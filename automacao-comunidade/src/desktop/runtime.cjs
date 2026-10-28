'use strict';
const path = require('node:path'), fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { WorkerClient } = require('../core/worker-client.cjs');
const PRODUCT = 'Automação Comunidade';
const APP_ID = 'br.com.kennedcode.automacaocomunidade';
const CHANNEL = 'community:call';
const ACTIONS = new Set(('snapshot connect disconnect reconnect testConnection listGroups refreshGroups listParticipants refreshParticipants listContacts updateContact authorizeContacts saveCampaign duplicateCampaign deleteCampaign previewCampaign activateCampaign pauseCampaign resumeCampaign stopCampaign stopAll resumeAutomation listCampaigns listRuns listHistory clearHistory listTemplates saveTemplate duplicateTemplate deleteTemplate saveSettings backup restore exportHistory reconcileJob retryJob testSimulation windowMinimize windowQuit openDataFolder').split(' '));

function publicError(message, code) { return Object.assign(new Error(message), { code }); }
function storageStatus(safeStorage, platform = process.platform) {
  let available = false, backend = 'unavailable';
  try {
    available = Boolean(safeStorage?.isEncryptionAvailable());
    let selected = '';
    try { selected = String(safeStorage?.getSelectedStorageBackend?.() || ''); } catch {}
    backend = platform === 'win32' ? (selected === 'basic_text' ? 'basic_text' : 'dpapi') : selected || 'unknown';
    if (backend === 'basic_text' || (platform === 'linux' && ['unknown', 'unavailable'].includes(backend))) available = false;
  } catch { available = false; }
  return { available, backend, platform };
}
function createSecureHost(safeStorage, platform = process.platform) {
  return (action, payload = {}) => {
    const status = storageStatus(safeStorage, platform);
    if (action === 'secureStorage.status') return status;
    if (!status.available) throw publicError('A proteção de credenciais do sistema não está disponível. No Windows, utilize o perfil do usuário com DPAPI; armazenamento em texto simples foi recusado.', 'SECURE_STORAGE_UNAVAILABLE');
    if (action === 'secureStorage.encrypt') {
      if (typeof payload.text !== 'string' || payload.text.length > 8 * 1024 * 1024) throw publicError('Dados de sessão inválidos.', 'SECURE_STORAGE_INPUT');
      return { base64: safeStorage.encryptString(payload.text).toString('base64') };
    }
    if (action === 'secureStorage.decrypt') {
      if (typeof payload.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.base64) || payload.base64.length > 12 * 1024 * 1024) throw publicError('Arquivo de sessão inválido.', 'SECURE_STORAGE_INPUT');
      try { return { text: safeStorage.decryptString(Buffer.from(payload.base64, 'base64')) }; }
      catch { throw publicError('Não foi possível abrir a sessão protegida deste usuário. Reconecte a conta sem reutilizar credenciais de outro perfil.', 'SESSION_DECRYPT_FAILED'); }
    }
    throw publicError('Recurso de segurança não permitido.', 'HOST_ACTION_DENIED');
  };
}
function allowedSender(event, window, entryUrl) {
  if (!window || window.isDestroyed?.() || event?.sender !== window.webContents) return false;
  if (window.webContents.mainFrame && event.senderFrame !== window.webContents.mainFrame) return false;
  const url = event.senderFrame?.url || '';
  try { const candidate = new URL(url); candidate.hash = ''; return candidate.href === entryUrl; } catch { return false; }
}
function safeName(value, fallback) {
  return String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 160);
}
async function createDesktop(electron, { workerFactory, env = process.env, platform = process.platform } = {}) {
  const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, safeStorage, shell, Notification } = electron;
  const state = { window: null, tray: null, service: null, quitting: false, closePrompt: false, settings: { minimizeToTray: true, launchAtLogin: false }, storageError: null };
  const root = path.join(__dirname, '..', '..'), entryFile = path.join(root, 'src', 'ui', 'index.html'), entryUrl = pathToFileURL(entryFile).href;
  app.setName(PRODUCT);
  app.setAppUserModelId?.(APP_ID);
  const testProfile = !app.isPackaged && env.COMMUNITY_TEST_MODE === '1' && env.COMMUNITY_TEST_PROFILE;
  const profile = testProfile ? path.resolve(testProfile) : path.join(app.getPath('appData'), PRODUCT);
  app.setPath('userData', profile);
  // Acquire the OS lock before opening a database, creating a worker or touching credentials.
  if (!app.requestSingleInstanceLock()) { app.quit(); return { ...state, primary: false, profile }; }
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const showWindow = () => {
    const win = state.window;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  };
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { if (!state.tray) void quit(); });
  async function quit() {
    if (state.quitting) return;
    state.quitting = true;
    try { await state.service?.shutdown(); } finally {
      state.tray?.destroy(); state.tray = null;
      app.quit(); resolveClosed();
    }
  }
  app.on('before-quit', event => {
    if (state.quitting) return;
    event.preventDefault(); void quit();
  });
  await app.whenReady();
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  for (const folder of ['media', 'credentials', 'backups']) fs.mkdirSync(path.join(profile, folder), { recursive: true, mode: 0o700 });
  const secureHost = createSecureHost(safeStorage, platform);
  const icon = nativeImage.createFromPath(path.join(root, 'assets', 'icon.png'));
  const notify = ({ title = PRODUCT, body = '' } = {}) => {
    if (Notification?.isSupported?.()) {
      const notice = new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 1000), icon });
      notice.on('click', showWindow); notice.show(); return { shown: true };
    }
    state.window?.flashFrame?.(true); return { shown: false, fallback: 'taskbar' };
  };
  const host = async (action, payload = {}) => {
    if (action.startsWith('secureStorage.')) return secureHost(action, payload);
    if (action === 'settings.apply') {
      state.settings = { ...state.settings, ...payload };
      if (platform === 'win32') app.setLoginItemSettings({ openAtLogin: Boolean(state.settings.launchAtLogin), path: process.execPath, args: ['--autostart'], name: PRODUCT });
      return { applied: true };
    }
    if (action === 'notification.show') return notify(payload);
    if (action === 'windowMinimize') { state.window?.minimize(); return { minimized: true }; }
    if (action === 'windowQuit') { setImmediate(() => void quit()); return { closing: true }; }
    if (action === 'openDataFolder') { const error = await shell.openPath(profile); if (error) throw publicError('Não foi possível abrir a pasta de dados.', 'OPEN_FOLDER_FAILED'); return { opened: true }; }
    if (action === 'dialogs.saveBackup' || action === 'dialogs.saveHistory') {
      const backup = action === 'dialogs.saveBackup';
      const defaultName = backup ? 'Automacao-Comunidade-Backup.sqlite' : 'Automacao-Comunidade-Historico.json';
      const result = await dialog.showSaveDialog(state.window, { title: backup ? 'Salvar backup sem credenciais' : 'Exportar histórico', defaultPath: path.join(app.getPath('documents'), safeName(payload.suggestedName, defaultName)), filters: [{ name: backup ? 'Backup SQLite' : 'Histórico JSON', extensions: backup ? ['sqlite'] : ['json'] }] });
      return result.canceled ? null : result.filePath;
    }
    if (action === 'dialogs.openBackup') {
      const result = await dialog.showOpenDialog(state.window, { title: 'Restaurar backup — automações permanecerão pausadas', properties: ['openFile'], filters: [{ name: 'Backup SQLite', extensions: ['sqlite'] }] });
      return result.canceled ? null : result.filePaths?.[0] || null;
    }
    throw publicError('Recurso do sistema não permitido.', 'HOST_ACTION_DENIED');
  };
  state.service = new WorkerClient({ dir: profile, version: app.getVersion(), host, ...(workerFactory ? { workerFactory } : {}) });
  state.window = new BrowserWindow({ title: PRODUCT, width: 1320, height: 860, minWidth: 1080, minHeight: 700, show: false, backgroundColor: '#f4f7f6', icon, autoHideMenuBar: true, webPreferences: { preload: path.join(root, 'src', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, devTools: !app.isPackaged } });
  state.window.removeMenu();
  const window = state.window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== entryUrl) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('ready-to-show', () => { if (!(env.COMMUNITY_TEST_MODE === '1' && env.COMMUNITY_TEST_HIDE === '1')) showWindow(); });
  window.on('focus', () => window.flashFrame(false));
  window.on('close', async event => {
    if (state.quitting) return;
    event.preventDefault();
    if (state.closePrompt) return;
    if (state.settings.minimizeToTray && state.tray) { window.hide(); return; }
    state.closePrompt = true;
    try {
      const response = await dialog.showMessageBox(window, { type: 'question', title: 'Fechar Automação Comunidade', message: 'Minimizar para a bandeja ou encerrar o aplicativo?', detail: 'Na bandeja, as tarefas continuam conforme a programação. Ao encerrar, os pendentes são preservados.', buttons: ['Minimizar para a bandeja', 'Encerrar aplicativo', 'Cancelar'], defaultId: 0, cancelId: 2, noLink: true });
      if (response.response === 0 && state.tray) window.hide();
      else if (response.response === 1) void quit();
    } finally { state.closePrompt = false; }
  });
  ipcMain.handle(CHANNEL, async (event, action, payload = {}) => {
    if (!allowedSender(event, state.window, entryUrl)) throw publicError('Origem da operação não autorizada.', 'IPC_ORIGIN_DENIED');
    if (!ACTIONS.has(action)) throw publicError('Operação não permitida.', 'IPC_ACTION_DENIED');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw publicError('Dados da operação inválidos.', 'IPC_INPUT');
    if (['windowMinimize', 'windowQuit', 'openDataFolder'].includes(action)) return host(action, payload);
    if (state.storageError) throw publicError(state.storageError, 'SERVICE_UNAVAILABLE');
    return state.service.call(action, payload);
  });
  state.service.on('update', payload => { if (!window.isDestroyed()) window.webContents.send('community:update', payload); });
  state.service.on('fault', fault => {
    state.storageError = fault.message;
    if (!window.isDestroyed()) window.webContents.send('community:update', { storageError: fault.message, faultCode: fault.code });
    notify({ title: `${PRODUCT} — processamento interrompido`, body: fault.message });
  });
  try {
    state.tray = new Tray(icon.resize({ width: 20, height: 20 }));
    state.tray.setToolTip(PRODUCT);
    state.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir Automação Comunidade', click: showWindow },
      { label: 'PARAR TODOS OS ENVIOS', click: () => void state.service.call('stopAll', {}).then(() => { showWindow(); notify({ title: PRODUCT, body: 'Envios automáticos bloqueados. Confira o painel para revisar e retomar explicitamente.' }); }).catch(error => { showWindow(); notify({ title: PRODUCT, body: error.message }); }) },
      { type: 'separator' }, { label: 'Encerrar aplicativo', click: () => void quit() }
    ]));
    state.tray.on('double-click', showWindow);
  } catch { state.tray = null; }
  await window.loadFile(entryFile);
  state.service.ready.then(async () => {
    try { const snapshot = await state.service.call('snapshot', {}); state.settings = { ...state.settings, ...(snapshot.settings || {}) }; await host('settings.apply', state.settings); if (!window.isDestroyed()) window.webContents.send('community:update', snapshot); }
    catch (error) { state.storageError = error.message; }
  }).catch(error => { state.storageError = error.message; });
  if (electron.powerMonitor) {
    electron.powerMonitor.on('suspend', () => { void state.service?.systemCall('suspend').catch(() => {}); });
    electron.powerMonitor.on('resume', () => { void state.service?.systemCall('resume').catch(() => {}); });
  }
  return { ...state, primary: true, profile, entryUrl, host, quit, closed, getState: () => state };
}
module.exports = { createDesktop, createSecureHost, storageStatus, allowedSender, safeName, PRODUCT, APP_ID, CHANNEL, ACTIONS };
