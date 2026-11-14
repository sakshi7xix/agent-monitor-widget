'use strict';
// In-memory state for every Claude Code session the hooks have told us about.
// No Electron in here, so it can be tested with plain Node.

const path = require('node:path');

const MAX_LOG = 40;
const DONE_TTL_MS = 10 * 60 * 1000;
const PALETTE = ['#FF4D8D', '#3D9BFF', '#B6F23C', '#FF9A1F', '#2EE6D6', '#FFE14D'];
const STATUS_ORDER = { needs: 0, running: 1, idle: 2, done: 3 };

function colorFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function clip(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Bash':
      return `$ ${clip(i.command, 120)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `edit ${clip(i.file_path || i.notebook_path, 120)}`;
    case 'Write':
      return `write ${clip(i.file_path, 120)}`;
    case 'Read':
      return `read ${clip(i.file_path, 120)}`;
    case 'Grep':
      return `grep ${clip(i.pattern, 100)}`;
    case 'Glob':
      return `glob ${clip(i.pattern, 100)}`;
    case 'WebFetch':
      return `fetch ${clip(i.url, 120)}`;
    case 'WebSearch':
      return `search ${clip(i.query, 100)}`;
    case 'Task':
    case 'Agent':
      return `subagent ${clip(i.description, 100)}`;
    default:
      return clip(name || 'tool', 60);
  }
}

// A few lines of the proposed change, for Edit and Write requests.
function diffPreview(name, input, maxLines = 6) {
  const i = input && typeof input === 'object' ? input : {};
  const lines = [];
  const push = (sign, text) => {
    for (const line of String(text ?? '').split('\n')) lines.push({ sign, text: clip(line, 200) || '' });
  };
  if (name === 'Edit' && (i.old_string != null || i.new_string != null)) {
    push('-', i.old_string);
    push('+', i.new_string);
  } else if (name === 'Write' && i.content != null) {
    push('+', i.content);
  } else {
    return null;
  }
  return {
    file: clip(i.file_path, 200),
    lines: lines.slice(0, maxLines),
    more: Math.max(0, lines.length - maxLines),
  };
}

class Store {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.sessions = new Map();
    this.nextPendingId = 1;
  }

  ensure(evt) {
    const id = String(evt.session_id || 'unknown');
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        title: '',
        cwd: '',
        model: '',
        color: colorFor(id),
        status: 'running',
        startedAt: this.now(),
        lastActivity: this.now(),
        lastMessage: '',
        log: [],
        pending: [],
      };
      this.sessions.set(id, s);
    }
    if (evt.cwd) s.cwd = String(evt.cwd);
    if (evt.session_title) s.title = clip(evt.session_title, 60);
    if (!s.title && s.cwd) s.title = path.basename(s.cwd) || s.cwd;
    if (typeof evt.model === 'string' && evt.model) s.model = clip(evt.model, 40);
    s.lastActivity = this.now();
    return s;
  }

  log(session, text) {
    session.log.push({ t: this.now(), text });
    if (session.log.length > MAX_LOG) session.log.splice(0, session.log.length - MAX_LOG);
  }

  settle(session) {
    if (session.pending.length > 0) session.status = 'needs';
    else if (session.status === 'needs') session.status = 'running';
  }

  // Apply one hook event. Returns the pending request it created, if any.
  apply(evt) {
    const s = this.ensure(evt);
    switch (evt.hook_event_name) {
      case 'SessionStart':
        s.status = 'idle';
        this.log(s, `session ${evt.source || 'started'}`);
        break;
      case 'UserPromptSubmit':
        s.status = 'running';
        this.log(s, `prompt: ${clip(evt.prompt, 100)}`);
        break;
      case 'PreToolUse':
        s.status = 'running';
        this.log(s, describeTool(evt.tool_name, evt.tool_input));
        break;
      case 'PostToolUse':
        // The tool ran, so any request we were still showing for it was answered elsewhere.
        this.dropMatching(s, evt.tool_name, evt.tool_input);
        s.status = 'running';
        break;
      case 'PermissionRequest': {
        const pending = {
          id: String(this.nextPendingId++),
          sessionId: s.id,
          toolName: clip(evt.tool_name, 60),
          summary: describeTool(evt.tool_name, evt.tool_input),
          preview: diffPreview(evt.tool_name, evt.tool_input),
          canAlwaysAllow: Array.isArray(evt.permission_suggestions) && evt.permission_suggestions.length > 0,
          inputKey: JSON.stringify(evt.tool_input ?? null),
          createdAt: this.now(),
        };
        s.pending.push(pending);
        this.log(s, `needs approval: ${pending.summary}`);
        this.settle(s);
        return pending;
      }
      case 'Notification':
        if (evt.message) this.log(s, clip(evt.message, 120));
        if (evt.notification_type === 'idle_prompt') s.status = s.pending.length ? 'needs' : 'idle';
        break;
      case 'Stop':
        if (evt.last_assistant_message) s.lastMessage = clip(evt.last_assistant_message, 400);
        s.status = s.pending.length ? 'needs' : 'idle';
        this.log(s, 'finished turn');
        break;
      case 'SessionEnd':
        s.pending = [];
        s.status = 'done';
        s.endedAt = this.now();
        this.log(s, 'session ended');
        break;
      default:
        break;
    }
    this.settle(s);
    return null;
  }

  dropMatching(session, toolName, toolInput) {
    const key = JSON.stringify(toolInput ?? null);
    const dropped = session.pending.filter((p) => p.toolName === toolName && p.inputKey === key);
    session.pending = session.pending.filter((p) => !dropped.includes(p));
    return dropped.map((p) => p.id);
  }

  // Remove a pending request once it is answered or abandoned.
  resolvePending(pendingId, note) {
    for (const s of this.sessions.values()) {
      const idx = s.pending.findIndex((p) => p.id === pendingId);
      if (idx === -1) continue;
      const [p] = s.pending.splice(idx, 1);
      if (note) this.log(s, `${note}: ${p.summary}`);
      this.settle(s);
      return p;
    }
    return null;
  }

  prune() {
    const cutoff = this.now() - DONE_TTL_MS;
    for (const [id, s] of this.sessions) {
      if (s.status === 'done' && (s.endedAt || 0) < cutoff) this.sessions.delete(id);
    }
  }

  snapshot() {
    this.prune();
    return [...this.sessions.values()]
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity)
      .map((s) => ({
        id: s.id,
        title: s.title || 'session',
        cwd: s.cwd,
        model: s.model,
        color: s.color,
        status: s.status,
        startedAt: s.startedAt,
        lastActivity: s.lastActivity,
        lastMessage: s.lastMessage,
        log: s.log.slice(-8),
        pending: s.pending.map(({ inputKey, ...rest }) => rest),
      }));
  }

  needsCount() {
    let n = 0;
    for (const s of this.sessions.values()) n += s.pending.length;
    return n;
  }
}

module.exports = { Store, describeTool, diffPreview, colorFor };
