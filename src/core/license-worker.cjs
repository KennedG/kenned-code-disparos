'use strict';

const { EventEmitter } = require('node:events');

// Only sanitized receipt status crosses into the backend worker. Device private
// keys and DPAPI buffers remain in the native host process.
function createLicenseWorkerProxy(host, { monotonicNow = () => Number(process.hrtime.bigint() / 1000000n), wallNow = () => Date.now() } = {}) {
  const proxy = new EventEmitter();
  let snapshot = { allowed: false, status: 'verifying', plan: null, expiresAt: null, remainingMs: 0, offlineRemainingMs: 0, reasonCode: 'LICENSE_VERIFYING', reason: 'Verificando a licença…', autoResumeRequired: false, serverConfigured: false }, capturedAt = monotonicNow(), capturedWall = wallNow();
  proxy.setStatus = status => {
    snapshot = status && typeof status === 'object' && typeof status.allowed === 'boolean' ? { ...status } : { allowed: false, status: 'connection_required', remainingMs: 0, offlineRemainingMs: 0, reasonCode: 'LICENSE_HOST_UNAVAILABLE', reason: 'O controle nativo da licença não está disponível.', autoResumeRequired: true };
    capturedAt = monotonicNow(); capturedWall = wallNow(); proxy.emit('change', proxy.getStatus()); return proxy.getStatus();
  };
  proxy.getStatus = () => {
    const elapsed = Math.max(0, monotonicNow() - capturedAt, wallNow() - capturedWall), state = { ...snapshot };
    if (state.allowed && wallNow() < capturedWall - 2000) { state.allowed = false; state.status = 'connection_required'; state.reasonCode = 'LICENSE_CLOCK_CHANGED'; state.reason = 'O relógio mudou. Valide a licença pela internet antes de enviar.'; state.autoResumeRequired = true; }
    state.remainingMs = Math.max(0, Number(snapshot.remainingMs || 0) - elapsed);
    state.offlineRemainingMs = Math.max(0, Number(snapshot.offlineRemainingMs || 0) - elapsed);
    if (state.trustedNow) state.trustedNow += elapsed;
    if (state.allowed && !state.remainingMs) { state.allowed = false; state.status = 'expired'; state.reasonCode = 'LICENSE_EXPIRED'; state.reason = 'A licença venceu. Renove para liberar novas operações.'; state.autoResumeRequired = true; }
    else if (state.allowed && !state.offlineRemainingMs) { state.allowed = false; state.status = 'connection_required'; state.reasonCode = 'LICENSE_OFFLINE_LIMIT'; state.reason = 'A tolerância sem validação terminou. Conecte à internet para verificar a licença.'; state.autoResumeRequired = true; }
    return state;
  };
  proxy.assertAllowed = () => { const state = proxy.getStatus(); if (!state.allowed) throw Object.assign(new Error(state.reason || 'Ative a licença para continuar.'), { code: state.reasonCode || 'LICENSE_REQUIRED', licenseBlocked: true }); return true; };
  proxy.initialize = async () => proxy.setStatus(await host('licenseStatus'));
  proxy.activate = async key => proxy.setStatus(await host('licenseActivate', { key }));
  proxy.validate = async () => proxy.setStatus(await host('licenseValidate'));
  proxy.tick = async () => proxy.setStatus(await host('licenseTick'));
  proxy.shutdown = async () => {};
  return proxy;
}

module.exports = { createLicenseWorkerProxy };
