/**
 * Waivers. Ranked by championship-probability added, priced in FAAB dollars,
 * with the competition you are bidding against named.
 */
import {
  h, frag, api, loading, errorBox, stat, pct, n1, n2, money, posEl,
  statusBadge, badge, table, empty, bar, why,
} from '../util.js';
import { componentBreakdown } from './warroom.js';

/** How many targets get a full card before the rest collapse into a table. */
const FEATURED = 6;

const VERDICT = {
  priority: { cls: 'ok', label: 'PRIORITY' },
  speculative: { cls: 'purple', label: 'BUY THE ROLE' },
  add: { cls: 'info', label: 'ADD' },
  stream: { cls: 'warn', label: 'STREAM' },
  pass: { cls: 'dim', label: 'PASS' },
};

export async function render(root) {
  root.replaceChildren(loading('valuing the free-agent pool…'));
  let d;
  try { d = await api('/api/waivers?limit=30'); }
  catch (err) { root.replaceChildren(errorBox(err)); return; }

  root.replaceChildren(
    h('div.page-head',
      h('div',
        h('h2', 'Waiver Wire'),
        h('div.sub', 'Ranked by change in championship probability, not by projected points. A big projection you cannot start is worth nothing.')
      )
    ),

    h('div.grid.c4.mb',
      h('div.card', stat('FAAB remaining', money(d.faabRemaining))),
      h('div.card', stat('Weeks to playoffs', d.weeksRemaining)),
      h('div.card', stat('Your playoff odds', d.playoffOdds != null ? pct(d.playoffOdds) : '—',
        { cls: d.playoffOdds >= 0.6 ? 'good' : d.playoffOdds <= 0.3 ? 'bad' : 'warn' })),
      h('div.card', stat('Drop candidate', d.drop?.name ?? '—', { size: 'sm', delta: d.drop ? `${d.drop.pos} · weakest bench spot` : 'roster is full of starters' }))
    ),

    h('div.section-head',
      h('h3', 'Act on these'),
      h('span.note', 'the bid is what the player is worth to YOU, shaded past what rivals are predicted to bid')),
    d.targets.length
      ? h('div.grid', { style: { gap: '10px' } }, ...d.targets.slice(0, FEATURED).map(targetCard))
      : empty('◇', 'No free agents improve your roster',
          'That is a good sign — your bench is already better than the wire.'),

    // Everything past the top few is reference, not a call to action. Thirty
    // full cards is a scroll, not a decision.
    d.targets.length > FEATURED ? frag(
      h('div.section-head',
        h('h3', 'Rest of the board'),
        h('span.note', 'same valuation, compact — nothing here is urgent')),
      h('div.card.tight',
        table(
          ['Player', 'Verdict', { label: 'Bid', num: true }, { label: '+/wk', num: true },
            { label: 'Title Δ', num: true }, { label: 'Breakout', num: true }, { label: 'Own%', num: true }],
          d.targets.slice(FEATURED).map((t) => h('tr',
            h('td', h('div.row-flex', posEl(t.pos), h('span.pname', t.name),
              h('span.pmeta', t.nfl_team ?? ''), statusBadge(t.status),
              t.startsImmediately ? badge('STARTS', 'ok') : null)),
            h('td', badge((VERDICT[t.verdict.level] ?? VERDICT.pass).label,
              (VERDICT[t.verdict.level] ?? VERDICT.pass).cls)),
            h('td.num', { class: t.bid.amount > 0 ? '' : 'mute' }, money(t.bid.amount)),
            h('td.num.mute', `+${n2(t.marginalWeekly)}`),
            h('td.num', { class: t.titleDelta > 0.004 ? 'good' : 'mute' }, pct(t.titleDelta, 2)),
            h('td.num', { class: t.breakout > 0.25 ? 'good' : 'mute' }, n2(t.breakout)),
            h('td.num.mute', t.pctOwned != null ? `${n1(t.pctOwned)}%` : '—')
          ))
        )
      )
    ) : null,

    d.breakouts.length ? frag(
      h('div.section-head',
        h('h3', 'Breakout signals'),
        h('span.note', 'role has changed; the market has not repriced yet')),
      h('div.card.tight',
        table(
          ['Player', 'Signal', { label: 'Score', num: true }, { label: 'Rostered', num: true }],
          d.breakouts.map((b) => h('tr',
            h('td', h('div.row-flex', posEl(b.pos), h('span.pname', b.name), h('span.pmeta', b.nfl_team ?? ''))),
            h('td.small.dim', b.signal),
            h('td.num.good', n2(b.score)),
            h('td.num.mute', `${n1(b.pctOwned ?? 0)}%`)
          ))
        )
      )
    ) : null
  );
}

function targetCard(t) {
  const v = VERDICT[t.verdict.level] ?? VERDICT.pass;
  return h('div.card', { class: t.verdict.level === 'priority' ? 'accent' : '' },
    h('div.spread',
      h('div.row-flex',
        badge(v.label, v.cls),
        posEl(t.pos),
        h('span', { style: { fontWeight: '600', fontSize: '15px' } }, t.name),
        h('span.pmeta', t.nfl_team ?? ''),
        statusBadge(t.status),
        t.startsImmediately ? badge('STARTS FOR YOU', 'ok') : null
      ),
      h('div.row-flex',
        h('div.right',
          h('div.xs.mute', 'BID'),
          h('div.mono', { style: { fontSize: '21px', fontWeight: '650', color: 'var(--accent)' } }, money(t.bid.amount))
        )
      )
    ),

    h('div.grid.c4.mt-s', { style: { gap: '10px' } },
      h('div', h('div.xs.mute', 'Lineup gain'), h('div.mono', `+${n2(t.marginalWeekly)}/wk`)),
      h('div', h('div.xs.mute', 'Title odds'), h('div.mono.good', `+${pct(t.titleDelta, 2)}`)),
      h('div', h('div.xs.mute', 'Rest of season'), h('div.mono', `+${n1(t.rosValue)} pts`)),
      h('div', h('div.xs.mute', 'Breakout'), h('div.mono', { class: t.breakout > 0.25 ? 'good' : 'mute' }, n2(t.breakout)))
    ),

    h('div.rec', { class: t.verdict.level === 'priority' ? '' : t.verdict.level === 'speculative' ? 'info' : 'warn', style: { margin: '11px 0 0' } },
      t.verdict.text),

    h('div.small.mute.mt-s', t.bid.rationale),

    t.competition?.contenders?.length ? h('div.mt-s',
      h('div.xs.mute', 'PREDICTED COMPETITION'),
      h('div.row-flex.mt-s',
        ...t.competition.contenders.map((c) => badge(`${c.team} ~${money(c.amount)}`, 'dim'))
      )
    ) : null,

    t.dropSuggestion ? h('div.xs.mute.mt-s', `Drop ${t.dropSuggestion.name} (${t.dropSuggestion.pos}) to make room.`) : null,

    h('div.mt-s', why('projection breakdown', () => componentBreakdown(t)))
  );
}
