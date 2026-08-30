/**
 * The War Room.
 *
 * The one screen you open on Sunday morning. It answers, in order:
 * am I winning this week, what should I start, and what is the case for each
 * decision the platform is making on my behalf.
 */
import {
  h, frag, api, loading, errorBox, stat, dial, pct, n1, signed,
  posEl, statusBadge, badge, rangeBar, why, table, empty,
} from '../util.js';

export async function render(root, ctx) {
  root.replaceChildren(loading('simulating the week…'));
  let data;
  try {
    data = await api(`/api/warroom${ctx.week ? `?week=${ctx.week}` : ''}`);
  } catch (err) { root.replaceChildren(errorBox(err)); return; }

  if (data.ready === false) return root.replaceChildren(notReady(data));

  const { decision, sim, posture, me, opponent, week } = data;
  const rec = decision.recommended;

  root.replaceChildren(
    h('div.page-head',
      h('div',
        h('h2', `Week ${week} — ${me.name}`),
        h('div.sub', opponent
          ? `vs ${opponent.name}${opponent.manager ? ` · ${opponent.manager}` : ''}`
          : 'No opponent scheduled this week')
      ),
      h('div.row-flex',
        // An opponent the schedule generator invented must never look like one
        // Yahoo published — every number on this page is conditioned on it.
        data.opponentSource === 'estimated'
          ? badge('OPPONENT ESTIMATED', 'warn')
          : null,
        badge(`${sim.sims.toLocaleString()} simulations`, 'dim'),
        badge(posture.stance.toUpperCase(), posture.stance === 'favourite' ? 'ok' : posture.stance === 'underdog' ? 'bad' : 'warn')
      )
    ),

    h('div.grid.hero',
      h('div.card.accent',
        h('div.winprob',
          dial(sim.winProb),
          h('div', { style: { flex: '1', minWidth: '0' } },
            h('div.grid.c2', { style: { gap: '12px' } },
              stat('Your projection', n1(sim.myMean), { size: 'sm', delta: `σ ${n1(sim.mySd)} · ${n1(sim.myFloor)} – ${n1(sim.myCeiling)}` }),
              stat('Their projection', n1(sim.oppMean), { size: 'sm', delta: `σ ${n1(sim.oppSd)} · ${n1(sim.oppFloor)} – ${n1(sim.oppCeiling)}` })
            ),
            h('div.mt.small.mute',
              `Expected margin ${signed(sim.margin)} · 80% of outcomes land between ${signed(sim.marginP10)} and ${signed(sim.marginP90)}`)
          )
        ),
        histogram(sim.histogram),
        h('div.rec', { class: posture.stance === 'underdog' ? 'warn' : '' },
          h('strong', posture.stance === 'favourite' ? 'You are favoured. '
            : posture.stance === 'underdog' ? 'You are the underdog. '
            : 'This is a coin flip. '),
          posture.advice
        )
      ),

      h('div.card',
        h('h4', 'The call'),
        h('div.rec', { class: decision.disagreement ? 'info' : '' }, decision.explanation),
        decision.disagreement
          ? h('div.small.mute.mt-s',
              'Projected points would have chosen a different lineup. Win probability is the objective that matters, so the platform overrode it.')
          : null,
        decision.stacks.length
          ? h('div.mt',
              h('h4', 'Correlation exposure'),
              ...decision.stacks.slice(0, 4).map((s) => h('div.spread.small',
                h('span', `${s.a} ~ ${s.b}`),
                h('span', { class: s.corr > 0 ? 'good mono' : 'bad mono' }, `${signed(s.corr, 2)} ${s.kind}`)
              )),
              h('div.xs.mute.mt-s', 'Positive correlation widens both your floor and your ceiling — leverage when behind, risk when ahead.')
            )
          : null
      )
    ),

    h('div.section-head',
      h('h3', 'Recommended lineup'),
      h('span.note', 'floor and ceiling are the 10th and 90th percentiles of each simulated distribution')),
    lineupTable(rec.lineup),

    h('div.section-head',
      h('h3', 'Alternatives considered'),
      h('span.note', "each lineup re-simulated against your opponent's actual starters")),
    alternatives(decision, rec),

    h('div.section-head', h('h3', 'Bench')),
    partialRosterWarning(data.completeness),

    benchTable(data.roster, rec.lineup),

    opponent ? frag(
      h('div.section-head',
        h('h3', `${opponent.name} — projected lineup`),
        h('span.note', data.opponentSource === 'estimated'
          ? 'ESTIMATED opponent — Yahoo\u2019s week has not been entered, so this pairing is a guess from a division-aware round robin'
          : 'their optimal lineup, which is what we simulate against')),
      lineupTable(data.oppLineup, { compact: true })
    ) : null
  );
}

function histogram(hg) {
  if (!hg) return null;
  const max = Math.max(...hg.mine, ...hg.opp) || 1;
  return h('div.mt',
    h('div.hist',
      ...hg.mine.map((v, i) => h('div.col',
        h('div.me', { style: { height: `${(v / max) * 100}%` } }),
        h('div.opp', { style: { height: `${(hg.opp[i] / max) * 100}%` } })
      ))
    ),
    h('div.hist-legend',
      h('span', h('i', { style: { background: 'rgba(77,212,172,.62)' } }), 'you'),
      h('span', h('i', { style: { background: 'rgba(255,107,107,.42)' } }), 'opponent'),
      h('span.mute', `${n1(hg.lo)} – ${n1(hg.hi)} points`)
    )
  );
}

function slotClass(label) {
  if (label === 'FLEX') return 'slot-badge flex';
  if (label === 'SUPERFLEX') return 'slot-badge sflex';
  return 'slot-badge';
}

function lineupTable(lineup, { compact = false } = {}) {
  if (!lineup?.length) return empty('◇', 'No lineup available');
  const scaleMax = Math.max(...lineup.map((l) => l.player?.ceiling ?? 0), 1);
  return h('div.card.tight',
    ...lineup.map((s) => {
      const p = s.player;
      if (!p) {
        return h('div.lineup-row',
          h('span', { class: slotClass(s.slotLabel) }, s.slotLabel),
          h('span.bad', 'EMPTY — no eligible player'),
          h('span'), h('span'), h('span'), h('span'));
      }
      const opp = p.opponent === 'BYE' ? 'BYE' : p.opponent ? `${p.isHome ? 'vs' : '@'} ${p.opponent}` : '—';
      return h('div.lineup-row',
        h('span', { class: slotClass(s.slotLabel) }, s.slotLabel),
        h('div.stack',
          h('div.row-flex',
            posEl(p.pos), h('span.pname', p.name), statusBadge(p.status),
            p.profile?.label ? h('span.xs.mute', p.profile.label) : null),
          h('span.pmeta', `${p.nfl_team ?? ''} ${opp}`)
        ),
        h('span.pmeta.right', p.games ? `${p.games} gp` : 'no data'),
        h('span.num', { style: { fontWeight: '600' } }, n1(p.mean)),
        h('div',
          rangeBar(p.floor, p.mean, p.ceiling, scaleMax),
          h('div.xs.mute.mono', `${n1(p.floor)} – ${n1(p.ceiling)}`)),
        compact ? h('span') : h('div.right', why('why?', () => componentBreakdown(p)))
      );
    })
  );
}

/** The per-component explanation behind a single projection. */
export function componentBreakdown(p) {
  const parts = p.components ?? [];
  const base = parts.find((c) => c.kind === 'base');
  return h('div',
    h('div.small.mb',
      h('strong', `${p.name} — ${n1(p.mean)} projected`), ' ',
      h('span.mute', `(floor ${n1(p.floor)}, ceiling ${n1(p.ceiling)}, σ ${n1(p.sd)})`)),
    base ? h('div.comp-row',
      h('span.small', base.label),
      h('span.num.small', n1(base.value)),
      h('span.xs.mute', base.note)) : null,
    ...parts.filter((c) => c.mult !== undefined).map((c) => {
      const delta = (c.mult - 1) * 100;
      return h('div.comp-row',
        h('span.small', c.label),
        h('span.num.small', { class: delta > 0.5 ? 'good' : delta < -0.5 ? 'bad' : 'mute' },
          `${delta > 0 ? '+' : ''}${delta.toFixed(0)}%`),
        h('div',
          h('div.comp-bar', h('i', {
            class: delta >= 0 ? 'up' : 'down',
            style: { width: `${Math.min(50, Math.abs(delta) * 1.6)}%` },
          })),
          h('div.xs.mute', c.note ?? ''))
      );
    }),
    h('div.xs.mute.mt-s',
      `Model ${p.model}. Multipliers compound onto the baseline. A component at 0% means that input is available but neutral; an unavailable source says so rather than being guessed at.`)
  );
}

function alternatives(decision, rec) {
  return h('div.card.tight',
    table(
      ['', 'Lineup', { label: 'Win prob', num: true }, { label: 'Proj', num: true },
        { label: 'σ', num: true }, { label: 'Floor', num: true }, { label: 'Ceiling', num: true }],
      decision.candidates.slice(0, 7).map((c) => h('tr', { class: c.id === rec.id ? 'mine' : '' },
        h('td', c.id === rec.id ? h('span.good', '▸') : ''),
        h('td', c.label, c.pointCost > 0.05 ? h('span.xs.mute', ` (−${n1(c.pointCost)} proj)`) : null),
        h('td.num', { class: c.id === rec.id ? 'good' : '' }, pct(c.winProb)),
        h('td.num', n1(c.mean)),
        h('td.num.mute', n1(c.sd)),
        h('td.num.mute', n1(c.floor)),
        h('td.num.mute', n1(c.ceiling))
      ))
    )
  );
}

function benchTable(roster, lineup) {
  const startingIds = new Set(lineup.filter((l) => l.player).map((l) => l.player.player_id));
  const bench = roster.filter((p) => !startingIds.has(p.player_id));
  if (!bench.length) return empty('—', 'Every rostered player is starting');
  return h('div.card.tight',
    table(
      ['Player', 'Matchup', { label: 'Proj', num: true }, { label: 'Floor', num: true },
        { label: 'Ceiling', num: true }, 'Profile', ''],
      bench.map((p) => h('tr',
        h('td', h('div.row-flex', posEl(p.pos), h('span.pname', p.name), statusBadge(p.status))),
        h('td.pmeta', p.opponent === 'BYE' ? h('span.warnc', 'BYE')
          : p.opponent ? `${p.nfl_team} ${p.isHome ? 'vs' : '@'} ${p.opponent}` : '—'),
        h('td.num', n1(p.mean)),
        h('td.num.mute', n1(p.floor)),
        h('td.num.mute', n1(p.ceiling)),
        h('td.small.mute', p.profile?.label ?? ''),
        h('td.right', why('why?', () => componentBreakdown(p)))
      ))
    )
  );
}


/**
 * What this screen shows when it cannot answer.
 *
 * The state it replaces: a 50.0% win probability over zero simulations, badged
 * COIN-FLIP, above the sentence "play it straight" — a recommendation, in the
 * exact shape of a real one, computed from an empty roster. A manager reading
 * that has no way to tell it apart from a genuine coin flip in week 12.
 */
function notReady(d) {
  const mine = d.reason === 'no-roster';
  return frag(
    h('div.page-head',
      h('div',
        h('h2', `Week ${d.week} — ${d.me?.name ?? ''}`),
        h('div.sub', d.opponent ? `vs ${d.opponent.name}` : 'No opponent scheduled'))),
    empty('◇', d.note, mine
      ? 'Nothing here can be computed until your team is saved.'
      : 'Their picks are not in the database yet.'),
    mine ? h('div.card.accent',
      h('h3', 'Save your drafted team'),
      h('p', 'Your draft is still only in the browser. Open the Draft Room — the marked picks are held in local storage — and press ',
        h('b', 'save team to database'), '. That writes the roster the war room, waivers, trades and the streamer all read from.'),
      h('p.mute.xs', 'If the Draft Room is empty too, the picks are gone from this browser and the roster has to be re-entered.'),
    ) : h('div.card',
      h('h3', `${d.opponent?.name ?? 'Your opponent'} has no saved roster`),
      h('p', 'Your own lineup can still be optimised for expected points, but win probability needs both sides. Saving the full draft board fills in every team at once.')),
  );
}


/**
 * Says out loud when a projection is computed off half a roster.
 *
 * Partial rosters fail quietly: six players project cleanly and come back
 * looking exactly like thirteen, just lower, with nothing in the output saying
 * which. And the empty slots are not interchangeable — this league scores
 * defenses far above the Yahoo default, so a missing K and DEF is not a little
 * low, it is the largest single scoring slot on the roster absent.
 */
function partialRosterWarning(c) {
  if (!c) return null;
  const mine = c.mine, opp = c.opponent;
  if ((!mine || mine.complete) && (!opp || opp.complete)) return null;

  const line = (t, who) => {
    if (!t || t.complete) return null;
    const pos = t.missingPositions.length
      ? ` — no ${t.missingPositions.join(', ')}`
      : '';
    return h('li', h('b', who), `: ${t.have} of ${t.size} players saved${pos}.`);
  };

  return h('div.card.warn',
    h('div.row-flex', badge('PARTIAL ROSTERS', 'warn'),
      h('h3', 'These projections are missing players')),
    h('ul',
      line(mine, 'Your team'),
      line(opp, 'Your opponent')),
    h('p.mute.xs', 'An unfilled kicker and defense cost more here than the count suggests: a complete team'
      + ' observed in week 1 projected 150.18, of which its kicker and defense were 41.24 — 27% of the total,'
      + ' with the defense alone outscoring every skill starter but the quarterback. Add the missing players'
      + ' to the "rosters" block of the league config and re-run the league setup.'));
}
