// 记忆库的离线单测（不碰 DSH、不碰 QQ、不发网络请求）。
//
// 覆盖的都是「错了会很难查」的地方：本地日期不串天、读失败不等于空库、
// 人设补丁的护栏、注入预算裁剪。跑法：node scripts/test-memory-store.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addShortTopics,
  addTopicCard,
  applyPersonaPatch,
  buildLongText,
  buildPersonaText,
  buildShortText,
  canonicalKey,
  dayKey,
  decayLong,
  defaultPersona,
  emptyLongState,
  emptyShortState,
  loadLong,
  loadPersona,
  loadShort,
  parsePersonaSections,
  pruneShort,
  recentDayKeys,
  relativeDayLabel,
  saveLong,
  savePersona,
  saveShort,
  setShortCursor,
  upsertPerson,
} from '../src/memory/store.mjs';
import { buildMemoryContext, resolveContextConfig } from '../src/memory/context.mjs';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-memory-test-'));

try {
  // ── 日期 ────────────────────────────────────────────────────────────────
  const morning = new Date(2026, 9, 26, 1, 30); // 本地 10-26 01:30：用 toISOString 会串到 10-25
  eq(dayKey(morning), '2026-10-26', 'dayKey 用本地日期，不串天');
  eq(relativeDayLabel('2026-10-26', new Date(2026, 9, 26, 12)), '今天', '今天');
  eq(relativeDayLabel('2026-10-25', new Date(2026, 9, 26, 12)), '昨天', '昨天');
  eq(relativeDayLabel('2026-10-24', new Date(2026, 9, 26, 12)), '前天', '前天');
  eq(relativeDayLabel('2026-10-23', new Date(2026, 9, 26, 12)), '3天前', '三天前');
  eq(relativeDayLabel('2026-10-22', new Date(2026, 9, 26, 12)), '10-22', '四天以前直接给月-日');
  eq(recentDayKeys(new Date(2026, 9, 26, 12), 3), ['2026-10-26', '2026-10-25', '2026-10-24'], '最近三天');

  // ── key 归一化 ──────────────────────────────────────────────────────────
  eq(canonicalKey('group:0123'), 'group:123', 'key 去前导零');
  eq(canonicalKey('private:0'), null, '非法 key 返回 null');
  eq(canonicalKey('group:abc'), null, '非数字 key 返回 null');

  // ── 短期 ────────────────────────────────────────────────────────────────
  const short = emptyShortState();
  const r1 = addShortTopics(short, { key: 'group:123', topics: ['在聊新番', '某人在减肥'], day: '2026-10-26' });
  eq(r1.added, 2, '短期写入两条');
  const r2 = addShortTopics(short, { key: 'group:123', topics: ['在聊新番', '周末去哪'], day: '2026-10-26' });
  eq(r2.added, 1, '短期同一天按文本去重');
  addShortTopics(short, { key: 'group:123', topics: ['昨天的旧话题'], day: '2026-10-20' });
  const dropped = pruneShort(short, { now: new Date(2026, 9, 26, 12), keepDays: 3 });
  ok(dropped.includes('2026-10-20'), 'prune 丢掉超过 3 天的桶');
  ok(!short.days['2026-10-20'], 'prune 之后旧日期桶真的没了');

  const shortText = buildShortText(short, { keys: ['group:123'], now: new Date(2026, 9, 26, 12), perDay: 4 });
  ok(shortText.includes('今天：') && shortText.includes('在聊新番'), '短期注入文本含今天与话题');
  ok(!shortText.includes('2026-10-26'), '短期文本用「今天」而不是裸日期');

  setShortCursor(short, 'group:123', { lastSeq: 42 });
  eq(short.cursors['group:123'].lastSeq, 42, '游标记录 lastSeq');

  // ── 长期 ────────────────────────────────────────────────────────────────
  const long = emptyLongState();
  upsertPerson(long, '10001', { name: '阿蓝', impression: '嘴硬心软', facts: ['在准备考研'] });
  eq(long.people['10001'].facts.length, 1, '人物卡写入一条事实');
  upsertPerson(long, '10001', { facts: ['在准备考研'] });
  eq(long.people['10001'].facts.length, 1, '同一事实不重复记');
  eq(long.people['10001'].facts[0].weight, 3, '重复提到会加权');
  upsertPerson(long, '10001', { impression: '嘴硬心软，最近压力挺大', taboos: ['别问她体重'] });
  eq(long.people['10001'].impression, '嘴硬心软，最近压力挺大', '印象可以被新的覆盖');
  eq(long.people['10001'].taboos, ['别问她体重'], '禁忌累加');

  addTopicCard(long, 'group:123', { text: '在计划去漫展' });
  addTopicCard(long, 'group:123', { text: '在计划去漫展' });
  eq(long.topics['group:123'].length, 1, '话题卡去重');
  eq(long.topics['group:123'][0].weight, 3, '话题卡重复加权');

  const longText = buildLongText(long, { key: 'group:123', now: new Date(2026, 9, 26, 12) });
  ok(longText.text.includes('阿蓝') && longText.text.includes('在准备考研'), '长期注入文本含人物与事实');
  ok(longText.text.includes('别问她体重'), '长期文本带禁忌');

  // 衰减：把事实调成 40 天前、权重 1 → 归档
  long.people['10001'].facts[0].at = '2026-09-01T10:00:00+08:00';
  long.people['10001'].facts[0].weight = 1;
  const decayed = decayLong(long, { now: new Date(2026, 9, 26, 12), idleDays: 30 });
  eq(decayed.archived, 1, '久不提的事实被归档');
  eq(long.people['10001'].facts.length, 0, '归档后人物卡里没有这条了');
  ok(long.archived.length === 1 && long.archived[0].text === '在准备考研', '归档保留了原文');

  // ── 人设叠加层 ──────────────────────────────────────────────────────────
  let persona = defaultPersona();
  let res = applyPersonaPatch(persona, { add: [{ section: '喜好', text: '喜欢被人叫「老姐」，不喜欢被叫「主人」' }] });
  eq(res.applied.length, 1, '人设 add 生效');
  ok(res.text.includes('喜欢被人叫「老姐」'), '人设文本真的写进去了');
  persona = res.text;

  res = applyPersonaPatch(persona, { add: [{ section: '乱七八糟', text: '偷偷加一节' }] });
  eq(res.applied.length, 0, '白名单外的小节被拒');
  eq(res.rejected.length, 1, '拒绝有记录');

  res = applyPersonaPatch(persona, { remove: [{ section: '禁忌', text: '不许骂人' }] });
  eq(res.applied.length, 0, '禁忌小节不允许删除');
  eq(res.rejected[0].reason.includes('禁忌'), true, '禁忌拒绝原因明确');

  res = applyPersonaPatch(persona, { add: [{ section: '禁忌', text: '不许提起她的前任' }] });
  eq(res.applied.length, 1, '禁忌允许新增');
  persona = res.text;

  res = applyPersonaPatch(persona, {
    replace: [{ section: '喜好', from: '喜欢被人叫「老姐」，不喜欢被叫「主人」', to: '喜欢被叫「老姐」' }],
  });
  eq(res.applied.length, 1, '人设 replace 生效');
  ok(res.text.includes('喜欢被叫「老姐」') && !res.text.includes('不喜欢被叫「主人」'), 'replace 真的换了内容');
  persona = res.text;

  res = applyPersonaPatch(persona, {
    add: [
      { section: '喜好', text: 'a' }, { section: '喜好', text: 'b' },
      { section: '喜好', text: 'c' }, { section: '喜好', text: 'd' },
      { section: '喜好', text: 'e' }, { section: '喜好', text: 'f' },
    ],
  });
  eq(res.applied.length, 5, '单次最多应用 5 条');
  eq(res.rejected.length, 1, '超出的被拒');

  const sections = parsePersonaSections(persona);
  ok(sections.some((s) => s.name === '禁忌'), '人设能按 ## 切开');

  const personaText = buildPersonaText(persona);
  ok(personaText.includes('禁忌：') && personaText.includes('喜好：'), '人设注入文本按小节压缩成一行一行');
  ok(!personaText.includes('> 这一份是'), '人设注入不含说明块');

  // ── 注入块与预算 ────────────────────────────────────────────────────────
  const built = buildMemoryContext({
    key: 'group:123',
    short,
    long,
    personaText: persona,
    config: { maxChars: 1200 },
    now: new Date(2026, 9, 26, 12),
  });
  ok(built.text.includes('【关于你自己】'), '注入块含人设标题');
  ok(built.text.includes('【最近几天聊过什么】'), '注入块含短期标题');
  ok(built.text.length <= 1200, '注入块不超过预算');

  const tiny = buildMemoryContext({
    key: 'group:123', short, long, personaText: persona, config: { maxChars: 200 },
    now: new Date(2026, 9, 26, 12),
  });
  ok(tiny.text.length <= 200, '预算收紧后仍不超');
  ok(tiny.sections.persona === true, '预算收紧时优先保住人设');

  const off = buildMemoryContext({ key: 'group:123', short, long, personaText: persona, config: { enabled: false } });
  eq(off.text, '', 'enabled=false 时不注入');

  const badKey = buildMemoryContext({ key: 'garbage', short, long, personaText: persona });
  eq(badKey.text, '', '非法 key 不注入');

  ok(resolveContextConfig({ maxChars: 999999 }).maxChars <= 8000, 'maxChars 有上限');
  eq(resolveContextConfig({ maxChars: 'abc' }).maxChars, 1200, 'maxChars 填垃圾时回落到默认值');

  // ── 文件层 ──────────────────────────────────────────────────────────────
  const shortFile = path.join(tmp, 'short.json');
  const longFile = path.join(tmp, 'long.json');

  // 文件不存在 → 空库，不抛
  eq(loadShort(shortFile).days, {}, '文件不存在时返回空库');
  eq(loadLong(longFile).people, {}, '长期库同理');

  saveShort(shortFile, short);
  saveLong(longFile, long);
  ok(fs.existsSync(shortFile) && fs.existsSync(longFile), '保存后文件存在');
  eq(loadShort(shortFile).days['2026-10-26']['group:123'].topics.length >= 1, true, '短期存取往返正常');
  eq(Object.keys(loadLong(longFile).people).length, 1, '长期存取往返正常');

  // 损坏隔离
  fs.writeFileSync(shortFile, '{ 这不是 JSON', 'utf8');
  let threw = false;
  try { loadShort(shortFile); } catch { threw = true; }
  ok(threw, 'JSON 损坏时抛错而不是静默返回空');
  const quarantined = fs.readdirSync(tmp).filter((f) => f.includes('.corrupt-'));
  ok(quarantined.length === 1, '损坏文件被隔离成 .corrupt-*');

  // 人设文件：不存在时给模板但不落盘
  const memDir = path.join(tmp, 'memory');
  const loadedPersona = loadPersona(memDir);
  eq(loadedPersona.existed, false, '人设书不存在时 existed=false');
  ok(!fs.existsSync(path.join(memDir, 'persona.md')), '读模板不会顺手把文件写出来');
  savePersona(memDir, persona);
  eq(loadPersona(memDir).text.trim(), persona.trim(), '人设书存取往返正常');
  savePersona(memDir, persona.replace('喜欢被叫「老姐」', '喜欢被叫「姐姐」'));
  const snaps = fs.readdirSync(path.join(memDir, 'persona.history'));
  eq(snaps.length, 1, '改人设会留一份快照');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n记忆库单测：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
