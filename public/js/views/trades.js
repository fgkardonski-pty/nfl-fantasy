/**
 * Trades. Two boards, deliberately separated: deals that help both sides (which
 * get accepted) and deals that are better for you than for them (which pay
 * more but land less often). Each shows its best few; the rest wait behind a
 * button, because nineteen near-identical cards is a scroll, not a decision.
 */
import {
  h, fill, frag, api, loading, errorBox, pct, n1, posEl, badge, empty,
} from '../util.js';

const SHOWN = 5;

export async function render(root) {
  fill(root, loading('searching every roster in the league…'));
  let d;
  try { d = await api('/api/trades?limit=12'); }
  catch (err) { fill(root, errorBox(err)); return; }

  fill(root,
    h('div.page-head',
      h('div',
        h('h2', 'Trades'),
        h('div.sub', 'Offers worth sending: what you give, what you get, and how likely the other manager is to say yes.'))),

    h('div.explainer',
      h('b', 'How to read these. '),
      '“You” is how many points a week your best lineup gains for the rest of the season; “them” is the same for their team. ',
      'Acceptance odds are estimates, and they sharpen once Yahoo is connected and each manager’s trading history can be read. ',
      `${d.weeksRemaining} weeks remain before the playoffs.`),

    h('div.section-head',
      h('h3', 'Fair trades — send these first'),
      h('span.note', 'both teams get better, so these are the ones that get accepted')),
    d.winWin.length
      ? board(d.winWin, true)
      : empty('⇄', 'No trade helps both teams right now',
          'Your roster and your rivals’ rosters don’t have surpluses that fit each other this week. Check again after waivers.'),

    h('div.section-head',
      h('h3', 'Lopsided trades'),
      h('span.note', 'better for you than for them — less likely to be accepted, but worth a try')),
    d.arbitrage.length ? board(d.arbitrage, false) : empty('—', 'None found'),
  );
}

function board(deals, winWin) {
  const sorted = [...deals].sort((a, b) => b.myGainPerWeek * b.acceptProb - a.myGainPerWeek * a.acceptProb);
  const rest = sorted.slice(SHOWN);
  const more = h('div.grid', { style: { gap: '10px', marginTop: '10px' }, hidden: true }, ...rest.map((t) => deal(t, winWin)));
  return frag(
    h('div.grid', { style: { gap: '10px' } }, ...sorted.slice(0, SHOWN).map((t) => deal(t, winWin))),
    rest.length ? h('button.btn.sm.mt-s', { onclick: (e) => { more.hidden = false; e.target.remove(); } },
      `Show ${rest.length} more`) : null,
    more);
}

function deal(t, winWin) {
  const side = (players) => players.map((p) => h('div.row-flex', { style: { marginBottom: '3px' } },
    posEl(p.pos), h('span', p.name), h('span.pmeta', `${n1(p.seasonMean)}/wk`)));
  // Archetype labels come from the transaction log; "Balanced" is what every
  // manager is called when there is none, so it says nothing.
  const archetype = t.archetype && t.archetype.key !== 'balanced' ? badge(t.archetype.label, 'purple') : null;
  return h('div.deal', { class: winWin ? 'winwin' : '' },
    h('div.deal-head',
      h('div.row-flex',
        h('span', { style: { fontWeight: '600' } }, `Trade with ${t.teamName}`),
        h('span.mute.small', t.manager ? `· ${t.manager}` : ''),
        archetype),
      h('div.row-flex',
        h('span.mono.good', `you +${n1(t.myGainPerWeek)}/wk`),
        h('span.mono', { class: t.theirRealGain > 0 ? 'good' : 'bad' }, `them ${t.theirRealGain >= 0 ? '+' : ''}${n1(t.theirRealGain)}`),
        badge(`${pct(t.acceptProb, 0)} likely to accept`, t.acceptProb > 0.4 ? 'ok' : t.acceptProb > 0.2 ? 'warn' : 'dim'))),
    h('div.deal-legs',
      h('div.deal-leg.out', h('div.cap', 'you send'), ...side(t.send)),
      h('div.deal-arrow', '→'),
      h('div.deal-leg.in', h('div.cap', 'you get'), ...side(t.receive))),
    h('details.pitch', h('summary.small', 'How to pitch it'), h('div.small.dim.mt-s', t.pitch)));
}
