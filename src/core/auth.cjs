'use strict';

const { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const scryptAsync = promisify(scrypt);
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const PERMISSIONS = Object.freeze([
  ['campaign.view', 'Visualizar campanhas', 'Campanhas'], ['campaign.create', 'Criar campanhas', 'Campanhas'],
  ['campaign.edit', 'Editar campanhas', 'Campanhas'], ['campaign.delete', 'Excluir campanhas', 'Campanhas'],
  ['campaign.start', 'Iniciar e retomar campanhas', 'Campanhas'], ['campaign.pause', 'Pausar campanhas', 'Campanhas'],
  ['campaign.stop', 'Encerrar campanhas', 'Campanhas'],
  ...['contacts', 'groups', 'media'].flatMap(resource => ['view', 'create', 'edit', 'delete'].map(action => [
    `${resource}.${action}`, `${({ view: 'Visualizar', create: 'Criar', edit: 'Editar', delete: 'Excluir' })[action]} ${({ contacts: 'contatos', groups: 'grupos', media: 'mídias' })[resource]}`, ({ contacts: 'Contatos', groups: 'Grupos', media: 'Mídias' })[resource]
  ])),
  ['reports.view', 'Visualizar relatórios', 'Relatórios'], ['reports.export', 'Exportar relatórios', 'Relatórios'],
  ['history.view', 'Visualizar históricos', 'Históricos'], ['history.export', 'Exportar históricos', 'Históricos'], ['history.clear', 'Apagar históricos', 'Históricos'],
  ['connection.view', 'Visualizar conexão', 'WhatsApp'], ['connection.manage', 'Conectar e desconectar WhatsApp', 'WhatsApp'],
  ['users.view', 'Visualizar usuários', 'Usuários'], ['users.create', 'Criar e aprovar usuários', 'Usuários'],
  ['users.edit', 'Editar usuários', 'Usuários'], ['users.delete', 'Excluir e desativar usuários', 'Usuários'],
  ['users.roles', 'Gerenciar perfis e permissões', 'Usuários'], ['users.assignOwner', 'Atribuir perfil Dono', 'Usuários'],
  ['settings.view', 'Visualizar configurações', 'Configurações'], ['settings.edit', 'Editar configurações', 'Configurações'],
  ['notifications.view', 'Visualizar alertas', 'Alertas'], ['notifications.manage', 'Configurar e testar alertas', 'Alertas'],
  ['diagnostics.view', 'Visualizar diagnóstico', 'Diagnóstico'], ['diagnostics.export', 'Exportar diagnóstico', 'Diagnóstico'],
  ['audit.view', 'Visualizar auditoria', 'Auditoria'],
  ['search.view', 'Consultar ofertas e mensagens capturadas', 'BUSCAS'],
  ['search.run', 'Executar buscas de ofertas', 'BUSCAS'],
  ['search.history', 'Consultar histórico de buscas', 'BUSCAS'],
  ['search.filters', 'Alterar filtros e apelidos de BUSCAS', 'BUSCAS'],
  ['search.manage', 'Gerenciar monitoramento e autorizações de BUSCAS', 'BUSCAS'],
  ['automation.control', 'Parar e retomar todas as automações', 'Controle do sistema'],
  ...['view','create','edit','delete','control'].map(action=>[`reminder.${action}`,({view:'Visualizar lembretes',create:'Criar lembretes',edit:'Editar lembretes',delete:'Excluir lembretes',control:'Ativar, pausar e testar lembretes'})[action],'Lembretes'])
].map(([id, label, section]) => Object.freeze({ id, label, section })));
const PERMISSION_IDS = new Set(PERMISSIONS.map(p => p.id));
const ALL = [...PERMISSION_IDS];
const DEFAULT_ROLES = Object.freeze([
  { id: 'role-owner', name: 'Dono', permissions: ALL, campaignScope: 'all', isOwner: true, builtIn: true },
  { id: 'role-admin', name: 'Administrador', permissions: ALL.filter(p => p !== 'users.assignOwner' && !p.startsWith('search.')), campaignScope: 'all', isOwner: false, builtIn: true },
  { id: 'role-manager', name: 'Responsável', permissions: ALL.filter(p => !p.startsWith('users.') && !p.startsWith('search.') && !['history.clear', 'settings.edit', 'connection.manage', 'audit.view', 'automation.control'].includes(p)), campaignScope: 'all', isOwner: false, builtIn: true },
  { id: 'role-seller', name: 'Vendedor', permissions: ['campaign.view', 'campaign.create', 'campaign.edit', 'campaign.start', 'campaign.pause', 'campaign.stop', 'contacts.view', 'contacts.create', 'contacts.edit', 'groups.view', 'media.view', 'media.create', 'reports.view', 'history.view', 'notifications.view'], campaignScope: 'own', isOwner: false, builtIn: true }
]);

function error(message, code = 'AUTH_DENIED') { return Object.assign(new Error(message), { code }); }
function username(value) {
  if (typeof value !== 'string') throw error('Informe um nome de usuário válido.', 'AUTH_INVALID');
  const result = value.normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
  if (!/^[\p{L}\p{N}._@-]{3,64}$/u.test(result)) throw error('O usuário deve ter de 3 a 64 letras, números ou . _ @ -.', 'AUTH_INVALID');
  return result;
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\x00-\x1f]/.test(value)) throw error('Informe um nome de até 120 caracteres.', 'AUTH_INVALID');
  return value.trim();
}
function phone(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw error('Informe o telefone com código do país e DDD.', 'AUTH_INVALID');
  const cleaned = value.replace(/[\s()+-]/g, '');
  if (!/^[1-9]\d{9,14}$/.test(cleaned)) throw error('Informe de 10 a 15 dígitos, com código do país e DDD.', 'AUTH_INVALID');
  return cleaned;
}
function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256 || /\x00/.test(value)) throw error('A senha deve ter entre 12 e 256 caracteres.', 'AUTH_INVALID');
  return value;
}
function scope(value, fallback = 'own') {
  if (value === undefined) return fallback;
  if (!['own', 'all'].includes(value)) throw error('Visibilidade de campanhas inválida.', 'AUTH_INVALID');
  return value;
}
async function hashPassword(value) {
  password(value);
  const salt = randomBytes(16);
  const key = await scryptAsync(value, salt, 64, SCRYPT);
  return { algorithm: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('hex'), hash: key.toString('hex') };
}
async function verifyPassword(value, record) {
  // The work factor comes from this application, never from an untrusted record.
  const valid = record?.algorithm === 'scrypt' && record.N === SCRYPT.N && record.r === SCRYPT.r && record.p === SCRYPT.p && /^[a-f0-9]{32}$/.test(record.salt || '') && /^[a-f0-9]{128}$/.test(record.hash || '');
  const key = await scryptAsync(typeof value === 'string' && value.length <= 256 ? value : '', valid ? Buffer.from(record.salt, 'hex') : Buffer.alloc(16), 64, SCRYPT);
  return timingSafeEqual(key, valid ? Buffer.from(record.hash, 'hex') : Buffer.alloc(64)) && !!valid;
}
const normalizeCode = value => typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '';
const digestCode = value => createHash('sha256').update(`Mega Disparos recovery:${normalizeCode(value)}`).digest('hex');
function newCode() { return `MEGA-${randomBytes(16).toString('hex').toUpperCase().match(/.{4}/g).join('-')}`; }
function sameDigest(a, b) {
  return /^[a-f0-9]{64}$/.test(a || '') && /^[a-f0-9]{64}$/.test(b || '') && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

class AuthService {
  constructor(options) {
    this.store = options.store || options;
    this.now = options.clock || (() => Date.now());
    this.currentUserId = null;
    this._tail = Promise.resolve(); this._waiting = 0;
    this._unknownFailures = new Map();
    this._recoveryFailures = new Map();
    this.maxFailures = options.maxFailures || 5;
    this.lockMs = options.lockMs || 15 * 60 * 1000;
    this.resetTtlMs = options.resetTtlMs || 30 * 60 * 1000;
    this._tx(() => {
      for (const role of DEFAULT_ROLES) if (!this.store.getEntity('roles', role.id)) this.store.saveEntity('roles', structuredClone(role));
      if (!this.store.getSetting('authPermissionSchema230')) {
        for (const id of ['role-admin','role-manager']) {
          const role=this.store.getEntity('roles',id);
          if (role?.builtIn===true) this.store.saveEntity('roles',{...role,permissions:[...new Set([...(role.permissions||[]),...ALL.filter(p=>p.startsWith('reminder.')||id==='role-admin'&&p==='automation.control')])]});
        }
        this.store.setSetting('authPermissionSchema230',true);
      }
    });
  }
  _tx(fn) { return this.store.transaction ? this.store.transaction(fn) : fn(); }
  _audit(action, targetId, detail, actorId = this.currentUserId) {
    this.store.addAudit({ actorId: actorId || null, action, targetId: targetId || null, at: this.now(), detail: detail || {} });
  }
  _exclusive(fn) {
    if (this._waiting >= 8) return Promise.reject(error('Há operações de acesso em andamento. Tente novamente em instantes.', 'AUTH_BUSY'));
    this._waiting++;
    const work = this._tail.then(fn);
    this._tail = work.catch(() => {});
    return work.finally(() => { this._waiting--; });
  }
  _users() { return this.store.listEntities('users'); }
  _role(user) { return user&&typeof user.roleId==='string'&&user.roleId?this.store.getEntity('roles',user.roleId):null; }
  _isOwner(user) { return !!this._role(user)?.isOwner; }
  _public(user) {
    if (!user) return null;
    const role = this._role(user);
    return {
      id: user.id, name: user.name, username: user.username, phone: user.phone || '', authorizedPhones: [...(user.authorizedPhones || [])],
      roleId: user.roleId, roleName: role?.name || 'Perfil indisponível', isOwner: !!role?.isOwner, active: user.active !== false,
      campaignScope: scope(user.campaignScope, role?.campaignScope || 'own'), permissions: this._permissions(user),
      permissionOverrides: { ...(user.permissionOverrides || {}) }, requirePasswordChange: !!user.requirePasswordChange,
      createdAt: user.createdAt, updatedAt: user.updatedAt
    };
  }
  _permissions(user) {
    const role = this._role(user);
    if (!user || user.active === false || !role) return [];
    if (role.isOwner) return [...ALL];
    const permitted = new Set((role.permissions || []).filter(p => PERMISSION_IDS.has(p)));
    for (const [id, enabled] of Object.entries(user.permissionOverrides || {})) { if (PERMISSION_IDS.has(id)) enabled ? permitted.add(id) : permitted.delete(id); }
    return [...permitted];
  }
  currentUser() {
    const user = this.currentUserId && this.store.getEntity('users', this.currentUserId);
    if (!user || user.active === false || !this._role(user)) { this.currentUserId = null; return null; }
    return this._public(user);
  }
  status() {
    const user = this.currentUser();
    return { setupRequired: !this._users().length, authenticated: !!user, user, permissions: user?.permissions || [], campaignScope: user?.campaignScope || 'own', permissionCatalog: PERMISSIONS };
  }
  canFor(userOrId, permission, campaign) {
    const id=typeof userOrId==='string'?userOrId:userOrId?.id;
    if(typeof id!=='string'||!id)return false;
    const user = this.store.getEntity('users', id);
    if (!user || user.active === false || !this._role(user) || user.requirePasswordChange || !this._permissions(user).includes(permission)) return false;
    const role = this._role(user);
    if (campaign && (permission.startsWith('campaign.') || ['history.view', 'history.export', 'reports.view', 'reports.export', 'diagnostics.view', 'diagnostics.export'].includes(permission)) && !role.isOwner && scope(user.campaignScope, role.campaignScope || 'own') === 'own') {
      return (campaign.ownerId || campaign.ownerUserId) === user.id;
    }
    return true;
  }
  can(permission, campaign) { return this.canFor(this.currentUserId, permission, campaign); }
  assertFor(userOrId, permission, campaign) {
    const identity=typeof userOrId==='string'?userOrId:userOrId?.id;
    if(typeof identity!=='string'||!identity)throw error('Faça login para continuar.', 'AUTH_REQUIRED');
    if (!this.canFor(userOrId, permission, campaign)) {
      const userId = typeof userOrId === 'string' ? userOrId : userOrId?.id;
      this._audit('access.denied', campaign?.id, { permission }, userId || null);
      throw error('Você não tem permissão para esta ação.');
    }
    return this._public(this.store.getEntity('users', typeof userOrId === 'string' ? userOrId : userOrId.id));
  }
  assert(permission, campaign) { return this.assertFor(this.currentUserId, permission, campaign); }
  visibleCampaigns(campaigns = this.store.listCampaigns()) { return campaigns.filter(c => this.can('campaign.view', c)); }
  findAuthorizedPhone(value) {
    let number; try { number = phone(value); } catch { return null; }
    if (!number) return null;
    const user = this._users().find(u => u.active !== false && !u.requirePasswordChange && this._role(u) && [u.phone, ...(u.authorizedPhones || [])].includes(number));
    return this._public(user);
  }
  async setupOwner(input) {
    return this._exclusive(async () => {
      if (this._users().length) throw error('O dono já foi cadastrado. Novos usuários precisam de um administrador.', 'AUTH_SETUP_COMPLETE');
      const prepared = { name: name(input.name), username: username(input.username), phone: phone(input.phone), passwordHash: await hashPassword(input.password) };
      const recoveryCodes = Array.from({ length: 8 }, newCode);
      let user;
      this._tx(() => {
        if (this._users().length) throw error('O dono já foi cadastrado.', 'AUTH_SETUP_COMPLETE');
        const legacyPhones = this.store.getSetting('admins', []).map(v => { try { return phone(v); } catch { return ''; } }).filter(Boolean);
        user = this.store.saveEntity('users', { ...prepared, id: randomUUID(), roleId: 'role-owner', campaignScope: 'all', permissionOverrides: {}, authorizedPhones: [...new Set(legacyPhones)], active: true, requirePasswordChange: false, recoveryProvisioned: true, createdAt: this.now(), updatedAt: this.now() });
        for (const code of recoveryCodes) this.store.saveEntity('recovery_tokens', { id: randomUUID(), userId: user.id, kind: 'owner', digest: digestCode(code), createdAt: this.now(), expiresAt: null, usedAt: null });
        for (const campaign of this.store.listCampaigns()) if (!campaign.ownerId && !campaign.ownerUserId) this.store.saveCampaign({ ...campaign, ownerId: user.id });
        this._audit('auth.owner_setup', user.id, { adoptedLegacyPhones: legacyPhones.length }, user.id);
      });
      this.currentUserId = user.id;
      return { user: this._public(user), recoveryCodes };
    });
  }
  async login(input) {
    return this._exclusive(async () => {
      let key; try { key = username(input.username); } catch { key = '(invalid)'; }
      const user = this._users().find(u => u.username === key);
      const failure = user || this._unknownFailures.get(key) || {};
      if (failure.lockedUntil > this.now()) throw error('Muitas tentativas. Aguarde antes de tentar novamente.', 'AUTH_THROTTLED');
      const valid = await verifyPassword(input.password, user?.passwordHash);
      if (!valid || !user || user.active === false || !this._role(user)) {
        const failCount = (failure.lastFailedAt && this.now() - failure.lastFailedAt < this.lockMs ? failure.failCount || 0 : 0) + 1;
        const patch = { failCount, lastFailedAt: this.now(), lockedUntil: failCount >= this.maxFailures ? this.now() + this.lockMs : 0 };
        this._tx(() => {
          if (user) this.store.saveEntity('users', { ...user, ...patch });
          else { if (this._unknownFailures.size >= 1000) this._unknownFailures.delete(this._unknownFailures.keys().next().value); this._unknownFailures.set(key, patch); }
          this._audit('auth.login_denied', user?.id, { reason: 'invalid_credentials' }, null);
        });
        throw error('Usuário ou senha inválidos, ou acesso desativado.', 'AUTH_INVALID_CREDENTIALS');
      }
      let fresh, recoveryCodes;
      this._tx(() => {
        const live = this._getUser(user.id);
        if (live.active === false || !this._role(live) || JSON.stringify(live.passwordHash) !== JSON.stringify(user.passwordHash)) throw error('Usuário ou senha inválidos, ou acesso desativado.', 'AUTH_INVALID_CREDENTIALS');
        if (this._isOwner(live) && !live.recoveryProvisioned) {
          recoveryCodes = Array.from({ length: 8 }, newCode);
          for (const code of recoveryCodes) this.store.saveEntity('recovery_tokens', { id: randomUUID(), userId: live.id, kind: 'owner', digest: digestCode(code), createdAt: this.now(), expiresAt: null, usedAt: null });
          this._audit('auth.recovery_provisioned', live.id, {}, live.id);
        }
        fresh = this.store.saveEntity('users', { ...live, recoveryProvisioned: live.recoveryProvisioned || !!recoveryCodes, failCount: 0, lastFailedAt: null, lockedUntil: 0, lastLoginAt: this.now() });
        this._audit('auth.login', user.id, {}, user.id);
      });
      this.currentUserId = user.id;
      return { user: this._public(fresh), ...(recoveryCodes ? { recoveryCodes } : {}) };
    });
  }
  logout() { try { if (this.currentUserId) this._audit('auth.logout', this.currentUserId); } finally { this.currentUserId = null; } return { success: true }; }
  _getUser(id) {
    if(typeof id!=='string'||!id)throw error('Usuário não encontrado.', 'AUTH_NOT_FOUND');
    const user = this.store.getEntity('users', id);
    if (!user) throw error('Usuário não encontrado.', 'AUTH_NOT_FOUND');
    return user;
  }
  _actor() {
    const publicUser = this.currentUser();
    if (!publicUser) throw error('Faça login para continuar.', 'AUTH_REQUIRED');
    return this._getUser(publicUser.id);
  }
  _checkRoleAssignment(roleId) {
    const role = this.store.getEntity('roles', roleId);
    if (!role) throw error('Perfil não encontrado.', 'AUTH_INVALID');
    if (role.isOwner) this.assert('users.assignOwner');
    const actor = this._actor();
    if (!this._isOwner(actor)) for (const permission of role.permissions || []) if (!this.can(permission)) throw error('Não é permitido conceder permissões que você não possui.');
    return role;
  }
  _overrides(value) {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('Permissões individuais inválidas.', 'AUTH_INVALID');
    const result = {};
    for (const [key, enabled] of Object.entries(value)) {
      if (!PERMISSION_IDS.has(key) || typeof enabled !== 'boolean') throw error('Permissão individual inválida.', 'AUTH_INVALID');
      if (enabled && !this.can(key)) throw error('Não é permitido conceder permissões que você não possui.');
      result[key] = enabled;
    }
    return result;
  }
  _checkIdentity(candidate) {
    if (this._users().some(u => u.id !== candidate.id && u.username === candidate.username)) throw error('Este nome de usuário já está cadastrado.', 'AUTH_CONFLICT');
    const phones = [candidate.phone, ...(candidate.authorizedPhones || [])].filter(Boolean);
    if (this._users().some(u => u.id !== candidate.id && [u.phone, ...(u.authorizedPhones || [])].filter(Boolean).some(p => phones.includes(p)))) throw error('Este número já pertence a outro usuário.', 'AUTH_CONFLICT');
  }
  _protectOwner(target, replacement) {
    if (!this._isOwner(target)) return;
    if (!this._isOwner(this._actor())) throw error('Somente um dono pode alterar outro dono.');
    if (target.active !== false && (!replacement || replacement.active === false || !this._isOwner(replacement))) {
      const owners = this._users().filter(u => u.active !== false && this._isOwner(u));
      if (owners.length <= 1) throw error('Não é possível remover, desativar ou alterar o perfil do último dono.', 'AUTH_LAST_OWNER');
    }
  }
  listUsers() { this.assert('users.view'); return this._users().map(u => this._public(u)); }
  async createUser(input) {
    return this._exclusive(async () => {
      this.assert('users.create');
      const role = this._checkRoleAssignment(input.roleId);
      const candidate = { id: randomUUID(), name: name(input.name), username: username(input.username), phone: phone(input.phone), roleId: role.id, campaignScope: scope(input.campaignScope, role.campaignScope), permissionOverrides: this._overrides(input.permissionOverrides), authorizedPhones: [], active: input.active !== false, requirePasswordChange: input.requirePasswordChange !== false, createdAt: this.now(), updatedAt: this.now() };
      if (!this._isOwner(this._actor()) && candidate.campaignScope === 'all' && scope(this._actor().campaignScope, this._role(this._actor()).campaignScope) !== 'all') throw error('Você não pode ampliar o acesso a campanhas.');
      this._checkIdentity(candidate);
      candidate.passwordHash = await hashPassword(input.password);
      // Revalidate the actor and identity after asynchronous hashing.
      this.assert('users.create'); this._checkRoleAssignment(candidate.roleId); this._overrides(candidate.permissionOverrides); this._checkIdentity(candidate);
      this._tx(() => { this.store.saveEntity('users', candidate); this._audit('users.created', candidate.id, { roleId: candidate.roleId }); });
      return this._public(candidate);
    });
  }
  updateUser(input) {
    this.assert('users.edit');
    return this._tx(() => {
      const previous = this._getUser(input.id);
      if (input.active !== undefined && typeof input.active !== 'boolean') throw error('Estado de acesso inválido.', 'AUTH_INVALID');
      const role = this._checkRoleAssignment(input.roleId ?? previous.roleId);
      const next = { ...previous, name: input.name === undefined ? previous.name : name(input.name), username: input.username === undefined ? previous.username : username(input.username), phone: input.phone === undefined ? previous.phone : phone(input.phone), roleId: role.id, campaignScope: scope(input.campaignScope, previous.campaignScope ?? role.campaignScope), permissionOverrides: input.permissionOverrides === undefined ? previous.permissionOverrides || {} : this._overrides(input.permissionOverrides), active: input.active === undefined ? previous.active : !!input.active, updatedAt: this.now() };
      if (input.active === false && previous.active !== false) this.assert('users.delete');
      if (!this._isOwner(this._actor()) && next.campaignScope === 'all' && scope(this._actor().campaignScope, this._role(this._actor()).campaignScope) !== 'all') throw error('Você não pode ampliar o acesso a campanhas.');
      this._protectOwner(previous, next); this._checkIdentity(next);
      this.store.saveEntity('users', next); this._audit('users.updated', next.id, { roleId: next.roleId, active: next.active });
      return this._public(next);
    });
  }
  deactivateUser(id) { return this.updateUser({ id: typeof id === 'string' ? id : id.id, active: false }); }
  deleteUser(id) {
    id = typeof id === 'string' ? id : id.id;
    this.assert('users.delete');
    return this._tx(() => {
      const previous = this._getUser(id); this._protectOwner(previous, null);
      for (const token of this.store.listEntities('recovery_tokens')) if (token.userId === id) this.store.deleteEntity('recovery_tokens', token.id);
      this.store.deleteEntity('users', id); this._audit('users.deleted', id);
      if (this.currentUserId === id) this.currentUserId = null;
      return { success: true };
    });
  }
  listRoles() { this.assert('users.view'); return this.store.listEntities('roles').map(r => ({ ...r, permissions: [...r.permissions] })); }
  saveRole(input) {
    this.assert('users.roles');
    const existing = input.id && this.store.getEntity('roles', input.id);
    if (existing?.isOwner || input.isOwner) throw error('O perfil Dono é protegido e não pode ser alterado.');
    if (!Array.isArray(input.permissions) || input.permissions.some(p => !PERMISSION_IDS.has(p))) throw error('Permissões de perfil inválidas.', 'AUTH_INVALID');
    for (const permission of input.permissions) if (!this.can(permission)) throw error('Não é permitido conceder permissões que você não possui.');
    const role = { id: existing?.id || randomUUID(), name: name(input.name), permissions: [...new Set(input.permissions)], campaignScope: scope(input.campaignScope, existing?.campaignScope || 'own'), isOwner: false, builtIn: existing?.builtIn || false, updatedAt: this.now() };
    this._tx(() => { this.store.saveEntity('roles', role); this._audit(existing ? 'roles.updated' : 'roles.created', role.id, { name: role.name }); });
    return role;
  }
  deleteRole(id) {
    id = typeof id === 'string' ? id : id.id;
    this.assert('users.roles');
    const role = this.store.getEntity('roles', id);
    if (!role) throw error('Perfil não encontrado.', 'AUTH_NOT_FOUND');
    if (role.builtIn || role.isOwner) throw error('Os perfis iniciais não podem ser excluídos.');
    if (this._users().some(u => u.roleId === id)) throw error('Mova os usuários deste perfil antes de excluí-lo.');
    this._tx(() => { this.store.deleteEntity('roles', id); this._audit('roles.deleted', id); });
    return { success: true };
  }
  async changePassword(input) {
    return this._exclusive(async () => {
      const user = this._actor();
      if (!await verifyPassword(input.currentPassword, user.passwordHash)) throw error('A senha atual está incorreta.', 'AUTH_INVALID_CREDENTIALS');
      const passwordHash = await hashPassword(input.newPassword);
      if (this._actor().id !== user.id) throw error('A sessão de acesso foi alterada.', 'AUTH_REQUIRED');
      let fresh;
      this._tx(() => {
        fresh = this.store.saveEntity('users', { ...this._getUser(user.id), passwordHash, requirePasswordChange: false, updatedAt: this.now(), failCount: 0, lockedUntil: 0 });
        this._invalidateResetTokens(user.id);
        this._audit('auth.password_changed', user.id);
      });
      return { user: this._public(fresh) };
    });
  }
  _invalidateResetTokens(userId) {
    for (const token of this.store.listEntities('recovery_tokens')) if (token.userId === userId && token.kind === 'reset') this.store.deleteEntity('recovery_tokens', token.id);
  }
  issueReset(input) {
    this.assert('users.edit');
    const user = this._getUser(typeof input === 'string' ? input : input.userId);
    if (this._isOwner(user) && !this._isOwner(this._actor())) throw error('Somente um dono pode recuperar o acesso de outro dono.');
    const code = newCode(), expiresAt = this.now() + this.resetTtlMs;
    this._tx(() => {
      this._invalidateResetTokens(user.id);
      this.store.saveEntity('recovery_tokens', { id: randomUUID(), userId: user.id, kind: 'reset', digest: digestCode(code), createdAt: this.now(), expiresAt, usedAt: null });
      this._audit('auth.reset_issued', user.id, { expiresAt });
    });
    return { code, expiresAt };
  }
  async recoverPassword(input) {
    return this._exclusive(async () => {
      let key; try { key = username(input.username); } catch { key = '(invalid)'; }
      const throttle = this._recoveryFailures.get(key);
      if (throttle?.lockedUntil > this.now()) throw error('Muitas tentativas de recuperação. Aguarde antes de tentar novamente.', 'AUTH_THROTTLED');
      password(input.newPassword);
      const user = this._users().find(u => u.username === key && u.active !== false);
      const digest = digestCode(input.code);
      const token = this.store.listEntities('recovery_tokens').find(t => t.userId === user?.id && !t.usedAt && (!t.expiresAt || t.expiresAt > this.now()) && sameDigest(t.digest, digest));
      if (!user || !token) {
        const count = (throttle?.lastFailedAt && this.now() - throttle.lastFailedAt < this.lockMs ? throttle.count || 0 : 0) + 1;
        if (this._recoveryFailures.size >= 1000) this._recoveryFailures.delete(this._recoveryFailures.keys().next().value);
        this._recoveryFailures.set(key, { count, lastFailedAt: this.now(), lockedUntil: count >= this.maxFailures ? this.now() + this.lockMs : 0 });
        this._audit('auth.recovery_denied', null, {}, null);
        throw error('Código inválido, expirado ou já utilizado.', 'AUTH_INVALID_RECOVERY');
      }
      const passwordHash = await hashPassword(input.newPassword);
      this._tx(() => {
        const freshToken = this.store.getEntity('recovery_tokens', token.id);
        const freshUser = this._getUser(user.id);
        if (!freshToken || freshToken.usedAt || (freshToken.expiresAt && freshToken.expiresAt <= this.now()) || freshUser.active === false) throw error('Código inválido, expirado ou já utilizado.', 'AUTH_INVALID_RECOVERY');
        this.store.saveEntity('recovery_tokens', { ...freshToken, usedAt: this.now() });
        this.store.saveEntity('users', { ...freshUser, passwordHash, requirePasswordChange: false, failCount: 0, lockedUntil: 0, updatedAt: this.now() });
        this._audit('auth.password_recovered', user.id, { kind: token.kind }, user.id);
      });
      this._recoveryFailures.delete(key); this.currentUserId = null;
      return { success: true };
    });
  }
  async rotateRecoveryCodes(input) {
    return this._exclusive(async () => {
      const user = this._actor();
      if (!this._isOwner(user)) throw error('Códigos de recuperação são exclusivos dos donos.');
      if (!await verifyPassword(input.currentPassword, user.passwordHash)) throw error('A senha atual está incorreta.', 'AUTH_INVALID_CREDENTIALS');
      if (this._actor().id !== user.id || !this._isOwner(this._actor())) throw error('A sessão de acesso foi alterada.', 'AUTH_REQUIRED');
      const recoveryCodes = Array.from({ length: 8 }, newCode);
      this._tx(() => {
        for (const token of this.store.listEntities('recovery_tokens')) if (token.userId === user.id && token.kind === 'owner') this.store.deleteEntity('recovery_tokens', token.id);
        for (const code of recoveryCodes) this.store.saveEntity('recovery_tokens', { id: randomUUID(), userId: user.id, kind: 'owner', digest: digestCode(code), createdAt: this.now(), expiresAt: null, usedAt: null });
        this.store.saveEntity('users', { ...this._getUser(user.id), recoveryProvisioned: true });
        this._audit('auth.recovery_rotated', user.id);
      });
      return { recoveryCodes };
    });
  }
}

module.exports = { AuthService, PERMISSIONS, DEFAULT_ROLES, hashPassword, verifyPassword, normalizePhone: phone };
