// 提炼层的离线单测：prompt 构建、模型返回的脏 JSON 解析、落库统计。
// 跑法：node scripts/test-memory-digest.mjs
import {
  applyDigest,
  buildDigestPrompt,
  extractJsonObject,
  parseDigestJson,
  personIdOf,
} from '../src/memory/digest.mjs';
import {
  emptyLongState,
  emptyShortState,
  defaultPersona,
} from '../src/memory/store.mjs';

let failed = 0;
let passed = 0;

function ok(cond, label) {
  if (cond) { passed += 1; return; }
  failed += 1;
  console.error(`✗ ${label}`);
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed += 1; return; }
  failed += 1;
  console.error(`✗ ${label}\n    实际: ${a}\n    期望: ${e}`);
}

const now = new Date(2026, 9, 26, 14, 0);

// ── 人物 ID ─────────────────────────────────────────────────────────────────
eq(personIdOf({ userId: '100001', name: '阿蓝' }), 'qq:100001', '有 QQ 号时用号做 id');
eq(personIdOf({ userId: null, name: '阿蓝' }), 'name:阿蓝', '没号时退回昵称');
eq(personIdOf({ userId: '123', name: '阿蓝' }), 'name:阿蓝', '太短的「号」不算号（防止把序号当 QQ）');
eq(personIdOf({}), null, '什么都没有时返回 null');

// ── prompt 构建 ─────────────────────────────────────────────────────────────
const messages = [
  { sender: '阿蓝', userId: '10001', text: '我明天要去做个检查，有点紧张', time: Date.now() },
  { sender: '我', isSelf: true, text: '别怕，我陪你', time: Date.now() },
  { sender: '阿蓝', userId: '10001', text: '谢谢，检查完请你喝奶茶', time: Date.now() },
  { sender: '路人', userId: '10002', text: '', time: Date.now() }, // 空消息应被丢掉
];
const prompt = buildDigestPrompt({
  key: 'group:123456',
  messages,
  existing: { people: {}, topics: {} },
  personaText: defaultPersona(),
  now,
});

ok(prompt.includes('阿蓝(10001)：我明天要去做个检查'), 'prompt 里带发送者与 QQ 号');
ok(prompt.includes('- 我：别怕，我陪你'), '自己的话标记为「我」');
ok(!prompt.includes('路人'), '空消息不进入 prompt');
ok(prompt.includes('只返回一个 JSON 对象'), 'prompt 有输出格式要求');
ok(prompt.includes('密码'), 'prompt 明确禁止记敏感信息');
ok(prompt.includes('禁忌'), 'prompt 里有人设小节白名单');
ok(prompt.includes('群聊'), '群聊会话识别正确');

const privatePrompt = buildDigestPrompt({ key: 'private:10001', messages, now });
ok(privatePrompt.includes('私聊'), '私聊会话识别正确');

const noPersona = buildDigestPrompt({ key: 'private:10001', messages, wantPersona: false, now });
ok(!noPersona.includes('【我现在的自我认知'), 'wantPersona=false 时不带人设段落');

// 已有记忆要出现在 prompt 里，避免重复记
const withExisting = buildDigestPrompt({
  key: 'group:123456',
  messages,
  existing: {
    people: { 'qq:10001': { name: '阿蓝', impression: '嘴硬心软', facts: [{ text: '在准备考研' }] } },
    topics: { 'group:123456': [{ text: '在聊新番', status: '进行中' }] },
  },
  now,
});
ok(withExisting.includes('在准备考研'), 'prompt 带已有事实（避免重复记）');
ok(withExisting.includes('在聊新番'), 'prompt 带已有话题卡');

// ── JSON 解析容错 ───────────────────────────────────────────────────────────
eq(parseDigestJson('').parseError !== null, true, '空输出报解析错误');

const fenced = parseDigestJson('好的，这是结果：\n```json\n{"topics":["在聊新番"]}\n```\n希望有用！');
eq(fenced.topics, ['在聊新番'], '剥掉代码块和前后废话');

const dirty = parseDigestJson('{"topics":["a"], "people":[{"name":"阿蓝","userId":"10001","facts":["在准备考研"]},{"bogus":1}], "sessionTopics":["约好周末打本"], "events":["他今天生日"], "persona":{"add":[{"section":"喜好","text":"喜欢喝奶茶"}]}}');
eq(dirty.people.length, 1, '没有 name 的人物被丢弃');
eq(dirty.people[0].id, 'qq:10001', '人物 id 用 QQ 号');
eq(dirty.sessionTopics[0].text, '约好周末打本', 'sessionTopics 支持纯字符串写法');
eq(dirty.persona.add.length, 1, '人设补丁解析出来');

const broken = parseDigestJson('{"topics": [');
ok(broken.parseError !== null, '半个 JSON 报错但不抛');

const noPersonaField = parseDigestJson('{"topics":[]}');
eq(noPersonaField.persona, { add: [], remove: [], replace: [] }, '缺字段时给空补丁');

// 超量裁剪
const many = parseDigestJson(JSON.stringify({ topics: Array.from({ length: 20 }, (_, i) => `t${i}`) }));
eq(many.topics.length, 8, '话题超量被裁到 8 条');

// ── 落库 ────────────────────────────────────────────────────────────────────
const short = emptyShortState();
const long = emptyLongState();
const persona = defaultPersona();

const applied = applyDigest({
  sessionKey: 'group:123456',
  digest: dirty,
  short,
  long,
  personaText: persona,
  now,
});

eq(applied.shortAdded, 1, '短期话题写入');
eq(applied.people, 1, '人物卡写入');
eq(applied.sessionTopics, 1, '会话话题卡写入');
eq(applied.events, 1, '事件写入');
eq(applied.persona.applied, 1, '人设补丁应用');
ok(applied.text.includes('喜欢喝奶茶'), '人设正文更新了');

const savedPerson = long.people['qq:10001'];
ok(savedPerson, '人物卡真的存在');
eq(savedPerson.name, '阿蓝', '人物卡记了名字');
eq(savedPerson.facts.length, 1, '人物卡记了事实');
eq(savedPerson.facts[0].text, '在准备考研', '事实内容正确');
ok(short.days['2026-10-26']['group:123456'], '短期话题落在今天这个桶里');

// 同一份结果再来一次：话题不重复、事实加权不重复
const twice = applyDigest({ sessionKey: 'group:123456', digest: dirty, short, long, personaText: applied.text, now });
eq(twice.shortAdded, 0, '重复提炼不会重复记话题');
eq(long.people['qq:10001'].facts.length, 1, '重复提炼不会重复记事实');
eq(long.people['qq:10001'].facts[0].weight, 3, '重复提炼给事实加权');
eq(twice.persona.applied, 0, '重复提炼不会重复改人设');

// 空结果不炸
const emptyApply = applyDigest({ sessionKey: 'group:123456', digest: null, short, long, personaText: '', now });
eq(emptyApply.people, 0, 'null 结果安全返回');

console.log(`\n记忆提炼层单测：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
