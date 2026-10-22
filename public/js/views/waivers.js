/**
 * Pickups — who to add, and who to drop for them.
 *
 * Two parts, deliberately in this order. First the plan: the same sequence of
 * moves the This Week page lists, because two screens recommending different
 * pickups is worse than either alone. Then the board: everyone available,
 * filterable by position, with one plain number per player — how much he adds
 * to YOUR lineup — rather than a wall of model outputs.
 */
import {
  h, fill, frag, api, loading, errorBox, pct, n1, money, posEl,
  statusBadge, badge, table, empty, why, gameLabel, doneList, todo,
} from '../util.js';
import { whyLink } from '../chat.js';
import { componentBreakdown } from './warroom.js';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

export async function render(root) {
  fill(root, loading('valuing every available player for your roster…'));
  let plan, board;
  try {
    [plan, board] = await Promise.all([api('/api/actions'), api('/api/waivers?limit=80')]);
  } catch (err) { fill(root, errorBox(err)); return; }

  const done = doneList(plan.week);
  const faab = board.waiverType === 'FAAB';
  const tableHost = h('div');
  let pos = 'ALL';
  let showAll = false;
  const drawTable = () => fill(tableHost, boardTable(board, { pos, showAll, faab }));
  const filters = h('div.row-flex.mb',
    h('div.seg', ...POSITIONS.map((p) => h('button', {
      class: p === pos ? 'on' : '',
      onclick: (e) => { pos = p; [...e.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.target)); drawTable(); },
    }, p))),
    h('label.small.mute', h('input', { type: 'checkbox', onchange: (e) => { showAll = e.target.checked; drawTable(); } }),
      ' include players who don’t help you'));
  drawTable();

  fill(root,
    h('div.page-head',
      h('div',
        h('h2', 'Pickups'),
        h('div.sub', 'Who to add this week, who to drop for them, and everyone else worth knowing about.'))),

    howWaiversWork(board, faab),

    h('div.section-head', h('h3', 'Your moves this week'),
      h('span.note', 'in order — each one assumes you made the ones above it')),
    plan.acquisitions.length
      ? h('div.card.todos', ...plan.acquisitions.map((a) => moveRow(a, plan, done)))
      : h('div.card', h('div.todo-title', 'No pickup is worth a roster spot right now.'),
          h('div.small.dim', plan.acquisitionNote ?? '')),

    h('div.section-head', h('h3', 'Best available'),
      h('span.note', '“Adds” is how many points he’d add to your best lineup this week')),
    filters,
    tableHost,
  );
}

function howWaiversWork(board, faab) {
  const pri = board.waiverPriority;
  return h('div.explainer',
    h('b', 'How pickups work in your league. '),
    faab
      ? `You bid from a budget — ${money(board.faabRemaining)} left. `
      : `Claims go by waiver priority, and yours is ${pri ?? '?'}${pri ? ` (${pri - 1} teams pick before you)` : ''}. `,
    'A player marked “FA” in Yahoo is a free agent — add him and he’s yours immediately. One marked “W” is on waivers: your add becomes a claim that only goes through if no team ahead of you claims him first. ',
    board.openSpot
      ? h('span.good', 'You have an open roster spot, so your first add needs no drop.')
      : null);
}

function moveRow(a, plan, done) {
  const swap = (plan.plannedSwaps ?? []).find((s) => s.start.player_id === a.add.player_id);
  return todo(done, `add:${a.add.player_id}`,
    h('div.todo-title',
      h('span.step', a.step ?? ''),
      h('span.verb.add', 'ADD'), ' ', posEl(a.addPos ?? a.add.pos), ' ', h('b', a.add.name),
      a.opponent ? h('span.mute', ` ${gameLabel(a.opponent, a.isHome)}`) : null,
      h(a.drop ? 'span.verb.drop' : 'span.verb.sit', a.drop ? 'DROP' : 'NO DROP'), ' ',
      a.drop ? h('b', a.drop.name) : h('span.mute', 'open roster spot'),
      a.weeklyGain >= 0.5 ? h('span.gain', `+${n1(a.weeklyGain)} pts this week`) : h('span.gain.mute', 'long-term'),
      whyLink(`Why do you recommend adding ${a.add.name}${a.drop ? ` and dropping ${a.drop.name}` : ''}?`)),
    h('div.small.dim', plainWhy(a, swap)));
}

/** The model's reasoning, as a sentence a person would say. */
function plainWhy(a, swap) {
  const parts = [];
  if (swap) parts.push(swap.sit ? `He starts for you at ${swap.slot} instead of ${swap.sit.name}.` : `He fills your ${swap.slot} spot.`);
  else parts.push('He goes on your bench as a better option than the player you drop.');
  if (a.seasonGain > 0.5) parts.push(`He also improves your typical lineup by about ${n1(a.seasonGain)} points a week for the rest of the season.`);
  if (a.drop) parts.push(`${a.drop.name} is the least useful player on your bench.`);
  return parts.join(' ');
}

const LABEL = {
  starts: ['WOULD START', 'ok'],
  depth: ['BENCH DEPTH', 'info'],
  none: ['NO HELP', 'dim'],
};

function boardTable(board, { pos, showAll, faab }) {
  const rows = board.targets
    .filter((t) => pos === 'ALL' || t.pos === pos)
    .map((t) => ({ ...t, kind: t.startsImmediately && t.marginalWeekly > 0.05 ? 'starts' : t.rosValue > 0.5 ? 'depth' : 'none' }))
    .filter((t) => showAll || t.kind !== 'none');
  if (!rows.length) {
    return empty('◇', pos === 'ALL' ? 'Nobody available improves your roster' : `No ${pos} available improves your roster`,
      showAll ? '' : 'Tick “include players who don’t help you” to see the rest.');
  }
  return h('div.card.tight',
    table(
      ['Player', 'Game', { label: 'Proj', num: true }, { label: 'Adds', num: true }, 'For you',
        ...(faab ? [{ label: 'Bid', num: true }] : []), ''],
      rows.map((t) => h('tr',
        h('td', h('div.row-flex', posEl(t.pos), h('span.pname', t.name), h('span.pmeta', t.nfl_team ?? ''), statusBadge(t.status))),
        h('td.pmeta', t.opponent === 'BYE' ? h('span.bad', 'BYE') : gameLabel(t.opponent, t.isHome)),
        h('td.num', n1(t.mean)),
        h('td.num', { class: t.marginalWeekly > 0.05 ? 'good' : 'mute' }, t.marginalWeekly > 0.05 ? `+${n1(t.marginalWeekly)}` : '—'),
        h('td', badge(...LABEL[t.kind])),
        ...(faab ? [h('td.num', money(t.bid.amount))] : []),
        h('td.right', why('details', () => frag(
          h('div.small.mb', t.verdict.text),
          t.dropSuggestion ? h('div.small.mb', `Would replace ${t.dropSuggestion.name} on your roster.`) : null,
          h('div.small.mb', `Rest-of-season value to you: +${n1(t.rosValue)} points; title odds ${t.titleDelta > 0 ? '+' : ''}${pct(t.titleDelta, 2)}.`),
          componentBreakdown(t))))
      ))
    )
  );
}
