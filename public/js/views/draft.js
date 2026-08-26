/**
 * The draft room. VOR, VONA, tiers and survival probability, with a live board
 * you advance pick by pick.
 */
import {
  h, api, loading, errorBox, pct, n1, n2, posEl, badge, table, empty, statusBadge,
} from '../util.js';

let state = { slot: 1, pick: null, rounds: 16, drafted: [] };

export async function render(root) {
  const league = await api('/api/league').catch(() => null);
  const numTeams = league?.num_teams ?? 12;
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
    state.drafted.length
      ? h('button.btn.sm', { onclick: () => { state.drafted = []; refresh(); } }, `clear ${state.drafted.length} marked`)
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
    body.replaceChildren(loading('simulating the draft forward…'));
    try {
      const params = new URLSearchParams({
        slot: String(state.slot), pick: String(state.pick),
        rounds: String(state.rounds), limit: '20', sims: '300',
      });
      if (state.drafted.length) params.set('drafted', state.drafted.join(','));
      const d = await api(`/api/draft/board?${params}`);
      body.replaceChildren(board(d, numTeams, refresh));
    } catch (err) { body.replaceChildren(errorBox(err)); }
  }
  refresh();
}

function board(d, numTeams, refresh) {
  const top = d.board[0];
  return h('div',
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
          h('td.right', h('button.btn.sm', {
            onclick: () => { state.drafted.push(p.player_id); state.pick += 1; refresh(); },
          }, 'taken'))
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
    )
  );
}
