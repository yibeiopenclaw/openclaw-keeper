/**
 * monitor.mjs - gateway health check and restart logic
 */

import https from 'https';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Resolves the path to the openclaw binary.
 * Checks /opt/homebrew/bin/openclaw first, then falls back to `which openclaw`.
 * @returns {Promise<string>}
 */
async function findOpenclawBin() {
  const homebrew = '/opt/homebrew/bin/openclaw';
  if (fs.existsSync(homebrew)) return homebrew;
  try {
    const { stdout } = await execAsync('which openclaw');
    const p = stdout.trim();
    if (p) return p;
  } catch {
    // ignore
  }
  return 'openclaw'; // hope it's on PATH
}

/**
 * Performs an HTTPS GET to the gateway URL with a 5-second timeout.
 * Uses rejectUnauthorized: false to accept self-signed TLS certs.
 *
 * @param {string} url - e.g. "https://127.0.0.1:18789/"
 * @returns {Promise<{ ok: boolean, latencyMs: number, statusCode?: number, error?: string }>}
 */
export function checkGateway(url) {
  return new Promise((resolve) => {
    const start = Date.now();

    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname || '/',
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      const latencyMs = Date.now() - start;
      // Drain the response so the socket is released
      res.resume();
      res.on('end', () => {
        resolve({ ok: true, latencyMs, statusCode: res.statusCode });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, latencyMs: Date.now() - start, error: 'Request timed out after 5s' });
    });

    req.on('error', (err) => {
      resolve({ ok: false, latencyMs: Date.now() - start, error: err.message });
    });

    req.end();
  });
}

/**
 * Attempts to restart the openclaw gateway:
 *  1. pkill -9 -f "openclaw/dist/index.js"   (kill any existing process)
 *  2. wait 3 seconds
 *  3. openclaw gateway start                   (re-launch in background)
 *  4. wait 8 seconds
 *  5. do one health check to verify
 *
 * @param {string} gatewayUrl - URL to verify after restart
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function restartGateway(gatewayUrl) {
  try {
    // Step 1: kill existing process (ignore errors — it may not be running)
    try {
      await execAsync('pkill -9 -f "openclaw/dist/index.js"');
    } catch {
      // pkill exits non-zero when no process matches — that's fine
    }

    // Step 2: wait 3s
    await sleep(3000);

    // Step 3: start gateway
    const bin = await findOpenclawBin();
    // Run in background; don't await the process itself
    const child = exec(`"${bin}" gateway start`, { detached: true });
    if (child.stdout) child.stdout.resume();
    if (child.stderr) child.stderr.resume();
    child.unref();

    // Step 4: wait 8s
    await sleep(8000);

    // Step 5: health check
    const result = await checkGateway(gatewayUrl);
    if (result.ok) {
      return { success: true };
    } else {
      return { success: false, error: `Post-restart check failed: ${result.error}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
