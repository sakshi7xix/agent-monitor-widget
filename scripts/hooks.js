#!/usr/bin/env node
'use strict';
// Adds or removes the widget's hooks in Claude Code's user settings.
//   node scripts/hooks.js install
//   node scripts/hooks.js uninstall
// A backup of settings.json is written next to it before any change.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, hookUrl } = require('../src/config');

const EVENTS = {
  SessionStart: 5,
  UserPromptSubmit: 5,
  PreToolUse: 5,
  PostToolUse: 5,
  PermissionRequest: 600, // held open while you decide in the widget
  Notification: 5,
  Stop: 5,
  SessionEnd: 5,
};

function settingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  return JSON.parse(text); // throw on invalid JSON rather than overwrite it
}

function isOurs(group, url) {
  return Array.isArray(group?.hooks) && group.hooks.some((h) => h?.type === 'http' && h.url === url);
}

function strip(settings, url) {
  if (!settings.hooks || typeof settings.hooks !== 'object') return 0;
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !isOurs(g, url));
    removed += groups.length - kept.length;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function write(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.agent-monitor.bak');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

function install() {
  const cfg = loadConfig();
  const url = hookUrl(cfg);
  const file = settingsPath();
  const settings = readSettings(file);
  strip(settings, url); // replace any older copy of our entries
  settings.hooks = settings.hooks || {};
  for (const [event, timeout] of Object.entries(EVENTS)) {
    settings.hooks[event] = settings.hooks[event] || [];
    settings.hooks[event].push({
      hooks: [{ type: 'http', url, timeout, headers: { 'X-Agent-Monitor-Token': cfg.token } }],
    });
  }
  write(file, settings);
  return { file, events: Object.keys(EVENTS).length };
}

function uninstall() {
  const cfg = loadConfig();
  const file = settingsPath();
  const settings = readSettings(file);
  const removed = strip(settings, hookUrl(cfg));
  if (removed) write(file, settings);
  return { file, removed };
}

function isInstalled() {
  try {
    const cfg = loadConfig();
    const settings = readSettings(settingsPath());
    return Object.values(settings.hooks || {}).some(
      (groups) => Array.isArray(groups) && groups.some((g) => isOurs(g, hookUrl(cfg)))
    );
  } catch {
    return false;
  }
}

module.exports = { install, uninstall, isInstalled, settingsPath, EVENTS };

if (require.main === module) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'install') {
      const r = install();
      console.log(`Added hooks for ${r.events} events to ${r.file}`);
      console.log('Restart any running Claude Code sessions so they pick up the hooks.');
    } else if (cmd === 'uninstall') {
      const r = uninstall();
      console.log(r.removed ? `Removed ${r.removed} hook entries from ${r.file}` : 'No agent monitor hooks found.');
    } else {
      console.log('Usage: node scripts/hooks.js install|uninstall');
      process.exit(1);
    }
  } catch (err) {
    console.error(`Could not update Claude Code settings: ${err.message}`);
    process.exit(1);
  }
}
