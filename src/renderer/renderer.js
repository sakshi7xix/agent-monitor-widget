'use strict';
// Draws the widget from the state the main process sends.
// Everything from Claude Code is set with textContent, never as HTML.

const api = window.agentMonitor;
const list = document.getElementById('list');
const summary = document.getElementById('summary');
const sync = document.getElementById('sync');
const expandBtn = document.getElementById('expand');
const pinBtn = document.getElementById('pin');

let expanded = false;
let pinned = false;
const drafts = new Map(); // pendingId -> unsent reply text

const SVG = 'http://www.w3.org/2000/svg';
const FACES = {
  // [x, y, width, height] rectangles on a 36px grid
  needs: [[8, 12, 4, 6], [24, 12, 4, 6], [14, 22, 8, 4]],
  running: [[8, 16, 6, 2], [22, 16, 6, 2], [14, 24, 8, 2]],
  idle: [[9, 14, 4, 4], [23, 14, 4, 4], [14, 24, 8, 2]],
  done: [[8, 16, 2, 2], [10, 14, 2, 2], [12, 16, 2, 2], [22, 16, 2, 2], [24, 14, 2, 2], [26, 16, 2, 2], [12, 22, 2, 2], [14, 24, 8, 2], [22, 22, 2, 2]],
};
const CHIP = { needs: 'needs you', running: 'running', idle: 'idle', done: 'done' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function avatar(session) {
  const wrap = el('div', `avatar ${session.status}`);
  wrap.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', '36');
  svg.setAttribute('height', '36');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('shape-rendering', 'crispEdges');
  for (const [x, y, w, h] of FACES[session.status] || FACES.idle) {
    const rect = document.createElementNS(SVG, 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', w);
    rect.setAttribute('height', h);
    svg.appendChild(rect);
  }
  wrap.appendChild(svg);
  if (session.status === 'needs') wrap.appendChild(el('span', 'dot'));
  const tile = el('span', 'tile');
  tile.style.background = session.color;
  wrap.appendChild(tile);
  return wrap;
}

function ago(ms) {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function diffBlock(preview) {
  const box = el('div', 'diff');
  box.appendChild(el('div', 'file', preview.file));
  for (const line of preview.lines) {
    box.appendChild(el('div', `line ${line.sign === '+' ? 'add' : 'del'}`, `${line.sign === '+' ? '+' : '−'} ${line.text}`));
  }
  if (preview.more > 0) box.appendChild(el('div', 'more', `${preview.more} more lines`));
  return box;
}

function pendingBlock(pending) {
  const frag = document.createDocumentFragment();
  frag.appendChild(el('div', 'well', pending.summary));
  if (expanded && pending.preview) frag.appendChild(diffBlock(pending.preview));

  const actions = el('div', 'actions');
  const deny = el('button', 'btn', 'Deny');
  deny.addEventListener('click', () => api.decide(pending.id, 'deny', {}));
  actions.appendChild(deny);
  if (pending.canAlwaysAllow) {
    const always = el('button', 'btn', 'Always allow');
    always.addEventListener('click', () => api.decide(pending.id, 'allow', { always: true }));
    actions.appendChild(always);
  }
  const accept = el('button', 'btn primary', 'Accept');
  accept.addEventListener('click', () => api.decide(pending.id, 'allow', {}));
  actions.appendChild(accept);
  frag.appendChild(actions);

  if (expanded) {
    const form = el('form', 'reply');
    const inputId = `reply-${pending.id}`;
    const label = el('label', 'sr-only', 'Deny and tell the agent what to do instead');
    label.htmlFor = inputId;
    const input = el('input');
    input.id = inputId;
    input.type = 'text';
    input.placeholder = '> deny and say what to do instead';
    input.value = drafts.get(pending.id) || '';
    input.addEventListener('input', () => drafts.set(pending.id, input.value));
    const send = el('button');
    send.type = 'submit';
    send.setAttribute('aria-label', 'Deny with this message');
    send.textContent = '↑';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const message = input.value.trim();
      if (!message) return;
      drafts.delete(pending.id);
      api.decide(pending.id, 'deny', { message });
    });
    form.append(label, input, send);
    frag.appendChild(form);
  }
  return frag;
}

function card(session) {
  const node = el('section', 'card');
  const head = el('div', 'head');
  head.appendChild(avatar(session));

  const who = el('div', 'who');
  who.appendChild(el('h2', '', session.title));
  const last = session.log[session.log.length - 1];
  const meta = ['claude code'];
  if (session.model) meta.push(session.model);
  if (!expanded && session.pending.length === 0 && last) meta.push(last.text);
  else meta.push(ago(session.startedAt));
  who.appendChild(el('p', '', meta.join(' · ')));
  head.appendChild(who);
  head.appendChild(el('span', `chip ${session.status}`, CHIP[session.status] || session.status));
  node.appendChild(head);

  if (expanded && session.log.length) {
    const log = el('ol', 'log');
    for (const entry of session.log.slice(-5)) {
      const item = el('li');
      item.append(el('span', '', clock(entry.t)), el('span', '', entry.text));
      log.appendChild(item);
    }
    node.appendChild(log);
  }

  if (expanded && session.lastMessage && session.pending.length === 0) {
    node.appendChild(el('span', 'label', 'last message'));
    node.appendChild(el('p', 'said', session.lastMessage));
  }

  for (const pending of session.pending) node.appendChild(pendingBlock(pending));
  return node;
}

function emptyState(hooksInstalled) {
  const box = el('div', 'empty');
  if (hooksInstalled) {
    box.appendChild(el('span', '', 'No Claude Code sessions yet. Start one in a terminal and it will show up here.'));
  } else {
    box.appendChild(el('span', '', 'Claude Code is not sending activity here yet.'));
    const btn = el('button', 'btn', 'Add hooks to Claude Code');
    btn.addEventListener('click', () => api.installHooks());
    box.appendChild(btn);
  }
  return box;
}

function render(state) {
  const sessions = state.sessions || [];
  const active = sessions.filter((s) => s.status !== 'done').length;
  const needs = sessions.reduce((n, s) => n + s.pending.length, 0);
  summary.textContent = sessions.length ? `${active} active · ${needs} awaiting approval` : 'waiting for sessions';
  sync.textContent = `updated ${clock(Date.now())}`;

  // keep focus and scroll position across redraws
  const focusedId = document.activeElement && document.activeElement.id;
  const scroll = list.scrollTop;
  list.replaceChildren(...(sessions.length ? sessions.map(card) : [emptyState(state.hooksInstalled)]));
  list.scrollTop = scroll;
  if (focusedId) {
    const again = document.getElementById(focusedId);
    if (again && again !== document.activeElement) again.focus();
  }
}

expandBtn.addEventListener('click', async () => {
  expanded = !expanded;
  expandBtn.setAttribute('aria-pressed', String(expanded));
  expandBtn.setAttribute('aria-label', expanded ? 'Collapse to compact view' : 'Expand to see activity');
  await api.setExpanded(expanded);
  render(await api.getState());
});

pinBtn.addEventListener('click', async () => {
  pinned = await api.setPinned(!pinned);
  pinBtn.setAttribute('aria-pressed', String(pinned));
});

api.onState(render);
api.getState().then(render);
