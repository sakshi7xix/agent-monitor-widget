#!/usr/bin/env node
'use strict';
// Checks each link between Claude Code and the widget and says which one is broken.
//   npm run doctor

const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { loadConfig, hookUrl } = require('../src/config');
const hooks = require('./hooks');

const ok = (msg) => console.log(`  OK    ${msg}`);
const bad = (msg) => console.log(`  FAIL  ${msg}`);
const info = (msg) => console.log(`  ..    ${msg}`);

function run(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).toString().trim();
  } catch {
    return null;
  }
}

(async () => {
  let failures = 0;
  const cfg = loadConfig();
  const url = hookUrl(cfg);

  console.log('\nAgent monitor check\n');
  info(`widget code version: ${run('git rev-parse --short HEAD') || 'unknown'}`);
  info(`node ${process.version} on ${process.platform}`);

  // 1. Is the widget app running?
  let running = false;
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(3000) });
    running = res.ok;
  } catch {
    running = false;
  }
  if (running) ok(`widget app is running on port ${cfg.port}`);
  else {
    failures++;
    bad(`widget app is not running on port ${cfg.port}. Start it with "npm start" and leave that terminal open.`);
  }

  // 2. Are the hooks in Claude Code's settings, and the right kind?
  const file = hooks.settingsPath();
  let settings = null;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    failures++;
    bad(`cannot read ${file} (${err.code || err.message}). Run "npm run install-hooks".`);
  }
  if (settings) {
    const missing = [];
    const wrong = [];
    for (const event of Object.keys(hooks.EVENTS)) {
      const ours = (settings.hooks?.[event] || [])
        .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
        .filter((h) => h?.url === url || (typeof h?.command === 'string' && h.command.includes(url)));
      if (ours.length === 0) missing.push(event);
      else if (event === 'SessionStart' && !ours.some((h) => h.type === 'command')) wrong.push(event);
    }
    if (missing.length || wrong.length) {
      failures++;
      if (missing.length) bad(`hooks missing for: ${missing.join(', ')}`);
      if (wrong.length) bad('SessionStart hook is the old kind, which Claude Code does not accept');
      console.log('        Fix: run "npm run install-hooks", then restart your Claude Code sessions.');
    } else {
      ok(`hooks for all ${Object.keys(hooks.EVENTS).length} events are in ${file}`);
    }
    if (settings.disableAllHooks) {
      failures++;
      bad('"disableAllHooks" is set in your Claude Code settings, so no hooks run.');
    }
  }

  // 3. Tools the hooks rely on
  if (run('curl --version')) ok('curl is available');
  else {
    failures++;
    bad('curl was not found. New sessions will only appear after their first message.');
  }
  const claude = run('claude --version');
  if (claude) info(`claude code version: ${claude}`);
  else info('"claude" command not found in this terminal (fine if you only use the desktop app)');

  // 4. Send a test session straight to the widget
  if (running) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Monitor-Token': cfg.token },
        body: JSON.stringify({
          session_id: 'doctor-test',
          hook_event_name: 'UserPromptSubmit',
          cwd: '/doctor-test',
          prompt: 'test from npm run doctor',
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) ok('sent a test session. A card named "doctor-test" should be in the widget now.');
      else {
        failures++;
        bad(`widget refused the test session (HTTP ${res.status}). Quit the widget, start it again, and re-run this.`);
      }
    } catch (err) {
      failures++;
      bad(`could not send the test session (${err.message})`);
    }
  }

  console.log('');
  if (failures === 0) {
    console.log('Everything checks out on this side.');
    console.log('If you see the "doctor-test" card but not your real sessions, restart those Claude Code sessions.');
    console.log('If you do not see the "doctor-test" card, the problem is in the widget window itself.');
  } else {
    console.log(`${failures} problem(s) found. Fix the FAIL lines above and run this again.`);
  }
  console.log('');
  process.exit(failures ? 1 : 0);
})();
