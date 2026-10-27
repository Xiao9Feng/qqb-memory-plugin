// 记忆的 MCP 工具面（stdio），给 DSH 里的 agent 主动查记忆用。
//
// ── 为什么这个 server **只读** ───────────────────────────────────────────
//
// 记忆的写入方是桥接进程（bridge.js）里的后台整理任务，它把 short.json / long.json /
// persona.md 整个读进内存、改完再整份写回。如果这个 MCP server 也去写同一批文件，
// 两边就会互相覆盖：agent 刚记下一条，桥接下一次保存就把它抹了——而且谁都不会报错，
// 只是记忆「莫名其妙丢了」。这类 bug 查起来极其折磨人。
//
// 所以分工写死：
//   写 → 桥接（自动整理）+ memory-cli.mjs（人工维护，桥接停机时用）
//   读 → 这里（每一轮都是实时从磁盘读，永远看到最新落盘的那一份）
//
// 工具：
//   memory_recall  按人/关键词/会话召回记忆
//   persona_read   读人设叠加层
//   memory_stats   看一眼记忆库有多大（排查「为什么它不记得」时先看这个）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  buildLongText,
  buildPersonaText,
  buildShortText,
  canonicalKey,
  loadLong,
  loadPersona,
  loadShort,
  relativeDayLabel,
  dayKey,
} from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const MEMORY_DIR = path.join(ROOT, 'state', 'memory');

/** 读失败一律降级成空，绝不因为「记忆坏了」让工具调用整个失败。 */
function safeLoad(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function readShort() {
  return safeLoad(() => loadShort(path.join(MEMORY_DIR, 'short.json')), { version: 1, days: {}, cursors: {} });
}

function readLong() {
  return safeLoad(() => loadLong(path.join(MEMORY_DIR, 'long.json')), { version: 1, people: {}, topics: {}, events: [], archived: [] });
}

function readPersona() {
  return safeLoad(() => loadPersona(MEMORY_DIR).text, '');
}

/** 关键词召回：名字/别名/印象/事实/禁忌里命中的都算，命中的字段越多排得越前。 */
function searchPeople(long, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) {
    // 没给关键词就按「最近提到过」排，给 agent 一个默认视野。
    return Object.entries(long.people ?? {})
      .sort((a, b) => String(b[1].lastSeenAt).localeCompare(String(a[1].lastSeenAt)))
      .slice(0, 8)
      .map(([id, person]) => ({ id, person, score: 0 }));
  }
  const scored = [];
  for (const [id, person] of Object.entries(long.people ?? {})) {
    let score = 0;
    const hay = [
      person.name,
      ...(person.aliases ?? []),
      person.impression,
      ...(person.traits ?? []),
      ...(person.facts ?? []).map((f) => f.text),
      ...(person.taboos ?? []),
      ...(person.topics ?? []).map((t) => t.text),
    ].filter(Boolean).join('\n').toLowerCase();
    if (hay.includes(q)) score += 10;
    if (String(person.name ?? '').toLowerCase().includes(q)) score += 20;
    for (const alias of person.aliases ?? []) if (String(alias).toLowerCase().includes(q)) score += 15;
    if (score > 0) scored.push({ id, person, score });
  }
  return scored.sort((a, b) => b.score - a.score || String(b.person.lastSeenAt).localeCompare(String(a.person.lastSeenAt))).slice(0, 8);
}

/** 把人物卡压成便于模型阅读的一段文本。 */
function formatPerson({ id, person }) {
  const bits = [];
  if (person.impression) bits.push(person.impression);
  if (person.traits?.length) bits.push(`性格：${person.traits.join('、')}`);
  for (const fact of (person.facts ?? []).slice(-6)) {
    const when = fact.at && Number.isFinite(Date.parse(fact.at))
      ? `（${relativeDayLabel(dayKey(new Date(fact.at)))}）`
      : '';
    bits.push(`${fact.text}${when}`);
  }
  if (person.taboos?.length) bits.push(`别碰：${person.taboos.join('、')}`);
  return `${person.name || id}：${bits.join('；') || '（还没形成印象）'}`;
}

const server = new McpServer({ name: 'qq-memory', version: '0.1.0' });

server.tool(
  'memory_recall',
  '从长期记忆里召回信息：某个人是谁、有什么印象和重要事实，以及某个会话里聊过的话题。'
  + '当你不确定对方提过的事、想确认某人的喜好/忌讳、或者要接着聊之前的话题时用。'
  + '返回的是你可能已经过时的印象，说错细节不如只说大方向。',
  {
    query: z.string().optional().describe('关键词：人名、话题、事件片段。留空则返回最近最活跃的几个人。'),
    key: z.string().optional().describe('会话 key（如 group:123456 / private:789012），用于带出该会话的话题卡。可省略。'),
  },
  async ({ query, key } = {}) => {
    const long = readLong();
    const short = readShort();
    const people = searchPeople(long, query);
    const ck = canonicalKey(key);

    const payload = {
      people: people.map((p) => ({ id: p.id, name: p.person.name, line: formatPerson(p) })),
      ...(ck && long.topics?.[ck] ? {
        sessionTopics: long.topics[ck].map((t) => ({ text: t.text, status: t.status ?? '', weight: t.weight ?? 0 })),
      } : {}),
      ...(ck ? { recentDays: buildShortText(short, { keys: [ck], perDay: 5 }) || '（这几天没记到话题）' } : {}),
    };
    if (people.length === 0) payload.hint = '没有匹配的记忆。可能是还没聊到，也可能关键词不对——别硬编。';
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

server.tool(
  'persona_read',
  '读你自己的人设叠加层：聊出来的自我认知（喜好、厌恶、关系、禁忌）。'
  + '跟人格卡一起生效，但它只记「最近形成的变化」。想知道自己最近是什么样时用。',
  {},
  async () => {
    const text = readPersona();
    const condensed = buildPersonaText(text);
    return {
      content: [{
        type: 'text',
        text: condensed
          ? `${condensed}\n\n（原始文件：state/memory/persona.md）`
          : '人设叠加层还是空白——说明还没有什么值得沉淀的变化，照人格卡来就行。',
      }],
    };
  }
);

server.tool(
  'memory_stats',
  '看一眼记忆库里有什么（规模统计，不含正文）。怀疑「它怎么不记得」时先查这个。',
  {},
  async () => {
    const long = readLong();
    const short = readShort();
    const people = Object.values(long.people ?? {});
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          dir: MEMORY_DIR,
          people: people.length,
          facts: people.reduce((sum, p) => sum + (p.facts?.length ?? 0), 0),
          sessionTopics: Object.values(long.topics ?? {}).reduce((sum, list) => sum + (list?.length ?? 0), 0),
          events: long.events?.length ?? 0,
          archived: long.archived?.length ?? 0,
          shortDays: Object.keys(short.days ?? {}),
          personaChars: readPersona().length,
          newestPeople: people
            .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
            .slice(0, 5)
            .map((p) => `${p.name}（${p.mentions} 次）`),
        }, null, 2),
      }],
    };
  }
);

await server.connect(new StdioServerTransport());
