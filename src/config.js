'use strict';
// Shared settings for the app and the hook installer.
// Stored in ~/.agent-monitor/config.json so both always agree on port + token.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_PORT = 47821;

function configDir() {
  return process.env.AGENT_MONITOR_HOME || path.join(os.homedir(), '.agent-monitor');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    // first run, or unreadable file: fall through and recreate
  }
  let changed = false;
  if (!Number.isInteger(cfg.port)) {
    cfg.port = DEFAULT_PORT;
    changed = true;
  }
  if (typeof cfg.token !== 'string' || cfg.token.length < 16) {
    cfg.token = crypto.randomBytes(24).toString('hex');
    changed = true;
  }
  if (changed) {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  }
  return cfg;
}

function hookUrl(cfg) {
  return `http://127.0.0.1:${cfg.port}/hook`;
}

module.exports = { loadConfig, configPath, hookUrl, DEFAULT_PORT };
