// MCP 工具面的冒烟测试：真的把 server 拉起来、列工具、调一次。
// 跑法：node scripts/test-memory-mcp.mjs
//
// 为什么值得单独测：MCP 是唯一「模型会主动调用」的入口，它要是坏了不会报错，
// 只会表现成「AI 从来不查记忆」——这种静默失效最难被发现。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failed = 0;
let passed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; return; }
  failed += 1;
  console.error(`✗ ${label}`);
}

// 用系统 node 绝对路径，并把 Electron 的 env 过滤掉：
// 在 Chatbox 内置 node 里跑测试时，process.env 会带 Electron 的私有变量，
// 直接继承给子进程会让 MCP server 一启动就退（表现为"Connection closed"）。
const NODE = process.env.QQB_TEST_NODE || 'C:\\Program Files\\nodejs\\node.exe';
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(ELECTRON|npm_|VSCODE|CHATBOX|NODE_OPTIONS)/i.test(k))
);

const transport = new StdioClientTransport({
  command: NODE,
  args: [path.join(ROOT, 'src', 'memory', 'mcp-server.mjs')],
  cwd: ROOT,
  env: cleanEnv,
  stderr: 'inherit',
});

const client = new Client({ name: 'memory-mcp-test', version: '0.0.1' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  ok(names.includes('memory_recall'), '有 memory_recall 工具');
  ok(names.includes('persona_read'), '有 persona_read 工具');
  ok(names.includes('memory_stats'), '有 memory_stats 工具');
  ok(tools.every((t) => t.description && t.description.length > 10), '每个工具都有描述（模型只靠它决定用不用）');

  const stats = await client.callTool({ name: 'memory_stats', arguments: {} });
  const statsText = stats.content?.[0]?.text ?? '';
  ok(statsText.includes('people'), 'memory_stats 返回可解析的 JSON');

  const recall = await client.callTool({ name: 'memory_recall', arguments: { query: '不存在的人' } });
  const recallText = recall.content?.[0]?.text ?? '';
  ok(recallText.includes('hint') || recallText.includes('people'), '空结果时给的是提示而不是报错');

  const persona = await client.callTool({ name: 'persona_read', arguments: {} });
  ok((persona.content?.[0]?.text ?? '').length > 0, 'persona_read 有返回内容（空白模板也算）');
} catch (error) {
  failed += 1;
  console.error(`✗ MCP 连接/调用异常：${error?.message ?? error}`);
} finally {
  try { await client.close(); } catch { /* 关不掉不影响结论 */ }
}

console.log(`\n记忆 MCP 工具面测试：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
