/**
 * Opponent intelligence — a dossier per manager, and a contested-player board
 * showing who you are racing for each free agent.
 */
import {
  h, frag, api, loading, errorBox, pct, n1, n2, money, posEl, badge, table, empty, bar, ago,
} from '../util.js';

export async function render(root) {
  root.replaceChildren(loading('reading the transaction log…'));
  let d;
  try { d = await api('/api/intel'); }
  catch (err) { root.replaceChildren(errorBox(err)); return; }

  root.replaceChildren(
    h('div.page-head',
      h('div',
        h('h2', 'Opponent Intelligence'),
        h('div.sub', 'Every manager leaves a complete behavioural record in the transaction log. Archetypes are assigned relative to this league, not against fixed thresholds.')
      )
    ),

    d.contention.length ? frag(
      h('div.section-head',
        h('h3', 'Contested free agents'),
        h('span.note', 'who else is chasing the same players, and what they will bid')),
      h('div.card.tight',
        table(
          ['Player', { label: 'Pressure', num: true }, 'Competition'],
          d.contention.map((c) => h('tr',
            h('td', h('div.row-flex', posEl(c.pos), h('span.pname', c.name))),
            h('td.num', { class: c.totalPressure > 0.8 ? 'bad' : c.totalPressure > 0.4 ? 'warnc' : 'mute' },
              n2(c.totalPressure)),
            h('td', h('div.row-flex',
              ...c.rivals.slice(0, 5).map((r) => badge(`${r.manager} ${pct(r.probability, 0)}${r.bid ? ` ~${money(r.bid)}` : ''}`, 'dim'))
            ))
          ))
        )
      )
    ) : null,

    h('div.section-head', h('h3', 'Dossiers')),
    h('div.grid.c2', ...d.dossiers.map(dossier))
  );
}

const TRAITS = [
  { key: 'aggression', label: 'Waiver aggression', hint: 'how often they touch the wire' },
  { key: 'chase', label: 'Box-score chasing', hint: 'buys last week\'s points rather than the role' },
  { key: 'panic', label: 'Panic dropping', hint: 'cuts players shortly after adding them' },
  { key: 'engagement', label: 'Engagement', hint: 'how recently they did anything at all' },
  { key: 'tradeAppetite', label: 'Trade appetite', hint: 'willingness to deal' },
];

function dossier(d) {
  return h('div.card', { class: d.is_mine ? 'accent' : '' },
    h('div.spread',
      h('div',
        h('div.row-flex',
          h('span', { style: { fontWeight: '650', fontSize: '15px' } }, d.name),
          d.is_mine ? badge('YOU', 'ok') : null),
        h('div.small.mute', `${d.manager ?? 'unknown manager'} · ${d.record.wins}-${d.record.losses}${d.record.ties ? `-${d.record.ties}` : ''} · ${n1(d.record.pf)} PF`)
      ),
      h('div.right',
        badge(d.archetype.label, archetypeColour(d.archetype.key)),
        h('div.xs.mute.mt-s', `confidence ${d.archetype.confidence}`)
      )
    ),

    h('div.rec.info', { style: { margin: '10px 0' } }, d.archetype.note),

    h('div.grid.c3', { style: { gap: '10px' } },
      h('div', h('div.xs.mute', 'FAAB LEFT'), h('div.mono', money(d.faab.remaining),
        h('span.xs.mute', ` · burn ${d.faab.burnRatio}×`))),
      h('div', h('div.xs.mute', 'MOVES'), h('div.mono', `${d.counts.adds} adds · ${d.counts.trades} trades`)),
      h('div', h('div.xs.mute', 'LAST ACTIVE'),
        h('div.mono', d.daysSinceActive == null ? 'never' : `${n1(d.daysSinceActive)}d ago`))
    ),

    h('div.mt',
      ...TRAITS.map((t) => h('div', { style: { marginBottom: '6px' } },
        h('div.spread.xs',
          h('span.mute', t.label),
          h('span.mono', n2(d[t.key]))),
        bar(d[t.key], 1, d[t.key] > 0.6 ? 'warn' : '')
      ))
    ),

    !d.is_mine && d.claims?.predictions?.length ? h('div.mt',
      h('h4', `Predicted claims — ${pct(d.claims.willAct, 0)} chance he acts this week`),
      ...d.claims.predictions.map((p) => h('div', { style: { marginBottom: '7px' } },
        h('div.spread',
          h('div.row-flex', posEl(p.pos), h('span', p.name)),
          h('div.row-flex',
            h('span.mono.small', pct(p.probability, 0)),
            p.expectedBid ? badge(`~${money(p.expectedBid.amount)}`, 'dim') : null)
        ),
        h('div.xs.mute', p.why)
      ))
    ) : null,

    d.claims?.holes?.length ? h('div.mt-s',
      h('div.xs.mute', 'LINEUP HOLES THIS WEEK'),
      h('div.row-flex.mt-s', ...d.claims.holes.slice(0, 6).map((x) =>
        badge(`${x.name} (${x.reason})`, 'bad')))
    ) : null,

    d.poach?.length ? h('div.mt-s',
      h('div.xs.mute', 'BUY LOW FROM THIS MANAGER'),
      ...d.poach.map((p) => h('div.small', { style: { marginTop: '4px' } },
        h('div.row-flex', posEl(p.pos), h('span', p.name),
          badge(`${pct(p.discount, 0)} discount`, 'warn')),
        h('div.xs.mute', p.reasons.join('; '))
      ))
    ) : null
  );
}

function archetypeColour(key) {
  return { absentee: 'dim', spender: 'warn', chaser: 'purple', churner: 'bad', dealer: 'info', stander: 'dim', balanced: 'dim' }[key] ?? 'dim';
}
