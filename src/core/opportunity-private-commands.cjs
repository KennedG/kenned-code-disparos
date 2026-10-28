'use strict';

// Deterministic private controls for OPORTUNIDADES. No LLM, contact broadcast,
// stock lookup or recipient fallback is part of this controller.
const { randomUUID, randomBytes } = require('node:crypto');
const { normalizePhone } = require('./phone.cjs');
const COMMAND_WINDOW = 5 * 60 * 1000;
const REPLAY_TTL = 24 * 60 * 60 * 1000;
const MAX_COMMANDS = 10000;
const PREFIX = /^!(?:automatico|aprovar|recusar|pausar|status|ajuda)(?:\s|$)/i;
const help = '📱 *Oportunidades — comandos*\n\n!automatico on — envia automaticamente aos destinos da campanha.\n!automatico off — avisa e aguarda sua decisão.\n!aprovar ID — autoriza a oportunidade selecionada.\n!recusar ID — cancela essa oportunidade.\n!pausar — interrompe os envios e bloqueia novas tarefas.\n!status — mostra modo e pendências.\n!ajuda — mostra estes comandos.\n\nAs mensagens das ofertas usam somente os destinos da campanha. Os avisos chegam no seu particular.';
const failure = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const codeOf = (value, fallback) => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : fallback;
const safe = value => String(value || '').slice(0, 1200)
  .replace(/(Bearer\s+)[\w.\-]+/gi, '$1[omitido]')
  .replace(/((?:["']?)(?:password|senha|token|secret|authorization|credential|cookie|qr|session|private.?key|api.?key)(?:["']?)\s*[:=]\s*)[^\r\n]*/gi, '$1[omitido]');
const accepted = proof => ['accepted', 'confirmed', 'delivered', 'read'].includes(proof?.status) && Boolean(proof?.messageId);
const delivered = proof => accepted(proof) && (['delivered', 'read'].includes(proof.status) || ['whatsapp-delivered', 'whatsapp-read'].includes(proof.confirmationScope));
const resultOrThrow = result => { if (result?.ok === false) throw failure(result.reason || 'A operação não pôde ser executada.', result.code || 'OP_CONTROL_DENIED'); return result; };

class OpportunityPrivateCommands {
  constructor({ store, adapter, authService, workflow, sendAdminReply, licenseGuard = () => true, now = () => Date.now() } = {}) {
    if (!store?.getSetting || !store?.setSetting || !workflow || !authService?.resolveWhatsAppActor) throw new Error('Controle de oportunidades exige armazenamento, fluxo e autorização central.');
    Object.assign(this, { store, adapter, authService, workflow, sendAdminReply, licenseGuard, now });
    this.closed = false; this.adapterRevision = 0; this.waiting = 0; this.tail = Promise.resolve();
    this.receiptListener = receipt => this._receipt(receipt);
    this._recover(); this.adapter?.on?.('receipt', this.receiptListener);
  }
  _mode() { return this.store.getStorageMode?.() || this.adapter?.status?.mode || 'whatsapp'; }
  _key(mode = this._mode()) { return `opportunityControlCommands:${mode}`; }
  _entries(mode = this._mode()) { const values = this.store.getSetting(this._key(mode), []); return Array.isArray(values) ? values.filter(item => item && Number.isFinite(item.at) && item.at >= this.now() - REPLAY_TTL) : []; }
  _persist(entries, mode = this._mode()) { this.store.setSetting(this._key(mode), entries); }
  _config() { return this.workflow.config(); }
  _trace(context, stage, code, description, detail = {}) {
    if (context?.commandStorageMode && context.commandStorageMode !== this._mode()) return;
    const entry = { id: randomUUID(), at: this.now(), traceId: context?.commandTraceId || null, operationType: 'opportunity-control', userId: context?.commandActorId || null,
      stage: `opportunities.control.${stage}`, code, description: safe(description), level: /DENIED|FAILED|UNCERTAIN|UNVERIFIED|MISMATCH|INVALID|STALE|AMBIGUOUS/.test(code) ? 'warning' : 'info',
      detail: { chatId: context?.chatId || null, messageId: context?.messageId || null, ...detail } };
    this.store.addDiagnostic?.(entry);
    this.store.addOpportunityTrace?.(entry);
  }
  _authorization(context) {
    const deny = (code, reason) => ({ allowed: false, code, reason });
    if (context?.verified !== true || context.identityAmbiguous === true) return deny('OP_CONTROL_IDENTITY_UNVERIFIED', 'Telefone real não confirmado ou identidade ambígua.');
    if (context.isGroup !== false) return deny('OP_CONTROL_PRIVATE_REQUIRED', 'Comandos de oportunidades são aceitos somente no privado.');
    if (context.forwarded !== false || context.isForwarded === true || context.forwardingScore > 0) return deny('OP_CONTROL_FORWARDED_REJECTED', 'Comando encaminhado ou sem origem direta confirmada.');
    if (context.history || context.historical || context.isHistory) return deny('OP_CONTROL_HISTORY_REJECTED', 'Histórico não executa comandos.');
    if (context.automaticMessage || context.machineGenerated || context.automated || this.store.isOutboundMessageId?.(context.messageId)) return deny('OP_CONTROL_AUTOMATION_ECHO', 'Mensagem automática ignorada para evitar ciclos.');
    if (context.fromMe !== false && (context.fromMe !== true || context.trustedSelf !== true || context.selfChat !== true || !this.adapter?.isTrustedSelfContext?.(context))) return deny('OP_CONTROL_SELF_UNVERIFIED', 'Mensagem própria fora do chat consigo mesmo ou sem comprovação de origem manual.');
    const sender = normalizePhone(context.senderNumber);
    let config; try { config = this._config(); } catch { return deny('OP_CONTROL_CONFIG_INVALID', 'Não foi possível verificar a configuração do administrador.'); }
    const admin = normalizePhone(config?.adminPhone), actorId = config?.adminActorId || config?.ownerId;
    if (!admin || typeof actorId !== 'string' || !actorId) return deny('OP_CONTROL_ADMIN_MISSING', 'Configure o número e o usuário administrador de Oportunidades no aplicativo.');
    if (!sender || sender !== admin) return deny('OP_CONTROL_SENDER_DENIED', 'Remetente não corresponde ao administrador configurado.');
    const directPhone = context.chatId === `${sender}@s.whatsapp.net`;
    const verifiedLid = /^[1-9]\d*@lid$/.test(context.chatId || '');
    if (!directPhone && !verifiedLid) return deny('OP_CONTROL_REPLY_CHAT_MISMATCH', 'Chat privado não corresponde à identidade do remetente verificado.');
    let resolved; try { resolved = this.authService.resolveWhatsAppActor(context); } catch { return deny('OP_CONTROL_ACTOR_DENIED', 'Não foi possível confirmar o vínculo central do administrador.'); }
    const user = resolved?.user || (resolved?.id ? resolved : null);
    if (!user?.id || user.id !== actorId) return deny('OP_CONTROL_ACTOR_DENIED', 'Número não vinculado de forma inequívoca ao administrador configurado.');
    if (!this.authService.canFor?.(user, 'opportunity.manage') || !this.authService.canFor?.(user, 'opportunity.respond')) return deny('OP_CONTROL_PERMISSION_DENIED', 'Administrador sem permissão para configurar ou responder oportunidades.');
    if (/^!(?:pausar\s*|automatico\s+(?:on|off)\s*)$/i.test(String(context.text || '').trim()) && !this.authService.canFor?.(user, 'automation.control')) return deny('OP_CONTROL_AUTOMATION_DENIED', 'Usuário sem permissão para controlar ou retomar os envios automáticos.');
    return { allowed: true, user, sender };
  }
  _fresh(context) {
    const raw = Number(context.timestamp), at = raw < 1e12 ? raw * 1000 : raw;
    return Number.isFinite(at) && at > 0 && at >= this.now() - COMMAND_WINDOW && at <= this.now() + 60000;
  }
  _claim(context) {
    if (typeof context.messageId !== 'string' || !context.messageId || context.messageId.length > 512 || !this._fresh(context)) {
      this._trace(context, 'duplicate', 'OP_CONTROL_STALE_OR_INVALID', 'Comando sem identificação ou horário válido; envie uma nova mensagem.'); return false;
    }
    const entries = this._entries(context.commandStorageMode);
    const id = `${normalizePhone(context.senderNumber)}:${context.messageId}`;
    const previous = entries.find(entry => entry.id === id);
    if (previous) { context.commandTraceId = previous.traceId; this._trace(context, 'duplicate', 'OP_CONTROL_DUPLICATE', 'Comando já registrado; operação e resposta não foram repetidas.'); return false; }
    if (entries.length >= MAX_COMMANDS) { this._trace(context, 'duplicate', 'OP_CONTROL_CAPACITY', 'Limite diário de comandos atingido; processamento bloqueado sem descartar a proteção de duplicidade.'); return false; }
    const entry = { id, at: this.now(), traceId: context.commandTraceId, actorId: context.commandActorId, chatId: context.chatId, status: 'claimed', replies: [] };
    entries.push(entry); this._persist(entries, context.commandStorageMode); context.commandLedgerKey = id; return true;
  }
  _record(context, patch) {
    if (context.commandStorageMode !== this._mode()) throw failure('A integração mudou; o comando não atravessa sessões.', 'OP_CONTROL_MODE_CHANGED');
    const entries = this._entries(), entry = entries.find(value => value.id === context.commandLedgerKey);
    if (!entry) throw failure('Registro persistente do comando não encontrado.', 'OP_CONTROL_LEDGER_MISSING');
    Object.assign(entry, patch); this._persist(entries); return entry;
  }
  _replyRecord(context, clientMessageId, patch) {
    const entries = this._entries(), entry = entries.find(value => value.id === context.commandLedgerKey);
    if (context.commandStorageMode !== this._mode() || !entry) throw failure('Registro da resposta não pertence à sessão atual.', 'OP_CONTROL_LEDGER_MISSING');
    const previous = entry.replies.find(item => item.clientMessageId === clientMessageId);
    if (previous?.status === 'delivered' && patch.status !== 'delivered' || previous?.status === 'accepted' && ['pending', 'processing', 'uncertain'].includes(patch.status)) return previous;
    const value = { ...(previous || {}), ...patch, clientMessageId };
    entry.replies = [...entry.replies.filter(item => item.clientMessageId !== clientMessageId), value]; this._persist(entries); return value;
  }
  _recover() {
    let changed = false; const entries = this._entries();
    for (const entry of entries) {
      if (entry.status === 'claimed' || entry.status === 'processing') { entry.status = 'interrupted'; changed = true; }
      for (const reply of entry.replies || []) if (reply.status === 'processing' || reply.status === 'pending') {
        reply.code = reply.status === 'processing' ? 'OP_CONTROL_REPLY_INTERRUPTED' : 'OP_CONTROL_REPLY_NOT_SUBMITTED';
        reply.status = reply.status === 'processing' ? 'uncertain' : 'cancelled'; reply.resultAt = this.now(); changed = true;
      }
    }
    if (changed) this._persist(entries);
  }
  _receipt(receipt) {
    if (this.closed || !receipt?.messageId || !['confirmed', 'accepted', 'delivered', 'read'].includes(receipt.status)) return;
    if (receipt.mode && receipt.mode !== this._mode() || receipt.simulation === true && this._mode() !== 'simulated') return;
    const entries = this._entries(); let changed = false;
    for (const entry of entries) for (const reply of entry.replies || []) {
      if (reply.clientMessageId !== receipt.messageId && reply.messageId !== receipt.messageId || !['processing', 'accepted', 'uncertain', 'delivered'].includes(reply.status)) continue;
      const isDelivered = ['delivered', 'read'].includes(receipt.status) || ['whatsapp-delivered', 'whatsapp-read'].includes(receipt.confirmationScope);
      if (reply.status === 'delivered' && !isDelivered) continue;
      reply.status = isDelivered ? 'delivered' : 'accepted'; reply.resultAt ||= this.now();
      reply.confirmationScope = receipt.confirmationScope || reply.confirmationScope || null;
      if (isDelivered) reply.deliveredAt ||= receipt.deliveredAt || this.now();
      if (receipt.status === 'read') reply.readAt ||= receipt.readAt || this.now(); changed = true;
    }
    if (changed) this._persist(entries);
  }
  async _reply(context, text) {
    for (let offset = 0; offset < String(text).length; offset += 3500) {
      const part = String(text).slice(offset, offset + 3500), clientMessageId = randomBytes(16).toString('hex').toUpperCase();
      let invoked = false;
      const beforeSubmit = () => {
        this.licenseGuard('opportunity.control.reply');
        const live = this._authorization(context);
        if (this.closed || context.commandAdapterRevision !== this.adapterRevision || context.commandStorageMode !== this._mode() || !live.allowed || live.user.id !== context.commandActorId) throw failure('A sessão ou autorização mudou antes da resposta.', 'OP_CONTROL_REPLY_AUTH_CHANGED', { submitted: false, definitive: true });
      };
      this._replyRecord(context, clientMessageId, { status: 'pending', queuedAt: this.now(), recipient: context.chatId });
      try {
        beforeSubmit();
        this._replyRecord(context, clientMessageId, { status: 'processing', submittedAt: this.now() }); invoked = true;
        const options = { manual: true, userId: context.commandActorId, clientMessageId, traceId: context.commandTraceId, beforeSubmit };
        const proof = this.sendAdminReply ? await this.sendAdminReply(context, part, options) : await this.adapter.reply(context.chatId, part, { ...options, replyContext: context });
        if (context.commandStorageMode !== this._mode() || context.commandAdapterRevision !== this.adapterRevision) return;
        const status = delivered(proof) ? 'delivered' : accepted(proof) ? 'accepted' : 'uncertain';
        this._replyRecord(context, clientMessageId, { status, messageId: proof?.messageId || clientMessageId, confirmationScope: proof?.confirmationScope || null, resultAt: this.now(), code: status === 'uncertain' ? 'OP_CONTROL_REPLY_UNCERTAIN' : null });
        this._trace(context, 'reply', status === 'uncertain' ? 'OP_CONTROL_REPLY_UNCERTAIN' : status === 'delivered' ? 'OP_CONTROL_REPLY_DELIVERED' : 'OP_CONTROL_REPLY_ACCEPTED', status === 'uncertain' ? 'Resposta com resultado incerto; não será reenviada automaticamente.' : status === 'delivered' ? 'Entrega da resposta confirmada pela integração.' : 'Resposta aceita pela integração; entrega ao dispositivo ainda não confirmada.', { recipient: context.chatId, messageId: proof?.messageId || clientMessageId });
        if (status === 'uncertain') return;
      } catch (err) {
        if (context.commandStorageMode !== this._mode() || context.commandAdapterRevision !== this.adapterRevision) return;
        const definitive = !invoked || err?.submitted === false;
        this._replyRecord(context, clientMessageId, { status: definitive ? 'failed' : 'uncertain', resultAt: this.now(), code: codeOf(err.code, 'OP_CONTROL_REPLY_FAILED'), reason: safe(err.message) });
        this._trace(context, 'reply', definitive ? 'OP_CONTROL_REPLY_FAILED' : 'OP_CONTROL_REPLY_UNCERTAIN', safe(err.message), { recipient: context.chatId, messageId: clientMessageId }); return;
      }
    }
  }
  handle(context) {
    if (this.closed || context?.type !== 'text' || !PREFIX.test(String(context.text || '').trim())) return Promise.resolve(false);
    context = { ...context, commandTraceId: randomUUID(), commandStorageMode: this._mode(), commandAdapterRevision: this.adapterRevision };
    this._trace(context, 'received', 'OP_CONTROL_RECEIVED', 'Comando privado de oportunidades recebido; aguardando autorização.');
    try { this.licenseGuard('opportunity.control'); } catch (err) { this._trace(context, 'authorization', 'OP_CONTROL_LICENSE_DENIED', safe(err.message)); return Promise.resolve(false); }
    const authorization = this._authorization(context);
    if (!authorization.allowed) { this._trace(context, 'authorization', authorization.code, authorization.reason); return Promise.resolve(false); }
    context.commandActorId = authorization.user.id;
    if (/^!pausar\s*$/i.test(context.text.trim())) return this._handle(context);
    if (this.waiting >= 64) { this._trace(context, 'queue', 'OP_CONTROL_QUEUE_FULL', 'Fila de comandos cheia; envie um novo comando após aguardar.'); return Promise.resolve(false); }
    this.waiting++; const task = this.tail.then(() => this._handle(context)).finally(() => { this.waiting--; }); this.tail = task.catch(() => {}); return task;
  }
  async _handle(context) {
    if (this.closed || context.commandAdapterRevision !== this.adapterRevision || context.commandStorageMode !== this._mode()) return false;
    try { this.licenseGuard('opportunity.control'); } catch { return false; }
    const live = this._authorization(context);
    if (!live.allowed || live.user.id !== context.commandActorId || !this._claim(context)) return false;
    this._trace(context, 'authorized', 'OP_CONTROL_AUTHORIZED', 'Administrador configurado identificado com permissões centrais.');
    this._record(context, { status: 'processing' });
    let response;
    try {
      const text = context.text.trim(); let match;
      if ((match = text.match(/^!automatico\s+(on|off)\s*$/i))) {
        const enabled = match[1].toLowerCase() === 'on'; resultOrThrow(await this.workflow.setAutomatic(enabled, context.commandActorId));
        response = enabled ? '✅ *Modo automático ativado*\nAs oportunidades elegíveis serão enviadas sem confirmação aos destinos cadastrados da campanha. Você receberá os avisos no particular.' : '⏸️ *Modo automático desativado*\nVocê será avisado no particular. Use !aprovar ID ou !recusar ID para decidir cada oportunidade.';
      } else if ((match = text.match(/^!aprovar\s+(\S{1,512})\s*$/i))) {
        resultOrThrow(await this.workflow.approve(match[1], context.commandActorId)); response = `✅ Oportunidade ${match[1]} autorizada.\nA tarefa foi registrada para os destinos da campanha; acompanhe o resultado do envio.`;
      } else if ((match = text.match(/^!recusar\s+(\S{1,512})\s*$/i))) {
        resultOrThrow(await this.workflow.reject(match[1], context.commandActorId)); response = `🚫 Oportunidade ${match[1]} recusada.\nEnvios ainda não iniciados foram cancelados. Uma mensagem já submetida à integração pode não ser cancelável.`;
      } else if (/^!pausar\s*$/i.test(text)) {
        const result = resultOrThrow(await this.workflow.pause(context.commandActorId));
        response = '⏸️ *Envios pausados*\nNovas tarefas automáticas estão bloqueadas e os envios pendentes foram interrompidos. Os dados foram preservados. Use !automatico on para retomar o modo automático.';
        if (Number(result?.inFlight || result?.inflight || result?.inFlightCount || result?.inProgress || result?.automation?.inFlight) > 0) response += '\n⚠️ Há envio já iniciado que pode não ser cancelável; seu resultado será registrado sem repetir a tarefa.';
      } else if (/^!status\s*$/i.test(text)) {
        const value = await this.workflow.status();
        if (typeof value === 'string') response = value;
        else { const cfg = this._config(); response = `📋 *Oportunidades — status*\nModo: ${(value?.automatic ?? cfg.automatic ?? cfg.mode === 'automatic') ? 'Automático' : 'Aguardando decisão'}\nEnvios: ${value?.paused ? 'Pausados' : 'Conforme configuração'}\nAguardando aprovação: ${value?.awaitingApproval ?? value?.pendingApproval ?? 0}\nNa fila: ${value?.queued ?? value?.pending ?? 0}\nResultados incertos: ${value?.uncertain ?? 0}\nFalhas: ${value?.failed ?? 0}`; }
      } else if (/^!ajuda\s*$/i.test(text)) response = help;
      else response = 'Comando inválido.\n\n' + help;
      this._record(context, { status: 'completed', completedAt: this.now() });
      this._trace(context, 'processed', 'OP_CONTROL_COMPLETED', 'Comando executado; resposta será enviada ao administrador original.');
    } catch (err) {
      this._record(context, { status: 'failed', resultAt: this.now(), code: codeOf(err.code, 'OP_CONTROL_FAILED'), reason: safe(err.message) });
      this._trace(context, 'processed', 'OP_CONTROL_FAILED', safe(err.message)); response = `⚠️ Não foi possível concluir o comando.\n${safe(err.message || 'Confira os detalhes no aplicativo.')}`;
    }
    await this._reply(context, response); return true;
  }
  setAdapter(adapter) { this.adapter?.off?.('receipt', this.receiptListener); this.adapter = adapter; this.adapterRevision++; this._recover(); this.adapter?.on?.('receipt', this.receiptListener); }
  close() { this.closed = true; this.adapter?.off?.('receipt', this.receiptListener); }
}
module.exports = { OpportunityPrivateCommands, COMMAND_WINDOW, REPLAY_TTL, HELP: help };
