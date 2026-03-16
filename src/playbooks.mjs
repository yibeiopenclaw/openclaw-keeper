/**
 * playbooks.mjs - automated fix actions triggered by log pattern diagnosis
 *
 * Each playbook maps to one or more diagnosis pattern IDs.
 * Cooldown prevents the same playbook from firing more than once per window.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execAsync = promisify(exec);

// ── Cooldown tracking ─────────────────────────────────────────────────────
// Map of playbook name → last run timestamp
const lastRun = new Map();

/**
 * Returns true if the playbook can run (cooldown has passed).
 * @param {string} name
 * @param {number} cooldownMs
 */
function canRun(name, cooldownMs) {
  const last = lastRun.get(name);
  if (!last) return true;
  return Date.now() - last > cooldownMs;
}

function markRan(name) {
  lastRun.set(name, Date.now());
}

// ── Playbook: restart gateway ─────────────────────────────────────────────
async function playbookRestart(gatewayUrl) {
  const { restartGateway } = await import('./monitor.mjs');
  return restartGateway(gatewayUrl);
}

// ── Playbook: run openclaw doctor --fix ───────────────────────────────────
async function playbookDoctor() {
  try {
    const bin = fs.existsSync('/opt/homebrew/bin/openclaw')
      ? '/opt/homebrew/bin/openclaw'
      : 'openclaw';
    const { stdout, stderr } = await execAsync(`"${bin}" doctor --fix`, { timeout: 30000 });
    return { success: true, output: (stdout + stderr).trim().slice(0, 500) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Playbook: kill process holding port ──────────────────────────────────
async function playbookKillPort(port = 18789) {
  try {
    await execAsync(`lsof -ti:${port} | xargs kill -9`, { timeout: 5000 });
    return { success: true };
  } catch {
    return { success: true }; // nothing to kill is fine
  }
}

// ── Map: diagnosis ID → playbook ─────────────────────────────────────────
const PLAYBOOK_MAP = {
  'tls-set-session':   { name: 'restart',   cooldownMs: 3 * 60 * 1000 },
  'mutex-lock':        { name: 'restart',   cooldownMs: 3 * 60 * 1000 },
  'out-of-memory':     { name: 'restart',   cooldownMs: 5 * 60 * 1000 },
  'port-in-use':       { name: 'kill-port', cooldownMs: 2 * 60 * 1000 },
  'invalid-config-key':{ name: 'doctor',    cooldownMs: 10 * 60 * 1000 },
};

/**
 * Runs the appropriate playbook for a diagnosis, if cooldown allows.
 *
 * @param {object} diag     - from diagnose()
 * @param {object} state    - daemon state (gatewayOk, isRestarting)
 * @param {string} gatewayUrl
 * @returns {Promise<{ ran: boolean, name?: string, result?: object, skipped?: string }>}
 */
export async function runPlaybook(diag, state, gatewayUrl) {
  const entry = PLAYBOOK_MAP[diag.id];
  if (!entry) return { ran: false, skipped: 'no playbook for this pattern' };

  const { name, cooldownMs } = entry;

  // Don't pile on if already restarting
  if (state.isRestarting) {
    return { ran: false, skipped: 'restart already in progress' };
  }

  // Don't run restart playbook if gateway already confirmed down —
  // the health-check loop will handle it
  if (name === 'restart' && state.gatewayOk === false) {
    return { ran: false, skipped: 'health-check loop already handling failure' };
  }

  if (!canRun(name, cooldownMs)) {
    const secsAgo = Math.round((Date.now() - lastRun.get(name)) / 1000);
    return { ran: false, skipped: `cooldown (ran ${secsAgo}s ago)` };
  }

  markRan(name);

  let result;
  switch (name) {
    case 'restart':
      result = await playbookRestart(gatewayUrl);
      break;
    case 'kill-port':
      result = await playbookKillPort(18789);
      break;
    case 'doctor':
      result = await playbookDoctor();
      break;
    default:
      return { ran: false, skipped: `unknown playbook: ${name}` };
  }

  return { ran: true, name, result };
}

/**
 * Returns whether a diagnosis ID has a mapped playbook.
 * @param {string} id
 */
export function hasPlaybook(id) {
  return id in PLAYBOOK_MAP;
}
