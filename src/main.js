'use strict';
// Electron main process: tray icon, the widget window, and the local hook server.

const path = require('node:path');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, Notification, dialog } = require('electron');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { createHookServer } = require('./server');
const hooks = require('../scripts/hooks');

const SIZE = { compact: { width: 380, height: 640 }, expanded: { width: 460, height: 780 } };

let tray = null;
let win = null;
let pinned = false;
let expanded = false;
let hookServer = null;
const store = new Store();

function icon(name) {
  return nativeImage.createFromPath(path.join(__dirname, '..', 'assets', name)).resize({ width: 18, height: 18 });
}

function snapshot() {
  return { sessions: store.snapshot(), hooksInstalled: hooks.isInstalled() };
}

function refresh() {
  const needs = store.needsCount();
  if (tray) {
    tray.setImage(icon(needs ? 'tray-alert.png' : 'tray.png'));
    tray.setToolTip(needs ? `Agents: ${needs} waiting on you` : 'Agents: nothing waiting');
    if (process.platform === 'darwin') tray.setTitle(needs ? ` ${needs}` : '');
  }
  if (win && !win.isDestroyed()) win.webContents.send('state', snapshot());
}

function placeWindow() {
  const { width, height } = expanded ? SIZE.expanded : SIZE.compact;
  const trayBounds = tray.getBounds();
  const hasTrayBounds = trayBounds.width > 0 && trayBounds.height > 0;
  const display = hasTrayBounds
    ? screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const h = Math.min(height, area.height - 16);

  let x = area.x + area.width - width - 8;
  let y = area.y + area.height - h - 8;
  if (hasTrayBounds) {
    x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
    // tray at the top of the screen (macOS, some Linux) opens downward, otherwise upward
    y = trayBounds.y < area.y + area.height / 2 ? trayBounds.y + trayBounds.height + 6 : trayBounds.y - h - 6;
  }
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8));
  y = Math.max(area.y + 8, Math.min(y, area.y + area.height - h - 8));
  win.setBounds({ x, y, width, height: h });
}

function showWindow() {
  placeWindow();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win.isVisible()) win.hide();
  else showWindow();
}

function createWindow() {
  win = new BrowserWindow({
    ...SIZE.compact,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('blur', () => {
    if (!pinned) win.hide();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function installHooksFromMenu() {
  try {
    const result = hooks.install();
    dialog.showMessageBox({
      type: 'info',
      message: 'Hooks added',
      detail: `Updated ${result.file}.\nRestart any running Claude Code sessions so they pick up the hooks.`,
    });
  } catch (err) {
    dialog.showErrorBox('Could not add hooks', err.message);
  }
  refresh();
}

function removeHooksFromMenu() {
  try {
    const result = hooks.uninstall();
    dialog.showMessageBox({
      type: 'info',
      message: result.removed ? 'Hooks removed' : 'No hooks found',
      detail: result.file,
    });
  } catch (err) {
    dialog.showErrorBox('Could not remove hooks', err.message);
  }
  refresh();
}

function createTray() {
  tray = new Tray(icon('tray.png'));
  tray.on('click', toggleWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show / hide widget', click: toggleWindow },
      {
        label: 'Keep on top when unfocused',
        type: 'checkbox',
        checked: pinned,
        click: (item) => {
          pinned = item.checked;
        },
      },
      { type: 'separator' },
      { label: 'Add hooks to Claude Code', click: installHooksFromMenu },
      { label: 'Remove hooks from Claude Code', click: removeHooksFromMenu },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function notifyPending(pending) {
  if (win.isVisible() || !Notification.isSupported()) return;
  const note = new Notification({ title: 'An agent needs you', body: pending.summary, silent: false });
  note.on('click', showWindow);
  note.show();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win && showWindow());

  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    const cfg = loadConfig();

    createWindow();
    createTray();

    hookServer = createHookServer({ store, token: cfg.token, onChange: refresh, onPending: notifyPending });
    try {
      await hookServer.listen(cfg.port);
    } catch (err) {
      dialog.showErrorBox(
        'Agent monitor could not start',
        `Port ${cfg.port} is not available (${err.code || err.message}). Change "port" in ~/.agent-monitor/config.json, then add the hooks again.`
      );
      app.quit();
      return;
    }

    ipcMain.handle('get-state', () => snapshot());
    ipcMain.handle('decide', (_event, pendingId, behavior, options) =>
      hookServer.decide(String(pendingId), behavior === 'allow' ? 'allow' : 'deny', {
        always: Boolean(options?.always),
        message: typeof options?.message === 'string' ? options.message : '',
      })
    );
    ipcMain.handle('set-expanded', (_event, value) => {
      expanded = Boolean(value);
      placeWindow();
    });
    ipcMain.handle('set-pinned', (_event, value) => {
      pinned = Boolean(value);
      return pinned;
    });
    ipcMain.handle('install-hooks', () => {
      installHooksFromMenu();
      return hooks.isInstalled();
    });

    // keep "12m" style timers and finished-session cleanup moving
    setInterval(refresh, 30 * 1000);
    refresh();
  });

  app.on('window-all-closed', () => {
    // tray app: stay alive with no visible window
  });

  app.on('before-quit', () => {
    if (hookServer) hookServer.close();
  });
}
