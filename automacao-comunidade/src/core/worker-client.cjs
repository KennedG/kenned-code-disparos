'use strict';
const { Worker } = require('node:worker_threads');
const { EventEmitter } = require('node:events');
const path = require('node:path');

function errorFrom(data, fallback = 'Não foi possível executar a operação.') {
  const error = new Error(data?.message || fallback);
  if (data?.code) error.code = data.code;
  return error;
}
class WorkerClient extends EventEmitter {
  constructor({ dir, version, host, workerFactory = options => new Worker(path.join(__dirname, '..', 'backend', 'worker.cjs'), options), timeoutMs = 120000 } = {}) {
    super();
    this.host = host; this.timeoutMs = timeoutMs; this.pending = new Map(); this.sequence = 0; this.closed = false;
    this.worker = workerFactory({ workerData: { dir, version } });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.worker.on('message', message => this.onMessage(message));
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => { if (!this.closed || code !== 0) this.fail(errorFrom({ code: 'WORKER_STOPPED', message: 'O processamento em segundo plano foi interrompido. Reinicie o aplicativo; o progresso está preservado.' })); });
  }
  async onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') { this.resolveReady(); this.emit('ready'); return; }
    if (message.type === 'event') { this.emit(message.event === 'update' ? 'update' : 'diagnostic', message.payload); return; }
    if (message.type === 'fatal') { this.fail(errorFrom(message.error)); return; }
    if (message.type === 'host') {
      try {
        const result = await this.host(message.action, message.payload);
        this.worker.postMessage({ type: 'hostResult', id: message.id, result });
      } catch (error) {
        this.worker.postMessage({ type: 'hostResult', id: message.id, error: { message: String(error.message || 'Falha no recurso do Windows.'), code: error.code || 'HOST_ERROR' } });
      }
      return;
    }
    if (message.type !== 'result') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(errorFrom(message.error)); else pending.resolve(message.result);
  }
  async call(action, payload = {}) {
    if (this.closed) throw errorFrom({ code: 'SERVICE_CLOSED', message: 'O aplicativo está encerrando.' });
    await this.ready;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(errorFrom({ code: 'RPC_TIMEOUT', message: 'A operação demorou além do esperado. Confira o estado antes de repetir.' }));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: 'call', id, action, payload });
    });
  }
  async systemCall(action, payload = {}) {
    if (!['suspend', 'resume', 'stopAll', 'settings'].includes(action)) throw errorFrom({ code: 'SYSTEM_ACTION_DENIED', message: 'Ação interna não permitida.' });
    return this.call(`__system:${action}`, payload);
  }
  fail(error) {
    this.rejectReady(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (!this.closed) this.emit('fault', { message: error.message, code: error.code || 'WORKER_ERROR' });
  }
  async shutdown() {
    if (this.closed) return;
    let timeout;
    try { await Promise.race([this.call('__shutdown'), new Promise(resolve => { timeout = setTimeout(resolve, 8000); timeout.unref?.(); })]); } catch {}
    finally { clearTimeout(timeout); }
    this.closed = true;
    await this.worker.terminate();
  }
}
module.exports = { WorkerClient, errorFrom };
