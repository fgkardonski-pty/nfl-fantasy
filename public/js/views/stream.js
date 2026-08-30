/**
 * Defense streamer.
 *
 * The cheapest edge in this league. Defenses score far more here than in a
 * standard one — two points a sack, sixteen for a shutout, a point per tackle
 * for loss — so the weekly gap between the best and worst startable unit is
 * wider than the gap between most starting running backs, and a defense costs
 * nothing but a waiver claim.
 *
 * Two things this view refuses to do. It will not rank real defenses against a
 * schedule it cannot verify, and it will not recommend a claim we are unlikely
 * to win: at waiver priority 13 of 16, twelve managers pick over the pile
 * before we do, so the useful answer is the best defense we can actually get.
 */
import { h, frag, api, loading, errorBox, badge, table, empty, n1, pct } from '../util.js';

export async function render(root) {
  root.replaceChildren(loading('pricing every defense against this week’s slate…'));
  let d;
  try { d = await api('/api/stream?limit=14'); }
  catch (err) { root.replaceChildren(errorBox(err)); return; }

  if (!d.ok) return root.replaceChildren(refusal(d));

  const rows = d.best.map((x) => {
    const odds = 1 - (x.claimRisk ?? 0);
    return [
      h('span.strong', x.name),
      `${x.home ? 'vs' : '@'} ${x.opponent}`,
      // The implied total of the offence faced is the whole signal; showing it
      // means a manager can sanity-check the ranking rather than trust it.
      h('span', { class: x.impliedOpponentTotal < 19 ? 'okc' : x.impliedOpponentTotal > 25 ? 'badc' : '' },
        n1(x.impliedOpponentTotal)),
      h('span.strong', n1(x.mean)),
      x.expectedGain == null ? '—'
        : h('span', { class: x.expectedGain > 1.5 ? 'okc' : x.expectedGain > 0 ? '' : 'mute' },
            `${x.expectedGain > 0 ? '+' : ''}${n1(x.expectedGain)}`),
      h('span', { class: odds > 0.8 ? 'okc' : odds > 0.6 ? 'warnc' : 'badc' }, pct(odds, 0)),
    ];
  });

  root.replaceChildren(
    h('div.page-head',
      h('div',
        h('h2', `Defense streamer — week ${d.week ?? ''}`),
        h('div.sub', d.mine
          ? `Holding ${d.mine.name} (${d.mine.home ? 'vs' : '@'} ${d.mine.opponent}, projected ${n1(d.mine.mean)}). Anything below has to beat that to be worth a claim.`
          : 'No defense is on the roster, so every candidate below is an upgrade on nothing.')),
      h('div.row-flex',
        d.waiverPriority != null
          ? badge(`WAIVER PRIORITY ${d.waiverPriority}`, d.waiverPriority > 8 ? 'warn' : 'ok')
          : null)),

    d.recommended ? verdictCard(d) : standPat(d),

    h('div.section-head',
      h('h3', 'Every available defense, best matchup first'),
      h('span.note', 'IMP is the points the offence they face is implied to score — the number the ranking turns on')),
    table(
      ['Defense', 'Matchup', { label: 'IMP', num: true }, { label: 'Proj', num: true },
       { label: 'Gain', num: true }, { label: 'Claim odds', num: true }],
      rows),

    d.contested?.length
      ? h('div.note.mt', `Likely claimed before our turn: ${d.contested.map((x) => x.name).join(', ')}.`)
      : null,
  );
}

function verdictCard(d) {
  const r = d.recommended;
  return h('div.card.accent',
    h('div.row-flex',
      badge('CLAIM', 'ok'),
      h('h3', r.name),
      h('span.mute', `${r.home ? 'vs' : '@'} ${r.opponent}`)),
    h('p', d.mine
      ? `Projected ${n1(r.mean)} against ${n1(d.mine.mean)} for ${d.mine.name} — ${n1(r.expectedGain)} points of upgrade for a claim that costs nothing but priority.`
      : `Projected ${n1(r.mean)}, against an offence implied for only ${n1(r.impliedOpponentTotal)} points.`),
    h('p.mute.xs', `From waiver priority ${d.waiverPriority ?? '?'} this claim lands roughly ${pct(1 - r.claimRisk, 0)} of the time.`));
}

function standPat(d) {
  return h('div.card',
    h('div.row-flex', badge('STAND PAT', 'dim'), h('h3', 'No claim worth making')),
    h('p', d.mine
      ? `Nothing available beats ${d.mine.name} by enough to spend a waiver claim on. Streaming is only free when the upgrade is real.`
      : 'No defense on this week’s slate is realistically claimable from our position in the waiver order.'));
}

/**
 * Why there is no ranking.
 *
 * Deliberately as prominent as a real answer would be. The failure this guards
 * against is a plausible-looking list built on demo fixtures — indistinguishable
 * from the real thing until a Sunday goes wrong.
 */
function refusal(d) {
  const fix = {
    'no-schedule': 'Load this week’s NFL games, with betting lines.',
    'synthetic-schedule': 'The games loaded for this week are demo fixtures. Run a clean real-data setup, then import a live slate.',
    'no-lines': 'The games are loaded but carry no implied team totals. Import odds.',
  }[d.reason] ?? 'Load a real slate for this week.';

  return frag(
    h('div.page-head', h('div',
      h('h2', 'Defense streamer'),
      h('div.sub', 'No ranking produced'))),
    empty('⛨', d.note, fix),
    h('div.card',
      h('h3', 'Why this is blank rather than populated'),
      h('p', 'A defense’s weekly score is driven overwhelmingly by how many points the offence it faces scores, and the betting market’s implied team total is the best public estimate of that. Without it, any ordering here would be arbitrary — and would look exactly as authoritative as a real one.')),
  );
}
