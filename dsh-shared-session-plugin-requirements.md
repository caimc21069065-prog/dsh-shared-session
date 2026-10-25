# dsh-shared-session 插件需求规格书

**版本**: 0.1.0-draft  
**日期**: 2026-10-25  
**状态**: 需求草案（可直接作为实现起点）  
**参考实现**: [Paradigm-Study/claude-share](https://github.com/Paradigm-Study/claude-share)（Claude Code 的 shared-session mod）  
**目标平台**: DeepSeek Harness (dsh) ≥ 0.2.x（web / desktop profile）

---

## 1. 背景与目标

### 1.1 问题

多人协作时，常见需求是：

- 结对编程 / 远程 review：两人同时盯着同一个 agent 会话
- 一人跑 agent，其他人旁观并偶尔插话
- 所有工具执行、文件修改只发生在**主机**机器上，客人不上自己的模型、不烧自己的额度

Claude Code 生态已有成熟方案（shared-session），dsh 目前缺少同等体验。

### 1.2 目标

做一个 dsh 插件，实现：

1. **主机**一键分享当前会话，生成可复制的链接 / 邀请码
2. **客人**用链接加入，实时看到主机侧的对话、思考流、工具调用与结果
3. **客人**可输入 prompt，这些输入在主机侧以「[GuestName]: text」形式注入，由**主机的模型**执行
4. 工具执行、文件读写、网络请求全部发生在主机；主机保留审批权
5. 可选：侧聊（agent 读不到）、文件/预览分享、房间持久化、自建 relay

### 1.3 非目标（v1）

- 不做端到端加密（可后续加）
- 不做完整「多主机并发写同一工作区」的冲突解决
- 不把客人本地的 agent 跑起来（客人零推理成本）
- 不替代 dsh 官方 subagent / team 编排

---

## 2. 参考：Claude shared-session 核心行为

来源：[claude-mods.com/shared-session](https://claude-mods.com/shared-session/) + 仓库 `Paradigm-Study/claude-share`

| 能力 | 行为摘要 |
|------|----------|
| 分享 | `/share-session` 或 Share 按钮 → 复制链接 |
| 加入 | 客人新开会话粘贴链接 → 回放历史，之后实时同步 |
| 客人输入 | 到达主机为 `Name: text`，排队等当前 turn 结束后执行 |
| 模型 | 只在主机跑；客人零 token |
| 工具 | 主机执行；对客人发起的危险操作额外询问主机 |
| 实时 | 回复与 thinking 流式转发；tool 结果可截断展示 |
| 房间 | `/room`：在线成员、时间线、侧聊、主机控制 |
| 团队 | GitHub/Google 登录、邀请、域名/组织限制 |
| 文件 | 主机展示的文件可上传到房间，客人本地落盘到 `.shared-session/` |
| 预览 | localhost 预览可转发给客人（限时 / TCP 转发可选） |
| 持久 | 主机退出后房间保留约 24h；重开可恢复 |
| 中继 | 默认公共 Cloudflare Worker；可自建 |

安装命令（Claude 侧，仅供对照）：

```bash
claude plugin marketplace add Paradigm-Study/claude-share
claude plugin install shared-session@claude-share
```

**GitHub 仓库地址（权威）**: https://github.com/Paradigm-Study/claude-share

---

## 3. dsh 侧设计原则

1. **严格遵守 dsh 的 append-only session log**  
   不改写历史事件；客人输入作为新的 `user/message`（带 plugin source 标记）写入主机会话。

2. **主机权威**  
   所有工具执行、权限门、工作区变更只在主机进程发生。

3. **可替换中继**  
   默认可用公共 relay；支持配置自建 WebSocket/HTTP 中继，便于内网与合规。

4. **与现有插件共存**  
   不依赖私有 API；只使用公开事件（`tool/call`、`tool/result`、`turn/*`、`assistant/*`、`user/message`）与 `ctx.tools` / 命令注册能力。

5. **安全默认**  
   默认对客人发起的写操作、shell、网络请求向主机弹审批；只读工具可放行。

---

## 4. 角色与术语

| 术语 | 含义 |
|------|------|
| **Host** | 发起分享的 dsh 实例；拥有真实工作区与模型额度 |
| **Guest** | 通过链接加入的其他 dsh 实例；只观看 + 发 prompt |
| **Room** | 一次分享会话的逻辑房间（含成员、事件流、文件、控制状态） |
| **Relay** | 房间状态与实时事件的中转服务（公共或自建） |
| **Side chat** | 房间内人类侧聊，不进入 agent 上下文 |
| **Replay tool** | 客人侧用于展示主机 tool 结果的只读伪工具 |

---

## 5. 功能需求（FR）

### FR-1 分享与加入

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-1.1 | Host 提供命令 `/share`（或 `/ss share`），生成房间并复制邀请链接/码 | P0 |
| FR-1.2 | 可选：分享「当前起」或「含历史全部」 | P0 |
| FR-1.3 | Guest 提供 `/join <link-or-code>`，加入房间并回放已有可见历史 | P0 |
| FR-1.4 | 加入不消耗 Guest 侧模型调用 | P0 |
| FR-1.5 | Host 提供 `/stop-share` 结束房间；Guest `/leave` 退出 | P0 |
| FR-1.6 | 链接默认带房间 ID + 短期 token；可配置过期时间（默认 24h） | P1 |

### FR-2 实时同步（Host → Guest）

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-2.1 | Host 侧 `user/message`、`assistant` 文本与 reasoning 流式推送到房间 | P0 |
| FR-2.2 | `tool/call` 与 `tool/result` 推送；Guest 侧以卡片形式展示 | P0 |
| FR-2.3 | tool 结果可配置截断（例如前 N 行 / 最大字节），避免刷屏 | P1 |
| FR-2.4 | 子 agent 外层调用可见；内层逐步细节可配置是否镜像 | P2 |
| FR-2.5 | 连接断开后重连应补齐 gap（基于事件 seq） | P1 |

### FR-3 Guest 输入注入（Guest → Host）

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-3.1 | Guest 输入的文本到达 Host 后，作为新的 user 消息写入 Host session，前缀为 `[GuestDisplayName]: ` | P0 |
| FR-3.2 | 若 Host 当前 turn 进行中，排队，turn 结束后再注入 | P0 |
| FR-3.3 | Guest 附件（图片/文件，限大小）可上传到房间并在 Host 侧进入上下文（可选审批） | P1 |
| FR-3.4 | Guest 的本地 system/context 注入不得转发到 Host | P0 |
| FR-3.5 | Host 可拒绝某条 Guest 输入（不进入模型） | P1 |

### FR-4 权限与安全

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-4.1 | 复用 Host 原有 `tools/pre-execute` 权限策略 | P0 |
| FR-4.2 | 对「由 Guest 触发的 turn」额外策略：写文件 / shell / 网络默认需 Host 显式允许（一次 / 始终允许该 Guest / 拒绝） | P0 |
| FR-4.3 | 只读工具（读文件、搜索等）可默认放行 | P1 |
| FR-4.4 | Room 设置可切换：Ask everything / 默认策略 / 仅观看 | P1 |
| FR-4.5 | 审批超时（如 10 分钟）视为拒绝 | P1 |
| FR-4.6 | 文档明确：公共 relay **非端到端加密**，内容可被中继方读取 | P0 |

### FR-5 房间 UI / 命令

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-5.1 | `/room` 打开房间面板：成员列表、在线状态、活动时间线 | P0 |
| FR-5.2 | 侧聊（side chat）：成员互发，不进入 agent 上下文 | P1 |
| FR-5.3 | Host 可踢人、设为仅观看、改审批策略 | P1 |
| FR-5.4 | Web UI：侧栏或 overlay 展示房间状态与「正在分享」指示 | P0 |
| FR-5.5 | 显示名默认取 `git config user.name` 或系统用户名，可覆盖 | P1 |

### FR-6 文件与预览分享

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-6.1 | Host 通过 agent 展示的文件可同步到房间；Guest 落盘到工作区下隔离目录（如 `.dsh-shared/<roomId>/`）并加入 git exclude | P1 |
| FR-6.2 | `/share-file <path>` 主动分享文件 | P2 |
| FR-6.3 | Host 的 localhost 预览可生成限时 Guest 可访问的代理链接（可选） | P2 |
| FR-6.4 | 单文件大小上限可配置（建议默认 8MB） | P1 |

### FR-7 持久化与恢复

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-7.1 | Host 本地保存 room token（仅当前用户可读），进程重启后可 `/share resume` | P1 |
| FR-7.2 | Relay 侧房间在 Host 失联后保留可配置时长（默认 24h） | P1 |
| FR-7.3 | Host 离线期间 Guest 输入可排队或拒绝（可配置；默认拒绝并提示） | P1 |

### FR-8 中继与部署

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-8.1 | 支持配置 `relayUrl`（默认公共或空=仅局域网发现可选） | P0 |
| FR-8.2 | 提供最小自建 relay 规范（WebSocket + 房间状态 REST） | P0 |
| FR-8.3 | 可选：仅局域网 mDNS / 二维码直连（无公网） | P2 |
| FR-8.4 | 可选：团队账号、GitHub org 限制（可二期） | P2 |

---

## 6. 非功能需求（NFR）

| ID | 需求 |
|----|------|
| NFR-1 | Guest 加入与观看不消耗 Guest 的 LLM token |
| NFR-2 | 实时延迟：同区域公网下文本流端到端 p95 < 500ms（尽力） |
| NFR-3 | 插件卸载后自动清理监听与本地 room 元数据（不删 Host session log） |
| NFR-4 | 兼容 dsh web 与 desktop profile；headless 可仅作 Host 推送、无完整 Guest UI |
| NFR-5 | 不修改用户 `.git`；共享文件目录必须进入 exclude |
| NFR-6 | 依赖尽量少；中继协议版本化，前后兼容至少一个次版本 |

---

## 7. 架构建议

### 7.1 组件划分

```
┌─────────────────────────────┐         ┌─────────────────────────────┐
│  Host dsh process           │         │  Guest dsh process          │
│  ┌───────────────────────┐  │         │  ┌───────────────────────┐  │
│  │ shared-session plugin │  │         │  │ shared-session plugin │  │
│  │ - event tap           │  │         │  │ - room client         │  │
│  │ - inject guest msgs   │◄─┼──WS/HTTP┤  │ - render stream       │  │
│  │ - approval UI         │  │  Relay  │  │ - send prompts        │  │
│  │ - file export         │  │         │  │ - replay tool         │  │
│  └───────────────────────┘  │         │  └───────────────────────┘  │
│  Session log (append-only)  │         │  Local view-only surface    │
│  Real tools / workspace     │         │  No real tool execution     │
└─────────────────────────────┘         └─────────────────────────────┘
```

### 7.2 Host 侧挂接（dsh 事件）

建议监听（名称以实际 dsh 版本为准，实现前用 handbook 核对）：

- `turn/start`, `turn/end`
- `user/message`
- `assistant/message` / streaming 等价事件
- `tool/call`, `tool/result`
- `tools/pre-execute`（叠加 Guest-turn 审批）

注入客人消息时：

- 写入一条 durable `user/message`，`source: { kind: 'plugin', plugin: 'shared-session', guestId, displayName }`
- 保证与正常用户消息一样进入下一 turn 的模型上下文

### 7.3 房间事件协议（草案）

最小事件类型：

```ts
type RoomEvent =
  | { type: 'room/meta'; roomId: string; hostName: string; createdAt: string }
  | { type: 'member/join'; memberId: string; displayName: string; role: 'host' | 'guest' | 'viewer' }
  | { type: 'member/leave'; memberId: string }
  | { type: 'chat/user'; seq: number; from: string; text: string; at: string } // 进入 agent 的
  | { type: 'chat/side'; from: string; text: string; at: string }           // 不进入 agent
  | { type: 'assistant/delta'; seq: number; text?: string; reasoning?: string }
  | { type: 'assistant/done'; seq: number }
  | { type: 'tool/call'; seq: number; name: string; argsPreview: string; callId: string }
  | { type: 'tool/result'; seq: number; callId: string; ok: boolean; preview: string }
  | { type: 'file/share'; fileId: string; name: string; size: number; url: string }
  | { type: 'control/approval'; requestId: string; summary: string }
  | { type: 'control/approval-result'; requestId: string; decision: 'allow-once' | 'allow-always' | 'deny' }
```

每条带单调 `seq`，Guest 用 `lastSeq` 做增量拉取/重连。

### 7.4 命令草案

| 命令 | 谁用 | 作用 |
|------|------|------|
| `/share` | Host | 创建房间并复制链接 |
| `/share history` | Host | 含历史分享 |
| `/share resume` | Host | 恢复上次房间 |
| `/stop-share` | Host | 结束房间 |
| `/join <code>` | Guest | 加入 |
| `/leave` | Guest | 离开 |
| `/room` | 双方 | 打开房间面板 |
| `/ss kick <name>` | Host | 踢人 |
| `/ss mode watch` | Host | 某人仅观看 |

（最终前缀可用 `shared-session` 或短前缀 `ss`，与现有命令冲突时再调整。）

---

## 8. 配置项（插件 config）

```yaml
# 示例 cordis / 插件配置
shared-session:
  relayUrl: "https://your-relay.example.com"   # 空则仅提示配置
  defaultShareHistory: false
  guestWriteApproval: "ask"   # ask | allow-readonly | allow-all（不推荐）
  toolResultMaxLines: 40
  roomTtlHours: 24
  maxFileBytes: 8388608
  displayName: null           # null = 自动
  sideChatEnabled: true
  allowLocalhostPreview: false
```

---

## 9. MVP 范围（建议第一期只做这些）

**必须有：**

1. Host `/share` → 链接  
2. Guest `/join` → 回放 + 实时看对话与 tool 卡片  
3. Guest 发 prompt → Host 注入并执行  
4. Host 对 Guest 触发的写/shell 审批  
5. `/room` 成员列表 + `/stop-share` / `/leave`  
6. 可配置 `relayUrl` + 一份最小自建 relay（可用 Cloudflare Worker 或 Node）

**可第二期：**

- 侧聊、文件同步、localhost 预览、团队登录、E2E 加密、局域网无中继模式

---

## 10. 验收用例（摘要）

1. **双人结对**  
   Host 分享 → Guest 加入 → Guest 发「把这个函数加上单元测试」→ Host 审批写文件 → 双方看到同一结果。

2. **仅观看**  
   Host 把 Guest 设为 viewer → Guest 无法注入 prompt，仍能看流。

3. **断线重连**  
   Guest 断网 30s 后重连，能补齐期间 Host 产生的事件。

4. **权限**  
   Guest 触发 `rm` 类命令 → Host 收到审批卡片 → 拒绝后 Guest 看到拒绝原因，工作区无变更。

5. **成本**  
   Guest 全程无 LLM 计费；Host 用量增加与本地多一人打字相当。

6. **卸载**  
   禁用插件后，无残留 WS 连接；session log 仍完整可审计。

---

## 11. 安全与合规清单

- [ ] README 显著说明公共中继可读内容，生产建议自建  
- [ ] Room token 本地文件权限 0600  
- [ ] 共享文件目录 git exclude  
- [ ] 不转发 Guest 本地密钥、`.env`、系统 prompt 私货  
- [ ] 审批 UI 必须展示完整命令/路径预览  
- [ ] 速率限制：单 Guest 注入频率、房间人数上限（建议默认 ≤ 10）  
- [ ] 日志中避免打印完整 token

---

## 12. 与现有 dsh 能力的关系

| 已有能力 | 关系 |
|----------|------|
| append-only session log | 客人输入作为新事件追加，不改历史 |
| tools/pre-execute 权限门 | 叠加 Guest-turn 策略 |
| Web UI slots / overlay | 房间面板、分享状态指示 |
| subagent / team 编排 | 正交；shared-session 是「多人共用一个主机会话」 |
| 现有 browser / terminal 插件 | 预览分享可后续对接，非 MVP 依赖 |

---

## 13. 实现任务拆分（建议）

| 阶段 | 任务 | 预估 |
|------|------|------|
| A | 房间协议 + 最小 relay（创建/加入/事件广播） | 3–5d |
| B | Host 事件采集与推送 | 2–3d |
| C | Guest 渲染与 `/join` | 2–3d |
| D | Guest → Host 消息注入与排队 | 2d |
| E | Guest-turn 审批门 | 2d |
| F | `/room` 面板 + Web UI 指示 | 2–3d |
| G | 文档、安装包、安全说明、E2E 用例 | 2d |

合计约 **2–3 人周** 可出可用 MVP（不含团队登录与预览转发）。

---

## 14. 参考链接

- Claude shared-session 说明: https://claude-mods.com/shared-session/  
- **GitHub 仓库**: https://github.com/Paradigm-Study/claude-share  
- 安装（Claude）:  
  `claude plugin marketplace add Paradigm-Study/claude-share`  
  `claude plugin install shared-session@claude-share`  
- dsh 插件扩展指南: 官方 extension cookbook / plugin handbook（以当前 dsh 版本文档为准）

---

## 15. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1.0-draft | 2026-10-25 | 初稿：对照 Claude shared-session，给出 dsh MVP 与完整需求 |

---

*本文档可直接作为插件仓库的 `docs/REQUIREMENTS.md` 使用。实现前请用目标 dsh 版本的事件名与 slot API 再核对一次。*
