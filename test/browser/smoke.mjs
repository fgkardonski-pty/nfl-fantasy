/**
 * Loads every view, in every league, in a real browser, and fails on any
 * console error, uncaught exception, or error box rendered into the page.
 *
 * Exists because four runtime defects in a row passed `node --check` and broke
 * a page on first render. The first cut of this file passed while one of those
 * bugs was still present: it only ever exercised the default league, and the
 * broken line was behind a check for a Sleeper league. A smoke test that walks
 * one path through a two-league app is worse than none, because it reports
 * confidence it has not earned.
 */
const CDP = process.argv[2];
const BASE = process.argv[3];
const VIEWS = ['warroom', 'waivers', 'stream', 'trades', 'intel', 'outlook', 'players', 'draft', 'data'];

const list = await (await fetch(`${CDP}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });

let id = 0;
const pending = new Map();
let errors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push('uncaught: ' + (d.exception?.description ?? d.text));
  }
};
const send = (method, params = {}) => new Promise((res) => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
// Modules are cached aggressively, and a smoke test that validates a stale
// copy of the code is worse than none.
await send('Network.setCacheDisabled', { cacheDisabled: true });

await send('Page.navigate', { url: `${BASE}/#/warroom` });
await new Promise((r) => setTimeout(r, 1200));
// Fetched from Node rather than inside the page: Runtime.evaluate with
// awaitPromise needs the expression itself to BE a promise, and a bare await
// at the top of an expression is a syntax error there.
const leagues = (await (await fetch(`${BASE}/api/leagues`)).json()).leagues.map((l) => l.league_key);
if (!leagues?.length) { console.log('no leagues to test'); process.exit(1); }

let failed = 0;
for (const league of leagues) {
  console.log(`\n--- ${league} ---`);
  for (const view of VIEWS) {
    errors = [];
    // Set the league, then do a FULL navigation. Setting the hash first would
    // start a render against the previous league and then abort it mid-flight
    // on reload, which produces failures belonging to the test rather than to
    // the app.
    await ev(`localStorage.setItem('oracle.league', ${JSON.stringify(league)})`);
    await send('Page.navigate', { url: `${BASE}/#/${view}` });
    await send('Page.reload', { ignoreCache: true });

    // Poll rather than wait a fixed time. Some views run tens of thousands of
    // Monte Carlo iterations, and a timeout short enough to be quick for the
    // rest reports those as broken — a false alarm that trains you to ignore
    // the output, which is how a real failure gets waved through.
    let stillLoading = true;
    for (let i = 0; i < 40 && stillLoading; i++) {
      await new Promise((r) => setTimeout(r, 250));
      stillLoading = await ev("!!document.querySelector('#main .loading')");
      if (errors.length) break;                       // already failed; stop waiting
    }

    const shown = await ev("document.querySelector('#main .err')?.textContent ?? ''");
    const rendered = await ev("(document.querySelector('#main')?.textContent ?? '').trim().length");
    const problems = [...errors];
    if (shown) problems.push(`in-page: ${shown.trim().slice(0, 100)}`);
    if (!rendered) problems.push('rendered nothing');
    if (stillLoading) problems.push('stuck on the loading state');

    if (problems.length) failed++;
    console.log(`  ${problems.length ? 'FAIL' : 'ok  '} ${view}`);
    for (const p of problems.slice(0, 2)) console.log(`         ${p.split('\n')[0].slice(0, 130)}`);
  }
}
ws.close();
console.log(failed ? `\n${failed} view/league combination(s) broken` : '\nevery view rendered clean in every league');
process.exit(failed ? 1 : 0);
