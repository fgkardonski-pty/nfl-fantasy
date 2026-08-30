/**
 * War room shell: hash routing, league context, and the sidebar status block.
 * No framework, no build step — the whole client is ES modules served as-is.
 */
import { h, api, $, $$, badge, errorBox, loading, ago, pct, setLeague, getLeague } from './util.js';

const VIEWS = {
  warroom: () => import('./views/warroom.js'),
  waivers: () => import('./views/waivers.js'),
  stream: () => import('./views/stream.js'),
  trades: () => import('./views/trades.js'),
  intel: () => import('./views/intel.js'),
  outlook: () => import('./views/outlook.js'),
  players: () => import('./views/players.js'),
  draft: () => import('./views/draft.js'),
  data: () => import('./views/data.js'),
};

const main = $('#main');
const ctx = { league: null, week: null };

async function boot() {
  try {
    // Resolve the league BEFORE anything else fetches, so no view ever renders
    // one league's numbers under another league's name.
    const { leagues, active } = await api('/api/leagues');
    ctx.leagues = leagues ?? [];
    const remembered = getLeague();
    const valid = ctx.leagues.some((l) => l.league_key === remembered);
    setLeague(valid ? remembered : (active ?? ctx.leagues[0]?.league_key ?? null));
  } catch { /* first run: /api/league below reports it properly */ }

  try {
    ctx.league = await api('/api/league');
  } catch (err) {
    // No league yet is a first-run state, not an error — send them to setup.
    if (err.status === 404) {
      renderFirstRun(err);
      return;
    }
    main.replaceChildren(errorBox(err));
    return;
  }
  renderFoot();
  window.addEventListener('hashchange', route);
  route();
}

/**
 * League picker.
 *
 * Two leagues under one roof, sharing only the player universe — which is
 * correct, since the same athlete valued under two different rule sets is
 * exactly what the scoring layer is for. Everything else is scoped by league
 * key, and switching reloads rather than re-rendering so no view can be left
 * holding data fetched for the other league.
 */
function leaguePicker() {
  if (!ctx.leagues || ctx.leagues.length < 2) return null;
  const current = getLeague();
  const kind = (l) => (l.is_demo ? 'demo' : l.league_key.startsWith('sleeper.') ? 'sleeper' : 'yahoo');

  return h('div.league-picker',
    h('div.xs.mute', 'LEAGUE'),
    h('select.league-select', {
      onchange: (e) => { setLeague(e.target.value); location.reload(); },
    }, ctx.leagues.map((l) => h('option', {
      value: l.league_key,
      selected: l.league_key === current || null,
    }, `${l.name}  ·  ${kind(l)}`)))
  );
}

function renderFirstRun(err) {
  $('#foot').replaceChildren(h('div.mute.xs', 'no league loaded'));
  main.replaceChildren(
    h('div.page-head', h('div',
      h('h2', 'Welcome to the war room'),
      h('div.sub', 'Nothing is loaded yet. Two ways to start:'))),
    h('div.grid.c2',
      h('div.card.accent',
        h('h4', 'Try it immediately'),
        h('p.small.dim', 'Seed a synthetic 12-team league with eight weeks of history, a full transaction log and rival managers who behave like real people. Every engine becomes usable at once.'),
        h('p.xs.mute', 'The players are fictional. Demo mode exists to exercise the platform, not to model real athletes.'),
        h('button.btn.primary', { onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'seeding…';
          await api('/api/demo/seed', { method: 'POST', body: {} });
          location.hash = '#/warroom'; location.reload();
        } }, 'Seed the demo league')),
      h('div.card',
        h('h4', 'Connect your Yahoo league'),
        h('p.small.dim', 'Read your real league: scoring rules, rosters, the full transaction log, FAAB balances and matchups.'),
        h('a.btn', { href: '#/data' }, 'Set up Yahoo →'))
    )
  );
  window.addEventListener('hashchange', route);
  if (location.hash === '#/data') route();
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'warroom';
  const [name] = hash.split('?');
  const loader = VIEWS[name] ?? VIEWS.warroom;

  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));

  main.replaceChildren(loading());
  try {
    const mod = await loader();
    const wrap = h('div');
    if (ctx.league?.isDemo) {
      wrap.appendChild(h('div.demo-banner',
        h('span', '◆'),
        h('span', h('strong', 'Demo league. '),
          'Players are fictional and statistics are simulated. Connect Yahoo on the Data page to run this against your real league.')));
    }
    main.replaceChildren(wrap);
    const viewRoot = h('div');
    wrap.appendChild(viewRoot);
    await mod.render(viewRoot, ctx);
  } catch (err) {
    main.replaceChildren(errorBox(err));
    console.error(err);
  }
}

async function renderFoot() {
  const l = ctx.league;
  const foot = $('#foot');
  foot.replaceChildren(
    leaguePicker(),
    h('div.row', h('span', l.name)),
    h('div.row', h('span.mute', 'week'), h('span.mono', l.current_week)),
    h('div', { style: { marginBottom: '4px' } },
      h('div.mute', 'scoring'),
      h('div', { style: { fontSize: '10px', lineHeight: '1.35' } }, l.scoringLabel)),
    h('div.row', h('span.mute', 'teams'), h('span.mono', l.num_teams)),
    l.myTeam ? h('div.row', h('span.mute', 'you'), h('span', l.myTeam.name)) : null,
    l.synced_at ? h('div.row', h('span.mute', 'synced'), h('span', ago(l.synced_at))) : null
  );

  // Championship odds in the sidebar: the number the whole platform optimises.
  try {
    const o = await api('/api/outlook');
    // No simulation means no odds. Printing 0.0% beside "playoffs 100%" — which
    // is what an unsimulated league produced — reads as a real standing.
    if (o.ready === false) {
      foot.prepend(h('div', { style: { marginBottom: '10px' } },
        h('div.xs.mute', 'CHAMPIONSHIP ODDS'),
        h('div.mono', { style: { fontSize: '20px', fontWeight: '650' } }, '—'),
        h('div.xs.mute', 'no rosters saved')));
      return;
    }
    const mine = o.standings.find((s) => s.is_mine);
    if (mine) {
      foot.prepend(h('div', { style: { marginBottom: '10px' } },
        h('div.xs.mute', 'CHAMPIONSHIP ODDS'),
        h('div.mono', { style: { fontSize: '20px', fontWeight: '650', color: 'var(--accent)' } }, pct(mine.titleOdds)),
        h('div.xs.mute', `playoffs ${pct(mine.playoffOdds, 0)}`)
      ));
    }
  } catch { /* the sidebar is a nicety; never let it break the app */ }
}

boot();
