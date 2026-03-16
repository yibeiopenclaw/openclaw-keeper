/**
 * config.mjs - reads openclaw config and local watchdog config
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const WATCHDOG_DIR = path.join(os.homedir(), '.openclaw-watchdog');
const WATCHDOG_CONFIG_PATH = path.join(WATCHDOG_DIR, 'config.json');

const DEFAULT_WATCHDOG_CONFIG = {
  gatewayUrl: 'https://127.0.0.1:18789/',
  checkInterval: 60,
  webPort: 19877,
  notifyTelegram: true,
  notifyChatId: null,
  heartbeatInterval: 0,      // seconds; 0 = disabled. e.g. 1800 = every 30 min
  discordWebhookUrl: null,   // optional Discord webhook URL
  slackWebhookUrl: null,     // optional Slack webhook URL
};

/**
 * Ensures the watchdog data directory exists.
 */
export function ensureWatchdogDir() {
  if (!fs.existsSync(WATCHDOG_DIR)) {
    fs.mkdirSync(WATCHDOG_DIR, { recursive: true });
  }
}

/**
 * Reads ~/.openclaw/openclaw.json and returns parsed JSON, or null on failure.
 */
export function getOpenclawConfig() {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extracts an array of { accountId, token } from the openclaw config.
 * Skips accounts where botToken is missing or empty.
 *
 * @param {object|null} config - result of getOpenclawConfig()
 * @returns {{ accountId: string, token: string }[]}
 */
export function getTelegramAccounts(config) {
  if (!config) return [];
  const accounts = config?.channels?.telegram?.accounts;
  if (!accounts || typeof accounts !== 'object') return [];

  const result = [];
  for (const [accountId, acc] of Object.entries(accounts)) {
    const token = acc?.botToken;
    if (token && typeof token === 'string' && token.trim().length > 0) {
      result.push({ accountId, token: token.trim() });
    }
  }
  return result;
}

/**
 * Reads ~/.openclaw-watchdog/config.json and returns merged config with defaults.
 * @returns {object}
 */
export function getWatchdogConfig() {
  ensureWatchdogDir();
  try {
    const raw = fs.readFileSync(WATCHDOG_CONFIG_PATH, 'utf8');
    const saved = JSON.parse(raw);
    return { ...DEFAULT_WATCHDOG_CONFIG, ...saved };
  } catch {
    return { ...DEFAULT_WATCHDOG_CONFIG };
  }
}

/**
 * Saves watchdog config to disk.
 * @param {object} cfg
 */
export function saveWatchdogConfig(cfg) {
  ensureWatchdogDir();
  const merged = { ...getWatchdogConfig(), ...cfg };
  fs.writeFileSync(WATCHDOG_CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

export { WATCHDOG_DIR, WATCHDOG_CONFIG_PATH, OPENCLAW_CONFIG_PATH };
