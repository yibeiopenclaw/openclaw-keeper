/**
 * Unit tests for diagnose.mjs and patterns.json
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, diagnoseLines } from '../src/diagnose.mjs';

// ── pattern matching ─────────────────────────────────────────────────────────

describe('pattern: tls-set-session', () => {
  it('matches setSession null error', () => {
    const r = diagnose('Cannot read properties of null (reading "setSession")');
    assert.equal(r?.id, 'tls-set-session');
  });
  it('does not match unrelated null error', () => {
    assert.equal(diagnose('Cannot read properties of null (reading "foo")'), null);
  });
});

describe('pattern: mutex-lock', () => {
  it('matches mutex lock failed', () => {
    assert.equal(diagnose('mutex lock failed: resource busy')?.id, 'mutex-lock');
  });
  it('matches pthread_mutex', () => {
    assert.equal(diagnose('pthread_mutex_lock failed')?.id, 'mutex-lock');
  });
});

describe('pattern: port-in-use', () => {
  it('matches EADDRINUSE on port 18789', () => {
    assert.equal(diagnose('Error: EADDRINUSE: address already in use :::18789')?.id, 'port-in-use');
  });
  it('does not match a different port', () => {
    assert.equal(diagnose('Error: EADDRINUSE: address already in use :::3000'), null);
  });
});

describe('pattern: out-of-memory', () => {
  it('matches heap OOM', () => {
    assert.equal(diagnose('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory')?.id, 'out-of-memory');
  });
  it('matches ENOMEM', () => {
    assert.equal(diagnose('spawn ENOMEM')?.id, 'out-of-memory');
  });
});

describe('pattern: token-invalid', () => {
  it('matches 401 Unauthorized', () => {
    assert.equal(diagnose('channel exited with error: 401: Unauthorized')?.id, 'token-invalid');
  });
  it('matches getMe 404', () => {
    assert.equal(diagnose('[telegram] getMe returned 404')?.id, 'token-invalid');
  });
});

describe('pattern: telegram-rate-limit', () => {
  it('matches 429 Too Many Requests', () => {
    assert.equal(diagnose('429: Too Many Requests')?.id, 'telegram-rate-limit');
  });
  it('matches retry after N', () => {
    assert.equal(diagnose('retry after 30 seconds')?.id, 'telegram-rate-limit');
  });
});

describe('pattern: telegram-polling-stall', () => {
  it('matches stall detected log', () => {
    const line = '[telegram] Polling stall detected (no getUpdates for 1009s); forcing restart.';
    assert.equal(diagnose(line)?.id, 'telegram-polling-stall');
  });
  it('matches runner stop timed out log', () => {
    const line = '[telegram] Polling runner stop timed out after 15s; forcing restart cycle.';
    assert.equal(diagnose(line)?.id, 'telegram-polling-stall');
  });
  it('does not match unrelated polling log', () => {
    assert.equal(diagnose('[telegram] Polling started successfully'), null);
  });
  it('autofix is true', () => {
    const r = diagnose('[telegram] Polling stall detected (no getUpdates for 244s); forcing restart.');
    assert.equal(r?.autofix, true);
  });
});

describe('pattern: context-window', () => {
  it('matches context window too small', () => {
    assert.equal(diagnose('context window too small for this operation')?.id, 'context-window');
  });
  it('matches contextWindow 16000', () => {
    assert.equal(diagnose('blocked model: contextWindow 16000 is too small')?.id, 'context-window');
  });
});

describe('pattern: all-models-failed', () => {
  it('matches All models failed with count', () => {
    assert.equal(diagnose('All models failed (3)')?.id, 'all-models-failed');
  });
});

describe('pattern: oauth-token-refresh', () => {
  it('matches OAuth token refresh failed', () => {
    assert.equal(diagnose('OAuth token refresh failed for openai-codex')?.id, 'oauth-token-refresh');
  });
});

describe('pattern: telegram-502', () => {
  it('matches 502 Bad Gateway', () => {
    assert.equal(diagnose('sendMessage failed: 502: Bad Gateway')?.id, 'telegram-502');
  });
});

// ── diagnose() return shape ──────────────────────────────────────────────────

describe('diagnose() return value', () => {
  it('returns null for unrecognized line', () => {
    assert.equal(diagnose('everything is fine'), null);
  });
  it('includes matchedLine in result', () => {
    const line = 'spawn ENOMEM';
    const r = diagnose(line);
    assert.equal(r?.matchedLine, line);
  });
  it('includes id, severity, autofix, notify fields', () => {
    const r = diagnose('spawn ENOMEM');
    assert.ok(r?.id);
    assert.ok(r?.severity);
    assert.equal(typeof r?.autofix, 'boolean');
    assert.equal(typeof r?.notify, 'boolean');
  });
  it('is case-insensitive', () => {
    assert.equal(diagnose('MUTEX LOCK FAILED')?.id, 'mutex-lock');
  });
});

// ── diagnoseLines() ──────────────────────────────────────────────────────────

describe('diagnoseLines()', () => {
  it('returns empty array for no matches', () => {
    assert.deepEqual(diagnoseLines(['all good', 'nothing to see here']), []);
  });
  it('returns one match per pattern (deduplication)', () => {
    const lines = [
      'spawn ENOMEM',
      'JavaScript heap out of memory',  // same pattern id: out-of-memory
    ];
    const results = diagnoseLines(lines);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'out-of-memory');
  });
  it('returns multiple matches for different patterns', () => {
    const lines = [
      'spawn ENOMEM',
      '429: Too Many Requests',
    ];
    const results = diagnoseLines(lines);
    assert.equal(results.length, 2);
    const ids = results.map(r => r.id);
    assert.ok(ids.includes('out-of-memory'));
    assert.ok(ids.includes('telegram-rate-limit'));
  });
});
