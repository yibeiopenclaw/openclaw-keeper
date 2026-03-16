/**
 * store.mjs - persistent event log at ~/.openclaw-watchdog/events.json
 *
 * Event types:
 *   check_ok | check_fail | restart_start | restart_ok | restart_fail |
 *   notify_sent | notify_fail
 *
 * Max 500 events; oldest are dropped when limit is exceeded.
 */

import fs from 'fs';
import path from 'path';
import { ensureWatchdogDir, WATCHDOG_DIR } from './config.mjs';

export const EVENTS_PATH = path.join(WATCHDOG_DIR, 'events.json');
const MAX_EVENTS = 500;

// ── Latency history (persisted to disk) ───────────────────────────────────
const LATENCY_PATH = path.join(WATCHDOG_DIR, 'latency.json');
const LATENCY_MAX  = 200;
let _latencyDirty  = false;
let _latencySaveTimer = null;

const latencyHistory = (() => {
  try {
    const raw = fs.readFileSync(LATENCY_PATH, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(-LATENCY_MAX) : [];
  } catch {
    return [];
  }
})();

function scheduleSaveLatency() {
  if (_latencyDirty || _latencySaveTimer) return;
  _latencyDirty = true;
  _latencySaveTimer = setTimeout(() => {
    try {
      ensureWatchdogDir();
      fs.writeFileSync(LATENCY_PATH, JSON.stringify(latencyHistory) + '\n', 'utf8');
    } catch {}
    _latencyDirty = false;
    _latencySaveTimer = null;
  }, 5000); // batch writes, max 1 save per 5s
}

/**
 * Records a latency data point. Pass null for failed checks.
 * @param {number|null} ms
 */
export function recordLatency(ms) {
  latencyHistory.push({ t: Date.now(), ms: ms ?? null });
  if (latencyHistory.length > LATENCY_MAX) latencyHistory.shift();
  scheduleSaveLatency();
}

/**
 * Returns the last N latency data points (oldest first).
 * @param {number} [n=60]
 * @returns {{ t: number, ms: number|null }[]}
 */
export function getLatencyHistory(n = 60) {
  return latencyHistory.slice(-n);
}

/**
 * Loads the raw events array from disk. Returns [] on any error.
 * @returns {object[]}
 */
function loadEvents() {
  try {
    const raw = fs.readFileSync(EVENTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Saves the events array to disk, truncating to MAX_EVENTS (keeps newest).
 * @param {object[]} events
 */
function saveEvents(events) {
  ensureWatchdogDir();
  const trimmed = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
  fs.writeFileSync(EVENTS_PATH, JSON.stringify(trimmed, null, 2) + '\n', 'utf8');
}

/**
 * Appends a new event to the log.
 *
 * @param {'check_ok'|'check_fail'|'restart_start'|'restart_ok'|'restart_fail'|'notify_sent'|'notify_fail'} type
 * @param {string} message - short human-readable description
 * @param {string|object} [detail] - optional extra detail
 * @returns {object} the created event
 */
export function addEvent(type, message, detail) {
  const events = loadEvents();
  const event = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    timestamp: new Date().toISOString(),
    type,
    message,
  };
  if (detail !== undefined) {
    event.detail = typeof detail === 'string' ? detail : JSON.stringify(detail);
  }
  events.push(event);
  saveEvents(events);
  return event;
}

/**
 * Returns recent events, newest first.
 * @param {number} [limit=100]
 * @returns {object[]}
 */
export function getEvents(limit = 100) {
  const events = loadEvents();
  return events.slice().reverse().slice(0, limit);
}

/**
 * Returns aggregate statistics derived from the event log.
 * @returns {{ totalChecks: number, failCount: number, lastCheck: string|null, lastFail: string|null, lastRestart: string|null, upSince: string|null }}
 */
export function getStats() {
  const events = loadEvents();

  let totalChecks = 0;
  let failCount = 0;
  let lastCheck = null;
  let lastFail = null;
  let lastRestart = null;
  let upSince = null;

  for (const ev of events) {
    if (ev.type === 'check_ok' || ev.type === 'check_fail') {
      totalChecks++;
      lastCheck = ev.timestamp;
    }
    if (ev.type === 'check_fail') {
      failCount++;
      lastFail = ev.timestamp;
    }
    if (ev.type === 'restart_ok') {
      lastRestart = ev.timestamp;
      upSince = ev.timestamp; // reset upSince on successful restart
    }
  }

  // If no restart event, upSince is the first check_ok
  if (!upSince) {
    for (const ev of events) {
      if (ev.type === 'check_ok') {
        upSince = ev.timestamp;
        break;
      }
    }
  }

  return { totalChecks, failCount, lastCheck, lastFail, lastRestart, upSince };
}

// ── Recent diagnoses (in-memory, last 20) ─────────────────────────────────
const recentDiagnoses = [];
const DIAGNOSES_MAX = 20;

/**
 * Records a diagnosis (pattern match from log watcher).
 * Deduplicates by pattern id within a 5-minute window.
 * @param {object} diag - result from diagnose()
 * @returns {boolean} true if this was a new (non-duplicate) diagnosis
 */
export function recordDiagnosis(diag) {
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const isDuplicate = recentDiagnoses.some(
    d => d.id === diag.id && d.t > fiveMinAgo
  );
  if (isDuplicate) return false;
  recentDiagnoses.unshift({ ...diag, t: Date.now() });
  if (recentDiagnoses.length > DIAGNOSES_MAX) recentDiagnoses.length = DIAGNOSES_MAX;
  return true;
}

/**
 * Returns recent diagnoses, newest first.
 * @param {number} [n=10]
 * @returns {object[]}
 */
export function getRecentDiagnoses(n = 10) {
  return recentDiagnoses.slice(0, n);
}
