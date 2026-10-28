'use strict';

// Durable, mode-scoped campaign deliveries and administrator notices. Stored in
// op_notifications so existing backups include every reservation. These jobs are
// deliberately separate from the older private-reply op_tasks recipient guard.
const { createHash, randomUUID } = require('node:crypto');
const PREFIX = 'wf:';
const BATCH = `${PREFIX}batch`;
const JOB = `${PREFIX}job:`;
const states = new Set(['awaiting_approval', 'queued', 'processing', 'accepted', 'delivered', 'uncertain', 'failed', 'cancelled']);
const finals = new Set(['accepted', 'delivered', 'uncertain', 'failed', 'cancelled']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (code, reason) => ({ ok: false, code, reason });

function attachOpportunityWorkflowStore(store, helpers) {
  const { db, prepared, transaction, mode, decode, key, stamp, safe, clock, config, saveRequest, trace } = helpers;
  const ensureIndexes = () => transaction(() => db.exec(`CREATE INDEX IF NOT EXISTS op_workflow_jobs_id ON op_notifications(storageMode,json_extract(data,'$.id')) WHERE kind LIKE 'wf:job:%';
    CREATE INDEX IF NOT EXISTS op_workflow_jobs_due ON op_notifications(storageMode,json_extract(data,'$.status'),COALESCE(json_extract(data,'$.nextAttemptAt'),0),at) WHERE kind LIKE 'wf:job:%';
    CREATE INDEX IF NOT EXISTS op_workflow_jobs_message ON op_notifications(storageMode,json_extract(data,'$.messageId')) WHERE kind LIKE 'wf:job:%';
    CREATE INDEX IF NOT EXISTS op_workflow_batches_contact ON op_notifications(storageMode,json_extract(data,'$.senderKey'),at) WHERE kind='wf:batch';`));
  const read = (opportunityId, kind) => decode(prepared('SELECT data FROM op_notifications WHERE storageMode=? AND opportunityId=? AND kind=?').get(mode(), key(opportunityId), key(kind)));
  const save = input => {
    const value = safe({ ...input, storageMode: mode() });
    prepared('INSERT INTO op_notifications(storageMode,opportunityId,kind,at,data)VALUES(?,?,?,?,?)ON CONFLICT(storageMode,opportunityId,kind)DO UPDATE SET data=excluded.data').run(mode(), key(value.opportunityId), key(value.kind), stamp(value.at), JSON.stringify(value));
    return value;
  };
  const getJob = id => decode(prepared("SELECT data FROM op_notifications WHERE storageMode=? AND kind LIKE 'wf:job:%' AND json_extract(data,'$.id')=? LIMIT 1").get(mode(), key(id)));
  const getBatch = id => read(id, BATCH);
  const listJobs = (filter = {}) => {
    const where = ["storageMode=?", "kind LIKE 'wf:job:%'"], args = [mode()];
    for (const field of ['status', 'type', 'opportunityId', 'batchRevision']) if (filter[field] !== undefined) {
      const values = Array.isArray(filter[field]) ? filter[field] : [filter[field]];
      const column = field === 'opportunityId' ? field : `json_extract(data,'$.${field}')`;
      where.push(values.length ? `${column} IN(${values.map(() => '?').join(',')})` : '0'); args.push(...values);
    }
    if (filter.messageId !== undefined) { where.push("(json_extract(data,'$.messageId')=? OR json_extract(data,'$.clientMessageId')=?)"); args.push(key(filter.messageId), filter.messageId); }
    if (filter.dueAt !== undefined) { where.push("COALESCE(json_extract(data,'$.nextAttemptAt'),0)<=?"); args.push(stamp(filter.dueAt)); }
    return prepared(`SELECT data FROM op_notifications WHERE ${where.join(' AND ')} ORDER BY at ${filter.newest === true ? 'DESC' : 'ASC'},rowid ${filter.newest === true ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`).all(...args, Math.min(1000, Math.max(1, Number(filter.limit) || 100)), Math.max(0, Number(filter.offset) || 0)).map(decode);
  };
  const allJobs = opportunityId => prepared("SELECT data FROM op_notifications WHERE storageMode=? AND opportunityId=? AND kind LIKE 'wf:job:%' ORDER BY at,rowid").all(mode(), key(opportunityId)).map(decode);
  const activeJobs = (opportunityId, batch = getBatch(opportunityId)) => allJobs(opportunityId).filter(job => job.type === 'campaign-ad' && (job.batchRevision || 0) === (batch?.selectionRevision || 0));
  const makeJob = ({ opportunityId, type, recipient, uniqueKey, now, ...rest }) => {
    const id = digest([mode(), opportunityId, type, uniqueKey, recipient]);
    const value = { ...rest, id, opportunityId, type, recipient, kind: JOB + id, status: rest.status || 'queued', at: now, createdAt: now,
      clientMessageId: digest(['opportunity-workflow', mode(), id]).slice(0, 32).toUpperCase(), attempts: 0, nextAttemptAt: now };
    return save(value);
  };
  const day = (at, timezone) => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  const protectedBatch = batch => ['awaiting_approval', 'queued', 'processing', 'accepted', 'delivered', 'uncertain', 'partial'].includes(batch.status) || Boolean(batch.firstSubmittedAt);
  function checkLimits(opportunity, now, offerIdentity) {
    const cfg = config();
    const duplicateOffer = offerIdentity && prepared("SELECT data FROM op_notifications WHERE storageMode=? AND kind='wf:batch' AND json_extract(data,'$.senderKey')=? AND json_extract(data,'$.offerIdentity')=? AND opportunityId<>? ORDER BY at DESC").all(mode(), opportunity.senderKey, offerIdentity, opportunity.id).map(decode).find(protectedBatch);
    if (duplicateOffer || offerIdentity && store.getOpportunityOfferSent?.(opportunity.senderKey, offerIdentity)) return failure('OP_OFFER_SENT', 'Esta oferta já foi reservada ou enviada para este interessado.');
    const since = now - Math.max(cfg.repeatHours * 3600000, cfg.contactIntervalMinutes * 60000, 172800000);
    const batches = prepared("SELECT data FROM op_notifications WHERE storageMode=? AND kind='wf:batch' AND json_extract(data,'$.senderKey')=? AND COALESCE(json_extract(data,'$.firstSubmittedAt'),at)>=? ORDER BY at DESC").all(mode(), opportunity.senderKey, since).map(decode).filter(batch => batch.opportunityId !== opportunity.id && protectedBatch(batch));
    const oldTasks = prepared("SELECT data FROM op_tasks WHERE storageMode=? AND senderKey=? AND COALESCE(json_extract(data,'$.startedAt'),createdAt)>=?").all(mode(), opportunity.senderKey, since).map(decode).filter(task => ['queued', 'sending', 'accepted', 'delivered', 'uncertain', 'outside'].includes(task.status) || task.startedAt);
    const prior = [...batches, ...oldTasks].map(value => ({ ...value, responseAt: value.firstSubmittedAt || value.startedAt || value.createdAt }));
    const repeated = prior.find(value => value.familyKey === opportunity.familyKey && now - value.responseAt < cfg.repeatHours * 3600000);
    if (repeated) return failure(repeated.status === 'uncertain' ? 'OP_UNCERTAIN' : 'OP_REPEAT', 'Mesmo interessado e mesma procura dentro do bloqueio de repetição.');
    const latest = prior.sort((a, b) => b.responseAt - a.responseAt)[0];
    if (latest && now - latest.responseAt < cfg.contactIntervalMinutes * 60000) return failure('OP_INTERVAL', 'Aguardando intervalo mínimo para este interessado.');
    if (prior.filter(value => day(value.responseAt, cfg.timezone) === day(now, cfg.timezone)).length >= cfg.maxPerDay) return failure('OP_DAILY_LIMIT', 'Limite diário de respostas para este interessado atingido.');
    return { ok: true };
  }
  function refreshBatch(opportunityId, now) {
    const batch = getBatch(opportunityId); if (!batch) return null;
    const jobs = activeJobs(opportunityId, batch);
    if (!jobs.length) return batch;
    const counts = Object.fromEntries([...states].map(status => [status, jobs.filter(job => job.status === status).length]));
    let status = batch.status;
    if (counts.awaiting_approval === jobs.length) status = 'awaiting_approval';
    else if (counts.delivered === jobs.length) status = 'delivered';
    else if (counts.accepted + counts.delivered === jobs.length) status = 'accepted';
    else if (counts.cancelled === jobs.length) status = 'cancelled';
    else if (counts.failed === jobs.length) status = 'failed';
    else if (counts.queued === jobs.length) status = 'queued';
    else if (counts.processing || counts.queued || counts.awaiting_approval) status = 'processing';
    else if (counts.uncertain) status = 'uncertain';
    else status = 'partial';
    const updated = save({ ...batch, status, counts, updatedAt: now });
    const opportunity = store.getOpportunity(opportunityId);
    if (opportunity && !['closed', 'expired', 'cancelled'].includes(opportunity.status)) {
      const answered = counts.accepted + counts.delivered > 0;
      saveRequest({ ...opportunity, status: answered ? 'responded' : counts.uncertain ? 'uncertain' : ['queued', 'processing'].includes(status) ? 'queued' : 'open', deliveryStatus: status, workflowStatus: status, updatedAt: now });
    }
    return updated;
  }
  function reserveOpportunityWorkflow(input = {}) {
    return transaction(() => {
      const now = clock(input.now ?? Date.now()), opportunity = store.getOpportunity(key(input.opportunityId));
      if (!opportunity) return failure('OP_NOT_FOUND', 'Oportunidade não encontrada.');
      const existing = getBatch(opportunity.id);
      if (existing && input.replaceUnstarted !== true) return { ok: true, duplicate: true, batch: existing, jobs: activeJobs(opportunity.id, existing) };
      if (existing) {
        const previousJobs = activeJobs(opportunity.id, existing);
        if (!['queued', 'awaiting_approval'].includes(existing.status) || existing.firstSubmittedAt != null || previousJobs.some(job => job.attempts > 0 || job.submittedAt != null || !['queued', 'awaiting_approval'].includes(job.status))) return failure('OP_ALREADY_RESPONDED', 'Um envio desta oportunidade já foi iniciado; a seleção não pode ser substituída.');
        if (existing.campaignId === input.campaignId && existing.itemId === input.itemId && existing.selectionFingerprint === input.selectionFingerprint) return input.automatic !== false && existing.status === 'awaiting_approval' ? store.approveOpportunityWorkflow(opportunity.id, { actorId: input.actorId, now }) : { ok: true, duplicate: true, batch: existing, jobs: previousJobs };
      }
      if (store.getOpportunityContactMute(opportunity.senderKey)?.muted) return failure('OP_MUTED', 'Contato silenciado.');
      if (['closed', 'cancelled', 'responded', 'uncertain'].includes(opportunity.status)) return failure('OP_CLOSED', 'Pedido encerrado ou já processado.');
      if (opportunity.expiresAt <= now) return failure('OP_EXPIRED', 'Pedido expirado.');
      const campaignId = key(input.campaignId), itemId = key(input.itemId), campaign = store.getCampaign?.(campaignId);
      if (!campaign || !config().campaignIds.includes(campaignId)) return failure('OP_CAMPAIGN_MISSING', 'Selecione uma campanha existente e habilitada para Oportunidades.');
      const item = campaign.items?.find(value => value.id === itemId);
      if (!item) return failure('OP_OFFER_MISSING', 'O anúncio selecionado não existe mais na campanha.');
      if (input.itemSnapshot && ['id', 'type', 'text', 'caption', 'mediaId'].some(field => JSON.stringify(input.itemSnapshot[field]) !== JSON.stringify(item[field]))) return failure('OP_OFFER_CHANGED', 'O conteúdo selecionado não corresponde ao anúncio atual da campanha.');
      const recipients = [...new Map((input.recipients || input.recipientIds?.map(id => ({ id, type: 'group' })) || []).map(value => [key(value.id), { id: value.id, type: value.type || 'group', name: String(value.name || '').slice(0, 256) }])).values()];
      if (!recipients.length || recipients.length > 1000) return failure('OP_RECIPIENT', 'A campanha precisa ter destinatários configurados.');
      const allowed = new Set(campaign.groupIds || []), simulated = mode() === 'simulated';
      if (recipients.some(recipient => recipient.type !== 'group' || !allowed.has(recipient.id) || !(simulated ? /@simulation$/.test(recipient.id) : /@g\.us$/.test(recipient.id)))) return failure('OP_RECIPIENT', 'Use somente os grupos de destino cadastrados na campanha, no modo atual.');
      const limit = checkLimits(opportunity, now, input.offerIdentity); if (!limit.ok) return limit;
      const automatic = input.automatic !== false;
      const selectionRevision = existing ? (existing.selectionRevision || 0) + 1 : 0;
      if (existing) for (const job of activeJobs(opportunity.id, existing)) save({ ...job, status: 'cancelled', cancelledAt: now, updatedAt: now, code: 'OP_SELECTION_REPLACED', reason: 'Anúncio substituído antes de iniciar qualquer envio.' });
      const batch = save({ id: opportunity.id, opportunityId: opportunity.id, kind: BATCH, at: existing?.at || now, createdAt: existing?.createdAt || now, updatedAt: now, selectionRevision, status: automatic ? 'queued' : 'awaiting_approval',
        senderKey: opportunity.senderKey, familyKey: opportunity.familyKey, intentKey: opportunity.intentKey, campaignId, itemId, itemSnapshot: safe(input.itemSnapshot || item), recipients, automatic,
        selectionFingerprint: input.selectionFingerprint || digest(item), offerIdentity: input.offerIdentity || `${campaignId}:${itemId}`, actorId: input.actorId || null, traceId: input.traceId || randomUUID() });
      const jobs = recipients.map(recipient => makeJob({ opportunityId: opportunity.id, type: 'campaign-ad', recipient: recipient.id, uniqueKey: [campaignId, itemId, selectionRevision], now, batchRevision: selectionRevision,
        status: batch.status, campaignId, itemId, itemSnapshot: batch.itemSnapshot, selectionFingerprint: batch.selectionFingerprint, automatic, traceId: batch.traceId, recipientName: recipient.name }));
      trace({ at: now, opportunityId: opportunity.id, stage: 'workflow_reserved', code: 'OP_CAMPAIGN_DESTINATIONS', detail: `${jobs.length} destino(s) da campanha reservados atomicamente.` });
      saveRequest({ ...opportunity, workflowStatus: batch.status, deliveryStatus: batch.status, updatedAt: now });
      return { ok: true, duplicate: false, batch, jobs };
    });
  }
  function updateJob(id, patch = {}) {
    return transaction(() => {
      const old = getJob(id); if (!old) throw new Error('Envio de oportunidade não encontrado.');
      const now = clock(patch.now ?? patch.resultAt ?? patch.acceptedAt ?? patch.deliveredAt ?? Date.now());
      for (const field of ['id', 'kind', 'opportunityId', 'type', 'recipient', 'campaignId', 'itemId', 'itemSnapshot', 'selectionFingerprint', 'clientMessageId', 'createdAt', 'at', 'batchRevision']) if (patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(old[field])) throw new Error('Identidade do envio de oportunidade não pode ser alterada.');
      if (patch.attemptId && old.attemptId && patch.attemptId !== old.attemptId) return old;
      const status = patch.status || old.status;
      if (!states.has(status)) throw new Error('Estado do envio de oportunidade inválido.');
      if (old.status === 'delivered' || old.status === 'accepted' && !['accepted', 'delivered'].includes(status)) return old;
      if (old.status === 'uncertain' && !['uncertain', 'accepted', 'delivered'].includes(status) && !(status === 'failed' && patch.confirmedFailure === true)) return old;
      if (old.status === 'cancelled' && !['cancelled', 'accepted', 'delivered'].includes(status)) return old;
      if (old.status === 'failed' && status === 'queued' && !(patch.confirmedFailure === true && patch.recoverable === true && old.attempts <= (config().retryMax ?? 2))) return old;
      if (old.status === 'processing' && status === 'queued' && (old.submittedAt || patch.confirmedFailure !== true)) return old;
      if (status === 'processing' && old.status !== 'processing') throw new Error('Use a reserva atômica para iniciar o envio.');
      if (['accepted', 'delivered'].includes(status) && !(patch.messageId || old.messageId)) throw new Error('Envio aceito exige identificador retornado pela integração.');
      if (old.messageId && patch.messageId && old.messageId !== patch.messageId) throw new Error('Confirmação pertence a outra mensagem.');
      const value = save({ ...old, ...safe(patch), status, updatedAt: now });
      if (value.type === 'campaign-ad') refreshBatch(value.opportunityId, now);
      trace({ at: now, opportunityId: value.opportunityId, taskId: value.id, traceId: value.traceId, stage: `workflow_${status}`, code: value.code || null, reason: value.reason || null, messageId: value.messageId || null });
      return value;
    });
  }
  Object.assign(store, {
    ensureOpportunityWorkflowIndexes: ensureIndexes,
    reserveOpportunityWorkflow,
    getOpportunityWorkflow: getBatch,
    listOpportunityWorkflows(filter = {}) {
      const where = ["storageMode=?", "kind='wf:batch'"], args = [mode()];
      if (filter.status !== undefined) { const values = Array.isArray(filter.status) ? filter.status : [filter.status]; where.push(values.length ? `json_extract(data,'$.status') IN(${values.map(() => '?').join(',')})` : '0'); args.push(...values); }
      return prepared(`SELECT data FROM op_notifications WHERE ${where.join(' AND ')} ORDER BY at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...args, Math.min(1000, Math.max(1, Number(filter.limit) || 100)), Math.max(0, Number(filter.offset) || 0)).map(decode);
    },
    approveOpportunityWorkflow(opportunityId, options = {}) {
      return transaction(() => {
        const now = clock(options.now ?? Date.now()), batch = getBatch(opportunityId), opportunity = store.getOpportunity(opportunityId);
        if (!batch) return failure('OP_NOT_FOUND', 'Selecione um anúncio para esta oportunidade.');
        if (!opportunity || opportunity.expiresAt <= now || ['closed', 'cancelled', 'expired'].includes(opportunity.status) || store.getOpportunityContactMute(opportunity.senderKey)?.muted) return failure('OP_INELIGIBLE', 'Pedido encerrado, expirado ou contato silenciado.');
        if (batch.status !== 'awaiting_approval') return { ok: true, duplicate: true, batch, jobs: activeJobs(opportunityId, batch) };
        const jobs = activeJobs(opportunityId, batch).map(job => job.status === 'awaiting_approval' ? save({ ...job, status: 'queued', approvedAt: now, approvedBy: options.actorId || null, nextAttemptAt: now }) : job);
        const updated = save({ ...batch, status: 'queued', approvedAt: now, approvedBy: options.actorId || null, updatedAt: now });
        return { ok: true, batch: updated, jobs };
      });
    },
    patchOpportunityWorkflowBatch(opportunityId, patch = {}) {
      return transaction(() => { const old = getBatch(opportunityId); if (!old) return null; for (const field of ['id', 'kind', 'opportunityId', 'senderKey', 'familyKey', 'campaignId', 'itemId', 'itemSnapshot', 'recipients', 'selectionFingerprint', 'createdAt', 'at']) if (patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(old[field])) throw new Error('Identidade da oportunidade reservada não pode ser alterada.'); return save({ ...old, ...safe(patch), updatedAt: clock(patch.now ?? Date.now()) }); });
    },
    getOpportunityWorkflowJob: getJob,
    listOpportunityWorkflowJobs: listJobs,
    getOpportunityWorkflowMetrics() {
      const jobs = {}, byType = {}; let total = 0;
      for (const row of prepared("SELECT json_extract(data,'$.type') type,json_extract(data,'$.status') status,COUNT(*) n FROM op_notifications WHERE storageMode=? AND kind LIKE 'wf:job:%' GROUP BY json_extract(data,'$.type'),json_extract(data,'$.status')").all(mode())) { const count = Number(row.n); jobs[row.status] = (jobs[row.status] || 0) + count; (byType[row.type] ||= {})[row.status] = count; total += count; }
      const last = prepared("SELECT MAX(COALESCE(json_extract(data,'$.updatedAt'),at)) lastAt FROM op_notifications WHERE storageMode=? AND kind LIKE 'wf:%'").get(mode());
      return { total, jobs, byType, lastUpdatedAt: last.lastAt == null ? null : Number(last.lastAt) };
    },
    claimOpportunityWorkflowJob(id, options = {}) {
      return transaction(() => {
        const old = getJob(id), now = clock(options.now ?? Date.now());
        if (!old || old.status !== 'queued' || (old.nextAttemptAt || 0) > now) return failure('OP_TASK_STATE', 'Envio não está disponível para iniciar.');
        if (options.automationAllowed === false) return failure('OP_STOPPED', 'Envios interrompidos.');
        if (old.type === 'campaign-ad') {
          const opportunity = store.getOpportunity(old.opportunityId), campaign = store.getCampaign?.(old.campaignId);
          const invalid = !opportunity || opportunity.expiresAt <= now || ['closed', 'cancelled', 'expired'].includes(opportunity.status) ? failure('OP_EXPIRED', 'Pedido encerrado ou expirado.')
            : store.getOpportunityContactMute(opportunity.senderKey)?.muted ? failure('OP_MUTED', 'Contato silenciado.')
              : !campaign || !config().campaignIds.includes(old.campaignId) || !campaign.items?.some(item => item.id === old.itemId) ? failure('OP_CAMPAIGN_REMOVED', 'A campanha ou o anúncio selecionado foi removido.')
                : !(campaign.groupIds || []).includes(old.recipient) ? failure('OP_RECIPIENT_REMOVED', 'O grupo deixou de ser destinatário da campanha.') : null;
          if (invalid) { save({ ...old, status: 'cancelled', cancelledAt: now, updatedAt: now, code: invalid.code, reason: invalid.reason }); refreshBatch(old.opportunityId, now); return invalid; }
        }
        const job = save({ ...old, status: 'processing', attempts: old.attempts + 1, attemptId: randomUUID(), lastAttemptAt: now, submittedAt: null, updatedAt: now });
        if (job.type === 'campaign-ad') refreshBatch(job.opportunityId, now);
        return { ok: true, job };
      });
    },
    markOpportunityWorkflowSubmitted(id, options = {}) {
      return transaction(() => { const old = getJob(id), now = clock(options.now ?? Date.now()); if (!old || old.status !== 'processing' || !options.attemptId || old.attemptId !== options.attemptId) return null; const job = save({ ...old, submittedAt: old.submittedAt ?? now, updatedAt: now }); const batch = getBatch(job.opportunityId); if (job.type === 'campaign-ad' && batch && !batch.firstSubmittedAt) save({ ...batch, firstSubmittedAt: now }); return job; });
    },
    updateOpportunityWorkflowJob: updateJob,
    enqueueOpportunityAdminNotice(input = {}) {
      return transaction(() => { const now = clock(input.now ?? Date.now()); if (!store.getOpportunity(key(input.opportunityId))) return failure('OP_NOT_FOUND', 'Oportunidade não encontrada.'); const recipient = key(input.recipient); if (!/^[1-9]\d{9,14}$/.test(recipient)) return failure('OP_ADMIN_PHONE', 'Informe o telefone completo e confiável do administrador.'); if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 32000) throw new Error('Mensagem administrativa inválida.'); const id = digest([mode(), input.opportunityId, 'admin-notice', key(input.key), recipient]), old = getJob(id); if (old) return { ok: true, duplicate: true, job: old }; return { ok: true, duplicate: false, job: makeJob({ opportunityId: input.opportunityId, type: 'admin-notice', recipient, uniqueKey: input.key, now, body: input.body, traceId: input.traceId || randomUUID(), status: 'queued' }) }; });
    },
    cancelOpportunityWorkflow(options = {}) {
      return transaction(() => { const now = clock(options.now ?? Date.now()); let cancelled = 0, inProgress = 0; const where = ["storageMode=?", "kind LIKE 'wf:job:%'", "json_extract(data,'$.status') IN('queued','awaiting_approval','processing')"], args = [mode()]; if (options.opportunityId) { where.push('opportunityId=?'); args.push(key(options.opportunityId)); } for (const row of prepared(`SELECT data FROM op_notifications WHERE ${where.join(' AND ')}`).all(...args)) { const job = decode(row); if (job.status === 'processing' && job.submittedAt !== null && job.submittedAt !== undefined) { inProgress++; continue; } save({ ...job, status: 'cancelled', cancelledAt: now, updatedAt: now, code: 'OP_STOPPED', reason: options.reason || 'Envios de oportunidades interrompidos.' }); cancelled++; } if (options.opportunityId) refreshBatch(options.opportunityId, now); else for (const row of prepared("SELECT opportunityId FROM op_notifications WHERE storageMode=? AND kind='wf:batch'").all(mode())) refreshBatch(row.opportunityId, now); return { cancelled, inProgress }; });
    },
    recoverOpportunityWorkflowJobs(at = Date.now()) {
      return transaction(() => { const now = clock(at); let uncertain = 0, requeued = 0; for (const row of prepared("SELECT data FROM op_notifications WHERE storageMode=? AND kind LIKE 'wf:job:%' AND json_extract(data,'$.status')='processing'").all(mode())) { const job = decode(row), submitted = job.submittedAt !== null && job.submittedAt !== undefined; save({ ...job, status: submitted ? 'uncertain' : 'queued', nextAttemptAt: now, updatedAt: now, code: submitted ? 'OP_RESTART_UNCERTAIN' : 'OP_RESTART_PENDING', reason: submitted ? 'Aplicativo encerrou durante o envio; confira o resultado antes de repetir.' : 'Envio ainda não submetido; aguardando reavaliação.' }); if (submitted) uncertain++; else requeued++; if (job.type === 'campaign-ad') refreshBatch(job.opportunityId, now); } return { uncertain, requeued }; });
    }
  });
  return store;
}

function restoreWorkflowNotification(notification) {
  if (!notification.kind?.startsWith(PREFIX)) return notification;
  const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
  const group = value => typeof value === 'string' && /@(?:g\.us|simulation)$/.test(value);
  if (notification.kind === BATCH) {
    if (!validKey(notification.opportunityId) || notification.id !== notification.opportunityId || !validKey(notification.campaignId) || !validKey(notification.itemId) || !notification.itemSnapshot || typeof notification.itemSnapshot !== 'object' || Array.isArray(notification.itemSnapshot) || !Array.isArray(notification.recipients) || !notification.recipients.length || notification.recipients.length > 1000 || notification.recipients.some(recipient => recipient.type !== 'group' || !group(recipient.id)) || ![...states, 'partial'].includes(notification.status)) throw new Error('Reserva de campanha inválida no backup de oportunidades.');
    return { ...notification, status: ['accepted', 'delivered', 'uncertain', 'failed', 'cancelled', 'partial'].includes(notification.status) ? notification.status : 'cancelled', restoreReviewRequired: true };
  }
  if (notification.kind.startsWith(JOB)) {
    if (!/^[a-f0-9]{64}$/.test(notification.id || '') || notification.kind !== JOB + notification.id || !validKey(notification.opportunityId) || !['campaign-ad', 'admin-notice'].includes(notification.type) || !states.has(notification.status) || !/^[A-F0-9]{32}$/.test(notification.clientMessageId || '') || !Number.isInteger(notification.attempts) || notification.attempts < 0 || ['accepted', 'delivered'].includes(notification.status) && !validKey(notification.messageId)) throw new Error('Envio inválido no backup de oportunidades.');
    if (notification.type === 'campaign-ad' ? !group(notification.recipient) || !validKey(notification.campaignId) || !validKey(notification.itemId) || !notification.itemSnapshot || typeof notification.itemSnapshot !== 'object' || Array.isArray(notification.itemSnapshot) : !/^[1-9]\d{9,14}$/.test(notification.recipient || '') || typeof notification.body !== 'string' || !notification.body.trim() || notification.body.length > 32000) throw new Error('Destinatário ou anúncio inválido no backup de oportunidades.');
    return { ...notification, status: notification.status === 'processing' ? notification.submittedAt != null ? 'uncertain' : 'cancelled' : ['queued', 'awaiting_approval'].includes(notification.status) ? 'cancelled' : notification.status, restoreReviewRequired: true };
  }
  throw new Error('Tipo de registro operacional desconhecido no backup de oportunidades.');
}

module.exports = { attachOpportunityWorkflowStore, restoreWorkflowNotification };
