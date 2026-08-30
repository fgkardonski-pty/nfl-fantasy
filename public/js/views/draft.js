/**
 * The draft room. VOR, VONA, tiers and survival probability, with a live board
 * you advance pick by pick.
 */
import {
  h, frag, api, loading, errorBox, pct, n1, n2, posEl, badge, table, empty, statusBadge,
} from '../util.js';

/**
 * Draft state survives a page reload.
 *
 * This lives in memory during a session, and a live draft is the one place
 * where losing it hurts: an accidental refresh partway through sixteen rounds
 * would drop every pick marked so far, and there is no way to reconstruct them
 * under a thirty-second clock. Persisted per league so two leagues do not
 * overwrite each other.
 */
const STORE_KEY = 'oracle.draft.v1';

const BLANK = { slot: 1, pick: null, rounds: 16, drafted: [], mine: [], pos: 'ALL' };

function loadState(leagueKey) {
  try {
    const raw = localStorage.getItem(`${STORE_KEY}.${leagueKey}`);
    if (!raw) return { ...BLANK };
    const saved = JSON.parse(raw);
    return {
      ...BLANK,
      ...saved,
      drafted: Array.isArray(saved.drafted) ? saved.drafted : [],
      mine: Array.isArray(saved.mine) ? saved.mine : [],
    };
  } catch { return { ...BLANK }; }
}

function saveState(leagueKey) {
  try {
    localStorage.setItem(`${STORE_KEY}.${leagueKey}`, JSON.stringify({
      slot: state.slot, pick: state.pick, rounds: state.rounds,
      drafted: state.drafted, mine: state.mine, pos: state.pos,
    }));
  } catch { /* private browsing, or storage disabled — the draft still works */ }
}

let state = { ...BLANK };
let storeKey = 'default';

export async function render(root) {
  const league = await api('/api/league').catch(() => null);
  const numTeams = league?.num_teams ?? 12;
  storeKey = league?.league_key ?? 'default';
  state = loadState(storeKey);
  if (state.pick == null) state.pick = state.slot;

  // Held by reference so refresh() can write the live values back into them.
  // Marking a pick advances the clock, and a control bar built once and never
  // updated left that field showing the pick you STARTED on — during a draft,
  // the single number you most need to be able to trust at a glance.
  const pickInput = h('input', {
    type: 'number', min: '1', value: String(state.pick),
    style: { width: '78px' },
    onchange: (e) => { state.pick = Number(e.target.value); refresh(); },
  });
  const resetBtn = h('button.btn.sm', {
    title: 'Clear every marked pick and start over. Use this between practice runs.',
    onclick: () => {
      if (state.drafted.length && !confirm(
        `Reset the draft? This clears all ${state.drafted.length} marked picks and cannot be undone.`
      )) return;
      state.drafted = [];
      state.mine = [];
      state.pick = state.slot;
      // Persist the cleared state BEFORE re-rendering: render() reloads from
      // storage, so skipping this would restore the picks just discarded.
      saveState(storeKey);
      render(root);
    },
  }, 'reset draft');

  // ------------------------------------------------------------------
  // Quick mark
  //
  // In a live draft, and especially against autopick, a rival's pick lands
  // every few seconds. Recording it used to mean typing, waiting out a
  // debounce, waiting for a server round trip, then finding and clicking a
  // button — comfortably longer than the gap between picks, so the board fell
  // behind and started recommending players who were already gone.
  //
  // The whole pool is fetched once and searched in the browser, so results are
  // instant, and the keyboard alone can record a pick: type a few letters and
  // press Enter. The hands never leave the keys and nothing waits on the
  // network before the next name can be typed.
  // ------------------------------------------------------------------
  let pool = [];
  let matches = [];
  let cursor = 0;
  let fuzzy = false;
  const undoStack = [];

  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');

  const searchInput = h('input', {
    type: 'text',
    placeholder: 'type a name, Enter = opp took',
    title: 'Searches the whole pool instantly.\n'
      + 'Enter        mark as taken by an opponent\n'
      + 'Shift+Enter  mark as YOUR pick\n'
      + '↑ ↓          move through matches\n'
      + 'Esc          clear',
    style: { minWidth: '260px' },
    oninput: runSearch,
    onkeydown: onSearchKey,
  });

  const searchResults = h('div', { hidden: true });

  const undoBtn = h('button.btn.sm', {
    title: 'Undo the last mark (Ctrl+Z). Under a pick clock, a mis-click needs to cost seconds, not a reset.',
    disabled: '',
    onclick: undoLast,
  }, 'undo');

  /**
   * What the last keystroke actually did.
   *
   * Enter and Shift+Enter differ only in a modifier, and after the fact both
   * look the same: the player leaves the board either way. Pressing Enter when
   * Shift+Enter was meant hands your pick to a rival, and the only visible
   * difference is a roster count that did not move — easy to miss on the clock,
   * and by then several more picks have gone by. So the last action states
   * itself, in the words that matter: whose player he now is.
   */
  const lastAction = h('div.mb', { hidden: true });

  function showLastAction(entry) {
    if (!entry) { lastAction.hidden = true; lastAction.replaceChildren(); return; }
    lastAction.hidden = false;
    lastAction.replaceChildren(
      h('div.card.tight',
        h('div.row-flex',
          h('span.xs.mute', 'LAST MARK'),
          h('span.pname', entry.name),
          h('span', { class: entry.isMine ? 'good' : 'warnc', style: { fontWeight: '650' } },
            entry.isMine ? '\u2192 YOUR ROSTER' : '\u2192 opponent'),
          h('button.btn.sm', { style: { marginLeft: 'auto' }, onclick: undoLast }, 'undo this'),
          entry.isMine
            ? null
            : h('span.xs.mute', 'Shift+Enter would have made this your pick')
        ))
    );
  }

  const pasteBox = h('textarea', {
    rows: '6',
    placeholder: 'Paste picks, one player per line — useful when autopick has run ahead of you.',
    style: { width: '100%', fontFamily: 'inherit', fontSize: '13px' },
  });
  const pasteReport = h('div.hint');
  const pastePanel = h('div.card.tight.mb', { hidden: true },
    pasteBox,
    h('div.row-flex', { style: { marginTop: '8px' } },
      h('button.btn.sm.primary', { onclick: () => applyPaste(false) }, 'mark all as taken'),
      h('button.btn.sm', { onclick: () => applyPaste(true) }, 'mark all as MY picks'),
      h('button.btn.sm', { onclick: () => { pastePanel.hidden = true; } }, 'close')),
    pasteReport
  );
  /**
   * Write the finished draft into the database.
   *
   * Until this runs the team exists only in this browser, which means every
   * season-long view is blind to it and a cleared cache loses the lot.
   */
  const saveBtn = h('button.btn.sm.primary', {
    title: 'Write your drafted team into the database so the war room, waivers and trades can use it.',
    onclick: async () => {
      if (!state.mine.length) { alert('Nothing marked as yours yet — use Shift+Enter or "I took".'); return; }
      saveBtn.disabled = '';
      saveBtn.textContent = 'saving…';
      try {
        const r = await api('/api/draft/commit', {
          method: 'POST',
          // The draft slot is what turns the pick order into per-seat rosters,
          // so every OTHER team gets saved too rather than only ours.
          body: { mine: state.mine, drafted: state.drafted, slot: state.slot },
        });
        saveBtn.textContent = `saved ${r.saved} \u2713`;

        let extra;
        const o = r.opponents ?? {};
        if (o.teams > 0) {
          extra = `\n\nRebuilt ${o.teams} opponent rosters from the pick order (${o.written} players), so`
            + ' win probability, playoff odds and trades all have a real league to work with.';
        } else if (o.skipped === 'no-draft-order') {
          extra = '\n\nOpponents were NOT saved: the pick order says which SEAT made each pick, but not'
            + ' which manager sat there. Add a "draftOrder" list (seat 1 first) to the league config and'
            + ' save again to fill in all 16 teams.';
        } else if (o.skipped === 'pick-log-inconsistent') {
          const m = o.mismatch ?? {};
          extra = `\n\nOpponents were NOT saved: the pick log does not line up with your own picks`
            + ` (snake order gives seat ${state.slot} ${m.derivedCount} picks, you marked ${m.markedCount}).`
            + ' A pick that was never marked shifts every later pick by one seat, which would hand every'
            + ' team someone else\u2019s roster. Your own team was saved.';
        } else if (o.skipped === 'no-slot') {
          extra = '\n\nOpponents were not saved because no draft slot is set.';
        } else {
          extra = '';
        }

        alert(`Saved ${r.saved} players to ${r.team} for week ${r.week}`
          + ` (${r.starters} starters, ${r.bench} bench).` + extra);
      } catch (err) {
        saveBtn.textContent = 'save team';
        alert('Could not save: ' + (err?.message ?? err));
      } finally { saveBtn.disabled = null; }
    },
  }, 'save team');

  const pasteBtn = h('button.btn.sm', {
    title: 'Catch up in bulk by pasting a list of names.',
    onclick: () => {
      pastePanel.hidden = !pastePanel.hidden;
      if (!pastePanel.hidden) pasteBox.focus();
    },
  }, 'paste picks');

  /**
   * Edit distance, abandoned as soon as it cannot come in under `max`.
   *
   * Only ever used as a FALLBACK. Marking the wrong player is far worse than
   * failing to match one: a wrong mark silently removes a real player from the
   * board and adds someone who is still available, and nothing on screen says
   * so. Exact and substring matching are tried first and always win.
   */
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      let best = i;
      for (let jj = 1; jj <= b.length; jj++) {
        const cost = a[i - 1] === b[jj - 1] ? 0 : 1;
        row[jj] = Math.min(prev[jj] + 1, row[jj - 1] + 1, prev[jj - 1] + cost);
        if (row[jj] < best) best = row[jj];
      }
      if (best > max) return max + 1;      // no path can still get under the cap
      prev = row;
    }
    return prev[b.length];
  }

  /**
   * Closest ranked players to a query that matched nothing exactly.
   *
   * Restricted to players the consensus board ranks: a misspelling is almost
   * always of someone draftable, and it keeps a long paste instant by comparing
   * against roughly five hundred names instead of several thousand.
   */
  function fuzzyMatches(q, taken) {
    if (q.length < 4) return [];           // too short to correct safely
    const max = q.length <= 6 ? 1 : 2;
    const out = [];
    for (const p of pool) {
      if (p.a == null || taken.has(p.i)) continue;
      const n = norm(p.n);
      // Compare against the surname too, since "gibbs" should reach "Jahmyr Gibbs".
      const surname = norm(String(p.n).split(/\s+/).slice(-1)[0]);
      const d = Math.min(editDistance(q, n, max), editDistance(q, surname, max));
      if (d <= max) out.push({ p, d });
    }
    return out.sort((x, y) => x.d - y.d || (x.p.a ?? 1e9) - (y.p.a ?? 1e9));
  }

  function runSearch() {
    const q = norm(searchInput.value);
    matches = [];
    cursor = 0;
    if (q.length >= 2) {
      const taken = new Set(state.drafted);
      for (const p of pool) {
        if (taken.has(p.i)) continue;
        if (norm(p.n).includes(q)) {
          matches.push(p);
          if (matches.length >= 8) break;   // pool is ADP-sorted, so these are the draftable ones
        }
      }
      // Nothing spelled that way — offer the nearest ranked names instead of
      // an empty box, which under a pick clock is the least useful answer.
      if (!matches.length) {
        fuzzy = true;
        matches = fuzzyMatches(q, taken).slice(0, 5).map((m) => m.p);
      } else fuzzy = false;
    } else fuzzy = false;
    renderMatches();
  }

  function renderMatches() {
    if (!matches.length) {
      searchResults.hidden = true;
      searchResults.replaceChildren();
      return;
    }
    searchResults.hidden = false;
    searchResults.replaceChildren(
      h('div.card.tight.mb',
        h('div.xs', { class: fuzzy ? 'warnc' : 'mute', style: { marginBottom: '6px' } },
          fuzzy
            ? 'NO EXACT MATCH \u2014 CLOSEST NAMES, CHECK BEFORE MARKING'
            : 'ENTER = OPP TOOK   \u00b7   SHIFT+ENTER = I TOOK   \u00b7   \u2191\u2193 TO MOVE'),
        ...matches.map((p, i) => h('div.row-flex', {
          style: {
            padding: '4px 6px',
            borderRadius: '4px',
            background: i === cursor ? 'rgba(120,170,255,0.16)' : 'transparent',
            cursor: 'pointer',
          },
          onclick: () => mark(p, false),
        },
        posEl(p.p),
        h('span.pname', p.n),
        h('span.pmeta', p.t || ''),
        h('span.xs.mute', p.a != null ? `ADP ${Math.round(p.a)}` : 'unranked'),
        i === cursor ? h('span.xs.good', { style: { marginLeft: 'auto' } }, '\u21b5 opp took') : null
        ))
      )
    );
  }

  function onSearchKey(e) {
    if (e.key === 'Escape') { searchInput.value = ''; runSearch(); return; }
    if (!matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = (cursor + 1) % matches.length; renderMatches(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); cursor = (cursor - 1 + matches.length) % matches.length; renderMatches(); return; }
    if (e.key === 'Enter') { e.preventDefault(); mark(matches[cursor], e.shiftKey); }
  }

  /** Record one pick. Clears and refocuses immediately so the next name can be typed. */
  function mark(player, isMine) {
    if (!player) return;
    state.drafted.push(player.i);
    if (isMine) state.mine.push(player.i);
    state.pick += 1;
    undoStack.push({ id: player.i, isMine, name: player.n });
    undoBtn.disabled = null;
    showLastAction(undoStack[undoStack.length - 1]);
    searchInput.value = '';
    matches = [];
    renderMatches();
    searchInput.focus();     // stay on the keyboard for the next pick
    refresh();
  }

  function undoLast() {
    const last = undoStack.pop();
    if (!last) return;
    const di = state.drafted.lastIndexOf(last.id);
    if (di >= 0) state.drafted.splice(di, 1);
    if (last.isMine) {
      const mi = state.mine.lastIndexOf(last.id);
      if (mi >= 0) state.mine.splice(mi, 1);
    }
    state.pick = Math.max(1, state.pick - 1);
    const next = undoStack[undoStack.length - 1];
    showLastAction(next);
    if (!next) undoBtn.disabled = '';
    refresh();
  }

  function applyPaste(asMine) {
    const lines = pasteBox.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const taken = new Set(state.drafted);
    const hit = [];
    const missed = [];
    const corrected = [];
    const ambiguous = [];
    for (const line of lines) {
      // Tolerate "12. Bijan Robinson RB ATL" and similar pasted formats.
      const q = norm(line.replace(/^[\d.\s]+/, ''));
      if (q.length < 3) { missed.push(line); continue; }

      let found = pool.find((p) => !taken.has(p.i) && norm(p.n).includes(q))
        ?? pool.find((p) => !taken.has(p.i) && q.includes(norm(p.n)));

      if (!found) {
        // Approximate, and only when it is not a close call. A near-tie means
        // guessing between two real players, and marking the wrong one removes
        // someone still available from the board while adding someone who is
        // not — a mistake nothing on screen would reveal. Better to report it
        // and let a person decide.
        const near = fuzzyMatches(q, taken);
        if (near.length && (near.length === 1 || near[0].d < near[1].d)) {
          found = near[0].p;
          corrected.push(`${line} \u2192 ${found.n}`);
        } else if (near.length) {
          ambiguous.push(`${line} (${near.slice(0, 3).map((m) => m.p.n).join(' / ')})`);
          continue;
        }
      }

      if (!found) { missed.push(line); continue; }
      taken.add(found.i);
      state.drafted.push(found.i);
      if (asMine) state.mine.push(found.i);
      state.pick += 1;
      hit.push(found.n);
    }
    pasteReport.replaceChildren(
      h('div', `Marked ${hit.length}${asMine ? ' as your picks' : ' as taken'}.`),
      // Corrections are shown so they can be eyeballed and undone, never
      // applied silently.
      corrected.length
        ? h('div.warnc', `Spelling corrected (${corrected.length}) — check these: ${corrected.slice(0, 6).join('; ')}${corrected.length > 6 ? ' …' : ''}`)
        : null,
      ambiguous.length
        ? h('div.warnc', `Too close to call, NOT marked (${ambiguous.length}): ${ambiguous.slice(0, 4).join('; ')}`)
        : null,
      missed.length
        ? h('div.warnc', `Not matched (${missed.length}): ${missed.slice(0, 8).join(', ')}${missed.length > 8 ? ' …' : ''}`)
        : null
    );
    pasteBox.value = '';
    refresh();
  }

  // Ctrl/Cmd+Z anywhere on the page, and "/" to jump to the search box.
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoLast(); return; }
    if (e.key === '/' && document.activeElement !== searchInput) { e.preventDefault(); searchInput.focus(); }
  };
  document.addEventListener('keydown', onKey);

  const controls = h('div.row-flex.mb',
    h('label.small.mute', 'Draft slot'),
    h('input', { type: 'number', min: '1', max: String(numTeams), value: String(state.slot),
      style: { width: '68px' },
      onchange: (e) => { state.slot = Number(e.target.value); state.pick = state.slot; state.drafted = []; refresh(); } }),
    h('label.small.mute', 'On the clock'),
    pickInput,
    h('label.small.mute', 'Rounds'),
    h('input', { type: 'number', min: '1', max: '30', value: String(state.rounds),
      style: { width: '68px' },
      onchange: (e) => { state.rounds = Number(e.target.value); refresh(); } }),
    h('button.btn.sm', {
      title: 'Move the clock on one pick WITHOUT recording who went. Marking a player taken already advances it.',
      onclick: () => { state.pick += 1; refresh(); },
    }, 'advance pick →'),
    h('select', {
      title: 'Show only this position on the board. The board is the top players across ALL positions, '
        + 'so the position you still need can drop off it entirely late in a draft.',
      onchange: (e) => { state.pos = e.target.value; refresh(); },
    }, ...['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) =>
      h('option', { value: p, selected: state.pos === p ? '' : null }, p === 'ALL' ? 'all positions' : p))),
    searchInput,
    undoBtn,
    pasteBtn,
    saveBtn,
    resetBtn
  );

  const body = h('div', loading('simulating the draft forward…'));

  root.replaceChildren(
    h('div.page-head',
      h('div',
        h('h2', 'Draft Room'),
        h('div.sub', 'The best pick is not the best player — it is the player whose value will be gone when you are back on the clock.')
      )
    ),
    controls,
    lastAction,
    searchResults,
    pastePanel,
    body
  );

  // Fetch the searchable pool once. The board still decides value; this only
  // has to be enough to FIND a player, so it can be loaded up front and reused
  // for the whole draft.
  api('/api/draft/pool')
    .then((d) => { pool = d.players ?? []; searchInput.placeholder = `search ${d.count} players — Enter = opp took`; })
    .catch(() => { searchInput.placeholder = 'search unavailable — use the board buttons'; });

  // Marks can be entered faster than a board can be drawn, so responses can
  // come back out of order. Without a sequence number the last response to
  // ARRIVE wins rather than the last one asked for, which quietly paints a
  // board that does not match the picks recorded — the one failure here that
  // would not look like a failure.
  let refreshSeq = 0;
  let painted = false;

  // ---- Live sync (Sleeper leagues only) -----------------------------------
  //
  // A Yahoo draft has no public feed, so every pick has to be marked by hand
  // under the clock. Sleeper publishes the picks, which removes that step
  // entirely: the board reads the draft rather than transcribing it.
  //
  // Sleeper's copy is authoritative and simply REPLACES local state. Merging
  // the two would be the dangerous choice — a hand-marked pick that Sleeper
  // does not have is a mistake, not information, and keeping it would shift
  // every later pick by one seat.
  const isSleeper = (league?.league_key ?? '').startsWith('sleeper.');
  let syncTimer = null;
  let syncing = false;

  async function syncFromSleeper({ quiet = false } = {}) {
    if (syncing) return;
    syncing = true;
    if (!quiet) syncBtn.textContent = 'syncing…';
    try {
      const d = await api('/api/draft/sync');
      const changed = d.drafted.length !== state.drafted.length;
      state.drafted = d.drafted;
      state.mine = d.mine;
      if (d.mySeat != null) state.slot = d.mySeat;
      if (d.rounds) state.rounds = d.rounds;
      // Our next pick, from what has actually happened rather than a count we
      // maintained ourselves.
      state.pick = d.made + 1;
      syncBtn.textContent = `synced · ${d.made} picks`;
      syncNote.textContent = d.status === 'drafting'
        ? `live · seat ${d.mySeat ?? '?'} · ${d.type}`
        : `${d.status} · seat ${d.mySeat ?? '?'} · ${d.type}`;
      if (changed || !quiet) await refresh();
    } catch (err) {
      syncBtn.textContent = 'sync picks';
      syncNote.textContent = err?.message ?? 'sync failed';
    } finally {
      syncing = false;
      if (!quiet) setTimeout(() => { syncBtn.textContent = 'sync picks'; }, 2500);
    }
  }

  const syncNote = h('span.note');
  const syncBtn = h('button.btn.sm', {
    title: 'Read the live draft from Sleeper. Replaces the local pick list with Sleeper\u2019s, which is authoritative.',
    onclick: () => syncFromSleeper(),
  }, 'sync picks');

  const autoBox = h('input', { type: 'checkbox', id: 'auto-sync' });
  const autoSync = h('label.small.mute', { for: 'auto-sync', title: 'Poll Sleeper every few seconds while the draft runs.' },
    autoBox, ' auto');
  // Placed into the toolbar here rather than declared with it, because the
  // handlers close over refresh(), which is defined further down. Only shown
  // for a league that actually has a feed — offering a sync button on a Yahoo
  // draft would promise something that does not exist.
  if (isSleeper) toolbar.append(syncBtn, autoSync, syncNote);

  autoBox.addEventListener('change', () => {
    clearInterval(syncTimer);
    syncTimer = null;
    if (autoBox.checked) {
      // Five seconds: fast enough to keep up with a thirty-second clock,
      // slow enough not to hammer a free public API all night.
      syncTimer = setInterval(() => syncFromSleeper({ quiet: true }), 5000);
      syncFromSleeper({ quiet: true });
    }
  });

  // Leaving the view must stop the poll. Without this, switching to another
  // page — or to the other league — leaves a timer hitting a public API every
  // five seconds for the rest of the session.
  window.addEventListener('hashchange', () => {
    clearInterval(syncTimer);
    syncTimer = null;
  }, { once: true });

  async function refresh() {
    // Every control and every mark routes through here, so this is the one
    // place a save has to happen for none to be missed.
    saveState(storeKey);
    // Write state back into the controls that state can change on its own.
    pickInput.value = String(state.pick);
    resetBtn.textContent = state.drafted.length
      ? `reset draft (${state.drafted.length} marked)`
      : 'reset draft';

    const seq = ++refreshSeq;
    // Only the very first draw shows a spinner. After that the previous board
    // stays on screen and dims: tearing the whole thing down and rebuilding it
    // reads as a delay even when the new one arrives in a fifth of a second,
    // and during a draft the old board is still the best answer available
    // until the new one lands.
    if (!painted) body.replaceChildren(loading('simulating the draft forward…'));
    else body.style.opacity = '0.55';

    try {
      const params = new URLSearchParams({
        slot: String(state.slot), pick: String(state.pick),
        rounds: String(state.rounds), limit: '20', sims: '300',
      });
      if (state.drafted.length) params.set('drafted', state.drafted.join(','));
      if (state.mine.length) params.set('mine', state.mine.join(','));
      if (state.pos && state.pos !== 'ALL') params.set('pos', state.pos);
      const d = await api(`/api/draft/board?${params}`);
      if (seq !== refreshSeq) return;            // superseded — a newer mark is in flight
      body.replaceChildren(board(d, numTeams, refresh));
      painted = true;
    } catch (err) {
      if (seq !== refreshSeq) return;
      body.replaceChildren(errorBox(err));
    } finally {
      if (seq === refreshSeq) body.style.opacity = '';
    }
  }
  refresh();
}

function board(d, numTeams, refresh) {
  const top = d.board[0];
  const cov = d.adpCoverage;
  return h('div',
    cov && !cov.sufficient ? h('div.err', { style: { marginBottom: '14px' } },
      h('div', h('strong', 'No draft rankings loaded — this board is not usable yet.')),
      h('div.hint',
        `Only ${cov.ranked} of ${cov.pool} players have a draft ranking, and this league needs at least `
        + `${cov.needed} ranked to tell players apart. Without rankings every player at a position gets `
        + `the SAME value, so the ordering below is meaningless.`),
      h('div.hint', { style: { marginTop: '6px' } },
        'Fix: paste a rankings list into rankings.txt, then run ',
        h('code', 'node bin/oracle.mjs real adp --file rankings.txt'))
    ) : null,
    rosterPanel(d.myRoster, d.need, d.startingSlots),
    top ? h('div.card.accent.mb',
      h('div.spread',
        h('div',
          h('div.xs.mute', 'RECOMMENDED PICK'),
          h('div.row-flex', { style: { marginTop: '5px' } },
            posEl(top.pos),
            h('span', { style: { fontSize: '20px', fontWeight: '650' } }, top.name),
            h('span.pmeta', top.nfl_team ?? ''),
            badge(`tier ${top.tier}`, 'info'),
            statusBadge(top.status)
          )
        ),
        h('div.right',
          h('div.xs.mute', 'SCORE'),
          h('div.mono.good', { style: { fontSize: '23px', fontWeight: '650' } }, n1(top.score))
        )
      ),
      h('div.mt-s', ...top.reasons.map((r) => h('div.small.dim', `· ${r}`)))
    ) : null,

    h('div.section-head', h('h3', 'Board'), h('span.note', 'VONA = value that disappears at this position before your next pick')),
    h('div.card.tight',
      table(
        ['#', 'Player', { label: 'Tier', num: true }, { label: 'Proj', num: true }, { label: 'VOR', num: true },
          { label: 'VONA', num: true }, { label: 'Survives', num: true }, { label: 'ADP', num: true },
          { label: 'Score', num: true }, ''],
        d.board.map((p, i) => h('tr',
          h('td.mute.xs', i + 1),
          h('td', h('div.row-flex', posEl(p.pos), h('span.pname', p.name),
            h('span.xs.mute', `${p.pos}${p.posRank}`), statusBadge(p.status))),
          h('td.num.mute', p.tier),
          h('td.num', n1(p.mean)),
          h('td.num', { class: p.vor > 0 ? 'good' : 'mute' }, n1(p.vor)),
          h('td.num', { class: p.vona > 1.5 ? 'warnc' : 'mute' }, n1(p.vona)),
          h('td.num', { class: p.survivalToNextPick < 0.3 ? 'bad' : 'mute' }, pct(p.survivalToNextPick, 0)),
          h('td.num.mute', p.adp != null ? n1(p.adp) : '—'),
          h('td.num', n1(p.score)),
          h('td.right', h('div.row-flex', { style: { justifyContent: 'flex-end' } },
            h('button.btn.sm.primary', {
              title: 'Mark this player as YOUR pick — feeds roster-need scoring for the rest of the draft',
              onclick: () => {
                state.drafted.push(p.player_id);
                state.mine.push(p.player_id);
                state.pick += 1;
                refresh();
              },
            }, 'I took'),
            h('button.btn.sm', {
              title: 'Mark this player as taken by another team',
              onclick: () => { state.drafted.push(p.player_id); state.pick += 1; refresh(); },
            }, 'opp took')
          ))
        ))
      )
    ),

    h('div.section-head', h('h3', 'Positional scarcity'), h('span.note', 'when startable hits zero, the run has already happened')),
    h('div.grid.c3',
      ...Object.entries(d.scarcity).filter(([, s]) => s.total).map(([pos, s]) => h('div.card.tight',
        h('div.spread', h('div.row-flex', posEl(pos), h('span.small.mute', `${s.total} left`)),
          h('span.mono', n1(s.best))),
        h('div.mt-s.small',
          h('div.spread', h('span.mute', 'startable'), h('span.mono', s.startable)),
          h('div.spread', h('span.mute', 'elite'), h('span.mono', { class: s.elite ? 'good' : 'mute' }, s.elite)),
          h('div.spread', h('span.mute', 'replacement'), h('span.mono', n1(d.replacementLevels[pos] ?? 0))))
      ))
    ),

  );
}

/**
 * My roster and what it still needs, in one panel.
 *
 * These are the same question asked two ways — what I have, and what that
 * leaves missing — and they were on opposite ends of a long page, so answering
 * "what should I be looking for now" meant scrolling between them. Under a
 * thirty-second clock that is the difference between using the tool and
 * ignoring it. Kept at the top for the same reason.
 */
function rosterPanel(myRoster, need, startingSlots) {
  const order = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const byPos = new Map(order.map((p) => [p, []]));
  for (const p of myRoster ?? []) {
    if (!byPos.has(p.pos)) byPos.set(p.pos, []);
    byPos.get(p.pos).push(p);
  }
  const open = Object.entries(need ?? {}).filter(([, v]) => v > 0.05);
  const count = myRoster?.length ?? 0;

  return frag(
    h('div.section-head',
      h('h3', `Your roster (${count})`),
      h('span.note', open.length
        ? 'red means a starting slot is still empty'
        : 'every starting slot is filled')),
    h('div.card.tight.mb',
      count
        ? h('div.row-flex', { style: { flexWrap: 'wrap', rowGap: '6px' } },
          ...[...byPos.entries()]
            .filter(([, list]) => list.length)
            .map(([pos, list]) => h('div.row-flex', { style: { marginRight: '16px' } },
              posEl(pos),
              ...list.map((p) => badge(p.name, 'ok'))
            )))
        : h('div.small.mute', 'Nothing marked yet. Use "I took" on the board when you make a pick.'),
      open.length
        ? h('div.mt-s',
          h('div.xs.mute', 'STILL NEEDED'),
          h('div.row-flex', { style: { marginTop: '4px', flexWrap: 'wrap', rowGap: '6px' } },
            ...open.map(([pos, v]) => badge(`${pos} ${n2(v)}`, v >= 1 ? 'bad' : 'warn'))))
        : null,
      // Flex slots have no row of their own, because no single position owns
      // one. Showing the lineup makes clear they are accounted for and explains
      // why the counts above are fractional rather than whole.
      flexNote(startingSlots)
    )
  );
}

/**
 * The league's starting lineup, with the flex slots called out.
 *
 * "Still needed" is per POSITION, but a flex slot belongs to no single
 * position — its demand is split across whichever positions may fill it. That
 * split is why the counts are fractional, and without seeing the slots a
 * reader reasonably concludes the flex has been ignored.
 */
function flexNote(startingSlots) {
  const slots = Array.isArray(startingSlots) ? startingSlots : [];
  if (!slots.length) return null;
  const flex = slots.filter((s) => String(s).includes('/'));
  return h('div.mt-s',
    h('div.xs.mute', 'STARTING LINEUP'),
    h('div.row-flex', { style: { marginTop: '4px', flexWrap: 'wrap', rowGap: '6px' } },
      ...slots.map((s) => badge(String(s), String(s).includes('/') ? 'info' : null))),
    flex.length
      ? h('div.hint', { style: { marginTop: '6px' } },
        `${flex.join(' and ')} ${flex.length > 1 ? 'are flex slots' : 'is a flex slot'} — `
        + 'their demand is split across the positions eligible to fill them, which is why the '
        + 'counts above are fractional rather than whole.')
      : null
  );
}

