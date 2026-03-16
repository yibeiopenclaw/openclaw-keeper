/**
 * diagnose.mjs - matches log lines against known error patterns
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATTERNS_PATH = path.join(__dirname, '..', 'knowledge', 'patterns.json');

function loadPatterns() {
  try {
    return JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Checks a single log line against all known patterns.
 * Returns the matching pattern with matchedLine, or null.
 *
 * @param {string} line
 * @returns {{ id, severity, cause, description, autofix, matchedLine }|null}
 */
export function diagnose(line) {
  const patterns = loadPatterns();
  for (const p of patterns) {
    try {
      const re = new RegExp(p.match, 'i');
      if (re.test(line)) {
        return { ...p, matchedLine: line };
      }
    } catch {}
  }
  return null;
}

/**
 * Checks an array of recent log lines and returns all matching diagnoses.
 * Deduplicates by pattern id (only first match per pattern).
 *
 * @param {string[]} lines
 * @returns {object[]}
 */
export function diagnoseLines(lines) {
  const seen = new Set();
  const results = [];
  for (const line of lines) {
    const match = diagnose(line);
    if (match && !seen.has(match.id)) {
      seen.add(match.id);
      results.push(match);
    }
  }
  return results;
}
