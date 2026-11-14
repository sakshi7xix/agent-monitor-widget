'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { createHookServer } = require('../src/server');

const TOKEN = 'test-token-0123456789';

async function setup() {
  const store = new Store();
  const hook = createHookServer({ store, token: TOKEN });
  const port = await hook.listen(0);
  const post = (body, { token = TOKEN, signal } = {}) =>
    fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': token },
      body: JSON.stringify(body),
      signal,
    });
  return { store, hook, post };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('rejects requests without the token', async () => {
  const { hook, post, store } = await setup();
  const res = await post({ session_id: 'a', hook_event_name: 'SessionStart' }, { token: 'nope' });
  assert.equal(res.status, 401);
  assert.equal(store.snapshot().length, 0);
  await hook.close();
});

test('tracks activity for a session', async () => {
  const { hook, post, store } = await setup();
  await post({ session_id: 'a', hook_event_name: 'SessionStart', cwd: '/work/shop', model: 'opus', source: 'startup' });
  await post({ session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'fix the rounding bug' });
  const res = await post({
    session_id: 'a',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: 't1',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});

  const [session] = store.snapshot();
  assert.equal(session.title, 'shop');
  assert.equal(session.model, 'opus');
  assert.equal(session.status, 'running');
  assert.equal(session.log.at(-1).text, '$ npm test');
  await hook.close();
});

test('holds a permission request until it is accepted', async () => {
  const { hook, post, store } = await setup();
  const waiting = post({
    session_id: 'a',
    hook_event_name: 'PermissionRequest',
    cwd: '/work/shop',
    tool_name: 'Edit',
    tool_input: { file_path: 'src/totals.ts', old_string: 'return a;', new_string: 'return round(a);' },
  });
  await tick();

  const [session] = store.snapshot();
  assert.equal(session.status, 'needs');
  assert.equal(session.pending.length, 1);
  assert.equal(session.pending[0].summary, 'edit src/totals.ts');
  assert.deepEqual(session.pending[0].preview.lines, [
    { sign: '-', text: 'return a;' },
    { sign: '+', text: 'return round(a);' },
  ]);

  assert.equal(hook.decide(session.pending[0].id, 'allow'), true);
  const body = await (await waiting).json();
  assert.deepEqual(body, {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  assert.equal(store.snapshot()[0].pending.length, 0);
  assert.equal(store.snapshot()[0].status, 'running');
  await hook.close();
});

test('deny passes the message back, always-allow passes the suggested rule', async () => {
  const { hook, post, store } = await setup();
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run build' }], behavior: 'allow', destination: 'localSettings' }];
  const request = { session_id: 'a', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm run build' }, permission_suggestions: suggestions };

  const first = post(request);
  await tick();
  hook.decide(store.snapshot()[0].pending[0].id, 'deny', { message: 'use pnpm instead' });
  assert.deepEqual((await (await first).json()).hookSpecificOutput.decision, { behavior: 'deny', message: 'use pnpm instead' });

  const second = post(request);
  await tick();
  const pending = store.snapshot()[0].pending[0];
  assert.equal(pending.canAlwaysAllow, true);
  hook.decide(pending.id, 'allow', { always: true });
  assert.deepEqual((await (await second).json()).hookSpecificOutput.decision, { behavior: 'allow', updatedPermissions: suggestions });
  await hook.close();
});

test('clears a request when Claude Code drops the connection', async () => {
  const { hook, post, store } = await setup();
  const controller = new AbortController();
  const waiting = post(
    { session_id: 'a', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } },
    { signal: controller.signal }
  ).catch(() => 'aborted');
  await tick();
  assert.equal(store.needsCount(), 1);
  controller.abort();
  assert.equal(await waiting, 'aborted');
  await tick(60);
  assert.equal(store.needsCount(), 0);
  assert.equal(hook.decide('1', 'allow'), false);
  await hook.close();
});

test('clears a request when the tool runs anyway', async () => {
  const { hook, post, store } = await setup();
  const input = { command: 'ls' };
  const waiting = post({ session_id: 'a', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input });
  await tick();
  assert.equal(store.needsCount(), 1);
  await post({ session_id: 'a', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: input, tool_use_id: 't1' });
  assert.deepEqual(await (await waiting).json(), {});
  assert.equal(store.needsCount(), 0);
  await hook.close();
});
