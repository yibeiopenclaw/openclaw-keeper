# OpenClaw Watchdog 🐕

An always-on local daemon that monitors your [OpenClaw](https://openclaw.ai) gateway, auto-restarts it on failure, and sends you Telegram/Discord/Slack notifications — even when OpenClaw itself is down.

> Built for OpenClaw users who need their gateway running 24/7 without babysitting it.

---

## Features

- **Gateway health check** — HTTPS probe every 60s (configurable)
- **Auto-restart** — detects failure, kills stale processes, restarts cleanly
- **Telegram notifications** — down / recovered / restart-failed alerts sent *directly* via Bot API (bypasses the gateway, works even during outages)
- **Notification retry queue** — if Telegram is unreachable (DNS outage etc.), alerts are queued and delivered when connectivity recovers
- **Heartbeat reports** — periodic status summaries with uptime %, latency, fail count
- **Log monitoring** — tails `gateway.err.log` in real time, detects known error patterns
- **20-pattern knowledge base** — identifies OAuth expiry, TLS crashes, port conflicts, OOM, model failures, and more
- **Playbooks** — auto-remediation actions (restart, kill-port, doctor) triggered by log patterns, with cooldown dedup
- **Web dashboard** — real-time SSE updates, latency chart, event log, channel health, update banner
- **OpenClaw update checker** — daily check, Telegram notification + Web UI banner when a new version is available
- **Discord & Slack webhooks** — parallel notifications alongside Telegram
- **LaunchAgent install** — macOS auto-start on login, KeepAlive, log rotation
- **Interactive CLI** — `chat` REPL for live status/restart/diagnose, `diagnose` command for log scanning

---

## Install

```bash
npm install -g openclaw-watchdog
```

---

## Setup

```bash
openclaw-watchdog setup
```

Interactive wizard that configures:
- Your OpenClaw gateway URL
- Telegram Chat ID and bot account
- Check interval (default: 60s)
- Heartbeat interval (default: disabled)
- Discord / Slack webhook URLs (optional)
- Sends a test notification to confirm everything works

---

## Start

```bash
# Run in foreground (useful for testing)
openclaw-watchdog start

# Install as macOS LaunchAgent (auto-start on login)
openclaw-watchdog install
```

Then open the dashboard: **http://localhost:19877**

---

## CLI Commands

```bash
openclaw-watchdog status          # Show current state
openclaw-watchdog start           # Start daemon in foreground
openclaw-watchdog stop            # Stop daemon
openclaw-watchdog install         # Register LaunchAgent (macOS)
openclaw-watchdog uninstall       # Remove LaunchAgent
openclaw-watchdog setup           # Run setup wizard
openclaw-watchdog chat            # Interactive REPL (status/check/restart/diagnoses)
openclaw-watchdog diagnose        # Scan gateway logs for known error patterns
openclaw-watchdog logs            # Show recent events
openclaw-watchdog logs --follow   # Stream events live (SSE)
openclaw-watchdog web             # Open dashboard in browser
```

---

## Web Dashboard

Real-time dashboard at `http://localhost:19877` (port configurable):

- **Status card** — gateway OK/down, last check time, latency
- **Latency chart** — 60-point rolling history
- **Channel health** — Telegram bot connectivity for each account
- **Event log** — filterable by type (down / recovered / restart / heartbeat / log-issue / update)
- **Update banner** — shows when a new OpenClaw version is available, with one-click update button

---

## Notifications

All notification types sent via Telegram (HTML), Discord (Markdown), and Slack:

| Event | Description |
|-------|-------------|
| `gateway_down` | Gateway health check failed, restart initiated |
| `gateway_recovered` | Gateway back online after restart |
| `restart_failed` | Auto-restart could not bring gateway back up |
| `heartbeat` | Periodic status summary (uptime %, latency, fail count) |
| `log_issue` | Known error pattern detected in gateway logs |
| `playbook` | Auto-remediation action executed (success or failure) |
| `update_available` | New OpenClaw version available |

Telegram notifications bypass the OpenClaw gateway entirely using direct IPv4-forced Bot API calls, so they work even during complete gateway outages.

---

## Knowledge Base

`knowledge/patterns.json` — 20 known error patterns matched against gateway logs:

| Error | Severity | Auto-fix |
|-------|----------|----------|
| TLS session crash (undici) | error | ✅ restart |
| Multi-instance mutex conflict | error | ✅ restart |
| Telegram IPv6 deleteWebhook loop | warn | — |
| Port 18789 already in use | error | ✅ kill-port |
| Invalid config key | error | — |
| Context window too small | warn | — |
| Bot token invalid (401/404) | error | — |
| OAuth token expired | error | — |
| All model providers failed | error | — |
| Out of memory | error | ✅ restart |
| ECONNRESET | warn | — |
| Telegram 429 rate limit | warn | — |
| Model request timeout | warn | — |
| Model API 403 Forbidden | error | — |
| ... and more | | |

Notifications for `error` patterns are sent immediately; `warn` patterns have a 1-hour cooldown.

---

## Architecture

```
openclaw-watchdog/
├── bin/cli.mjs         # CLI entry (start/stop/setup/install/chat/diagnose...)
├── src/
│   ├── config.mjs      # Reads ~/.openclaw/openclaw.json + ~/.openclaw-watchdog/config.json
│   ├── daemon.mjs      # Main loop: health check + heartbeat + log watcher + SSE push
│   ├── monitor.mjs     # HTTPS health check + restart logic
│   ├── store.mjs       # Event log (events.json) + latency history (latency.json)
│   ├── log-watcher.mjs # Tails gateway.err.log with fs.watch + position tracking
│   ├── diagnose.mjs    # Regex pattern matching against knowledge base
│   ├── notify.mjs      # Direct Telegram/Discord/Slack notifications
│   ├── channels.mjs    # Telegram bot connectivity checks
│   ├── playbooks.mjs   # Auto-remediation playbooks with cooldown tracking
│   ├── web.mjs         # HTTP dashboard + SSE /api/stream + REST API
│   └── install.mjs     # LaunchAgent plist generation / load / unload
├── ui/index.html       # Self-contained web dashboard (no external dependencies)
└── knowledge/
    └── patterns.json   # Known error pattern knowledge base
```

---

## Data Directory (`~/.openclaw-watchdog/`)

| File | Contents |
|------|----------|
| `config.json` | Watchdog config (gatewayUrl, chatId, accountId, intervals...) |
| `events.json` | Event log, max 500 entries, persisted across restarts |
| `latency.json` | Latency history, max 200 points, persisted across restarts |
| `daemon.pid` | Current daemon PID |
| `daemon.log` | Daemon stdout log |
| `launchd-stdout.log` | LaunchAgent stdout |
| `launchd-stderr.log` | LaunchAgent stderr |

---

## Web API

| Route | Description |
|-------|-------------|
| `GET /` | Dashboard HTML |
| `GET /api/status` | Live state + stats |
| `GET /api/events` | Event list (max 100) |
| `GET /api/latency` | Latency history (max 60 points) |
| `GET /api/diagnoses` | Recent detected log issues (max 10) |
| `GET /api/channels` | Telegram bot connectivity status |
| `GET /api/stream` | SSE real-time push stream |
| `GET /api/update` | Current update state |
| `POST /api/check` | Trigger immediate health check |
| `POST /api/restart` | Trigger immediate gateway restart |
| `POST /api/update/check` | Trigger update check |
| `POST /api/update/run` | Run `openclaw update` |

---

## Requirements

- macOS (LaunchAgent install; daemon runs on any Node.js platform)
- Node.js ≥ 18
- [OpenClaw](https://openclaw.ai) installed and configured
- A Telegram bot token (optional but recommended for notifications)

---

## License

MIT
