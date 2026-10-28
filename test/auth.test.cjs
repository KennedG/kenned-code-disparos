'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuthService, PERMISSIONS, hashPassword, verifyPassword } = require('../src/core/auth.cjs');

const OWNER_PASSWORD = 'Senha do dono 2026!';
const USER_PASSWORD = 'Senha do usuario 2026!';
function memoryStore() {
  let tables = new Map(), audits = [], settings = new Map(), campaigns = [];
  const copy = value => value === undefined ? undefined : structuredClone(value);
  const table = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  return {
    getEntity: (name, id) => copy(table(name).get(id)), listEntities: name => [...table(name).values()].map(copy),
    saveEntity(name, value) { table(name).set(value.id, copy(value)); return copy(value); }, deleteEntity(name, id) { table(name).delete(id); },
    addAudit(value) { const row = { ...copy(value), id: `audit-${audits.length + 1}` }; audits.push(row); return copy(row); },
    transaction(fn) { const prior = copy({ tables, audits, settings, campaigns }); try { return fn(); } catch (err) { ({ tables, audits, settings, campaigns } = prior); throw err; } },
    getSetting: (id, fallback) => copy(settings.has(id) ? settings.get(id) : fallback), setSetting(id, value) { settings.set(id, copy(value)); },
    listCampaigns: () => copy(campaigns), saveCampaign(value) { campaigns = campaigns.filter(c => c.id !== value.id); campaigns.push(copy(value)); return copy(value); },
    audits: () => copy(audits), dump: () => JSON.stringify({ tables: [...tables].map(([id, rows]) => [id, [...rows.values()]]), audits, settings: [...settings], campaigns })
  };
}
async function fixture(options = {}) {
  const store = memoryStore(); const auth = new AuthService({ store, ...options });
  const setup = await auth.setupOwner({ name: 'Dona principal', username: 'dona', password: OWNER_PASSWORD, phone: '+55 (11) 99999-9999' });
  return { store, auth, owner: setup.user, recoveryCodes: setup.recoveryCodes };
}
async function createSeller(auth, extra = {}) {
  return auth.createUser({ name: 'Vendedora', username: 'vendedora', password: USER_PASSWORD, roleId: 'role-seller', requirePasswordChange: false, ...extra });
}

test('passwords use random salted asynchronous scrypt and verify safely', async () => {
  const first = await hashPassword(OWNER_PASSWORD), second = await hashPassword(OWNER_PASSWORD);
  assert.equal(first.algorithm, 'scrypt'); assert.equal(first.N, 32768); assert.notEqual(first.salt, second.salt); assert.notEqual(first.hash, second.hash);
  assert.equal(await verifyPassword(OWNER_PASSWORD, first), true);
  assert.equal(await verifyPassword('outra senha', first), false);
  assert.equal(await verifyPassword(OWNER_PASSWORD, { ...first, N: 1 }), false);
  await assert.rejects(hashPassword('curta'), { code: 'AUTH_INVALID' });
});

test('only one first-owner registration succeeds including concurrent attempts', async () => {
  const store = memoryStore(), auth = new AuthService({ store });
  assert.equal(auth.status().setupRequired, true);
  const attempts = await Promise.allSettled([
    auth.setupOwner({ name: 'Dono A', username: 'dono-a', password: OWNER_PASSWORD }),
    auth.setupOwner({ name: 'Dono B', username: 'dono-b', password: OWNER_PASSWORD })
  ]);
  assert.equal(attempts.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(store.listEntities('users').length, 1); assert.equal(auth.status().setupRequired, false);
  assert.equal(auth.status().authenticated, true); assert.equal(auth.currentUser().isOwner, true);
});

test('setup adopts existing campaigns and legacy authorized phones without modifying content or progress', async () => {
  const store = memoryStore(); store.setSetting('admins', ['5511988888888', 'malformed']);
  store.saveCampaign({ id: 'old', state: 'paused', roundIndex: 17, items: [{ id: 'text-1', text: 'Original' }] });
  const auth = new AuthService({ store });
  const { user } = await auth.setupOwner({ name: 'Dono', username: 'dono', password: OWNER_PASSWORD });
  assert.equal(store.listCampaigns()[0].ownerId, user.id); assert.equal(store.listCampaigns()[0].roundIndex, 17);
  assert.deepEqual(store.listCampaigns()[0].items, [{ id: 'text-1', text: 'Original' }]);
  assert.equal(auth.findAuthorizedPhone('5511988888888').id, user.id);
  assert.equal(auth.findAuthorizedPhone('5511977777777'), null);
});

test('no hashes, password or recovery secrets appear in public users/status/audits', async () => {
  const { auth, store, recoveryCodes } = await fixture();
  const seller = await createSeller(auth);
  const exposed = JSON.stringify([auth.status(), auth.listUsers(), auth.listRoles(), seller, store.audits()]);
  assert.equal(exposed.includes('passwordHash'), false); assert.equal(exposed.includes(OWNER_PASSWORD), false);
  assert.equal(exposed.includes(USER_PASSWORD), false); for (const code of recoveryCodes) assert.equal(store.dump().includes(code), false);
  assert.equal(store.listEntities('recovery_tokens').length, 8);
  assert.ok(PERMISSIONS.some(p => p.id === 'history.clear'));
});

test('unauthenticated signup/user management and permission calls are denied', async () => {
  const { auth } = await fixture(); auth.logout();
  assert.equal(auth.can('connection.manage'), false);assert.equal(auth.canFor(null,'campaign.view'),false);assert.equal(auth.canFor({id:7},'campaign.view'),false);
  await assert.rejects(createSeller(auth), { code: 'AUTH_REQUIRED' });
  assert.throws(() => auth.listUsers(), { code: 'AUTH_REQUIRED' });
  assert.throws(() => auth.assert('campaign.start'), { code: 'AUTH_REQUIRED' });
  assert.equal(auth.status().authenticated, false);
});

test('seller visibility and action scope are enforced from saved ownership', async () => {
  const { auth, owner } = await fixture(); const seller = await createSeller(auth);
  auth.logout(); await auth.login({ username: 'VENDEDORA', password: USER_PASSWORD });
  const own = { id: 'own', ownerId: seller.id }, other = { id: 'other', ownerId: owner.id };
  assert.equal(auth.can('campaign.view', own), true); assert.equal(auth.can('campaign.start', own), true);
  assert.equal(auth.can('campaign.view', other), false); assert.equal(auth.can('campaign.start', other), false);
  assert.equal(auth.can('campaign.delete', own), false); assert.equal(auth.can('history.clear'), false);
  assert.deepEqual(auth.visibleCampaigns([own, other]).map(c => c.id), ['own']);
  assert.equal(auth.canFor({ ...seller, roleId: 'role-owner', isOwner: true }, 'users.create'), false);
});

test('individual grants and all-campaign scope take effect and can be revoked live', async () => {
  const { auth, owner } = await fixture(); const seller = await createSeller(auth);
  auth.updateUser({ id: seller.id, campaignScope: 'all', permissionOverrides: { 'history.clear': true, 'campaign.start': false } });
  assert.equal(auth.canFor(seller, 'campaign.view', { ownerId: owner.id }), true);
  assert.equal(auth.canFor(seller, 'history.clear'), true); assert.equal(auth.canFor(seller, 'campaign.start'), false);
  auth.updateUser({ id: seller.id, permissionOverrides: {} });
  assert.equal(auth.canFor(seller, 'history.clear'), false);
});

test('last owner cannot be deleted, disabled or demoted; additional owner can', async () => {
  const { auth, owner } = await fixture();
  assert.throws(() => auth.deleteUser(owner.id), { code: 'AUTH_LAST_OWNER' });
  assert.throws(() => auth.updateUser({ id: owner.id, active: false }), { code: 'AUTH_LAST_OWNER' });
  assert.throws(() => auth.updateUser({ id: owner.id, roleId: 'role-seller' }), { code: 'AUTH_LAST_OWNER' });
  const second = await auth.createUser({ name: 'Segundo dono', username: 'outro-dono', password: USER_PASSWORD, roleId: 'role-owner', requirePasswordChange: false });
  auth.updateUser({ id: second.id, active: false }); assert.equal(auth.listUsers().find(u => u.id === second.id).active, false);
  auth.deleteUser(second.id); assert.equal(auth.listUsers().length, 1);
});

test('administrator cannot grant owner privileges or modify a protected owner role', async () => {
  const { auth, owner } = await fixture();
  await createSeller(auth, { username: 'administradora', roleId: 'role-admin' });
  auth.logout(); await auth.login({ username: 'administradora', password: USER_PASSWORD });
  assert.throws(() => auth.updateUser({ id: owner.id, name: 'Mudado' }), { code: 'AUTH_DENIED' });
  await assert.rejects(createSeller(auth, { username: 'novo-dono', roleId: 'role-owner' }), { code: 'AUTH_DENIED' });
  assert.throws(() => auth.saveRole({ name: 'Elevado', permissions: ['users.assignOwner'] }), { code: 'AUTH_DENIED' });
  assert.throws(() => auth.saveRole({ id: 'role-owner', name: 'Dono', permissions: [] }), { code: 'AUTH_DENIED' });
});

test('custom profiles are configurable and cannot be deleted while assigned', async () => {
  const { auth } = await fixture();
  const role = auth.saveRole({ name: 'Consulta', campaignScope: 'all', permissions: ['campaign.view', 'history.view'] });
  const user = await createSeller(auth, { roleId: role.id });
  assert.equal(auth.canFor(user, 'campaign.view', { ownerId: 'another' }), true);
  assert.equal(auth.canFor(user, 'campaign.edit'), false);
  assert.throws(() => auth.deleteRole(role.id), /Mova os usuários/);
  auth.updateUser({ id: user.id, roleId: 'role-seller' }); auth.deleteRole(role.id);
  assert.equal(auth.listRoles().some(r => r.id === role.id), false);
});

test('deactivated users and phone commands lose permission immediately without changing GUI actor', async () => {
  const { auth, owner } = await fixture(); const seller = await createSeller(auth, { phone: '5511988888888' });
  const phoneUser = auth.findAuthorizedPhone('5511988888888'); assert.equal(phoneUser.id, seller.id);
  auth.assertFor(phoneUser, 'campaign.pause', { ownerId: seller.id }); assert.equal(auth.currentUser().id, owner.id);
  auth.deactivateUser(seller.id); assert.equal(auth.findAuthorizedPhone('5511988888888'), null);
  assert.equal(auth.canFor(phoneUser, 'campaign.pause', { ownerId: seller.id }), false);
  await assert.rejects(auth.login({ username: seller.username, password: USER_PASSWORD }), { code: 'AUTH_INVALID_CREDENTIALS' });
});

test('phone identities are validated and cannot be claimed by multiple local users', async () => {
  const { auth } = await fixture();
  await assert.rejects(createSeller(auth, { phone: 'not-a-phone' }), { code: 'AUTH_INVALID' });
  await assert.rejects(createSeller(auth, { phone: '5511999999999' }), { code: 'AUTH_CONFLICT' });
  const seller = await createSeller(auth, { phone: '+55 (11) 98888-8888' });
  assert.equal(seller.phone, '5511988888888');
});

test('login throttles repeated failures persistently and permits recovery after the interval', async () => {
  let time = 1000; const { auth, store } = await fixture({ clock: () => time, maxFailures: 2, lockMs: 5000 }); auth.logout();
  await assert.rejects(auth.login({ username: 'dona', password: 'senha errada' }), { code: 'AUTH_INVALID_CREDENTIALS' });
  await assert.rejects(auth.login({ username: 'dona', password: 'senha errada' }), { code: 'AUTH_INVALID_CREDENTIALS' });
  await assert.rejects(auth.login({ username: 'dona', password: OWNER_PASSWORD }), { code: 'AUTH_THROTTLED' });
  const fresh = new AuthService({ store, clock: () => time, maxFailures: 2, lockMs: 5000 });
  await assert.rejects(fresh.login({ username: 'dona', password: OWNER_PASSWORD }), { code: 'AUTH_THROTTLED' });
  time += 5001; await fresh.login({ username: 'dona', password: OWNER_PASSWORD });
  assert.equal(fresh.currentUser().username, 'dona');
});

test('admin-created credentials require a password change before app and WhatsApp operations', async () => {
  const { auth } = await fixture();
  const user = await auth.createUser({ name: 'Novo', username: 'usuario-novo', password: USER_PASSWORD, roleId: 'role-seller', phone: '5511988888888' });
  auth.logout(); const login = await auth.login({ username: 'usuario-novo', password: USER_PASSWORD });
  assert.equal(login.user.requirePasswordChange, true); assert.equal(auth.can('campaign.view', { ownerId: user.id }), false);
  assert.equal(auth.findAuthorizedPhone('5511988888888'), null);
  await auth.changePassword({ currentPassword: USER_PASSWORD, newPassword: 'Nova senha segura 2026!' });
  assert.equal(auth.currentUser().requirePasswordChange, false); assert.equal(auth.can('campaign.view', { ownerId: user.id }), true);
});

test('owner offline recovery codes work once, never stored as plaintext, and require secure new password', async () => {
  const { auth, recoveryCodes, store } = await fixture(); auth.logout();
  await assert.rejects(auth.recoverPassword({ username: 'dona', code: recoveryCodes[0], newPassword: 'curta' }), { code: 'AUTH_INVALID' });
  const newPassword = 'Minha nova senha segura!';
  assert.deepEqual(await auth.recoverPassword({ username: 'dona', code: recoveryCodes[0], newPassword }), { success: true });
  await assert.rejects(auth.recoverPassword({ username: 'dona', code: recoveryCodes[0], newPassword: 'Mais uma senha segura!' }), { code: 'AUTH_INVALID_RECOVERY' });
  await assert.rejects(auth.login({ username: 'dona', password: OWNER_PASSWORD }), { code: 'AUTH_INVALID_CREDENTIALS' });
  await auth.login({ username: 'dona', password: newPassword }); assert.equal(auth.currentUser().isOwner, true);
  assert.equal(store.listEntities('recovery_tokens').filter(t => t.usedAt).length, 1);
});

test('authorized administrator-issued reset expires, consumes once and never exposes another owner code', async () => {
  let time = 1000; const { auth, owner } = await fixture({ clock: () => time, resetTtlMs: 1000 });
  const seller = await createSeller(auth), reset = auth.issueReset({ userId: seller.id });
  time += 1001; await assert.rejects(auth.recoverPassword({ username: seller.username, code: reset.code, newPassword: 'Senha nova segura 2026!' }), { code: 'AUTH_INVALID_RECOVERY' });
  const replacement = auth.issueReset({ userId: seller.id });
  await auth.recoverPassword({ username: seller.username, code: replacement.code, newPassword: 'Senha nova segura 2026!' });
  await assert.rejects(auth.recoverPassword({ username: seller.username, code: replacement.code, newPassword: 'Outra senha segura 2026!' }), { code: 'AUTH_INVALID_RECOVERY' });
  await auth.login({ username: owner.username, password: OWNER_PASSWORD });
  const admin = await createSeller(auth, { username: 'admin-reset', roleId: 'role-admin' });
  auth.logout(); await auth.login({ username: admin.username, password: USER_PASSWORD });
  assert.throws(() => auth.issueReset({ userId: owner.id }), { code: 'AUTH_DENIED' });
});

test('password and recovery rotation invalidate reset tokens and previous offline codes', async () => {
  const { auth, owner, recoveryCodes } = await fixture();
  const reset = auth.issueReset({ userId: owner.id });
  const rotated = await auth.rotateRecoveryCodes({ currentPassword: OWNER_PASSWORD });
  assert.equal(rotated.recoveryCodes.length, 8);
  await assert.rejects(auth.recoverPassword({ username: 'dona', code: recoveryCodes[0], newPassword: 'Outra senha segura 2026!' }), { code: 'AUTH_INVALID_RECOVERY' });
  await auth.changePassword({ currentPassword: OWNER_PASSWORD, newPassword: 'Outra senha segura 2026!' });
  await assert.rejects(auth.recoverPassword({ username: 'dona', code: reset.code, newPassword: 'Mais uma senha segura 2026!' }), { code: 'AUTH_INVALID_RECOVERY' });
});

test('important actions and denials record actor, time and purpose separately from history', async () => {
  const { auth, owner, store } = await fixture(); const seller = await createSeller(auth);
  auth.assertFor(seller.id, 'campaign.pause', { id: 'c1', ownerId: seller.id });
  assert.throws(() => auth.assertFor(seller.id, 'history.clear'), { code: 'AUTH_DENIED' });
  const create = store.audits().find(a => a.action === 'users.created'); assert.equal(create.actorId, owner.id); assert.ok(create.at);
  const denied = store.audits().find(a => a.action === 'access.denied'); assert.equal(denied.actorId, seller.id); assert.equal(denied.detail.permission, 'history.clear');
});

test('additional owners receive their private recovery codes only on their own first login', async () => {
  const { auth, store } = await fixture();
  const second = await auth.createUser({ name: 'Outro dono', username: 'outro-dono', password: USER_PASSWORD, roleId: 'role-owner', requirePasswordChange: false });
  assert.equal(store.listEntities('recovery_tokens').filter(t => t.userId === second.id).length, 0);
  auth.logout(); const firstLogin = await auth.login({ username: second.username, password: USER_PASSWORD });
  assert.equal(firstLogin.recoveryCodes.length, 8);
  auth.logout(); const nextLogin = await auth.login({ username: second.username, password: USER_PASSWORD });
  assert.equal(nextLogin.recoveryCodes, undefined);
});

test('real local database persists auth and ordinary backup/history cleanup preserve accounts and recovery state', async t => {
  const { createStore, seed } = require('../src/core/store.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-auth-persistence-'));
  let store;
  t.after(() => { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store = await createStore(dir); seed(store);
  const auth = new AuthService({ store }); const setup = await auth.setupOwner({ name: 'Dono persistido', username: 'dono-local', password: OWNER_PASSWORD });
  const backup = store.exportData();
  assert.equal(JSON.stringify(backup).includes('passwordHash'), false); assert.equal(JSON.stringify(backup).includes('recovery_tokens'), false);
  store.clearHistory({ categories: ['campaigns', 'sends', 'errors', 'notifications'], actor: setup.user });
  assert.equal(store.listEntities('users').length, 1); assert.equal(store.listEntities('recovery_tokens').length, 8);
  store.importData(backup); assert.equal(store.listEntities('users').length, 1); assert.equal(store.listEntities('recovery_tokens').length, 8);
  store.close(); store = await createStore(dir);
  const fresh = new AuthService({ store }); assert.equal(fresh.status().setupRequired, false);
  assert.equal(fresh.can('connection.manage'),false);assert.equal(fresh.canFor(null,'campaign.view'),false);
  await fresh.login({ username: 'dono-local', password: OWNER_PASSWORD }); assert.equal(fresh.currentUser().id, setup.user.id);
  await fresh.recoverPassword({ username: 'dono-local', code: setup.recoveryCodes[0], newPassword: 'Senha depois de reabrir!' });
  await assert.rejects(fresh.recoverPassword({ username: 'dono-local', code: setup.recoveryCodes[0], newPassword: 'Mais uma senha segura!' }), { code: 'AUTH_INVALID_RECOVERY' });
});
