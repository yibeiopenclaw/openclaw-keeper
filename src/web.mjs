/**
 * web.mjs - HTTP dashboard server
 *
 * Routes:
 *   GET  /             → serve ui/index.html
 *   GET  /api/status   → { gatewayOk, lastCheck, stats, recentEvents[10] }
 *   GET  /api/events   → all events newest-first (max 100)
 *   POST /api/check    → trigger manual health check
 *   POST /api/restart  → trigger manual restart
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getStats, getEvents, getLatencyHistory, getRecentDiagnoses } from './store.mjs';
import { state, onUpdate } from './daemon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = path.join(__dirname, '..', 'ui', 'index.html');

let server = null;

// ── SSE client registry ───────────────────────────────────────────────────
const sseClients = new Set();

// Push daemon updates to all connected SSE clients
onUpdate((payload) => {
  if (sseClients.size === 0) return;
  const msg = `data: ${JSON.stringify({ type: 'update', payload })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
});

// Keep SSE connections alive every 25s (proxies drop idle connections at 30s)
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
  }
}, 25000);

/**
 * Starts the web dashboard server on the given port.
 * @param {number} port
 * @param {{ triggerCheck: Function, triggerRestart: Function }} daemonControls
 * @returns {Promise<void>}
 */
// Import update controls lazily to avoid circular dep at module load
async function getUpdateControls() {
  const { triggerUpdateCheck, runUpdate } = await import('./daemon.mjs');
  return { triggerUpdateCheck, runUpdate };
}

export function startWebServer(port, daemonControls) {
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      try {
        await handleRequest(req, res, daemonControls);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[web] Dashboard available at http://localhost:${port}`);
      resolve();
    });

    server.on('error', reject);
  });
}

/**
 * Stops the web server.
 * @returns {Promise<void>}
 */
export function stopWebServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

async function handleRequest(req, res, controls) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // ── Static UI ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/') {
    try {
      const html = fs.readFileSync(UI_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Dashboard UI not found');
    }
    return;
  }

  // ── API: status ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/status') {
    const stats = getStats();
    const recentEvents = getEvents(10);
    sendJson(res, 200, {
      gatewayOk: state.gatewayOk,
      lastCheck: state.lastCheckAt,
      latencyMs: state.lastLatencyMs,
      isRestarting: state.isRestarting,
      checkInterval: state.checkInterval,
      channels: state.channels,
      channelsCheckedAt: state.channelsCheckedAt,
      update: state.update,
      stats,
      recentEvents,
    });
    return;
  }

  // ── API: channels ────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/channels') {
    sendJson(res, 200, {
      channels: state.channels,
      checkedAt: state.channelsCheckedAt,
    });
    return;
  }

  // ── API: events ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/events') {
    sendJson(res, 200, getEvents(100));
    return;
  }

  // ── API: latency history ─────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/latency') {
    sendJson(res, 200, getLatencyHistory(60));
    return;
  }

  // ── API: recent diagnoses ────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/diagnoses') {
    sendJson(res, 200, getRecentDiagnoses(10));
    return;
  }

  // ── API: SSE stream ──────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    // Send current state immediately so the client syncs on connect
    const initial = {
      type: 'update',
      payload: {
        ...state,
        latestEvent: null,
        stats: getStats(),
      },
    };
    res.write(`data: ${JSON.stringify(initial)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── API: manual check ───────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/check') {
    if (!controls?.triggerCheck) {
      sendJson(res, 503, { error: 'Daemon not attached' });
      return;
    }
    const result = await controls.triggerCheck();
    sendJson(res, 200, result);
    return;
  }

  // ── API: update status ───────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/update') {
    sendJson(res, 200, state.update);
    return;
  }

  // ── API: check for update ────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/update/check') {
    const { triggerUpdateCheck } = await getUpdateControls();
    const result = await triggerUpdateCheck();
    sendJson(res, 200, result);
    return;
  }

  // ── API: run openclaw update ─────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/update/run') {
    const { runUpdate } = await getUpdateControls();
    const result = await runUpdate();
    sendJson(res, 200, result);
    return;
  }

  // ── API: manual restart ─────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/restart') {
    if (!controls?.triggerRestart) {
      sendJson(res, 503, { error: 'Daemon not attached' });
      return;
    }
    const result = await controls.triggerRestart();
    sendJson(res, 200, result);
    return;
  }

  // ── 404 ─────────────────────────────────────────────────────────────────
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}
