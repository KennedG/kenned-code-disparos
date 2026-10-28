'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const os = require('node:os');

const HOUR = 3600000, GRACE_MS = 72 * HOUR, CLOCK_TOLERANCE_MS = 2000;
const DEFAULT_AUDIENCE = 'kenned-code-disparos';
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function publicJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x || '') || !/^[A-Za-z0-9_-]{43}$/.test(jwk.y || '') || jwk.d) throw coded('LICENSE_IDENTITY_INVALID', 'A identidade protegida deste dispositivo é inválida.');
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}
function jwkThumbprint(jwk) { return crypto.createHash('sha256').update(canonicalJson(publicJwk(jwk))).digest('base64url'); }
function coded(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
function timestamp(value) { const n = Date.parse(value); if (!Number.isFinite(n)) throw coded('LICENSE_RECEIPT_INVALID', 'O comprovante de licença contém uma data inválida.'); return n; }
function verifyReceipt(receipt, config, identity) {
  if (typeof receipt !== 'string' || receipt.length > 20000) throw coded('LICENSE_RECEIPT_INVALID', 'O comprovante de licença recebido é inválido.');
  const parts = receipt.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw coded('LICENSE_RECEIPT_INVALID', 'O comprovante de licença recebido é inválido.');
  let header, claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw coded('LICENSE_RECEIPT_INVALID', 'Não foi possível ler o comprovante assinado da licença.'); }
  if (header.alg !== 'ES256' || header.kid !== config.kid || (header.typ && header.typ !== 'JWT')) throw coded('LICENSE_SIGNATURE_INVALID', 'A assinatura do comprovante não corresponde ao serviço autorizado.');
  const signature = Buffer.from(parts[2], 'base64url');
  let valid = false;
  try { valid = signature.length === 64 && crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key: crypto.createPublicKey({ key: publicJwk(config.publicKeyJwk), format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, signature); } catch {}
  if (!valid) throw coded('LICENSE_SIGNATURE_INVALID', 'Não foi possível verificar a assinatura da licença.');
  if (claims.iss !== config.issuer || claims.aud !== (config.audience || DEFAULT_AUDIENCE) || claims.sub !== identity.deviceId || claims.deviceKeyThumbprint !== jwkThumbprint(identity.publicKeyJwk)) throw coded('LICENSE_DEVICE_MISMATCH', 'Este comprovante pertence a outro dispositivo ou serviço.');
  if (!['trial', 'active', 'expired', 'revoked'].includes(claims.status) || !['trial', 'monthly', 'annual', null].includes(claims.plan) || !Number.isInteger(claims.iat) || !Number.isInteger(claims.nbf) || !Number.isInteger(claims.exp)) throw coded('LICENSE_RECEIPT_INVALID', 'O comprovante de licença contém informações incompatíveis.');
  const serverTime = timestamp(claims.serverTime), issuedAt = timestamp(claims.issuedAt), expiry = timestamp(claims.expiresAt), offlineUntil = timestamp(claims.offlineUntil);
  const live = ['trial', 'active'].includes(claims.status);
  if (Math.abs(serverTime - issuedAt) > 10000 || Math.abs(serverTime - claims.iat * 1000) > 2000 || claims.nbf > claims.iat || live && claims.exp < claims.iat || offlineUntil > expiry || offlineUntil > serverTime + GRACE_MS || live && offlineUntil < serverTime || claims.exp !== Math.floor(expiry / 1000)) throw coded('LICENSE_RECEIPT_INVALID', 'O prazo do comprovante de licença é inválido.');
  if (claims.status === 'trial' && claims.plan !== 'trial' || claims.status === 'active' && !['monthly', 'annual'].includes(claims.plan)) throw coded('LICENSE_RECEIPT_INVALID', 'O plano do comprovante é inválido.');
  // The service signs both the conventional whole-second JWT exp and its exact
  // millisecond expiry. Equality above prevents conflicting expiry claims.
  return { ...claims, serverTimeMs: serverTime, expiresAtMs: expiry, offlineUntilMs: offlineUntil, trialStartedAtMs: claims.trialStartedAt ? timestamp(claims.trialStartedAt) : null, trialExpiresAtMs: claims.trialExpiresAt ? timestamp(claims.trialExpiresAt) : null };
}
function configurationValid(config) {
  try { const url = new URL(config.endpoint); publicJwk(config.publicKeyJwk); return url.protocol === 'https:' && !url.username && !url.password && !!config.issuer && !!config.kid; } catch { return false; }
}

class LicenseClient extends EventEmitter {
  constructor({ config = require('./license-config.cjs'), identityProvider, fetchImpl = globalThis.fetch, wallNow = () => Date.now(), monotonicNow = () => Number(process.hrtime.bigint() / 1000000n), uptimeNow = () => os.uptime() * 1000, timeoutMs = 10000, validationIntervalMs = 15 * 60000, checkpointIntervalMs = 60000 } = {}) {
    super(); this.config = config; this.identityProvider = identityProvider; this.fetchImpl = fetchImpl; this.wallNow = wallNow; this.monotonicNow = monotonicNow; this.uptimeNow = uptimeNow; this.timeoutMs = timeoutMs; this.validationIntervalMs = validationIntervalMs; this.checkpointIntervalMs = checkpointIntervalMs;
    this.identity = null; this.state = null; this.claims = null; this.inFlight = null; this.initializing = null; this.stopped = false; this.lastError = null; this.hardFailure = null; this.clockSuspect = false; this.bootIdentity = null; this.bootValidationRequired = false; this.anchor = null; this.lastValidationMono = -Infinity; this.lastCheckpointMono = -Infinity; this.lastAllowed = false; this.recoveryRequired = false; this.controllers = new Set();
  }
  _reason() {
    if (!configurationValid(this.config)) return ['LICENSE_SERVICE_UNCONFIGURED', 'O serviço de licenciamento ainda não foi configurado. Seus dados continuam preservados.'];
    if (this.hardFailure) return [this.hardFailure.code, this.hardFailure.message];
    if (this.bootValidationRequired) return ['LICENSE_BOOT_VALIDATION_REQUIRED', 'O computador reiniciou ou sua inicialização não pôde ser confirmada. Conecte à internet para validar a licença novamente.'];
    if (this.clockSuspect) return ['LICENSE_CLOCK_CHANGED', 'O relógio do computador foi alterado. Conecte à internet e valide a licença novamente.'];
    if (!this.claims) return [this.initializing ? 'LICENSE_VERIFYING' : 'LICENSE_CONNECTION_REQUIRED', this.initializing ? 'Iniciando o teste e verificando a licença no serviço seguro…' : 'Conecte à internet para iniciar o teste gratuito de 72 horas ou ativar uma licença.'];
    return null;
  }
  _trustedNow() {
    if (!this.anchor) return 0;
    const wall = this.wallNow(), mono = this.monotonicNow(), monoDelta = Math.max(0, mono - this.anchor.mono, this.uptimeNow() - this.anchor.uptime), wallDelta = wall - this.anchor.wall;
    if (wall < this.anchor.maxWall - CLOCK_TOLERANCE_MS || wallDelta + CLOCK_TOLERANCE_MS < monoDelta) this.clockSuspect = true;
    this.anchor.maxWall = Math.max(this.anchor.maxWall, wall);
    this.anchor.lastTrusted = Math.max(this.anchor.lastTrusted || this.anchor.trusted, this.anchor.trusted + Math.max(monoDelta, wallDelta, 0));
    return this.anchor.lastTrusted;
  }
  getStatus() {
    const trustedNow = this._trustedNow(), reason = this._reason(), c = this.claims;
    let allowed = false, status = 'connection_required', reasonCode = reason?.[0] || null, text = reason?.[1] || null;
    if (!reason && c) {
      if (c.status === 'revoked') { status = 'revoked'; reasonCode = 'LICENSE_REVOKED'; text = 'Esta licença foi revogada. Os dados continuam preservados.'; }
      else if (c.status === 'expired' || trustedNow >= c.expiresAtMs) { status = 'expired'; reasonCode = 'LICENSE_EXPIRED'; text = c.plan === 'trial' ? 'O teste gratuito terminou. Insira uma chave para continuar.' : 'A licença venceu. Renove para liberar novas operações.'; }
      else if (trustedNow >= c.offlineUntilMs) { status = 'connection_required'; reasonCode = 'LICENSE_OFFLINE_LIMIT'; text = 'A tolerância sem validação terminou. Conecte à internet para verificar a licença.'; }
      else { allowed = true; status = c.status; if (this.lastError) { reasonCode = this.lastError.code; text = this.lastError.retryable ? 'Sem contato com o serviço: a licença permanece válida somente até o limite offline indicado.' : this.lastError.message; } }
    } else if (reasonCode === 'LICENSE_VERIFYING') status = 'verifying';
    else if (reasonCode === 'LICENSE_SERVICE_UNCONFIGURED') status = 'unconfigured';
    else if (this.hardFailure) status = 'invalid';
    if (this.lastAllowed && !allowed) this.recoveryRequired = true;
    this.lastAllowed = allowed;
    return { allowed, status, plan: c?.plan || null, trialStartedAt: c?.trialStartedAtMs || null, trialExpiresAt: c?.trialExpiresAtMs || null, expiresAt: c?.expiresAtMs || null, remainingMs: c ? Math.max(0, c.expiresAtMs - trustedNow) : 0, offlineUntil: c?.offlineUntilMs || null, offlineRemainingMs: c ? Math.max(0, c.offlineUntilMs - trustedNow) : 0, trustedNow: trustedNow || null, reasonCode, reason: text, lastError: this.lastError ? { code: this.lastError.code, message: this.lastError.message, at: this.lastError.at } : null, autoResumeRequired: this.recoveryRequired, serverConfigured: configurationValid(this.config), deviceId: this.identity?.deviceId || null };
  }
  assertAllowed(operation = 'operação') {
    const status = this.getStatus();
    if (!status.allowed) throw coded(status.reasonCode || 'LICENSE_REQUIRED', status.reason || `Ative a licença para realizar esta ${operation}.`, { licenseBlocked: true });
    return true;
  }
  _emit() { this.emit('change', this.getStatus()); }
  async _load() {
    if (this.identity) return;
    if (!this.identityProvider?.load || !this.identityProvider?.loadState || !this.identityProvider?.saveState) throw coded('LICENSE_STORAGE_UNAVAILABLE', 'A proteção da licença não está disponível neste computador.');
    this.identity = await this.identityProvider.load();
    if (!/^[a-f0-9]{64}$/.test(this.identity.deviceId || '') || !this.identity.privateKeyPem) throw coded('LICENSE_IDENTITY_INVALID', 'Não foi possível identificar este dispositivo com segurança.');
    publicJwk(this.identity.publicKeyJwk);
    try { const marker = await this.identityProvider.bootIdentity?.(); this.bootIdentity = /^[a-f0-9]{64}$/.test(marker || '') ? marker : null; } catch { this.bootIdentity = null; }
    this.state = await this.identityProvider.loadState() || { version: 1 };
    if (this.state.authoritativeDenial) this.hardFailure = coded(this.state.authoritativeDenial.code, this.state.authoritativeDenial.message);
    if (this.state.receipt) {
      this.claims = verifyReceipt(this.state.receipt, this.config, this.identity);
      const wall = this.wallNow(), old = this.state.anchor;
      if (!old || !Number.isFinite(old.wall) || !Number.isFinite(old.trusted) || !Number.isFinite(old.maxWall) || !Number.isFinite(old.lastTrusted)) throw coded('LICENSE_CLOCK_STATE_INVALID', 'A referência segura de horário da licença precisa ser validada pela internet.');
      this.clockSuspect = wall < old.maxWall - CLOCK_TOLERANCE_MS;
      // A protected, independent boot marker is mandatory for offline reuse.
      // Missing markers (including older checkpoints) migrate only online.
      this.bootValidationRequired = !this.bootIdentity || old.bootIdentity !== this.bootIdentity;
      const uptime = this.uptimeNow(), uptimeDelta = Number.isFinite(old.uptime) ? uptime - old.uptime : 0;
      // A machine-wide uptime counter survives app restarts. If it restarts
      // (OS reboot), require the service rather than trust a frozen local clock.
      if (Number.isFinite(old.uptime) && uptimeDelta < -CLOCK_TOLERANCE_MS) this.clockSuspect = true;
      if (uptimeDelta > wall - old.wall + CLOCK_TOLERANCE_MS) this.clockSuspect = true;
      const trusted = Math.max(old.lastTrusted, old.trusted + Math.max(0, wall - old.wall, uptimeDelta));
      this.anchor = { trusted, wall, mono: this.monotonicNow(), uptime, maxWall: Math.max(wall, old.maxWall), lastTrusted: trusted };
    }
  }
  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      try {
        if (!configurationValid(this.config)) return this.getStatus();
        try { await this._load(); } catch (error) { this.hardFailure = error; if (!this.identity) return this.getStatus(); this.claims = null; this.anchor = null; }
        await this._run(this.state?.receipt ? 'validate' : 'trial');
      } catch (error) { await this._recordError(error, 'initialize'); }
      finally { this.initializing = null; this._emit(); }
      return this.getStatus();
    })();
    this._emit(); return this.initializing;
  }
  async _recordError(error, action) {
    this.lastError = { code: error.code || 'LICENSE_SERVICE_FAILURE', message: error.message || 'Não foi possível contatar o serviço de licenciamento.', at: this.wallNow(), retryable: !!error.retryable };
    if (action !== 'activate' && !error.retryable && error.code !== 'LICENSE_CONNECTION_REQUIRED') {
      this.hardFailure = error;
      if (this.identity && this.state) {
        this.state.authoritativeDenial = { code: error.code || 'LICENSE_SERVICE_FAILURE', message: error.message || 'A licença precisa ser validada novamente.', at: this.wallNow() };
        try { await this.identityProvider.saveState(this.state); } catch { this.hardFailure = coded('LICENSE_STORAGE_FAILURE', 'Não foi possível preservar o resultado protegido da validação.'); }
      }
    }
    this._emit();
  }
  async _request(route, payload) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs); timer.unref?.(); this.controllers.add(controller);
    try {
      const response = await this.fetchImpl(this.config.endpoint.replace(/\/$/, '') + '/api/v1/' + route, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok || body?.ok !== true) {
        const error = body?.error;
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'LICENSE_SERVICE_FAILURE';
        const messages = { INVALID_KEY: 'A chave informada é inválida.', KEY_INVALID: 'A chave informada é inválida.', KEY_ALREADY_USED: 'Esta chave já foi ativada em outro dispositivo.', KEY_USED: 'Esta chave já foi ativada em outro dispositivo.', DEVICE_IDENTITY_CHANGED: 'Este dispositivo já iniciou o teste com outra identidade protegida. Recupere a identidade original; reinstalar não libera um novo teste.', DEVICE_NOT_FOUND: 'O dispositivo ainda precisa iniciar o teste pela internet.', DEVICE_PROOF_INVALID: 'A identidade protegida não pôde ser validada. Recupere a identidade original deste dispositivo.', LICENSE_REVOKED: 'Esta licença foi revogada.', KEY_REVOKED: 'Esta chave foi revogada.', KEY_EXPIRED: 'Esta chave está expirada.', DEVICE_MISMATCH: 'A chave pertence a outro dispositivo.', RATE_LIMITED: 'Aguarde antes de tentar novamente.', RATE_LIMIT: 'Aguarde antes de tentar novamente.', NONCE_INVALID: 'A solicitação de ativação precisa ser validada novamente.', CHALLENGE_INVALID: 'A solicitação de ativação precisa ser validada novamente.' };
        throw coded(code, messages[code] || 'O serviço não autorizou esta solicitação de licença (' + code + ').', { retryable: !!error?.retryable || response.status >= 500 || response.status === 429 });
      }
      return body;
    } catch (error) {
      if (error.code) throw error;
      throw coded('LICENSE_CONNECTION_REQUIRED', 'Não foi possível conectar ao serviço de licenciamento. Verifique a internet e tente novamente.', { retryable: true });
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  async _run(action, key) {
    if (this.inFlight) {
      if (action === 'activate' && this.activeAction !== 'activate') { await this.inFlight.catch(() => {}); return this._run(action, key); }
      if (action === 'activate' && this.activeKey !== key) throw coded('LICENSE_OPERATION_IN_PROGRESS', 'Uma ativação de licença está em andamento. Aguarde e tente novamente.');
      return this.inFlight;
    }
    this.activeAction = action; this.activeKey = key;
    this.inFlight = (async () => {
      await this._load();
      const requestId = crypto.randomUUID();
      const challenge = await this._request('challenge', { deviceId: this.identity.deviceId, action, requestId });
      if (typeof challenge.nonce !== 'string' || challenge.nonce.length < 16 || !challenge.issuedAt || !challenge.expiresAt) throw coded('LICENSE_CHALLENGE_INVALID', 'O serviço retornou uma solicitação de validação inválida.');
      const envelope = { action, deviceId: this.identity.deviceId, publicKeyJwk: publicJwk(this.identity.publicKeyJwk), requestId, nonce: challenge.nonce, issuedAt: challenge.issuedAt, ...(action === 'activate' ? { key } : {}) };
      const signature = crypto.sign('sha256', Buffer.from(canonicalJson(envelope)), { key: this.identity.privateKeyPem, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      const response = await this._request(action, { envelope, signature });
      const claims = verifyReceipt(response.receipt, this.config, this.identity);
      if (claims.requestId !== requestId) throw coded('LICENSE_RECEIPT_REQUEST_MISMATCH', 'O comprovante recebido não corresponde a esta solicitação. Valide novamente antes de continuar.');
      const challengeAt = timestamp(challenge.issuedAt), challengeExpiry = timestamp(challenge.expiresAt);
      if (challengeExpiry < challengeAt || challengeExpiry - challengeAt > 5 * 60000 || claims.serverTimeMs < challengeAt - CLOCK_TOLERANCE_MS || claims.serverTimeMs > challengeExpiry + CLOCK_TOLERANCE_MS || this.claims && (claims.serverTimeMs < this.claims.serverTimeMs || Number(claims.licenseVersion) < Number(this.claims.licenseVersion))) throw coded('LICENSE_RECEIPT_STALE', 'O serviço retornou um comprovante antigo. Valide novamente antes de continuar.');
      // No untrusted local time can extend an accepted server receipt.
      this.claims = claims; this.state = { version: 1, receipt: response.receipt };
      this.anchor = { trusted: claims.serverTimeMs, wall: this.wallNow(), mono: this.monotonicNow(), uptime: this.uptimeNow(), maxWall: this.wallNow(), lastTrusted: claims.serverTimeMs };
      this.clockSuspect = false; this.bootValidationRequired = false; this.hardFailure = null; this.lastError = null; this.lastValidationMono = this.monotonicNow();
      await this._checkpoint(true);
      this._emit(); return { ...this.getStatus(), alreadyApplied: !!response.alreadyApplied };
    })();
    try { return await this.inFlight; } finally { this.inFlight = null; this.activeAction = null; this.activeKey = null; }
  }
  async activate(input) {
    if (!configurationValid(this.config)) throw coded('LICENSE_SERVICE_UNCONFIGURED', 'O serviço de licenciamento ainda não foi configurado.');
    const key = String(input?.key ?? input ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{16,200}$/.test(key)) throw coded('INVALID_KEY', 'Cole uma chave de licença válida.');
    try { return await this._run('activate', key); } catch (error) { await this._recordError(error, 'activate'); throw error; }
  }
  async validate() {
    if (!configurationValid(this.config)) return this.getStatus();
    try { return await this._run(this.state?.receipt ? 'validate' : 'trial'); } catch (error) { await this._recordError(error, 'validate'); throw error; }
  }
  async _checkpoint(force = false) {
    if (!this.state?.receipt || !this.anchor || this.clockSuspect || this.bootValidationRequired || (!force && this.monotonicNow() - this.lastCheckpointMono < this.checkpointIntervalMs)) return;
    this._trustedNow();
    if (this.clockSuspect) return;
    this.state.anchor = { trusted: this.anchor.trusted, wall: this.anchor.wall, uptime: this.anchor.uptime, bootIdentity: this.bootIdentity, maxWall: this.anchor.maxWall, lastTrusted: this.anchor.lastTrusted };
    await this.identityProvider.saveState(this.state); this.lastCheckpointMono = this.monotonicNow();
  }
  async tick({ validate = true } = {}) {
    if (this.stopped) return this.getStatus();
    const status = this.getStatus(); this._emit();
    try { await this._checkpoint(); } catch (error) { this.hardFailure = coded('LICENSE_STORAGE_FAILURE', 'Não foi possível preservar o controle protegido da licença. Verifique as permissões do Windows.'); this._emit(); }
    if (validate && !this.inFlight && this.monotonicNow() - this.lastValidationMono >= this.validationIntervalMs) {
      // Limit reconnect attempts even when the service stays unavailable.
      this.lastValidationMono = this.monotonicNow();
      await this.validate().catch(() => {});
    }
    return status;
  }
  async shutdown() { this.stopped = true; for (const controller of this.controllers) controller.abort(); await this.inFlight?.catch(() => {}); await this._checkpoint(true).catch(() => {}); }
}

module.exports = { LicenseClient, canonicalJson, jwkThumbprint, verifyReceipt, configurationValid, GRACE_MS, CLOCK_TOLERANCE_MS };
