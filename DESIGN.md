# OpenClaw Watchdog - 本地运维守护进程

## 项目目标

为 OpenClaw 提供一个永远在线、独立运行的本地守护进程。
自动监控、故障诊断、主动告警和自愈。

---

## 实现状态

| 功能 | 状态 | 说明 |
|------|------|------|
| Gateway 健康检查 | ✅ | HTTPS 探测，每 60s 一次 |
| 自动重启 | ✅ | 检测失败后 kill + 重启，防多实例冲突 |
| Telegram 通知 | ✅ | 宕机/恢复/重启失败，IPv4 强制，绕过 gateway |
| 通知含诊断原因 | ✅ | 检测到日志模式时通知包含原因 |
| 心跳汇报 | ✅ | 可配置间隔定期发状态摘要 |
| 日志监控 | ✅ | tail gateway.err.log，实时检测 |
| 知识库诊断 | ✅ | 20 个已知错误模式，5 分钟内去重 |
| Web 看板 | ✅ | SSE 实时，延迟折线图，事件过滤，倒计时 |
| 延迟历史持久化 | ✅ | latency.json，重启后不丢失 |
| LaunchAgent 安装 | ✅ | 开机自启，KeepAlive |
| CLI chat 命令 | ✅ | 交互式 REPL：status/logs/check/restart/diagnoses |
| CLI diagnose 命令 | ✅ | 扫描 gateway 日志，报告已知错误模式及次数 |
| logs --follow | ✅ | SSE 实时跟踪事件流 |
| setup 向导 | ✅ | Chat ID / 账号选择 / 检查间隔 / 心跳 / Discord+Slack / 测试通知 |
| npm 发布准备 | ✅ | package.json / .npmignore / files 字段 |
| Channel 健康检查 | ✅ | 每 5 分钟检测所有 Bot 连通性，看板展示 |
| Playbooks | ✅ | restart/kill-port/doctor，冷却期去重 |
| Discord 通知 | ✅ | Webhook POST，与 Telegram 并行发送 |
| Slack 通知 | ✅ | Webhook POST，与 Telegram 并行发送 |

---

## 架构

```
openclaw-keeper/
├── bin/cli.mjs              # CLI 入口 (start/stop/status/logs/chat/setup/install...)
├── src/
│   ├── config.mjs           # 读取 ~/.openclaw/openclaw.json + ~/.openclaw-keeper/config.json
│   ├── store.mjs            # 事件日志 (events.json) + 延迟历史 (latency.json)
│   ├── monitor.mjs          # HTTPS 健康检查 + 重启逻辑
│   ├── daemon.mjs           # 主循环：健康检查 + 心跳 + 日志监控 + SSE 推送
│   ├── log-watcher.mjs      # tail 日志文件，fs.watch + 位置跟踪
│   ├── diagnose.mjs         # 正则匹配知识库模式
│   ├── notify.mjs           # Telegram 直发（down/recovered/restart-failed/heartbeat）
│   ├── channels.mjs         # Telegram Bot getMe 连通性检测
│   ├── playbooks.mjs        # 知识库联动自动修复（restart/kill-port/doctor）
│   ├── web.mjs              # HTTP 看板 + SSE /api/stream + REST API
│   └── install.mjs          # LaunchAgent plist 生成 / 加载 / 卸载
├── ui/index.html            # 自包含 Web 看板（无外部依赖）
├── knowledge/patterns.json  # 已知错误模式知识库
└── package.json
```

---

## 数据目录 (~/.openclaw-keeper/)

| 文件 | 内容 |
|------|------|
| config.json | watchdog 配置（gatewayUrl / chatId / accountId / heartbeatInterval 等）|
| events.json | 事件日志，最多 500 条，持久化 |
| latency.json | 延迟历史，最多 200 点，持久化 |
| daemon.pid | 当前 daemon PID |
| daemon.log | daemon stdout 日志 |
| launchd-stdout.log | LaunchAgent stdout |
| launchd-stderr.log | LaunchAgent stderr |

---

## Web API

| 路由 | 说明 |
|------|------|
| GET / | 看板 HTML |
| GET /api/status | 实时状态 + stats |
| GET /api/events | 事件列表（最多 100）|
| GET /api/latency | 延迟历史（最多 60 点）|
| GET /api/diagnoses | 最近检测到的日志问题（最多 10）|
| GET /api/channels | Telegram Bot 连通性状态 |
| GET /api/stream | SSE 实时推送 |
| POST /api/check | 触发立即检查 |
| POST /api/restart | 触发立即重启 |

---

## 知识库模式 (knowledge/patterns.json)

| id | 错误 | 严重度 | 可自动修复 |
|----|------|--------|----------|
| tls-set-session | undici TLS session crash | error | ✅ |
| mutex-lock | 多实例 mutex 冲突 | error | ✅ |
| deletewebhook-loop | Telegram IPv6 死循环 | warn | ❌ |
| port-in-use | 端口 18789 占用 | error | ✅ |
| invalid-config-key | 配置无效字段 (含 fallback key) | error | ❌ |
| context-window | contextWindow 过小，agent 被阻塞 | warn | ❌ |
| token-invalid | Bot Token 失效 (401/404) | error | ❌ |
| sigterm-timeout | 关闭超时 | warn | ❌ |
| out-of-memory | OOM | error | ✅ |
| econnreset | 连接重置 | warn | ❌ |
| telegram-rate-limit | Telegram 429 频率限制 | warn | ❌ |
| oauth-token-refresh | OAuth 凭证过期，需重新授权 | error | ❌ |
| all-models-failed | 所有模型提供商均失败 | error | ❌ |
| model-timeout | LLM 请求超时 | warn | ❌ |
| telegram-502 | Telegram 服务器 502 | warn | ❌ |
| telegram-network-fail | Telegram API 网络请求失败 | warn | ❌ |
| model-403 | 模型 API 403 Forbidden | error | ❌ |
| embedded-agent-failed | 内嵌 Agent 回复前崩溃 | error | ❌ |
| reasoning-effort-invalid | reasoning_effort 参数值无效 | warn | ❌ |
| fetch-failed | HTTP fetch 失败 (非致命) | warn | ❌ |

---


---

## 安装流程（用户视角）

```bash
npm install -g openclaw-keeper
openclaw-keeper setup      # 配置 Telegram Chat ID、账号、心跳间隔
openclaw-keeper install    # 注册 LaunchAgent，开机自启
openclaw-keeper status     # 查看状态
openclaw-keeper chat       # 终端交互
# 浏览器访问 http://localhost:19877
```
