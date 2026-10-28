'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createService } = require('./service.cjs');
const pendingHosts = new Map();
let hostSequence = 0, service, closing = false;
function host(action, payload = {}) {
  const id = ++hostSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingHosts.delete(id); reject(Object.assign(new Error('O recurso do sistema não respondeu.'), { code: 'HOST_TIMEOUT' })); }, 120000);
    timer.unref?.(); pendingHosts.set(id, { resolve, reject, timer });
    parentPort.postMessage({ type: 'host', id, action, payload });
  });
}
function safeError(error) { return { code: String(error?.code || 'SERVICE_ERROR'), message: String(error?.message || 'Não foi possível executar a operação.') }; }
parentPort.on('message', async message => {
  if (message?.type === 'hostResult') {
    const pending = pendingHosts.get(message.id);
    if (!pending) return;
    pendingHosts.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else pending.resolve(message.result);
    return;
  }
  if (message?.type !== 'call') return;
  try {
    if (message.action === '__shutdown') {
      closing = true;
      if (service) await service.shutdown();
      parentPort.postMessage({ type: 'result', id: message.id, result: { closed: true } });
      return;
    }
    if (!service || closing) throw Object.assign(new Error('O processamento ainda não está disponível.'), { code: 'SERVICE_UNAVAILABLE' });
    const result = message.action.startsWith('__system:')
      ? await service.systemCall(message.action.slice('__system:'.length), message.payload || {})
      : await service.call(message.action, message.payload || {});
    parentPort.postMessage({ type: 'result', id: message.id, result });
  } catch (error) { parentPort.postMessage({ type: 'result', id: message.id, error: safeError(error) }); }
});
(async () => {
  const storage = await host('secureStorage.status');
  const secureStorage = {
    available: storage.available, backend: storage.backend, platform: storage.platform,
    isEncryptionAvailable: () => storage.available,
    getSelectedStorageBackend: () => storage.backend,
    async encryptString(text) { const result = await host('secureStorage.encrypt', { text }); return Buffer.from(result.base64, 'base64'); },
    async decryptString(bytes) { const result = await host('secureStorage.decrypt', { base64: Buffer.from(bytes).toString('base64') }); return result.text; }
  };
  service = await createService({ dir: workerData.dir, version: workerData.version, host, secureStorage });
  service.on('update', payload => parentPort.postMessage({ type: 'event', event: 'update', payload }));
  service.on('diagnostic', payload => parentPort.postMessage({ type: 'event', event: 'diagnostic', payload }));
  parentPort.postMessage({ type: 'ready' });
})().catch(error => parentPort.postMessage({ type: 'fatal', error: safeError(error) }));
