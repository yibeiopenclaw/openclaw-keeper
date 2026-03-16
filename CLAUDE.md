# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`openclaw-watchdog` is a Node.js ESM daemon that monitors the OpenClaw gateway (`https://127.0.0.1:18789/`), auto-restarts it on failure, diagnoses known errors from logs, and sends alerts via Telegram/Discord/Slack. Installed as a macOS LaunchAgent for persistent operation.

## Running the Watchdog

```bash
# Development: run CLI directly
node bin/cli.mjs start
node bin/cli.mjs stop
node bin/cli.mjs status
node bin/cli.mjs restart   # not supported — use stop + start

# Production: installed globally
openclaw-watchdog start
openclaw-watchdog status
openclaw-watchdog chat       # interactive REPL
openclaw-watchdog diagnose   # scan gateway logs for known patterns
openclaw-watchdog logs --follow   # live SSE event stream
openclaw-watchdog setup      # interactive config wizard
openclaw-watchdog install    # register macOS LaunchAgent
```

No build step — pure ESM, runs directly with Node.js ≥18. No test suite.

## Architecture

The daemon runs as a single Node.js process. All modules are stateless except `daemon.mjs` and `store.mjs`.

**Data flow:**
1. `daemon.mjs` drives the main loop: health checks every 60s, log watching, heartbeat, channel checks
2. On gateway failure → `handleFailure()` → notify + `monitor.mjs` restart
3. Log watcher fires `diagnose()` on each new line → matches `knowledge/patterns.json` → triggers playbook or notification
4. `web.mjs` serves the dashboard and exposes REST + SSE; `daemon.mjs` pushes updates via `onUpdate()` callbacks

**Key state in `daemon.mjs`:**
- `state` object — shared with `web.mjs` via ES module import
- `pendingAlerts[]` — retry queue for notifications that failed due to network outage; drained on next successful gateway check
- `notifyLastSent` Map — per-pattern cooldown (warn: 1h, error: governed by `recordDiagnosis` 5-min dedup)

**Config sources (two separate files):**
- `~/.openclaw/openclaw.json` — OpenClaw config; Telegram bot tokens are read from `channels.telegram.accounts[id].botToken`
- `~/.openclaw-watchdog/config.json` — watchdog config: `gatewayUrl`, `checkInterval`, `notifyChatId`, `heartbeatInterval`, `discordWebhookUrl`, `slackWebhookUrl`

## Key Design Decisions

**Telegram bypasses the gateway:** `notify.mjs` uses raw `https.request` with forced IPv4 DNS resolution (`dns.lookup(..., { family: 4 })`), so notifications still work when the gateway is down.

**Playbooks vs health-check restarts:** There are two restart paths:
- Health check fails → `handleFailure()` → sends down/recovery notifications
- Log pattern with `autofix: true` → `playbooks.mjs` → sends playbook result notification
The playbook skips running if `state.gatewayOk === false` (health-check loop handles it).

**Pattern matching pipeline:** `log-watcher.mjs` tails `~/.openclaw/logs/gateway.err.log` and `gateway.log` from EOF (no history replay). New lines → `diagnose.mjs` tests each `patterns.json` regex → `recordDiagnosis()` deduplicates within 5 min → if `notify: true` and cooldown allows, sends alert.

**Notification retry queue:** If a Telegram send fails (e.g. DNS down), the alert is pushed to `pendingAlerts[]` without marking cooldown. The queue is drained after each successful gateway health check. Items expire after 2 hours.

## Adding a New Error Pattern

Edit `knowledge/patterns.json`. Each entry:
```json
{
  "id": "unique-id",
  "match": "regex string (tested against each log line)",
  "severity": "error" | "warn",
  "cause": "Short Chinese description shown in notifications",
  "description": "Longer explanation + fix command",
  "autofix": true | false,
  "notify": true | false
}
```
- `autofix: true` requires a matching entry in `PLAYBOOK_MAP` in `playbooks.mjs`
- `notify: true` sends a Telegram/webhook alert; warn patterns have 1h cooldown, error patterns use 5-min dedup only

## Runtime Data Directory (`~/.openclaw-watchdog/`)

| File | Purpose |
|------|---------|
| `config.json` | Watchdog settings |
| `events.json` | Persistent event log (max 500) |
| `latency.json` | Latency history (max 200 points) |
| `daemon.pid` | Running daemon PID |
| `daemon.log` | Daemon stdout |

## Web Dashboard

Runs on `http://localhost:19877`. The `ui/index.html` is self-contained (no external dependencies). SSE stream at `/api/stream` pushes state updates after every health check or log event.
