// 记忆提炼：把一段对话压成「值得记住的东西」。
//
// 这一层是纯函数——构建 prompt、解析模型返回的 JSON、把结果落到 store。
// 真正「什么时候触发、喂给哪个 DSH 会话」由 bridge.js 决定（它已经有黑话学习会话那套设施）。
// 分成两半的好处：prompt 和解析可以离线单测，不用开 DSH、不花钱。
//
// 提炼的目标不是「总结聊天记录」，而是「写档案」：
//   - 聊过什么（短期话题，几天后会被裁掉）
//   - 这个人是什么人（长期人物卡，永久）
//   - 我自己有什么变化（人设叠加层）
// 所以 prompt 里反复强调「宁缺毋滥」：记错一条比漏记十条更糟——漏记只是不知道，
// 记错会让角色理直气壮地说错话。
import {
  PERSONA_ENTRY_MAX,
  PERSONA_SECTIONS,
  addEvent,
  addShortTopics,
  addTopicCard,
  applyPersonaPatch,
  buildPersonaText,
  dayKey,
  nowIso,
  relativeDayLabel,
  upsertPerson,
} from './store.mjs';

/** 一次提炼最多看多少条消息（多了纯烧钱，而且模型会开始编）。 */
export const DIGEST_MESSAGE_MAX = 120;
/** 单条消息在 prompt 里的最大字数。 */
export const DIGEST_MESSAGE_CHARS = 180;
/** 一次提炼最多返回多少条短期话题。 */
export const DIGEST_TOPICS_MAX = 8;

/**
 * 把桥接内部的消息对象转成 prompt 的一行。
 * 只认 `sender / text / userId / time / isSelf`，其余字段（媒体、引用、表情）一律不参与提炼。
 */
function messageLine(msg) {
  const sender = String(msg?.sender ?? '').trim() || (msg?.isSelf ? '我' : '某人');
  const body = String(msg?.text ?? msg?.plain ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return null;
  const trimmed = body.length > DIGEST_MESSAGE_CHARS ? `${body.slice(0, DIGEST_MESSAGE_CHARS)}…` : body;
  const who = msg?.isSelf ? '我' : sender;
  const id = !msg?.isSelf && msg?.userId != null ? `(${msg.userId})` : '';
  return `- ${who}${id}：${trimmed}`;
}

/**
 * 人物 ID：优先 QQ 号（改名也不丢卡），没有号才退回昵称。
 * 昵称会变、会重名，所以它是**兜底**而不是首选。
 */
export function personIdOf({ userId, name } = {}) {
  const id = String(userId ?? '').trim();
  if (/^\d{4,}$/.test(id)) return `qq:${id}`;
  const n = String(name ?? '').trim().toLowerCase();
  return n ? `name:${n}` : null;
}

/**
 * 构建提炼 prompt。
 *
 * @param {object} args
 * @param {string} args.key            会话 key
 * @param {Array}  args.messages       消息列表（桥接的 st.recentMessages / unread）
 * @param {object} [args.existing]     已有记忆（{people, topics}），让模型知道什么已经记过了
 * @param {string} [args.personaText]  当前人设书，让模型在此基础上小步修正
 * @param {boolean}[args.wantPersona]  这次要不要让人设演化（默认 true）
 * @param {Date}   [args.now]
 * @returns {string} 一段可直接发出的 prompt 文本
 */
export function buildDigestPrompt({
  key,
  messages = [],
  existing = null,
  personaText = '',
  wantPersona = true,
  now = new Date(),
} = {}) {
  const isGroup = String(key ?? '').startsWith('group:');
  const lines = (Array.isArray(messages) ? messages : [])
    .slice(-DIGEST_MESSAGE_MAX)
    .map(messageLine)
    .filter(Boolean)
    .join('\n');

  const known = [];
  const existingTopics = isGroup ? existing?.topics?.[key] : null;
  for (const card of Array.isArray(existingTopics) ? existingTopics : []) {
    if (card?.text) known.push(`- 话题「${card.text}」${card.status ? `（${card.status}）` : ''}`);
  }
  const people = Object.entries(existing?.people ?? {});
  for (const [pid, p] of people.slice(0, 20)) {
    const bits = [];
    if (p?.impression) bits.push(p.impression);
    if (Array.isArray(p?.facts)) for (const f of p.facts.slice(0, 4)) if (f?.text) bits.push(f.text);
    if (p?.name && bits.length) known.push(`- ${p.name}（${pid}）：${bits.join('；')}`);
  }

  const personaBlock = wantPersona
    ? `
【我现在的自我认知（人设叠加层）】
${buildPersonaText(personaText) || '（还是一片空白）'}

如果这段对话让我对自己有了新的、稳定的认识（不是一时的情绪），可以提出最多 2 条修改。
只能改这些小节：${PERSONA_SECTIONS.join('、')}。
规矩：
- 只能因为**对方的明确说法**或**我自己反复表现出的倾向**才改，不许凭空想象；
- 「禁忌」只允许新增，不许删除或改写；
- 每条不超过 ${PERSONA_ENTRY_MAX} 字，写成「- 」开头那样的短句；
- 没有就留空数组，不要为了填满而硬写。
`
    : '';

  return `你在替我整理记忆档案。下面是一段 QQ ${isGroup ? '群聊' : '私聊'}记录（会话 ${key}），
现在的时间是 ${nowIso(now)}（${relativeDayLabel(dayKey(now), now)}）。

【这段对话】
${lines || '（没有可用内容）'}
${known.length ? `\n【我已经记住的（不要重复记，有新情况就补充或更新）】\n${known.slice(0, 25).join('\n')}\n` : ''}${personaBlock}
【要你做的事】
只挑「离开这段对话之后仍然有用」的信息，按下述 JSON 返回。宁缺毋滥——漏记只是不知道，记错会让我说错话。

- topics：这两天聊过的话题，每条一句话、不超过 30 字、用陈述句（如「在讨论新番排期」「某人在准备考研」）。最多 ${DIGEST_TOPICS_MAX} 条。
- people：对话里出现的**别人**（不含我自己）。
  · name 用对话里的称呼；userId 有就在括号里抄过来，没有就 null。
  · impression 是你对他的整体印象（一句话，可以带性格判断），没有明显特征就留空。
  · traits 是性格/说话风格的关键词（最多 3 个）。
  · facts 是**关于他的重要事实**：在做的事、身份、经历、喜好厌恶、身体状况、承诺。每条一句话。
  · taboos 是他明确讨厌/不想被提的事。
  · 不确定的、一次性的闲聊、玩笑话，一律不要写进 facts。
- sessionTopics：正在进行或刚刚结束的**具体事项**（如「约好周末一起打本」「在帮他改简历」），带 status（进行中 / 已结束）。
- events：值得记一笔的时间点事件（如「他今天生日」），可以留空。
- persona：见上面那段，允许为空。

绝对不要记：密码、身份证、银行卡、精确住址、手机号等敏感信息；也不要记表情包、寒暄、纯情绪宣泄。

只返回一个 JSON 对象，不要任何解释、不要 markdown 代码块：
{
  "topics": [],
  "people": [{"name":"", "userId":null, "impression":"", "traits":[], "facts":[], "taboos":[], "topics":[]}],
  "sessionTopics": [{"text":"", "status":"进行中"}],
  "events": [],
  "persona": {"add":[{"section":"喜好","text":""}], "remove":[], "replace":[]}
}`;
}

/** 从模型输出里挖出 JSON 对象：容忍 ```json 包裹、前后废话、BOM。 */
export function extractJsonObject(raw) {
  let s = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!s) return null;
  // 优先剥代码块
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return s.slice(start, end + 1);
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function str(v, max = 200) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

/**
 * 解析提炼结果。**任何字段出问题都只丢那一条，不整体失败**——
 * 一次提炼花了钱，不能因为模型多写了个逗号就全丢。
 */
export function parseDigestJson(raw) {
  const json = extractJsonObject(raw);
  const empty = {
    topics: [], people: [], sessionTopics: [], events: [],
    persona: { add: [], remove: [], replace: [] },
    parseError: json ? null : '没有找到 JSON 对象',
  };
  if (!json) return empty;
  let data;
  try {
    data = JSON.parse(json);
  } catch (error) {
    return { ...empty, parseError: `JSON 解析失败：${error?.message ?? error}` };
  }
  if (!data || typeof data !== 'object') return { ...empty, parseError: '顶层不是对象' };

  const topics = arr(data.topics).map((t) => str(t, 60)).filter(Boolean).slice(0, DIGEST_TOPICS_MAX);

  const people = arr(data.people)
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const name = str(p.name, 40);
      const userId = p.userId ?? p.user_id ?? null;
      const id = personIdOf({ userId, name });
      if (!id || !name) return null;
      return {
        id,
        name,
        userId: userId != null ? String(userId) : null,
        impression: str(p.impression, 200),
        traits: arr(p.traits).map((t) => str(t, 60)).filter(Boolean).slice(0, 5),
        facts: arr(p.facts).map((f) => str(f, 200)).filter(Boolean).slice(0, 12),
        taboos: arr(p.taboos).map((t) => str(t, 120)).filter(Boolean).slice(0, 5),
        topics: arr(p.topics).map((t) => str(t, 200)).filter(Boolean).slice(0, 6),
      };
    })
    .filter(Boolean);

  const sessionTopics = arr(data.sessionTopics)
    .map((t) => {
      if (typeof t === 'string') return { text: str(t, 200), status: '' };
      if (!t || typeof t !== 'object') return null;
      const textValue = str(t.text, 200);
      if (!textValue) return null;
      return { text: textValue, status: str(t.status, 20), summary: str(t.summary, 300) };
    })
    .filter(Boolean)
    .slice(0, 8);

  const events = arr(data.events).map((e) => str(e, 200)).filter(Boolean).slice(0, 8);

  const personaRaw = data.persona && typeof data.persona === 'object' ? data.persona : {};
  const persona = {
    add: arr(personaRaw.add)
      .map((x) => (x && typeof x === 'object' ? { section: str(x.section, 20), text: str(x.text, PERSONA_ENTRY_MAX) } : null))
      .filter((x) => x?.section && x?.text),
    remove: arr(personaRaw.remove)
      .map((x) => (x && typeof x === 'object' ? { section: str(x.section, 20), text: str(x.text, PERSONA_ENTRY_MAX) } : null))
      .filter((x) => x?.section && x?.text),
    replace: arr(personaRaw.replace)
      .map((x) => (x && typeof x === 'object'
        ? { section: str(x.section, 20), from: str(x.from, PERSONA_ENTRY_MAX), to: str(x.to, PERSONA_ENTRY_MAX) }
        : null))
      .filter((x) => x?.section && x?.from && x?.to),
  };

  return { topics, people, sessionTopics, events, persona, parseError: null };
}

/**
 * 把提炼结果写进三层存储。就地修改传入的 short / long 对象。
 *
 * @returns {{shortAdded:number, people:number, sessionTopics:number, events:number,
 *            persona:{applied:number, rejected:number}, text:string, applied:object[]}}
 */
export function applyDigest({
  sessionKey,
  digest,
  short,
  long,
  personaText = '',
  now = new Date(),
} = {}) {
  const at = nowIso(now);
  const day = dayKey(now);
  const result = {
    shortAdded: 0, people: 0, sessionTopics: 0, events: 0,
    persona: { applied: 0, rejected: 0 }, text: personaText, applied: [],
  };
  if (!digest) return result;

  if (short && Array.isArray(digest.topics) && digest.topics.length) {
    const r = addShortTopics(short, {
      key: sessionKey,
      day,
      at,
      topics: digest.topics.map((t) => ({ text: t, at })),
    });
    result.shortAdded = r.added;
  }

  if (long) {
    for (const person of arr(digest.people)) {
      const saved = upsertPerson(long, person.id, {
        name: person.name,
        impression: person.impression,
        traits: person.traits,
        facts: person.facts.map((f) => ({ text: f, at })),
        taboos: person.taboos,
        topics: person.topics.map((t) => ({ text: t, at })),
        mentions: 1,
      }, { now: at });
      if (saved) result.people += 1;
    }
    for (const card of arr(digest.sessionTopics)) {
      if (addTopicCard(long, sessionKey, { ...card, at }, { now: at })) result.sessionTopics += 1;
    }
    for (const textValue of arr(digest.events)) {
      if (addEvent(long, { text: textValue, at, key: sessionKey }, { now: at })) result.events += 1;
    }
  }

  const patch = digest.persona;
  const hasPatch = patch && (patch.add?.length || patch.remove?.length || patch.replace?.length);
  if (hasPatch) {
    const applied = applyPersonaPatch(personaText, patch);
    result.text = applied.text;
    result.applied = applied.applied;
    result.persona = { applied: applied.applied.length, rejected: applied.rejected.length };
    if (applied.rejected.length) result.personaRejected = applied.rejected;
  }

  return result;
}
