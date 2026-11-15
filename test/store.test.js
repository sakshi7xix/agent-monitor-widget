'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');

const MIN = 60 * 1000;

function clockStore() {
  const clock = { t: 1_000_000_000_000 };
  return { clock, store: new Store({ now: () => clock.t }) };
}

test('drops idle sessions after 30 minutes and brings them back on activity', () => {
  const { clock, store } = clockStore();
  store.apply({ session_id: 'a', hook_event_name: 'SessionStart', cwd: '/work/shop' });
  clock.t += 29 * MIN;
  assert.equal(store.snapshot().length, 1);
  clock.t += 2 * MIN;
  assert.equal(store.snapshot().length, 0);

  store.apply({ session_id: 'a', hook_event_name: 'UserPromptSubmit', cwd: '/work/shop', prompt: 'hello again' });
  const [session] = store.snapshot();
  assert.equal(session.title, 'shop');
  assert.equal(session.status, 'running');
});

test('keeps a session that is waiting on the user, however long', () => {
  const { clock, store } = clockStore();
  store.apply({ session_id: 'a', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
  clock.t += 5 * 60 * MIN;
  assert.equal(store.snapshot().length, 1);
  assert.equal(store.snapshot()[0].status, 'needs');
});

test('keeps a running session for 2 hours of silence, then drops it', () => {
  const { clock, store } = clockStore();
  store.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'make' } });
  clock.t += 90 * MIN;
  assert.equal(store.snapshot().length, 1);
  clock.t += 31 * MIN;
  assert.equal(store.snapshot().length, 0);
});

test('restores saved sessions as idle, without pending requests', () => {
  const { clock, store } = clockStore();
  store.apply({ session_id: 'a', hook_event_name: 'SessionStart', cwd: '/work/shop', model: 'opus' });
  store.apply({ session_id: 'a', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
  store.apply({ session_id: 'b', hook_event_name: 'PreToolUse', cwd: '/work/blog', tool_name: 'Read', tool_input: { file_path: 'a.md' } });
  store.apply({ session_id: 'c', hook_event_name: 'SessionEnd', cwd: '/work/old' });
  const saved = JSON.parse(JSON.stringify(store.serialize()));

  clock.t += 5 * MIN;
  const next = new Store({ now: () => clock.t });
  assert.equal(next.restore(saved), 3);
  const byId = Object.fromEntries(next.snapshot().map((s) => [s.id, s]));
  assert.equal(byId.a.status, 'idle');
  assert.equal(byId.a.pending.length, 0);
  assert.equal(byId.a.model, 'opus');
  assert.equal(byId.b.status, 'idle');
  assert.equal(byId.b.log.at(-1).text, 'read a.md');
  assert.equal(byId.c.status, 'done');
  assert.equal(next.needsCount(), 0);
});

test('restore skips sessions that went stale while the widget was closed', () => {
  const { clock, store } = clockStore();
  store.apply({ session_id: 'a', hook_event_name: 'SessionStart', cwd: '/work/shop' });
  const saved = JSON.parse(JSON.stringify(store.serialize()));
  clock.t += 45 * MIN;
  const next = new Store({ now: () => clock.t });
  assert.equal(next.restore(saved), 0);
});

test('restore ignores bad data', () => {
  const store = new Store();
  for (const bad of [null, 'x', {}, { version: 2, sessions: [] }, { version: 1, sessions: [null, { id: 5 }, {}] }]) {
    assert.equal(store.restore(bad), 0);
  }
});

test('state file round trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-'));
  process.env.AGENT_MONITOR_HOME = dir;
  const { loadState, saveState, statePath } = require('../src/persist');
  assert.equal(loadState(), null);
  assert.equal(saveState({ version: 1, sessions: [] }), true);
  assert.deepEqual(loadState(), { version: 1, sessions: [] });
  fs.writeFileSync(statePath(), '{not json');
  assert.equal(loadState(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
