'use strict';

const { createHash } = require('node:crypto');

/** Source publication ledgers are operational data, not disposable histories. */
function attachSourceStore(store, { db, prepared, transaction }) {
  db.exec(`CREATE TABLE IF NOT EXISTS source_publications(
    storageMode TEXT NOT NULL,id TEXT NOT NULL,groupId TEXT NOT NULL,messageId TEXT NOT NULL,
    originalAt INTEGER NOT NULL,capturedAt INTEGER NOT NULL,revisionAt INTEGER NOT NULL,
    campaignId TEXT,status TEXT NOT NULL,data TEXT NOT NULL,
    PRIMARY KEY(storageMode,groupId,messageId),UNIQUE(storageMode,id));
    CREATE INDEX IF NOT EXISTS source_publications_due ON source_publications(storageMode,status,capturedAt);
    CREATE INDEX IF NOT EXISTS source_publications_campaign ON source_publications(storageMode,campaignId,originalAt);
    CREATE TABLE IF NOT EXISTS source_days(
    storageMode TEXT NOT NULL,groupId TEXT NOT NULL,dateKey TEXT NOT NULL,campaignId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,data TEXT NOT NULL,
    PRIMARY KEY(storageMode,groupId,dateKey),UNIQUE(storageMode,campaignId));
    CREATE INDEX IF NOT EXISTS source_days_created ON source_days(storageMode,createdAt DESC);
    CREATE TABLE IF NOT EXISTS source_group_links(storageMode TEXT NOT NULL,groupId TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(storageMode,groupId));
    CREATE INDEX IF NOT EXISTS source_group_links_campaign ON source_group_links(storageMode,json_extract(data,'$.campaignId'));`);
  const mode = () => store.getStorageMode?.() || store.getSetting('integrationMode', 'whatsapp');
  const decode = row => { if (!row) return undefined; const value = JSON.parse(row.data); return row.captureOrder === undefined ? value : { ...value, captureOrder: Number(row.captureOrder) }; };
  const key = (value, label = 'Identificador') => {
    if (typeof value !== 'string' || !value || value.length > 512) throw new Error(`${label} inválido.`);
    return value;
  };
  const integer = value => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Horário da publicação inválido.');
    return value;
  };
  const get = id => decode(prepared('SELECT rowid captureOrder,data FROM source_publications WHERE storageMode=? AND id=?').get(mode(), key(id)));
  const byMessage = (groupId, messageId) => decode(prepared('SELECT rowid captureOrder,data FROM source_publications WHERE storageMode=? AND groupId=? AND messageId=?').get(mode(), key(groupId), key(messageId)));
  function save(input, { insertOnly = false } = {}) {
    const storageMode = mode();
    if (input.storageMode && input.storageMode !== storageMode) throw new Error('A publicação pertence a outro modo de integração.');
    const groupId = key(input.groupId), messageId = key(input.messageId);
    const old = byMessage(groupId, messageId);
    if (insertOnly && old) return { inserted: false, publication: old };
    const value = { ...old, ...input, storageMode, simulation: storageMode === 'simulated', groupId, messageId,
      id: old?.id || input.id || createHash('sha256').update(`${storageMode}\0${groupId}\0${messageId}`).digest('hex'),
      originalAt: old?.originalAt ?? integer(input.originalAt), capturedAt: old?.capturedAt ?? integer(input.capturedAt),
      revisionAt: integer(input.revisionAt ?? old?.revisionAt ?? input.originalAt) };
    if (!['pending', 'downloading', 'ready', 'review', 'failed', 'removed'].includes(value.status)) throw new Error('Estado de publicação inválido.');
    key(value.id);
    prepared(`INSERT INTO source_publications(storageMode,id,groupId,messageId,originalAt,capturedAt,revisionAt,campaignId,status,data)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(storageMode,groupId,messageId) DO UPDATE SET
      revisionAt=excluded.revisionAt,campaignId=excluded.campaignId,status=excluded.status,data=excluded.data`)
      .run(storageMode, value.id, groupId, messageId, value.originalAt, value.capturedAt, value.revisionAt, value.campaignId || null, value.status, JSON.stringify(value));
    const saved = byMessage(groupId, messageId);
    return insertOnly ? { inserted: true, publication: saved } : saved;
  }
  function list(filters = {}) {
    const where = ['storageMode=?'], args = [mode()];
    for (const column of ['campaignId', 'groupId', 'dateKey', 'status']) if (filters[column] !== undefined && filters[column] !== null) {
      const values = Array.isArray(filters[column]) ? filters[column] : [filters[column]];
      if (values.length > 1000) throw new Error('Filtro de publicações muito grande.');
      const sqlColumn = column === 'dateKey' ? "json_extract(data,'$.dateKey')" : column;
      where.push(values.length ? `${sqlColumn} IN(${values.map(() => '?').join(',')})` : '0'); args.push(...values);
    }
    const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50)), offset = Math.max(0, Math.floor(Number(filters.offset) || 0));
    const sql = `FROM source_publications WHERE ${where.join(' AND ')}`;
    const total = Number(prepared(`SELECT COUNT(*) n ${sql}`).get(...args).n);
    const order = filters.order === 'capture' ? 'capturedAt ASC,rowid ASC' : 'originalAt DESC,messageId DESC';
    const items = prepared(`SELECT rowid captureOrder,data ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset).map(decode);
    return { items, total, limit, offset };
  }
  const portableFields = ['id','groupId','messageId','originalAt','capturedAt','revisionAt','campaignId','itemId','mediaId','mediaType','type','status','dateKey',
    'caption','text','originalCaption','originalText','senderId','senderPhone','fromMe','albumParent','manualGroupId','mediaFingerprint',
    'reason','code','error','attempts','lastAttemptAt','failedAt','readyAt','lastEditedAt','removedAt','removedBy','removalOrigin','reviewedAt','reviewedBy','groupedBy','groupedAt',
    'traceId','historical','ownerId','storageMode','simulation','captureGeneration'];
  const portableRecord = record => Object.fromEntries(portableFields.filter(field => record[field] !== undefined).map(field => [field, record[field]]));
  function exportSourceData() {
    return { version: 1, storageMode: mode(), config: store.getSourceConfig(),
      publications: prepared('SELECT data FROM source_publications WHERE storageMode=? ORDER BY capturedAt,rowid').all(mode()).map(decode).map(portableRecord),
      links: prepared('SELECT data FROM source_group_links WHERE storageMode=? ORDER BY groupId').all(mode()).map(decode),
      days: prepared('SELECT data FROM source_days WHERE storageMode=? ORDER BY createdAt').all(mode()).map(decode).map(day => ({ ...day, campaignDeleted: !store.getCampaign(day.campaignId) })) };
  }
  function importSourceData(input) {
    if (input?.links !== undefined && (!Array.isArray(input.links) || input.links.length > 10000)) throw new Error('Vínculos de origem inválidos no backup.');
    if (!input || input.version !== 1 || input.storageMode !== mode() || !Array.isArray(input.publications) || !Array.isArray(input.days) || input.publications.length > 100000 || input.days.length > 100000) throw new Error('Backup de origem inválido ou pertencente a outro modo.');
    const { normalizeSourceConfig, localDay } = require('./source-campaigns.cjs');
    const config = { ...normalizeSourceConfig({ ...input.config, enabled: false }, {}, Date.now(), null), ownerId: null, actorId: null, enabledAt: null, importFrom: null, importUntil: null };
    const seen = new Set();
    const publications = input.publications.map(raw => {
      if (!raw || typeof raw !== 'object' || ['protectedContext','raw','mediaDownloadContext','downloadContext','mediaKey'].some(field => Object.hasOwn(raw, field))) throw new Error('Backup de origem não pode conter credenciais de mídia.');
      const record = portableRecord(raw), recordKey = `${key(record.groupId)}\0${key(record.messageId)}`;
      key(record.id); integer(record.originalAt); integer(record.capturedAt); integer(record.revisionAt);
      if (seen.has(recordKey) || record.storageMode && record.storageMode !== mode() || !['pending','downloading','ready','review','failed','removed'].includes(record.status)) throw new Error('Publicação de origem inválida ou repetida no backup.');
      if (mode() === 'simulated' ? !/@simulation$/.test(record.groupId) : !/^[^\s@]+@g\.us$/.test(record.groupId)) throw new Error('Origem real e simulada não podem ser misturadas no backup.');
      for (const field of ['caption','text','originalCaption','originalText']) if (record[field] !== undefined && (typeof record[field] !== 'string' || record[field].length > 65536)) throw new Error('Texto de origem inválido no backup.');
      if (record.dateKey !== localDay(record.originalAt, config.timezone)) throw new Error('A data local da origem não corresponde à mensagem original.');
      if (record.mediaId) key(record.mediaId);
      if (record.campaignId) key(record.campaignId);
      seen.add(recordKey); return record;
    });
    const dayKeys = new Set();
    const days = input.days.map(raw => {
      const day = { groupId: key(raw?.groupId), dateKey: key(raw?.dateKey), campaignId: key(raw?.campaignId), createdAt: integer(raw?.createdAt), campaignDeleted: raw?.campaignDeleted === true, previousCampaignIds: Array.isArray(raw?.previousCampaignIds) ? [...new Set(raw.previousCampaignIds.map(id => key(id)))] : [] }, value = `${day.groupId}\0${day.dateKey}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.dateKey) || !Number.isFinite(Date.parse(day.dateKey)) || new Date(day.dateKey).toISOString().slice(0,10) !== day.dateKey || dayKeys.has(value)) throw new Error('Dia de origem inválido ou repetido no backup.');
      if (mode() === 'simulated' ? !/@simulation$/.test(day.groupId) : !/^[^\s@]+@g\.us$/.test(day.groupId)) throw new Error('Dia de origem pertence a outro modo de integração.');
      const campaign = store.getCampaign(day.campaignId);
      if (campaign ? campaign.sourceManaged !== true || campaign.sourceGroupId !== day.groupId || campaign.sourceDateKey !== day.dateKey : !day.campaignDeleted) throw new Error('O dia de origem aponta para uma campanha incompatível ou ausente sem registro de exclusão.');
      for (const id of day.previousCampaignIds) { const prior = store.getCampaign(id); if (prior && (prior.sourceManaged !== true || prior.sourceGroupId !== day.groupId || prior.sourceDateKey !== day.dateKey)) throw new Error('O vínculo anterior da origem aponta para campanha incompatível.'); }
      const existing = store.getSourceDay(day.groupId, day.dateKey);
      if (existing && existing.campaignId !== day.campaignId && !existing.previousCampaignIds?.includes(day.campaignId) && !day.previousCampaignIds.includes(existing.campaignId)) throw new Error('O backup de origem conflita com um registro diário existente. Use uma cópia completa consistente para recuperação.');
      dayKeys.add(value); return day;
    });
    const byDay = new Map(days.map(day => [`${day.groupId}\0${day.dateKey}`, day]));
    for (const record of publications) if (record.campaignId) {
      const day = byDay.get(`${record.groupId}\0${record.dateKey}`);
      if (!day || day.campaignId !== record.campaignId && !day.previousCampaignIds.includes(record.campaignId)) throw new Error('A publicação e o registro diário apontam para campanhas diferentes no backup.');
    }
    const links = (input.links || []).map(link => { if (!link || !['active','paused'].includes(link.status)) throw new Error('Estado de vínculo inválido no backup.'); key(link.groupId); if (link.campaignId) key(link.campaignId); integer(link.generation || 0); integer(link.captureFrom || 0); if (link.pausedAt !== undefined && link.pausedAt !== null) integer(link.pausedAt); return { ...link };  });
    return transaction(() => {
      store.setSourceConfig(config); let restored = 0, preserved = 0;
      for (let record of publications) {
        const old = byMessage(record.groupId, record.messageId);
        if (old && (old.status === 'removed' || old.revisionAt > record.revisionAt)) { preserved++; continue; }
        const validFingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
        const sameMedia = old && (validFingerprint(old.mediaFingerprint) && validFingerprint(record.mediaFingerprint)
          ? old.mediaFingerprint.toLowerCase() === record.mediaFingerprint.toLowerCase()
          : !old.mediaFingerprint && !record.mediaFingerprint && old.revisionAt === record.revisionAt && old.type === record.type && old.mediaId === record.mediaId && old.caption === record.caption);
        record = { ...record, protectedContext: sameMedia ? old.protectedContext || null : null, storageMode: mode(), simulation: mode() === 'simulated' };
        if (record.status === 'downloading') record.status = 'pending';
        if (record.mediaId && !store.getMedia(record.mediaId)) record = { ...record, mediaId: null, status: record.status === 'removed' ? 'removed' : 'review', reason: 'Mídia ausente na restauração; importe o arquivo antes de incluir.' };
        if (record.status === 'pending' && !record.mediaId && !record.protectedContext) record = { ...record, status: 'failed', code: 'SOURCE_MEDIA_REPOST_REQUIRED', error: 'A cópia portátil não inclui credenciais de download. Reenvie a publicação ou importe a mídia.' };
        save(record); restored++;
      }
      for (const day of days) { const existing = store.getSourceDay(day.groupId, day.dateKey); if (!existing) store.insertSourceDay(day); }
      for (const link of links) { const existing = store.getSourceLink(link.groupId); if (!existing || existing.status !== 'paused') store.setSourceLink(link); }
      return { restored, preserved, enabled: false, automaticResume: false, mediaCredentialsRestored: false };
    });
  }
  function saveLink(input) {
    const old = store.getSourceLink(input.groupId), value = { ...old, ...input, groupId: key(input.groupId), storageMode: mode() };
    if (!['active','paused'].includes(value.status)) throw new Error('Estado de vínculo de origem inválido.');
    value.generation = integer(value.generation ?? old?.generation ?? 0); value.captureFrom = integer(value.captureFrom ?? old?.captureFrom ?? 0);
    if (value.campaignId) key(value.campaignId);
    prepared('INSERT INTO source_group_links(storageMode,groupId,status,data) VALUES(?,?,?,?) ON CONFLICT(storageMode,groupId) DO UPDATE SET status=excluded.status,data=excluded.data').run(mode(), value.groupId, value.status, JSON.stringify(value)); return value;
  }
  function pauseSourceGroup(groupId, options = {}) { return transaction(() => {
    key(groupId); const old = store.getSourceLink(groupId), at = integer(options.at ?? Date.now()), code = options.code || 'SOURCE_CAMPAIGN_REMOVED', reason = options.reason || 'A campanha vinculada foi excluída; a captura permanece pausada até retomada explícita.';
    const changed = old?.status !== 'paused'; const link = saveLink({ ...old, groupId, status: 'paused', pausedAt: old?.status === 'paused' ? old.pausedAt : at, reason, code, campaignId: null, previousCampaignId: options.campaignId || old?.campaignId || old?.previousCampaignId || null, actorId: options.actorId || null });
    let cancelledPublications = 0;
    for (;;) { const rows = prepared("SELECT data FROM source_publications WHERE storageMode=? AND groupId=? AND status!='removed' AND (status IN('pending','downloading') OR (? IS NOT NULL AND campaignId=?)) LIMIT 200").all(mode(), groupId, options.campaignId || null, options.campaignId || null); if (!rows.length) break;
      for (const row of rows) { const record = decode(row); save({ ...record, status: 'removed', removedAt: at, removedBy: options.actorId || null, removalOrigin: 'campaign-link-paused', code, reason, protectedContext: null }); cancelledPublications++; }
    }
    return { link, changed, cancelledPublications };
  }); }
  function getSourceGroupsLinkedToCampaign(campaignId) {
    key(campaignId); const campaign = store.getCampaign(campaignId), candidates = new Set();
    if (campaign?.sourceManaged && campaign.sourceGroupId) candidates.add(campaign.sourceGroupId);
    for (const row of prepared('SELECT groupId FROM source_days WHERE storageMode=? AND campaignId=?').all(mode(), campaignId)) candidates.add(row.groupId);
    for (const row of prepared("SELECT groupId FROM source_group_links WHERE storageMode=? AND json_extract(data,'$.campaignId')=?").all(mode(), campaignId)) candidates.add(row.groupId);
    return [...candidates].filter(groupId => {
      const link = store.getSourceLink(groupId);
      // Historical daily campaigns retain their origin metadata. That does
      // not make them the current capture target after another day or resume.
      if (link) return link.campaignId === campaignId;
      // Before persistent links existed, only the latest daily binding can
      // represent the currently configured origin. Never pause for an older
      // day merely because it references the same WhatsApp group.
      return store.getLatestSourceDay(groupId)?.campaignId === campaignId;
    });
  }
  function pauseSourceForCampaign(campaignId, options = {}) { return transaction(() => {
    key(campaignId); const groups = getSourceGroupsLinkedToCampaign(campaignId), at = integer(options.at ?? Date.now());
    let cancelledPublications = 0; const links = [];
    for (const groupId of groups) { const paused = pauseSourceGroup(groupId, { ...options, at, campaignId }); cancelledPublications += paused.cancelledPublications; links.push(paused.link); }
    // The deleted campaign's own ledger must become a tombstone even when its
    // source group has already moved to a different campaign. Preserve new
    // campaign downloads, queue entries, and the current persistent binding.
    for (;;) {
      const rows = prepared("SELECT data FROM source_publications WHERE storageMode=? AND campaignId=? AND status!='removed' LIMIT 200").all(mode(), campaignId);
      if (!rows.length) break;
      for (const row of rows) { const record = decode(row); save({ ...record, status: 'removed', removedAt: at, removedBy: options.actorId || null, removalOrigin: 'campaign-deleted', code: 'SOURCE_CAMPAIGN_REMOVED', reason: options.reason || 'A campanha desta publicação foi excluída; seu conteúdo não será importado novamente.', protectedContext: null }); cancelledPublications++; }
    }
    for (const row of prepared('SELECT data FROM source_days WHERE storageMode=? AND campaignId=?').all(mode(), campaignId)) { const day = decode(row); prepared('UPDATE source_days SET data=? WHERE storageMode=? AND groupId=? AND dateKey=?').run(JSON.stringify({ ...day, campaignDeleted: true, deletedAt: at }), mode(), day.groupId, day.dateKey); }
    return { groupIds: groups, pausedGroups: groups.length, cancelledPublications, links };
  }); }
  function relinkSourceDay(input) { return transaction(() => {
    const old = store.getSourceDay(input.groupId, input.dateKey), campaign = store.getCampaign(input.campaignId);
    if (!campaign || campaign.sourceManaged !== true || campaign.sourceGroupId !== input.groupId || campaign.sourceDateKey !== input.dateKey) throw new Error('A retomada deve vincular uma campanha de origem compatível.');
    if (!old) return store.insertSourceDay(input).day;
    const previousCampaignIds = [...new Set([...(old.previousCampaignIds || []), ...(old.campaignId !== input.campaignId ? [old.campaignId] : [])])];
    const day = { ...old, ...input, previousCampaignIds, campaignDeleted: false, storageMode: mode() };
    prepared('UPDATE source_days SET campaignId=?,data=? WHERE storageMode=? AND groupId=? AND dateKey=?').run(key(day.campaignId), JSON.stringify(day), mode(), key(day.groupId), key(day.dateKey)); return day;
  }); }
  Object.assign(store, {
    exportSourceData, importSourceData, pauseSourceGroup, pauseSourceForCampaign, getSourceGroupsLinkedToCampaign, relinkSourceDay,
    getSourceLink(groupId) { return decode(prepared('SELECT data FROM source_group_links WHERE storageMode=? AND groupId=?').get(mode(), key(groupId))); },
    setSourceLink: value => transaction(() => saveLink(value)),
    getLatestSourceDay(groupId) { return decode(prepared('SELECT data FROM source_days WHERE storageMode=? AND groupId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(mode(), key(groupId))); },
    getSourceConfig() { return decode(prepared('SELECT data FROM settings WHERE id=?').get(`mode:${mode()}:sourceCampaignConfig`))?.value || {}; },
    setSourceConfig(value) { return transaction(() => { const id = `mode:${mode()}:sourceCampaignConfig`; prepared('INSERT INTO settings(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify({ id, value })); return value; }); },
    getSourcePublication(id, messageId) { return messageId === undefined ? get(id) : byMessage(id, messageId); },
    insertSourcePublication: value => transaction(() => save(value, { insertOnly: true })),
    saveSourcePublication: value => transaction(() => save(value)),
    updateSourcePublication(id, patch) { return transaction(() => { const old = get(id); if (!old) throw new Error('Publicação não encontrada.'); return save({ ...old, ...patch }); }); },
    listSourcePublications: list,
    getSourceDay(groupId, dateKey) { return decode(prepared('SELECT data FROM source_days WHERE storageMode=? AND groupId=? AND dateKey=?').get(mode(), key(groupId), key(dateKey))); },
    insertSourceDay(value) { return transaction(() => {
      const old = store.getSourceDay(value.groupId, value.dateKey); if (old) return { inserted: false, day: old };
      const day = { ...value, storageMode: mode(), simulation: mode() === 'simulated' };
      prepared('INSERT INTO source_days(storageMode,groupId,dateKey,campaignId,createdAt,data) VALUES(?,?,?,?,?,?)').run(mode(), key(day.groupId), key(day.dateKey), key(day.campaignId), integer(day.createdAt), JSON.stringify(day));
      return { inserted: true, day };
    }); },
    listSourceDays({ limit = 50, offset = 0 } = {}) { return prepared('SELECT data FROM source_days WHERE storageMode=? ORDER BY createdAt DESC LIMIT ? OFFSET ?').all(mode(), Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0)).map(decode); },
    getSourceMetrics({ campaignId } = {}) { const counts = { ready: 0, pending: 0, downloading: 0, failed: 0, review: 0, removed: 0 }, where = campaignId ? 'storageMode=? AND campaignId=?' : 'storageMode=?', args = campaignId ? [mode(), key(campaignId)] : [mode()];
      for (const row of prepared(`SELECT status,COUNT(*) n FROM source_publications WHERE ${where} GROUP BY status`).all(...args)) counts[row.status] = Number(row.n);
      const times = prepared(`SELECT MAX(capturedAt) lastCaptureAt FROM source_publications WHERE ${where}`).get(...args);
      return { ...counts, pending: counts.pending + counts.downloading, total: Object.values(counts).reduce((sum, n) => sum + n, 0), lastCaptureAt: times.lastCaptureAt || null };
    }
  });
  return store;
}

module.exports = { attachSourceStore };
