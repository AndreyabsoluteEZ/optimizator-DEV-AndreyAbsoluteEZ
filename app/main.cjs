'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { readFile, writeFile, rename, rm, stat } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const os = require('node:os');
const windows = require('./windows.cjs');
const { validateExe, validateState } = require('./domain.cjs');

const entry = path.join(__dirname, 'ui', 'index.html');
const entryUrl = pathToFileURL(entry).href;
const isWindows = process.platform === 'win32';
const settings = {
  gaming: 'ms-settings:gaming-gamemode',
  graphics: 'ms-settings:display-advancedgraphics'
};
let window;
let state;
let stateError;
let pendingChange = false;
let pendingPing = false;
let games = new Map();
let backgroundExe;
let cpuBefore = cpuTimes();

function cpuTimes() {
  return os.cpus().reduce(({ idle, total }, cpu) => ({
    idle: idle + cpu.times.idle,
    total: total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
  }), { idle: 0, total: 0 });
}

function telemetry() {
  const current = cpuTimes();
  const elapsed = current.total - cpuBefore.total;
  const busy = elapsed > 0 ? 1 - (current.idle - cpuBefore.idle) / elapsed : 0;
  cpuBefore = current;
  const total = os.totalmem();
  const used = total - os.freemem();
  return { cpu: Math.max(0, Math.min(100, Math.round(busy * 100))), used, total };
}

function statePath() {
  return path.join(app.getPath('userData'), 'restore.json');
}

async function loadState() {
  try {
    state = validateState(JSON.parse(await readFile(statePath(), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') state = { version: 1 };
    else stateError = 'Файл восстановления недоступен. Изменения заблокированы. ' + statePath();
  }
  if (!isWindows || !state) return;
  const [qos, priority] = await Promise.all([
    state.qos ? windows.qosStatus(state.qos) : Promise.resolve('absent'),
    state.priority ? windows.priorityStillSet(state.priority) : Promise.resolve(false)
  ]);
  const expired = {};
  if (state.qos && qos === 'absent') expired.qos = null;
  if (state.priority && !priority) expired.priority = null;
  if (Object.keys(expired).length) await saveState(expired).catch(console.error);
}

async function saveState(changes) {
  const next = validateState({ ...state, ...changes });
  const temporary = statePath() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2), { flush: true });
    await rename(temporary, statePath());
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error('Не удалось записать файл восстановления.');
  }
  state = next;
}

function currentState() {
  const { profile, priority, qos } = state || {};
  return {
    profile: profile ? (profile.complete ? 'active' : 'pending') : 'off',
    planChanged: Boolean(profile?.plan),
    priority: priority ? { file: priority.file, complete: priority.complete } : null,
    qos: qos ? { file: qos.file, rate: qos.rate, complete: qos.complete } : null,
    platform: isWindows,
    stateError: stateError || null,
    version: app.getVersion(),
    os: isWindows && Number(os.release().split('.')[2]) >= 22000 ? 'Windows 11' : 'Windows 10'
  };
}

function requireWindows() {
  if (!isWindows) throw new Error('Функция доступна в Windows 10 и 11.');
}

async function mutate(action) {
  requireWindows();
  if (stateError) throw new Error(stateError);
  if (pendingChange) throw new Error('Дождитесь окончания текущей операции.');
  pendingChange = true;
  try {
    return await action();
  } finally {
    pendingChange = false;
  }
}

async function setProfile(enable) {
  if (enable === true && !state.profile) {
    const snapshot = await windows.getProfile();
    await saveState({ profile: snapshot });
    try {
      await windows.applyProfile(snapshot);
      await saveState({ profile: { ...snapshot, complete: true } });
    } catch (error) {
      const recovery = error.unchanged ? Promise.resolve() : windows.restoreProfile(snapshot);
      await recovery.then(() => saveState({ profile: null })).catch(() => {});
      throw error;
    }
  } else if (enable === false && state.profile) {
    await windows.restoreProfile(state.profile);
    await saveState({ profile: null });
  }
  return currentState();
}

async function priority(enable, selection) {
  if (enable === false && state.priority) {
    await windows.setPriority(state.priority, true);
    await saveState({ priority: null });
  } else if (enable === true && !state.priority) {
    const game = games.get(selection);
    if (!game) throw new Error('Выберите запущенную игру из списка.');
    if (['AboveNormal', 'High', 'RealTime'].includes(game.before)) {
      throw new Error('У выбранного процесса уже повышенный приоритет.');
    }
    const { id, start, file, before } = game;
    const snapshot = { id, start, file, before, complete: false };
    await saveState({ priority: snapshot });
    try {
      await windows.setPriority(snapshot);
      await saveState({ priority: { ...snapshot, complete: true } });
    } catch (error) {
      const recovery = error.unchanged ? Promise.resolve() : windows.setPriority(snapshot, true);
      await recovery.then(() => saveState({ priority: null })).catch(() => {});
      throw error;
    }
  }
  return currentState();
}

async function qos(enable, rate) {
  if (enable === false && state.qos) {
    if (await windows.qosStatus(state.qos) !== 'absent') await windows.changeQos(state.qos, true);
    await saveState({ qos: null });
  } else if (enable === true && !state.qos) {
    if (!backgroundExe) throw new Error('Выберите .exe фонового приложения.');
    if (!Number.isInteger(rate) || rate < 1 || rate > 100) throw new Error('Введите целое число от 1 до 100 Мбит/с.');
    if (!(await stat(backgroundExe).catch(() => null))?.isFile()) throw new Error('Выбранный файл больше не доступен.');
    if (!await windows.hasQos()) throw new Error('Модуль NetQos недоступен в этой Windows.');
    if (process.execPath.toLowerCase() === backgroundExe.toLowerCase()) {
      throw new Error('Выберите фоновое приложение, например клиент синхронизации.');
    }

    const snapshot = {
      name: 'AbsoluteOptimizer-' + randomUUID().replaceAll('-', ''),
      rate, file: backgroundExe, complete: false
    };
    await saveState({ qos: snapshot });
    try {
      await windows.changeQos(snapshot);
      await saveState({ qos: { ...snapshot, complete: true } });
    } catch (error) {
      if (error.cancelled || await windows.qosStatus(snapshot) === 'absent') await saveState({ qos: null });
      throw error;
    }
  }
  return currentState();
}

function register(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    const frame = event.senderFrame;
    if (event.sender !== window?.webContents || !frame ||
        frame !== window.webContents.mainFrame || frame.url !== entryUrl) {
      return { error: 'Источник команды недоступен.' };
    }
    try {
      return { value: await action(...args) };
    } catch (error) {
      if ('cmd' in error) {
        console.error(channel, error.code, error.stderr?.slice(0, 600));
        return { error: 'Windows не выполнила операцию. Проверьте права доступа и повторите.' };
      }
      return { error: error.message || 'Операция завершилась с ошибкой.' };
    }
  });
}

register('system:state', currentState);
register('system:metrics', telemetry);
register('gaming:profile', enable => mutate(() => setProfile(enable)));
register('gaming:apps', async () => {
  requireWindows();
  const list = await windows.listGames();
  games = new Map(list.map(game => [game.id + ':' + game.start, game]));
  return Array.from(games, ([id, { name, file }]) => ({ id, name, file }));
});
register('gaming:priority', (enable, id) => mutate(() => priority(enable, id)));
register('network:test', async host => {
  requireWindows();
  if (pendingPing) throw new Error('Тест уже идёт.');
  pendingPing = true;
  try {
    return await windows.ping(host);
  } finally {
    pendingPing = false;
  }
});
register('network:pick', async () => {
  requireWindows();
  const selection = await dialog.showOpenDialog(window, {
    title: 'Выберите фоновое приложение',
    properties: ['openFile'],
    filters: [{ name: 'Приложение Windows', extensions: ['exe'] }]
  });
  if (selection.canceled) return backgroundExe || null;
  backgroundExe = validateExe(selection.filePaths[0]);
  return backgroundExe;
});
register('network:qos', (enable, rate) => mutate(() => qos(enable, rate)));

register('system:settings', async section => {
  requireWindows();
  if (typeof section !== 'string' || !Object.hasOwn(settings, section)) throw new Error('Раздел Windows недоступен.');
  await shell.openExternal(settings[section]);
});
register('window:control', action => {
  if (action === 'minimize') window.minimize();
  if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
  if (action === 'close') window.close();
});

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 880,
    minHeight: 660,
    backgroundColor: '#0d0f11',
    show: false,
    frame: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'ui', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, resolve) => resolve(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (pendingChange) {
      event.preventDefault();
      window.webContents.send('window:busy');
    }
  });
  window.on('closed', () => { window = null; });
  window.loadFile(entry);
}

app.setName('Absolute Optimizer');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(async () => {
    await loadState();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
