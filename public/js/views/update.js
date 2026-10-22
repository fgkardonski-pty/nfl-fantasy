/**
 * Update rosters from screenshots — for a league the app cannot sync yet.
 *
 * Paste or drop screenshots of the league platform, review what was read, tick
 * what is right, apply. The review step is the feature: a misread name applied
 * blind would corrupt every recommendation built on the roster it lands in.
 */
import { h, fill, api, loading, errorBox, badge, posEl, empty } from '../util.js';

// Wide screenshots are scaled down by width only: a tall Recent Moves capture
// squeezed to fit a height limit would shrink every name past legibility.
const MAX_WIDTH = 1800;

export async function render(root) {
  fill(root, loading());
  let status;
  try { status = await api('/api/import/status'); }
  catch (err) { fill(root, errorBox(err)); return; }

  const head = h('div.page-head', h('div',
    h('h2', 'Update rosters from screenshots'),
    h('div.sub', 'Until Yahoo’s API is connected, this is how the app learns about adds, drops and lineup changes.')));

  if (!status.available) {
    return fill(root, head, empty('◇', 'This league syncs automatically', 'Screenshot updates are only for leagues entered by hand from a league file.'));
  }
  if (!status.readerEnabled) {
    return fill(root, head, errorBox({ message: 'Reading screenshots needs an Anthropic API key.', hint: 'Set ANTHROPIC_API_KEY in .env and restart the server.' }));
  }

  const images = [];
  const thumbs = h('div.shot-thumbs');
  const review = h('div');
  const readBtn = h('button.btn.primary', { disabled: true, onclick: () => read() }, 'Read screenshots');

  const addFile = (file) => {
    if (!file?.type?.startsWith('image/')) return;
    downscale(file).then((dataUrl) => {
      images.push(dataUrl);
      const idx = images.length - 1;
      thumbs.append(h('div.shot-thumb',
        h('img', { src: dataUrl, alt: `Screenshot ${idx + 1}` }),
        h('button.shot-remove', { title: 'Remove', onclick: (e) => { images[idx] = null; e.target.parentNode.remove(); sync(); } }, '✕')));
      sync();
    });
  };
  const sync = () => {
    const n = images.filter(Boolean).length;
    readBtn.disabled = !n;
    readBtn.textContent = n ? `Read ${n} screenshot${n === 1 ? '' : 's'}` : 'Read screenshots';
  };

  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true,
    onchange: (e) => { [...e.target.files].forEach(addFile); e.target.value = ''; } });
  const drop = h('div.drop-zone', {
    tabindex: 0,
    onclick: () => fileInput.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); [...e.dataTransfer.files].forEach(addFile); },
  },
  h('div.drop-big', 'Paste with Ctrl+V, drag screenshots here, or click to choose files'),
  h('div.small.mute', 'Works with Yahoo’s Recent Moves page, matchup pages (full rosters and records) and waiver-report emails. Several at once is fine.'));

  // Snipping Tool copies to the clipboard, so pasting is the fast path.
  const onPaste = (e) => {
    if (!root.isConnected) { document.removeEventListener('paste', onPaste); return; }
    [...(e.clipboardData?.items ?? [])].filter((i) => i.type.startsWith('image/')).forEach((i) => addFile(i.getAsFile()));
  };
  document.addEventListener('paste', onPaste);

  async function read() {
    const batch = images.filter(Boolean);
    readBtn.disabled = true;
    fill(review, loading(`reading ${batch.length} screenshot${batch.length === 1 ? '' : 's'}… this takes about a minute`));
    try {
      const proposal = await api('/api/import/screenshots', { method: 'POST', body: { images: batch.map((dataUrl) => ({ dataUrl })) } });
      fill(review, reviewList(proposal, status.week));
    } catch (err) { fill(review, errorBox(err)); }
    sync();
  }

  fill(root, head,
    h('div.card', drop, fileInput, thumbs, h('div.row-flex.mt', readBtn,
      h('span.small.mute', 'Nothing changes until you review and apply.'))),
    review);
}

/** The proposed changes, each with a checkbox; problems are shown but cannot be ticked. */
function reviewList(p, week) {
  const ready = p.changes.filter((c) => c.status === 'ready');
  const boxes = new Map();
  const result = h('div');
  const weekBox = h('input', { type: 'checkbox' });
  const applyBtn = h('button.btn.primary', { onclick: async () => {
    const chosen = p.changes.filter((c) => boxes.get(c.id)?.checked);
    if (!chosen.length && !weekBox.checked) return;
    applyBtn.disabled = true;
    fill(result, loading('updating the league…'));
    try {
      const r = await api('/api/import/apply', { method: 'POST', body: { changes: chosen, currentWeek: weekBox.checked ? week + 1 : null } });
      fill(result, h('div.card.accent.mt',
        h('div.todo-title', `✓ League updated — ${r.applied.length} change${r.applied.length === 1 ? '' : 's'}`),
        h('ul.small.dim', r.applied.map((x) => h('li', x))),
        r.unmatched?.length ? h('div.small.warnc', `Not matched to a player: ${r.unmatched.join(', ')}`) : null,
        h('a.btn.mt-s', { href: '#/warroom' }, 'See this week’s plan →')));
    } catch (err) { fill(result, errorBox(err)); applyBtn.disabled = false; }
  } }, 'Apply ticked changes');

  const row = (c) => {
    const box = h('input', { type: 'checkbox', checked: c.status === 'ready' || null, disabled: c.status === 'problem' || null });
    boxes.set(c.id, box);
    return h('label.todo', { class: c.status === 'ready' ? '' : 'done' },
      box,
      h('div.todo-body',
        h('div.todo-title',
          h('b', c.team ?? c.readAs.team ?? 'Unknown team'),
          c.kind === 'move' ? moveText(c) : rosterText(c),
          c.status === 'already' ? badge('ALREADY IN APP', 'dim') : c.status === 'problem' ? badge('NEEDS A LOOK', 'warn') : null),
        c.note ? h('div.small', { class: c.status === 'problem' ? 'warnc' : 'dim' }, c.note) : null));
  };

  return h('div',
    h('div.section-head', h('h3', 'What the screenshots show'),
      h('span.note', `${ready.length} change${ready.length === 1 ? '' : 's'} ready · untick anything that looks wrong`)),
    p.screenshots.length ? h('div.small.mute.mb', p.screenshots.map((s, i) => `${i + 1}. ${s.summary}`).join('  ·  ')) : null,
    p.changes.length ? h('div.card.todos', ...p.changes.map(row)) : empty('◇', 'No roster changes found in these screenshots'),
    p.notes.length ? h('div.explainer.mt', h('b', 'Couldn’t read everything: '), p.notes.join(' ')) : null,
    h('label.row-flex.mt.small', weekBox, `Also move the league to week ${week + 1} (do this once the week’s games are over)`),
    h('div.row-flex.mt', applyBtn),
    result);
}

function moveText(c) {
  return [
    c.add ? [h('span.verb.add', 'ADD'), ' ', posEl(c.add.pos), ' ', c.add.name] : null,
    c.drop ? [h('span.verb.drop', 'DROP'), ' ', posEl(c.drop.pos), ' ', c.drop.name] : null,
    !c.add && !c.drop ? h('span.mute', `${c.readAs.add ?? ''} ${c.readAs.drop ?? ''}`) : null,
    c.fromTeam ? h('span.small.mute', `(from ${c.fromTeam})`) : null,
  ];
}

function rosterText(c) {
  const parts = [];
  if (c.added.length) parts.push(`+ ${c.added.join(', ')}`);
  if (c.removed.length) parts.push(`− ${c.removed.join(', ')}`);
  if (c.record) parts.push(`record ${c.record.wins}-${c.record.losses}${c.record.ties ? `-${c.record.ties}` : ''}`);
  return h('span.dim', ` roster${parts.length ? ': ' + parts.join(' · ') : ' and lineup slots'}`);
}

/** Scale very large screenshots down: smaller uploads, same legibility. */
function downscale(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_WIDTH / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
