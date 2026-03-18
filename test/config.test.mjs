/**
 * Unit tests for config.mjs helpers
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getTelegramAccounts } from '../src/config.mjs';

// ── getTelegramAccounts() ────────────────────────────────────────────────────

describe('getTelegramAccounts()', () => {
  it('returns empty array for null config', () => {
    assert.deepEqual(getTelegramAccounts(null), []);
  });

  it('returns empty array when channels.telegram is missing', () => {
    assert.deepEqual(getTelegramAccounts({}), []);
    assert.deepEqual(getTelegramAccounts({ channels: {} }), []);
    assert.deepEqual(getTelegramAccounts({ channels: { telegram: {} } }), []);
  });

  it('returns accounts with valid botToken', () => {
    const config = {
      channels: {
        telegram: {
          accounts: {
            mybot: { botToken: '123:ABC' },
          },
        },
      },
    };
    const result = getTelegramAccounts(config);
    assert.equal(result.length, 1);
    assert.equal(result[0].accountId, 'mybot');
    assert.equal(result[0].token, '123:ABC');
  });

  it('skips accounts with empty or missing botToken', () => {
    const config = {
      channels: {
        telegram: {
          accounts: {
            good: { botToken: '123:ABC' },
            empty: { botToken: '' },
            missing: {},
            whitespace: { botToken: '   ' },
          },
        },
      },
    };
    const result = getTelegramAccounts(config);
    assert.equal(result.length, 1);
    assert.equal(result[0].accountId, 'good');
  });

  it('trims whitespace from botToken', () => {
    const config = {
      channels: {
        telegram: {
          accounts: {
            bot: { botToken: '  123:ABC  ' },
          },
        },
      },
    };
    const result = getTelegramAccounts(config);
    assert.equal(result[0].token, '123:ABC');
  });

  it('returns multiple accounts', () => {
    const config = {
      channels: {
        telegram: {
          accounts: {
            bot1: { botToken: '111:AAA' },
            bot2: { botToken: '222:BBB' },
          },
        },
      },
    };
    const result = getTelegramAccounts(config);
    assert.equal(result.length, 2);
  });

  it('handles non-object accounts value gracefully', () => {
    assert.deepEqual(getTelegramAccounts({ channels: { telegram: { accounts: null } } }), []);
    assert.deepEqual(getTelegramAccounts({ channels: { telegram: { accounts: 'bad' } } }), []);
  });
});
