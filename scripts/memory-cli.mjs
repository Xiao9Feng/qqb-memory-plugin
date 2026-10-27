#!/usr/bin/env node
// 记忆库的人工入口：看、查、手改。
//
// ⚠️ 写入类命令（remember / forget / persona-*）请**先停掉桥接**再跑：
// 桥接把记忆整份读进内存、改完再整份写回，你这边改了它下一次保存会覆盖掉。
// 只读命令（show / people / person / short / persona / events）随时可以跑。
//
// 用法：
//   node scripts/memory-cli.mjs show              总览
//   node scripts/memory-cli.mjs people            人物列表
//   node scripts/memory-cli.mjs person 阿蓝        某个人详情（名字/别名模糊匹配）
//   node scripts/memory-cli.mjs short             最近三天的短期话题
//   node scripts/memory-cli.mjs persona           人设叠加层
//   node scripts/memory-cli.mjs events            事件流
//   node scripts/memory-cli.mjs remember <人> <事实>   手动记一条事实
//   node scripts/memory-cli.mjs taboo <人> <内容>      手动记一条忌讳
//   node scripts/memory-cli.mjs persona-add <小节> <内容>
//   node scripts/memory-cli.mjs persona-remove <小节> <内容>
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addEvent,
  applyPersonaPatch,
  buildPersonaText,
  loadLong,
  loadPersona,
  loadShort,
  relativeDayLabel,
  saveLong,
  savePersona,
  upsertPerson,
} from '../src/memory/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MEMORY_DIR = path.join(ROOT, 'state', 'memory');
const SHORT_FILE = path.join(MEMORY_DIR, 'short.json');
const LONG_FILE = path.join(MEMORY_DIR, 'long.json');

const [, , command, ...args] = process.argv;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function readLongSafe() {
  try { return loadLong(LONG_FILE); } catch (error) { fail(`长期记忆读取失败：${error.message}`); }
}

function writeLongSafe(state) {
  try { saveLong(LONG_FILE, state); } catch (error) { fail(`长期记忆保存失败：${error.message}`); }
}

/** 按名字/别名/ID 找人，找不到就返回 null（不做模糊猜测，避免改错人）。 */
function findPerson(long, needle) {
  const q = String(needle ?? '').trim().toLowerCase();
  if (!q) return null;
  for (const [id, person] of Object.entries(long.people ?? {})) {
    if (id.toLowerCase() === q || String(person.name).toLowerCase() === q) return { id, person };
  }
  for (const [id, person] of Object.entries(long.people ?? {})) {
    if (String(person.name).toLowerCase().includes(q)) return { id, person };
    if ((person.aliases ?? []).some((a) => String(a).toLowerCase().includes(q))) return { id, person };
  }
  return null;
}

function line(char = '─', n = 48) {
  return char.repeat(n);
}

switch (command) {
  case 'show': {
    const long = readLongSafe();
    const short = (() => { try { return loadShort(SHORT_FILE); } catch { return { days: {}, cursors: {} }; } })();
    const persona = loadPersona(MEMORY_DIR);
    const people = Object.values(long.people ?? {});
    console.log(`记忆库：${MEMORY_DIR}`);
    console.log(line());
    console.log(`人物卡     ${people.length} 个（事实 ${people.reduce((s, p) => s + (p.facts?.length ?? 0), 0)} 条）`);
    console.log(`会话话题   ${Object.keys(long.topics ?? {}).length} 个会话`);
    console.log(`事件       ${long.events?.length ?? 0} 条，归档 ${long.archived?.length ?? 0} 条`);
    console.log(`短期       ${Object.keys(short.days ?? {}).length} 天：${Object.keys(short.days ?? {}).sort().join('、') || '（空）'}`);
    console.log(`人设       ${persona.existed ? `${persona.text.length} 字` : '空白模板（还没沉淀过）'}`);
    if (people.length) {
      console.log(line());
      console.log('最近的几个人：');
      for (const p of people.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))).slice(0, 8)) {
        console.log(`  · ${p.name}（提到 ${p.mentions} 次）${p.impression ? ` — ${p.impression}` : ''}`);
      }
    }
    break;
  }

  case 'people': {
    const long = readLongSafe();
    const people = Object.values(long.people ?? {}).sort((a, b) => (b.mentions ?? 0) - (a.mentions ?? 0));
    if (!people.length) { console.log('还没有任何人物卡。'); break; }
    for (const p of people) {
      console.log(`${p.name}  提到 ${p.mentions} 次  最近 ${String(p.lastSeenAt).slice(0, 10)}`);
      if (p.impression) console.log(`  印象：${p.impression}`);
      for (const fact of p.facts ?? []) console.log(`  · ${fact.text}${fact.at ? `（${fact.at.slice(0, 10)}）` : ''}`);
      if (p.taboos?.length) console.log(`  别碰：${p.taboos.join('、')}`);
      console.log('');
    }
    break;
  }

  case 'person': {
    const long = readLongSafe();
    const found = findPerson(long, args.join(' '));
    if (!found) fail(`找不到「${args.join(' ')}」`);
    const p = found.person;
    console.log(`${p.name}（${found.id}）`);
    console.log(line());
    if (p.impression) console.log(`印象：${p.impression}`);
    if (p.traits?.length) console.log(`性格：${p.traits.join('、')}`);
    console.log(`提到次数：${p.mentions}，最近：${p.lastSeenAt}`);
    if (p.facts?.length) {
      console.log(line());
      for (const fact of p.facts) console.log(`· ${fact.text}（权重 ${fact.weight}，${String(fact.at).slice(0, 10)}）`);
    }
    if (p.taboos?.length) {
      console.log(line());
      console.log(`别碰：${p.taboos.join('、')}`);
    }
    break;
  }

  case 'short': {
    let short = { days: {}, cursors: {} };
    try { short = loadShort(SHORT_FILE); } catch (error) { fail(`短期记忆读取失败：${error.message}`); }
    const keys = Object.keys(short.cursors ?? {});
    if (!keys.length && !Object.keys(short.days ?? {}).length) { console.log('短期记忆还是空的。'); break; }
    const now = new Date();
    for (const day of Object.keys(short.days ?? {}).sort().reverse()) {
      console.log(`${day}（${relativeDayLabel(day, now)}）`);
      for (const [key, bucket] of Object.entries(short.days[day])) {
        console.log(`  ${key}：${bucket.topics.map((t) => t.text).join('；')}`);
      }
    }
    break;
  }

  case 'persona': {
    const persona = loadPersona(MEMORY_DIR);
    console.log(persona.existed ? persona.text : '（还是空白模板）\n\n' + buildPersonaText(persona.text));
    break;
  }

  case 'events': {
    const long = readLongSafe();
    if (!long.events?.length) { console.log('还没有事件记录。'); break; }
    for (const e of long.events.slice(-30)) console.log(`${String(e.at).slice(0, 10)}  ${e.text}`);
    break;
  }

  case 'remember': {
    const [who, ...rest] = args;
    const fact = rest.join(' ').trim();
    if (!who || !fact) fail('用法：memory-cli.mjs remember <人> <事实>');
    const long = readLongSafe();
    const found = findPerson(long, who);
    const id = found?.id ?? `name:${who.toLowerCase()}`;
    upsertPerson(long, id, { name: who, facts: [{ text: fact, at: new Date().toISOString(), weight: 3 }] });
    writeLongSafe(long);
    console.log(`✓ 已记下：${who} — ${fact}`);
    break;
  }

  case 'taboo': {
    const [who, ...rest] = args;
    const textValue = rest.join(' ').trim();
    if (!who || !textValue) fail('用法：memory-cli.mjs taboo <人> <内容>');
    const long = readLongSafe();
    const found = findPerson(long, who);
    const id = found?.id ?? `name:${who.toLowerCase()}`;
    upsertPerson(long, id, { name: who, taboos: [textValue] });
    writeLongSafe(long);
    console.log(`✓ 已记下忌讳：${who} — ${textValue}`);
    break;
  }

  case 'persona-add':
  case 'persona-remove': {
    const [section, ...rest] = args;
    const textValue = rest.join(' ').trim();
    if (!section || !textValue) fail(`用法：memory-cli.mjs ${command} <小节> <内容>`);
    const persona = loadPersona(MEMORY_DIR);
    const patch = command === 'persona-add'
      ? { add: [{ section, text: textValue }] }
      : { remove: [{ section, text: textValue }] };
    const result = applyPersonaPatch(persona.text, patch);
    if (!result.applied.length) {
      fail(`没有改动：${result.rejected.map((r) => r.reason).join('；') || '未知原因'}`);
    }
    savePersona(MEMORY_DIR, result.text);
    console.log(`✓ 人设已更新：${section} ${command === 'persona-add' ? '+' : '-'} ${textValue}`);
    console.log(`（旧版本已存到 state/memory/persona.history/）`);
    break;
  }

  case 'add-event': {
    const textValue = args.join(' ').trim();
    if (!textValue) fail('用法：memory-cli.mjs add-event <内容>');
    const long = readLongSafe();
    addEvent(long, { text: textValue, at: new Date().toISOString() });
    writeLongSafe(long);
    console.log(`✓ 已记下事件：${textValue}`);
    break;
  }

  default:
    console.log(`记忆库命令行工具

只读（随时可用）：
  show                总览
  people              人物列表
  person <名字>        某个人详情
  short               最近三天的短期话题
  persona             人设叠加层
  events              事件流

写入（先停桥接！）：
  remember <人> <事实>            记一条关于某人的事实
  taboo <人> <内容>               记一条忌讳
  persona-add <小节> <内容>       往人设里加一条
  persona-remove <小节> <内容>    从人设里删一条
  add-event <内容>                记一条事件

人设小节：我是谁 / 性格 / 说话方式 / 喜好 / 厌恶 / 关系 / 禁忌
数据目录：${MEMORY_DIR}`);
    break;
}
