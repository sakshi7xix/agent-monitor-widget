'use strict';
// Saves the session list to ~/.agent-monitor/state.json so it survives a restart of the widget.

const fs = require('node:fs');
const path = require('node:path');
const { configDir } = require('./config');

function statePath() {
  return path.join(configDir(), 'state.json');
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return null; // no file yet, or unreadable: start with an empty list
  }
}

function saveState(data) {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    const tmp = statePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, statePath());
    return true;
  } catch {
    return false; // saving is best effort; the widget keeps working without it
  }
}

module.exports = { loadState, saveState, statePath };
