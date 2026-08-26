/** The player universe: search, filter, VOR, tiers, ownership. */
import {
  h, api, loading, errorBox, pct, n1, n2, posEl, statusBadge, badge, table, empty, why, $,
} from '../util.js';
import { componentBreakdown } from './warroom.js';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
let state = { pos: null, q: '', available: false };

export async function render(root) {
  const controls = h('div.row-flex.mb',
    h('div.seg', ...POSITIONS.map((p) => h('button', {
      class: (state.pos ?? 'ALL') === p ? 'on' : '',
      onclick: () => { state.pos = p === 'ALL' ? null : p; refresh(); },
    }, p))),
    h('input', {
      type: 'text', placeholder: 'search players…', value: state.q,
      oninput: (e) => { state.q = e.target.value; debounce(refresh); },
      style: { minWidth: '190px' },
    }),
    h('label.row-flex.small.mute', { style: { cursor: 'pointer' } },
      h('input', {
        type: 'checkbox', checked: state.available || undefined,
        onchange: (e) => { state.available = e.target.checked; refresh(); },
      }),
      'free agents only')
  );

  const body = h('div', loading('valuing the player pool…'));

  root.replaceChildren(
    h('div.page-head',
      h('div',
        h('h2', 'Players'),
        h('div.sub', 'Value over replacement is computed from this league\'s real starting requirements — not from a generic 12-team template.')
      )
    ),
    controls,
    body
  );

  async function refresh() {
    body.replaceChildren(loading('valuing the player pool…'));
    try {
      const params = new URLSearchParams({ limit: '150' });
      if (state.pos) params.set('pos', state.pos);
      if (state.q) params.set('q', state.q);
      if (state.available) params.set('available', '1');
      const d = await api(`/api/players?${params}`);
      body.replaceChildren(list(d));
    } catch (err) { body.replaceChildren(errorBox(err)); }
  }
  refresh();
}

let timer = null;
function debounce(fn) { clearTimeout(timer); timer = setTimeout(fn, 260); }

function list(d) {
  if (!d.players.length) return empty('◇', 'No players match', 'Try clearing the search or the position filter.');
  return h('div',
    h('div.card.tight',
      table(
        ['#', 'Player', 'Matchup', 'Owner', { label: 'Tier', num: true }, { label: 'Proj', num: true },
          { label: 'Floor', num: true }, { label: 'Ceiling', num: true }, { label: 'VOR', num: true },
          { label: 'Own%', num: true }, ''],
        d.players.map((p, i) => h('tr',
          h('td.mute.xs', i + 1),
          h('td', h('div.row-flex', posEl(p.pos),
            h('span.pname', p.name),
            h('span.xs.mute', `${p.pos}${p.posRank ?? ''}`),
            statusBadge(p.status))),
          h('td.pmeta', p.opponent === 'BYE' ? h('span.warnc', 'BYE')
            : p.opponent ? `${p.nfl_team} ${p.isHome ? 'vs' : '@'} ${p.opponent}` : (p.nfl_team ?? '—')),
          h('td.small', p.owner ? h('span.dim', p.owner) : badge('FA', 'ok')),
          h('td.num.mute', p.tier),
          h('td.num', n1(p.mean)),
          h('td.num.mute', n1(p.floor)),
          h('td.num.mute', n1(p.ceiling)),
          h('td.num', { class: p.vor > 0 ? 'good' : 'mute' }, n1(p.vor)),
          h('td.num.mute', p.pctOwned != null ? `${n1(p.pctOwned)}%` : '—'),
          h('td.right', why('why?', () => componentBreakdown(p)))
        ))
      )
    ),
    h('div.small.mute.mt-s',
      'Replacement level: ' +
      Object.entries(d.replacementLevels).map(([pos, v]) => `${pos} ${n1(v)}`).join(' · '))
  );
}
