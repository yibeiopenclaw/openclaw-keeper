/**
 * daemon.mjs - main watchdog loop
 *
 * Every checkInterval seconds:
 *   1. checkGateway()
 *   2. Log to store
 *   3. On fail: notify, restartGateway(), log result, notify recovery/failure
 *
 * Consecutive-fail tracking prevents notification spam.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getWatchdogConfig, getOpenclawConfig, getTelegramAccounts, saveWatchdogConfig } from './config.mjs';
import { checkGateway, restartGateway } from './monitor.mjs';
import { addEvent, recordLatency, recordDiagnosis } from './store.mjs';
import { notifyDown, notifyRecovered, notifyRestartFailed, notifyHeartbeat, notifyLogIssue, notifyPlaybook, notifyNewVersion } from './notify.mjs';
import { watchOpencalwLogs } from './log-watcher.mjs';
import { diagnose } from './diagnose.mjs';
import { runPlaybook, hasPlaybook } from './playbooks.mjs';
import { checkAllChannels } from './channels.mjs';

let running = false;
let timer = null;
let heartbeatTimer = null;
let channelTimer = null;
let updateCheckTimer = null;
let logWatcher = null;

// Per-pattern notification cooldown: warn = 1 hour, error = governed by recordDiagnosis (5 min)
const WARN_NOTIFY_INTERVAL_MS = 60 * 60 * 1000;
const notifyLastSent = new Map(); // patternId → timestamp

function canSendNotify(diag) {
  if (diag.severity !== 'warn') return true;
  const last = notifyLastSent.get(diag.id);
  return !last || (Date.now() - last) > WARN_NOTIFY_INTERVAL_MS;
}

function markNotifySent(diagId) {
  notifyLastSent.set(diagId, Date.now());
}

// Pending alert retry queue — filled when network is down at send time
const pendingAlerts = []; // [{ diag, accounts, chatId, webhooks, enqueuedAt }]
const MAX_PENDING = 20;
const MAX_PENDING_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

async function drainPendingAlerts() {
  if (pendingAlerts.length === 0) return;
  const now = Date.now();
  // Drop stale entries
  while (pendingAlerts.length > 0 && (now - pendingAlerts[0].enqueuedAt) > MAX_PENDING_AGE_MS) {
    const stale = pendingAlerts.shift();
    log(`[notify-retry] Dropped stale alert (${Math.round((now - stale.enqueuedAt) / 60000)}m old): ${stale.diag.cause}`);
  }
  if (pendingAlerts.length === 0) return;
  log(`[notify-retry] Attempting to send ${pendingAlerts.length} pending alert(s)...`);
  const item = pendingAlerts[0];
  const r = await notifyLogIssue(item.accounts, item.chatId, item.diag, item.webhooks);
  if (r.ok) {
    pendingAlerts.shift();
    markNotifySent(item.diag.id);
    addEvent('notify_sent', `Retry: Log alert sent via ${r.accountId}: ${item.diag.cause}`);
    log(`[notify-retry] Alert sent via ${r.accountId}: ${item.diag.cause}`);
    if (pendingAlerts.length > 0) await drainPendingAlerts();
  } else {
    log(`[notify-retry] Still failing: ${r.error}`);
  }
}

// Most recent diagnosis from log watcher (used to enrich restart notifications)
export let latestDiagnosis = null;

// Shared state readable by web.mjs / cli
export const state = {
  gatewayOk: null,      // null = unknown, true/false
  lastCheckAt: null,    // ISO timestamp
  lastLatencyMs: null,
  consecutiveFails: 0,
  isRestarting: false,
  checkInterval: 60,    // mirrors config, for countdown
  channels: [],         // [{ accountId, ok, botName?, error?, checkedAt }]
  channelsCheckedAt: null,
  update: {             // openclaw version update status
    currentVersion: null,
    availableVersion: null,
    hasUpdate: false,
    checkedAt: null,
  },
};

// ── Real-time update subscribers ──────────────────────────────────────────
const updateCallbacks = new Set();

/**
 * Register a callback to be called after each health check or state change.
 * Returns an unsubscribe function.
 * @param {(payload: object) => void} fn
 * @returns {() => void}
 */
export function onUpdate(fn) {
  updateCallbacks.add(fn);
  return () => updateCallbacks.delete(fn);
}

function notifyUpdate(latestEvent = null) {
  if (updateCallbacks.size === 0) return;
  const payload = { ...state, latestEvent };
  for (const fn of updateCallbacks) {
    try { fn(payload); } catch {}
  }
}

function log(msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${msg}\n`);
}

async function runCheck() {
  if (state.isRestarting) {
    log('Skipping check — restart in progress');
    return;
  }

  const cfg = getWatchdogConfig();
  const result = await checkGateway(cfg.gatewayUrl);

  state.lastCheckAt = new Date().toISOString();
  state.lastLatencyMs = result.latencyMs;

  if (result.ok) {
    state.gatewayOk = true;
    state.consecutiveFails = 0;
    recordLatency(result.latencyMs);
    const ev = addEvent('check_ok', `Gateway OK (${result.latencyMs}ms)`, `status ${result.statusCode}`);
    log(`Gateway OK — ${result.latencyMs}ms`);
    notifyUpdate(ev);
    // Drain any pending alerts that failed when network was down
    if (pendingAlerts.length > 0) drainPendingAlerts().catch(() => {});
  } else {
    state.gatewayOk = false;
    state.consecutiveFails++;
    recordLatency(null);
    const ev = addEvent('check_fail', `Gateway unreachable: ${result.error}`, `latency ${result.latencyMs}ms`);
    log(`Gateway FAIL (consecutive ${state.consecutiveFails}): ${result.error}`);
    notifyUpdate(ev);

    // Only notify and restart on the FIRST fail in a sequence to avoid spam
    if (state.consecutiveFails === 1) {
      await handleFailure(result.error, cfg);
    } else {
      log(`Skipping restart/notification — already in fail sequence (count: ${state.consecutiveFails})`);
    }
  }
}

function pickAccounts(cfg) {
  const ocConfig = getOpenclawConfig();
  const all = getTelegramAccounts(ocConfig);
  if (cfg.notifyAccountId) {
    const match = all.find(a => a.accountId === cfg.notifyAccountId);
    return match ? [match] : all;
  }
  return all;
}

function buildWebhooks(cfg) {
  const w = {};
  if (cfg.discordWebhookUrl) w.discord = cfg.discordWebhookUrl;
  if (cfg.slackWebhookUrl)   w.slack   = cfg.slackWebhookUrl;
  return (w.discord || w.slack) ? w : null;
}

async function handleFailure(errorMsg, cfg) {
  const accounts = pickAccounts(cfg);
  const chatId = cfg.notifyChatId;
  const webhooks = buildWebhooks(cfg);

  // Send down notification (include latest log diagnosis if available)
  if (cfg.notifyTelegram && chatId && accounts.length > 0) {
    const notifyResult = await notifyDown(accounts, chatId, errorMsg, latestDiagnosis, webhooks);
    if (notifyResult.ok) {
      addEvent('notify_sent', `Down notification sent via ${notifyResult.accountId}`);
      log(`Telegram notification sent (down) via ${notifyResult.accountId}`);
    } else {
      addEvent('notify_fail', `Failed to send down notification: ${notifyResult.error}`);
      log(`Telegram notification failed: ${notifyResult.error}`);
    }
  } else if (webhooks) {
    // No Telegram configured but webhooks exist — still send
    const { sendWebhooks } = await import('./notify.mjs');
    await sendWebhooks(webhooks, `🐕 OpenClaw Watchdog\n\n⚠️ Gateway 无响应\n错误: ${errorMsg}\n\n正在自动重启...`);
    addEvent('notify_sent', 'Down notification sent via webhook');
  }

  // Restart gateway
  state.isRestarting = true;
  addEvent('restart_start', 'Attempting gateway restart');
  log('Starting gateway restart...');

  const restartStart = Date.now();
  const restartResult = await restartGateway(cfg.gatewayUrl);
  const elapsedSeconds = Math.round((Date.now() - restartStart) / 1000);
  state.isRestarting = false;

  if (restartResult.success) {
    state.gatewayOk = true;
    state.consecutiveFails = 0;
    addEvent('restart_ok', `Gateway restarted successfully in ${elapsedSeconds}s`);
    log(`Gateway restarted successfully in ${elapsedSeconds}s`);

    // Send recovery notification
    if (cfg.notifyTelegram && chatId && accounts.length > 0) {
      const notifyResult = await notifyRecovered(accounts, chatId, elapsedSeconds, webhooks);
      if (notifyResult.ok) {
        addEvent('notify_sent', `Recovery notification sent via ${notifyResult.accountId}`);
        log(`Telegram notification sent (recovered) via ${notifyResult.accountId}`);
      } else {
        addEvent('notify_fail', `Failed to send recovery notification: ${notifyResult.error}`);
        log(`Telegram recovery notification failed: ${notifyResult.error}`);
      }
    } else if (webhooks) {
      const { sendWebhooks } = await import('./notify.mjs');
      await sendWebhooks(webhooks, `🐕 OpenClaw Watchdog\n\n✅ Gateway 已恢复\n重启耗时: ${elapsedSeconds}秒`);
      addEvent('notify_sent', 'Recovery notification sent via webhook');
    }
  } else {
    addEvent('restart_fail', `Gateway restart failed: ${restartResult.error}`);
    log(`Gateway restart FAILED: ${restartResult.error}`);

    // Send restart-failed notification
    if (cfg.notifyTelegram && chatId && accounts.length > 0) {
      const notifyResult = await notifyRestartFailed(accounts, chatId, restartResult.error, webhooks);
      if (notifyResult.ok) {
        addEvent('notify_sent', `Restart-failed notification sent via ${notifyResult.accountId}`);
      } else {
        addEvent('notify_fail', `Failed to send restart-failed notification: ${notifyResult.error}`);
      }
    } else if (webhooks) {
      const { sendWebhooks } = await import('./notify.mjs');
      await sendWebhooks(webhooks, `🐕 OpenClaw Watchdog\n\n❌ Gateway 重启失败\n原因: ${restartResult.error}`);
      addEvent('notify_sent', 'Restart-failed notification sent via webhook');
    }
  }
}

/**
 * Starts the daemon loop. Safe to call once.
 */
export async function start() {
  if (running) {
    log('Daemon already running');
    return;
  }
  running = true;

  const cfg = getWatchdogConfig();
  state.checkInterval = cfg.checkInterval;
  log(`Watchdog daemon starting — interval ${cfg.checkInterval}s, gateway ${cfg.gatewayUrl}`);
  log(`Telegram notifications: ${cfg.notifyTelegram ? (cfg.notifyChatId ? 'enabled (chat ' + cfg.notifyChatId + ')' : 'enabled but no chatId configured') : 'disabled'}`);

  // Start log watcher
  logWatcher = watchOpencalwLogs((line, filePath) => {
    const diag = diagnose(line);
    if (!diag) return;

    const isNew = recordDiagnosis(diag);
    if (!isNew) return;

    latestDiagnosis = diag;
    const evType = diag.severity === 'error' ? 'log_error' : 'log_warn';
    const ev = addEvent(evType, diag.cause, diag.description);
    log(`[log-watcher] ${diag.severity.toUpperCase()}: ${diag.cause}`);
    notifyUpdate(ev);

    // Send Telegram/webhook alert for patterns that require user action
    if (diag.notify && canSendNotify(diag)) {
      const cfg = getWatchdogConfig();
      const accounts = pickAccounts(cfg);
      const chatId = cfg.notifyChatId;
      const webhooks = buildWebhooks(cfg);
      if (cfg.notifyTelegram && chatId && accounts.length > 0) {
        notifyLogIssue(accounts, chatId, diag, webhooks)
          .then(r => {
            if (r.ok) {
              markNotifySent(diag.id);
              addEvent('notify_sent', `Log alert sent via ${r.accountId}: ${diag.cause}`);
              log(`[log-watcher] Alert sent via ${r.accountId}: ${diag.cause}`);
            } else {
              addEvent('notify_fail', `Log alert failed: ${r.error}`);
              log(`[log-watcher] Alert failed: ${r.error}`);
              // Queue for retry when network recovers
              if (pendingAlerts.length < MAX_PENDING) {
                pendingAlerts.push({ diag, accounts, chatId, webhooks, enqueuedAt: Date.now() });
                log(`[log-watcher] Queued for retry (${pendingAlerts.length} pending): ${diag.cause}`);
              }
            }
          })
          .catch(err => log(`[log-watcher] Alert error: ${err.message}`));
      } else if (webhooks) {
        notifyLogIssue([], null, diag, webhooks)
          .then(r => {
            if (r.ok) {
              markNotifySent(diag.id);
              addEvent('notify_sent', `Log alert sent via webhook: ${diag.cause}`);
              log(`[log-watcher] Webhook alert sent: ${diag.cause}`);
            } else {
              log(`[log-watcher] Webhook alert failed: ${r.error}`);
              if (pendingAlerts.length < MAX_PENDING) {
                pendingAlerts.push({ diag, accounts: [], chatId: null, webhooks, enqueuedAt: Date.now() });
              }
            }
          })
          .catch(err => log(`[log-watcher] Webhook alert error: ${err.message}`));
      }
    }

    // Run playbook if pattern is autofixable (fire-and-forget from callback)
    if (diag.autofix && hasPlaybook(diag.id)) {
      const cfg = getWatchdogConfig();
      log(`[playbook] Running playbook for: ${diag.id}`);
      runPlaybook(diag, state, cfg.gatewayUrl).then((pbResult) => {
        if (pbResult.ran) {
          const ok = pbResult.result?.success ?? pbResult.result?.ok;
          const errorMsg = pbResult.result?.error;
          const summary = ok
            ? `Playbook '${pbResult.name}' succeeded`
            : `Playbook '${pbResult.name}' failed: ${errorMsg || '?'}`;
          const pbEv = addEvent(
            ok ? 'restart_ok' : 'restart_fail',
            summary,
            `triggered by log pattern: ${diag.id}`
          );
          log(`[playbook] ${summary}`);
          notifyUpdate(pbEv);

          // Send notification for playbook result
          const accounts = pickAccounts(cfg);
          const chatId = cfg.notifyChatId;
          const webhooks = buildWebhooks(cfg);
          if (cfg.notifyTelegram && chatId && accounts.length > 0) {
            notifyPlaybook(accounts, chatId, diag, ok, errorMsg, webhooks)
              .then(r => {
                if (r.ok) log(`[playbook] Notification sent via ${r.accountId}`);
                else log(`[playbook] Notification failed: ${r.error}`);
              })
              .catch(err => log(`[playbook] Notification error: ${err.message}`));
          } else if (webhooks) {
            notifyPlaybook([], null, diag, ok, errorMsg, webhooks)
              .catch(err => log(`[playbook] Webhook notification error: ${err.message}`));
          }
        } else {
          log(`[playbook] Skipped: ${pbResult.skipped}`);
        }
      }).catch(err => log(`[playbook] Error: ${err.message}`));
    }
  });
  log('Log watcher started');

  // Run an immediate check, then schedule
  await runCheck();
  scheduleNext();
  scheduleHeartbeat();
  scheduleChannelCheck();
  scheduleUpdateCheck();
}

function scheduleHeartbeat() {
  const cfg = getWatchdogConfig();
  const interval = cfg.heartbeatInterval || 0;
  if (!interval || interval < 60) return;

  log(`Heartbeat scheduled every ${interval}s`);
  heartbeatTimer = setTimeout(async function beat() {
    if (!running) return;
    await sendHeartbeat();
    heartbeatTimer = setTimeout(beat, interval * 1000);
  }, interval * 1000);
}

async function sendHeartbeat() {
  const cfg      = getWatchdogConfig();
  const accounts = pickAccounts(cfg);
  const chatId   = cfg.notifyChatId;
  const webhooks = buildWebhooks(cfg);

  if (!cfg.notifyTelegram && !webhooks) return;
  if (cfg.notifyTelegram && (!chatId || !accounts.length) && !webhooks) return;

  const { getStats } = await import('./store.mjs');
  const stats  = getStats();

  if (cfg.notifyTelegram && chatId && accounts.length > 0) {
    const result = await notifyHeartbeat(accounts, chatId, stats, state, webhooks);
    if (result.ok) {
      addEvent('notify_sent', `Heartbeat sent via ${result.accountId}`);
      log(`Heartbeat sent via ${result.accountId}`);
    } else {
      addEvent('notify_fail', `Heartbeat failed: ${result.error}`);
      log(`Heartbeat failed: ${result.error}`);
    }
  } else if (webhooks) {
    const { sendWebhooks } = await import('./notify.mjs');
    const total  = stats.totalChecks || 0;
    const fails  = stats.failCount   || 0;
    const upPct  = total > 0 ? ((total - fails) / total * 100).toFixed(1) : '—';
    const status = state.gatewayOk ? '✅ Gateway 正常' : '⚠️ Gateway 异常';
    await sendWebhooks(webhooks, `🐕 OpenClaw Watchdog [heartbeat]\n\n${status}\n正常率: ${upPct}%  |  检查次数: ${total}`);
    addEvent('notify_sent', 'Heartbeat sent via webhook');
    log('Heartbeat sent via webhook');
  }
}

// ── Update check ──────────────────────────────────────────────────────────

const execAsync = promisify(exec);
const UPDATE_CHECK_PATH = path.join(os.homedir(), '.openclaw', 'update-check.json');
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

function parseVersion(v) {
  return (v || '').split('.').map(Number);
}

function isNewer(available, current) {
  const [ay, am, ap] = parseVersion(available);
  const [cy, cm, cp] = parseVersion(current);
  if (ay !== cy) return ay > cy;
  if (am !== cm) return am > cm;
  return ap > cp;
}

async function getCurrentVersion() {
  try {
    const bin = fs.existsSync('/opt/homebrew/bin/openclaw') ? '/opt/homebrew/bin/openclaw' : 'openclaw';
    const { stdout } = await execAsync(`"${bin}" --version`, { timeout: 10000 });
    // Output: "OpenClaw 2026.3.12 (abc1234)" or just "2026.3.12"
    const m = stdout.match(/(\d{4}\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function getAvailableVersion() {
  try {
    const raw = fs.readFileSync(UPDATE_CHECK_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data.lastAvailableVersion || null;
  } catch {
    return null;
  }
}

async function checkForUpdate() {
  const currentVersion = state.update.currentVersion || await getCurrentVersion();
  const availableVersion = getAvailableVersion();

  state.update.currentVersion = currentVersion;
  state.update.availableVersion = availableVersion;
  state.update.checkedAt = new Date().toISOString();

  if (!currentVersion || !availableVersion) return;

  const hasUpdate = isNewer(availableVersion, currentVersion);
  state.update.hasUpdate = hasUpdate;

  if (hasUpdate) {
    const cfg = getWatchdogConfig();
    const lastNotified = cfg.lastNotifiedUpdateVersion;
    if (lastNotified === availableVersion) return; // already notified about this version

    log(`[update] New version available: ${availableVersion} (current: ${currentVersion})`);
    const ev = addEvent('update_available', `OpenClaw ${availableVersion} available`, `current: ${currentVersion}`);
    notifyUpdate(ev); // push to SSE clients

    const accounts = pickAccounts(cfg);
    const chatId = cfg.notifyChatId;
    const webhooks = buildWebhooks(cfg);
    if (cfg.notifyTelegram && chatId && accounts.length > 0) {
      notifyNewVersion(accounts, chatId, currentVersion, availableVersion, webhooks)
        .then(r => {
          if (r.ok) {
            saveWatchdogConfig({ lastNotifiedUpdateVersion: availableVersion });
            log(`[update] Notification sent via ${r.accountId}`);
          } else {
            log(`[update] Notification failed: ${r.error}`);
          }
        })
        .catch(err => log(`[update] Notification error: ${err.message}`));
    } else if (webhooks) {
      notifyNewVersion([], null, currentVersion, availableVersion, webhooks)
        .then(() => saveWatchdogConfig({ lastNotifiedUpdateVersion: availableVersion }))
        .catch(() => {});
    }
  }
}

function scheduleUpdateCheck() {
  // Run immediately on startup
  checkForUpdate().catch(err => log(`[update] Check error: ${err.message}`));

  updateCheckTimer = setTimeout(async function beat() {
    if (!running) return;
    await checkForUpdate().catch(err => log(`[update] Check error: ${err.message}`));
    updateCheckTimer = setTimeout(beat, UPDATE_CHECK_INTERVAL);
  }, UPDATE_CHECK_INTERVAL);
}

export async function triggerUpdateCheck() {
  await checkForUpdate();
  return state.update;
}

export async function runUpdate() {
  try {
    const bin = fs.existsSync('/opt/homebrew/bin/openclaw') ? '/opt/homebrew/bin/openclaw' : 'openclaw';
    const { stdout, stderr } = await execAsync(`"${bin}" update`, { timeout: 120000 });
    const output = (stdout + stderr).trim().slice(0, 1000);
    // Refresh version after update
    state.update.currentVersion = await getCurrentVersion();
    state.update.hasUpdate = false;
    return { success: true, output };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function scheduleChannelCheck() {
  const CHANNEL_CHECK_INTERVAL = 5 * 60 * 1000; // every 5 minutes

  async function doCheck() {
    if (!running) return;
    const ocConfig = getOpenclawConfig();
    const accounts = getTelegramAccounts(ocConfig);
    if (accounts.length === 0) return;

    log(`[channels] Checking ${accounts.length} Telegram bot(s)...`);
    const results = await checkAllChannels(accounts);
    const now = new Date().toISOString();

    state.channels = results.map(r => ({ ...r, checkedAt: now }));
    state.channelsCheckedAt = now;

    for (const r of results) {
      if (r.ok) {
        log(`[channels] ${r.accountId} (@${r.botName}) OK`);
      } else {
        log(`[channels] ${r.accountId} FAIL: ${r.error}`);
      }
    }

    notifyUpdate(null);
    channelTimer = setTimeout(doCheck, CHANNEL_CHECK_INTERVAL);
  }

  // First check after 30s (let gateway settle first)
  channelTimer = setTimeout(doCheck, 30000);
}

function scheduleNext() {
  if (!running) return;
  const cfg = getWatchdogConfig();
  const intervalMs = (cfg.checkInterval || 60) * 1000;
  timer = setTimeout(async () => {
    await runCheck();
    scheduleNext();
  }, intervalMs);
}

/**
 * Stops the daemon loop.
 */
export function stop() {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
  if (channelTimer) { clearTimeout(channelTimer); channelTimer = null; }
  if (updateCheckTimer) { clearTimeout(updateCheckTimer); updateCheckTimer = null; }
  if (logWatcher) { logWatcher.stop(); logWatcher = null; }
  log('Daemon stopped');
}

/**
 * Triggers an immediate health check outside the normal schedule.
 * Returns the check result.
 */
export async function triggerCheck() {
  const cfg = getWatchdogConfig();
  const result = await checkGateway(cfg.gatewayUrl);
  state.lastCheckAt = new Date().toISOString();
  state.lastLatencyMs = result.latencyMs;
  state.gatewayOk = result.ok;
  if (result.ok) {
    addEvent('check_ok', `Manual check: Gateway OK (${result.latencyMs}ms)`);
  } else {
    addEvent('check_fail', `Manual check: Gateway unreachable: ${result.error}`);
  }
  return result;
}

/**
 * Triggers an immediate restart outside the normal schedule.
 */
export async function triggerRestart() {
  const cfg = getWatchdogConfig();
  const accounts = pickAccounts(cfg);
  state.isRestarting = true;
  addEvent('restart_start', 'Manual restart triggered');
  const start = Date.now();
  const result = await restartGateway(cfg.gatewayUrl);
  const elapsed = Math.round((Date.now() - start) / 1000);
  state.isRestarting = false;
  if (result.success) {
    state.gatewayOk = true;
    state.consecutiveFails = 0;
    addEvent('restart_ok', `Manual restart succeeded in ${elapsed}s`);
  } else {
    addEvent('restart_fail', `Manual restart failed: ${result.error}`);
  }
  return { ...result, elapsedSeconds: elapsed };
}
