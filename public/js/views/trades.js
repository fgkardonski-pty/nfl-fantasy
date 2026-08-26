/**
 * Trades. Two boards, deliberately separated: deals that help both sides (which
 * get accepted) and deals that exploit a rival's own valuations (which pay more
 * but land less often).
 */
import {
  h, frag, api, loading, errorBox, pct, n1, n2, signed, posEl, badge, empty, bar,
} from '../util.js';

export async function render(root) {
  root.replaceChildren(loading('searching every roster in the league…'));
  let d;
  try { d = await api('/api/trades?limit=12'); }
  catch (err) { root.replaceChildren(errorBox(err)); return; }

  root.replaceChildren(
    h('div.page-head',
      h('div',
        h('h2', 'Trade Finder'),
        h('div.sub', 'Every package evaluated twice — once on your valuations, once on theirs, reconstructed from how they actually behave.')
      ),
      h('div.row-flex',
        badge(`${d.counts.winWin} win-win`, 'ok'),
        badge(`${d.counts.arbitrage} arbitrage`, 'warn'),
        badge(`${d.weeksRemaining} weeks left`, 'dim')
      )
    ),

    h('div.section-head',
      h('h3', 'Win-win — send these first'),
      h('span.note', 'both sides genuinely improve, so these actually get accepted')),
    d.winWin.length
      ? h('div.grid', { style: { gap: '11px' } }, ...d.winWin.map((t) => deal(t, true)))
      : empty('⇄', 'No mutually beneficial trades found right now',
          'Your roster and your rivals\' rosters do not have complementary surpluses this week. Check back after the next round of waivers.'),

    h('div.section-head',
      h('h3', 'Value arbitrage'),
      h('span.note', 'you gain and they do not — but their revealed preferences say they will take it anyway')),
    d.arbitrage.length
      ? h('div.grid', { style: { gap: '11px' } }, ...d.arbitrage.map((t) => deal(t, false)))
      : empty('—', 'No arbitrage opportunities found')
  );
}

function deal(t, winWin) {
  return h('div.deal', { class: winWin ? 'winwin' : '' },
    h('div.deal-head',
      h('div.row-flex',
        h('span', { style: { fontWeight: '600' } }, t.teamName),
        h('span.mute.small', t.manager ? `· ${t.manager}` : ''),
        t.archetype ? badge(t.archetype.label, 'purple') : null
      ),
      h('div.row-flex',
        badge(`accept ${pct(t.acceptProb, 0)}`, t.acceptProb > 0.4 ? 'ok' : t.acceptProb > 0.2 ? 'warn' : 'bad'),
        h('span.mono.good', `you +${n2(t.myGainPerWeek)}/wk`),
        h('span.mono', { class: t.theirRealGain > 0 ? 'good' : 'mute' },
          `them ${signed(t.theirRealGain)}`)
      )
    ),

    h('div.deal-legs',
      h('div.deal-leg.out',
        h('div.cap', 'you send'),
        ...t.send.map((p) => h('div.row-flex', { style: { marginBottom: '3px' } },
          posEl(p.pos), h('span', p.name), h('span.pmeta', n1(p.seasonMean))))
      ),
      h('div.deal-arrow', '⇄'),
      h('div.deal-leg.in',
        h('div.cap', 'you get'),
        ...t.receive.map((p) => h('div.row-flex', { style: { marginBottom: '3px' } },
          posEl(p.pos), h('span', p.name), h('span.pmeta', n1(p.seasonMean))))
      )
    ),

    h('div.mt-s',
      h('div.xs.mute', `acceptance probability ${pct(t.acceptProb, 0)}`),
      bar(t.acceptProb, 1, t.acceptProb > 0.4 ? '' : 'warn')
    ),

    h('div.pitch', h('strong', 'How to pitch it: '), t.pitch)
  );
}
