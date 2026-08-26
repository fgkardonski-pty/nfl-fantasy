/**
 * Data & Yahoo: connection, sync, research jobs, and full provenance —
 * where every number in this platform came from.
 */
import {
  h, frag, api, loading, errorBox, badge, table, ago, n1, empty, stat, $,
} from '../util.js';

export async function render(root) {
  root.replaceChildren(loading('checking connections…'));
  let health; let yahoo; let research; let leagues;
  try {
    [health, yahoo, research, leagues] = await Promise.all([
      api('/api/health'), api('/api/yahoo/status'),
      api('/api/research/status'), api('/api/leagues'),
    ]);
  } catch (err) { root.replaceChildren(errorBox(err)); return; }

  root.replaceChildren(
    h('div.page-head',
      h('div',
        h('h2', 'Data & Connections'),
        h('div.sub', 'Every outbound fetch is logged. If a source is unavailable, the platform says so and degrades — it does not invent numbers.')
      )
    ),

    yahooCard(yahoo),
    leaguesCard(leagues, health),
    researchCard(research),
    provenanceCard(research)
  );
}

function yahooCard(y) {
  const body = [];
  if (!y.configured) {
    body.push(
      h('div.rec.warn',
        h('strong', 'Yahoo is not configured. '),
        'Create an app at ',
        h('a', { href: 'https://developer.yahoo.com/apps/create/', target: '_blank', rel: 'noopener' }, 'developer.yahoo.com'),
        ' with the Fantasy Sports permission, then put the client id and secret in your ', h('code', '.env'), '.'
      ),
      h('div.card.tight.mt-s',
        h('div.xs.mute', 'REDIRECT URI — paste this into the Yahoo app exactly'),
        h('code', y.redirectUri))
    );
  } else if (!y.connected) {
    body.push(
      h('div.rec.info', 'Yahoo is configured but not yet connected.'),
      h('div.row-flex',
        h('a.btn.primary', { href: '/auth/yahoo' }, 'Connect Yahoo (read only)'),
        h('a.btn', { href: '/auth/yahoo?write=1' }, 'Connect with write access')
      ),
      manualConnect()
    );
  } else {
    body.push(
      h('div.grid.c3',
        h('div', stat('Status', 'Connected', { size: 'sm', cls: 'good' })),
        h('div', stat('Scope', y.canWrite ? 'read + write' : 'read only', { size: 'sm' })),
        h('div', stat('Token', y.expired ? 'expired' : 'valid', {
          size: 'sm', cls: y.expired ? 'warn' : 'good',
          delta: y.expired ? 'refreshes automatically on next call' : `until ${new Date(Number(y.expiresAt)).toLocaleTimeString()}`,
        }))
      ),
      h('div.row-flex.mt',
        h('button.btn.primary', { onclick: (e) => syncNow(e.target) }, 'Sync league now'),
        h('button.btn', { onclick: async (e) => {
          const list = await api('/api/yahoo/leagues');
          e.target.closest('.card').appendChild(
            h('div.mt-s', h('div.xs.mute', 'YOUR YAHOO LEAGUES'),
              ...list.leagues.map((l) => h('div.small', `${l.name} — ${l.num_teams} teams, week ${l.current_week} `,
                h('code', l.league_key))))
          );
        } }, 'List my leagues'),
        h('button.btn', { onclick: async (e) => {
          await api('/api/yahoo/disconnect', { method: 'POST' });
          location.reload();
        } }, 'Disconnect')
      ),
      h('div.mt-s', h('div', { id: 'sync-out' }))
    );
  }
  return h('div.card.mb', h('h4', 'Yahoo Fantasy'), ...body);
}

/**
 * Fallback connection flow.
 *
 * Yahoo may refuse to register or redirect to a plain-HTTP localhost callback.
 * When that happens the browser still lands on a URL containing the
 * authorisation code, so pasting that address back in completes the connection
 * without the redirect ever having to work.
 */
function manualConnect() {
  const out = h('div.mt');
  const wrap = h('div.mt',
    h('details',
      h('summary', { style: { cursor: 'pointer', color: 'var(--text-dim)', fontSize: '12.5px' } },
        'The button above did not work? Connect by pasting the code instead'),
      h('div.card.tight.mt-s',
        h('p.small.dim', { style: { marginTop: 0 } },
          'Yahoo sometimes refuses plain-HTTP localhost callbacks. This path works regardless: ',
          'you approve in the browser, and paste back whatever ends up in the address bar — ',
          'even if the page itself fails to load.'),
        h('button.btn', { onclick: (e) => startManual(e.target, out) }, 'Step 1 — get the authorisation link'),
        out
      )
    )
  );
  return wrap;
}

async function startManual(btn, out) {
  btn.disabled = true;
  try {
    const { url } = await api('/api/yahoo/manual/start', { method: 'POST', body: {} });
    const input = h('input', {
      type: 'text', placeholder: 'paste the whole address bar here…',
      style: { width: '100%', marginTop: '8px' },
    });
    out.replaceChildren(
      h('div.rec.info', { style: { marginTop: '12px' } },
        h('strong', 'Step 1. '), 'Open this link, approve access, then copy your browser\'s address bar:'),
      h('div.card.tight', h('a', { href: url, target: '_blank', rel: 'noopener',
        style: { wordBreak: 'break-all', fontSize: '12px' } }, url)),
      h('div.rec.info', h('strong', 'Step 2. '), 'Paste it here — the page it lands on may show an error, that is expected.'),
      input,
      h('div.mt-s',
        h('button.btn.primary', { onclick: (e) => finishManual(e.target, input, out) }, 'Finish connection')),
      h('div.xs.mute.mt-s', 'The link is valid for 15 minutes.')
    );
  } catch (err) {
    out.replaceChildren(errorBox(err));
    btn.disabled = false;
  }
}

async function finishManual(btn, input, out) {
  btn.disabled = true;
  btn.textContent = 'connecting…';
  try {
    const res = await api('/api/yahoo/manual/finish', { method: 'POST', body: { pasted: input.value } });
    out.replaceChildren(
      h('div.rec', h('strong', 'Connected. '),
        res.leagues.length
          ? `Found ${res.leagues.length} league${res.leagues.length === 1 ? '' : 's'}.`
          : 'No NFL leagues found on this account for the current season.'),
      ...res.leagues.map((l) => h('div.small', `${l.name} — ${l.num_teams} teams, week ${l.current_week} `,
        h('code', l.league_key))),
      h('button.btn.primary.mt-s', { onclick: () => location.reload() }, 'Reload and sync')
    );
  } catch (err) {
    out.appendChild(errorBox(err));
    btn.disabled = false;
    btn.textContent = 'Finish connection';
  }
}

async function syncNow(btn) {
  btn.disabled = true;
  const out = $('#sync-out');
  out.replaceChildren(loading('syncing league from Yahoo…'));
  try {
    const report = await api('/api/yahoo/sync', { method: 'POST', body: {} });
    out.replaceChildren(
      h('div', { class: report.ok ? 'rec' : 'rec warn' },
        report.ok ? `Sync complete in ${report.ms}ms.` : `Partial sync — ${report.errors.length} stage(s) failed.`),
      h('div.card.tight.mt-s', table(['Stage', 'Result'],
        Object.entries(report.stages).map(([name, s]) => h('tr',
          h('td', name),
          h('td', s.ok ? badge('ok', 'ok') : badge(s.error ?? 'failed', 'bad'))))))
    );
  } catch (err) { out.replaceChildren(errorBox(err)); }
  btn.disabled = false;
}

function leaguesCard(leagues, health) {
  return h('div.card.mb',
    h('h4', 'Leagues'),
    leagues.leagues.length
      ? h('div.card.tight', table(
          ['League', 'Season', 'Teams', 'Week', '', ''],
          leagues.leagues.map((l) => h('tr', { class: l.league_key === leagues.active ? 'mine' : '' },
            h('td', l.name),
            h('td.num', l.season),
            h('td.num', l.num_teams),
            h('td.num', l.current_week),
            h('td', l.is_demo ? badge('DEMO', 'warn') : badge('LIVE', 'ok')),
            h('td.right', l.league_key === leagues.active
              ? badge('active', 'info')
              : h('button.btn.sm', { onclick: async () => {
                  await api('/api/leagues/active', { method: 'POST', body: { league_key: l.league_key } });
                  location.reload();
                } }, 'make active'))
          ))))
      : empty('◇', 'No leagues loaded'),
    h('div.row-flex.mt',
      h('button.btn', { onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = 'seeding…';
        await api('/api/demo/seed', { method: 'POST', body: {} });
        location.reload();
      } }, 'Seed a demo league'),
      h('span.xs.mute', 'Demo players are fictional — the demo exists to exercise the engines, not to model real athletes.')
    ),
    health?.counts ? h('div.grid.c4.mt', { style: { gap: '10px' } },
      h('div', h('div.xs.mute', 'PLAYERS'), h('div.mono', health.counts.players)),
      h('div', h('div.xs.mute', 'STAT LINES'), h('div.mono', health.counts.statLines)),
      h('div', h('div.xs.mute', 'TRANSACTIONS'), h('div.mono', health.counts.transactions)),
      h('div', h('div.xs.mute', 'GAMES'), h('div.mono', health.counts.games))
    ) : null
  );
}

function researchCard(r) {
  return h('div.card.mb',
    h('div.spread',
      h('h4', { style: { margin: 0 } }, 'Research daemon'),
      h('div.row-flex',
        badge(r.odds ? 'odds API configured' : 'no odds key', r.odds ? 'ok' : 'dim'),
        badge(r.llm ? 'LLM news scoring on' : 'LLM news scoring off', r.llm ? 'ok' : 'dim'),
        h('button.btn.sm', { onclick: async () => {
          await api('/api/research/daemon', { method: 'POST', body: { action: r.running ? 'stop' : 'start' } });
          location.reload();
        } }, r.running ? 'Stop daemon' : 'Start daemon')
      )
    ),
    h('div.small.mute.mt-s', r.running
      ? 'Running. Data refreshes on its own so the war room is already correct when you open it.'
      : 'Stopped. Jobs can still be run on demand below.'),
    h('div.card.tight.mt', table(
      ['Job', 'What it does', { label: 'Every', num: true }, 'Last run', ''],
      r.jobs.map((jb) => h('tr',
        h('td.mono.small', jb.job),
        h('td.small.mute', jb.description),
        h('td.num.mute', `${jb.everyMinutes}m`),
        h('td.small', jb.last ? (jb.last.ok ? badge(`ok ${ago(jb.last.at)}`, 'ok') : badge(jb.last.error ?? 'failed', 'bad')) : h('span.mute', '—')),
        h('td.right', h('button.btn.sm', { onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = '…';
          const res = await api('/api/research/run', { method: 'POST', body: { job: jb.job } });
          const out = res.results[0];
          e.target.replaceWith(out.ok ? badge('ok', 'ok') : badge(out.error ?? 'failed', 'bad'));
        } }, 'run'))
      ))))
  );
}

function provenanceCard(r) {
  if (!r.provenance?.length) {
    return h('div.card', h('h4', 'Provenance'),
      empty('◇', 'No outbound requests yet', 'Every external fetch is logged here with its status, latency and size.'));
  }
  return h('div.card',
    h('h4', 'Provenance — every outbound request'),
    h('div.card.tight', table(
      ['Source', 'Endpoint', { label: 'Status', num: true }, { label: 'ms', num: true }, 'When'],
      r.provenance.map((p) => h('tr',
        h('td.small', p.source),
        h('td.xs.mute', { style: { maxWidth: '420px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.endpoint),
        h('td.num', { class: p.ok ? 'good' : 'bad' }, p.status),
        h('td.num.mute', p.ms ?? '—'),
        h('td.small.mute', ago(p.fetched_at))
      ))))
  );
}
