/**
 * This Week.
 *
 * The one screen you open before kickoff, and it answers one question: what do
 * I have to do in Yahoo this week? Everything else — the simulation, the
 * alternatives, the evidence — sits underneath, collapsed, for when the answer
 * needs checking rather than following.
 */
import {
  h, fill, frag, api, loading, errorBox, stat, dial, pct, n1, signed,
  posEl, statusBadge, badge, rangeBar, why, table, empty, gameLabel, doneList, todo,
} from '../util.js';
import { whyLink } from '../chat.js';

const SLOT_NAMES = { 'W/T': 'WR/TE flex', 'W/R': 'WR/RB flex', 'W/R/T': 'flex', DEF: 'defense', K: 'kicker' };
const slotName = (s) => SLOT_NAMES[s] ?? s;

export async function render(root, ctx) {
  fill(root, loading('working out this week’s moves…'));
  let d;
  try { d = await api('/api/actions'); }
  catch (err) { fill(root, errorBox(err)); return; }
  if (!root.isConnected) return;

  // The matchup numbers come from a heavier simulation; the to-do list must not
  // wait for it.
  const matchupHead = h('div', loading('simulating your matchup…'));
  const details = h('div');
  const done = doneList(d.week);

  fill(root, 
    matchupHead,
    freshnessLine(d),
    ['pre_draft', 'drafting'].includes(d.phase) ? h('div.card.accent.mb',
      h('h3', 'Your draft is coming up'), h('a.btn', { href: '#/draft' }, 'Open the Draft Room')) : h('span'),
    h('div.section-head', h('h3', 'Your to-do list before kickoff'),
      h('span.note', 'make each move in Yahoo, then tick it off here')),
    todoList(d, done),
    h('div.section-head', h('h3', 'Your lineup once these are done'),
      h('span.note', 'highlighted rows change from what Yahoo has now')),
    plannedLineup(d),
    h('details.more', h('summary', 'Show the full matchup simulation and the evidence behind each projection'), details),
  );

  api(`/api/warroom${ctx.week ? `?week=${ctx.week}` : ''}`)
    .then((w) => { if (root.isConnected) { fill(matchupHead, matchupBanner(w, d)); renderMatchup(details, w); } })
    .catch((err) => { fill(matchupHead, h('div.page-head', h('div', h('h2', `Week ${d.week}`))), errorBox(err)); });
}

/** Week, opponent and the one number that matters, in a sentence. */
function matchupBanner(w, d) {
  const gain = d.acquisitions.reduce((a, x) => a + Math.max(0, x.weeklyGain ?? 0), 0);
  if (w.ready === false || !w.sim) {
    return h('div.page-head', h('div', h('h2', `Week ${d.week}`),
      h('div.sub', w.opponent ? `vs ${w.opponent.name}` : 'No opponent scheduled')));
  }
  const p = w.sim.winProb;
  const verdict = p >= 0.65 ? 'You’re the clear favourite.'
    : p >= 0.55 ? 'You’re a slight favourite.'
    : p > 0.45 ? 'It’s a coin flip.'
    : p > 0.35 ? 'You’re a slight underdog.'
    : 'You’re the underdog — the moves below matter.';
  const opp = w.opponent;
  return h('div.banner',
    h('div',
      h('div.banner-kicker', `Week ${w.week}${w.opponentSource === 'estimated' ? ' · opponent estimated' : ''}`),
      h('h2', opp ? `${w.me.name} vs ${opp.name}` : w.me.name),
      h('div.banner-verdict', verdict),
      h('div.small.mute', `With your roster as it stands: you ${n1(w.sim.myMean)}, them ${n1(w.sim.oppMean)}.`,
        gain >= 0.5 ? h('span.good', ` The moves below add about ${n1(gain)} points.`) : null),
      w.ifOpponentKeepsLineup ? h('div.small', { style: { marginTop: '4px' } },
        h('span.mute', `That assumes ${opp.name} plays their best lineup. They currently aren’t starting ${w.ifOpponentKeepsLineup.benched.join(', ')} — `),
        h('span.good', `if they leave it that way, your chance rises to ${pct(w.ifOpponentKeepsLineup.winProb, 0)}.`)) : null),
    h('div.banner-odds',
      h('div.big-pct', { class: p >= 0.55 ? 'good' : p <= 0.45 ? 'bad' : 'warnc' }, pct(p, 0)),
      h('div.xs.mute', 'chance to win')));
}

function freshnessLine(d) {
  const f = d.freshness;
  const warnings = [...d.blockers, ...f.errors, ...f.evidenceErrors];
  const when = (ts) => new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const line = f.manual
    ? `Rosters as you entered them${f.enteredAt ? ` on ${when(f.enteredAt)}` : ''}. Moves made in Yahoo since then aren’t reflected here.`
    : f.lastSuccess ? `Rosters synced ${when(f.lastSuccess)}.` : 'Rosters have never synced from your league.';
  return h('div.fresh',
    h('span', { class: f.stale ? 'warnc' : 'mute' }, line),
    f.manual ? h('a.small', { href: '#/update', style: { marginLeft: '8px' } }, 'Update from screenshots →') : null,
    ...warnings.map((s) => h('div.warnc.small', s)));
}

/**
 * Every move this week, in the order to make them.
 *
 * Gaps first, because an empty or unplayable slot scores zero whatever else
 * happens. Each pickup says exactly what it costs (the drop) and finishes the
 * job (the start/sit it implies), so no step reads as complete when it is half
 * done.
 */
function todoList(d, done) {
  const items = [];
  const swaps = d.plannedSwaps ?? [];
  const swapFor = (id) => swaps.find((s) => s.start.player_id === id);
  const filledBy = new Map();
  for (const a of d.acquisitions) {
    const s = swapFor(a.add.player_id);
    if (s) filledBy.set(s.slot, a);
  }

  // Gaps the plan does not fill on its own.
  for (const hole of d.holes ?? []) {
    if (filledBy.has(hole.slot)) continue;
    items.push(todo(done, `hole:${hole.slot}`,
      h('div.todo-title', badge('GAP', 'bad'), ` Nobody can score at ${slotName(hole.slot)} this week`),
      h('div.small.dim', holeReason(hole), ' ', h('a', { href: '#/waivers' }, 'See pickups →'))));
  }

  d.acquisitions.forEach((a) => {
    const s = swapFor(a.add.player_id);
    const fillsGap = s && (d.holes ?? []).find((x) => x.slot === s.slot);
    items.push(todo(done, `add:${a.add.player_id}`,
      h('div.todo-title',
        h('span.verb.add', 'ADD'), ' ', posEl(a.addPos ?? a.add.pos), ' ', h('b', a.add.name),
        a.opponent ? h('span.mute', ` ${gameLabel(a.opponent, a.isHome)}`) : null,
        h(a.drop ? 'span.verb.drop' : 'span.verb.sit', a.drop ? 'DROP' : 'NO DROP'), ' ',
        a.drop ? h('b', a.drop.name) : h('span.mute', 'uses your open roster spot'),
        a.weeklyGain >= 0.5 ? h('span.gain', `+${n1(a.weeklyGain)} pts this week`) : h('span.gain.mute', 'for later weeks'),
        whyLink(`Why do you recommend adding ${a.add.name}${a.drop ? ` and dropping ${a.drop.name}` : ''}?`)),
      h('div.small.dim',
        fillsGap ? `Fills your ${slotName(s.slot)} spot — ${holeReason(fillsGap)} ` : '',
        s ? (s.sit ? `Then start him at ${slotName(s.slot)} instead of ${s.sit.name}.` : `Then start him at ${slotName(s.slot)}.`)
          : 'Keep him on your bench for now — he’s a better long-term option than the player you drop.')));
  });

  // Start/sit swaps among players already on the roster.
  for (const s of swaps.filter((x) => !x.isNew)) {
    items.push(todo(done, `swap:${s.start.player_id}`,
      h('div.todo-title', h('span.verb.start', 'START'), ' ', h('b', s.start.name), ` at ${slotName(s.slot)}`,
        s.sit ? frag(h('span.verb.sit', 'BENCH'), ' ', h('b', s.sit.name)) : null,
        h('span.gain'), whyLink(`Why should I start ${s.start.name}${s.sit ? ` over ${s.sit.name}` : ''}?`)),
      h('div.small.dim', 'Projects higher in your league’s scoring this week.')));
  }

  if (!items.length) {
    return h('div.card.accent', h('div.todo-title', '✓ Nothing to do. Your lineup is already the best one available.'),
      h('div.small.dim', d.acquisitionNote ?? ''));
  }
  return h('div.card.todos', ...items,
    d.acquisitions.length ? h('div.xs.mute.todo-foot', `To add a player in Yahoo: Players → search his name → Add. If a “W” shows next to him he’s on waivers, so the add becomes a claim that processes later${d.waiverPriority ? `, and ${d.waiverPriority - 1} teams claim before you` : ''}. See Pickups for backups.`) : null,
    d.acquisitionNote && !d.acquisitions.length ? h('div.small.mute.mt-s', d.acquisitionNote) : null);
}

function holeReason(hole) {
  const who = hole.player?.name;
  return {
    bye: `${who} is on bye.`,
    out: `${who} is ruled out.`,
    empty: 'The slot is empty and no one on your bench is eligible.',
    zero: `${who} isn’t projected to score.`,
  }[hole.reason] ?? '';
}

function plannedLineup(d) {
  const rows = d.plannedLineup ?? [];
  if (!rows.length) return empty('◇', 'No lineup yet', 'Save your roster first.');
  return h('div.card.tight',
    table(['Slot', 'Player', 'Game', { label: 'Projected', num: true }, ''],
      rows.map((s) => h('tr', { class: s.isNew || !s.alreadyStarting ? 'changed' : '' },
        h('td', h('span.slot-badge', s.slot)),
        h('td', s.player
          ? h('div.row-flex', posEl(s.player.pos), h('span.pname', s.player.name), statusBadge(s.status))
          : h('span.bad', 'empty')),
        h('td.pmeta', s.opponent === 'BYE' ? h('span.bad', 'BYE') : gameLabel(s.opponent, s.isHome)),
        h('td.num', s.player ? n1(s.player.mean) : '—'),
        h('td.small', s.locked ? h('span.mute', 'game started')
          : s.isNew ? badge('PICK UP', 'ok') : !s.alreadyStarting && s.player ? badge('MOVE IN', 'info') : null)))));
}

function renderMatchup(root, data) {
  if (data.ready === false) return fill(root, notReady(data));

  const { decision, sim, posture, me, opponent, week } = data;
  const rec = decision.recommended;

  fill(root, 
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
