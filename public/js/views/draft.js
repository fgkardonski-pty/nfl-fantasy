/**
 * The draft room. VOR, VONA, tiers and survival probability, with a live board
 * you advance pick by pick.
 */
import {
  h, frag, api, loading, errorBox, pct, n1, n2, posEl, badge, table, empty, statusBadge,
} from '../util.js';

/**
 * Draft state survives a page reload.
 *
 * This lives in memory during a session, and a live draft is the one place
 * where losing it hurts: an accidental refresh partway through sixteen rounds
 * would drop every pick marked so far, and there is no way to reconstruct them
 * under a thirty-second clock. Persisted per league so two leagues do not
 * overwrite each other.
 */
const STORE_KEY = 'oracle.draft.v1';

const BLANK = { slot: 1, pick: null, rounds: 16, drafted: [], mine: [], q: '' };

function loadState(leagueKey) {
  try {
    const raw = localStorage.getItem(`${STORE_KEY}.${leagueKey}`);
    if (!raw) return { ...BLANK };
    const saved = JSON.parse(raw);
    return {
      ...BLANK,
      ...saved,
      // Never restore a stale search box; it hides most of the board on load.
      q: '',
      drafted: Array.isArray(saved.drafted) ? saved.drafted : [],
      mine: Array.isArray(saved.mine) ? saved.mine : [],
    };
  } catch { return { ...BLANK }; }
}

function saveState(leagueKey) {
  try {
    localStorage.setItem(`${STORE_KEY}.${leagueKey}`, JSON.stringify({
      slot: state.slot, pick: state.pick, rounds: state.rounds,
      drafted: state.drafted, mine: state.mine,
    }));
  } catch { /* private browsing, or storage disabled — the draft still works */ }
}

let state = { ...BLANK };
let storeKey = 'default';

let searchTimer = null;
/** Typing fires a Monte Carlo draft simulation per keystroke without this. */
function debounceSearch(fn) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(fn, 250);
}

export async function render(root) {
  const league = await api('/api/league').catch(() => null);
  const numTeams = league?.num_teams ?? 12;
  storeKey = league?.league_key ?? 'default';
  state = loadState(storeKey);
  if (state.pick == null) state.pick = state.slot;

  const controls = h('div.row-flex.mb',
    h('label.small.mute', 'Draft slot'),
    h('input', { type: 'number', min: '1', max: String(numTeams), value: String(state.slot),
      style: { width: '68px' },
      onchange: (e) => { state.slot = Number(e.target.value); state.pick = state.slot; state.drafted = []; refresh(); } }),
    h('label.small.mute', 'On the clock'),
    h('input', { type: 'number', min: '1', value: String(state.pick),
      style: { width: '78px' },
      onchange: (e) => { state.pick = Number(e.target.value); refresh(); } }),
    h('label.small.mute', 'Rounds'),
    h('input', { type: 'number', min: '1', max: '30', value: String(state.rounds),
      style: { width: '68px' },
      onchange: (e) => { state.rounds = Number(e.target.value); refresh(); } }),
    h('button.btn.sm', { onclick: () => { state.pick += 1; refresh(); } }, 'advance pick →'),
    h('input', {
      type: 'text',
      placeholder: 'find any player to mark taken…',
      value: state.q,
      title: 'Searches the ENTIRE pool, not just the board — use this when a rival takes someone outside the top 20',
      style: { minWidth: '260px' },
      oninput: (e) => { state.q = e.target.value; debounceSearch(refresh); },
    }),
    state.drafted.length
      ? h('button.btn.sm', { onclick: () => { state.drafted = []; state.mine = []; refresh(); } }, `clear ${state.drafted.length} marked`)
      : null
  );

  const body = h('div', loading('simulating the draft forward…'));

  root.replaceChildren(
    h('div.page-head',
      h('div',
        h('h2', 'Draft Room'),
        h('div.sub', 'The best pick is not the best player — it is the player whose value will be gone when you are back on the clock.')
      )
    ),
    controls,
    body
  );

  async function refresh() {
    // Every control and every mark routes through here, so this is the one
    // place a save has to happen for none to be missed.
    saveState(storeKey);
    body.replaceChildren(loading('simulating the draft forward…'));
    try {
      const params = new URLSearchParams({
        slot: String(state.slot), pick: String(state.pick),
        rounds: String(state.rounds), limit: '20', sims: '300',
      });
      if (state.drafted.length) params.set('drafted', state.drafted.join(','));
      if (state.mine.length) params.set('mine', state.mine.join(','));
      if (state.q.trim().length >= 2) params.set('q', state.q.trim());
      const d = await api(`/api/draft/board?${params}`);
      body.replaceChildren(board(d, numTeams, refresh));
    } catch (err) { body.replaceChildren(errorBox(err)); }
  }
  refresh();
}

function board(d, numTeams, refresh) {
  const top = d.board[0];
  const cov = d.adpCoverage;
  return h('div',
    cov && !cov.sufficient ? h('div.err', { style: { marginBottom: '14px' } },
      h('div', h('strong', 'No draft rankings loaded — this board is not usable yet.')),
      h('div.hint',
        `Only ${cov.ranked} of ${cov.pool} players have a draft ranking, and this league needs at least `
        + `${cov.needed} ranked to tell players apart. Without rankings every player at a position gets `
        + `the SAME value, so the ordering below is meaningless.`),
      h('div.hint', { style: { marginTop: '6px' } },
        'Fix: paste a rankings list into rankings.txt, then run ',
        h('code', 'node bin/oracle.mjs real adp --file rankings.txt'))
    ) : null,
    rosterStrip(d.myRoster),
    top ? h('div.card.accent.mb',
      h('div.spread',
        h('div',
          h('div.xs.mute', 'RECOMMENDED PICK'),
          h('div.row-flex', { style: { marginTop: '5px' } },
            posEl(top.pos),
            h('span', { style: { fontSize: '20px', fontWeight: '650' } }, top.name),
            h('span.pmeta', top.nfl_team ?? ''),
            badge(`tier ${top.tier}`, 'info'),
            statusBadge(top.status)
          )
        ),
        h('div.right',
          h('div.xs.mute', 'SCORE'),
          h('div.mono.good', { style: { fontSize: '23px', fontWeight: '650' } }, n1(top.score))
        )
      ),
      h('div.mt-s', ...top.reasons.map((r) => h('div.small.dim', `· ${r}`)))
    ) : null,

    d.matches?.length ? frag(
      h('div.section-head',
        h('h3', `Search results (${d.matches.length})`),
        h('span.note', `searched all ${d.poolSize} available players`)),
      h('div.card.tight',
        table(
          ['Player', { label: 'Tier', num: true }, { label: 'Proj', num: true },
            { label: 'VOR', num: true }, { label: 'ADP', num: true }, ''],
          d.matches.map((p) => h('tr',
            h('td', h('div.row-flex', posEl(p.pos), h('span.pname', p.name),
              h('span.xs.mute', `${p.pos}${p.posRank ?? ''}`),
              h('span.pmeta', p.nfl_team ?? ''), statusBadge(p.status))),
            h('td.num.mute', p.tier),
            h('td.num', n1(p.mean)),
            h('td.num', { class: p.vor > 0 ? 'good' : 'mute' }, n1(p.vor)),
            h('td.num.mute', p.adp != null ? n1(p.adp) : '—'),
            h('td.right', h('div.row-flex', { style: { justifyContent: 'flex-end' } },
              h('button.btn.sm.primary', {
                onclick: () => {
                  state.drafted.push(p.player_id);
                  state.mine.push(p.player_id);
                  state.pick += 1; state.q = ''; refresh();
                },
              }, 'I took'),
              h('button.btn.sm', {
                onclick: () => {
                  state.drafted.push(p.player_id);
                  state.pick += 1; state.q = ''; refresh();
                },
              }, 'opp took')
            ))
          ))
        )
      )
    ) : null,

    h('div.section-head', h('h3', 'Board'), h('span.note', 'VONA = value that disappears at this position before your next pick')),
    h('div.card.tight',
      table(
        ['#', 'Player', { label: 'Tier', num: true }, { label: 'Proj', num: true }, { label: 'VOR', num: true },
          { label: 'VONA', num: true }, { label: 'Survives', num: true }, { label: 'ADP', num: true },
          { label: 'Score', num: true }, ''],
        d.board.map((p, i) => h('tr',
          h('td.mute.xs', i + 1),
          h('td', h('div.row-flex', posEl(p.pos), h('span.pname', p.name),
            h('span.xs.mute', `${p.pos}${p.posRank}`), statusBadge(p.status))),
          h('td.num.mute', p.tier),
          h('td.num', n1(p.mean)),
          h('td.num', { class: p.vor > 0 ? 'good' : 'mute' }, n1(p.vor)),
          h('td.num', { class: p.vona > 1.5 ? 'warnc' : 'mute' }, n1(p.vona)),
          h('td.num', { class: p.survivalToNextPick < 0.3 ? 'bad' : 'mute' }, pct(p.survivalToNextPick, 0)),
          h('td.num.mute', p.adp != null ? n1(p.adp) : '—'),
          h('td.num', n1(p.score)),
          h('td.right', h('div.row-flex', { style: { justifyContent: 'flex-end' } },
            h('button.btn.sm.primary', {
              title: 'Mark this player as YOUR pick — feeds roster-need scoring for the rest of the draft',
              onclick: () => {
                state.drafted.push(p.player_id);
                state.mine.push(p.player_id);
                state.pick += 1;
                refresh();
              },
            }, 'I took'),
            h('button.btn.sm', {
              title: 'Mark this player as taken by another team',
              onclick: () => { state.drafted.push(p.player_id); state.pick += 1; refresh(); },
            }, 'opp took')
          ))
        ))
      )
    ),

    h('div.section-head', h('h3', 'Positional scarcity'), h('span.note', 'when startable hits zero, the run has already happened')),
    h('div.grid.c3',
      ...Object.entries(d.scarcity).filter(([, s]) => s.total).map(([pos, s]) => h('div.card.tight',
        h('div.spread', h('div.row-flex', posEl(pos), h('span.small.mute', `${s.total} left`)),
          h('span.mono', n1(s.best))),
        h('div.mt-s.small',
          h('div.spread', h('span.mute', 'startable'), h('span.mono', s.startable)),
          h('div.spread', h('span.mute', 'elite'), h('span.mono', { class: s.elite ? 'good' : 'mute' }, s.elite)),
          h('div.spread', h('span.mute', 'replacement'), h('span.mono', n1(d.replacementLevels[pos] ?? 0))))
      ))
    ),

    h('div.section-head', h('h3', 'Your roster needs')),
    h('div.card.tight',
      h('div.row-flex', ...Object.entries(d.need).filter(([, v]) => v > 0.05).map(([pos, v]) =>
        badge(`${pos} ${n2(v)}`, v >= 1 ? 'bad' : 'warn')))
    ),

  );
}

/**
 * What I have taken so far.
 *
 * Sits at the top of the board because it is checked constantly during a live
 * draft — after every pick, to see what the roster still needs — and anything
 * below the fold may as well not exist under a thirty-second clock. Grouped by
 * position, in the order the roster is built, so a missing starter is obvious
 * at a glance rather than something to count out.
 */
function rosterStrip(myRoster) {
  if (!myRoster?.length) return null;
  const order = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const byPos = new Map(order.map((p) => [p, []]));
  for (const p of myRoster) {
    if (!byPos.has(p.pos)) byPos.set(p.pos, []);
    byPos.get(p.pos).push(p);
  }
  return frag(
    h('div.section-head', h('h3', `Your roster so far (${myRoster.length})`)),
    h('div.card.tight.mb',
      h('div.row-flex',
        ...[...byPos.entries()]
          .filter(([, list]) => list.length)
          .map(([pos, list]) => h('div.row-flex', { style: { marginRight: '14px' } },
            posEl(pos),
            ...list.map((p) => badge(p.name, 'ok'))
          ))
      )
    )
  );
}
