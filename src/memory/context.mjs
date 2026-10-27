// 把三层记忆拼成一段可注入的 prompt 文本。
//
// 为什么单独一个模块：注入点（bridge.js 的 withContextBlocks）只该负责「什么时候加」，
// 「加什么、加多少、超预算先砍谁」属于记忆自己的事。放这里之后，MCP 工具、控制台预览、
// 离线单测能共用同一套输出，不会出现「控制台看到的是 A，模型收到的是 B」。
import {
  buildLongText,
  buildPersonaText,
  buildShortText,
  canonicalKey,
  relativeDayLabel,
  dayKey,
} from './store.mjs';

/** 三层各自的标题。改这里等于改模型看到的世界，慎重。 */
const HEADINGS = Object.freeze({
  persona: '【关于你自己】',
  short: '【最近几天聊过什么】',
  long: '【你对这些人的了解】',
});

/** 写在提示词里的一句话要求。不同层有不同语气：人设是「你就是」，记忆是「你还记得」。 */
const NOTES = Object.freeze({
  persona: '（这是你最近形成的自我认知，跟人格卡一起生效。自然一点，别照着念。）',
  short: '（按时间从近到远。除非有人问起，不要主动复述；只是让你知道聊过什么。）',
  long: '（是你自己的印象，可能过时。当天的细节说错比不提更糟，不确定就只说大方向。）',
});

export const DEFAULT_CONTEXT_CONFIG = Object.freeze({
  enabled: true,
  /** 注入总字数预算（含标题）。超了按 persona > short > long 的顺序砍。 */
  maxChars: 1200,
  /** 短期注入几天。跟 store 的保留天数不是一回事：保留 3 天，不一定每次都提 3 天。 */
  shortDays: 3,
  /** 每天最多提几件事。 */
  shortPerDay: 3,
  /** 长期注入几个人。 */
  longPeople: 5,
  /** 长期块的字数上限。 */
  longMaxChars: 600,
  /** 是否注入人设叠加层。 */
  includePersona: true,
});

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 合并用户配置与默认值。config.json 是手写的，什么都可能填错。 */
export function resolveContextConfig(raw = {}) {
  const cfg = { ...DEFAULT_CONTEXT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    enabled: cfg.enabled !== false,
    maxChars: clampNumber(cfg.maxChars, 200, 8000, DEFAULT_CONTEXT_CONFIG.maxChars),
    shortDays: clampNumber(cfg.shortDays, 1, 7, DEFAULT_CONTEXT_CONFIG.shortDays),
    shortPerDay: clampNumber(cfg.shortPerDay, 1, 8, DEFAULT_CONTEXT_CONFIG.shortPerDay),
    longPeople: clampNumber(cfg.longPeople, 0, 20, DEFAULT_CONTEXT_CONFIG.longPeople),
    longMaxChars: clampNumber(cfg.longMaxChars, 100, 3000, DEFAULT_CONTEXT_CONFIG.longMaxChars),
    includePersona: cfg.includePersona !== false,
  };
}

/**
 * 生成注入块。
 *
 * @param {object} args
 * @param {string} args.key            会话 key（`group:123` / `private:456`）
 * @param {object} [args.short]        store 的短期状态
 * @param {object} [args.long]         store 的长期状态
 * @param {string} [args.personaText]  人设书正文（markdown）
 * @param {string[]} [args.names]      当前这条消息里点到的名字（用于挑人物卡）
 * @param {object} [args.config]       原始配置（会被 resolveContextConfig 归一）
 * @param {Date}   [args.now]
 * @returns {{ text: string, sections: {persona:boolean, short:boolean, long:boolean}, chars: number }}
 */
export function buildMemoryContext({
  key,
  short = null,
  long = null,
  personaText = '',
  names = [],
  config = {},
  now = new Date(),
} = {}) {
  const cfg = resolveContextConfig(config);
  const empty = { text: '', sections: { persona: false, short: false, long: false }, chars: 0 };
  if (!cfg.enabled) return empty;
  if (!canonicalKey(key)) return empty;

  const blocks = [];

  // ① 人设叠加层：优先级最高，宁可砍记忆也不砍它——记错事顶多尴尬，人设崩了是全局崩。
  if (cfg.includePersona) {
    const body = buildPersonaText(personaText);
    if (body) blocks.push({ id: 'persona', text: `${HEADINGS.persona}\n${NOTES.persona}\n${body}` });
  }

  // ② 短期：最近几天的话题。
  if (short) {
    const body = buildShortText(short, { keys: [key], now, keepDays: cfg.shortDays, perDay: cfg.shortPerDay });
    if (body) blocks.push({ id: 'short', text: `${HEADINGS.short}\n${NOTES.short}\n${body}` });
  }

  // ③ 长期：人物卡 + 本会话话题卡。
  if (long && cfg.longPeople > 0) {
    const { text: body } = buildLongText(long, { key, names, now, maxPeople: cfg.longPeople, maxChars: cfg.longMaxChars });
    if (body) blocks.push({ id: 'long', text: `${HEADINGS.long}\n${NOTES.long}\n${body}` });
  }

  if (!blocks.length) return empty;

  // 预算裁剪：从最后一个块开始整个块地丢（不切半句，切半句比没有更糟）。
  let total = blocks.reduce((sum, b) => sum + b.text.length, 0) + (blocks.length - 1) * 2;
  const kept = [...blocks];
  while (total > cfg.maxChars && kept.length > 1) {
    const removed = kept.pop();
    total -= removed.text.length + 2;
  }

  const text = kept.map((b) => b.text).join('\n\n');
  return {
    text: total > cfg.maxChars ? text.slice(0, cfg.maxChars) : text,
    sections: {
      persona: kept.some((b) => b.id === 'persona'),
      short: kept.some((b) => b.id === 'short'),
      long: kept.some((b) => b.id === 'long'),
    },
    chars: Math.min(total, cfg.maxChars),
  };
}

/**
 * 控制台/调试用的摘要：不含正文，只说「有什么、多少字、各层命中没」。
 * 控制台要显示完整正文也不需要走这里（直接读文件即可），这里只做体检。
 */
export function describeMemoryContext(built, { now = new Date() } = {}) {
  return {
    chars: built?.chars ?? 0,
    sections: built?.sections ?? { persona: false, short: false, long: false },
    preview: (built?.text ?? '').slice(0, 240),
    day: dayKey(now),
    dayLabel: relativeDayLabel(dayKey(now), now),
  };
}
