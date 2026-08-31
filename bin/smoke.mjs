#!/usr/bin/env node
/**
 * Load every view, in every league, in a real browser; fail on any error.
 *
 * Four runtime defects in a row reached the user through `node --check`: an
 * undefined helper, a mistyped identifier, a method called on the wrong object,
 * and a null dereference. None is findable by parsing, and none was covered by
 * the unit tests, which exercise engines rather than pages.
 *
 * Starts its own server and browser so it is one command with no setup.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';

const PORT = Number(process.env.SMOKE_PORT ?? 8931);
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT ?? 9334);
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';

function findChrome() {
  const candidates = [];
  try {
    for (const dir of fs.readdirSync(BROWSERS)) {
      candidates.push(
        path.join(BROWSERS, dir, 'chrome-linux', 'headless_shell'),
        path.join(BROWSERS, dir, 'chrome-linux', 'chrome'),
      );
    }
  } catch { /* no browser directory */ }
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}

const chrome = findChrome();
if (!chrome) {
  console.error(`No Chromium found under ${BROWSERS}. Set PLAYWRIGHT_BROWSERS_PATH, or skip this check.`);
  process.exit(2);
}

const waitFor = async (url, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    try { await fetch(url); return true; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  return false;
};

const server = spawn(process.execPath, ['bin/oracle.mjs', 'serve'], {
  env: { ...process.env, ORACLE_PORT: String(PORT) }, stdio: 'ignore',
});
const browser = spawn(chrome, [
  `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--disable-gpu', '--headless',
  `--user-data-dir=${fs.mkdtempSync('/tmp/oracle-smoke-')}`, 'about:blank',
], { stdio: 'ignore' });

const stop = () => { server.kill(); browser.kill(); };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

if (!await waitFor(`http://127.0.0.1:${PORT}/api/leagues`) || !await waitFor(`http://127.0.0.1:${CDP_PORT}/json/list`)) {
  console.error('Server or browser did not come up.');
  stop(); process.exit(2);
}

const run = spawn(process.execPath, ['test/browser/smoke.mjs', `http://127.0.0.1:${CDP_PORT}`, `http://127.0.0.1:${PORT}`], { stdio: 'inherit' });
run.on('exit', (code) => { stop(); process.exit(code ?? 1); });
