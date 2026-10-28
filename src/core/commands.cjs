'use strict';

const { randomUUID, randomBytes } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { configurationFingerprint } = require('./campaign-version.cjs');

const SESSION_TTL = 15 * 60 * 1000;
const CONFIRM_TTL = 5 * 60 * 1000;
const HISTORY_WINDOW = 5 * 60 * 1000;
const REPLAY_TTL = 24 * 60 * 60 * 1000;
const MEDIA_TYPES = new Set(['image', 'video', 'document']);
const clone = value => JSON.parse(JSON.stringify(value));
const { normalizePhone: phone } = require('./phone.cjs');
const codeOf = (value, fallback) => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : fallback;
const safeReason = value => String(value || '').slice(0, 800)
  .replace(/(Bearer\s+)[\w.\-]+/gi, '$1[omitido]')
  .replace(/((?:["']?)(?:password|senha|token|secret|authorization|credential|cookie|qr|session|private.?key|api.?key)(?:["']?)\s*[:=]\s*)[^\r\n]*/gi, '$1[omitido]');
const compact = value => String(value || '').replace(/\s+/g, ' ').slice(0, 150);
const fold = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
class ControlError extends Error {}
const fail = message => { throw new ControlError(message); };

class CommandController {
  constructor({ store, scheduler, adapter, mediaManager, authService, automationControl, statusProvider, sendAdminReply, now = () => Date.now() }) {
    this.store = store;
    this.scheduler = scheduler;
    this.adapter = adapter;
    this.mediaManager = mediaManager;
    this.authService = authService || null;
    this.automationControl = automationControl || null;
    this.statusProvider = statusProvider || null;
    this.sendAdminReply = sendAdminReply || null;
    this.actorContext = new AsyncLocalStorage();
    this.now = now;
    this.sessions = new Map();
    this.pending = new Map();
    this._tail = Promise.resolve();
    this._waiting = 0;
    this.replyFailures = new WeakSet();
    this.replyIndex = new Map();
    this.closed = false;
    this.adapterRevision = 0;
    this.receiptListener = receipt => this._receipt(receipt);
    this._recoverReplies();
    this.adapter.on?.('receipt', this.receiptListener);
  }

  setAdapter(adapter) {
    this.adapter.off?.('receipt', this.receiptListener);
    this.adapter = adapter;
    this.adapterRevision++;
    // Configuration and replies cannot cross an integration/account switch.
    this.sessions.clear();
    this.pending.clear();
    this.replyIndex.clear();
    this._recoverReplies();
    this.adapter.on?.('receipt', this.receiptListener);
  }

  close() {
    this.closed = true;
    this.adapter.off?.('receipt', this.receiptListener);
    this.sessions.clear();
    this.pending.clear();
    this.replyIndex.clear();
  }

  handle(context) {
    if (this.closed || !context) return Promise.resolve(false);
    const sender = phone(context.senderNumber);
    const command = context.type === 'text' && /^!mega(?:\s|$)/i.test(String(context.text || '').trim());
    if (!command && !this.sessions.has(sender)) return Promise.resolve(false);
    context = { ...context, commandTraceId: /^wa-receive-[a-f0-9]{24}$/.test(context.traceId || '') ? context.traceId : randomUUID(),
      commandAdapterRevision: this.adapterRevision, commandStorageMode: this.store.getStorageMode?.() || this.adapter.status?.mode || 'whatsapp' };
    this._trace(context, 'recebimento', 'ADMIN_COMMAND_RECEIVED',
      context.fromMe === true ? 'Comando manual da conta conectada observado.' : 'Mensagem de controle recebida; autorização ainda não validada.');
    const authorization = this._authorization(context);
    if (!authorization.allowed) {
      this._trace(context, 'autorizacao', authorization.code, authorization.reason);
      return Promise.resolve(false);
    }
    context.commandActorId = authorization.user?.id || null;
    // An administrator's stop cannot wait for media preparation or slow replies.
    if (command && /^!mega\s+(?:parar\s+tudo|pausar\s+\S+)\s*$/i.test(String(context.text || '').trim())) return this._handle(context);
    if (this._waiting >= 64) {
      this._trace(context, 'fila', 'ADMIN_COMMAND_QUEUE_FULL', 'Fila de comandos cheia; comando não executado. Aguarde e envie um novo comando.');
      return Promise.resolve(false);
    }
    this._waiting++;
    const operation = this._tail.then(() => this._handle(context)).finally(() => { this._waiting--; });
    this._tail = operation.catch(() => {});
    return operation;
  }

  _authorization(context) {
    const denied = (code, reason) => ({ allowed: false, code, reason });
    if (!context || context.verified !== true) return denied('ADMIN_IDENTITY_UNVERIFIED', 'O adaptador não confirmou o telefone real do remetente. Confira a resolução de PN/LID.');
    if (context.isGroup !== false) return denied('ADMIN_PRIVATE_CHAT_REQUIRED', 'Comandos administrativos são aceitos somente em conversa privada.');
    if (context.forwarded !== false) return denied('ADMIN_FORWARDED_REJECTED', 'Mensagem encaminhada ou sem confirmação de origem direta; nenhuma operação executada.');
    if (context.historical === true || context.isHistory === true || context.history === true) return denied('ADMIN_HISTORY_REJECTED', 'Evento de histórico não executa comandos.');
    if (context.automaticMessage === true || context.machineGenerated === true || this.store.isOutboundMessageId?.(context.messageId)) return denied('ADMIN_AUTOMATION_ECHO_REJECTED', 'Eco de mensagem automática ignorado para evitar loops.');
    if (context.fromMe !== false && (context.fromMe !== true || context.trustedSelf !== true || context.selfChat !== true || !this.adapter.isTrustedSelfContext?.(context))) return denied('ADMIN_SELF_IDENTITY_REJECTED', 'Mensagem da própria conta fora da conversa consigo mesma ou sem prova de identidade.');
    const sender = phone(context.senderNumber);
    if (!sender) return denied('ADMIN_PHONE_INVALID', 'Telefone real ausente ou inválido; identificadores internos não são usados como telefone.');
    const directPhone = context.chatId === `${sender}@s.whatsapp.net`;
    const verifiedLid = /^\d+@lid$/.test(context.chatId || '');
    if (!directPhone && !verifiedLid) return denied('ADMIN_REPLY_CHAT_MISMATCH', 'A conversa privada não corresponde à identidade do remetente verificado.');
    let user = null;
    if (this.authService) {
      // Production uses the central collision-safe account resolver. The fallback
      // preserves existing isolated consumers, without accepting legacy admins.
      const resolved = this.authService.resolveWhatsAppActor?.(context);
      user = this.authService.resolveWhatsAppActor ? resolved?.user || resolved : this.authService.findAuthorizedPhone(sender);
      if (!user?.id) return denied(codeOf(resolved?.code, 'ADMIN_SENDER_UNAUTHORIZED'), resolved?.reason || 'O telefone não está vinculado de forma inequívoca a um usuário ativo autorizado.');
      if (this.automationControl && !this.authService.canFor(user, 'automation.control')) return denied('ADMIN_CONTROL_PERMISSION_DENIED', 'Usuário identificado, mas sem permissão de controle administrativo. Permissão de busca não autoriza controle do sistema.');
    } else {
      const admins = this.store.getSetting('admins', []);
      if (!Array.isArray(admins) || !admins.some(number => phone(number) === sender)) return denied('ADMIN_SENDER_UNAUTHORIZED', 'Remetente não consta entre os administradores autorizados.');
      user = { id: null, legacy: true };
    }
    return { allowed: true, user, sender };
  }

  _authorized(context) { return this._authorization(context).allowed; }

  _recentCommands() {
    const values = this.store.getSetting('recentCommandIds', []);
    return (Array.isArray(values) ? values : []).filter(entry => entry && Number.isFinite(entry.at) && entry.at >= Number(this.now()) - REPLAY_TTL);
  }

  _recoverReplies() {
    const entries = this._recentCommands();
    let changed = false;
    for (const entry of entries) for (const reply of entry.replies || []) {
      if (reply.status === 'processing') {
        reply.status = 'uncertain';
        reply.code = 'ADMIN_REPLY_INTERRUPTED';
        reply.reason = 'Aplicativo interrompido durante o envio; aguarde confirmação ou revise antes de repetir.';
        reply.resultAt = Number(this.now());
        changed = true;
      } else if (reply.status === 'pending') {
        reply.status = 'cancelled';
        reply.code = 'ADMIN_REPLY_NOT_SUBMITTED';
        reply.reason = 'Resposta não submetida antes da interrupção; envie um novo comando se necessário.';
        reply.resultAt = Number(this.now());
        changed = true;
      }
      if (reply.messageId) this.replyIndex.set(reply.messageId, entry.id);
    }
    if (changed) {
      this.store.setSetting('recentCommandIds', entries);
      for (const entry of entries) for (const reply of entry.replies || []) if (['ADMIN_REPLY_INTERRUPTED', 'ADMIN_REPLY_NOT_SUBMITTED'].includes(reply.code) && reply.resultAt === Number(this.now())) {
        this._trace({ commandTraceId: entry.traceId, commandActorId: entry.actorId, chatId: entry.chatId }, 'recuperacao', reply.code, reply.reason, { messageId: reply.messageId, status: reply.status });
      }
    }
  }

  _claim(context) {
    const rejected = (code, description) => {
      this._trace(context, 'duplicidade', code, description);
      return false;
    };
    if (typeof context.messageId !== 'string' || !context.messageId || context.messageId.length > 512) return rejected('ADMIN_MESSAGE_ID_INVALID', 'Comando sem identificador válido; nenhuma operação executada.');
    const rawTimestamp = Number(context.timestamp);
    if (!Number.isFinite(rawTimestamp) || rawTimestamp <= 0) return rejected('ADMIN_MESSAGE_TIME_INVALID', 'Comando sem horário original válido; nenhuma operação executada.');
    const timestamp = rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp;
    const now = Number(this.now());
    if (timestamp < now - HISTORY_WINDOW || timestamp > now + 60_000) return rejected('ADMIN_COMMAND_STALE', 'Comando fora da janela de segurança; envie uma nova mensagem privada.');
    const seen = this._recentCommands();
    const activeKeys = new Set(seen.map(entry => entry.id));
    for (const [messageId, commandKey] of this.replyIndex) if (!activeKeys.has(commandKey)) this.replyIndex.delete(messageId);
    const key = `${phone(context.senderNumber)}:${context.messageId}`;
    const previous = seen.find(entry => entry.id === key);
    if (previous) {
      context.commandTraceId = previous.traceId || context.commandTraceId;
      return rejected('ADMIN_COMMAND_DUPLICATE', 'Evento já processado; operação e resposta não foram repetidas.');
    }
    // Retain the durable identities for 24 hours, not just the freshness window.
    // A bounded flood fails closed rather than evicting live replay protection.
    if (seen.length >= 10000) return rejected('ADMIN_REPLAY_CAPACITY', 'Limite diário de comandos atingido; processamento bloqueado para proteger contra repetição.');
    seen.push({ id: key, at: now, traceId: context.commandTraceId, actorId: context.commandActorId || null, chatId: context.chatId, replies: [] });
    this.store.setSetting('recentCommandIds', seen);
    context.commandLedgerKey = key;
    return true;
  }

  _replyRecord(context, messageId, patch) {
    if (context.commandStorageMode && context.commandStorageMode !== (this.store.getStorageMode?.() || this.adapter.status?.mode || 'whatsapp')) throw Object.assign(new Error('A integração foi alterada; a resposta da conta anterior não atravessa os modos.'), { code: 'ADMIN_REPLY_MODE_CHANGED', submitted: true });
    if (!context.commandLedgerKey) return null;
    const entries = this._recentCommands();
    const entry = entries.find(value => value.id === context.commandLedgerKey);
    if (!entry) throw Object.assign(new ControlError('O controle persistente da resposta não foi encontrado.'), { code: 'ADMIN_REPLY_LEDGER_MISSING', definitive: true, submitted: false });
    entry.replies ||= [];
    const previous = entry.replies.find(value => value.messageId === messageId);
    const reply = { ...(previous || {}), ...patch, messageId };
    if (previous?.confirmationScope === 'whatsapp-read') reply.confirmationScope = 'whatsapp-read';
    if (previous?.deliveredAt) reply.deliveredAt = previous.deliveredAt;
    if (previous?.readAt) reply.readAt = previous.readAt;
    // A late accepted result cannot downgrade a receipt already reconciled.
    if (previous && ['confirmed', 'delivered'].includes(previous.status) && !['confirmed', 'delivered'].includes(reply.status)) return previous;
    if (previous?.status === 'delivered' && reply.status === 'confirmed') return previous;
    entry.replies = [...entry.replies.filter(value => value.messageId !== messageId), reply];
    this.store.setSetting('recentCommandIds', entries);
    this.replyIndex.set(messageId, entry.id);
    return reply;
  }

  _receipt(receipt) {
    if (this.closed || !receipt?.messageId || !['confirmed', 'delivered', 'read'].includes(receipt.status)) return;
    const key = this.replyIndex.get(receipt.messageId);
    if (!key) return;
    const simulated = this.adapter.status?.mode === 'simulated';
    if (receipt.simulation === true && !simulated || receipt.mode && (receipt.mode === 'simulated') !== simulated) return;
    try {
      const entry = this._recentCommands().find(value => value.id === key);
      const reply = entry?.replies?.find(value => value.messageId === receipt.messageId);
      if (!entry || !reply || ['pending', 'cancelled', 'failed'].includes(reply.status)) return;
      const delivered = ['delivered', 'read'].includes(receipt.status) || ['whatsapp-delivered', 'whatsapp-read'].includes(receipt.confirmationScope);
      const scope = reply.confirmationScope === 'whatsapp-read' ? 'whatsapp-read' : receipt.confirmationScope || reply.confirmationScope || (simulated ? 'simulation-only' : 'whatsapp-server');
      if (reply.status === 'delivered' && !delivered) return;
      if (reply.status === (delivered ? 'delivered' : 'confirmed') && reply.confirmationScope === scope && (!receipt.readAt || reply.readAt)) return;
      const context = { commandLedgerKey: key, commandTraceId: entry.traceId, commandActorId: entry.actorId, chatId: entry.chatId };
      this._replyRecord(context, receipt.messageId, { status: delivered || reply.status === 'delivered' ? 'delivered' : 'confirmed', confirmationScope: scope, resultAt: reply.resultAt || Number(this.now()), ...(delivered ? { deliveredAt: reply.deliveredAt || receipt.deliveredAt || Number(this.now()) } : {}), ...(receipt.readAt ? { readAt: reply.readAt || receipt.readAt } : {}), code: null, reason: null });
      this._trace(context, 'confirmacao', delivered ? 'ADMIN_REPLY_DELIVERED' : 'ADMIN_REPLY_ACCEPTED', delivered ? 'Entrega da resposta confirmada pelo WhatsApp.' : 'Resposta aceita pelo servidor; a entrega ao dispositivo ainda não foi confirmada.', { messageId: receipt.messageId, confirmationScope: scope });
    } catch { this.scheduler?.blockOnPersistenceFailure?.(); }
  }

  async _reply(context, text) {
    const value = String(text);
    const actorId = this.actorContext.getStore()?.id || null;
    for (let offset = 0; offset < value.length; offset += 3500) {
      const part = value.slice(offset, offset + 3500);
      const messageId = randomBytes(16).toString('hex').toUpperCase();
      const index = Math.floor(offset / 3500) + 1;
      let adapterInvoked = false;
      const assertAuthorized = () => {
        if (this.closed || context.commandAdapterRevision !== this.adapterRevision) throw Object.assign(new ControlError('O aplicativo foi encerrado ou a integração foi alterada antes do envio.'), { code: 'ADMIN_REPLY_INTEGRATION_CHANGED', definitive: true, submitted: false });
        const live = this._authorization(context);
        if (!live.allowed || (live.user?.id || null) !== actorId) throw Object.assign(new ControlError('A identidade ou autorização foi alterada antes do envio da resposta.'), { code: 'ADMIN_REPLY_AUTH_CHANGED', definitive: true, submitted: false });
      };
      const submission = () => {
        assertAuthorized();
        this._replyRecord(context, messageId, { status: 'processing', submittedAt: Number(this.now()) });
        this._trace(context, 'envio', 'ADMIN_REPLY_SUBMITTED', 'Resposta administrativa submetida à integração.', { messageId, recipient: context.chatId, part: index });
        adapterInvoked = true;
        if (this.sendAdminReply) return this.sendAdminReply(context, part, { manual: true, userId: actorId, clientMessageId: messageId, traceId: context.commandTraceId, beforeSubmit: assertAuthorized });
        return this.adapter.reply(context.chatId, part, { replyContext: context, clientMessageId: messageId, traceId: context.commandTraceId, beforeSubmit: assertAuthorized });
      };
      try {
        this._replyRecord(context, messageId, { status: 'pending', queuedAt: Number(this.now()), part: index, parts: Math.ceil(value.length / 3500), recipient: context.chatId });
        this._trace(context, 'fila', 'ADMIN_REPLY_QUEUED', 'Resposta administrativa colocada na fila manual para o solicitante original.', { messageId, recipient: context.chatId, part: index });
        const result = this.sendAdminReply ? await submission() : this.scheduler?.runExternalSubmission ?
          await this.scheduler.runExternalSubmission(submission, { manual: true }) : await submission();
        const delivered = ['delivered', 'read'].includes(result?.status) || ['whatsapp-delivered', 'whatsapp-read'].includes(result?.confirmationScope);
        const accepted = result?.status === 'confirmed' || delivered;
        const status = delivered ? 'delivered' : accepted ? 'confirmed' : 'uncertain';
        this._replyRecord(context, messageId, { status, resultAt: Number(this.now()), confirmationScope: result?.confirmationScope || null, ...(delivered ? { deliveredAt: result.deliveredAt || Number(this.now()) } : {}), code: accepted ? null : 'ADMIN_REPLY_UNCERTAIN', reason: accepted ? null : 'A integração não confirmou a resposta; não será reenviada automaticamente.' });
        this._trace(context, 'resultado', delivered ? 'ADMIN_REPLY_DELIVERED' : accepted ? 'ADMIN_REPLY_ACCEPTED' : 'ADMIN_REPLY_UNCERTAIN',
          delivered ? 'Entrega da resposta confirmada pelo WhatsApp.' : accepted ? 'Resposta aceita pelo servidor; não implica entrega ao dispositivo.' : 'Resultado incerto. Confira o WhatsApp e aguarde confirmação; o sistema não repetirá automaticamente.', { messageId: result?.messageId || messageId, recipient: context.chatId, confirmationScope: result?.confirmationScope || null });
        // A partially uncertain multi-part response must not continue with new
        // parts, nor generate a second error response with different IDs.
        if (!accepted) return;
      } catch (error) {
        const definitive = !adapterInvoked || error?.submitted === false || error?.definitive === true && error?.submitted !== true;
        const code = codeOf(error?.code, definitive ? 'ADMIN_REPLY_FAILED' : 'ADMIN_REPLY_UNCERTAIN');
        const reason = safeReason(error?.message || 'A integração não informou o motivo da falha.');
        try { this._replyRecord(context, messageId, { status: definitive ? 'failed' : 'uncertain', resultAt: Number(this.now()), code, reason }); }
        catch (writeError) { if (writeError?.code !== 'ADMIN_REPLY_MODE_CHANGED') this.scheduler?.blockOnPersistenceFailure?.(); }
        this._trace(context, 'erro', code, reason, { messageId, recipient: context.chatId, submitted: !definitive, temporary: error?.safeToRetry === true });
        if (error && (typeof error === 'object' || typeof error === 'function')) this.replyFailures.add(error);
        throw error;
      }
    }
  }

  _trace(context, stage, code, description, detail = {}) {
    if (!this.store.addDiagnostic || context.commandStorageMode && context.commandStorageMode !== (this.store.getStorageMode?.() || this.adapter.status?.mode || 'whatsapp')) return;
    const level = stage === 'erro' && code !== 'ADMIN_OPERATION_DENIED' || ['ADMIN_REPLY_UNCERTAIN', 'ADMIN_REPLY_INTERRUPTED'].includes(code) ? 'error' :
      stage === 'duplicidade' || stage === 'autorizacao' && code !== 'ADMIN_AUTH_APPROVED' || code === 'ADMIN_COMMAND_QUEUE_FULL' || code === 'ADMIN_REPLY_NOT_SUBMITTED' || code === 'ADMIN_OPERATION_DENIED' ? 'warning' : 'info';
    try { this.store.addDiagnostic({ id: randomUUID(), traceId: context.commandTraceId || null, level,
      at: Number(this.now()), userId: context.commandActorId || this.actorContext.getStore()?.id || null, campaignId: null,
      stage: `admin.${stage}`, code, description: safeReason(description), attempts: stage === 'envio' ? 1 : 0,
      action: 'Controle administrativo privado; autorização preservada e resposta ao solicitante original.',
      guidance: 'Confira a etapa, a identidade verificada, a conexão e o código da falha. Resultados incertos exigem revisão.',
      detail: { chatId: context.chatId || null, fromMe: context.fromMe === true, identityVerified: context.verified === true, ...detail } }); }
    catch { this.scheduler?.blockOnPersistenceFailure?.(); }
  }

  _expire() {
    const now = Number(this.now());
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
    for (const [key, request] of this.pending) if (request.expiresAt <= now) this.pending.delete(key);
  }

  async _handle(context) {
    if (this.closed) return false;
    if (context.commandAdapterRevision !== this.adapterRevision) {
      this._trace(context, 'autorizacao', 'ADMIN_INTEGRATION_CHANGED', 'A integração mudou enquanto o comando aguardava; envie uma nova mensagem.');
      return false;
    }
    const authorization = this._authorization(context);
    if (!authorization.allowed || (authorization.user?.id || null) !== (context.commandActorId || null)) {
      this._trace(context, 'autorizacao', authorization.allowed ? 'ADMIN_ACTOR_CHANGED' : authorization.code,
        authorization.allowed ? 'O vínculo de usuário mudou enquanto o comando aguardava na fila.' : authorization.reason);
      return false;
    }
    const user = authorization.user;
    if (!this._claim(context)) return false;
    return this.actorContext.run(user, () => {
      this._trace(context, 'autorizacao', 'ADMIN_AUTH_APPROVED', 'Identidade vinculada a usuário ativo com permissão de controle.');
      return this._handleAuthorized(context);
    });
  }

  _assert(permission, campaign) {
    if (!this.authService) return;
    try { this.authService.assertFor(this.actorContext.getStore(), permission, campaign); }
    catch { fail('Seu usuário não tem permissão para esta operação ou para esta campanha. Consulte o administrador.'); }
  }

  _audit(action, campaignId, details = {}) {
    this.store.addAudit?.({ action, actorId: this.actorContext.getStore()?.id || null,
      campaignId: campaignId || null, source: 'whatsapp', at: Number(this.now()), ...details });
  }

  _visibleCampaigns() {
    const values = this.store.listCampaigns();
    if (!this.authService) return values;
    return values.filter(campaign => this.authService.canFor(this.actorContext.getStore(), 'campaign.view', campaign));
  }

  async _handleAuthorized(context) {
    const sender = phone(context.senderNumber);
    const actorId = this.actorContext.getStore()?.id || null;
    if (this.sessions.get(sender)?.actorId !== actorId) this.sessions.delete(sender);
    if (this.pending.get(sender)?.actorId !== actorId) this.pending.delete(sender);
    const previousSession = this.sessions.get(sender);
    this._expire();
    const session = this.sessions.get(sender);
    if (session) session.expiresAt = Number(this.now()) + SESSION_TTL;
    const text = String(context.text || '').trim();
    try {
      if (context.type === 'text' && /^!mega(?:\s|$)/i.test(text)) {
        await this._command(context, sender, text.replace(/^!mega\s*/i, ''));
        return true;
      }
      if (session) {
        await this._menuInput(context, sender, session, text);
        return true;
      }
      if (previousSession) await this._reply(context, 'A sessão de configuração expirou. Envie !mega menu para começar outra.');
      return false;
    } catch (error) {
      // A failed reply may already have reached WhatsApp. Do not submit a
      // second generic reply with a new ID or repeat the administrative action.
      if (error && this.replyFailures.has(error)) throw error;
      this._trace(context, 'erro', error instanceof ControlError ? 'ADMIN_OPERATION_DENIED' : 'ADMIN_OPERATION_FAILED',
        error instanceof ControlError ? error.message : 'Falha ao concluir a operação administrativa. Confira o diagnóstico no aplicativo.');
      await this._reply(context, error instanceof ControlError ? error.message :
        'Não foi possível concluir a operação. Confira a conexão e os dados da campanha no aplicativo.');
      return true;
    }
  }

  _campaign(id) {
    const campaign = this.store.getCampaign(id);
    if (!campaign) fail('Campanha não encontrada. Use !mega campanhas para consultar os identificadores.');
    this._assert('campaign.view', campaign);
    return clone(campaign);
  }

  _group(id) {
    this._assert('groups.view');
    const group = this.store.getGroup(id);
    if (!group) fail('Grupo não encontrado. Use !mega grupos para consultar os identificadores.');
    if (!group.authorized) fail('Este grupo ainda não está autorizado no aplicativo.');
    const simulated = this.adapter.status?.mode === 'simulated';
    if (Boolean(group.simulation) !== simulated) fail('O grupo pertence a outra integração. Confira a conexão no aplicativo.');
    return group;
  }

  _maxGroups() {
    const configured = Number(this.store.getSetting('maxSelectedGroups', 15));
    return Number.isInteger(configured) && configured > 0 ? configured : 15;
  }

  _validateProposal(campaign) {
    if (campaign.groupIds.length > this._maxGroups()) fail(`Limite atual: ${this._maxGroups()} grupos. Altere-o nas configurações do aplicativo.`);
    if (new Set(campaign.groupIds).size !== campaign.groupIds.length) fail('Há grupos duplicados na seleção.');
    campaign.groupIds.forEach(id => this._group(id));
    const minimumSpacing = Math.max(3, this.adapter.minimumSpacingSeconds || 3);
    if (!Number.isFinite(campaign.spacingSeconds) || campaign.spacingSeconds < minimumSpacing || campaign.spacingSeconds > 3600) {
      fail(`O espaçamento entre grupos deve ficar entre ${minimumSpacing} e 3600 segundos.`);
    }
    for (const contents of [campaign.items, ...Object.values(campaign.groupOverrides || {}).map(value => value?.items).filter(Boolean)]) {
      if (!Array.isArray(contents) || contents.length > 100) fail('Use até 100 conteúdos por campanha ou configuração individual.');
      for (const item of contents) {
        if (item.type === 'text') {
          if (!String(item.text || '').trim() || item.text.length > 16000) fail('Informe um texto de até 16.000 caracteres.');
        } else {
          if (!MEDIA_TYPES.has(item.type) || !this.store.getMedia(item.mediaId)) fail('Mídia não encontrada na biblioteca gerenciada.');
          if (String(item.caption || '').length > 1000) fail('Legenda: use até 1.000 caracteres.');
        }
      }
    }
  }

  _validateActivation(campaign) {
    this._validateProposal(campaign);
    if (this.adapter.status?.state !== 'connected') fail('Conecte o WhatsApp ou o modo simulado no aplicativo antes de ativar.');
    if (!campaign.groupIds.length) fail('Selecione pelo menos um grupo antes de ativar a campanha.');
    for (const id of campaign.groupIds) {
      const override = campaign.groupOverrides?.[id];
      const items = override?.enabled && Array.isArray(override.items) && override.items.length ? override.items : campaign.items;
      if (!items.length) fail('Adicione pelo menos um conteúdo para cada grupo antes de ativar a campanha.');
    }
    const uncertain = this.store.listJobs({ campaignId: campaign.id, status: 'uncertain', limit: 1000000 });
    if (uncertain.some(job => job.status === 'uncertain')) fail('Revise os envios com resultado incerto no Histórico do aplicativo antes de retomar. Eles não serão reenviados automaticamente.');
  }

  _summary(campaign) {
    const days = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    const schedule = campaign.schedule || {};
    const groups = campaign.groupIds.map(id => this.store.getGroup(id));
    const perRound = groups.length * (campaign.mode === 'rotate' ? Math.min(1, campaign.items.length) : campaign.items.length);
    const [startH, startM] = (schedule.startTime || '00:00').split(':').map(Number);
    const [endH, endM] = (schedule.endTime || '23:59').split(':').map(Number);
    let minutes = endH * 60 + endM - startH * 60 - startM;
    if (minutes <= 0) minutes += 1440;
    let rounds = Math.ceil(minutes / campaign.intervalMinutes);
    if (campaign.dailyRoundLimit > 0) rounds = Math.min(rounds, campaign.dailyRoundLimit);
    let sends = perRound * rounds;
    if (campaign.dailySendLimit > 0) sends = Math.min(sends, campaign.dailySendLimit);
    const describe = (item, index) => `${index + 1}. ${item.type === 'text' ? item.text :
      `${({ image: 'Imagem', video: 'Vídeo', document: 'Documento' })[item.type]}: ${this.store.getMedia(item.mediaId)?.name || item.mediaId}${item.caption ? ` — ${item.caption}` : ''}`}`;
    const contents = campaign.items.map(describe).join('\n');
    const overrideCount = Object.values(campaign.groupOverrides || {}).filter(value => value?.enabled).length;
    const individual = campaign.groupIds.filter(id=>campaign.groupOverrides?.[id]?.enabled).map(id=>{
      const value=campaign.groupOverrides[id],window={...schedule,...value.schedule},items=value.items?.length?value.items:campaign.items;
      return `${this.store.getGroup(id)?.name||id}: ${value.intervalMinutes||campaign.intervalMinutes} min; ${window.startTime}–${window.endTime}; ${(window.days||[]).map(d=>days[d]).join(', ')}; datas ${window.startDate||'livre'} a ${window.endDate||'livre'}.\n${items.map(describe).join('\n')}`;
    }).join('\n\n');
    return `Campanha: ${campaign.name}\nID: ${campaign.id}\nEstado: ${campaign.state}\n` +
      `Modo: ${campaign.mode === 'rotate' ? 'próximo item a cada rodada' : 'repetir todos os itens'}\n` +
      `Conteúdos (${campaign.items.length}):\n${contents || '(nenhum)'}\n` +
      `Grupos (${groups.length}):\n${groups.map(group => `${group?.name || '(indisponível)'} — ${group?.id || ''}`).join('\n') || '(nenhum)'}\n` +
      `Intervalo entre inícios de rodadas: ${campaign.intervalMinutes} min\nEspaçamento entre grupos: ${campaign.spacingSeconds} s\n` +
      `Horário local do computador: ${schedule.startTime}–${schedule.endTime}; ${(schedule.days || []).map(day => days[day]).join(', ')}\n` +
      `Datas: ${schedule.startDate || 'sem início definido'} a ${schedule.endDate || 'sem encerramento definido'}\n` +
      `Limites por dia: ${campaign.dailyRoundLimit || 'sem limite'} rodadas / ${campaign.dailySendLimit || 'sem limite'} envios\n` +
      `Estimativa base: ${perRound} envios por rodada; até ${sends} por dia de funcionamento. Filas longas reduzem esta estimativa.\n` +
      `${overrideCount ? `${overrideCount} grupo(s) com configuração individual; a estimativa base não inclui essas diferenças.\n${individual}\n` : ''}` +
      'O computador precisa permanecer ligado, conectado e sem suspensão. Não há recuperação de rodadas perdidas.';
  }

  _requestConfirmation(sender, campaign, operation, proposal) {
    const token = randomBytes(4).toString('hex');
    // Uma solicitação por administrador; emitir outra invalida a anterior.
    this.pending.set(sender, {
      token, actorId: this.actorContext.getStore()?.id || null, campaignId: campaign.id, revision: campaign.revision,
      fingerprint: configurationFingerprint(campaign), state: campaign.state,
      operation, proposal: proposal ? clone(proposal) : null,
      expiresAt: Number(this.now()) + CONFIRM_TTL
    });
    return `${this._summary(proposal || campaign)}\n\nPara confirmar ${operation === 'edit' ? 'a alteração e a retomada' : 'a ativação'}, envie !mega confirmar ${token} em até 5 minutos. Para cancelar: !mega cancelar.`;
  }

  async _confirm(context, sender, token) {
    const request = this.pending.get(sender);
    if (!request || request.token !== token || request.expiresAt <= Number(this.now())) fail('Confirmação inválida ou expirada. Solicite uma nova prévia/ativação.');
    this.pending.delete(sender); // Consumir antes da execução, inclusive se ela falhar.
    const current = this._campaign(request.campaignId);
    if (configurationFingerprint(current) !== request.fingerprint || current.state !== request.state) fail('A campanha mudou desde o resumo. Confira a campanha e solicite outra confirmação.');
    if (request.operation === 'edit') {
      this._assert('campaign.edit', current);
      this._assert('campaign.pause', current);
      this._assert('campaign.start', current);
      // Cancelar a fila antiga antes de trocar conteúdos/destinos.
      await this.scheduler.pause(current.id);
      await this.scheduler.waitForIdle?.();
      const settled = this._campaign(current.id);
      if (configurationFingerprint(settled) !== request.fingerprint || settled.state !== 'paused') fail('A campanha mudou enquanto a fila era pausada. Solicite outra confirmação.');
      this._assert('campaign.edit', settled);
      this._assert('campaign.start', settled);
      const proposal = { ...request.proposal, roundIndex: settled.roundIndex, state: 'paused', nextRunAt: null };
      this._validateActivation(proposal);
      this.store.saveCampaign(proposal);
      await this.scheduler.resume(current.id);
    } else if (request.operation === 'resume') {
      this._assert('campaign.start', current);
      this._validateActivation(current);
      await this.scheduler.resume(current.id);
    } else {
      this._assert('campaign.start', current);
      this._validateActivation(current);
      await this.scheduler.activate(current.id);
    }
    this._audit(request.operation === 'edit' ? 'campaign.edit-and-start' : 'campaign.start', current.id);
    const session = this.sessions.get(sender);
    if (session?.campaignId === current.id) this._refreshSession(session);
    await this._reply(context, 'Confirmação recebida. Campanha ativada; os envios respeitarão o horário, a conexão e a fila.');
  }

  async _saveEdit(context, sender, original, proposal) {
    this._assert('campaign.edit', original);
    this._validateProposal(proposal);
    const current = this._campaign(original.id);
    if (configurationFingerprint(current) !== configurationFingerprint(original) || current.state !== original.state) fail('A campanha foi alterada enquanto você editava. Selecione-a novamente no menu.');
    if (current.state === 'active') {
      this._assert('campaign.pause', current);
      this._assert('campaign.start', current);
      await this._reply(context, this._requestConfirmation(sender, current, 'edit', proposal));
      return false;
    }
    this.store.saveCampaign({ ...proposal, state: current.state, roundIndex: current.roundIndex, nextRunAt: current.nextRunAt });
    this._audit('campaign.edit', current.id);
    const session = this.sessions.get(sender);
    if (session?.campaignId === original.id) this._refreshSession(session);
    await this._reply(context, 'Alteração salva. A campanha não foi ativada.');
    return true;
  }

  _newCampaign(name) {
    this._assert('campaign.create');
    if (!name.trim() || name.length > 120) fail('Informe um nome de 1 a 120 caracteres.');
    const campaign = {
      id: randomUUID(), ownerId: this.actorContext.getStore()?.id || null, responsibleUserIds: [], alertRecipientIds: [],
      retryPolicy: { maxAttempts: 3, delaySeconds: 30 }, name: name.trim(), state: 'draft', mode: 'repeat', intervalMinutes: 10,
      spacingSeconds: 5, schedule: { days: [0, 1, 2, 3, 4, 5, 6], startTime: '08:00', endTime: '18:00', startDate: '', endDate: '' },
      dailyRoundLimit: 0, dailySendLimit: 0, groupIds: [], items: [], groupOverrides: {},
      nextRunAt: null, roundIndex: 0, revision: 1
    };
    this.store.saveCampaign(campaign);
    this._audit('campaign.create', campaign.id);
    return this._campaign(campaign.id);
  }

  _help() {
    return 'Kenned Code Disparos — comandos da conversa autorizada\n' +
      '!mega ajuda\n!mega status\n!mega campanhas\n!mega grupos\n!mega menu\n!mega criar NOME\n!mega editar ID\n' +
      '!mega pausar ID\n!mega retomar ID\n!mega ativar ID\n!mega parar tudo\n!mega intervalo ID MINUTOS\n' +
      '!mega adicionar-grupo ID_CAMPANHA ID_GRUPO\n!mega remover-grupo ID_CAMPANHA ID_GRUPO\n!mega previa ID\n' +
      '!mega retomar sistema — reabrir as filas após parar tudo\n!mega confirmar CÓDIGO\n!mega cancelar\n\nAtivação e alterações em campanhas ativas exigem a confirmação do resumo. Sessões de edição expiram após 15 minutos sem uso.';
  }

  _campaignList() {
    this._assert('campaign.view');
    return this._visibleCampaigns().map((campaign, index) => `${index + 1}. ${campaign.name} [${campaign.state}]\n${campaign.id}`).join('\n') || 'Nenhuma campanha cadastrada.';
  }

  _groupList() {
    this._assert('groups.view');
    return this.store.listGroups().map((group, index) => `${index + 1}. ${group.name} — ${group.authorized ? 'autorizado' : 'não autorizado'}${group.simulation ? ' (simulação)' : ''}\n${group.id}`).join('\n') || 'Nenhum grupo carregado. Conecte e atualize os grupos no aplicativo.';
  }

  _session(sender, campaign) {
    const session = { phase: 'home', actorId: this.actorContext.getStore()?.id || null, campaignId: campaign?.id || null, revision: campaign?.revision || null,
      fingerprint: campaign ? configurationFingerprint(campaign) : null, state: campaign?.state || null,
      groupId: null, expiresAt: Number(this.now()) + SESSION_TTL };
    this.sessions.set(sender, session);
    return session;
  }

  _refreshSession(session) {
    const campaign = this.store.getCampaign(session.campaignId);
    session.revision = campaign?.revision || null;
    session.fingerprint = campaign ? configurationFingerprint(campaign) : null;
    session.state = campaign?.state || null;
  }

  _home(session) {
    const campaign = session.campaignId ? this.store.getCampaign(session.campaignId) : null;
    if (campaign) this._assert('campaign.view', campaign);
    return `Menu Kenned Code Disparos${campaign ? ` — ${campaign.name}` : ''}\n` +
      '1 Criar campanha\n2 Editar/selecionar campanha\n3 Selecionar/remover grupos e configurar grupo\n' +
      '4 Horários, intervalos e limites\n5 Adicionar texto ou mídia\n6 Ordenar/remover conteúdos\n7 Resultados e falhas\n8 Prévia e ativação\n' +
      `${this.statusProvider ? '9 Estado de filas, monitoramento, alertas e lembretes\n' : ''}` +
      '0 Encerrar menu\nResponda com o número. Para retornar de uma etapa: !mega menu.' +
      `${this.automationControl ? '\nEmergência: !mega parar tudo. Reabrir as filas: !mega retomar sistema.' : ''}`;
  }

  async _command(context, sender, body) {
    const words = body.trim().split(/\s+/);
    const command = fold(words.shift() || 'menu');
    this._trace(context, 'interpretacao', 'ADMIN_COMMAND_PARSED', `Comando administrativo interpretado: ${['ajuda','menu','cancelar','confirmar','status','campanhas','grupos','parar','criar','editar','previa','pausar','ativar','retomar','intervalo','adicionar-grupo','remover-grupo'].includes(command) ? command : 'não reconhecido'}.`);
    if (command === 'ajuda') return this._reply(context, this._help());
    if (command === 'menu') {
      const old = this.sessions.get(sender);
      const campaign = old?.campaignId ? this.store.getCampaign(old.campaignId) : null;
      const session = this._session(sender, campaign);
      return this._reply(context, this._home(session));
    }
    if (command === 'cancelar') {
      this.pending.delete(sender);
      return this._reply(context, 'Solicitação de confirmação cancelada.');
    }
    if (command === 'confirmar') return this._confirm(context, sender, words[0]);
    if (command === 'status') {
      this._assert('connection.view');
      this._assert('campaign.view');
      const campaigns = this._visibleCampaigns();
      const next = campaigns.filter(campaign => campaign.state === 'active' && campaign.nextRunAt)
        .map(campaign => campaign.nextRunAt).sort((a, b) => new Date(a) - new Date(b))[0];
      const details = this.statusProvider ? await this.statusProvider({ userId: this.actorContext.getStore()?.id || null }) : null;
      const counts = value => typeof value === 'number' ? String(value) : value && typeof value === 'object' ? Object.entries(value).filter(([,v]) => typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length < 100)).map(([key,v]) => `${key}: ${v}`).join('; ') : 'não informado';
      const connection = ({ connected: 'conectado', disconnected: 'desconectado', connecting: 'conectando', qr: 'aguardando leitura do QR', restricted: 'restrito' })[this.adapter.status?.state] || 'indisponível';
      return this._reply(context, `Conexão: ${connection}\n` +
        `Campanhas: ${campaigns.length}; ativas: ${campaigns.filter(campaign => campaign.state === 'active').length}\n` +
        `Próximo envio: ${next ? new Date(next).toLocaleString('pt-BR', { timeZone: this.store.getSetting('buscasSettings', {})?.timezone || 'America/Sao_Paulo' }) : 'não programado'}\n` +
        `${this.automationControl ? `Automação: ${this.automationControl.isStopped() ? 'INTERROMPIDA — retomada explícita necessária' : 'habilitada'}\n` : ''}` +
        `${details ? `Filas: ${counts(details.queues || details.queue || details.scheduler)}\nMonitoramento: ${counts(details.monitoring || details.monitor || details.search)}\nAlertas: ${counts(details.alerts)}\nLembretes: ${counts(details.reminders)}\n` : ''}` +
        `${this.adapter.status?.mode === 'simulated' ? 'Modo simulado: nenhuma mensagem real é enviada.' : 'O envio requer computador ligado, internet e conexão ativa.'}`);
    }
    if (command === 'campanhas') return this._reply(context, this._campaignList());
    if (command === 'grupos') return this._reply(context, this._groupList());
    if (command === 'parar' && fold(words.join(' ')) === 'tudo') {
      this._assert(this.automationControl ? 'automation.control' : 'campaign.stop');
      // A global stop must cover every campaign; a seller's own scope cannot stop others.
      if (!this.automationControl) for (const campaign of this.store.listCampaigns()) this._assert('campaign.stop', campaign);
      this.pending.clear();
      this.sessions.clear();
      if (this.automationControl) {
        const report = await this.automationControl.stop({ actorId: this.actorContext.getStore()?.id || null, source: 'whatsapp' });
        this._audit('automation.stop-all', null, { report });
        const count = value => typeof value === 'number' ? value : Number(value?.cancelled ?? value?.stopped ?? value?.campaigns ?? value?.count) || 0;
        return this._reply(context, `🛑 Todos os envios automáticos foram interrompidos.\n\nCampanhas: ${count(report.campaigns)}\nEnvios de campanhas pendentes: ${Number(report.campaigns?.jobs || report.jobs) || 0}\nResultados de buscas pendentes: ${count(report.search)}\nAlertas pendentes: ${count(report.alerts)}\nLembretes pausados: ${Number(report.reminders?.paused ?? report.reminders?.stopped ?? count(report.reminders)) || 0}\nAvisos de lembretes pendentes cancelados: ${count(report.reminders)}\n\n${report.inFlight ? `${report.inFlight} envio(s) já em andamento não pôde/puderam ser cancelado(s); o resultado será registrado.\n` : ''}Novas entradas nas filas estão bloqueadas. Os dados foram preservados. Para reabrir as filas, envie !mega retomar sistema. As campanhas precisam de ativação individual.${report.errors?.length ? `\n⚠️ ${report.errors.join(' ')}` : ''}`);
      }
      await this.scheduler.stopAll();
      this._audit('campaign.stop-all');
      return this._reply(context, 'Todas as campanhas foram interrompidas. Um envio já submetido ao WhatsApp pode terminar; a fila restante foi cancelada.');
    }
    if (command === 'retomar' && fold(words.join(' ')) === 'sistema') {
      if (!this.automationControl) fail('A retomada global não está disponível nesta integração.');
      this._assert('automation.control');
      await this.automationControl.resume({ actorId: this.actorContext.getStore()?.id || null, source: 'whatsapp' });
      this._audit('automation.resume');
      return this._reply(context, '✅ Novas entradas nas filas automáticas foram liberadas. Envios cancelados não serão repetidos e campanhas interrompidas continuam encerradas; ative apenas as que deseja executar.');
    }
    if (command === 'criar') {
      const campaign = this._newCampaign(words.join(' '));
      const session = this._session(sender, campaign);
      return this._reply(context, `Campanha criada e desativada. ID: ${campaign.id}\n${this._home(session)}`);
    }
    if (command === 'editar') {
      const campaign = this._campaign(words[0]);
      this._assert('campaign.edit', campaign);
      const session = this._session(sender, campaign);
      return this._reply(context, this._home(session));
    }
    if (command === 'previa') return this._reply(context, this._summary(this._campaign(words[0])));
    if (command === 'pausar') {
      const campaign = this._campaign(words[0]);
      this._assert('campaign.pause', campaign);
      this._invalidateCampaign(campaign.id);
      await this.scheduler.pause(campaign.id);
      this._audit('campaign.pause', campaign.id);
      return this._reply(context, 'Campanha pausada. A fila ainda não enviada foi cancelada.');
    }
    if (command === 'ativar' || command === 'retomar') {
      const campaign = this._campaign(words[0]);
      this._assert('campaign.start', campaign);
      this._validateActivation(campaign);
      return this._reply(context, this._requestConfirmation(sender, campaign, command === 'retomar' ? 'resume' : 'activate'));
    }
    if (command === 'intervalo') {
      const campaign = this._campaign(words[0]);
      campaign.intervalMinutes = this._number(words[1], 1, 10080, 'intervalo em minutos');
      return this._saveEdit(context, sender, this._campaign(campaign.id), campaign);
    }
    if (command === 'adicionar-grupo' || command === 'remover-grupo') {
      const original = this._campaign(words[0]);
      const proposal = clone(original);
      const groupId = words[1];
      if (command === 'adicionar-grupo') {
        this._group(groupId);
        if (!proposal.groupIds.includes(groupId)) proposal.groupIds.push(groupId);
      } else {
        if (!proposal.groupIds.includes(groupId)) fail('Este grupo não está selecionado na campanha.');
        proposal.groupIds = proposal.groupIds.filter(id => id !== groupId);
        delete proposal.groupOverrides[groupId];
      }
      return this._saveEdit(context, sender, original, proposal);
    }
    return this._reply(context, 'Comando desconhecido. Envie !mega ajuda ou !mega menu.');
  }

  _invalidateCampaign(id) {
    for (const [sender, request] of this.pending) if (request.campaignId === id) this.pending.delete(sender);
  }

  _editing(session) {
    if (!session.campaignId) fail('Selecione uma campanha pela opção 2 do menu.');
    const campaign = this._campaign(session.campaignId);
    if (session.fingerprint !== configurationFingerprint(campaign) || session.state !== campaign.state) fail('A campanha mudou desde a seleção. Envie !mega editar ID para selecioná-la novamente.');
    return campaign;
  }

  _number(value, min, max, label) {
    const number = Number(value);
    if (!String(value || '').trim() || !Number.isFinite(number) || number < min || number > max) fail(`Informe ${label} entre ${min} e ${max}.`);
    return number;
  }

  _time(value) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value || '')) fail('Use o horário no formato HH:MM, por exemplo 08:00.');
    return value;
  }

  _date(value) {
    if (value === '-') return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('Use a data AAAA-MM-DD ou - para não definir.');
    return value;
  }

  _chosenGroups(text, campaign, remove = false) {
    const available = remove ? campaign.groupIds.map(id => this.store.getGroup(id)).filter(Boolean) : this.store.listGroups();
    const values = text.split(/[,\s]+/).filter(Boolean);
    if (!values.length) fail('Informe um ou mais números/identificadores de grupos, separados por vírgula.');
    return [...new Set(values.map(value => {
      const group = /^\d+$/.test(value) ? available[Number(value) - 1] : available.find(item => item.id === value);
      if (!group) fail('Grupo inválido. Consulte a lista mostrada nesta etapa.');
      if (!remove) this._group(group.id);
      return group.id;
    }))];
  }

  _scheduleMenu(session) {
    return `Configuração ${session.groupId ? 'individual do grupo' : 'da campanha'}\n` +
      '1 Intervalo entre rodadas (minutos)\n2 Espaçamento entre grupos (segundos, campanha)\n3 Dias da semana\n4 Janela de horários\n5 Datas de início/encerramento\n6 Limite de rodadas/dia (campanha)\n7 Limite de envios/dia (campanha)\n8 Repetir ou alternar conteúdos (campanha)\n0 Voltar';
  }

  _scope(campaign, session) {
    if (!session.groupId) return campaign;
    if (!campaign.groupIds.includes(session.groupId)) fail('O grupo deixou de fazer parte da campanha. Selecione-o novamente.');
    if (!campaign.groupOverrides[session.groupId]) {
      campaign.groupOverrides[session.groupId] = { enabled: true, intervalMinutes: campaign.intervalMinutes, schedule: clone(campaign.schedule), items: clone(campaign.items) };
    }
    const override = campaign.groupOverrides[session.groupId];
    override.schedule ||= clone(campaign.schedule);
    override.items ||= clone(campaign.items);
    override.intervalMinutes ??= campaign.intervalMinutes;
    return override;
  }

  async _menuInput(context, sender, session, text) {
    if (MEDIA_TYPES.has(context.type) && session.phase !== 'content_input') {
      return this._reply(context, 'Para anexar esta mídia, selecione a campanha e entre na opção 5. Nenhuma mídia foi associada.');
    }
    if (session.phase === 'create_name') {
      const campaign = this._newCampaign(text);
      session.campaignId = campaign.id; session.revision = campaign.revision; session.groupId = null; session.phase = 'home';
      this._refreshSession(session);
      return this._reply(context, `Campanha criada e desativada. ID: ${campaign.id}\n${this._home(session)}`);
    }
    if (session.phase === 'choose_campaign') {
      this._assert('campaign.view');
      const campaigns = this._visibleCampaigns();
      const choice = /^\d+$/.test(text) ? campaigns[Number(text) - 1] : campaigns.find(campaign => campaign.id === text);
      if (!choice) fail('Seleção inválida. Informe o número ou identificador de uma campanha da lista.');
      this._assert('campaign.edit', choice);
      session.campaignId = choice.id; session.revision = choice.revision; session.groupId = null; session.phase = 'home';
      this._refreshSession(session);
      return this._reply(context, this._home(session));
    }
    if (session.phase === 'home') {
      if (text === '0') { this.sessions.delete(sender); return this._reply(context, 'Menu encerrado.'); }
      if (text === '9' && this.statusProvider) return this._command(context, sender, 'status');
      if (text === '1') { this._assert('campaign.create'); session.phase = 'create_name'; return this._reply(context, 'Qual será o nome da campanha? Ela será criada desativada.'); }
      if (text === '2') { session.phase = 'choose_campaign'; return this._reply(context, `${this._campaignList()}\nInforme o número ou ID da campanha.`); }
      const campaign = this._editing(session);
      session.groupId = null;
      if (text === '3') { this._assert('campaign.edit', campaign); this._assert('groups.view'); session.phase = 'groups_menu'; return this._reply(context, 'Grupos\n1 Adicionar grupos\n2 Remover grupos\n3 Configuração individual de um grupo\n0 Voltar'); }
      if (text === '4') { this._assert('campaign.edit', campaign); session.phase = 'schedule_menu'; return this._reply(context, this._scheduleMenu(session)); }
      if (text === '5') { this._assert('campaign.edit', campaign); session.phase = 'content_input'; return this._reply(context, 'Envie o texto com a formatação desejada ou uma imagem, vídeo ou documento. A legenda da mídia será preservada. O conteúdo será anexado somente a esta campanha. Envie !mega menu para sair.'); }
      if (text === '6') { this._assert('campaign.edit', campaign); session.phase = 'order_menu'; return this._reply(context, 'Conteúdos\n1 Alterar ordem\n2 Remover item\n0 Voltar'); }
      if (text === '7') {
        this._assert('history.view');
        const jobs = this.store.listJobs({ campaignId: campaign.id, limit: 20 });
        return this._reply(context, jobs.map(job => `${job.resultAt || job.createdAt} — ${this.store.getGroup(job.groupId)?.name || job.groupId}\n${job.itemId} — ${job.status}${job.error ? `: ${compact(job.error)}` : ''}`).join('\n') || 'Ainda não há resultados para esta campanha.');
      }
      if (text === '8') {
        this._assert('campaign.start', campaign);
        this._validateActivation(campaign);
        return this._reply(context, this._requestConfirmation(sender, campaign, campaign.state === 'paused' ? 'resume' : 'activate'));
      }
      fail('Opção inválida. Responda com um número do menu.');
    }
    const original = this._editing(session);
    const proposal = clone(original);
    if (session.phase === 'groups_menu') {
      if (text === '0') { session.phase = 'home'; return this._reply(context, this._home(session)); }
      if (text === '1') { session.phase = 'groups_add'; return this._reply(context, `${this._groupList()}\nInforme números ou IDs separados por vírgula.`); }
      if (text === '2' || text === '3') {
        session.phase = text === '2' ? 'groups_remove' : 'choose_override';
        return this._reply(context, `${original.groupIds.map((id, index) => `${index + 1}. ${this.store.getGroup(id)?.name || id}\n${id}`).join('\n') || '(nenhum grupo selecionado)'}\nInforme ${text === '3' ? 'um número/ID' : 'números ou IDs separados por vírgula'}.`);
      }
      fail('Opção inválida. Use 1, 2, 3 ou 0.');
    }
    if (session.phase === 'groups_add' || session.phase === 'groups_remove') {
      const remove = session.phase === 'groups_remove';
      const ids = this._chosenGroups(text, original, remove);
      proposal.groupIds = remove ? proposal.groupIds.filter(id => !ids.includes(id)) : [...new Set([...proposal.groupIds, ...ids])];
      if (remove) ids.forEach(id => delete proposal.groupOverrides[id]);
      await this._saveEdit(context, sender, original, proposal);
      session.phase = 'home';
      return;
    }
    if (session.phase === 'choose_override') {
      const ids = this._chosenGroups(text, original, true);
      if (ids.length !== 1) fail('Selecione somente um grupo para a configuração individual.');
      session.groupId = ids[0]; session.phase = 'override_menu';
      return this._reply(context, 'Configuração individual\n1 Ativar configurações individuais\n2 Desativar configurações individuais\n3 Horários e intervalo\n4 Adicionar conteúdo individual\n5 Ordenar/remover conteúdo individual\n0 Voltar');
    }
    if (session.phase === 'override_menu') {
      if (text === '0') { session.groupId = null; session.phase = 'home'; return this._reply(context, this._home(session)); }
      if (text === '1' || text === '2') {
        this._scope(proposal, session).enabled = text === '1';
        await this._saveEdit(context, sender, original, proposal);
        return;
      }
      if (text === '3') { session.phase = 'schedule_menu'; return this._reply(context, this._scheduleMenu(session)); }
      if (text === '4') { session.phase = 'content_input'; return this._reply(context, 'Envie texto ou mídia com legenda para o conteúdo individual deste grupo nesta campanha. A configuração individual será habilitada. Para sair: !mega menu.'); }
      if (text === '5') { session.phase = 'order_menu'; return this._reply(context, 'Conteúdos individuais\n1 Alterar ordem\n2 Remover item\n0 Voltar'); }
      fail('Opção inválida. Use um número do menu.');
    }
    if (session.phase === 'schedule_menu') {
      if (text === '0') { session.phase = 'home'; session.groupId = null; return this._reply(context, this._home(session)); }
      if (session.groupId && ['2', '6', '7', '8'].includes(text)) fail('Essa opção se aplica à campanha. Use !mega menu e a opção 4.');
      const prompts = {
        '1': 'Informe o intervalo em minutos (entre 1 e 10080). O padrão é 10 minutos entre inícios de rodadas.',
        '2': `Informe o espaçamento entre grupos em segundos (entre ${Math.max(3, this.adapter.minimumSpacingSeconds || 3)} e 3600). Os limites da integração também são aplicados.`,
        '3': 'Informe dias separados por vírgula: 0 domingo, 1 segunda, 2 terça, 3 quarta, 4 quinta, 5 sexta, 6 sábado.',
        '4': 'Informe início e fim: HH:MM HH:MM. Exemplo: 08:00 18:00.',
        '5': 'Informe início e encerramento: AAAA-MM-DD AAAA-MM-DD. Use - para uma data não definida.',
        '6': 'Informe o limite de rodadas por dia (inteiro; 0 significa sem limite).',
        '7': 'Informe o limite de envios por dia (inteiro; 0 significa sem limite).',
        '8': 'Responda 1 para repetir todos os itens ou 2 para enviar o próximo item a cada rodada.'
      };
      if (!prompts[text]) fail('Opção inválida. Use um número do menu.');
      session.phase = `setting_${text}`;
      return this._reply(context, prompts[text]);
    }
    if (session.phase.startsWith('setting_')) {
      const setting = session.phase.slice(8);
      const scope = this._scope(proposal, session);
      if (session.groupId) scope.enabled = true;
      if (setting === '1') scope.intervalMinutes = this._number(text, 1, 10080, 'intervalo em minutos');
      if (setting === '2') proposal.spacingSeconds = this._number(text, Math.max(3, this.adapter.minimumSpacingSeconds || 3), 3600, 'espaçamento em segundos');
      if (setting === '3') {
        const values = text.split(/[,\s]+/).filter(Boolean);
        if (!values.length || values.some(value => !/^[0-6]$/.test(value))) fail('Informe ao menos um dia entre 0 e 6.');
        scope.schedule.days = [...new Set(values.map(Number))];
      }
      if (setting === '4') {
        const values = text.split(/\s+/);
        if (values.length !== 2) fail('Informe os dois horários: HH:MM HH:MM.');
        scope.schedule.startTime = this._time(values[0]); scope.schedule.endTime = this._time(values[1]);
      }
      if (setting === '5') {
        const values = text.split(/\s+/);
        if (values.length !== 2) fail('Informe as duas datas ou -: AAAA-MM-DD AAAA-MM-DD.');
        scope.schedule.startDate = this._date(values[0]); scope.schedule.endDate = this._date(values[1]);
        if (scope.schedule.startDate && scope.schedule.endDate && scope.schedule.startDate > scope.schedule.endDate) fail('A data de encerramento precisa ser igual ou posterior à data de início.');
      }
      if (setting === '6' || setting === '7') {
        const number = this._number(text, 0, setting === '6' ? 10000 : 100000, 'limite diário');
        if (!Number.isInteger(number)) fail('O limite diário deve ser inteiro.');
        proposal[setting === '6' ? 'dailyRoundLimit' : 'dailySendLimit'] = number;
      }
      if (setting === '8') {
        if (!['1', '2'].includes(text)) fail('Use 1 para repetir ou 2 para alternar.');
        proposal.mode = text === '1' ? 'repeat' : 'rotate';
      }
      await this._saveEdit(context, sender, original, proposal);
      session.phase = 'schedule_menu';
      return;
    }
    if (session.phase === 'content_input') {
      this._assert('campaign.edit', original);
      const scope = this._scope(proposal, session);
      if (session.groupId) scope.enabled = true;
      if (MEDIA_TYPES.has(context.type)) {
        this._assert('media.create');
        if (!this.mediaManager || !this.adapter.downloadIncoming) fail('Recebimento de mídias indisponível nesta integração. Importe o arquivo pelo aplicativo.');
        const downloaded = await this.adapter.downloadIncoming(context);
        this._assert('campaign.edit', this._campaign(original.id));
        this._assert('media.create');
        if (!downloaded || !MEDIA_TYPES.has(downloaded.type)) fail('Este tipo de mídia não é suportado. Use imagem, vídeo ou documento.');
        const media = await this.mediaManager.importBuffer(downloaded.buffer, {
          name: downloaded.name, mime: downloaded.mime, type: downloaded.type
        });
        scope.items.push({ id: randomUUID(), type: media.type, text: '', mediaId: media.id, caption: String(context.text || '') });
      } else {
        if (context.type !== 'text' || !text) fail('Envie texto, imagem, vídeo ou documento. Áudio e outros tipos não são adicionados.');
        scope.items.push({ id: randomUUID(), type: 'text', text: String(context.text), mediaId: null, caption: '' });
      }
      await this._saveEdit(context, sender, original, proposal);
      return;
    }
    if (session.phase === 'order_menu') {
      if (text === '0') { session.phase = 'home'; session.groupId = null; return this._reply(context, this._home(session)); }
      if (!['1', '2'].includes(text)) fail('Use 1 para ordenar, 2 para remover ou 0 para voltar.');
      const items = this._scope(proposal, session).items;
      session.phase = text === '1' ? 'order_items' : 'remove_item';
      return this._reply(context, `${items.map((item, index) => `${index + 1}. ${item.type === 'text' ? compact(item.text) : this.store.getMedia(item.mediaId)?.name || item.type}`).join('\n') || '(nenhum conteúdo)'}\n` +
        (text === '1' ? 'Informe todos os números na nova ordem, separados por vírgula.' : 'Informe o número do item a remover.'));
    }
    if (session.phase === 'order_items' || session.phase === 'remove_item') {
      const scope = this._scope(proposal, session);
      const values = text.split(/[,\s]+/).filter(Boolean);
      if (!values.length || values.some(value => !/^\d+$/.test(value))) fail('Informe números válidos dos itens mostrados.');
      const indices = values.map(value => Number(value) - 1);
      if (indices.some(index => index < 0 || index >= scope.items.length)) fail('Número de conteúdo inválido.');
      if (session.phase === 'order_items') {
        if (indices.length !== scope.items.length || new Set(indices).size !== indices.length) fail('Inclua cada item uma vez na nova ordem.');
        scope.items = indices.map(index => scope.items[index]);
      } else {
        if (indices.length !== 1) fail('Informe somente um item para remover.');
        scope.items.splice(indices[0], 1);
      }
      if (session.groupId) scope.enabled = true;
      await this._saveEdit(context, sender, original, proposal);
      session.phase = 'home'; session.groupId = null;
      return;
    }
    fail('Sessão inválida. Envie !mega menu para começar outra.');
  }
}

module.exports = { CommandController, SESSION_TTL, CONFIRM_TTL };
