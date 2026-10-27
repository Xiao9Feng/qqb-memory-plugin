# 记忆系统（跨天持久记忆）

> 给 QQ 里的 AI 加三层记忆：**短期话题**（这三天聊过什么）、**长期卡片**（某人是什么人、什么重要的事）、**人设叠加层**（聊出来的自我认知）。
> 桥接原有的 `qq_memory_append` 是**会话内**速记（`activeTopics` / `memberImpressions`，重置就没）；这一套是**跨天、跨重启**的沉淀层。两者互补，不冲突。

---

## 一、三层各管什么

| 层 | 存什么 | 生命周期 | 谁写 |
|---|---|---|---|
| **短期** | 每个群/私聊这几天聊过的话题，一句一条 | 滚动 **3 天**，超过就裁掉 | 后台整理（自动） |
| **长期** | 人物卡（印象/性格/重要事实/忌讳）、会话话题卡、事件 | **永久**，30 天没人提就降权，降到 0 归档（不删） | 后台整理（自动）+ 命令行手工 |
| **人设叠加层** | 分节活文档：我是谁 / 性格 / 说话方式 / 喜好 / 厌恶 / 关系 / 禁忌 | 永久，**每次改动都留快照** | 后台整理小步修改 + 命令行手工 |

**关键区别**：人格卡（`roles/*.md`）是主人定的底座，AI **不许动**；人设叠加层是聊出来的变化，AI 可以小步改，但只能改那七个小节、单次最多 5 条、「禁忌」只能加不能删。

---

## 二、记忆怎么流动

```
QQ 消息
   │
   ├─→ 桥接原有：activeTopics / memberImpressions（会话内，AI 自己调 qq_memory_*）
   │
   └─→ recentMessages（最近消息窗口，本来就有的）
             │
             │  每 10 分钟扫一次：某会话攒满 N 条新消息 → 触发整理
             ▼
      独立 DSH 会话「QQ 记忆整理」（preset 同 QQ 聊天，工具面受限）
             │  把「新消息 + 已记住的 + 当前人设」一起喂进去，要求只返回 JSON
             ▼
      ┌────────────┬────────────┬─────────────┐
      │  短期话题   │  长期卡片   │  人设补丁   │
      └────────────┴────────────┴─────────────┘
             │
             ▼
      下一轮对话注入（withContextBlocks）
```

注入顺序（每条 prompt 前）：

```
【当前时间】
【群聊黑话表】          ← 原有
【关于你自己】          ← 人设叠加层（预算最优先）
【最近几天聊过什么】     ← 短期
【你对这些人的了解】     ← 长期人物卡
<真正的消息>
```

超预算（默认 1200 字）时，从最后一块整块儿丢——**绝不切半句**，切半句比没有更糟。

---

## 三、怎么开、怎么关

`config.json` 加 `memory` 段（`config.example.json` 里已经是完整模板，直接抄）：

```json
"memory": {
  "enabled": true,
  "digestMinMessages": 20,
  "digestCooldownMs": 1800000,
  "scanIntervalMs": 600000,
  "digestTimeoutMs": 180000,
  "idleDays": 30,
  "learnerPreset": "qq-chat",
  "workspaceTitle": "QQ 记忆整理",
  "persona": { "enabled": true },
  "context": {
    "enabled": true,
    "maxChars": 1200,
    "shortDays": 3,
    "shortPerDay": 3,
    "longPeople": 5,
    "longMaxChars": 600,
    "includePersona": true
  }
}
```

| 键 | 意思 | 建议 |
|---|---|---|
| `enabled` | 总开关。`false` 就完全不读不写不注入 | — |
| `digestMinMessages` | 某会话攒够多少条新消息才整理 | 20 条差不多；太小会反复烧 token |
| `digestCooldownMs` | 同一会话两次整理的最小间隔 | 默认 30 分钟 |
| `scanIntervalMs` | 后台多久扫一遍所有会话 | 10 分钟 |
| `digestTimeoutMs` | 等整理会话回话的超时 | 3 分钟；模型慢就调大 |
| `idleDays` | 多少天没被提到开始降权 | 30 天 |
| `learnerPreset` | 整理用哪个 agent preset | 必须和聊天用同一个安全 preset |
| `persona.enabled` | 允不允许 AI 自己改人设 | 想稳就 `false`，只留手工 |
| `context.maxChars` | 注入总预算 | 1200 字；嫌费 token 就压到 800 |
| `context.shortDays` | 注入时最多提几天 | 3 |
| `context.longPeople` | 注入时最多带几个人物卡 | 5 |

**关掉**：`"enabled": false` 然后重启桥接。已有记忆文件不会被删，再打开就接着用。

---

## 四、数据在哪

```
state/memory/
├── short.json          短期话题（按日期分桶）
├── long.json           长期卡片（人物 / 会话话题 / 事件 / 归档区）
├── persona.md          ← 人设叠加层，人肉直接改这个就行
├── persona.history/    人设历史快照（保留最近 30 份）
└── digest-agent/       整理会话的工作目录（DSH 那边建的）
```

全部是普通 JSON / markdown：能看、能手改、能备份、能进 git 看 diff。**没有数据库、没有二进制**。

---

## 五、看和改：`memory-cli.mjs`

```bash
node scripts/memory-cli.mjs show              # 总览
node scripts/memory-cli.mjs people            # 人物列表（带印象和事实）
node scripts/memory-cli.mjs person 阿蓝        # 某个人详情
node scripts/memory-cli.mjs short             # 最近三天的短期话题
node scripts/memory-cli.mjs persona           # 人设叠加层
node scripts/memory-cli.mjs events            # 事件流
```

写入类（**先停桥接再跑**，否则桥接下次保存会把你的改动覆盖掉）：

```bash
node scripts/memory-cli.mjs remember 阿蓝 在准备考研
node scripts/memory-cli.mjs taboo 阿蓝 别问她体重
node scripts/memory-cli.mjs persona-add 喜好 喜欢被人叫老姐
node scripts/memory-cli.mjs persona-remove 厌恶 讨厌被叫主人
node scripts/memory-cli.mjs add-event 今天他生日
```

---

## 六、让 AI 自己查记忆（MCP 工具）

`src/memory/mcp-server.mjs` 提供三个**只读**工具：

| 工具 | 什么时候用 |
|---|---|
| `memory_recall` | 不确定对方提过的事、想确认喜好/忌讳、要接之前的话题 |
| `persona_read` | 想知道自己最近是什么样 |
| `memory_stats` | 排查「它怎么不记得」——先看这里有多少数据 |

装进 DSH（会改 `~/.dsh/profiles/<profile>/cordis.patch.yml`，幂等）：

```bash
node scripts/setup-dsh.mjs
```

然后重启 DSH。**为什么只读**：写入方是桥接进程（它把文件整份读进内存、改完整份写回），MCP server 也去写就会互相覆盖，而且谁都不报错——那种「记忆莫名其妙丢了」的 bug 最难查。所以：**写归桥接和 CLI，读归 MCP**。

---

## 七、设计取舍（踩过的坑，别改回去）

1. **日期用本地时区**，不用 `toISOString()`。否则早上 8 点前的消息会被记到前一天。
2. **读失败 ≠ 空库**。`short.json` 读不出来时整层停止写入并报错；要是当成空库继续，下一次保存就把磁盘上那份记忆覆盖成 `{}` 了。
3. **JSON 坏了隔离不覆盖**：另存 `.corrupt-<时间戳>` 再抛错。
4. **人设只能小步改**。小节白名单 + 单次 5 条 + 「禁忌」只加不删 + 每次留快照。不这么做的话，聊两万句之后人设就漂成另一个人了。
5. **提炼只认「长期有用」的信息**。闲聊流水不记；密码/身份证/住址/手机号明确禁止。记错一条比漏记十条更糟。
6. **游标存消息时间，不存整理时间**。整理本身要几十秒，这期间新到的消息不能被当成已消化。
7. **注入失败不能挡住发消息**。记忆坏了最多「这次没记忆」，报个错就够。

---

## 八、排错

| 症状 | 查什么 |
|---|---|
| AI 完全不提以前的事 | `node scripts/memory-cli.mjs show` 看有没有数据；`memory.enabled` 是不是 `false` |
| 有数据但不注入 | 看 `state/bridge.log` 里有没有「记忆注入失败」；`context.enabled` / `maxChars` 是不是太小 |
| 一直不整理 | 日志里搜「记忆整理」；攒够 `digestMinMessages` 了吗；DSH 是不是在线（`dshReady`） |
| 整理报 JSON 解析失败 | 日志里有原文片段；多半是 `learnerPreset` 的模型太弱，换个强一点的 |
| 人设越改越怪 | `state/memory/persona.history/` 里回滚上一版；或把 `persona.enabled` 关掉，只留手工 |
| 怀疑被覆盖 | 看有没有 `.corrupt-*` 文件；确认没在桥接运行时跑 CLI 写入 |

测试：

```bash
node scripts/test-memory-store.mjs    # 持久层 + 注入预算
node scripts/test-memory-digest.mjs   # prompt 构建 + 脏 JSON 容错
node scripts/test-memory-mcp.mjs      # MCP 工具面真的能拉起来
```

合计 110 项断言，全离线，不碰 DSH、不发 QQ 消息、不花钱。
