/**
 * log-watcher.mjs - tails openclaw gateway log files and emits new lines
 *
 * Starts watching from end-of-file so old history is not replayed.
 * Handles file rotation (truncation or deletion).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_LOG_PATHS = [
  path.join(os.homedir(), '.openclaw', 'logs', 'gateway.err.log'),
  path.join(os.homedir(), '.openclaw', 'logs', 'gateway.log'),
];

/**
 * Watches a single file for new lines.
 *
 * @param {string}   filePath   - file to watch
 * @param {Function} onLine     - called with each new line string
 * @param {Function} [onError]  - called on read errors
 * @returns {{ stop: Function }}
 */
export function watchFile(filePath, onLine, onError) {
  let position = 0;
  let watcher = null;
  let pollTimer = null;

  // Initialise position to end of file (skip old content)
  try {
    const stat = fs.statSync(filePath);
    position = stat.size;
  } catch {
    // File doesn't exist yet — start at 0 and wait for it to appear
  }

  function readNew() {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size < position) {
        // File was truncated or rotated — reset
        position = 0;
      }
      if (stat.size === position) return;

      const toRead = stat.size - position;
      const buf = Buffer.alloc(toRead);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, toRead, position);
      fs.closeSync(fd);
      position = stat.size;

      const chunk = buf.toString('utf8');
      const lines = chunk.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    } catch (err) {
      if (onError) onError(err);
    }
  }

  function startWatcher() {
    try {
      watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
        if (eventType === 'change') readNew();
      });
      watcher.on('error', () => {
        // Watcher died (file deleted?), restart with a poll interval
        scheduleRewatchPoll();
      });
    } catch {
      // File doesn't exist yet, poll for it
      scheduleRewatchPoll();
    }
  }

  function scheduleRewatchPoll() {
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      position = 0;
      startWatcher();
    }, 5000);
  }

  startWatcher();

  return {
    stop() {
      if (watcher) { try { watcher.close(); } catch {} watcher = null; }
      clearTimeout(pollTimer);
    },
  };
}

/**
 * Watches all default openclaw log files.
 *
 * @param {Function} onLine   - called with (line: string, filePath: string)
 * @param {string[]} [paths]  - override default log paths
 * @returns {{ stop: Function }}
 */
export function watchOpencalwLogs(onLine, paths) {
  const targets = paths || DEFAULT_LOG_PATHS;
  const watchers = targets.map(p =>
    watchFile(p, (line) => onLine(line, p), () => {})
  );
  return {
    stop() { watchers.forEach(w => w.stop()); },
  };
}

export { DEFAULT_LOG_PATHS };
