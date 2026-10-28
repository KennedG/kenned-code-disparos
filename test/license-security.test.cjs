'use strict';

// Independent adversarial review. HTTP is a controlled boundary here; these
// cases prove client validation and persistence, not a public deployment.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { LicenseClient, verifyReceipt, jwkThumbprint, canonicalJson, GRACE_MS } = require('../src/core/license-client.cjs');
const { publicLicenseStatus } = require('../src/core/license-policy.cjs');
const { LicenseIdentityHost } = require('../src/core/license-host.cjs');

const BASE = Date.parse('2026-10-07T12:00:00.123Z');
const DAY = 86400000;
const clone = value => value == null ? value : structuredClone(value);
function keys() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { publicKeyJwk: pair.publicKey.export({ format: 'jwk' }), privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) };
}
function rig() {
  const server = keys(), device = keys();
  const identity = { ...device, deviceId: crypto.createHash('sha256').update('independent-test-hardware').digest('hex') };
  const config = { endpoint: 'https://license-test.invalid', issuer: 'https://license-test.invalid', audience: 'kenned-code-disparos', kid: 'kcd-2026-01', publicKeyJwk: server.publicKeyJwk };
  let wall = BASE, mono = 0, serverNow = BASE, saved = null, blocked = null, archived = null, previousChallenge = null, replayChallenge = null;
  const provider = { load: async () => clone(identity), bootIdentity: async () => 'b'.repeat(64), loadState: async () => clone(saved), saveState: async value => { saved = clone(value); } };
  function claims(overrides = {}) {
    const expiry = serverNow + 30 * DAY;
    return { iss: config.issuer, aud: config.audience, sub: identity.deviceId, deviceKeyThumbprint: jwkThumbprint(identity.publicKeyJwk), status: 'active', plan: 'monthly',
      iat: Math.floor(serverNow / 1000), nbf: Math.floor(serverNow / 1000), exp: Math.floor(expiry / 1000), issuedAt: new Date(serverNow).toISOString(), serverTime: new Date(serverNow).toISOString(),
      expiresAt: new Date(expiry).toISOString(), offlineUntil: new Date(serverNow + GRACE_MS).toISOString(), trialStartedAt: new Date(BASE).toISOString(), trialExpiresAt: new Date(BASE + GRACE_MS).toISOString(), ...overrides };
  }
  function signed(value, headerOverrides = {}) {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: config.kid, ...headerOverrides })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    const content = `${header}.${payload}`;
    return `${content}.${crypto.sign('sha256', Buffer.from(content), { key: server.privateKeyPem, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  }
  const fetchImpl = async (url, options) => {
    const action = url.split('/').at(-1), body = JSON.parse(options.body);
    if (blocked) return { ok: false, status: blocked.status, json: async () => ({ ok: false, error: { code: blocked.code, retryable: blocked.retryable === true } }) };
    if (action === 'challenge') {
      previousChallenge = replayChallenge || { ok: true, nonce: crypto.randomUUID(), issuedAt: new Date(serverNow).toISOString(), expiresAt: new Date(serverNow + 5 * 60000).toISOString() };
      return { ok: true, status: 200, json: async () => clone(previousChallenge) };
    }
    assert.equal(body.envelope.action, action);
    assert.equal(crypto.verify('sha256', Buffer.from(canonicalJson(body.envelope)), { key: crypto.createPublicKey({ key: identity.publicKeyJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(body.signature, 'base64url')), true, 'Client request must be signed by the linked device');
    return { ok: true, status: 200, json: async () => ({ ok: true, receipt: archived || signed(claims({ requestId: body.envelope.requestId })) }) };
  };
  const client = () => new LicenseClient({ config, identityProvider: provider, fetchImpl, wallNow: () => wall, monotonicNow: () => mono, checkpointIntervalMs: 0 });
  return { config, identity, claims, signed, client,
    advance(ms) { wall += ms; mono += ms; serverNow += ms; },
    rollback(ms) { wall -= ms; },
    monotonicOnly(ms) { mono += ms; },
    block(code = 'LICENSE_CONNECTION_REQUIRED', status = 503, retryable = true) { blocked = { code, status, retryable }; },
    unblock() { blocked = null; },
    replay(receipt) { archived = receipt; },
    replayExchange(receipt) { archived = receipt; replayChallenge = clone(previousChallenge); },
    get saved() { return clone(saved); },
    get serverNow() { return serverNow; }
  };
}

test('independent review: altered payload, unknown signing key and wrong device cannot authorize operations', () => {
  const f = rig(), token = f.signed(f.claims());
  assert.equal(verifyReceipt(token, f.config, f.identity).status, 'active');
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify(f.claims({ expiresAt: '2036-10-07T12:00:00.000Z' }))).toString('base64url');
  assert.throws(() => verifyReceipt(parts.join('.'), f.config, f.identity), { code: 'LICENSE_SIGNATURE_INVALID' });
  assert.throws(() => verifyReceipt(token, { ...f.config, publicKeyJwk: keys().publicKeyJwk }, f.identity), { code: 'LICENSE_SIGNATURE_INVALID' });
  assert.throws(() => verifyReceipt(token, f.config, { ...f.identity, deviceId: 'f'.repeat(64) }), { code: 'LICENSE_DEVICE_MISMATCH' });
});

test('independent review: signed algorithm substitution, wrong audience and mismatched plan are rejected', () => {
  const f = rig();
  assert.throws(() => verifyReceipt(f.signed(f.claims(), { alg: 'none' }), f.config, f.identity), { code: 'LICENSE_SIGNATURE_INVALID' });
  assert.throws(() => verifyReceipt(f.signed(f.claims({ aud: 'other-application' })), f.config, f.identity), { code: 'LICENSE_DEVICE_MISMATCH' });
  assert.throws(() => verifyReceipt(f.signed(f.claims({ status: 'active', plan: 'trial' })), f.config, f.identity), { code: 'LICENSE_RECEIPT_INVALID' });
});

test('independent review: even a signed receipt cannot grant more than 72 offline hours or exceed paid expiration', () => {
  const f = rig();
  assert.throws(() => verifyReceipt(f.signed(f.claims({ offlineUntil: new Date(BASE + GRACE_MS + 1).toISOString() })), f.config, f.identity), { code: 'LICENSE_RECEIPT_INVALID' });
  assert.throws(() => verifyReceipt(f.signed(f.claims({ expiresAt: new Date(BASE + DAY).toISOString() })), f.config, f.identity), { code: 'LICENSE_RECEIPT_INVALID' });
});

test('independent review: exact signed expiration is preserved at millisecond precision', () => {
  const f = rig(), value = f.claims();
  assert.equal(verifyReceipt(f.signed(value), f.config, f.identity).expiresAtMs, Date.parse(value.expiresAt));
});

test('independent review: network failure keeps a current proof but cannot create a fresh offline interval after restart', async () => {
  const f = rig(), first = f.client();
  assert.equal((await first.initialize()).allowed, true);
  const deadline = first.getStatus().offlineUntil;
  f.advance(71 * 3600000);
  await first.tick({ validate: false });
  f.block();
  const reopened = f.client();
  assert.equal((await reopened.initialize()).allowed, true);
  assert.equal(reopened.getStatus().offlineUntil, deadline);
  f.advance(3600000);
  assert.equal(reopened.getStatus().allowed, false);
  assert.equal(reopened.getStatus().reasonCode, 'LICENSE_OFFLINE_LIMIT');
});

test('independent review: a known server revocation cannot be forgotten by restarting offline', async () => {
  const f = rig(), first = f.client();
  await first.initialize();
  f.block('LICENSE_REVOKED', 403, false);
  await assert.rejects(first.validate(), { code: 'LICENSE_REVOKED' });
  assert.equal(first.getStatus().allowed, false);
  await first.shutdown();
  f.block();
  const reopened = f.client();
  assert.equal((await reopened.initialize()).allowed, false, 'An authoritative revocation must remain recorded when the network goes away');
});

test('independent review: an archived signed receipt cannot rewind trusted time after a fresh challenge', async () => {
  const f = rig(), first = f.client();
  await first.initialize();
  const old = f.saved.receipt;
  f.advance(4 * DAY);
  assert.equal(first.getStatus().allowed, false);
  f.replay(old);
  await assert.rejects(first.validate(), error => /^LICENSE_(?:RECEIPT|SERVER_TIME|CLOCK)/.test(error.code), 'The receipt must correspond to this fresh server challenge');
  assert.equal(first.getStatus().allowed, false);
});

test('independent review: replaying both an old challenge and receipt cannot satisfy a new client request', async () => {
  const f = rig(), first = f.client();
  await first.initialize();
  const old = f.saved.receipt;
  f.replayExchange(old);
  f.advance(4 * DAY);
  assert.equal(first.getStatus().allowed, false);
  await assert.rejects(first.validate(), error => /^LICENSE_(?:RECEIPT|SERVER_TIME|CLOCK|REQUEST)/.test(error.code));
  assert.equal(first.getStatus().allowed, false);
});

test('independent review: wall-clock rollback and a frozen wall clock cannot extend an offline proof', async () => {
  const f = rig(), first = f.client();
  await first.initialize();
  f.advance(60000);
  await first.tick({ validate: false });
  f.rollback(10000);
  assert.equal(first.getStatus().allowed, false);
  assert.equal(first.getStatus().reasonCode, 'LICENSE_CLOCK_CHANGED');
  const fresh = rig(), second = fresh.client();
  await second.initialize();
  fresh.monotonicOnly(5000);
  assert.equal(second.getStatus().allowed, false);
  assert.equal(second.getStatus().reasonCode, 'LICENSE_CLOCK_CHANGED');
});

test('independent review: the backend public snapshot excludes all receipt and administrative material', () => {
  const marker = 'PRIVATE_TEST_MARKER_NEVER_PUBLIC';
  const status = publicLicenseStatus({ allowed: true, status: 'active', plan: 'annual', expiresAt: BASE, receipt: marker, privateKeyPem: marker, adminToken: marker, allLicenseKeys: [marker], deviceId: marker, lastError: { secret: marker } });
  assert.deepEqual(status, { allowed: true, autoResumeRequired: false, totalBlocked: false, status: 'active', plan: 'annual', expiresAt: BASE });
  assert.equal(JSON.stringify(status).includes(marker), false);
});

test('independent review: an interrupted dual-anchor save cannot choose an older active state over a tied authoritative denial', async () => {
  const host = new LicenseIdentityHost({ platform: 'linux' });
  const anchor = { trusted: BASE, lastTrusted: BASE, wall: BASE, maxWall: BASE, uptime: 1000 };
  const previous = { version: 1, receipt: 'protected-active-proof', anchor };
  const denied = { ...previous, authoritativeDenial: { code: 'LICENSE_REVOKED', message: 'Revogada', at: BASE + 1 } };
  // Crash after registry commit, before atomic-file replacement. Identity and
  // encrypted copies are an injected boundary, not physical DPAPI validation.
  host.load = async () => ({ deviceId: 'a'.repeat(64) });
  host._copies = async () => [previous, denied];
  assert.equal((await host.loadState()).authoritativeDenial?.code, 'LICENSE_REVOKED');
});

test('independent review: expiry blocks control replies and unconfirmed service outage never lends reply exemption to unrelated sends', async t => {
  const { createAppService } = require('../src/backend/service.cjs');
  const { SimulatedAdapter } = require('../src/adapters/simulated.cjs');
  const originalReply = SimulatedAdapter.prototype.reply;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kenned-license-scope-audit-'));
  let service, nestedResult = null;
  const { createLicenseFixture } = require('./fixtures/license.cjs');
  const license = createLicenseFixture();
  SimulatedAdapter.prototype.reply = async function (...args) {
    try { nestedResult = await this.sendPrivate('5562999998888', 'Mensagem automática que não pertence à resposta administrativa', { clientMessageId: crypto.randomUUID() }); }
    catch (error) { nestedResult = error; }
    return originalReply.apply(this, args);
  };
  t.after(async () => { await service?.shutdown(); SimulatedAdapter.prototype.reply = originalReply; await fs.rm(dir, { recursive: true, force: true }); });
  service = await createAppService({ dir, licenseService: license, runtimePlatform: 'linux', host: async action => action === 'secretGet' ? null : { canceled: true } });
  await service.call('setupOwner', { name: 'Dono de teste', username: 'dono-auditoria', phone: '5562999999999', password: 'Senha-Auditoria-License-232!' });
  const model = await service.call('saveTemplate', { name: 'Preservado no vencimento', items: [{ type: 'text', text: 'Conteúdo preservado' }] });
  license.set({ allowed: false, status: 'expired', reasonCode: 'LICENSE_EXPIRED', reason: 'Teste encerrado', expiresAt: Date.now() - 1 });
  await service.systemCall('licenseChanged');
  await assert.rejects(service.call('testSimulation', { text: '!mega ajuda' }), { code: 'LICENSE_EXPIRED' });
  assert.equal(nestedResult, null, 'Confirmed expiry must prevent the administrative reply from entering any submission scope');
  assert.equal(service.snapshot().licenseOnly, true);
  await service.call('licenseActivate', { key: 'ISOLATED-AUDIT-RENEWAL' });
  assert.equal((await service.call('getTemplate', { id: model.id })).name, model.name);
  assert.equal(service.snapshot().automation.stopped, true, 'Renewal does not resume automations');
  license.set({ allowed: false, status: 'network_required', reasonCode: 'LICENSE_CONNECTION_REQUIRED', reason: 'Autoridade de licença temporariamente indisponível.' });
  await service.systemCall('licenseChanged');
  const result = await service.call('testSimulation', { text: '!mega ajuda' });
  assert.ok(result.replies.length > 0, 'Unconfirmed outage permits authorised control replies and must not be mistaken for confirmed expiry');
  assert.equal(nestedResult?.code, 'LICENSE_CONNECTION_REQUIRED', 'The private async context must exempt only the original administrative reply');
});
