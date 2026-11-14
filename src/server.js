'use strict';
// Local HTTP endpoint that Claude Code's "http" hooks post to.
// Activity events are answered straight away. A PermissionRequest is held open
// until the widget calls decide(), and the answer is sent back as the hook result.

const http = require('node:http');

const MAX_BODY = 2 * 1024 * 1024;

function createHookServer({ store, token, onChange = () => {}, onPending = () => {} }) {
  const waiters = new Map(); // pendingId -> { res, suggestions }

  function send(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  function handleEvent(evt, res) {
    const before = new Set([...waiters.keys()]);
    const pending = store.apply(evt);

    // PostToolUse / SessionEnd can clear requests; release their held connections.
    const stillPending = new Set(store.snapshot().flatMap((s) => s.pending.map((p) => p.id)));
    for (const id of before) {
      if (!stillPending.has(id)) {
        const w = waiters.get(id);
        waiters.delete(id);
        if (w && !w.res.writableEnded) send(w.res, 200, {});
      }
    }

    if (!pending) {
      send(res, 200, {});
      onChange();
      return;
    }

    waiters.set(pending.id, { res, suggestions: evt.permission_suggestions });
    res.on('close', () => {
      // Claude Code gave up on this hook (answered in the terminal, timed out, or exited).
      if (waiters.delete(pending.id)) {
        store.resolvePending(pending.id, 'answered elsewhere');
        onChange();
      }
    });
    onChange();
    onPending(pending);
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/hook') return send(res, 404, { error: 'not found' });
    if (req.headers['x-agent-monitor-token'] !== token) return send(res, 401, { error: 'bad token' });

    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        send(res, 413, { error: 'too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let evt;
      try {
        evt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, { error: 'invalid json' });
      }
      if (!evt || typeof evt !== 'object') return send(res, 400, { error: 'invalid event' });
      handleEvent(evt, res);
    });
  });

  // behavior: 'allow' | 'deny'. options.always adds Claude Code's suggested "always allow" rule.
  // options.message is passed to Claude as the reason for a denial.
  function decide(pendingId, behavior, options = {}) {
    const waiter = waiters.get(pendingId);
    if (!waiter) return false;
    waiters.delete(pendingId);

    const decision = { behavior: behavior === 'allow' ? 'allow' : 'deny' };
    if (decision.behavior === 'allow' && options.always && Array.isArray(waiter.suggestions)) {
      decision.updatedPermissions = waiter.suggestions;
    }
    if (decision.behavior === 'deny') {
      decision.message = String(options.message || 'Denied from the agent monitor widget.').slice(0, 2000);
    }
    send(waiter.res, 200, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
    store.resolvePending(pendingId, decision.behavior === 'allow' ? 'approved in widget' : 'denied in widget');
    onChange();
    return true;
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    });
  }

  function close() {
    for (const w of waiters.values()) if (!w.res.writableEnded) send(w.res, 200, {});
    waiters.clear();
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, decide, listen, close };
}

module.exports = { createHookServer };
