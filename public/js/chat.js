/**
 * The "Ask" panel: a conversation with the assistant about the app's own
 * recommendations. Opens from a floating button on every page, or from a
 * "Why?" link beside any recommendation, which asks the question for you.
 *
 * The server holds the real conversation (it must stay append-only); this
 * keeps only what is needed to redraw the panel after navigating, per league,
 * for the life of the browser tab.
 */
import { h, fill, getLeague } from './util.js';

const store = () => `oracle.chat.${getLeague()}`;
function load() {
  try { return JSON.parse(sessionStorage.getItem(store()) ?? 'null') ?? { conversationId: null, turns: [] }; }
  catch { return { conversationId: null, turns: [] }; }
}
function save(state) { try { sessionStorage.setItem(store(), JSON.stringify(state)); } catch { /* private mode */ } }

let panel, log, input, sendBtn, busy = false;
let state = load();

/** Minimal, escaped markdown: paragraphs, **bold**, and - / 1. lists. */
function render(text) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const out = [];
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) {
      const ordered = /^\s*\d/.test(line);
      if (!list || list.ordered !== ordered) { if (list) out.push(list.close); list = { ordered, close: ordered ? '</ol>' : '</ul>' }; out.push(ordered ? '<ol>' : '<ul>'); }
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    if (list) { out.push(list.close); list = null; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(list.close);
  return out.join('');
}

function bubble(role, text) {
  const el = h(`div.chat-msg.${role}`);
  if (role === 'assistant') el.innerHTML = render(text); else el.textContent = text;
  return el;
}

function redraw() {
  fill(log, state.turns.length
    ? state.turns.map((t) => bubble(t.role, t.text))
    : h('div.chat-empty',
        h('p', 'Ask about any recommendation, player or matchup. For example:'),
        ...['Why should I make the first move on my list?', 'Is it worth starting Michael Mayer over Harold Fannin?', 'Who is the best tight end I could pick up?']
          .map((q) => h('button.chat-suggest', { onclick: () => send(q) }, q))));
  log.scrollTop = log.scrollHeight;
}

function build() {
  input = h('textarea.chat-input', {
    rows: 2, placeholder: 'Ask why…',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } },
  });
  sendBtn = h('button.btn.primary.sm', { onclick: () => send(input.value) }, 'Ask');
  log = h('div.chat-log');
  panel = h('aside.chat-panel', { hidden: true },
    h('div.chat-head',
      h('div', h('b', 'Ask the app'), h('div.xs.mute', 'answers use this league’s current data')),
      h('div.row-flex',
        h('button.btn.sm', { title: 'Start over with fresh league data', onclick: () => { state = { conversationId: null, turns: [] }; save(state); redraw(); } }, 'New chat'),
        h('button.btn.sm', { onclick: () => toggle(false), 'aria-label': 'Close' }, '✕'))),
    log,
    h('div.chat-compose', input, sendBtn));
  document.body.append(panel,
    h('button.chat-fab', { onclick: () => toggle(), title: 'Ask the app why' }, 'Ask why?'));
  redraw();
}

export function toggle(open = panel.hidden) {
  panel.hidden = !open;
  if (open) { redraw(); input.focus(); }
}

/** Open the panel and ask a question on the user's behalf. */
export function askAbout(question) {
  toggle(true);
  send(question);
}

async function send(text) {
  const question = String(text ?? '').trim();
  if (!question || busy) return;
  busy = true; sendBtn.disabled = true; input.value = '';
  state.turns.push({ role: 'user', text: question });
  redraw();
  const answer = { role: 'assistant', text: '' };
  const live = bubble('assistant', '');
  const status = h('div.chat-status', h('span.spinner'), ' thinking…');
  log.append(live, status);
  log.scrollTop = log.scrollHeight;

  try {
    const league = getLeague();
    const res = await fetch(`/api/chat${league ? `?league=${encodeURIComponent(league)}` : ''}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: state.conversationId, message: question }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error([err.error, err.hint].filter(Boolean).join(' ') || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e.type === 'start') {
          // A restarted server forgets conversations; say so rather than
          // silently answering without the earlier context.
          if (e.fresh && state.conversationId && state.turns.length > 1) {
            log.insertBefore(h('div.chat-note', 'Started a new conversation (the server was restarted).'), live);
          }
          state.conversationId = e.conversationId;
        } else if (e.type === 'text') {
          answer.text += e.delta;
          live.innerHTML = render(answer.text);
          status.hidden = true;
        } else if (e.type === 'tool') {
          status.hidden = false;
          fill(status, h('span.spinner'), ({ lookup_player: ' looking up a player…', best_available: ' checking who’s available…', get_team: ' reading another team’s roster…', trade_ideas: ' looking for trades…' })[e.name] ?? ' checking…');
        } else if (e.type === 'error') {
          throw new Error(e.message);
        }
        log.scrollTop = log.scrollHeight;
      }
    }
  } catch (err) {
    answer.text += `${answer.text ? '\n\n' : ''}⚠ ${err.message}`;
    live.innerHTML = render(answer.text);
  } finally {
    status.remove();
    state.turns.push(answer);
    save(state);
    busy = false; sendBtn.disabled = false;
    input.focus();
  }
}

/** A small "Why?" link that asks the assistant about one recommendation. */
export function whyLink(question) {
  return h('a.why-ask', { href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); askAbout(question); } }, 'Why?');
}

build();
