/** Shared helpers for the war room. No framework — just precise DOM building. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Minimal hyperscript. h('div.card', {onclick}, child, child) */
export function h(spec, props, ...children) {
  const [tagAndId, ...classes] = String(spec).split('.');
  const [tag, id] = tagAndId.split('#');
  const el = document.createElement(tag || 'div');
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  } else if (props != null) {
    children.unshift(props);
  }
  append(el, children);
  return el;
}

function append(el, kids) {
  for (const k of kids.flat(6)) {
    if (k == null || k === false) continue;
    el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const frag = (...kids) => { const f = document.createDocumentFragment(); append(f, kids); return f; };

// ---- Formatting -----------------------------------------------------------

export const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`);
export const n1 = (x) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(1));
export const n2 = (x) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(2));
export const n0 = (x) => (x == null || Number.isNaN(x) ? '—' : Math.round(Number(x)).toString());
export const money = (x) => (x == null ? '—' : `$${Math.round(x)}`);
export const signed = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`);

export const ago = (ts) => {
  if (!ts) return 'never';
  const s = (Date.now() - Number(ts)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** Colour class for a probability where higher is better. */
export const probClass = (p) => (p >= 0.6 ? 'good' : p <= 0.4 ? 'bad' : 'warnc');

export const posEl = (pos) => h(`span.pos.${pos}`, pos);

export const badge = (text, kind = 'dim') => h(`span.badge.${kind}`, text);

/** Injury designation badge, or nothing when healthy. */
export function statusBadge(status) {
  if (!status) return null;
  const map = { Q: 'warn', D: 'bad', O: 'bad', IR: 'bad', PUP: 'bad', SUSP: 'bad', P: 'dim', COV: 'warn' };
  return badge(status, map[status] ?? 'dim');
}

// ---- API ------------------------------------------------------------------

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error ?? `Request failed (${res.status})`);
    err.hint = data?.hint;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---- Building blocks ------------------------------------------------------

export const loading = (label = 'computing…') => h('div.loading', h('span.spinner'), label);

export function errorBox(err) {
  return h('div.err',
    h('div', err.message ?? String(err)),
    err.hint ? h('div.hint', err.hint) : null
  );
}

export function empty(icon, text, sub) {
  return h('div.empty', h('div.big', icon), h('div', text), sub ? h('div.small.mute.mt-s', sub) : null);
}

export function stat(label, value, { cls = '', delta = null, size = '' } = {}) {
  return h('div.stat',
    h('div.label', label),
    h(`div.value${size ? '.' + size : ''}${cls ? '.' + cls : ''}`, value),
    delta ? h('div.delta', delta) : null
  );
}

export function table(headers, rows) {
  return h('div.tbl-wrap',
    h('table',
      h('thead', h('tr', headers.map((hd) =>
        h(typeof hd === 'object' && hd.num ? 'th.num' : 'th', typeof hd === 'object' ? hd.label : hd)))),
      h('tbody', rows)
    )
  );
}

/** Horizontal proportion bar. */
export function bar(value, max, kind = '') {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return h('div.bar', h(`i${kind ? '.' + kind : ''}`, { style: { width: `${w}%` } }));
}

/** SVG donut for win probability. */
export function dial(p, caption = 'win probability') {
  const size = 132, stroke = 11, r = (size - stroke) / 2, circ = 2 * Math.PI * r;
  const color = p >= 0.6 ? 'var(--win)' : p <= 0.4 ? 'var(--lose)' : 'var(--warn)';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.innerHTML =
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--bg-3)" stroke-width="${stroke}"/>` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
       stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - Math.max(0, Math.min(1, p)))}"
       style="transition:stroke-dashoffset .6s cubic-bezier(.4,0,.2,1)"/>`;
  return h('div.dial', svg,
    h('div.readout',
      h('div.pc', { style: { color } }, pct(p)),
      h('div.cap', caption)
    )
  );
}

/** Floor–mean–ceiling range visualisation. */
export function rangeBar(floor, mean, ceiling, scaleMax) {
  const max = scaleMax || Math.max(ceiling * 1.05, 1);
  const l = (floor / max) * 100;
  const w = ((ceiling - floor) / max) * 100;
  const m = (mean / max) * 100;
  return h('div.range',
    h('div.fill', { style: { left: `${l}%`, width: `${Math.max(w, 1)}%` } }),
    h('div.mark', { style: { left: `${m}%` } })
  );
}

/** A click-to-expand explanation block. */
export function why(label, buildBody) {
  const body = h('div.why-body');
  let built = false;
  const toggle = h('span.why.small.mute', { onclick: () => {
    if (!built) { body.appendChild(buildBody()); built = true; }
    body.classList.toggle('open');
  } }, label);
  return frag(toggle, body);
}
