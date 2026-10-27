// 三层记忆 · 自安装脚本（幂等）
//
// 用法：在 qq-bridge 仓库根目录执行
//   node scripts/install-memory.mjs
//
// 它会：把记忆接线插进 src/bridge.js、把 memory 段写进 config.example.json。
// 前提：qq-bridge v0.2.1-r1（锚点按这个版本写；版本不同会「锚点不存在」直接停，不会改坏文件）。
//
// 为什么做成脚本而不是「照着文档手工改」：
//   记忆的接线散在 10400 行的 bridge.js 里共 8 处，手工改必错且难查。
//   脚本改完会先做语法检查（node --check），不通过就回滚。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BRIDGE = path.join(ROOT, 'src', 'bridge.js');
const EXAMPLE = path.join(ROOT, 'config.example.json');
const BACKUP = path.join(ROOT, 'src', 'bridge.js.bak-before-memory');

if (!fs.existsSync(BRIDGE)) {
  console.error(`找不到 ${BRIDGE}——请在 qq-bridge 仓库根目录运行本脚本`);
  process.exit(1);
}

let src = fs.readFileSync(BRIDGE, 'utf8');
const hadBom = src.charCodeAt(0) === 0xfeff;
if (hadBom) src = src.slice(1);

if (src.includes("from './memory/store.mjs'")) {
  console.log('✓ 记忆插件已经装过了，跳过（幂等）');
  process.exit(0);
}

const done = [];
// --check：只检查锚点是否命中，一个字节都不改（给「先看兼容不兼容再决定装不装」用）
const CHECK_ONLY = process.argv.includes('--check');
function replaceOnce(oldText, newText, label) {
  const at = src.indexOf(oldText);
  if (at < 0) throw new Error(`锚点不存在：${label}\n（qq-bridge 版本可能不是 v0.2.1-r1）`);
  if (src.indexOf(oldText, at + 1) >= 0) throw new Error(`锚点不唯一：${label}`);
  src = src.slice(0, at) + newText + src.slice(at + oldText.length);
  done.push(label);
}

// ── 1) import ─────────────────────────────────────────────────────────────
replaceOnce(
  "import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from './role-card.js';",
  "import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from './role-card.js';\n"
  + "// 三层记忆：短期话题 / 长期卡片 / 人设叠加层（模块本身不认识 DSH 与 QQ）\n"
  + "import {\n"
  + "  decayLong, defaultPersona, emptyLongState, emptyShortState, getShortCursor,\n"
  + "  loadLong, loadPersona, loadShort, nowIso, pruneShort,\n"
  + "  saveLong, savePersona, saveShort, setShortCursor,\n"
  + "} from './memory/store.mjs';\n"
  + "import { buildMemoryContext, resolveContextConfig } from './memory/context.mjs';\n"
  + "import { applyDigest, buildDigestPrompt, parseDigestJson } from './memory/digest.mjs';",
  'import 语句'
);

// ── 2) 常量 ───────────────────────────────────────────────────────────────
replaceOnce(
  "const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');",
  "const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');\n"
  + "// 记忆库：三个文件分开存，坏一个不连坐\n"
  + "const MEMORY_DIR = path.join(STATE_DIR, 'memory');\n"
  + "const MEMORY_SHORT_FILE = path.join(MEMORY_DIR, 'short.json');\n"
  + "const MEMORY_LONG_FILE = path.join(MEMORY_DIR, 'long.json');\n"
  + "const MEMORY_SESSION_FILE = path.join(MEMORY_DIR, 'digest-session.json');",
  '记忆文件常量'
);

// ── 3) 状态 + 加载 + 保存 ─────────────────────────────────────────────────
replaceOnce(
  '  let slangTaskChain = Promise.resolve();',
  `  let slangTaskChain = Promise.resolve();

  // ── 记忆（短期 / 长期 / 人设叠加层）────────────────────────────────────
  // 读失败 ≠ 空库：读失败就整层停写，否则下一次 save 会把磁盘上那份记忆覆盖成空。
  let memoryWritable = true;
  let memoryShort = emptyShortState();
  let memoryLong = emptyLongState();
  let memoryPersona = defaultPersona();
  let memoryPersonaExisted = false;
  let memorySessionId = null;
  let memoryTaskChain = Promise.resolve();
  const memoryCooldowns = new Map();
  let memoryLastDecayAt = 0;

  function memoryEnabled() {
    return cfg.memory?.enabled !== false;
  }

  if (memoryEnabled()) {
    try {
      memoryShort = loadShort(MEMORY_SHORT_FILE, { onCorrupt: (message) => log(\`⚠️ \${message}\`) });
      memoryLong = loadLong(MEMORY_LONG_FILE, { onCorrupt: (message) => log(\`⚠️ \${message}\`) });
      const persona = loadPersona(MEMORY_DIR, { onCorrupt: (message) => log(\`⚠️ \${message}\`) });
      memoryPersona = persona.text;
      memoryPersonaExisted = persona.existed;
      log(\`记忆已加载：短期 \${Object.keys(memoryShort.days).length} 天，长期 \${Object.keys(memoryLong.people).length} 人\`
        + (memoryPersonaExisted ? '，人设叠加层已就绪' : '，人设叠加层还是空白模板'));
    } catch (error) {
      memoryWritable = false;
      log(\`⚠️ 记忆库加载失败，已暂停写入以免覆盖磁盘数据：\${error?.message ?? error}\`);
    }
  }

  function saveMemoryShort() {
    if (!memoryWritable || !memoryEnabled()) return;
    try { saveShort(MEMORY_SHORT_FILE, memoryShort); } catch (error) { log('保存短期记忆失败:', error?.message ?? error); }
  }

  function saveMemoryLong() {
    if (!memoryWritable || !memoryEnabled()) return;
    try { saveLong(MEMORY_LONG_FILE, memoryLong); } catch (error) { log('保存长期记忆失败:', error?.message ?? error); }
  }

  function saveMemoryPersona() {
    if (!memoryWritable || !memoryEnabled()) return;
    try { savePersona(MEMORY_DIR, memoryPersona); } catch (error) { log('保存人设叠加层失败:', error?.message ?? error); }
  }

  /** 衰减按「30 天没被提到」判断，6 小时跑一次足够。 */
  function maybeDecayMemory() {
    if (!memoryEnabled()) return;
    const now = Date.now();
    if (now - memoryLastDecayAt < 6 * 60 * 60 * 1000) return;
    memoryLastDecayAt = now;
    const keepDays = Math.max(3, resolveContextConfig(cfg.memory?.context ?? {}).shortDays);
    const dropped = pruneShort(memoryShort, { now: new Date(now), keepDays });
    const decayed = decayLong(memoryLong, { now: new Date(now), idleDays: Math.max(7, Number(cfg.memory?.idleDays) || 30) });
    if (dropped.length || decayed.archived || decayed.weakened) {
      log(\`记忆整理：清理 \${dropped.length} 天旧短期记录，淡化 \${decayed.weakened} 条，归档 \${decayed.archived} 条\`);
      saveMemoryShort();
      saveMemoryLong();
    }
  }`,
  '记忆状态与保存函数'
);

// ── 4) 提炼执行链（挂在黑话提炼之前）───────────────────────────────────────
replaceOnce(
  '  async function runSlangExtraction(key) {',
  `  // ── 记忆整理（短期话题 + 长期卡片 + 人设演化）────────────────────────
  // 复用黑话学习那套设施（独立 DSH 会话 + waitLearnerTurn 收回复），但用自己的会话：
  // 黑话提炼和记忆提炼混在一个对话历史里，模型会串。
  function queueMemoryTask(fn) {
    memoryTaskChain = memoryTaskChain.then(fn).catch((error) => log('记忆任务异常:', error?.message ?? error));
    return memoryTaskChain;
  }

  function invalidateMemorySession() {
    const oldId = memorySessionId;
    memorySessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) learnerSessions.delete(oldId);
    try { fs.unlinkSync(MEMORY_SESSION_FILE); } catch {}
  }

  async function ensureMemorySession() {
    const preset = resolvePresetName(cfg.memory?.learnerPreset || cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('记忆整理缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(MEMORY_SESSION_FILE, null);
    if (saved?.preset !== preset) invalidateMemorySession();
    if (memorySessionId) {
      learnerSessions.add(memorySessionId);
      api.events.follow(memorySessionId);
      return memorySessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      memorySessionId = String(saved.sessionId);
      learnerSessions.add(memorySessionId);
      api.events.follow(memorySessionId);
      await ensureChatModel(memorySessionId);
      return memorySessionId;
    }
    const dir = path.join(MEMORY_DIR, 'digest-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'memory workspace.create');
    const workspaceTitle = cfg.memory?.workspaceTitle || 'QQ 记忆整理';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'memory session.create');
    memorySessionId = value.sessionId;
    learnerSessions.add(memorySessionId);
    api.events.follow(memorySessionId);
    await ensureChatModel(memorySessionId);
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    atomicWriteJson(MEMORY_SESSION_FILE, { sessionId: memorySessionId, preset });
    log(\`记忆整理会话已创建：\${memorySessionId}\`);
    return memorySessionId;
  }

  /** 取「上次消化之后」的新消息。游标存消息时间，不存整理时间。 */
  function memoryFreshMessages(key) {
    const st = socialV2.conversations.get(key) ?? null;
    const v2Recent = Array.isArray(st?.recentMessages) ? st.recentMessages : null;
    const v1Recent = social.recentMessages?.get?.(key);
    const recent = v2Recent ?? (Array.isArray(v1Recent) ? v1Recent : []);
    const cursor = getShortCursor(memoryShort, key);
    const since = cursor?.lastAt ? Date.parse(cursor.lastAt) : 0;
    const fresh = recent.filter((m) => m && (!since || (Number(m.time) || 0) > since));
    return { st, fresh };
  }

  async function runMemoryDigest(key, { force = false } = {}) {
    if (!memoryEnabled()) return { ok: false, reason: 'disabled' };
    if (!memoryWritable) return { ok: false, reason: 'readonly' };
    if (!dshReady) return { ok: false, reason: 'dsh-offline' };

    const { st, fresh } = memoryFreshMessages(key);
    const min = Math.max(4, Number(cfg.memory?.digestMinMessages) || 20);
    if (!fresh.length) return { ok: false, reason: 'nothing-new' };
    if (!force && fresh.length < min) return { ok: false, reason: 'not-enough' };

    let sessionId;
    try {
      sessionId = await ensureMemorySession();
    } catch (error) {
      log(\`记忆整理会话创建失败 (\${key}):\`, error?.message ?? error);
      return { ok: false, reason: 'session' };
    }

    const promptText = buildDigestPrompt({
      key,
      messages: fresh,
      existing: memoryLong,
      personaText: memoryPersona,
      wantPersona: cfg.memory?.persona?.enabled !== false,
      now: new Date()
    });

    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(\`记忆整理被拒 (\${key}): \${accepted.result.error.code}: \${accepted.result.error.message}\`);
        return { ok: false, reason: 'rejected' };
      }
      const output = await waitLearnerTurn(sessionId, Number(cfg.memory?.digestTimeoutMs) || 180000);
      const digest = parseDigestJson(output);
      if (digest.parseError) log(\`记忆整理解析失败 (\${key}): \${digest.parseError}\`);

      const applied = applyDigest({
        sessionKey: key,
        digest,
        short: memoryShort,
        long: memoryLong,
        personaText: memoryPersona,
        now: new Date()
      });

      if (applied.text && applied.text !== memoryPersona) {
        memoryPersona = applied.text;
        saveMemoryPersona();
      }
      saveMemoryShort();
      saveMemoryLong();

      const newest = fresh.reduce((max, m) => Math.max(max, Number(m.time) || 0), 0);
      setShortCursor(memoryShort, key, {
        lastSeq: Number(st?.lastUnreadSeq) || 0,
        at: newest ? new Date(newest).toISOString() : nowIso()
      });
      saveMemoryShort();

      maybeDecayMemory();
      log(\`记忆整理完成 \${key}：话题 +\${applied.shortAdded}，人物 \${applied.people}，事项 \${applied.sessionTopics}，事件 \${applied.events}，人设改动 \${applied.persona.applied}\`);
      return { ok: true, applied };
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) invalidateMemorySession();
      log(\`记忆整理失败 (\${key}):\`, error?.message ?? error);
      return { ok: false, reason: 'exception', error: String(error?.message ?? error) };
    }
  }

  function maybeQueueMemoryDigest(key) {
    if (!memoryEnabled() || !dshReady) return;
    const cooldown = Math.max(60_000, Number(cfg.memory?.digestCooldownMs) || 30 * 60 * 1000);
    const last = memoryCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const { fresh } = memoryFreshMessages(key);
    const min = Math.max(4, Number(cfg.memory?.digestMinMessages) || 20);
    if (fresh.length < min) return;
    memoryCooldowns.set(key, Date.now());
    queueMemoryTask(() => runMemoryDigest(key));
  }

  function startMemoryScheduler() {
    if (!memoryEnabled()) return;
    const tick = Math.max(60_000, Number(cfg.memory?.scanIntervalMs) || 10 * 60 * 1000);
    const min = Math.max(4, Number(cfg.memory?.digestMinMessages) || 20);
    setInterval(() => {
      if (!dshReady || !memoryEnabled()) return;
      const keys = new Set([...socialV2.conversations.keys(), ...(social.recentMessages?.keys?.() ?? [])]);
      for (const key of keys) maybeQueueMemoryDigest(key);
      maybeDecayMemory();
    }, tick).unref?.();
    log(\`记忆调度已启动：每 \${Math.round(tick / 60000)} 分钟扫一次，单会话攒满 \${min} 条新消息才整理\`);
  }

  async function runSlangExtraction(key) {`,
  '记忆提炼执行链'
);

// ── 5) withSlangContext → withContextBlocks（整函数替换）──────────────────
{
  const startMarker = '  function withSlangContext(promptText) {';
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error('锚点不存在：withSlangContext 定义');
  const returnMarker = "    return parts.join('\\n\\n') + '\\n\\n' + promptText;";
  const returnAt = src.indexOf(returnMarker, start);
  if (returnAt < 0) throw new Error('锚点不存在：withSlangContext 的 return 行');
  const closeAt = src.indexOf('\n  }', returnAt);
  if (closeAt < 0) throw new Error('锚点不存在：withSlangContext 结束花括号');

  const replacement = [
    '  /**',
    '   * 每条投递给 AI 的 prompt 前面都挂这几块环境注入：当前时间 → 黑话表 → 记忆。',
    '   * 集中在一处，是因为桥接有多个投递入口；任何入口漏了，模型在那条消息上就"失忆"。',
    '   */',
    '  function withContextBlocks(promptText, key) {',
    '    const now = new Date();',
    "    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;",
    '    const parts = [timeLine];',
    '    if (cfg.slang?.enabled !== false) {',
    '      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8);',
    '      if (block) parts.push(block);',
    '    }',
    '    if (memoryEnabled() && key) {',
    '      try {',
    '        const block = buildMemoryContext({',
    '          key,',
    '          short: memoryShort,',
    '          long: memoryLong,',
    '          personaText: memoryPersona,',
    '          config: cfg.memory?.context ?? {},',
    '          now',
    '        });',
    '        if (block.text) parts.push(block.text);',
    '      } catch (error) {',
    "        log('记忆注入失败（本条消息无记忆）:', error?.message ?? error);",
    '      }',
    '    }',
    "    return parts.join('\\n\\n') + '\\n\\n' + promptText;",
    '  }',
  ].join('\n');

  src = src.slice(0, start) + replacement + src.slice(closeAt + '\n  }'.length);

  const before = (src.match(/withSlangContext\(promptText\)/g) || []).length;
  src = src.split('withSlangContext(promptText)').join('withContextBlocks(promptText, key)');
  if (before < 1) throw new Error('没有找到任何 withSlangContext 调用点（预期 4 处）');
  done.push(`withContextBlocks 替换（含 ${before} 处调用点）`);
}

// ── 6) 学习会话清理条件放宽（否则记忆会话 turn 结束就被踢出集合）──────────
{
  const oldCleanup = 'if (frame.sessionId !== slangLearnerSessionId) learnerSessions.delete(frame.sessionId);';
  const newCleanup = 'if (frame.sessionId !== slangLearnerSessionId && frame.sessionId !== memorySessionId) learnerSessions.delete(frame.sessionId);';
  const at = src.indexOf(oldCleanup);
  if (at >= 0) {
    src = src.slice(0, at) + newCleanup + src.slice(at + oldCleanup.length);
    done.push('学习会话清理条件放宽');
  } else {
    console.warn('⚠ 没找到 learnerSessions 清理条件，跳过（不影响主要功能，但记忆会话可能每次重建）');
  }
}

// ── 7) 挂调度器 ───────────────────────────────────────────────────────────
replaceOnce(
  '  setInterval(checkDsh, 5000);',
  '  setInterval(checkDsh, 5000);\n  // 记忆整理调度：不起就永远只有手动整理可用，等于没记忆。\n  startMemoryScheduler();',
  '启动记忆调度器'
);

if (CHECK_ONLY) {
  console.log('✓ 锚点全部命中，可以安装。共会改动 ' + done.length + ' 处：');
  for (const step of done) console.log('  · ' + step);
  console.log('')
  console.log('（本次是 --check，没有修改任何文件。去掉 --check 再跑一次才会真的装。）');
  process.exit(0);
}

// ── 写回 + 语法检查（不通过就回滚）────────────────────────────────────────
if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, (hadBom ? '\uFEFF' : '') + fs.readFileSync(BRIDGE, 'utf8'), 'utf8');
fs.writeFileSync(BRIDGE, (hadBom ? '\uFEFF' : '') + src, 'utf8');

try {
  execFileSync(process.execPath, ['--check', BRIDGE], { stdio: 'pipe' });
} catch (error) {
  fs.copyFileSync(BACKUP, BRIDGE);
  console.error('✗ 改完语法检查不通过，已自动回滚。请把下面的报错发出来：');
  console.error(String(error.stderr ?? error.message).slice(0, 800));
  process.exit(1);
}

// ── config.example.json 加 memory 段 ─────────────────────────────────────
{
  let ex = fs.readFileSync(EXAMPLE, 'utf8');
  const hadExBom = ex.charCodeAt(0) === 0xfeff;
  if (hadExBom) ex = ex.slice(1);
  if (!/^ {2}"memory"\s*:\s*\{/m.test(ex)) {
    const eol = ex.includes('\r\n') ? '\r\n' : '\n';
    const block = [
      '  "memory": {',
      '    "enabled": true,',
      '    "digestMinMessages": 20,',
      '    "digestCooldownMs": 1800000,',
      '    "scanIntervalMs": 600000,',
      '    "digestTimeoutMs": 180000,',
      '    "idleDays": 30,',
      '    "learnerPreset": "qq-chat",',
      '    "workspaceTitle": "QQ 记忆整理",',
      '    "persona": { "enabled": true },',
      '    "context": {',
      '      "enabled": true,',
      '      "maxChars": 1200,',
      '      "shortDays": 3,',
      '      "shortPerDay": 3,',
      '      "longPeople": 5,',
      '      "longMaxChars": 600,',
      '      "includePersona": true',
      '    }',
      '  },',
    ].join(eol);
    const socialAt = ex.indexOf(`${eol}  "social": {`);
    if (socialAt < 0) throw new Error('config.example.json 里找不到 social 段');
    ex = ex.slice(0, socialAt) + eol + block + ex.slice(socialAt);
    fs.writeFileSync(EXAMPLE, (hadExBom ? '\uFEFF' : '') + ex, 'utf8');
    JSON.parse(fs.readFileSync(EXAMPLE, 'utf8').replace(/^\uFEFF/, ''));
    done.push('config.example.json 加 memory 段');
  }
}

console.log('✓ 记忆插件安装完成，共改动 ' + done.length + ' 处：');
for (const step of done) console.log('  · ' + step);
console.log('\n接下来：');
console.log('  1) 把 config.example.json 的 memory 段抄进你的 config.json');
console.log('  2) 跑 node scripts/test-memory-store.mjs && node scripts/test-memory-digest.mjs 确认模块正常');
console.log('  3) 重启桥接（记忆调度器在启动时挂载）');
console.log('  4) 重启 DSH 并在 cordis.patch.yml 挂 mcp-memory（可选，让 AI 能主动查记忆）');
