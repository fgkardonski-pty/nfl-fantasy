/**
 * Defense — the weekly swap question.
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
import { h, fill, frag, api, loading, errorBox, badge, table, empty, n1, pct, gameLabel, doneList, todo } from '../util.js';
import { whyLink } from '../chat.js';

/** A swap has to clear this many projected points to be worth the claim. */
const WORTH_IT = 1.5;

export async function render(root) {
  fill(root, loading('pricing every defense against this week’s slate…'));
  let d, plan;
  try { [d, plan] = await Promise.all([api('/api/stream?limit=14'), api('/api/actions').catch(() => null)]); }
  catch (err) { fill(root, errorBox(err)); return; }

  if (!d.ok) return fill(root, refusal(d));

  const upgrades = d.best.filter((x) => (x.expectedGain ?? 0) > WORTH_IT);
  fill(root,
    h('div.page-head',
      h('div',
        h('h2', 'Defense'),
        h('div.sub', `Should you swap your defense for week ${d.week ?? ''}? Defenses score big in this league and change hands for free, so the right one is worth checking every week.`))),

    answer(d, upgrades, plan),

    h('div.section-head',
      h('h3', 'Every available defense'),
      h('span.note', 'best projection first')),
    h('div.card.tight', table(
      ['Defense', 'Game', { label: 'Projected', num: true }, { label: 'vs yours', num: true }, 'If on waivers'],
      [
        d.mine ? h('tr.mine',
          h('td', h('b', d.mine.name), ' ', badge('YOURS', 'ok')),
          h('td.pmeta', gameLabel(d.mine.opponent, d.mine.home)),
          h('td.num', n1(d.mine.mean)),
          h('td.num.mute', '—'),
          h('td.small.mute', '')) : null,
        ...d.best.map((x) => {
          const odds = 1 - (x.claimRisk ?? 0);
          const gain = x.expectedGain;
          return h('tr',
            h('td', x.name),
            h('td.pmeta', gameLabel(x.opponent, x.home)),
            h('td.num', n1(x.mean)),
            h('td.num', { class: gain > WORTH_IT ? 'good' : 'mute' }, gain == null ? '—' : `${gain > 0 ? '+' : ''}${n1(gain)}`),
            h('td.small', { class: odds > 0.8 ? 'good' : odds > 0.5 ? 'warnc' : 'bad' },
              odds > 0.8 ? 'you’d likely get him' : odds > 0.5 ? `${pct(odds, 0)} chance` : `unlikely (${pct(odds, 0)})`));
        }),
      ])),
    h('div.xs.mute.mt-s', 'The last column only matters if Yahoo marks the defense “W” (on waivers). A defense marked “FA” is yours the moment you add it.'),
  );
}

/**
 * The answer, as an instruction: which defense to add, which to drop, and what
 * to try if the first choice is gone. A bare "CLAIM Miami" left the drop and
 * the start unsaid.
 */
function answer(d, upgrades, plan) {
  const mine = d.mine;
  // The weekly plan decides what is dropped, because it sees the whole roster:
  // with an open spot the right move keeps the current defense on the bench.
  const planned = plan?.acquisitions?.find((a) => a.addPos === 'DEF');
  const drop = planned ? planned.drop : mine;
  if (!upgrades.length) {
    return h('div.card',
      h('div.todo-title', badge('KEEP', 'ok'), ` Keep ${mine ? mine.name : 'your defense'}`),
      h('p.small.dim', mine
        ? `Nothing available projects enough above ${mine.name} (${n1(mine.mean)} ${gameLabel(mine.opponent, mine.home)}) to be worth the move.`
        : 'No available defense is worth adding this week.'));
  }
  const done = doneList(d.week);
  const first = (planned && upgrades.find((x) => x.player_id === planned.add.player_id)) ?? upgrades[0];
  const rest = upgrades.filter((x) => x !== first);
  const fallback = rest.filter((x) => (x.claimRisk ?? 0) < 0.5).slice(0, 2);
  return h('div.card.accent.todos',
    todo(done, `add:${first.player_id}`,
      h('div.todo-title',
        h('span.verb.add', 'ADD'), ' ', h('b', first.name), h('span.mute', ` ${gameLabel(first.opponent, first.home)}`),
        drop ? frag(h('span.verb.drop', 'DROP'), ' ', h('b', drop.name))
          : frag(h('span.verb.sit', 'NO DROP'), ' ', h('span.mute', 'uses your open roster spot')),
        h('span.gain', `+${n1(first.expectedGain)} pts this week`),
        whyLink(`Why should I pick up the ${first.name} defense${drop ? ` and drop ${drop.name}` : ''} this week?`)),
      h('div.small.dim',
        `Projected ${n1(first.mean)}${mine ? ` against ${n1(mine.mean)} for ${mine.name} (${gameLabel(mine.opponent, mine.home)})` : ''}. `,
        mine && !drop ? `Start him at DEF and move ${mine.name} to your bench — they’re the better defense for the rest of the season.` : 'Start him at DEF once he’s on your roster.'),
      fallback.length && (first.claimRisk ?? 0) >= 0.5
        ? h('div.small.warnc', `If he’s on waivers, someone ahead of you will probably claim him first. Claim him anyway, and put in a backup claim for ${fallback.map((x) => `${x.name} (+${n1(x.expectedGain)})`).join(', then ')}.`)
        : null),
    drop && mine && drop.player_id === mine.player_id
      ? h('div.xs.mute.mt-s', `Dropping ${mine.name} is fine: defenses are streamed week to week, and you can pick one up again when its matchup is good.`)
      : null);
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
    'unverified-schedule': 'These games predate provenance tracking, so they cannot be confirmed real. Re-import this week’s slate with odds to replace them.',
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
