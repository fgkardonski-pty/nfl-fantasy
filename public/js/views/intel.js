/**
 * Rivals — how every team in the league stacks up, and what each is short of.
 *
 * Built around what can actually be known. Roster strength is computed from
 * the rosters, so it always shows. Manager behaviour — who churns the wire, who
 * trades, who has checked out — is read from the transaction log, so it shows
 * only when there is a log to read; without one every trait was a row of 0.00
 * bars and every manager "disengaged", which is noise dressed as intelligence.
 */
import {
  h, fill, frag, api, loading, errorBox, pct, n1, money, posEl, badge, table, bar,
} from '../util.js';

export async function render(root) {
  fill(root, loading('sizing up every roster…'));
  let d;
  try { d = await api('/api/intel'); }
  catch (err) { fill(root, errorBox(err)); return; }

  const teams = d.dossiers;
  // A server started before roster strength existed answers without it, and
  // every team then ties on nothing — which ranked us first by accident.
  if (teams.length && teams.every((t) => t.seasonProj == null)) {
    return fill(root, errorBox({
      message: 'The server is running an older version of the app, so team strength is missing.',
      hint: 'Restart it (Ctrl+C, then node bin/oracle.mjs serve) and reload this page.',
    }));
  }
  const top = Math.max(...teams.map((t) => t.seasonProj ?? 0), 1);
  const ranked = [...teams].sort((a, b) => (b.seasonProj ?? 0) - (a.seasonProj ?? 0));
  const rankOf = new Map(ranked.map((t, i) => [t.team_key, i + 1]));
  const me = teams.find((t) => t.is_mine);

  fill(root,
    h('div.page-head',
      h('div',
        h('h2', 'Rivals'),
        h('div.sub', 'How strong every roster is, and who each team is missing this week.'))),

    me ? h('div.explainer',
      h('b', `Your roster ranks ${rankOf.get(me.team_key)} of ${teams.length}`),
      ` on a typical week (${n1(me.seasonProj)} points from your best lineup). `,
      ranked[0] && !ranked[0].is_mine ? `The strongest is ${ranked[0].name} at ${n1(ranked[0].seasonProj)}.` : 'Nobody’s roster is stronger.') : null,

    h('div.section-head', h('h3', 'Every team, strongest roster first'),
      h('span.note', '“Typical week” is each team’s best lineup on a normal week; “This week” includes byes and matchups')),
    h('div.card.tight', table(
      ['#', 'Team', 'Record', { label: 'Typical week', num: true }, '', { label: 'This week', num: true }, 'Best players', 'Out this week'],
      ranked.map((t) => h('tr', { class: t.is_mine ? 'mine' : '' },
        h('td.mono.mute', rankOf.get(t.team_key)),
        h('td', h('div', h('span', { style: { fontWeight: t.is_mine ? '650' : '550' } }, t.name), t.is_mine ? frag(' ', badge('YOU', 'ok')) : null),
          h('div.xs.mute', t.manager ?? '')),
        h('td.mono', `${t.record.wins}-${t.record.losses}${t.record.ties ? `-${t.record.ties}` : ''}`),
        h('td.num', n1(t.seasonProj)),
        h('td', { style: { minWidth: '90px' } }, bar(t.seasonProj ?? 0, top, t.is_mine ? '' : 'blue')),
        h('td.num', n1(t.weekProj)),
        h('td.small', (t.starPlayers ?? []).map((p) => p.name).join(', ')),
        h('td', (t.claims?.holes ?? []).length
          ? h('div.row-flex', ...t.claims.holes.slice(0, 3).map((x) => badge(`${x.name} · ${x.reason}`, 'bad')))
          : h('span.xs.mute', 'none'))
      ))
    )),

    d.hasActivity
      ? behaviour(teams)
      : h('div.explainer.mt',
          h('b', 'Manager tendencies aren’t shown yet. '),
          'Who chases waivers, who trades and who has stopped paying attention all come from the league’s transaction history. A league entered by hand doesn’t have one. Once Yahoo is connected, each team gets a scouting report here.'),
  );
}

/** Scouting reports, for leagues with a transaction log to read them from. */
function behaviour(teams) {
  return frag(
    h('div.section-head', h('h3', 'Scouting reports'), h('span.note', 'read from each manager’s transaction history')),
    h('div.grid.c2', ...teams.filter((t) => !t.is_mine).map((t) => h('div.card',
      h('div.spread',
        h('span', { style: { fontWeight: '650' } }, t.name),
        badge(t.archetype.label, 'purple')),
      h('div.small.dim.mt-s', t.archetype.note),
      h('div.small.mute.mt-s', `${t.counts.adds} adds · ${t.counts.trades} trades · last active ${t.daysSinceActive == null ? 'never' : `${n1(t.daysSinceActive)} days ago`}${t.faab?.remaining ? ` · ${money(t.faab.remaining)} FAAB left` : ''}`),
      t.claims?.predictions?.length ? h('div.mt-s',
        h('div.xs.mute', `LIKELY TO CLAIM (${pct(t.claims.willAct, 0)} chance they make a move this week)`),
        ...t.claims.predictions.map((p) => h('div.row-flex.small', posEl(p.pos), p.name, h('span.mute', pct(p.probability, 0))))) : null,
      t.poach?.length ? h('div.mt-s',
        h('div.xs.mute', 'TRADE TARGETS ON THIS ROSTER'),
        ...t.poach.map((p) => h('div.small', h('div.row-flex', posEl(p.pos), p.name), h('div.xs.mute', p.reasons.join('; '))))) : null,
    ))));
}
