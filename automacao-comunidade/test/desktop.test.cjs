'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createDesktop, createSecureHost, storageStatus, allowedSender, safeName, APP_ID, ACTIONS } = require('../src/desktop/runtime.cjs');
const { WorkerClient } = require('../src/core/worker-client.cjs');
const { writeOwnershipManifest, MANIFEST } = require('../scripts/ownership-manifest.cjs');

function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comunidade-desktop-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function makeFake(t, { primary = true, packaged = false } = {}) {
  const dir = temporary(t), calls = [], events = new EventEmitter(), handlers = new Map();
  class App extends EventEmitter {
    constructor() { super(); this.isPackaged = packaged; }
    setName(name) { calls.push(['name', name]); }
    setAppUserModelId(id) { calls.push(['aumid', id]); }
    getPath(kind) { return kind === 'appData' ? dir : path.join(dir, kind); }
    setPath(kind, value) { calls.push(['path', kind, value]); }
    requestSingleInstanceLock() { calls.push(['lock']); return primary; }
    quit() { calls.push(['quit']); }
    whenReady() { calls.push(['ready']); return Promise.resolve(); }
    getVersion() { return '1.0.0'; }
    setLoginItemSettings(value) { calls.push(['login', value]); }
  }
  class Win extends EventEmitter {
    constructor(options) { super(); this.options = options; this.minimized = false; this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' }; this.webContents.send = (channel, payload) => calls.push(['event', channel, payload]); this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; }; calls.push(['window', options]); }
    removeMenu() {}
    async loadFile(file) { this.file = file; this.webContents.mainFrame.url = require('node:url').pathToFileURL(file).href; this.emit('ready-to-show'); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    minimize() { this.minimized = true; calls.push(['minimize']); }
    restore() { this.minimized = false; calls.push(['restore']); }
    show() { calls.push(['show']); }
    hide() { calls.push(['hide']); }
    focus() { calls.push(['focus']); }
    flashFrame(value) { calls.push(['flash', value]); }
  }
  class Tray extends EventEmitter {
    constructor() { super(); calls.push(['tray']); }
    setToolTip(text) { calls.push(['tooltip', text]); }
    setContextMenu(menu) { this.menu = menu; calls.push(['trayMenu', menu]); }
    destroy() { calls.push(['trayDestroy']); }
  }
  class Notice extends EventEmitter { static isSupported() { return true; } constructor(value) { super(); calls.push(['notification', value]); } show() { calls.push(['notificationShow']); } }
  class FakeWorker extends EventEmitter {
    constructor(options) { super(); this.options = options; calls.push(['worker', options]); setImmediate(() => this.emit('message', { type: 'ready' })); }
    postMessage(value) { calls.push(['post', value]); if (value.type === 'call') setImmediate(() => this.emit('message', { type: 'result', id: value.id, result: value.action === 'snapshot' ? { settings: { minimizeToTray: true, launchAtLogin: true } } : { ok: true } })); }
    async terminate() { calls.push(['terminate']); this.emit('exit', 0); }
  }
  const app = new App();
  const electron = { app, BrowserWindow: Win, Tray, Notification: Notice, Menu: { buildFromTemplate: value => value }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {
    showMessageBox: async (_window, options) => { calls.push(['dialog', options]); return { response: 1 }; },
    showSaveDialog: async (_window, options) => { calls.push(['saveDialog', options]); return { canceled: false, filePath: path.join(dir, 'backup.sqlite') }; },
    showOpenDialog: async (_window, options) => { calls.push(['openDialog', options]); return { canceled: false, filePaths: [path.join(dir, 'restore.sqlite')] }; }
  }, safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'unknown', encryptString: value => Buffer.from(`sealed:${value}`), decryptString: value => value.toString().replace(/^sealed:/, '') }, shell: { openPath: async folder => { calls.push(['openPath', folder]); return ''; } }, powerMonitor: events };
  return { electron, calls, handlers, dir, workerFactory: options => new FakeWorker(options) };
}
function sender(runtime) { return { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame }; }
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test('o bloqueio de instância ocorre antes de banco, diretórios ou worker', async t => {
  const fake = makeFake(t, { primary: false });
  const app = await createDesktop(fake.electron, { workerFactory: fake.workerFactory, platform: 'win32', env: {} });
  assert.equal(app.primary, false);
  assert.equal(fake.calls.some(row => row[0] === 'worker'), false);
  assert.equal(fs.existsSync(path.join(fake.dir, 'Automação Comunidade')), false);
  assert.equal(fake.calls.at(-1)[0], 'quit');
});
test('perfil, appId, segurança do renderer e sessão são próprios do aplicativo', async t => {
  const fake = makeFake(t), app = await createDesktop(fake.electron, { workerFactory: fake.workerFactory, platform: 'win32', env: {} });
  t.after(() => app.quit());
  assert.equal(app.profile, path.join(fake.dir, 'Automação Comunidade'));
  assert.equal(APP_ID, 'br.com.kennedcode.automacaocomunidade');
  assert.ok(fs.existsSync(path.join(app.profile, 'credentials')));
  assert.ok(fake.calls.findIndex(row => row[0] === 'lock') < fake.calls.findIndex(row => row[0] === 'worker'));
  const options = app.window.options.webPreferences;
  assert.equal(options.nodeIntegration, false); assert.equal(options.contextIsolation, true); assert.equal(options.sandbox, true);
  assert.deepEqual(app.window.openHandler({ url: 'https://example.invalid' }), { action: 'deny' });
  let denied = false; app.window.webContents.emit('will-navigate', { preventDefault() { denied = true; } }, 'https://example.invalid'); assert.equal(denied, true);
});
test('IPC valida origem, janela, frame e lista de ações sem expor APIs nativas', async t => {
  const fake = makeFake(t), app = await createDesktop(fake.electron, { workerFactory: fake.workerFactory, platform: 'win32', env: {} });
  t.after(() => app.quit()); await settle();
  const handle = fake.handlers.get('community:call');
  await assert.rejects(handle({ sender: {}, senderFrame: { url: app.entryUrl } }, 'stopAll'), { code: 'IPC_ORIGIN_DENIED' });
  await assert.rejects(handle({ sender: app.window.webContents, senderFrame: { url: app.entryUrl } }, 'stopAll'), { code: 'IPC_ORIGIN_DENIED' });
  await assert.rejects(handle(sender(app), 'secureStorage.decrypt'), { code: 'IPC_ACTION_DENIED' });
  await assert.rejects(handle(sender(app), 'snapshot', []), { code: 'IPC_INPUT' });
  assert.deepEqual(await handle(sender(app), 'snapshot', {}), { settings: { minimizeToTray: true, launchAtLogin: true } });
  assert.equal(ACTIONS.has('openExternal'), false);
});
test('DPAPI protege bytes, preserva Unicode e rejeita basic_text em modo real', () => {
  const fake = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'unknown', encryptString: value => Buffer.from(`sealed:${value}`), decryptString: value => value.toString().replace(/^sealed:/, '') };
  const windows = createSecureHost(fake, 'win32');
  assert.deepEqual(windows('secureStorage.status'), { available: true, backend: 'dpapi', platform: 'win32' });
  const cipher = windows('secureStorage.encrypt', { text: 'sessão de teste 🔒' });
  assert.deepEqual(windows('secureStorage.decrypt', cipher), { text: 'sessão de teste 🔒' });
  assert.equal(storageStatus(fake, 'linux').available, false);
  const basicText = { ...fake, getSelectedStorageBackend: () => 'basic_text' };
  assert.equal(storageStatus(basicText, 'win32').available, false);
  assert.throws(() => createSecureHost(basicText, 'win32')('secureStorage.encrypt', { text: 'x' }), { code: 'SECURE_STORAGE_UNAVAILABLE' });
  assert.throws(() => createSecureHost(fake, 'linux')('secureStorage.encrypt', { text: 'x' }), { code: 'SECURE_STORAGE_UNAVAILABLE' });
  assert.throws(() => windows('secureStorage.decrypt', { base64: '../inválido' }), { code: 'SECURE_STORAGE_INPUT' });
  assert.throws(() => windows('secureStorage.encrypt', { text: Buffer.from('x') }), { code: 'SECURE_STORAGE_INPUT' });
});
test('configuração nativa de inicialização, diálogos e pasta são restritos', async t => {
  const fake = makeFake(t), app = await createDesktop(fake.electron, { workerFactory: fake.workerFactory, platform: 'win32', env: {} });
  t.after(() => app.quit());
  await app.host('settings.apply', { launchAtLogin: true, minimizeToTray: false });
  const startup = fake.calls.find(row => row[0] === 'login')[1];
  assert.equal(startup.openAtLogin, true); assert.deepEqual(startup.args, ['--autostart']);
  assert.equal(await app.host('dialogs.saveBackup', { suggestedName: '../bad.sqlite' }), path.join(fake.dir, 'backup.sqlite'));
  assert.equal(await app.host('dialogs.openBackup'), path.join(fake.dir, 'restore.sqlite'));
  await app.host('dialogs.saveHistory');
  const exportDialog = fake.calls.filter(row => row[0] === 'saveDialog').at(-1)[1];
  assert.deepEqual(exportDialog.filters[0].extensions, ['json']);
  assert.ok(exportDialog.defaultPath.endsWith('.json'));
  await app.host('openDataFolder', { path: '/forbidden' });
  assert.equal(fake.calls.find(row => row[0] === 'openPath')[1], app.profile);
  await assert.rejects(app.host('shell.exec', {}), { code: 'HOST_ACTION_DENIED' });
  assert.equal(safeName('../../x', 'fallback'), '..-..-x');
});
test('bandeja mantém fila; parada geral chama backend e segunda instância restaura janela', async t => {
  const fake = makeFake(t), app = await createDesktop(fake.electron, { workerFactory: fake.workerFactory, platform: 'win32', env: {} });
  t.after(() => app.quit()); await settle();
  const stop = fake.calls.find(row => row[0] === 'trayMenu')[1].find(item => item.label === 'PARAR TODOS OS ENVIOS');
  stop.click(); await settle();
  assert.ok(fake.calls.some(row => row[0] === 'post' && row[1].action === 'stopAll'));
  app.window.minimized = true; fake.electron.app.emit('second-instance');
  assert.ok(fake.calls.some(row => row[0] === 'restore'));
  fake.electron.powerMonitor.emit('suspend'); fake.electron.powerMonitor.emit('resume'); await settle();
  assert.ok(fake.calls.some(row => row[0] === 'post' && row[1].action === '__system:suspend'));
  assert.ok(fake.calls.some(row => row[0] === 'post' && row[1].action === '__system:resume'));
  let prevented = false; app.window.emit('close', { preventDefault() { prevented = true; } }); await settle();
  assert.equal(prevented, true); assert.ok(fake.calls.some(row => row[0] === 'hide'));
});
test('perfil de teste não pode substituir dados em aplicativo empacotado', async t => {
  const fake = makeFake(t, { packaged: true });
  const app = await createDesktop(fake.electron, { workerFactory: fake.workerFactory, platform: 'win32', env: { COMMUNITY_TEST_MODE: '1', COMMUNITY_TEST_PROFILE: '/do-not-use' } });
  t.after(() => app.quit());
  assert.equal(app.profile, path.join(fake.dir, 'Automação Comunidade'));
});
test('manifesto de desinstalação lista apenas arquivos próprios e não inclui dados externos', t => {
  const dir = temporary(t); fs.mkdirSync(path.join(dir, 'resources')); fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), 'test'); fs.writeFileSync(path.join(dir, 'Automação Comunidade.exe'), 'test');
  const result = writeOwnershipManifest(dir), manifest = fs.readFileSync(path.join(dir, MANIFEST), 'utf16le');
  assert.equal(result.files, 2); assert.ok(manifest.includes('F|resources\\app.asar')); assert.ok(manifest.includes('D|resources'));
  const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'installer.nsi'), 'utf8');
  assert.equal(/RMDir\s+\/r/i.test(installer.replace(/;[^\n]*/g, '')), false);
  assert.equal(installer.includes('Mega Disparos'), false); assert.equal(installer.includes('Kenned Code Disparos'), false);
  assert.ok(installer.includes('br.com.kennedcode.automacaocomunidade'));
});
test('worker RPC transporta host, falhas e resultados sem bloquear a interface', async () => {
  class FakeWorker extends EventEmitter { postMessage(message) { this.messages.push(message); } constructor() { super(); this.messages = []; } async terminate() {} }
  const fake = new FakeWorker(), hostCalls = [];
  const client = new WorkerClient({ dir: '/profile', version: '1.0.0', host: async (...args) => { hostCalls.push(args); return { available: true }; }, workerFactory: () => fake, timeoutMs: 1000 });
  fake.emit('message', { type: 'ready' });
  const pending = client.call('snapshot'); await settle();
  const call = fake.messages.find(message => message.type === 'call');
  fake.emit('message', { type: 'result', id: call.id, result: { mode: 'whatsapp' } });
  assert.deepEqual(await pending, { mode: 'whatsapp' });
  fake.emit('message', { type: 'host', id: 13, action: 'secureStorage.status', payload: {} }); await settle();
  assert.equal(hostCalls[0][0], 'secureStorage.status');
  assert.deepEqual(fake.messages.find(message => message.type === 'hostResult').result, { available: true });
  let updated = false; client.on('update', () => { updated = true; }); fake.emit('message', { type: 'event', event: 'update', payload: {} }); assert.equal(updated, true);
  client.closed = true;
});
test('bootstrap Electron inicia mesmo quando require.main difere do módulo de entrada', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  let started = 0;
  const fakeRequire = name => name === './desktop/runtime.cjs' ? { createDesktop: async () => { started++; } } : { dialog: { showErrorBox() {} }, app: { quit() {} } };
  fakeRequire.main = { filename: 'electron-bootstrap.js' };
  const sandbox = { require: fakeRequire, module: { exports: {} }, process: { versions: { electron: '44.5.1' }, type: 'browser' } };
  vm.runInNewContext(source, sandbox);
  assert.equal(started, 1);
  sandbox.process = { versions: {}, type: undefined }; vm.runInNewContext(`{${source}}`, sandbox);
  assert.equal(started, 1);
});
