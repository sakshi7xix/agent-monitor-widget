'use strict';
// Electron main process: tray icon, the floating widget window, and the local hook server.

const path = require('node:path');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, Notification, dialog } = require('electron');
const { loadConfig } = require('./config');
const { loadState, saveState } = require('./persist');
const { Store } = require('./store');
const { createHookServer } = require('./server');
const hooks = require('../scripts/hooks');

const WIDTH = { compact: 320, expanded: 420 };
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 720;
const MARGIN = 8;

let tray = null;
let win = null;
let pinned = true; // float above other windows; unpinned = hide when you click away
let expanded = false;
let contentHeight = 160; // reported by the widget so the window fits its cards
let userMoved = false; // once dragged, the window stays where the user put it
let hookServer = null;
const store = new Store();
let saveTimer = null;

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saveState(store.serialize());
}

// Called whenever a session changes: redraw, and save shortly after.
function changed() {
  refresh();
  if (!saveTimer) saveTimer = setTimeout(saveNow, 1000);
}

function icon(name) {
  return nativeImage.createFromPath(path.join(__dirname, '..', 'assets', name)).resize({ width: 18, height: 18 });
}

function snapshot() {
  return { sessions: store.snapshot(), hooksInstalled: hooks.isInstalled(), pinned };
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

// Size the window to its content and keep it on screen.
function placeWindow() {
  const width = expanded ? WIDTH.expanded : WIDTH.compact;
  const current = win.getBounds();
  const trayBounds = tray.getBounds();
  const hasTrayBounds = trayBounds.width > 0 && trayBounds.height > 0;

  const display = userMoved
    ? screen.getDisplayMatching(current)
    : hasTrayBounds
      ? screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
      : screen.getPrimaryDisplay();
  const area = display.workArea;
  const height = clamp(contentHeight, MIN_HEIGHT, Math.min(MAX_HEIGHT, area.height - MARGIN * 2));

  let x;
  let y;
  if (userMoved) {
    // keep the top-right corner where the user left it
    x = current.x + current.width - width;
    y = current.y;
  } else if (hasTrayBounds) {
    x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
    // tray at the top of the screen (macOS, some Linux) opens downward, otherwise upward
    y = trayBounds.y < area.y + area.height / 2 ? trayBounds.y + trayBounds.height + 6 : trayBounds.y - height - 6;
  } else {
    x = area.x + area.width - width - MARGIN;
    y = area.y + area.height - height - MARGIN;
  }
  x = clamp(x, area.x + MARGIN, area.x + area.width - width - MARGIN);
  y = clamp(y, area.y + MARGIN, area.y + area.height - height - MARGIN);
  win.setBounds({ x, y, width, height });
}

function showWindow({ focus = true } = {}) {
  placeWindow();
  if (focus) {
    win.show();
    win.focus();
  } else {
    win.showInactive();
  }
}

function toggleWindow() {
  if (win.isVisible()) win.hide();
  else showWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: WIDTH.compact,
    height: contentHeight,
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
  // Float above every window, on every desktop/Space, including full-screen apps.
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });

  // Registered before loading so the first show can never be missed.
  win.once('ready-to-show', () => showWindow({ focus: false }));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('will-move', () => {
    userMoved = true;
  });
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
        label: 'Move back under the tray icon',
        click: () => {
          userMoved = false;
          showWindow();
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
  note.on('click', () => showWindow());
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

    store.restore(loadState());
    hookServer = createHookServer({ store, token: cfg.token, onChange: changed, onPending: notifyPending });
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
    ipcMain.handle('set-height', (_event, value) => {
      const next = Math.round(Number(value));
      if (!Number.isFinite(next) || next === contentHeight) return;
      contentHeight = next;
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
    saveNow();
    if (hookServer) hookServer.close();
  });
}
