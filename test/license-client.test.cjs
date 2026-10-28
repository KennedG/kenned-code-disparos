'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { LicenseClient, canonicalJson, jwkThumbprint, GRACE_MS } = require('../src/core/license-client.cjs');
const { LicenseIdentityHost } = require('../src/core/license-host.cjs');
const { createLicenseWorkerProxy } = require('../src/core/license-worker.cjs');
const DAY = 86400000, BASE = Date.parse('2026-01-31T15:00:00.123Z');
function identity(deviceId = crypto.randomBytes(32).toString('hex')) {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { deviceId, publicKeyJwk: pair.publicKey.export({ format: 'jwk' }), privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
function rig() {
  const signing = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const config = { endpoint: 'https://licensing.example', issuer: 'unit-licensing', audience: 'kenned-code-disparos', kid: 'unit-1', publicKeyJwk: signing.publicKey.export({ format: 'jwk' }) };
  const device = identity(), devices = new Map(), keys = new Map([['TEST-MONTHLY-00000001', 'monthly'], ['TEST-MONTHLY-00000002', 'monthly'], ['TEST-ANNUAL-00000001', 'annual']]);
  let wall = BASE, mono = 100000, uptime = 1000000, serverNow = BASE, saved = null, connected = true, delayed = false, pause, unlock, bootId = 'a'.repeat(64), bootAvailable = true;
  const counts = { challenges: 0, trials: 0, activates: 0, validates: 0 };
  function sign(claims) {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: config.kid })).toString('base64url'), payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return header + '.' + payload + '.' + crypto.sign('sha256', Buffer.from(header + '.' + payload), { key: signing.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  }
  const fetchImpl = async (url, request) => {
    if (!connected) throw new Error('offline test');
    if (delayed) await pause;
    const route = url.split('/').at(-1), body = JSON.parse(request.body);
    const good = response => ({ ok: true, status: 200, json: async () => ({ ok: true, ...response }) });
    const reject = code => ({ ok: false, status: 409, json: async () => ({ ok: false, error: { code, retryable: false } }) });
    if (route === 'challenge') { counts.challenges++; return good({ nonce: crypto.randomBytes(32).toString('base64url'), issuedAt: new Date(serverNow).toISOString(), expiresAt: new Date(serverNow + 120000).toISOString() }); }
    const { envelope, signature } = body;
    assert.equal(crypto.verify('sha256', Buffer.from(canonicalJson(envelope)), { key: crypto.createPublicKey({ key: envelope.publicKeyJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
    let record = devices.get(envelope.deviceId);
    if (record && record.thumb !== jwkThumbprint(envelope.publicKeyJwk)) return reject('DEVICE_IDENTITY_CHANGED');
    if (!record) { record = { thumb: jwkThumbprint(envelope.publicKeyJwk), start: serverNow, expiry: serverNow + GRACE_MS, plan: 'trial', paid: false, used: new Set(), version: 1 }; devices.set(envelope.deviceId, record); }
    let alreadyApplied = false;
    if (route === 'trial') counts.trials++;
    if (route === 'validate') counts.validates++;
    if (route === 'activate') {
      counts.activates++;
      const plan = keys.get(envelope.key);
      if (!plan) return reject('KEY_INVALID');
      if (record.used.has(envelope.key)) alreadyApplied = true;
      else {
        const date = new Date(record.paid ? Math.max(serverNow, record.expiry) : serverNow), day = date.getUTCDate();
        date.setUTCDate(1);
        if (plan === 'monthly') date.setUTCMonth(date.getUTCMonth() + 1); else date.setUTCFullYear(date.getUTCFullYear() + 1);
        const max = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate(); date.setUTCDate(Math.min(day, max));
        record.expiry = date.getTime(); record.plan = plan; record.paid = true; record.used.add(envelope.key); record.version++;
      }
    }
    const status = serverNow >= record.expiry ? 'expired' : record.paid ? 'active' : 'trial';
    const claims = { iss: config.issuer, aud: config.audience, sub: envelope.deviceId, deviceKeyThumbprint: record.thumb, iat: Math.floor(serverNow / 1000), nbf: Math.floor(serverNow / 1000), exp: Math.floor(record.expiry / 1000), serverTime: new Date(serverNow).toISOString(), issuedAt: new Date(serverNow).toISOString(), offlineUntil: new Date(Math.min(serverNow + GRACE_MS, record.expiry)).toISOString(), status, plan: record.plan, trialStartedAt: new Date(record.start).toISOString(), trialExpiresAt: new Date(record.start + GRACE_MS).toISOString(), expiresAt: new Date(record.expiry).toISOString(), licenseVersion: record.version, requestId: envelope.requestId, receiptId: crypto.randomUUID() };
    return good({ receipt: sign(claims), alreadyApplied });
  };
  const provider = { load: async () => device, bootIdentity: async () => { if (!bootAvailable) throw new Error('Boot identity unavailable'); return bootId; }, loadState: async () => saved && structuredClone(saved), saveState: async state => { saved = structuredClone(state); } };
  const make = (options = {}) => new LicenseClient({ config, identityProvider: provider, fetchImpl, wallNow: () => wall, monotonicNow: () => mono, uptimeNow: () => uptime, ...options });
  return { config, device, provider, counts, make, get saved() { return saved; }, advance(ms) { wall += ms; mono += ms; uptime += ms; serverNow += ms; }, wallOnly(ms) { wall += ms; }, uptimeOnly(ms) { uptime += ms; }, reboot() { uptime = 1000; mono = 0; bootId = crypto.randomBytes(32).toString('hex'); }, unavailableBoot() { bootAvailable = false; }, eraseBootMarker() { delete saved.anchor.bootIdentity; }, offline() { connected = false; }, online() { connected = true; }, delay() { delayed = true; pause = new Promise(resolve => { unlock = resolve; }); }, release() { delayed = false; unlock(); }, eraseState() { saved = null; } };
}

test('client automatically starts one signed 72-hour trial and keeps the original expiry after restart or data erasure', async () => {
  const f = rig(), client = f.make();
  const starts = await Promise.all([client.initialize(), client.initialize(), client.initialize()]);
  assert.equal(starts[0].allowed, true); assert.equal(starts[0].expiresAt, BASE + GRACE_MS); assert.equal(f.counts.trials, 1);
  f.advance(DAY); await client.shutdown(); const second = f.make(); await second.initialize();
  assert.equal(second.getStatus().expiresAt, BASE + GRACE_MS);
  f.eraseState(); const restored = f.make(); await restored.initialize();
  assert.equal(restored.getStatus().expiresAt, BASE + GRACE_MS); assert.equal(restored.getStatus().remainingMs, 2 * DAY);
});

test('initial trial needs trustworthy service contact and unconfigured clients cannot fabricate a free period', async () => {
  const f = rig(); f.offline(); const client = f.make(); await client.initialize();
  assert.equal(client.getStatus().allowed, false); assert.equal(client.getStatus().reasonCode, 'LICENSE_CONNECTION_REQUIRED'); assert.equal(f.saved, null);
  const unconfigured = f.make({ config: { endpoint: '' } }); await unconfigured.initialize(); assert.equal(unconfigured.getStatus().status, 'unconfigured'); assert.equal(unconfigured.getStatus().allowed, false);
});

test('first monthly license starts at activation, not at trial expiry, with calendar month end and exact milliseconds', async () => {
  const f = rig(), client = f.make(); await client.initialize();
  const activated = await client.activate('TEST-MONTHLY-00000001');
  assert.equal(activated.plan, 'monthly'); assert.equal(activated.expiresAt, Date.parse('2026-02-28T15:00:00.123Z'));
  const again = await client.activate('TEST-MONTHLY-00000001'); assert.equal(again.alreadyApplied, true); assert.equal(again.expiresAt, activated.expiresAt);
  const renewal = await client.activate('TEST-MONTHLY-00000002'); assert.equal(renewal.expiresAt, Date.parse('2026-03-28T15:00:00.123Z'));
});

test('annual activation and expired monthly renewal preserve data and require explicit automation resumption', async () => {
  const f = rig(), client = f.make(); await client.initialize();
  assert.equal((await client.activate('TEST-ANNUAL-00000001')).expiresAt, Date.parse('2027-01-31T15:00:00.123Z'));
  f.advance(366 * DAY); assert.equal(client.getStatus().allowed, false); assert.equal(client.getStatus().status, 'expired');
  const renewed = await client.activate('TEST-MONTHLY-00000001'); assert.equal(renewed.allowed, true); assert.equal(renewed.autoResumeRequired, true); assert.equal(renewed.expiresAt, Date.parse('2027-03-01T15:00:00.123Z'));
});

test('two concurrent submissions of the same key share one activation; unrelated concurrent activation is rejected', async () => {
  const f = rig(), client = f.make(); await client.initialize(); f.delay();
  const first = client.activate('TEST-MONTHLY-00000001'), repeat = client.activate('TEST-MONTHLY-00000001');
  await assert.rejects(client.activate('TEST-ANNUAL-00000001'), error => error.code === 'LICENSE_OPERATION_IN_PROGRESS');
  f.release(); const results = await Promise.all([first, repeat]);
  assert.equal(results[0].expiresAt, results[1].expiresAt); assert.equal(f.counts.activates, 1);
});

test('invalid activation keeps a valid trial, reports the real cause and never calls the failure a network outage', async () => {
  const f = rig(), client = f.make(); await client.initialize();
  await assert.rejects(client.activate('TEST-INVALID-00000001'), error => error.code === 'KEY_INVALID' && /inválida/.test(error.message));
  assert.equal(client.getStatus().allowed, true); assert.equal(client.getStatus().reasonCode, 'KEY_INVALID'); assert.doesNotMatch(client.getStatus().reason, /Sem contato/);
});

test('offline grace is counted with trusted elapsed time, never extends expiry and survives restart without resetting', async () => {
  const f = rig(), client = f.make(); await client.initialize(); await client.activate('TEST-ANNUAL-00000001');
  f.offline(); f.advance(DAY); await client.shutdown(); const second = f.make(); await second.initialize();
  assert.equal(second.getStatus().allowed, true); assert.equal(second.getStatus().offlineRemainingMs, 2 * DAY);
  f.advance(2 * DAY); assert.equal(second.getStatus().allowed, false); assert.equal(second.getStatus().reasonCode, 'LICENSE_OFFLINE_LIMIT');
  f.online(); await second.validate(); assert.equal(second.getStatus().allowed, true); assert.equal(second.getStatus().autoResumeRequired, true);
});

test('machine uptime detects a frozen wall clock while the application is closed and reboot requires revalidation', async () => {
  const f = rig(), client = f.make(); await client.initialize(); await client.shutdown(); f.offline();
  f.uptimeOnly(600000); const second = f.make(); await second.initialize(); assert.equal(second.getStatus().allowed, false); assert.equal(second.getStatus().reasonCode, 'LICENSE_CLOCK_CHANGED');
  f.online(); await second.validate(); assert.equal(second.getStatus().allowed, true); await second.shutdown();
  f.reboot(); f.offline(); const third = f.make(); await third.initialize(); assert.equal(third.getStatus().allowed, false); assert.equal(third.getStatus().reasonCode, 'LICENSE_BOOT_VALIDATION_REQUIRED');
});

test('a new boot cannot reuse an expired trial offline even when its uptime exceeds the old checkpoint and the wall clock is restored', async () => {
  const f = rig(), first = f.make(); await first.initialize(); await first.shutdown();
  const originalMarker = f.saved.anchor.bootIdentity;
  f.advance(4 * DAY); f.reboot(); f.uptimeOnly(1000000); f.wallOnly(-4 * DAY); f.offline();
  const second = f.make(); await second.initialize();
  assert.equal(second.getStatus().allowed, false);
  assert.equal(second.getStatus().reasonCode, 'LICENSE_BOOT_VALIDATION_REQUIRED');
  await second.tick({ validate: false }); await second.shutdown();
  assert.equal(f.saved.anchor.bootIdentity, originalMarker, 'Offline checkpoint must not bless the new boot');
  const third = f.make(); await third.initialize(); assert.equal(third.getStatus().allowed, false);
  f.online(); await third.validate(); assert.equal(third.getStatus().status, 'expired'); assert.equal(third.getStatus().allowed, false);
});

test('missing boot markers require online validation and unavailable OS markers never create an offline restart grant', async () => {
  const f = rig(), first = f.make(); await first.initialize(); await first.shutdown(); f.eraseBootMarker(); f.offline();
  const migrated = f.make(); await migrated.initialize(); assert.equal(migrated.getStatus().allowed, false); assert.equal(migrated.getStatus().reasonCode, 'LICENSE_BOOT_VALIDATION_REQUIRED');
  f.online(); await migrated.validate(); assert.equal(migrated.getStatus().allowed, true); assert.match(f.saved.anchor.bootIdentity, /^[a-f0-9]{64}$/); await migrated.shutdown();
  f.unavailableBoot(); const online = f.make(); await online.initialize(); assert.equal(online.getStatus().allowed, true); assert.equal(f.saved.anchor.bootIdentity, null); await online.shutdown();
  f.offline(); const offline = f.make(); await offline.initialize(); assert.equal(offline.getStatus().allowed, false); assert.equal(offline.getStatus().reasonCode, 'LICENSE_BOOT_VALIDATION_REQUIRED');
});

test('Windows boot marker uses both the stable kernel event RecordId and original boot time; missing evidence fails closed', async () => {
  let recordId = '123456', bootTime = '2026-10-07T10:00:00.0000000Z', missing = false;
  const commands = [];
  const run = async (executable, args) => { commands.push({ executable, args }); if (missing) throw new Error('Event log unavailable'); return { stdout: JSON.stringify({ recordId, bootTime }) }; };
  const host = new LicenseIdentityHost({ platform: 'win32', run });
  const original = await host.bootIdentity(); assert.equal(await host.bootIdentity(), original);
  recordId = '123457'; assert.notEqual(await host.bootIdentity(), original, 'A new event must distinguish reboot even if the wall clock and boot timestamp repeat');
  recordId = '123456'; bootTime = '2026-10-08T10:00:00.0000000Z'; assert.notEqual(await host.bootIdentity(), original);
  assert.equal(commands.every(c => c.executable === 'powershell.exe' && c.args.includes('-NonInteractive') && c.args.at(-1).includes('Microsoft-Windows-Kernel-General') && c.args.at(-1).includes('LastBootUpTime')), true);
  missing = true; await assert.rejects(host.bootIdentity(), { code: 'LICENSE_BOOT_IDENTITY_UNAVAILABLE' });
  missing = false; recordId = '0'; await assert.rejects(host.bootIdentity(), { code: 'LICENSE_BOOT_IDENTITY_UNAVAILABLE' });
});

test('Linux development boot marker reads the kernel boot_id and distinguishes reboots without using elapsed uptime', async () => {
  let value = '11111111-2222-3333-4444-555555555555';
  const host = new LicenseIdentityHost({ platform: 'linux', readFile: filename => { assert.equal(filename, '/proc/sys/kernel/random/boot_id'); return value; } });
  const original = await host.bootIdentity(); assert.equal(await host.bootIdentity(), original);
  value = '11111111-2222-3333-4444-666666666666'; assert.notEqual(await host.bootIdentity(), original);
  value = 'malformed'; await assert.rejects(host.bootIdentity(), { code: 'LICENSE_BOOT_IDENTITY_UNAVAILABLE' });
});

test('the worker synchronous final guard expires without a host event and never exposes private device credentials', async () => {
  let mono = 0;
  const proxy = createLicenseWorkerProxy(async () => ({ allowed: true, status: 'active', plan: 'monthly', remainingMs: 1000, offlineRemainingMs: 800, trustedNow: BASE }), { monotonicNow: () => mono });
  await proxy.initialize(); assert.equal(proxy.assertAllowed(), true); mono = 800;
  assert.throws(() => proxy.assertAllowed(), error => error.code === 'LICENSE_OFFLINE_LIMIT'); mono = 1000;
  assert.throws(() => proxy.assertAllowed(), error => error.code === 'LICENSE_EXPIRED'); assert.doesNotMatch(JSON.stringify(proxy.getStatus()), /privateKeyPem|receipt|signature/);
});

test('Windows DPAPI identity and registry anchor survive profile deletion while stable hardware stays linked', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'licensing-windows-host-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = new Map(), protection = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from('PROTECTED:' + value), decryptString: value => { assert.ok(Buffer.from(value).toString().startsWith('PROTECTED:')); return Buffer.from(value).toString().slice(10); } };
  const run = async (exe, args) => {
    if (exe === 'powershell.exe') return { stdout: '11111111-2222-3333-4444-555555555555\r\n' };
    const name = args[args.indexOf('/v') + 1];
    if (args[0] === 'add') { registry.set(name, args[args.indexOf('/d') + 1]); return { stdout: '' }; }
    if (name === 'MachineGuid') return { stdout: '    MachineGuid    REG_SZ    12345678-1234-5678-1234-567812345678\r\n' };
    if (!registry.has(name)) throw new Error('not found'); return { stdout: '    ' + name + '    REG_SZ    ' + registry.get(name) + '\r\n' };
  };
  const first = new LicenseIdentityHost({ platform: 'win32', directory: dir, safeStorage: protection, run });
  const created = await first.load(); await first.saveState({ version: 1, anchor: { lastTrusted: BASE }, receipt: 'signed-test-receipt' });
  assert.equal(created.deviceId.length, 64); assert.equal(fs.readFileSync(path.join(dir, 'device.protected'), 'utf8').startsWith('PROTECTED:'), true);
  fs.rmSync(dir, { recursive: true, force: true });
  const restored = new LicenseIdentityHost({ platform: 'win32', directory: dir, safeStorage: protection, run });
  assert.equal((await restored.load()).privateKeyPem, created.privateKeyPem); assert.equal((await restored.loadState()).receipt, 'signed-test-receipt');
});

test('Windows cannot downgrade protected identity to an unencrypted file when DPAPI is unavailable', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'licensing-dpapi-failure-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = new LicenseIdentityHost({ platform: 'win32', directory: dir, safeStorage: { isEncryptionAvailable: () => false } });
  assert.throws(() => host._protect({ secret: 'device-key' }), error => error.code === 'LICENSE_PROTECTION_UNAVAILABLE'); assert.equal(fs.existsSync(path.join(dir, 'device.protected')), false);
});

test('Linux development host persists a machine identity with private permissions and still requires hosted licensing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'licensing-linux-host-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = new LicenseIdentityHost({ platform: 'linux', directory: dir, readFile: () => 'a'.repeat(32) }); const record = await first.load();
  const second = new LicenseIdentityHost({ platform: 'linux', directory: dir, readFile: () => 'a'.repeat(32) }); assert.equal((await second.load()).deviceId, record.deviceId); assert.equal((await second.load()).privateKeyPem, record.privateKeyPem);
  assert.equal(fs.statSync(path.join(dir, 'device.protected')).mode & 0o777, 0o600);
});


test('worker final guard counts suspension even before the native host publishes a new status', () => {
  const {createLicenseWorkerProxy}=require('../src/core/license-worker.cjs');
  let wall=100000,mono=1000;
  const proxy=createLicenseWorkerProxy(async()=>{}, {wallNow:()=>wall,monotonicNow:()=>mono});
  proxy.setStatus({allowed:true,status:'active',remainingMs:5000,offlineRemainingMs:5000});
  wall+=6000;
  assert.equal(proxy.getStatus().allowed,false);
  assert.throws(()=>proxy.assertAllowed(),error=>error.code==='LICENSE_EXPIRED');
});

test('worker final guard fails closed on a local clock rollback before the next native checkpoint', () => {
  const {createLicenseWorkerProxy}=require('../src/core/license-worker.cjs');
  let wall=100000;
  const proxy=createLicenseWorkerProxy(async()=>{}, {wallNow:()=>wall,monotonicNow:()=>1000});
  proxy.setStatus({allowed:true,status:'active',remainingMs:5000,offlineRemainingMs:5000});
  wall-=5000;
  assert.throws(()=>proxy.assertAllowed(),error=>error.code==='LICENSE_CLOCK_CHANGED');
});


test('a pasted key waits for a background validation and then activates automatically', async () => {
  const f=rig(),client=f.make();await client.initialize();f.delay();
  const validation=client.validate();const activation=client.activate('TEST-MONTHLY-00000001');
  await Promise.resolve();f.release();await validation;
  const paid=await activation;assert.equal(paid.allowed,true);assert.equal(paid.plan,'monthly');assert.equal(f.counts.activates,1);
});
