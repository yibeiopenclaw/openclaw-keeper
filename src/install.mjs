/**
 * install.mjs - macOS LaunchAgent installer / uninstaller
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'bin', 'cli.mjs');

const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_LABEL = 'com.yibeiou.openclaw-watchdog';
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${PLIST_LABEL}.plist`);

/**
 * Finds the Node.js binary path.
 * @returns {Promise<string>}
 */
async function findNodeBin() {
  try {
    const { stdout } = await execAsync('which node');
    return stdout.trim();
  } catch {
    return process.execPath; // fall back to current node
  }
}

/**
 * Builds the launchd plist XML string.
 * @param {string} nodeBin - absolute path to node
 * @returns {string}
 */
function buildPlist(nodeBin) {
  // Inherit a reasonable PATH so openclaw can be found
  const envPath = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');

  const logDir = path.join(os.homedir(), '.openclaw-watchdog');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${CLI_PATH}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
    <key>NODE_OPTIONS</key>
    <string>--dns-result-order=ipv4first</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${logDir}/launchd-stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${logDir}/launchd-stderr.log</string>
</dict>
</plist>
`;
}

/**
 * Installs and loads the LaunchAgent.
 * @returns {Promise<void>}
 */
export async function installLaunchAgent() {
  // Ensure LaunchAgents dir exists (it always should, but be safe)
  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });

  // Ensure watchdog dir exists for log files
  const watchdogDir = path.join(os.homedir(), '.openclaw-watchdog');
  fs.mkdirSync(watchdogDir, { recursive: true });

  const nodeBin = await findNodeBin();
  const plist = buildPlist(nodeBin);

  fs.writeFileSync(PLIST_PATH, plist, 'utf8');
  console.log(`Plist written to: ${PLIST_PATH}`);

  // Unload first in case it was already loaded (ignore errors)
  try {
    await execAsync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
  } catch {
    // not loaded yet — fine
  }

  await execAsync(`launchctl load "${PLIST_PATH}"`);
  console.log(`LaunchAgent loaded: ${PLIST_LABEL}`);
  console.log('Watchdog will now start automatically at login.');
}

/**
 * Unloads and removes the LaunchAgent.
 * @returns {Promise<void>}
 */
export async function uninstallLaunchAgent() {
  if (!fs.existsSync(PLIST_PATH)) {
    console.log('LaunchAgent plist not found — nothing to uninstall.');
    return;
  }

  try {
    await execAsync(`launchctl unload "${PLIST_PATH}"`);
    console.log(`LaunchAgent unloaded: ${PLIST_LABEL}`);
  } catch (err) {
    console.warn(`Warning: could not unload LaunchAgent: ${err.message}`);
  }

  fs.unlinkSync(PLIST_PATH);
  console.log(`Plist removed: ${PLIST_PATH}`);
}

export { PLIST_PATH, PLIST_LABEL };
