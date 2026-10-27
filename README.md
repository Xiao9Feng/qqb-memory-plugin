# 三层记忆插件（qq-bridge 专用）

> 给 QQ 里的 AI 加上**跨天、跨重启**的记忆：短期话题 / 长期印象 / 人设自演化。
> 本包**只含记忆功能**，不含任何额外玩法。

有两种人可以用它：

- **人**：照「安装方式 A（一键）」走，四条命令以内。
- **AI**：直接把整个包连同这份 README 丢给它，让它自己读自己装。

---

## 它解决什么问题

qq-bridge 自带的 `qq_memory_append` 是**会话内**速记（`activeTopics` / `memberImpressions`），会话一重置就没了。这个插件是跨天、跨重启的沉淀层：

| 层 | 存什么 | 生命周期 |
|---|---|---|
| 短期 | 这几天每个群/私聊聊过什么话题 | 滚动 3 天 |
| 长期 | 人物卡（印象/性格/重要事实/忌讳）、会话话题卡、事件 | 永久，30 天不提自动降权归档 |
| 人设叠加层 | 聊出来的自我认知（七个小节，可演化） | 永久，每次改动留快照 |

三层加起来注入到每条消息前面，预算 1200 字（可配），超了按「人设 > 短期 > 长期」整块砍。

**写入方只有一个**：桥接进程的后台整理任务（整份读进内存、改完整份写回）。MCP 工具是**只读**的——两边同时写会互相覆盖，而且谁都不报错，那种「记忆莫名其妙丢了」的 bug 最难查。

---

## 包里有什么

```
install-memory.ps1                一键安装器（Windows）
README.md                         本文件
docs/MEMORY-详细文档.md            设计细节与数据结构
src/memory/store.mjs              持久层：三层 JSON + 原子写 + 损坏隔离
src/memory/context.mjs            注入块拼装 + 预算裁剪
src/memory/digest.mjs             提炼 prompt + 脏 JSON 容错
src/memory/mcp-server.mjs         只读 MCP 工具面
scripts/install-memory.mjs        接线器：把 8 处改动插进 src/bridge.js
scripts/memory-cli.mjs            命令行：看/查/手改记忆
scripts/test-memory-store.mjs     单测（63 项）
scripts/test-memory-digest.mjs    单测（40 项）
scripts/test-memory-mcp.mjs       工具面冒烟（7 项）
```

---

## 前置条件

| 项 | 要求 | 怎么查 |
|---|---|---|
| Node.js | **>= 22.13** | `node -v` |
| qq-bridge | **v0.2.1-r1**（接线锚点按这个版本写） | `node -p "require('./package.json').version"` |
| 操作系统 | Windows（PowerShell 5.1+）；模块本身是纯 Node，Linux/macOS 也能跑，只是 `install-memory.ps1` 是 PowerShell | — |

> 版本不是 `0.2.1-r1` 时**不要硬装**：安装器会以「锚点不存在」安全退出（不会改坏文件）。先跑一次自检（见下）把结果发出来，锚点要按你的版本调整。

---

## 先自检（30 秒，强烈建议）

```powershell
cd <qq-bridge 仓库根目录>
powershell -ExecutionPolicy Bypass -File .\install-memory.ps1 -Repo . -Check
```

- 输出「✓ 锚点全部命中，可以安装」→ 放心装
- 输出「✗ 锚点不存在：xxx」→ 你的 qq-bridge 版本不同，**一个字节都没改**，把这段报错发出来

---

## 安装方式 A：一键（推荐）

把整个包解压到任意位置（不要解压进仓库里也行），然后在**包目录**里：

```powershell
# 1) 自检（可选但建议）
powershell -ExecutionPolicy Bypass -File .\install-memory.ps1 -Repo D:\你的\qq-bridge -Check

# 2) 真装（复制文件 + 接线 + 跑单测）
powershell -ExecutionPolicy Bypass -File .\install-memory.ps1 -Repo D:\你的\qq-bridge
```

PATH 里没有 `node` 时加一个参数：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-memory.ps1 -Repo D:\你的\qq-bridge -Node "$env:ProgramFiles\nodejs\node.exe"
```

脚本会：复制模块 → 备份 `src/bridge.js.bak-before-memory` → 接线 → `node --check` 语法检查（不通过自动回滚）→ 跑三个单测。

装完还剩三步（脚本最后也会打出来）：

1. 把 `config.example.json` 里新增的 `"memory": { ... }` 整段抄进你的 `config.json`
2. 重启桥接
3. 可选：挂 MCP（见下文）

---

## 安装方式 B：手动四步

### 第 1 步：复制文件

```
本包/src/memory/        →  <仓库>/src/memory/        （4 个 .mjs）
本包/scripts/*.mjs      →  <仓库>/scripts/            （5 个 .mjs）
```

### 第 2 步：跑接线器（必须在仓库根目录）

```powershell
cd <仓库>
node scripts/install-memory.mjs            # 真装
node scripts/install-memory.mjs --check    # 只自检，不改文件
```

**期望输出**：

```
✓ 记忆插件安装完成，共改动 8 处：
  · import 语句
  · 记忆文件常量
  · 记忆状态与保存函数
  · 记忆提炼执行链
  · withContextBlocks 替换（含 4 处调用点）
  · 学习会话清理条件放宽
  · 启动记忆调度器
  · config.example.json 加 memory 段
```

脚本行为：自动备份 → 接线 → `node --check`（不通过自动回滚）→ 幂等（重复跑会直接跳过）。

### 第 3 步：把 memory 段抄进 config.json

打开 `<仓库>/config.example.json`，把里面新增的 `"memory": { ... }` 整段复制进 `config.json`（放在 `"slang"` 段后面、`"social"` 前面）。

如果 `config.json` 本来就没有这俩段，直接 `Copy-Item config.example.json config.json` 再改其它字段更省事（记得重填 `ownerQQ` / 白名单）。

### 第 4 步：重启桥接

```powershell
# 停（3100 是控制台端口，按你自己的端口改）
$c = Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue
if ($c) { $c.OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force } }
# 起：用你自己的启动方式（start.bat / 计划任务 / vbs 都行）
```

---

## 验证（三条都过才算成功）

**① 模块单测**

```
node scripts/test-memory-store.mjs    期望：63 通过，0 失败
node scripts/test-memory-digest.mjs   期望：40 通过，0 失败
node scripts/test-memory-mcp.mjs      期望：7 通过，0 失败
```

**② 启动日志**（桥接日志里必须出现这两行）

```
记忆已加载：短期 0 天，长期 0 人，人设叠加层还是空白模板
记忆调度已启动：每 10 分钟扫一次，单会话攒满 20 条新消息才整理
```

**③ 数据目录会自动生成**（攒够 20 条消息之后）

```powershell
Test-Path <仓库>\state\memory\short.json
Test-Path <仓库>\state\memory\long.json
```

---

## 可选：让 AI 能主动查记忆（只读 MCP）

默认记忆只会**被动注入**（每条消息前面带一段）。想让 AI 自己查（「上次某人说过什么来着」），挂一个只读 MCP：

编辑 `%USERPROFILE%\.dsh\profiles\<profile 名>\cordis.patch.yml`（默认 profile 叫 `web`），追加：

```yaml
- insert:
    - id: mcp-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memory
        transport: stdio
        command: '<你的 node.exe 完整路径>'       # Windows 上通常 C:\Program Files\nodejs\node.exe
        args:
          - '<你的仓库绝对路径>\src\memory\mcp-server.mjs'
```

> 两个绝对路径必须写全，MCP 是 DSH 用 spawn 拉起的子进程，工作目录不确定，相对路径会找不到文件。

然后重启 DSH。工具会以 `mcp__memory__` 前缀出现：

| 工具 | 作用 |
|---|---|
| `memory_recall` | 按人/关键词召回 |
| `persona_read` | 读人设叠加层 |
| `memory_stats` | 看记忆库规模（排查「它怎么不记得」用） |

---

## 日常用法

### 自动

- 每 10 分钟扫一遍所有会话；某个会话攒够 20 条新消息 → 触发一次整理
- 同一会话两次整理至少隔 30 分钟
- 整理时用一个独立 DSH 会话（标题「QQ 记忆整理」）读这批消息，输出结构化 JSON，落到三层
- 每 6 小时衰减一次（30 天没被提到的事实降权，降到 0 归档）

### 手动看 / 改

```powershell
node scripts/memory-cli.mjs show           # 总览
node scripts/memory-cli.mjs people         # 人物列表
node scripts/memory-cli.mjs person 阿蓝     # 某人详情
node scripts/memory-cli.mjs short          # 最近三天的话题
node scripts/memory-cli.mjs persona        # 人设叠加层
```

写入类命令**必须先停桥接**（否则桥接下次保存会覆盖你改的内容）：

```powershell
node scripts/memory-cli.mjs remember 阿蓝 在准备考研
node scripts/memory-cli.mjs taboo 阿蓝 别问她体重
node scripts/memory-cli.mjs persona-add 喜好 喜欢喝奶茶
```

### 配置项（`config.json` 的 `memory` 段）

| 键 | 默认 | 意思 |
|---|---|---|
| `enabled` | true | 总开关 |
| `digestMinMessages` | 20 | 攒够多少条新消息才整理 |
| `digestCooldownMs` | 1800000 | 同一会话两次整理的最小间隔（30 分钟） |
| `scanIntervalMs` | 600000 | 后台扫描间隔（10 分钟） |
| `digestTimeoutMs` | 180000 | 等整理会话回话的超时 |
| `idleDays` | 30 | 多少天没被提到开始降权 |
| `learnerPreset` | qq-chat | 整理用哪个 preset（必须和聊天同一个安全 preset） |
| `persona.enabled` | true | 允不允许 AI 自己改人设 |
| `context.maxChars` | 1200 | 注入总预算 |
| `context.shortDays` | 3 | 注入时最多提几天 |
| `context.longPeople` | 5 | 注入时最多带几个人物卡 |

---

## 设计取舍（别改回去）

1. **读失败 ≠ 空库**。读不出来就整层停写并报错；当成空库继续会导致下次保存把磁盘上的记忆覆盖成空。
2. **JSON 坏了隔离不覆盖**：另存 `.corrupt-<时间戳>` 再抛错。
3. **人设只能小步改**：七个小节白名单 + 单次最多 5 条 + 「禁忌」只加不删 + 每次留快照。不锁的话聊两万句后人设就漂了。
4. **提炼只要「长期有用」的信息**：闲聊流水不记；密码/身份证/住址/手机号明确禁止。
5. **游标存消息时间，不存整理时间**：整理要几十秒，期间新到的消息不能被当成已消化。
6. **注入失败不能挡住发消息**：记忆坏了最多「这次没记忆」，报个错就够。

---

## 排错

| 症状 | 查什么 |
|---|---|
| 安装器说「锚点不存在」 | qq-bridge 版本不是 0.2.1-r1。**文件没被改动**，把报错发出来，锚点要按你的版本补 |
| 安装器说「锚点不唯一」 | 你的 `src/bridge.js` 被别的补丁动过同一段，手工比对后再装 |
| AI 完全不提以前的事 | `node scripts/memory-cli.mjs show` 有没有数据；`memory.enabled` 是不是 false |
| 有数据但不注入 | 桥接日志搜「记忆注入失败」；`context.enabled` / `maxChars` 是不是太小 |
| 一直不整理 | 日志搜「记忆整理」；攒够 20 条了吗；DSH 在线吗 |
| 整理报 JSON 解析失败 | 日志里有原文片段；多半是 `learnerPreset` 的模型太弱 |
| 人设越改越怪 | 回滚 `state/memory/persona.history/` 里上一版；或把 `persona.enabled` 关掉 |
| 怀疑被覆盖 | 看有没有 `.corrupt-*`；确认没在桥接运行时跑 CLI 写入 |
| 想整个删掉 | 恢复 `src/bridge.js.bak-before-memory`，删 `src/memory/`，删 `state/memory/`，删 `config.json` 的 memory 段 |

---

## 回滚

安装器在接线前自动备份：

```
<仓库>/src/bridge.js.bak-before-memory
```

彻底卸载：

```powershell
cd <仓库>
Copy-Item src\bridge.js.bak-before-memory src\bridge.js -Force
Remove-Item src\memory -Recurse -Force
Remove-Item scripts\install-memory.mjs,scripts\memory-cli.mjs,scripts\test-memory-*.mjs -Force
# 想连记忆数据一起删：
Remove-Item state\memory -Recurse -Force
# 再从 config.json 里删掉 memory 段
```

之后再重启桥接即可。
