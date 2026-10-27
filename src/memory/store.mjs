// 记忆库的持久层：短期话题 / 长期卡片 / 人设叠加层。
//
// 为什么是 JSON 而不是 SQLite：桥接现有的持久化（黑话库 slang.json、会话映射、初始提示词）
// 全是「一个小 JSON 文件 + 原子写」。记忆的量级是几百条卡片，JSON 完全够；文件小到能手改、
// 能进 git 看 diff，比多一个 sqlite 依赖、多一种并发锁问题划算得多。
//
// 三条铁律（黑话库踩过的坑，这里不再踩）：
//   1. 文件不存在 ≠ 读失败。前者返回空库，后者必须抛错——否则下一次保存会把原文件覆盖成空，
//      于是「花真金白银总结出来的记忆」永久消失。
//   2. JSON 坏了就隔离成 .corrupt-<时间戳>，绝不静默清空。
//   3. 只写 tmp + rename，权限 0600。
//
// 这个模块不认识 DSH、不认识 QQ、不读 config.json：它只收「已经归一化好的数据」，
// 这样 digest / 注入 / MCP 工具三处共用同一套规则，也方便离线单测。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 数据结构版本。将来迁移时看这个字段，不看文件是否长得像。 */
export const MEMORY_VERSION = 1;

// ── 上限（全部是「裁剪」而不是「拒绝」：宁可丢最旧的，也不让文件无限长大） ──

/** 短期记忆保留天数（含今天）。主人定的是 3 天。 */
export const SHORT_KEEP_DAYS = 3;
/** 单条短期话题的最大字数。摘要不是复述，超了就截。 */
export const SHORT_TOPIC_MAX = 120;
/** 每个会话每天最多保留多少条短期话题。 */
export const SHORT_TOPICS_PER_DAY = 12;
/** 每个会话最多记住几个「上游游标」（防止换群换号时 cursors 无限增长）。 */
export const SHORT_CURSORS_MAX = 200;

/** 每个人物卡最多几条事实。 */
export const PERSON_FACTS_MAX = 40;
/** 每个人物卡最多几条禁忌。 */
export const PERSON_TABOOS_MAX = 10;
/** 每个人物卡最多几条话题。 */
export const PERSON_TOPICS_MAX = 12;
/** 一个人物卡总共最多记多少个（按 mentions 排序裁剪最冷的）。 */
export const PEOPLE_MAX = 500;
/** 每个会话最多几张话题卡。 */
export const SESSION_TOPICS_MAX = 40;
/** 全局事件流上限。 */
export const EVENTS_MAX = 300;
/** 归档区上限（被衰减掉的旧事实不删，挪到这里）。 */
export const ARCHIVED_MAX = 500;

/** 人设叠加层字数上限。超了由调用方截断，但这里也兜一层。 */
export const PERSONA_MAX_CHARS = 4000;
/** 人设快照保留份数。 */
export const PERSONA_SNAPSHOTS = 30;
/** 人设单条的字数上限。一条人设写成一篇文章，模型就会照着文章说话。 */
export const PERSONA_ENTRY_MAX = 200;
/** 单次演化最多应用几条（护栏：防止模型一次性把人设重写）。 */
export const PERSONA_PATCH_MAX = 5;

/**
 * 人设书的固定小节。
 *
 * 为什么锁死小节名：模型很喜欢自己发明「## 我的小秘密」「## 最近的烦恼」这种小节，
 * 几十轮之后人设书会变成一篇散文，注入时没法按权重取用。未知小节一律拒绝，
 * 模型想加东西只能往这几个桶里放。
 */
export const PERSONA_SECTIONS = Object.freeze([
  '我是谁',
  '性格',
  '说话方式',
  '喜好',
  '厌恶',
  '关系',
  '禁忌',
]);

// ── 时间工具 ────────────────────────────────────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时区的日期键 `YYYY-MM-DD`。**不能用 toISOString()**：那是 UTC，凌晨 8 点前会串天。 */
export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return dayKey(new Date());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ISO 时间戳，统一用本地可读性最好的那个：带时区偏移的 ISO。 */
export function nowIso(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const base = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = pad2(Math.floor(Math.abs(off) / 60));
  const mm = pad2(Math.abs(off) % 60);
  return `${base}${sign}${hh}:${mm}`;
}

/** 把日期键换算成「今天/昨天/前天/3天前/10-20」。相对表述比裸时间戳更像人话。 */
export function relativeDayLabel(day, now = new Date()) {
  const today = dayKey(now);
  if (day === today) return '今天';
  const t = new Date(`${today}T00:00:00`);
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(day ?? '');
  const diff = Math.round((t.getTime() - d.getTime()) / 86400000);
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  // 3 天以内说「N天前」还算人话；再往后的「9天前」没人算得清，直接给日期。
  if (diff === 3) return '3天前';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 最近的 N 个日期键（含今天），从新到旧。 */
export function recentDayKeys(now = new Date(), count = SHORT_KEEP_DAYS) {
  const keys = [];
  const base = new Date(dayKey(now) + 'T00:00:00');
  for (let i = 0; i < Math.max(1, count); i += 1) {
    const d = new Date(base.getTime() - i * 86400000);
    keys.push(dayKey(d));
  }
  return keys;
}

// ── 文件读写（原子 + 损坏隔离） ─────────────────────────────────────────────

function ensureDirFor(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/**
 * 读一个 JSON 状态文件。
 *
 * @param {string} file
 * @param {{ label?: string, empty: () => any, normalize?: (raw:any)=>any, onCorrupt?: (msg:string)=>void }} opts
 * @returns {any} 归一化后的状态；文件不存在时返回 `empty()`
 * @throws 文件存在但读不出来 / 解析失败 / 形状不对时抛错（调用方决定是否降级）
 */
export function loadJsonState(file, { label = '状态文件', empty, normalize, onCorrupt } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return empty();
    throw new Error(`${label}读取失败（${error?.code || 'unknown'}）：${error?.message ?? error}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return empty();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const quarantine = `${file}.corrupt-${Date.now()}`;
    try { fs.writeFileSync(quarantine, text, { encoding: 'utf8', mode: 0o600 }); } catch { /* 隔离失败也要抛 */ }
    const message = `${label} JSON 解析失败，原文已另存为 ${quarantine}：${error?.message ?? error}`;
    onCorrupt?.(message);
    throw new Error(message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const quarantine = `${file}.corrupt-${Date.now()}`;
    try { fs.writeFileSync(quarantine, text, { encoding: 'utf8', mode: 0o600 }); } catch { /* 同上 */ }
    const message = `${label} 顶层不是对象，原文已另存为 ${quarantine}`;
    onCorrupt?.(message);
    throw new Error(message);
  }
  return normalize ? normalize(parsed) : parsed;
}

/** 原子写一个 JSON 状态文件。返回实际写入的字节数。 */
export function saveJsonState(file, state) {
  ensureDirFor(file);
  const text = JSON.stringify(state, null, 2);
  atomicWriteText(file, text);
  return Buffer.byteLength(text, 'utf8');
}

/** 原子写文本（tmp + rename + 0600）。人设书是 markdown，也要走这条路。 */
export function atomicWriteText(file, text) {
  ensureDirFor(file);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖原错 */ }
    throw error;
  }
}

// ── 归一化小工具 ────────────────────────────────────────────────────────────

function text(v, max = 400) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

function lower(v) {
  return String(v ?? '').trim().toLowerCase();
}

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = typeof item === 'string' ? item : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function clampNumber(v, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 会话 key 归一化：只认 `group:<正整数>` / `private:<正整数>`（与 bridge 的 canonicalV2Key 一致）。 */
export function canonicalKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

// ── 短期记忆 ────────────────────────────────────────────────────────────────

export function emptyShortState() {
  return { version: MEMORY_VERSION, days: {}, cursors: {} };
}

function normalizeShortTopic(raw) {
  if (typeof raw === 'string') return raw.trim() ? { text: text(raw, SHORT_TOPIC_MAX), at: nowIso() } : null;
  if (!raw || typeof raw !== 'object') return null;
  const t = text(raw.text, SHORT_TOPIC_MAX);
  if (!t) return null;
  return {
    text: t,
    at: text(raw.at, 40) || nowIso(),
    ...(asArray(raw.participants).length ? { participants: asArray(raw.participants).map((p) => text(p, 40)).filter(Boolean).slice(0, 8) } : {}),
  };
}

export function normalizeShortState(raw) {
  const state = emptyShortState();
  const days = asObject(raw?.days);
  for (const [day, dayBucket] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const perKey = asObject(dayBucket);
    const out = {};
    for (const [key, bucket] of Object.entries(perKey)) {
      const ck = canonicalKey(key);
      if (!ck) continue;
      const topics = asArray(bucket?.topics).map(normalizeShortTopic).filter(Boolean).slice(-SHORT_TOPICS_PER_DAY);
      if (!topics.length) continue;
      out[ck] = { topics, updatedAt: text(bucket?.updatedAt, 40) || nowIso() };
    }
    if (Object.keys(out).length) state.days[day] = out;
  }
  const cursors = asObject(raw?.cursors);
  for (const [key, cur] of Object.entries(cursors)) {
    const ck = canonicalKey(key);
    if (!ck) continue;
    state.cursors[ck] = {
      lastSeq: clampNumber(cur?.lastSeq, { min: 0, fallback: 0 }),
      lastAt: text(cur?.lastAt, 40) || '',
      digestCount: clampNumber(cur?.digestCount, { min: 0, fallback: 0 }),
    };
  }
  return state;
}

export function loadShort(file, opts = {}) {
  return loadJsonState(file, {
    label: '短期记忆库',
    empty: emptyShortState,
    normalize: normalizeShortState,
    ...opts,
  });
}

export function saveShort(file, state) {
  return saveJsonState(file, normalizeShortState(state));
}

/** 裁掉超过保留天数的日期桶。返回被丢弃的日期键，方便日志。 */
export function pruneShort(state, { now = new Date(), keepDays = SHORT_KEEP_DAYS } = {}) {
  const keep = new Set(recentDayKeys(now, keepDays));
  const dropped = [];
  for (const day of Object.keys(state.days || {})) {
    if (!keep.has(day)) {
      dropped.push(day);
      delete state.days[day];
    }
  }
  // 游标只保留最近活跃的一批，防止换群换号后无限增长。
  const cursors = Object.entries(state.cursors || {});
  if (cursors.length > SHORT_CURSORS_MAX) {
    cursors
      .sort((a, b) => String(b[1]?.lastAt ?? '').localeCompare(String(a[1]?.lastAt ?? '')))
      .slice(SHORT_CURSORS_MAX)
      .forEach(([key]) => delete state.cursors[key]);
  }
  return dropped;
}

/**
 * 往短期记忆里塞一批话题（同一天同一会话按文本去重）。
 * @returns {{added:number, total:number}}
 */
export function addShortTopics(state, { key, topics, day = dayKey(), at = nowIso() } = {}) {
  const ck = canonicalKey(key);
  if (!ck) return { added: 0, total: 0 };
  const list = asArray(topics).map(normalizeShortTopic).filter(Boolean);
  if (!list.length) return { added: 0, total: 0 };

  state.days[day] ??= {};
  state.days[day][ck] ??= { topics: [], updatedAt: at };
  const bucket = state.days[day][ck];
  const seen = new Set(bucket.topics.map((t) => lower(t.text)));
  let added = 0;
  for (const topic of list) {
    const k = lower(topic.text);
    if (seen.has(k)) continue;
    seen.add(k);
    bucket.topics.push(topic);
    added += 1;
  }
  bucket.topics = bucket.topics.slice(-SHORT_TOPICS_PER_DAY);
  bucket.updatedAt = at;
  return { added, total: bucket.topics.length };
}

/** 记录某个会话「已经消化到哪条消息」，digest 靠它避免重复总结。 */
export function setShortCursor(state, key, { lastSeq, at = nowIso() } = {}) {
  const ck = canonicalKey(key);
  if (!ck) return null;
  const prev = state.cursors[ck] ?? { lastSeq: 0, digestCount: 0 };
  state.cursors[ck] = {
    lastSeq: clampNumber(lastSeq, { min: 0, fallback: prev.lastSeq ?? 0 }),
    lastAt: at,
    digestCount: clampNumber(prev.digestCount, { min: 0, fallback: 0 }) + 1,
  };
  return state.cursors[ck];
}

export function getShortCursor(state, key) {
  const ck = canonicalKey(key);
  return ck ? (state.cursors[ck] ?? null) : null;
}

/**
 * 生成短期记忆的注入文本（只含当前会话，从新到旧）。
 * @returns {string} 没有内容时返回空串（调用方据此决定要不要加标题）
 */
export function buildShortText(state, { keys, now = new Date(), keepDays = SHORT_KEEP_DAYS, perDay = 4 } = {}) {
  const want = (asArray(keys).length ? asArray(keys) : Object.keys(state.cursors || {}).slice(0, 1))
    .map(canonicalKey)
    .filter(Boolean);
  if (!want.length) return '';

  const lines = [];
  for (const day of recentDayKeys(now, keepDays)) {
    const bucket = state.days?.[day];
    if (!bucket) continue;
    const topics = [];
    for (const key of want) {
      for (const topic of asArray(bucket[key]?.topics)) {
        if (topic?.text) topics.push(topic.text);
      }
    }
    if (!topics.length) continue;
    const picked = topics.slice(-Math.max(1, perDay));
    lines.push(`· ${relativeDayLabel(day, now)}：${picked.join('；')}`);
  }
  return lines.join('\n');
}

// ── 长期记忆 ────────────────────────────────────────────────────────────────

export function emptyLongState() {
  return { version: MEMORY_VERSION, people: {}, topics: {}, events: [], archived: [] };
}

function normalizeFact(raw) {
  if (typeof raw === 'string') return raw.trim() ? { text: text(raw, 200), at: nowIso(), weight: 2 } : null;
  if (!raw || typeof raw !== 'object') return null;
  const t = text(raw.text, 200);
  if (!t) return null;
  return {
    text: t,
    at: text(raw.at, 40) || nowIso(),
    weight: clampNumber(raw.weight, { min: 0, max: 5, fallback: 2 }),
    ...(raw.evidence ? { evidence: text(raw.evidence, 160) } : {}),
  };
}

function normalizeTopicCard(raw) {
  if (typeof raw === 'string') return raw.trim() ? { text: text(raw, 200), at: nowIso(), weight: 2 } : null;
  if (!raw || typeof raw !== 'object') return null;
  const t = text(raw.text, 200);
  if (!t) return null;
  return {
    text: t,
    at: text(raw.at, 40) || nowIso(),
    weight: clampNumber(raw.weight, { min: 0, max: 5, fallback: 2 }),
    ...(raw.status ? { status: text(raw.status, 20) } : {}),
    ...(raw.summary ? { summary: text(raw.summary, 300) } : {}),
  };
}

function normalizePerson(raw) {
  const p = {
    name: text(raw?.name, 40) || '',
    aliases: uniq(asArray(raw?.aliases).map((a) => text(a, 40)).filter(Boolean)).slice(0, 8),
    impression: text(raw?.impression, 200) || '',
    traits: uniq(asArray(raw?.traits).map((t) => text(t, 60)).filter(Boolean)).slice(0, 10),
    facts: asArray(raw?.facts).map(normalizeFact).filter(Boolean).slice(-PERSON_FACTS_MAX),
    taboos: uniq(asArray(raw?.taboos).map((t) => text(t, 120)).filter(Boolean)).slice(0, PERSON_TABOOS_MAX),
    topics: asArray(raw?.topics).map(normalizeTopicCard).filter(Boolean).slice(-PERSON_TOPICS_MAX),
    mentions: clampNumber(raw?.mentions, { min: 0, fallback: 0 }),
    firstSeenAt: text(raw?.firstSeenAt, 40) || nowIso(),
    lastSeenAt: text(raw?.lastSeenAt, 40) || nowIso(),
    updatedAt: text(raw?.updatedAt, 40) || nowIso(),
  };
  return p;
}

export function normalizeLongState(raw) {
  const state = emptyLongState();
  const people = asObject(raw?.people);
  for (const [id, person] of Object.entries(people)) {
    const pid = text(id, 60);
    if (!pid) continue;
    state.people[pid] = normalizePerson(person);
  }
  const topics = asObject(raw?.topics);
  for (const [key, cards] of Object.entries(topics)) {
    const ck = canonicalKey(key);
    if (!ck) continue;
    const list = asArray(cards).map(normalizeTopicCard).filter(Boolean).slice(-SESSION_TOPICS_MAX);
    if (list.length) state.topics[ck] = list;
  }
  state.events = asArray(raw?.events)
    .map((e) => (e && typeof e === 'object' && text(e.text, 200)
      ? { text: text(e.text, 200), at: text(e.at, 40) || nowIso(), ...(e.key ? { key: canonicalKey(e.key) ?? undefined } : {}) }
      : null))
    .filter(Boolean)
    .slice(-EVENTS_MAX);
  state.archived = asArray(raw?.archived)
    .map((e) => (e && typeof e === 'object' && text(e.text, 200)
      ? { text: text(e.text, 200), at: text(e.at, 40) || nowIso(), archivedAt: text(e.archivedAt, 40) || nowIso(), ...(e.personId ? { personId: text(e.personId, 60) } : {}) }
      : null))
    .filter(Boolean)
    .slice(-ARCHIVED_MAX);
  return state;
}

export function loadLong(file, opts = {}) {
  return loadJsonState(file, {
    label: '长期记忆库',
    empty: emptyLongState,
    normalize: normalizeLongState,
    ...opts,
  });
}

export function saveLong(file, state) {
  return saveJsonState(file, normalizeLongState(state));
}

/**
 * 写入/合并一个人物卡。
 *
 * 合并规则是「叠加而不是覆盖」：新印象覆盖旧印象（印象本来就是判断，该变就变），
 * 但事实、禁忌、话题都是**累加**——一个人的信息不该因为某次总结没提到就消失。
 *
 * @param {object} long
 * @param {string} personId 稳定标识（QQ 号或昵称归一值，由调用方保证稳定）
 * @param {object} patch { name, aliases, impression, traits, facts, taboos, topics, mentions }
 */
export function upsertPerson(long, personId, patch = {}, { now = nowIso() } = {}) {
  const pid = text(personId, 60);
  if (!pid) return null;
  const prev = long.people[pid] ? normalizePerson(long.people[pid]) : normalizePerson({ name: patch.name, firstSeenAt: now });
  const next = { ...prev };

  if (patch.name) next.name = text(patch.name, 40);
  if (asArray(patch.aliases).length) next.aliases = uniq([...prev.aliases, ...asArray(patch.aliases).map((a) => text(a, 40)).filter(Boolean)]).slice(0, 8);
  if (patch.impression) next.impression = text(patch.impression, 200);
  if (asArray(patch.traits).length) next.traits = uniq([...prev.traits, ...asArray(patch.traits).map((t) => text(t, 60)).filter(Boolean)]).slice(-10);

  for (const fact of asArray(patch.facts).map(normalizeFact).filter(Boolean)) {
    const dup = next.facts.find((f) => lower(f.text) === lower(fact.text));
    if (dup) {
      // 同一条事实又被提到：加权（越常被提起越重要），不重复记。
      dup.weight = clampNumber((dup.weight ?? 2) + 1, { min: 0, max: 5, fallback: 3 });
      dup.at = fact.at;
    } else {
      next.facts.push(fact);
    }
  }
  next.facts = next.facts.slice(-PERSON_FACTS_MAX);

  for (const taboo of asArray(patch.taboos).map((t) => text(t, 120)).filter(Boolean)) {
    if (!next.taboos.some((t) => lower(t) === lower(taboo))) next.taboos.push(taboo);
  }
  next.taboos = next.taboos.slice(-PERSON_TABOOS_MAX);

  for (const card of asArray(patch.topics).map(normalizeTopicCard).filter(Boolean)) {
    const dup = next.topics.find((t) => lower(t.text) === lower(card.text));
    if (dup) {
      dup.weight = clampNumber((dup.weight ?? 2) + 1, { min: 0, max: 5, fallback: 3 });
      if (card.status) dup.status = card.status;
      if (card.summary) dup.summary = card.summary;
      dup.at = card.at;
    } else {
      next.topics.push(card);
    }
  }
  next.topics = next.topics.slice(-PERSON_TOPICS_MAX);

  next.mentions = clampNumber((prev.mentions ?? 0) + clampNumber(patch.mentions, { min: 1, fallback: 1 }), { min: 0, fallback: 1 });
  next.lastSeenAt = now;
  next.updatedAt = now;
  long.people[pid] = normalizePerson(next);
  return long.people[pid];
}

/** 写入一张会话话题卡（同一会话内按文本去重加权）。 */
export function addTopicCard(long, sessionKey, card, { now = nowIso() } = {}) {
  const ck = canonicalKey(sessionKey);
  const normalized = normalizeTopicCard(card);
  if (!ck || !normalized) return null;
  const list = long.topics[ck] ?? [];
  const dup = list.find((t) => lower(t.text) === lower(normalized.text));
  if (dup) {
    dup.weight = clampNumber((dup.weight ?? 2) + 1, { min: 0, max: 5, fallback: 3 });
    if (normalized.status) dup.status = normalized.status;
    if (normalized.summary) dup.summary = normalized.summary;
    dup.at = normalized.at || now;
  } else {
    list.push({ ...normalized, at: normalized.at || now });
  }
  long.topics[ck] = list.slice(-SESSION_TOPICS_MAX);
  return long.topics[ck];
}

/** 追加一条全局事件。 */
export function addEvent(long, event, { now = nowIso() } = {}) {
  const t = text(event?.text, 200);
  if (!t) return null;
  const entry = { text: t, at: text(event?.at, 40) || now, ...(event?.key ? { key: canonicalKey(event.key) ?? undefined } : {}) };
  long.events.push(entry);
  long.events = long.events.slice(-EVENTS_MAX);
  return entry;
}

/**
 * 衰减：太久没被提到的记忆降权，降到 0 就挪进归档区。
 *
 * 为什么需要衰减：不衰减的话，三个月前一句「他在减肥」会永远和「他刚做完手术」同权重，
 * 注入时随机命中，模型就会说出让人尴尬的话。降权而不是删除——旧事还能查，只是不再主动提。
 *
 * @returns {{weakened:number, archived:number}}
 */
export function decayLong(long, { now = new Date(), idleDays = 30 } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const cutoff = nowMs - idleDays * 86400000;
  let weakened = 0;
  let archived = 0;

  for (const [pid, person] of Object.entries(long.people)) {
    const kept = [];
    for (const fact of asArray(person.facts)) {
      const at = Date.parse(fact.at);
      if (Number.isFinite(at) && at < cutoff && (fact.weight ?? 2) <= 1) {
        long.archived.push({ text: fact.text, at: fact.at, archivedAt: nowIso(now), personId: pid });
        archived += 1;
        continue;
      }
      if (Number.isFinite(at) && at < cutoff && (fact.weight ?? 2) > 1) {
        fact.weight = (fact.weight ?? 2) - 1;
        weakened += 1;
      }
      kept.push(fact);
    }
    person.facts = kept;
  }

  for (const [ck, cards] of Object.entries(long.topics)) {
    long.topics[ck] = asArray(cards).filter((card) => {
      const at = Date.parse(card.at);
      if (Number.isFinite(at) && at < cutoff && (card.weight ?? 2) <= 1) {
        long.archived.push({ text: card.text, at: card.at, archivedAt: nowIso(now) });
        archived += 1;
        return false;
      }
      if (Number.isFinite(at) && at < cutoff && (card.weight ?? 2) > 1) {
        card.weight = (card.weight ?? 2) - 1;
        weakened += 1;
      }
      return true;
    });
    if (!long.topics[ck].length) delete long.topics[ck];
  }

  // 人物总数超上限时，淘汰最久没露面的人（他们的卡片一起归档，别静默丢）。
  const ids = Object.keys(long.people);
  if (ids.length > PEOPLE_MAX) {
    ids.sort((a, b) => String(long.people[b].lastSeenAt).localeCompare(String(long.people[a].lastSeenAt)));
    for (const pid of ids.slice(PEOPLE_MAX)) {
      const person = long.people[pid];
      for (const fact of asArray(person.facts)) {
        long.archived.push({ text: fact.text, at: fact.at, archivedAt: nowIso(now), personId: pid });
      }
      delete long.people[pid];
    }
  }

  long.archived = long.archived.slice(-ARCHIVED_MAX);
  return { weakened, archived };
}

/** 按 key 找相关人物卡：名字出现在会话名/别名里，或者被明确点名。 */
export function pickPeople(long, { key, names = [], limit = 6 } = {}) {
  const ck = canonicalKey(key);
  const wanted = new Set(asArray(names).map((n) => lower(n)).filter(Boolean));
  const scored = Object.entries(long.people || {})
    .map(([id, person]) => {
      let score = 0;
      if (wanted.size) {
        if (wanted.has(lower(person.name))) score += 100;
        for (const alias of person.aliases) if (wanted.has(lower(alias))) score += 60;
      }
      // 私人会话里那个人天然最相关。
      if (ck && ck.startsWith('private:') && (id === ck.slice(8) || person.name === id)) score += 120;
      score += Math.min(20, Number(person.mentions) || 0);
      for (const fact of person.facts) score += Math.min(3, Number(fact.weight) || 0);
      return { id, person, score };
    })
    .filter((x) => x.score > 0 || wanted.size === 0)
    .sort((a, b) => b.score - a.score || String(b.person.lastSeenAt).localeCompare(String(a.person.lastSeenAt)));

  // 没有明确目标时，只返回「最近露过面」的人，避免把三年前的冷卡全灌进去。
  const pool = wanted.size ? scored : scored.filter((x) => x.person.mentions > 0);
  return pool.slice(0, Math.max(1, limit));
}

/**
 * 生成长期记忆的注入文本。
 * @returns {{text:string, people:number}} 没有可用内容时 text 为空串
 */
export function buildLongText(long, { key, names = [], now = new Date(), maxPeople = 6, maxChars = 700 } = {}) {
  const lines = [];
  const picked = pickPeople(long, { key, names, limit: maxPeople });
  for (const { person } of picked) {
    const label = person.name || '某人';
    const bits = [];
    if (person.impression) bits.push(person.impression);
    if (person.traits.length) bits.push(`性格：${person.traits.slice(0, 3).join('、')}`);
    // 事实按权重取前几条：权重高的才是「重要的事」。
    const facts = [...person.facts].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, 3);
    for (const fact of facts) {
      const day = fact.at ? dayKey(new Date(fact.at)) : '';
      bits.push(day && Number.isFinite(Date.parse(fact.at)) ? `${fact.text}（${relativeDayLabel(day, now)}提过）` : fact.text);
    }
    if (person.taboos.length) bits.push(`别碰：${person.taboos.slice(0, 2).join('、')}`);
    if (!bits.length) continue;
    lines.push(`· ${label}：${bits.join('；')}`);
  }

  const ck = canonicalKey(key);
  const cards = ck ? asArray(long.topics?.[ck]) : [];
  if (cards.length) {
    const top = [...cards].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, 4);
    lines.push(`· 这个会话里进行过的话题：${top.map((c) => c.text).join('；')}`);
  }

  let out = lines.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return { text: out, people: lines.length };
}

// ── 人设叠加层 ─────────────────────────────────────────────────────────────

/** 默认人设书。空模板：不认识主人、不认识群，全靠聊出来。 */
export function defaultPersona() {
  return [
    '# 人设叠加层',
    '',
    '> 这一份是**聊出来的**自我认知，会随对话缓慢变化；人格卡（roles/*.md）是主人定的底座，',
    '> 两者同时生效，底座在前、这份在后。**这里只放最近形成的偏好和关系变化**，不要抄人格卡。',
    '',
    '## 我是谁',
    '',
    '## 性格',
    '',
    '## 说话方式',
    '',
    '## 喜好',
    '',
    '## 厌恶',
    '',
    '## 关系',
    '',
    '## 禁忌',
    '',
  ].join('\n');
}

/**
 * 按 `## 标题` 切分成小节。返回的 name 是去掉 `##` 的标题文本。
 * @returns {{name:string, lines:string[]}[]}
 */
export function parsePersonaSections(textValue) {
  const sections = [];
  let current = { name: '', lines: [] };
  for (const line of String(textValue ?? '').split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      sections.push(current);
      current = { name: m[1], lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);
  return sections;
}

/** 把小节拼回 markdown。空小节保留标题（注入时由调用方跳过）。 */
export function stringifyPersonaSections(sections) {
  return sections
    .map((s) => (s.name ? `## ${s.name}\n${s.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n` : s.lines.join('\n').trim()))
    .filter((s) => s.trim())
    .join('\n');
}

/** 取某小节里的条目（`- xxx` 形式的行）。 */
export function sectionEntries(sections, name) {
  const sec = sections.find((s) => s.name === name);
  if (!sec) return [];
  return sec.lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

/**
 * 应用一次人设演化补丁。
 *
 * 补丁语义（故意做得又窄又土，就是为了让模型改不动大局）：
 *   { add:     [{section, text}],  remove: [{section, text}],  replace: [{section, from, to}] }
 *
 * 护栏：
 *   - section 必须在 PERSONA_SECTIONS 里，否则整条拒绝（记进 rejected）；
 *   - 单条 ≤ PERSONA_ENTRY_MAX 字，超了截断；
 *   - 「禁忌」小节只允许 add，不允许 remove/replace —— 底线不该被模型自己擦掉；
 *   - 单次最多应用 PERSONA_PATCH_MAX 条，超出的拒绝（防止一次性重写人设）。
 *
 * @returns {{text:string, applied:object[], rejected:object[]}}
 */
export function applyPersonaPatch(textValue, patch = {}) {
  const sections = parsePersonaSections(textValue || defaultPersona());
  const applied = [];
  const rejected = [];
  let budget = PERSONA_PATCH_MAX;

  const findSection = (name) => {
    let sec = sections.find((s) => s.name === name);
    if (!sec) {
      sec = { name, lines: [] };
      sections.push(sec);
    }
    return sec;
  };

  const guard = (item, kind) => {
    const section = text(item?.section, 20);
    if (!PERSONA_SECTIONS.includes(section)) {
      rejected.push({ kind, item, reason: `小节「${section || '(空)'}」不在白名单里` });
      return null;
    }
    if (budget <= 0) {
      rejected.push({ kind, item, reason: `单次最多改 ${PERSONA_PATCH_MAX} 条` });
      return null;
    }
    if (kind !== 'add' && section === '禁忌') {
      rejected.push({ kind, item, reason: '「禁忌」只允许新增，不允许删除或改写' });
      return null;
    }
    return section;
  };

  for (const item of asArray(patch.add)) {
    const sectionName = guard(item, 'add');
    if (!sectionName) continue;
    const entry = text(item?.text, PERSONA_ENTRY_MAX);
    if (!entry) { rejected.push({ kind: 'add', item, reason: '空条目' }); continue; }
    const sec = findSection(sectionName);
    const existing = sec.lines.filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2).trim());
    if (existing.some((e) => lower(e) === lower(entry))) continue; // 已经有了，静默跳过
    // 空小节首次写入时补一个空行，避免 `## 喜好` 和 `- xxx` 贴在一起看起来像标题。
    if (sec.lines.length === 1 && sec.lines[0].trim() === '') sec.lines = [];
    if (sec.lines.length && sec.lines[sec.lines.length - 1].trim() !== '') sec.lines.push('');
    sec.lines.push(`- ${entry}`);
    budget -= 1;
    applied.push({ kind: 'add', section: sectionName, text: entry });
  }

  for (const item of asArray(patch.remove)) {
    const sectionName = guard(item, 'remove');
    if (!sectionName) continue;
    const target = text(item?.text, PERSONA_ENTRY_MAX);
    const sec = sections.find((s) => s.name === sectionName);
    if (!sec || !target) { rejected.push({ kind: 'remove', item, reason: '找不到该小节或条目为空' }); continue; }
    const idx = sec.lines.findIndex((l) => {
      const t = l.trim();
      return t.startsWith('- ') && lower(t.slice(2).trim()) === lower(target);
    });
    if (idx < 0) { rejected.push({ kind: 'remove', item, reason: '找不到这条人设条目' }); continue; }
    sec.lines.splice(idx, 1);
    budget -= 1;
    applied.push({ kind: 'remove', section: sectionName, text: target });
  }

  for (const item of asArray(patch.replace)) {
    const sectionName = guard(item, 'replace');
    if (!sectionName) continue;
    const from = text(item?.from, PERSONA_ENTRY_MAX);
    const to = text(item?.to, PERSONA_ENTRY_MAX);
    const sec = sections.find((s) => s.name === sectionName);
    if (!sec || !from || !to) { rejected.push({ kind: 'replace', item, reason: '缺少 from/to 或小节不存在' }); continue; }
    const idx = sec.lines.findIndex((l) => {
      const t = l.trim();
      return t.startsWith('- ') && lower(t.slice(2).trim()) === lower(from);
    });
    if (idx < 0) { rejected.push({ kind: 'replace', item, reason: '找不到要改写的条目' }); continue; }
    sec.lines[idx] = `- ${to}`;
    budget -= 1;
    applied.push({ kind: 'replace', section: sectionName, from, to });
  }

  let out = stringifyPersonaSections(sections).trim() + '\n';
  if (out.length > PERSONA_MAX_CHARS) out = `${out.slice(0, PERSONA_MAX_CHARS - 1)}…\n`;
  return { text: out, applied, rejected };
}

/** 生成人设注入文本：去掉空小节与说明块的「干货版」。 */
export function buildPersonaText(textValue) {
  const sections = parsePersonaSections(textValue || defaultPersona());
  const parts = [];
  for (const sec of sections) {
    if (!sec.name || !PERSONA_SECTIONS.includes(sec.name)) continue;
    const entries = sec.lines
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim())
      .filter(Boolean);
    if (!entries.length) continue;
    parts.push(`${sec.name}：${entries.join('；')}`);
  }
  return parts.join('\n');
}

/** 人设书文件路径约定：`<dir>/persona.md`，快照在 `<dir>/persona.history/`。 */
export function personaPaths(dir) {
  return {
    file: path.join(dir, 'persona.md'),
    historyDir: path.join(dir, 'persona.history'),
  };
}

/** 读人设书。不存在时返回默认模板（并**不**立刻落盘，避免第一轮就把模板写进用户目录）。 */
export function loadPersona(dir, { onCorrupt } = {}) {
  const { file } = personaPaths(dir);
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (!text.trim()) return { text: defaultPersona(), existed: true, file };
    return { text, existed: true, file };
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: defaultPersona(), existed: false, file };
    onCorrupt?.(`人设书读取失败（${error?.code || 'unknown'}）：${error?.message ?? error}`);
    throw error;
  }
}

/** 存人设书，每次改动先留一份快照（保留最近 PERSONA_SNAPSHOTS 份）。 */
export function savePersona(dir, textValue, { snapshot = true, now = new Date() } = {}) {
  const { file, historyDir } = personaPaths(dir);
  const prev = (() => {
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
  })();
  if (snapshot && prev && prev.trim() && prev !== textValue) {
    try {
      fs.mkdirSync(historyDir, { recursive: true });
      const stamp = nowIso(now).replace(/[:+]/g, '').replace('T', '-');
      atomicWriteText(path.join(historyDir, `${stamp}.md`), prev);
      const files = fs.readdirSync(historyDir).filter((f) => f.endsWith('.md')).sort();
      for (const old of files.slice(0, Math.max(0, files.length - PERSONA_SNAPSHOTS))) {
        try { fs.unlinkSync(path.join(historyDir, old)); } catch { /* 删不掉不影响保存 */ }
      }
    } catch { /* 快照失败不能阻止保存：宁可没历史，也不能丢了改动人设 */ }
  }
  atomicWriteText(file, textValue);
  return { file, snapshot: Boolean(snapshot && prev) };
}
