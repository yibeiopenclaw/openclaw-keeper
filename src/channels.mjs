/**
 * channels.mjs - checks connectivity of configured notification channels
 *
 * Currently supports Telegram. Calls the Bot API directly (IPv4-forced),
 * independent of the openclaw gateway process.
 */

import https from 'https';
import dns from 'dns';

const TG_HOSTNAME = 'api.telegram.org';

function resolveIPv4(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { family: 4 }, (err, addr) => {
      if (err) reject(err); else resolve(addr);
    });
  });
}

/**
 * Checks a single Telegram bot token via getMe.
 *
 * @param {string} token
 * @param {string} accountId - for labelling
 * @returns {Promise<{ accountId, ok, botName?, error? }>}
 */
export async function checkTelegramBot(token, accountId) {
  let ip;
  try {
    ip = await resolveIPv4(TG_HOSTNAME);
  } catch (err) {
    return { accountId, ok: false, error: `DNS failed: ${err.message}` };
  }

  return new Promise((resolve) => {
    const options = {
      hostname: ip,
      port: 443,
      path: `/bot${token}/getMe`,
      method: 'GET',
      headers: { Host: TG_HOSTNAME, servername: TG_HOSTNAME },
      rejectUnauthorized: true,
      timeout: 8000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok && parsed.result?.is_bot) {
            resolve({
              accountId,
              ok: true,
              botName: parsed.result.username,
              firstName: parsed.result.first_name,
            });
          } else {
            resolve({
              accountId,
              ok: false,
              error: parsed.description || `API error (${res.statusCode})`,
            });
          }
        } catch {
          resolve({ accountId, ok: false, error: 'Invalid API response' });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ accountId, ok: false, error: 'Timed out after 8s' });
    });

    req.on('error', (err) => {
      resolve({ accountId, ok: false, error: err.message });
    });

    req.end();
  });
}

/**
 * Checks all Telegram accounts from openclaw config.
 *
 * @param {{ accountId: string, token: string }[]} accounts
 * @returns {Promise<{ accountId, ok, botName?, error? }[]>}
 */
export async function checkAllChannels(accounts) {
  if (!accounts || accounts.length === 0) return [];
  return Promise.all(
    accounts.map(({ accountId, token }) => checkTelegramBot(token, accountId))
  );
}
