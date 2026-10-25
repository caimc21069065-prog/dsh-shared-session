# dsh-shared-session

ZCode 插件:把当前会话一键共享给团队 —— 主机跑模型和工具,客人实时旁观并发送 prompt,由主机代为执行。多人结对编程 / 远程 review,客人零 token 消耗。

参考 [Paradigm-Study/claude-share](https://github.com/Paradigm-Study/claude-share)(Claude Code 的 shared-session)实现,需求规格见 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)。

- 插件源码与文档:[plugins/dsh-shared-session/README.md](plugins/dsh-shared-session/README.md)
- 自建 relay 协议:[plugins/dsh-shared-session/docs/relay-protocol.md](plugins/dsh-shared-session/docs/relay-protocol.md)

## 一图看懂

```
Host ZCode ──(hooks 采集 + 审批门)──► relay ◄──(SSE 实时流 + prompt 注入)── Guest ZCode / 浏览器
```

## 核心体验

| 角色 | 命令 | 说明 |
|------|------|------|
| Host | `/share` | 生成邀请链接;`/share history` 连历史一起分享;`/stop-share` 结束 |
| Guest | `/join <link>` | 回放 + 实时观看;`/ask <message>` 把 prompt 交给主机执行 |
| 双方 | `/room` | 成员、时间线、审批请求 |

客人触发的写文件 / shell / 网络请求默认需要主机审批(超时视为拒绝);会话日志 append-only,客人输入以 `[GuestName]: text` 追加,不改写历史。

## 快速自建 relay

```bash
node plugins/dsh-shared-session/relay/server.mjs --port 8787
```

⚠️ 公共/第三方中继**非端到端加密**,中继方可以读取房间内容;生产环境请自建并将 `relayUrl` 指向自己的实例。
