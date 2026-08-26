/** Season odds: playoff and championship probability for every team. */
import { h, api, loading, errorBox, pct, n1, badge, table, bar, stat } from '../util.js';

export async function render(root) {
  root.replaceChildren(loading('replaying the season thousands of times…'));
  let d;
  try { d = await api('/api/outlook'); }
  catch (err) { root.replaceChildren(errorBox(err)); return; }

  const mine = d.standings.find((s) => s.is_mine);

  root.replaceChildren(
    h('div.page-head',
      h('div',
        h('h2', 'Season Outlook'),
        h('div.sub', `Monte Carlo over the remaining schedule from week ${d.week}. Top ${d.playoffTeams} make the playoffs; the bracket starts week ${d.playoffStartWeek}.`)
      )
    ),

    mine ? h('div.grid.c4.mb',
      h('div.card.accent', stat('Championship odds', pct(mine.titleOdds), { size: 'lg', cls: mine.titleOdds > 0.2 ? 'good' : '' })),
      h('div.card', stat('Playoff odds', pct(mine.playoffOdds), { cls: mine.playoffOdds > 0.6 ? 'good' : mine.playoffOdds < 0.3 ? 'bad' : 'warn' })),
      h('div.card', stat('Expected wins', n1(mine.expectedWins), { delta: `${mine.winsP10} – ${mine.winsP90} range` })),
      h('div.card', stat('Weekly projection', n1(mine.projMean), { delta: `σ ${n1(mine.projSd)}` }))
    ) : null,

    h('div.section-head', h('h3', 'League'), h('span.note', 'sorted by championship probability')),
    h('div.card.tight',
      table(
        ['Team', { label: 'Title', num: true }, { label: 'Playoffs', num: true }, { label: 'Bye', num: true },
          { label: 'xWins', num: true }, { label: 'Range', num: true }, { label: 'Weekly', num: true }, 'Playoff odds'],
        d.standings.map((t) => h('tr', { class: t.is_mine ? 'mine' : '' },
          h('td', h('div.row-flex', h('span', { style: { fontWeight: t.is_mine ? '650' : '500' } }, t.name),
            t.is_mine ? badge('YOU', 'ok') : null)),
          h('td.num', { class: t.titleOdds > 0.15 ? 'good' : '' }, pct(t.titleOdds)),
          h('td.num', pct(t.playoffOdds)),
          h('td.num.mute', pct(t.byeOdds)),
          h('td.num', n1(t.expectedWins)),
          h('td.num.mute', `${t.winsP10}–${t.winsP90}`),
          h('td.num.mute', n1(t.projMean)),
          h('td', { style: { minWidth: '110px' } }, bar(t.playoffOdds, 1, t.playoffOdds > 0.6 ? '' : t.playoffOdds < 0.3 ? 'danger' : 'warn'))
        ))
      )
    ),

    h('div.section-head', h('h3', 'Seed distribution'), h('span.note', 'probability of finishing in each seed')),
    h('div.card.tight',
      table(
        ['Team', ...d.standings.map((_, i) => ({ label: String(i + 1), num: true }))],
        d.standings.map((t) => h('tr', { class: t.is_mine ? 'mine' : '' },
          h('td.small', t.name),
          ...t.seedDist.map((p, i) => h('td.num.xs', {
            style: {
              background: p > 0.01 ? `rgba(77,212,172,${Math.min(0.55, p * 1.5)})` : 'transparent',
              color: p > 0.3 ? 'var(--text)' : 'var(--text-mute)',
            },
          }, p > 0.005 ? Math.round(p * 100) : ''))
        ))
      )
    )
  );
}
