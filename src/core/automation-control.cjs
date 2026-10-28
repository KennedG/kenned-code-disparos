'use strict';

const { EventEmitter } = require('node:events');

// This latch is deliberately independent of campaign state. Pausing a campaign
// must not accidentally reopen alerts, reminders or a queued private delivery.
class AutomationControl extends EventEmitter {
  constructor({ store, scheduler, now = () => Date.now(), beforeResume = () => {} }) {
    super();
    Object.assign(this, { store, scheduler, now, beforeResume });
    this.handlers = new Map();
    this.operation = null;
    this.syncMode();
  }

  syncMode() {
    this.state = this.store.getSetting('automationState', { stopped: false });
    this.stopped = this.state?.stopped === true;
    this.scheduler?.setAutomationBlocked(this.stopped);
    this.emit('change', this.getState());
    return this.getState();
  }

  isStopped() { return this.stopped === true; }
  getState() { return { ...this.state, stopped: this.isStopped() }; }

  register(name, stopCallback) {
    if (typeof name !== 'string' || !name || typeof stopCallback !== 'function') throw new TypeError('Registro de interrupção inválido.');
    this.handlers.set(name, stopCallback);
    return () => this.handlers.delete(name);
  }

  stop({ actorId = null, source = 'app', reason = 'Todos os envios automáticos foram interrompidos.' } = {}) {
    // Latch before disk access, callbacks and the first await. Even a storage
    // failure leaves the runtime stopped, so no later callback can submit work.
    this.stopped = true;
    this.scheduler?.setAutomationBlocked(true);
    const state = { stopped: true, stoppedAt: this.now(), actorId, source, reason };
    this.state = state;
    let persistenceError = null;
    try { this.store.setSetting('automationState', state); }
    catch (error) { persistenceError = error; this.scheduler?.blockOnPersistenceFailure(); }
    if (this.operation) return this.operation;
    const report = { stopped: true, campaigns: 0, jobs: 0, search: 0, alerts: 0, reminders: 0,
      inFlight: this.scheduler?.getCampaignInFlightCount?.() || 0,
      processing: this.scheduler?.getInFlightCount?.() || 0, errors: [] };
    // Invoke every service synchronously before waiting for any one service.
    // A stop implementation can cancel its timers immediately and return a
    // promise only for its durable bookkeeping.
    const invoke = (name, callback) => {
      try { return Promise.resolve(callback(reason)).then(value => { report[name] = value ?? 0; }); }
      catch (error) { return Promise.reject(error); }
    };
    const operations = [invoke('campaigns', () => this.scheduler?.stopAll())];
    for (const [name, callback] of this.handlers) operations.push(invoke(name, callback));
    this.emit('change', this.getState());
    const operation = Promise.allSettled(operations).then(results => {
      for (let index = 0; index < results.length; index++) if (results[index].status === 'rejected') {
        report.errors.push(index === 0 ? 'Não foi possível persistir toda a interrupção de campanhas.' : 'Não foi possível persistir toda a interrupção de uma fila automática.');
      }
      if (persistenceError) report.errors.push('Falha ao salvar a interrupção no disco. O processamento permanece bloqueado; corrija o armazenamento antes de reabrir.');
      // A service callback may merely be sleeping between deliveries. Only
      // each service's actual submission counter is an uncancellable send.
      report.inFlight = Math.max(report.inFlight, this.scheduler?.getCampaignInFlightCount?.() || 0,
        ...Object.values(report).filter(value => value && typeof value === 'object' && !Array.isArray(value)).map(value => Number(value.inFlight) || 0));
      this.emit('stopped', report);
      return report;
    }).finally(() => { if (this.operation === operation) this.operation = null; });
    this.operation = operation;
    return operation;
  }

  resume({ actorId = null, source = 'app' } = {}) {
    if (this.operation) throw Object.assign(new Error('Aguarde a conclusão da interrupção antes de retomar o sistema.'), { code: 'AUTOMATION_STOPPING' });
    if (this.store.persistenceFailed || this.scheduler?.persistenceFailed) throw Object.assign(new Error('Corrija a falha de armazenamento e reinicie antes de retomar.'), { code: 'STORAGE_UNAVAILABLE' });
    this.beforeResume();
    const state = { ...this.state, stopped: false, resumedAt: this.now(), resumedBy: actorId, resumeSource: source };
    // Persist before reopening the gate. Failed writes cannot reopen processing.
    this.store.setSetting('automationState', state);
    this.state = state;
    this.stopped = false;
    this.scheduler?.setAutomationBlocked(false);
    this.emit('change', this.getState());
    // Old deliveries were cancelled, and stopped campaigns stay stopped. The
    // operator chooses what to activate after reopening new queue entries.
    return this.getState();
  }
}

module.exports = { AutomationControl };
