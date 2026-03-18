/**
 * notify.mjs - direct Telegram API calls (bypasses openclaw gateway)
 *              + Discord / Slack webhook support
 *
 * Forces IPv4 for DNS resolution so that api.telegram.org resolves to an
 * IPv4 address even on systems that prefer IPv6.
 */

import http from 'http';
import https from 'https';
import dns from 'dns';

/**
 * Resolves a hostname to an IPv4 address.
 * @param {string} hostname
 * @returns {Promise<string>}
 */
function resolveIPv4(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { family: 4 }, (err, address) => {
      if (err) reject(err);
      else resolve(address);
    });
  });
}

/**
 * Sends a Telegram message using the Bot API.
 *
 * @param {string} token  - Telegram bot token
 * @param {string|number} chatId - target chat ID
 * @param {string} text   - message text
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendTelegram(token, chatId, text) {
  const hostname = 'api.telegram.org';
  let ip;
  try {
    ip = await resolveIPv4(hostname);
  } catch (err) {
    return { ok: false, error: `DNS resolution failed: ${err.message}` };
  }

  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  });

  return new Promise((resolve) => {
    const options = {
      hostname: ip,
      port: 443,
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        // SNI must still say the real hostname even when connecting by IP
        servername: hostname,
        Host: hostname,
      },
      rejectUnauthorized: true,
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: `Telegram API error: ${parsed.description}` });
          }
        } catch {
          resolve({ ok: false, error: `Invalid JSON response: ${data.slice(0, 200)}` });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Request timed out after 15s' });
    });

    req.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Formats a timestamp as a human-readable local time string.
 * @param {Date} [date]
 * @returns {string}
 */
function formatTime(date = new Date()) {
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Sends a "gateway down" notification.
 * Tries each account in order and stops at the first success.
 *
 * @param {{ accountId: string, token: string }[]} accounts
 * @param {string|number} chatId
 * @param {string} error - error message from the failed health check
 * @returns {Promise<{ ok: boolean, accountId?: string, error?: string }>}
 */
export async function notifyDown(accounts, chatId, error, diagnosis = null, webhooks = null) {
  const time = formatTime();
  let html =
    `🐕 <b>OpenClaw Keeper</b>\n\n` +
    `⚠️ <b>Gateway 无响应</b>\n` +
    `时间: ${time}\n`;
  let plain =
    `🐕 OpenClaw Keeper\n\n` +
    `⚠️ Gateway 无响应\n` +
    `时间: ${time}\n`;

  if (diagnosis) {
    html +=
      `\n🔍 <b>检测到的原因</b>\n` +
      `${escapeHtml(diagnosis.cause)}\n` +
      `<i>${escapeHtml(diagnosis.description)}</i>\n`;
    plain +=
      `\n🔍 检测到的原因\n` +
      `${diagnosis.cause}\n` +
      `${diagnosis.description}\n`;
  } else {
    html  += `错误: ${escapeHtml(error)}\n`;
    plain += `错误: ${error}\n`;
  }

  html  += `\n正在自动重启...\n\n⚠️ 这是 openclaw-keeper 自动推送。当前 openclaw 不可用，无法在此接收回复。`;
  plain += `\n正在自动重启...`;

  await sendWebhooks(webhooks, plain);
  return trySend(accounts, chatId, html);
}

/**
 * Sends a "gateway recovered" notification.
 *
 * @param {{ accountId: string, token: string }[]} accounts
 * @param {string|number} chatId
 * @param {number} uptimeSeconds - seconds elapsed during restart
 * @returns {Promise<{ ok: boolean, accountId?: string, error?: string }>}
 */
export async function notifyRecovered(accounts, chatId, uptimeSeconds, webhooks = null) {
  const time = formatTime();
  const html =
    `🐕 <b>OpenClaw Keeper</b>\n\n` +
    `✅ Gateway 已恢复\n` +
    `重启耗时: ${uptimeSeconds}秒\n` +
    `时间: ${time}`;
  const plain =
    `🐕 OpenClaw Keeper\n\n` +
    `✅ Gateway 已恢复\n` +
    `重启耗时: ${uptimeSeconds}秒\n` +
    `时间: ${time}`;

  await sendWebhooks(webhooks, plain);
  return trySend(accounts, chatId, html);
}

/**
 * Sends a "restart failed" notification.
 *
 * @param {{ accountId: string, token: string }[]} accounts
 * @param {string|number} chatId
 * @param {string} error
 * @returns {Promise<{ ok: boolean, accountId?: string, error?: string }>}
 */
export async function notifyRestartFailed(accounts, chatId, error, webhooks = null) {
  const time = formatTime();
  const html =
    `🐕 <b>OpenClaw Keeper</b>\n\n` +
    `❌ Gateway 重启失败\n` +
    `原因: ${escapeHtml(error)}\n` +
    `时间: ${time}\n\n` +
    `请手动检查: <code>openclaw gateway start</code>`;
  const plain =
    `🐕 OpenClaw Keeper\n\n` +
    `❌ Gateway 重启失败\n` +
    `原因: ${error}\n` +
    `时间: ${time}\n\n` +
    `请手动检查: openclaw gateway start`;

  await sendWebhooks(webhooks, plain);
  return trySend(accounts, chatId, html);
}

/**
 * Sends a periodic heartbeat status summary.
 *
 * @param {{ accountId: string, token: string }[]} accounts
 * @param {string|number} chatId
 * @param {{ totalChecks, failCount, lastFail, upSince }} stats
 * @param {{ latencyMs: number|null }} liveState
 * @returns {Promise<{ ok: boolean, accountId?: string, error?: string }>}
 */
export async function notifyHeartbeat(accounts, chatId, stats, liveState, webhooks = null) {
  const total   = stats.totalChecks || 0;
  const fails   = stats.failCount   || 0;
  const upPct   = total > 0 ? ((total - fails) / total * 100).toFixed(1) : '—';
  const upSince = stats.upSince ? formatTime(new Date(stats.upSince)) : '—';
  const time    = formatTime();

  const statusLine = liveState.gatewayOk ? `✅ Gateway 正常` : `⚠️ Gateway 异常`;

  let html =
    `🐕 <b>OpenClaw Keeper</b> [heartbeat]\n\n` +
    `${statusLine}\n` +
    `正常率: ${upPct}%  |  检查次数: ${total}\n`;
  let plain =
    `🐕 OpenClaw Keeper [heartbeat]\n\n` +
    `${statusLine}\n` +
    `正常率: ${upPct}%  |  检查次数: ${total}\n`;

  if (fails > 0) {
    const failLine = `失败次数: ${fails}` +
      (stats.lastFail ? `  |  最后失败: ${formatTime(new Date(stats.lastFail))}` : '') + '\n';
    html  += failLine;
    plain += failLine;
  }

  if (liveState.latencyMs != null) {
    html  += `延迟: ${liveState.latencyMs}ms\n`;
    plain += `延迟: ${liveState.latencyMs}ms\n`;
  }

  html  += `运行自: ${upSince}\n时间: ${time}`;
  plain += `运行自: ${upSince}\n时间: ${time}`;

  await sendWebhooks(webhooks, plain);
  return trySend(accounts, chatId, html);
}

/**
 * Tries each account in order, returns on first success.
 */
async function trySend(accounts, chatId, text) {
  let lastError = 'No accounts available';
  for (const { accountId, token } of accounts) {
    const result = await sendTelegram(token, chatId, text);
    if (result.ok) return { ok: true, accountId };
    lastError = result.error;
  }
  return { ok: false, error: lastError };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Sends a log-pattern alert notification (e.g. OAuth expired, config invalid).
 * Called by the log watcher when a pattern with notify:true is detected.
 *
 * @param {{ accountId: string, token: string }[]} accounts
 * @param {string|number} chatId
 * @param {{ id, cause, description, severity }} diag
 * @param {object|null} webhooks
 * @returns {Promise<{ ok: boolean, accountId?: string, error?: string }>}
 */
export async function notifyLogIssue(accounts, chatId, diag, webhooks = null) {
  const time = formatTime();
  const sevEmoji = diag.severity === 'error' ? '🔴' : '🟡';

  const html =
    `🐕 <b>OpenClaw Keeper</b>\n\n` +
    `${sevEmoji} <b>检测到问题：${escapeHtml(diag.cause)}</b>\n\n` +
    `${escapeHtml(diag.description)}\n\n` +
    `时间: ${time}`;

  const plain =
    `🐕 OpenClaw Keeper\n\n` +
    `${sevEmoji} 检测到问题：${diag.cause}\n\n` +
    `${diag.description}\n\n` +
    `时间: ${time}`;

  await sendWebhooks(webhooks, plain);
  return trySend(accounts, chatId, html);
}

/**
 * Sends a new OpenClaw version available notification.
 *
 * @param {{ accountId: string, token: string }[]} accounts
 * @param {string|number} chatId
 * @param {string} currentVersion
 * @param {string} newVersion
 * @param {object|null} webhooks
 */
export async function notifyNewVersion(accounts, chatId, currentVersion, newVersion, webhooks = null) {
  const time = formatTime();
  const html =
    `🐕 <b>OpenClaw Keeper</b>\n\n` +
    `🆕 <b>OpenClaw 有新版本可用</b>\n` +
    `当前版本: ${escapeHtml(currentVersion)}\n` +
    `最新版本: <b>${escapeHtml(newVersion)}</b>\n` +
    `时间: ${time}\n\n` +
    `运行更新: <code>openclaw update</code>`;
  const plain =
    `🐕 OpenClaw Keeper\n\n` +
    `🆕 OpenClaw 有新版本可用\n` +
    `当前版本: ${currentVersion}\n` +
    `最新版本: ${newVersion}\n` +
    `时间: ${time}\n\n` +
    `运行更新: openclaw update`;

  await sendWebhooks(webhooks, plain);
  return trySend(accounts, chatId, html);
}

/**
 * Sends a playbook execution result notification.
 *
 * @param {{ accountId: string, token: string }[]} accounts
 * @param {string|number} chatId
 * @param {{ id, cause, description }} diag  - the pattern that triggered it
 * @param {boolean} success
 * @param {string} [errorMsg]
 * @param {object|null} webhooks
 */
export async function notifyPlaybook(accounts, chatId, diag, success, errorMsg, webhooks = null) {
  const time = formatTime();
  const html = success
    ? `🐕 <b>OpenClaw Keeper</b>\n\n` +
      `🔧 <b>自动修复已执行</b>\n` +
      `原因: ${escapeHtml(diag.cause)}\n` +
      `结果: ✅ Gateway 重启成功\n` +
      `时间: ${time}`
    : `🐕 <b>OpenClaw Keeper</b>\n\n` +
      `🔧 <b>自动修复失败</b>\n` +
      `原因: ${escapeHtml(diag.cause)}\n` +
      `错误: ${escapeHtml(errorMsg || '未知错误')}\n` +
      `时间: ${time}\n\n` +
      `请手动检查: <code>openclaw gateway start</code>`;
  const plain = success
    ? `🐕 OpenClaw Keeper\n\n🔧 自动修复已执行\n原因: ${diag.cause}\n结果: ✅ Gateway 重启成功\n时间: ${time}`
    : `🐕 OpenClaw Keeper\n\n🔧 自动修复失败\n原因: ${diag.cause}\n错误: ${errorMsg || '未知错误'}\n时间: ${time}`;

  await sendWebhooks(webhooks, plain);
  return trySend(accounts, chatId, html);
}

// ── Webhook helpers ────────────────────────────────────────────────────────

/**
 * HTTP POST JSON to a webhook URL (Discord / Slack / generic).
 * @param {string} url
 * @param {object} body
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
function postWebhook(url, body) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch {
      return resolve({ ok: false, error: 'Invalid webhook URL' });
    }
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: 10000,
    };
    const proto = parsed.protocol === 'http:' ? http : https;
    const req = proto.request(options, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timed out' }); });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Sends to all configured webhooks (Discord + Slack).
 * @param {{ discord?: string, slack?: string }|null} webhooks
 * @param {string} text - plain text (Discord also accepts limited Markdown)
 * @returns {Promise<void>}
 */
export async function sendWebhooks(webhooks, text) {
  if (!webhooks) return;
  const tasks = [];
  if (webhooks.discord) tasks.push(postWebhook(webhooks.discord, { content: text }));
  if (webhooks.slack)   tasks.push(postWebhook(webhooks.slack,   { text }));
  await Promise.allSettled(tasks);
}
