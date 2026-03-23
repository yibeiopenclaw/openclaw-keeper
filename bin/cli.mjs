#!/usr/bin/env node
/**
 * bin/cli.mjs - OpenClaw Watchdog CLI
 *
 * Commands:
 *   start [--foreground]  - start the daemon
 *   stop                  - stop the daemon
 *   status                - show gateway status + recent events
 *   logs [--tail N]       - show recent events from store
 *   web                   - open dashboard in browser
 *   install               - install as macOS LaunchAgent
 *   uninstall             - remove LaunchAgent
 *   setup                 - interactive setup wizard
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import readline from 'readline';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Paths
const WATCHDOG_DIR  = path.join(os.homedir(), '.openclaw-keeper');
const PID_FILE      = path.join(WATCHDOG_DIR, 'daemon.pid');
const LOG_FILE      = path.join(WATCHDOG_DIR, 'daemon.log');

// ── Helpers ───────────────────────────────────────────────────────────────

function ensureDir() {
  fs.mkdirSync(WATCHDOG_DIR, { recursive: true });
}

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function colorize(text, code) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

const green  = (t) => colorize(t, '32');
const red    = (t) => colorize(t, '31');
const yellow = (t) => colorize(t, '33');
const cyan   = (t) => colorize(t, '36');
const bold   = (t) => colorize(t, '1');
const dim    = (t) => colorize(t, '2');

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 5)     return 'just now';
  if (diff < 60)    return diff + 's ago';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

const TYPE_COLORS = {
  check_ok:      green,
  check_fail:    red,
  restart_start: yellow,
  restart_ok:    green,
  restart_fail:  red,
  notify_sent:   cyan,
  notify_fail:   yellow,
};

function formatType(type) {
  const fn = TYPE_COLORS[type] || dim;
  return fn(type.toUpperCase().padEnd(14));
}

// ── Commands ──────────────────────────────────────────────────────────────

/** start [--foreground] */
async function cmdStart(args) {
  const foreground = args.includes('--foreground');
  ensureDir();

  if (!foreground) {
    // Check if already running
    const pid = readPid();
    if (pid && isProcessRunning(pid)) {
      console.log(yellow(`Watchdog already running (PID ${pid})`));
      process.exit(0);
    }

    // Fork to background
    const nodeBin = process.execPath;
    const cliPath  = fileURLToPath(import.meta.url);

    const child = exec(
      `"${nodeBin}" "${cliPath}" start --foreground >> "${LOG_FILE}" 2>&1`,
      { detached: true, stdio: 'ignore' }
    );
    child.unref();

    // Give it a moment to write its PID
    await new Promise(r => setTimeout(r, 1200));

    const newPid = readPid();
    if (newPid) {
      console.log(green(`Watchdog started (PID ${newPid})`));
      console.log(dim(`Log: ${LOG_FILE}`));
    } else {
      console.log(yellow('Watchdog launched (could not read PID yet)'));
      console.log(dim(`Log: ${LOG_FILE}`));
    }
    return;
  }

  // ── Foreground mode ───────────────────────────────────────────────────
  // Write PID
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

  // Clean up PID file on exit
  function cleanup() {
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  }
  process.on('SIGTERM', cleanup);
  process.on('SIGINT',  cleanup);

  // Import daemon + web modules
  const { start: daemonStart, triggerCheck, triggerRestart } = await import('../src/daemon.mjs');
  const { startWebServer } = await import('../src/web.mjs');
  const { getWatchdogConfig } = await import('../src/config.mjs');

  const cfg = getWatchdogConfig();

  // Start web server
  try {
    await startWebServer(cfg.webPort, { triggerCheck, triggerRestart });
  } catch (err) {
    console.error(`Warning: could not start web server on port ${cfg.webPort}: ${err.message}`);
  }

  // Start daemon loop
  await daemonStart();

  // Keep process alive
  await new Promise(() => {});
}

/** stop */
function cmdStop() {
  const pid = readPid();
  if (!pid) {
    console.log(yellow('No PID file found — keeper may not be running.'));
    process.exit(1);
  }
  if (!isProcessRunning(pid)) {
    console.log(yellow(`PID ${pid} is not running — cleaning up stale PID file.`));
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(green(`Watchdog stopped (PID ${pid})`));
    try { fs.unlinkSync(PID_FILE); } catch {}
  } catch (err) {
    console.error(red(`Failed to stop keeper: ${err.message}`));
    process.exit(1);
  }
}

/** status */
async function cmdStatus() {
  const { getStats, getEvents } = await import('../src/store.mjs');
  const { getWatchdogConfig } = await import('../src/config.mjs');
  const { checkGateway } = await import('../src/monitor.mjs');

  const cfg  = getWatchdogConfig();
  const pid  = readPid();
  const alive = pid ? isProcessRunning(pid) : false;

  console.log('');
  console.log(bold('  🐕 OpenClaw Watchdog'));
  console.log('');

  // Daemon status
  if (alive) {
    console.log(`  Daemon:    ${green('running')} (PID ${pid})`);
  } else {
    console.log(`  Daemon:    ${red('not running')}`);
  }

  console.log(`  Gateway:   ${dim(cfg.gatewayUrl)}`);
  console.log(`  Interval:  ${cfg.checkInterval}s`);
  console.log(`  Heartbeat: ${cfg.heartbeatInterval > 0 ? 'every ' + cfg.heartbeatInterval + 's' : dim('disabled')}`);
  console.log(`  Discord:   ${cfg.discordWebhookUrl ? green('configured') : dim('not set')}`);
  console.log(`  Slack:     ${cfg.slackWebhookUrl   ? green('configured') : dim('not set')}`);
  console.log(`  Web UI:    http://localhost:${cfg.webPort}`);
  console.log('');

  // Live check
  process.stdout.write(`  Checking gateway... `);
  const result = await checkGateway(cfg.gatewayUrl);
  if (result.ok) {
    console.log(green(`OK`) + dim(` (${result.latencyMs}ms)`));
  } else {
    console.log(red(`DOWN`) + dim(` — ${result.error}`));
  }

  // Stats
  const stats = getStats();
  console.log('');
  console.log(bold('  Stats'));
  console.log(`  Total checks:  ${stats.totalChecks}`);
  console.log(`  Failures:      ${stats.failCount}`);
  console.log(`  Last check:    ${formatTime(stats.lastCheck)}`);
  console.log(`  Last failure:  ${formatTime(stats.lastFail)}`);
  console.log(`  Up since:      ${formatTime(stats.upSince)}`);
  console.log('');

  // Recent events
  const events = getEvents(5);
  if (events.length) {
    console.log(bold('  Recent Events'));
    for (const ev of events) {
      const ts  = dim(formatTime(ev.timestamp));
      const type = formatType(ev.type);
      console.log(`  ${ts}  ${type}  ${ev.message}`);
    }
  }
  console.log('');
}

/** logs [--tail N] [--follow] */
async function cmdLogs(args) {
  const follow = args.includes('--follow') || args.includes('-f');

  if (follow) {
    await cmdLogsFollow();
    return;
  }

  const { getEvents } = await import('../src/store.mjs');

  let limit = 50;
  const tailIdx = args.indexOf('--tail');
  if (tailIdx !== -1 && args[tailIdx + 1]) {
    const n = parseInt(args[tailIdx + 1], 10);
    if (Number.isFinite(n) && n > 0) limit = n;
  }

  const events = getEvents(limit);

  if (!events.length) {
    console.log(dim('No events recorded yet.'));
    return;
  }

  console.log('');
  console.log(bold(`  Last ${events.length} events (newest first)`));
  console.log('');

  for (const ev of events) {
    const ts     = dim(formatTime(ev.timestamp));
    const type   = formatType(ev.type);
    const detail = ev.detail ? dim(`  ${ev.detail}`) : '';
    console.log(`  ${ts}  ${type}  ${ev.message}${detail}`);
  }
  console.log('');
}

/** logs --follow: stream live events via SSE */
async function cmdLogsFollow() {
  const { getWatchdogConfig } = await import('../src/config.mjs');
  const cfg = getWatchdogConfig();
  const port = cfg.webPort || 19877;

  // Check daemon is running
  const pid = readPid();
  if (!pid || !isProcessRunning(pid)) {
    console.log(red('  Daemon is not running. Start it first: openclaw-keeper start'));
    process.exit(1);
  }

  console.log('');
  console.log(bold('  Live events') + dim(' (Ctrl+C to stop)'));
  console.log('');

  const http = await import('http');
  let buffer = '';

  const req = http.default.get(`http://127.0.0.1:${port}/api/stream`, (res) => {
    if (res.statusCode !== 200) {
      console.log(red(`  Cannot connect to dashboard (HTTP ${res.statusCode})`));
      process.exit(1);
    }

    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split('\n\n');
      buffer = parts.pop(); // keep incomplete chunk
      for (const part of parts) {
        if (!part.startsWith('data:')) continue;
        try {
          const msg = JSON.parse(part.slice(5).trim());
          if (msg.type === 'update' && msg.payload?.latestEvent) {
            const ev = msg.payload.latestEvent;
            const ts   = dim(formatTime(ev.timestamp));
            const type = formatType(ev.type);
            const detail = ev.detail ? dim(`  ${ev.detail}`) : '';
            console.log(`  ${ts}  ${type}  ${ev.message}${detail}`);
          }
        } catch {}
      }
    });

    res.on('error', (err) => {
      console.log(red(`  Stream error: ${err.message}`));
      process.exit(1);
    });
  });

  req.on('error', (err) => {
    console.log(red(`  Cannot connect to dashboard: ${err.message}`));
    process.exit(1);
  });

  // Keep alive
  process.on('SIGINT', () => {
    req.destroy();
    console.log('');
    process.exit(0);
  });
}

/** diagnose [--lines N] — scan recent gateway logs for known error patterns */
async function cmdDiagnose(args) {
  const { diagnose } = await import('../src/diagnose.mjs');

  let lineCount = 2000;
  const linesIdx = args.indexOf('--lines');
  if (linesIdx !== -1 && args[linesIdx + 1]) {
    const n = parseInt(args[linesIdx + 1], 10);
    if (Number.isFinite(n) && n > 0) lineCount = n;
  }

  const logPath = path.join(os.homedir(), '.openclaw', 'logs', 'gateway.err.log');

  console.log('');
  console.log(bold('  OpenClaw Log Diagnosis'));
  console.log(dim(`  Scanning last ${lineCount} lines of ${logPath}`));
  console.log('');

  if (!fs.existsSync(logPath)) {
    console.log(yellow('  Log file not found: ' + logPath));
    console.log('');
    return;
  }

  // Read last N lines efficiently
  const content = fs.readFileSync(logPath, 'utf8');
  const allLines = content.split('\n');
  const lines = allLines.slice(-lineCount);

  // Scan and count by pattern id
  const counts = new Map(); // id -> { diag, count, lastLine, lastTs }
  for (const line of lines) {
    if (!line.trim()) continue;
    const diag = diagnose(line);
    if (!diag) continue;

    // Try to extract timestamp from line (ISO format)
    const tsMatch = line.match(/\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/);
    const ts = tsMatch ? tsMatch[0] : null;

    if (counts.has(diag.id)) {
      const entry = counts.get(diag.id);
      entry.count++;
      if (ts) entry.lastTs = ts;
      entry.lastLine = line.slice(0, 120);
    } else {
      counts.set(diag.id, { diag, count: 1, lastTs: ts, lastLine: line.slice(0, 120) });
    }
  }

  if (counts.size === 0) {
    console.log(green('  No known issues detected in recent logs.'));
    console.log('');
    return;
  }

  // Sort: errors first, then by count desc
  const sorted = [...counts.values()].sort((a, b) => {
    if (a.diag.severity !== b.diag.severity) {
      return a.diag.severity === 'error' ? -1 : 1;
    }
    return b.count - a.count;
  });

  console.log(`  Found ${bold(sorted.length)} distinct issue type(s) in ${lines.length} lines:\n`);

  for (const { diag, count, lastTs, lastLine } of sorted) {
    const sevColor = diag.severity === 'error' ? red : yellow;
    const sev = sevColor(diag.severity.toUpperCase().padEnd(5));
    const autofix = diag.autofix ? cyan(' [autofix]') : '';
    console.log(`  ${sev}  ${bold(diag.cause)}${autofix}`);
    console.log(`         ${dim(diag.description)}`);
    console.log(`         Occurrences: ${bold(count)}${lastTs ? '  Last: ' + dim(formatTime(lastTs)) : ''}`);
    console.log(`         ${dim('Example: ' + lastLine.trim().slice(0, 100))}`);
    console.log('');
  }
}

/** web */
async function cmdWeb() {
  const { getWatchdogConfig } = await import('../src/config.mjs');
  const cfg = getWatchdogConfig();
  const url = `http://localhost:${cfg.webPort}`;

  // Check if the web server is already responding
  let serverRunning = false;
  try {
    const { default: http } = await import('http');
    await new Promise((resolve, reject) => {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    });
    serverRunning = true;
  } catch {
    serverRunning = false;
  }

  if (!serverRunning) {
    console.log(yellow(`Web server not responding at ${url}`));
    console.log(`Start the watchdog first: ${bold('openclaw-keeper start')}`);
    console.log(`Or start in foreground with web server for quick use.`);
    // Open anyway — maybe the daemon is starting
  }

  console.log(`Opening ${cyan(url)} in browser...`);
  try {
    await execAsync(`open "${url}"`);
  } catch {
    console.log(`Could not open browser. Visit manually: ${url}`);
  }
}

/** install */
async function cmdInstall() {
  const { installLaunchAgent } = await import('../src/install.mjs');
  try {
    await installLaunchAgent();
  } catch (err) {
    console.error(red(`Install failed: ${err.message}`));
    process.exit(1);
  }
}

/** uninstall */
async function cmdUninstall() {
  const { uninstallLaunchAgent } = await import('../src/install.mjs');
  try {
    await uninstallLaunchAgent();
  } catch (err) {
    console.error(red(`Uninstall failed: ${err.message}`));
    process.exit(1);
  }
}

/** setup - interactive configuration wizard */
async function cmdSetup() {
  const { getWatchdogConfig, saveWatchdogConfig, getOpenclawConfig, getTelegramAccounts }
    = await import('../src/config.mjs');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  console.log('');
  console.log(bold('  🐕 OpenClaw Watchdog — Setup'));
  console.log('');

  const ocConfig = getOpenclawConfig();
  const accounts = getTelegramAccounts(ocConfig);
  const cfg = getWatchdogConfig();

  // ── Step 1: Chat ID ────────────────────────────────────────────────────
  console.log(bold('  Step 1: Telegram Chat ID'));
  console.log('');
  console.log('  通知会发送到指定的 Telegram 对话（私聊或群组）。');
  console.log('  获取 Chat ID 的方法：');
  console.log(`    ${dim('私聊：')} 在 Telegram 搜索 ${cyan('@userinfobot')}，发送任意消息，它会回复你的数字 Chat ID`);
  console.log(`    ${dim('群组：')} 将 ${cyan('@userinfobot')} 拉入群组，发送任意消息，它会回复群组的 Chat ID（负数）`);
  console.log('');

  const chatIdDefault = cfg.notifyChatId || '';
  const chatIdPrompt = chatIdDefault
    ? `  Chat ID ${dim('[' + chatIdDefault + ']')}: `
    : `  Chat ID（留空跳过 Telegram 通知）: `;

  const chatIdInput = (await ask(chatIdPrompt)).trim();
  const notifyChatId = chatIdInput || chatIdDefault || null;
  console.log('');

  // ── Step 2: Account selection ──────────────────────────────────────────
  let selectedAccount = null;

  if (notifyChatId && accounts.length > 0) {
    console.log(bold('  Step 2: 选择发送通知的 Telegram 账号'));
    console.log('');

    if (accounts.length === 1) {
      selectedAccount = accounts[0];
      console.log(`  自动选择唯一账号：${green(selectedAccount.accountId)}`);
    } else {
      for (let i = 0; i < accounts.length; i++) {
        console.log(`    ${cyan(String(i + 1))}. ${accounts[i].accountId}`);
      }
      console.log('');
      const defaultAccountIdx = (() => {
        const saved = cfg.notifyAccountId;
        if (saved) {
          const idx = accounts.findIndex(a => a.accountId === saved);
          return idx >= 0 ? idx : 0;
        }
        return 0;
      })();
      const accInput = (await ask(
        `  选择账号编号 ${dim('[' + (defaultAccountIdx + 1) + ' = ' + accounts[defaultAccountIdx].accountId + ']')}: `
      )).trim();
      const accIdx = (parseInt(accInput, 10) || defaultAccountIdx + 1) - 1;
      selectedAccount = accounts[Math.max(0, Math.min(accIdx, accounts.length - 1))];
    }
    console.log('');
  } else if (notifyChatId && accounts.length === 0) {
    console.log(yellow('  Step 2: 未找到 Telegram 账号'));
    console.log('  请先在 openclaw 中配置 Telegram 账号，再启用通知。');
    console.log('');
  }

  // ── Step 3: Interval ───────────────────────────────────────────────────
  console.log(bold('  Step 3: 检查间隔'));
  console.log('');
  const intervalInput = (await ask(
    `  Gateway 健康检查间隔（秒）${dim('[' + cfg.checkInterval + ']')}: `
  )).trim();
  const checkInterval = parseInt(intervalInput, 10) || cfg.checkInterval;
  console.log('');

  // ── Step 4: Heartbeat ──────────────────────────────────────────────────
  let heartbeatInterval = cfg.heartbeatInterval || 0;
  if (notifyChatId && selectedAccount) {
    console.log(bold('  Step 4: 定时心跳汇报'));
    console.log('');
    console.log('  定期发送状态摘要（正常率、延迟、重启次数等）。');
    console.log(`  常用间隔: ${dim('1800 = 每 30 分钟 | 3600 = 每小时 | 86400 = 每天')}`);
    console.log('');
    const hbDefault = heartbeatInterval > 0 ? String(heartbeatInterval) : '0';
    const hbInput = (await ask(
      `  心跳间隔（秒，0 = 禁用）${dim('[' + hbDefault + ']')}: `
    )).trim();
    heartbeatInterval = parseInt(hbInput, 10);
    if (isNaN(heartbeatInterval) || heartbeatInterval < 0) heartbeatInterval = 0;
    console.log('');
  }

  // ── Step 5: Discord / Slack Webhooks ──────────────────────────────────
  console.log(bold('  Step 5: Webhook 通知（可选）'));
  console.log('');
  console.log('  可选：配置 Discord 或 Slack webhook，在 Telegram 之外额外接收通知。');
  console.log(`  Discord: Server Settings → Integrations → Webhooks → New Webhook`);
  console.log(`  Slack:   App Directory → Incoming Webhooks`);
  console.log('');

  const discordDefault = cfg.discordWebhookUrl || '';
  const discordInput = (await ask(
    `  Discord Webhook URL ${dim(discordDefault ? '[已配置，留空保留]' : '[留空跳过]')}: `
  )).trim();
  const discordWebhookUrl = discordInput || discordDefault || null;

  const slackDefault = cfg.slackWebhookUrl || '';
  const slackInput = (await ask(
    `  Slack Webhook URL ${dim(slackDefault ? '[已配置，留空保留]' : '[留空跳过]')}: `
  )).trim();
  const slackWebhookUrl = slackInput || slackDefault || null;
  console.log('');

  // ── Save ───────────────────────────────────────────────────────────────
  const notifyTelegram = !!(notifyChatId && selectedAccount);
  const newCfg = {
    ...cfg,
    notifyChatId,
    notifyAccountId: selectedAccount?.accountId ?? cfg.notifyAccountId ?? null,
    checkInterval,
    heartbeatInterval,
    notifyTelegram,
    discordWebhookUrl,
    slackWebhookUrl,
  };
  saveWatchdogConfig(newCfg);

  console.log(green('  Configuration saved!'));
  console.log('');
  console.log(`  Chat ID:      ${newCfg.notifyChatId || dim('(none)')}`);
  console.log(`  Account:      ${newCfg.notifyAccountId || dim('(none)')}`);
  console.log(`  Check every:  ${newCfg.checkInterval}s`);
  const hbDisplay = newCfg.heartbeatInterval > 0
    ? green(`every ${newCfg.heartbeatInterval}s`)
    : dim('disabled');
  console.log(`  Heartbeat:    ${hbDisplay}`);
  console.log(`  Telegram:     ${newCfg.notifyTelegram ? green('enabled') : dim('disabled')}`);
  console.log(`  Discord:      ${newCfg.discordWebhookUrl ? green('configured') : dim('not set')}`);
  console.log(`  Slack:        ${newCfg.slackWebhookUrl   ? green('configured') : dim('not set')}`);
  console.log('');

  // ── Test notification ──────────────────────────────────────────────────
  if (notifyChatId && selectedAccount) {
    const testInput = (await ask('  发送一条测试通知？(y/n): ')).trim().toLowerCase();
    rl.close();
    if (testInput === 'y') {
      const { sendTelegram } = await import('../src/notify.mjs');
      const { token, accountId } = selectedAccount;
      const ts = new Date().toLocaleString('zh-CN', { hour12: false });
      const result = await sendTelegram(token, notifyChatId,
        `🐕 <b>OpenClaw Watchdog</b>\n\n` +
        `✅ 测试通知\n` +
        `账号: ${accountId}\n` +
        `时间: ${ts}\n\n` +
        `Watchdog 配置成功，已准备好监控 Gateway。`
      );
      if (result.ok) {
        console.log(green('  测试通知已发送！'));
      } else {
        console.log(red(`  发送失败: ${result.error}`));
      }
    }
  } else {
    rl.close();
  }

  console.log('');
  console.log(`  Next steps:`);
  console.log(`    ${cyan('openclaw-keeper start')}    — start the daemon`);
  console.log(`    ${cyan('openclaw-keeper install')}  — auto-start at login (macOS)`);
  console.log(`    ${cyan('openclaw-keeper web')}      — open the dashboard`);
  console.log('');
}

/** chat */
async function cmdChat() {
  const { getWatchdogConfig } = await import('../src/config.mjs');
  const cfg  = getWatchdogConfig();
  const base = `http://localhost:${cfg.webPort}`;

  // ── API helpers ──────────────────────────────────────────────────────
  const { default: http } = await import('http');

  function apiGet(path) {
    return new Promise((resolve, reject) => {
      const req = http.get(base + path, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
        });
      });
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    });
  }

  function apiPost(path) {
    return new Promise((resolve, reject) => {
      const req = http.request(base + path, { method: 'POST' }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
        });
      });
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      req.end();
    });
  }

  // ── Check daemon is reachable ────────────────────────────────────────
  let daemonOk = false;
  try {
    await apiGet('/api/status');
    daemonOk = true;
  } catch {}

  console.log('');
  console.log(bold('  🐕 OpenClaw Watchdog — Chat'));
  if (!daemonOk) {
    console.log('');
    console.log(yellow(`  Watchdog daemon not reachable at ${base}`));
    console.log(`  Start it first: ${cyan('openclaw-keeper start')}`);
    console.log('');
    return;
  }
  console.log(dim(`  Connected to ${base}`));
  console.log(dim('  Commands: status · logs [N] · check · restart · diagnoses · help · exit'));
  console.log('');

  // ── Command handlers ─────────────────────────────────────────────────
  async function handleCommand(input) {
    const parts = input.trim().split(/\s+/);
    const cmd   = parts[0].toLowerCase();

    switch (cmd) {
      case 'status':
      case 's': {
        const data = await apiGet('/api/status');
        const s    = data.stats || {};
        const total = s.totalChecks || 0;
        const fails = s.failCount   || 0;
        const upPct = total > 0 ? ((total - fails) / total * 100).toFixed(1) + '%' : '—';

        if (data.isRestarting) {
          console.log(`  ${yellow('⏳ Restarting...')}`);
        } else if (data.gatewayOk === true) {
          console.log(`  ${green('✅ Gateway Online')}  ${dim(data.latencyMs + 'ms')}`);
        } else if (data.gatewayOk === false) {
          console.log(`  ${red('❌ Gateway Down')}`);
        } else {
          console.log(`  ${dim('? Unknown')}`);
        }
        console.log(`  Uptime: ${green(upPct)}  Checks: ${total}  Failures: ${fails}`);
        if (s.lastCheck) console.log(`  Last check: ${dim(formatTime(s.lastCheck))}`);
        break;
      }

      case 'logs':
      case 'l': {
        const n     = parseInt(parts[1], 10) || 10;
        const events = await apiGet('/api/events');
        const slice  = events.slice(0, n);
        if (!slice.length) { console.log(dim('  No events yet.')); break; }
        for (const ev of slice) {
          const ts   = dim(formatTime(ev.timestamp));
          const type = formatType(ev.type);
          const msg  = ev.message;
          console.log(`  ${ts}  ${type}  ${msg}`);
        }
        break;
      }

      case 'check':
      case 'c': {
        process.stdout.write('  Checking gateway... ');
        const res = await apiPost('/api/check');
        if (res.ok) {
          console.log(green(`OK`) + dim(` (${res.latencyMs}ms)`));
        } else {
          console.log(red(`DOWN`) + dim(` — ${res.error}`));
        }
        break;
      }

      case 'restart':
      case 'r': {
        const { createInterface } = await import('readline');
        const rl2 = createInterface({ input: process.stdin, output: process.stdout });
        const confirm = await new Promise(res => rl2.question(
          `  ${yellow('Restart gateway?')} (y/N) `, res
        ));
        rl2.close();
        if (confirm.trim().toLowerCase() !== 'y') {
          console.log(dim('  Cancelled.'));
          break;
        }
        process.stdout.write('  Restarting gateway... ');
        const result = await apiPost('/api/restart');
        if (result.success) {
          console.log(green(`Done`) + dim(` (${result.elapsedSeconds}s)`));
        } else {
          console.log(red(`Failed`) + dim(` — ${result.error}`));
        }
        break;
      }

      case 'diagnoses':
      case 'diag':
      case 'd': {
        const diags = await apiGet('/api/diagnoses');
        if (!diags.length) { console.log(dim('  No issues detected.')); break; }
        for (const d of diags) {
          const icon = d.severity === 'error' ? red('●') : yellow('●');
          console.log(`  ${icon} ${bold(d.cause)}`);
          console.log(`    ${dim(d.description)}`);
          console.log(`    ${dim(timeAgo(d.t))}`);
        }
        break;
      }

      case 'channels':
      case 'ch': {
        const { channels, checkedAt } = await apiGet('/api/channels');
        if (!channels || channels.length === 0) {
          console.log(dim('  No channel data yet (check runs 30s after daemon start).'));
          break;
        }
        console.log(`  ${dim('Channels')} ${checkedAt ? dim('· checked ' + timeAgo(checkedAt)) : ''}`);
        for (const ch of channels) {
          const icon = ch.ok ? green('✓') : red('✗');
          const name = ch.accountId;
          const detail = ch.ok
            ? dim(`@${ch.botName}`)
            : red(ch.error || 'error');
          console.log(`  ${icon} ${name}  ${detail}`);
        }
        break;
      }

      case 'help':
      case 'h':
      case '?':
        console.log('');
        console.log(`  ${cyan('status')}      (s)  — gateway status and stats`);
        console.log(`  ${cyan('logs')} [N]    (l)  — recent events (default 10)`);
        console.log(`  ${cyan('check')}       (c)  — trigger immediate health check`);
        console.log(`  ${cyan('restart')}     (r)  — restart the gateway`);
        console.log(`  ${cyan('diagnoses')}   (d)  — show detected log issues`);
        console.log(`  ${cyan('channels')}   (ch)  — show Telegram channel connectivity`);
        console.log(`  ${cyan('exit')}             — quit`);
        break;

      case 'exit':
      case 'quit':
      case 'q':
        return false; // signal exit

      case '':
        break;

      default:
        console.log(dim(`  Unknown command: ${cmd}. Type 'help' for commands.`));
    }
    return true; // continue
  }

  // ── REPL loop ────────────────────────────────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: green('keeper') + dim(' › '),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    rl.pause();
    try {
      const cont = await handleCommand(line);
      if (cont === false) { rl.close(); return; }
    } catch (err) {
      console.log(red(`  Error: ${err.message}`));
    }
    console.log('');
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('');
    process.exit(0);
  });

  // Show status on entry
  try {
    await handleCommand('status');
    console.log('');
  } catch {}

  rl.prompt();
}

/** help */
function cmdHelp() {
  console.log(`
${bold('openclaw-keeper')} — Health monitor and auto-recovery for OpenClaw gateway

${bold('USAGE')}
  openclaw-keeper <command> [options]

${bold('COMMANDS')}
  start [--foreground]   Start the keeper daemon
                          --foreground: run in current process (used by LaunchAgent)
  stop                   Stop the running daemon
  status                 Show gateway status, stats, and recent events
  logs [--tail N]        Show recent events (default: 50)
  logs --follow          Stream live events in real-time (Ctrl+C to stop)
  diagnose [--lines N]   Scan gateway logs for known error patterns (default: 2000 lines)
  chat                   Interactive status REPL (status/logs/check/restart/diagnoses)
  web                    Open the web dashboard in your browser
  install                Install as macOS LaunchAgent (auto-start at login)
  uninstall              Remove LaunchAgent
  setup                  Interactive configuration wizard

${bold('EXAMPLES')}
  openclaw-keeper setup
  openclaw-keeper start
  openclaw-keeper status
  openclaw-keeper chat
  openclaw-keeper logs --tail 20
  openclaw-keeper logs --follow
  openclaw-keeper diagnose
  openclaw-keeper diagnose --lines 5000
  openclaw-keeper web
  openclaw-keeper install

${bold('DATA')}
  Config:   ~/.openclaw-keeper/config.json
  Events:   ~/.openclaw-keeper/events.json
  PID:      ~/.openclaw-keeper/daemon.pid
  Log:      ~/.openclaw-keeper/daemon.log
  Web:      http://localhost:19877
`);
}

// ── Main ──────────────────────────────────────────────────────────────────

const [,, command, ...args] = process.argv;

switch (command) {
  case 'start':
    await cmdStart(args);
    break;
  case 'stop':
    cmdStop();
    break;
  case 'status':
    await cmdStatus();
    break;
  case 'logs':
    await cmdLogs(args);
    break;
  case 'diagnose':
    await cmdDiagnose(args);
    break;
  case 'chat':
    await cmdChat();
    break;
  case 'web':
    await cmdWeb();
    break;
  case 'install':
    await cmdInstall();
    break;
  case 'uninstall':
    await cmdUninstall();
    break;
  case 'setup':
    await cmdSetup();
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    cmdHelp();
    break;
  default:
    console.error(red(`Unknown command: ${command}`));
    console.log(`Run ${bold('openclaw-keeper help')} for usage.`);
    process.exit(1);
}
