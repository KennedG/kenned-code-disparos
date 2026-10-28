'use strict';

const { createHash, randomUUID } = require('node:crypto');

// The captured supplier data and operational command/delivery ledgers intentionally
// remain outside campaign history, portable backup and campaign restore.
function createSearchSchema(db) {
  const schema = `
    CREATE TABLE IF NOT EXISTS buscas_messages(
      chatId TEXT NOT NULL,messageId TEXT NOT NULL,originalAt INTEGER NOT NULL,
      capturedAt INTEGER NOT NULL,revisionAt INTEGER NOT NULL,deletedAt INTEGER,
      senderId TEXT,forwarded INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,
      PRIMARY KEY(chatId,messageId));
    CREATE INDEX IF NOT EXISTS buscas_messages_time ON buscas_messages(originalAt DESC);
    CREATE INDEX IF NOT EXISTS buscas_messages_chat_time ON buscas_messages(chatId,originalAt DESC);
    CREATE TABLE IF NOT EXISTS buscas_offers(
      id TEXT PRIMARY KEY,chatId TEXT NOT NULL,messageId TEXT NOT NULL,messageAt INTEGER NOT NULL,
      supplierKey TEXT,modelKey TEXT,storageGB INTEGER,colorKey TEXT,condition TEXT,
      batteryPercent INTEGER,priceCents INTEGER,priceKind TEXT,confidence TEXT NOT NULL,
      status TEXT NOT NULL,productKey TEXT,fingerprint TEXT,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS buscas_offers_message ON buscas_offers(chatId,messageId);
    CREATE INDEX IF NOT EXISTS buscas_offers_rank ON buscas_offers(confidence,status,priceCents,messageAt DESC);
    CREATE INDEX IF NOT EXISTS buscas_offers_product ON buscas_offers(supplierKey,productKey,messageAt DESC);
    CREATE INDEX IF NOT EXISTS buscas_offers_filters ON buscas_offers(modelKey,storageGB,colorKey,condition,messageAt DESC);
    CREATE INDEX IF NOT EXISTS buscas_offers_time ON buscas_offers(messageAt DESC);
    CREATE INDEX IF NOT EXISTS buscas_offers_fingerprint ON buscas_offers(fingerprint,messageAt DESC);
    CREATE TABLE IF NOT EXISTS buscas_authorizations(
      id TEXT PRIMARY KEY,principalId TEXT,active INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS buscas_authorizations_principal ON buscas_authorizations(principalId) WHERE principalId IS NOT NULL;
    CREATE TABLE IF NOT EXISTS buscas_runs(
      id TEXT PRIMARY KEY,chatId TEXT,messageId TEXT,userId TEXT,createdAt INTEGER NOT NULL,
      status TEXT NOT NULL,data TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS buscas_runs_command ON buscas_runs(chatId,messageId) WHERE chatId IS NOT NULL AND messageId IS NOT NULL;
    CREATE INDEX IF NOT EXISTS buscas_runs_user_time ON buscas_runs(userId,createdAt DESC);
    CREATE INDEX IF NOT EXISTS buscas_runs_status_time ON buscas_runs(status,createdAt DESC);
    CREATE TABLE IF NOT EXISTS buscas_history(
      id TEXT PRIMARY KEY,userId TEXT,chatId TEXT,createdAt INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS buscas_history_time ON buscas_history(createdAt DESC);
    CREATE INDEX IF NOT EXISTS buscas_history_user_time ON buscas_history(userId,createdAt DESC);
    CREATE TABLE IF NOT EXISTS buscas_deliveries(
      id TEXT PRIMARY KEY,runId TEXT NOT NULL,status TEXT NOT NULL,createdAt INTEGER NOT NULL,
      messageId TEXT,nextAttemptAt INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS buscas_deliveries_status_due ON buscas_deliveries(status,nextAttemptAt,createdAt);
    CREATE INDEX IF NOT EXISTS buscas_deliveries_run ON buscas_deliveries(runId,createdAt);
    CREATE INDEX IF NOT EXISTS buscas_deliveries_message ON buscas_deliveries(messageId,status);
    CREATE TABLE IF NOT EXISTS buscas_gaps(
      id TEXT PRIMARY KEY,startedAt INTEGER NOT NULL,endedAt INTEGER,chatId TEXT,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS buscas_gaps_time ON buscas_gaps(startedAt DESC);
    CREATE TABLE IF NOT EXISTS buscas_inbox(
      id TEXT PRIMARY KEY,status TEXT NOT NULL,createdAt INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS buscas_inbox_status_time ON buscas_inbox(status,createdAt);
  `;
  db.exec(schema);
  db.exec(schema.replace(/\bbuscas_(messages|offers|authorizations|runs|history|deliveries|gaps|inbox)(?![a-z_])/g, '$&_simulation').replace(/\bbuscas_(messages|offers|authorizations|runs|history|deliveries|gaps|inbox)_[a-z_]+(?= ON)/g, '$&_simulation'));
}

function attachSearchStore(store,{db,prepared: basePrepared,transaction}) {
  createSearchSchema(db);
  const tablePattern = /\bbuscas_(messages|offers|authorizations|runs|history|deliveries|gaps|inbox)\b/g;
  const mode = () => store.getStorageMode?.() || (store.getSetting('integrationMode', 'simulated') === 'whatsapp' ? 'whatsapp' : 'simulated');
  const prepared = sql => basePrepared(mode() === 'simulated' ? sql.replace(tablePattern, '$&_simulation') : sql);
  // Only proven demo records are moved: explicit metadata or the protocol's
  // simulation namespace. Display names are never used to classify data.
  db.exec('CREATE TABLE IF NOT EXISTS buscas_isolation_meta(id TEXT PRIMARY KEY)');
  if (!basePrepared("SELECT id FROM buscas_isolation_meta WHERE id='v1'").get()) transaction(() => {
    const proven = `COALESCE(json_extract(data,'$.simulation'),0)=1 OR COALESCE(json_extract(data,'$.storageMode'),'')='simulated' OR COALESCE(json_extract(data,'$.chatId'),'') LIKE '%@simulation' OR COALESCE(json_extract(data,'$.context.simulation'),0)=1 OR COALESCE(json_extract(data,'$.context.chatId'),'') LIKE '%@simulation'`;
    for (const table of ['messages','offers','inbox']) {
      basePrepared(`INSERT OR IGNORE INTO buscas_${table}_simulation SELECT * FROM buscas_${table} WHERE ${proven}`).run();
      basePrepared(`DELETE FROM buscas_${table} WHERE ${proven}`).run();
    }
    const runs = `${proven} OR id IN(SELECT id FROM buscas_runs WHERE EXISTS(SELECT 1 FROM json_each(json_extract(buscas_runs.data,'$.resultOfferIds')) refs JOIN buscas_offers_simulation offers ON refs.value=offers.id))`;
    basePrepared(`INSERT OR IGNORE INTO buscas_runs_simulation SELECT * FROM buscas_runs WHERE ${runs}`).run();
    for (const table of ['history','deliveries']) {
      const condition = table === 'history' ? 'id IN(SELECT id FROM buscas_runs_simulation)' : 'runId IN(SELECT id FROM buscas_runs_simulation)';
      basePrepared(`INSERT OR IGNORE INTO buscas_${table}_simulation SELECT * FROM buscas_${table} WHERE ${condition} OR ${proven}`).run();
      basePrepared(`DELETE FROM buscas_${table} WHERE ${condition} OR ${proven}`).run();
    }
    basePrepared('DELETE FROM buscas_runs WHERE id IN(SELECT id FROM buscas_runs_simulation)').run();
    basePrepared("INSERT INTO buscas_isolation_meta(id) VALUES('v1')").run();
  });
  const foldText=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  db.function('buscas_fold_text',{deterministic:true},foldText);
  const scoped=value=>{if(value?.storageMode && value.storageMode!==mode())throw new Error('O registro BUSCAS pertence a outro modo de integração.');return {...value,storageMode:mode(),simulation:mode()==='simulated'};};
  const encode=JSON.stringify;
  const decode=row=>row?JSON.parse(row.data):undefined;
  const identifier=(value,label='Identificador')=>{if(typeof value!=='string'||!value||value.length>500)throw new Error(`${label} inválido.`);return value;};
  const timestamp=(value,fallback=Date.now())=>{const n=typeof value==='string'?Date.parse(value):Number(value??fallback);if(!Number.isFinite(n)||n<0)throw new Error('Data BUSCAS inválida.');return Math.floor(n);};
  const optionalInt=value=>value===null||value===undefined||value===''?null:Number.isInteger(Number(value))?Number(value):null;
  const limit=(value,fallback=50,max=500)=>Number.isInteger(Number(value))&&Number(value)>=0?Math.min(Number(value),max):fallback;
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const page=(table,filters={},columns={},extra=[],extraParams=[],order='createdAt DESC,rowid DESC')=>{
    const where=[...extra],params=[...extraParams];
    for(const [field,column]of Object.entries(columns))if(filters[field]!==undefined&&filters[field]!==null){
      const values=Array.isArray(filters[field])?filters[field]:[filters[field]];
      if(values.length>1000)throw new Error('Filtros BUSCAS excedem o limite.');
      if(!values.length){where.push('0');continue;}
      where.push(`${column} IN(${values.map(()=>'?').join(',')})`);params.push(...values);
    }
    const timeColumn=table==='buscas_messages'?'originalAt':table==='buscas_offers'?'o.messageAt':table==='buscas_gaps'?'startedAt':'createdAt';
    if(filters.from!==undefined&&filters.from!==null&&filters.from!==''){where.push(`${timeColumn}>=?`);params.push(timestamp(filters.from));}
    if(filters.to!==undefined&&filters.to!==null&&filters.to!==''){where.push(`${timeColumn}<=?`);params.push(timestamp(filters.to));}
    if(filters.search){where.push("data LIKE ? ESCAPE '\\'");params.push(`%${String(filters.search).slice(0,200).replace(/[\\%_]/g,'\\$&')}%`);}
    let sql=where.length?' WHERE '+where.join(' AND '):'',source=table==='buscas_offers'?'buscas_offers o':table,prefix='';
    if(table==='buscas_offers'&&filters.onePerSupplier){prefix=`WITH selected AS(SELECT o.rowid AS rowid,o.*,ROW_NUMBER() OVER(PARTITION BY COALESCE(o.supplierKey,o.id) ORDER BY ${order}) AS supplierRank FROM buscas_offers o${sql}) `;source='selected o';sql=' WHERE supplierRank=1';}
    const n=limit(filters.limit),offset=limit(filters.offset,0,10000000);
    const total=Number(prepared(`${prefix}SELECT COUNT(*) n FROM ${source}${sql}`).get(...params).n);
    const items=prepared(`${prefix}SELECT ${table==='buscas_offers'?'o.':''}data FROM ${source}${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params,n,offset).map(decode);
    return {items,total,limit:n,offset};
  };
  const getMessage=(chatId,messageId)=>decode(prepared('SELECT data FROM buscas_messages WHERE chatId=? AND messageId=?').get(identifier(chatId),identifier(messageId)));
  const messageOffers=(chatId,messageId)=>prepared('SELECT data FROM buscas_offers WHERE chatId=? AND messageId=? ORDER BY rowid').all(chatId,messageId).map(decode);
  function upsertMessage(input,offers=[]) {
    if(!input||!Array.isArray(offers)||offers.length>1000)throw new Error('Mensagem ou lista de ofertas BUSCAS inválida.');
    input=scoped(input);
    const chatId=identifier(input.chatId??input.groupId,'Grupo'),messageId=identifier(input.messageId??input.id,'Mensagem');
    if(typeof input.text!=='string'||Buffer.byteLength(input.text,'utf8')>1048576)throw new Error('Texto da mensagem BUSCAS inválido ou muito grande.');
    return transaction(()=>{
      const old=getMessage(chatId,messageId),originalAt=old?.originalAt??timestamp(input.originalAt??input.messageAt??input.timestamp??input.at);
      const revisionAt=timestamp(input.revisionAt??input.editedAt,originalAt);
      if(old?.deletedAt)return {inserted:false,updated:false,ignored:true,deleted:true,message:old,offers:[]};
      if(old&&(revisionAt<old.revisionAt||(revisionAt===old.revisionAt)||input.text===old.text))return {inserted:false,updated:false,ignored:true,deleted:false,message:old,offers:messageOffers(chatId,messageId)};
      const capturedAt=timestamp(input.capturedAt),value={...old,...input,chatId,messageId,id:old?.id??input.id??hash(`${chatId}\0${messageId}`),originalAt,messageAt:originalAt,capturedAt,revisionAt,text:input.text,originalText:old?.originalText??input.originalText??input.text,deletedAt:null};
      if(store.getSetting('buscasMonitorStartedAt',null)===null)store.setSetting('buscasMonitorStartedAt',capturedAt);
      prepared(`INSERT INTO buscas_messages(chatId,messageId,originalAt,capturedAt,revisionAt,deletedAt,senderId,forwarded,data) VALUES(?,?,?,?,?,NULL,?,?,?) ON CONFLICT(chatId,messageId)DO UPDATE SET capturedAt=excluded.capturedAt,revisionAt=excluded.revisionAt,senderId=excluded.senderId,forwarded=excluded.forwarded,data=excluded.data`).run(chatId,messageId,originalAt,capturedAt,revisionAt,value.senderId??value.senderJid??null,value.forwarded?1:0,encode(value));
      prepared('DELETE FROM buscas_offers WHERE chatId=? AND messageId=?').run(chatId,messageId);
      const saved=offers.map((raw,index)=>{
        const confidence=raw.confidence==='confirmed'?'confirmed':'review',supplierKey=raw.supplierKey??value.supplierKey??value.senderId??value.senderJid??null;
        const priceCents=optionalInt(raw.priceCents);
        if(priceCents!==null&&priceCents<0)throw new Error('Preço de oferta inválido.');
        const status=raw.unavailable?'unavailable':raw.status??'active';
        if(!['active','unavailable','deleted'].includes(status))throw new Error('Estado de oferta inválido.');
        const offer={...scoped(raw),id:raw.id??hash(`${chatId}\0${messageId}\0${index}`),chatId,groupId:chatId,messageId,messageAt:originalAt,originalAt,revisionAt,supplierKey,confidence,status,priceCents,storageGB:optionalInt(raw.storageGB),batteryPercent:optionalInt(raw.batteryPercent),originalExcerpt:raw.originalExcerpt??input.text};
        prepared(`INSERT INTO buscas_offers(id,chatId,messageId,messageAt,supplierKey,modelKey,storageGB,colorKey,condition,batteryPercent,priceCents,priceKind,confidence,status,productKey,fingerprint,data)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(identifier(offer.id),chatId,messageId,originalAt,supplierKey,offer.modelKey??null,offer.storageGB,offer.colorKey??null,offer.condition??null,offer.batteryPercent,priceCents,offer.priceKind??'unknown',confidence,status,offer.productKey??null,offer.fingerprint??null,encode(offer));
        return offer;
      });
      return {inserted:!old,updated:!!old,ignored:false,deleted:false,message:value,offers:saved};
    });
  }
  function deleteMessages(keys,at=Date.now()) {
    if(!Array.isArray(keys)||keys.length>1000)throw new Error('Lista de exclusões BUSCAS inválida.');
    return transaction(()=>{
      let count=0;const deletedAt=timestamp(at);
      for(const key of keys){
        const chatId=identifier(key.chatId??key.groupId??key.remoteJid),messageId=identifier(key.messageId??key.id),old=getMessage(chatId,messageId);
        if(old?.deletedAt)continue;
        const value={...old,id:old?.id??hash(`${chatId}\0${messageId}`),chatId,messageId,text:old?.text??'',originalText:old?.originalText??'',originalAt:old?.originalAt??deletedAt,capturedAt:old?.capturedAt??deletedAt,revisionAt:Math.max(old?.revisionAt??0,deletedAt),deletedAt};
        prepared(`INSERT INTO buscas_messages(chatId,messageId,originalAt,capturedAt,revisionAt,deletedAt,senderId,forwarded,data)VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(chatId,messageId)DO UPDATE SET revisionAt=excluded.revisionAt,deletedAt=excluded.deletedAt,data=excluded.data`).run(chatId,messageId,value.originalAt,value.capturedAt,value.revisionAt,deletedAt,value.senderId??null,value.forwarded?1:0,encode(value));
        for(const offer of messageOffers(chatId,messageId))prepared('UPDATE buscas_offers SET status=?,data=? WHERE id=?').run('deleted',encode({...offer,status:'deleted',deletedAt}),offer.id);
        count++;
      }return {count,deletedAt};
    });
  }
  function queryOffers(filters={}) {
    filters={...filters,minPriceCents:filters.minPriceCents??filters.priceMinCents,maxPriceCents:filters.maxPriceCents??filters.priceMaxCents,minBattery:filters.minBattery??filters.batteryMin,maxBattery:filters.maxBattery??filters.batteryMax};
    const where=[],params=[];
    if(!filters.includeReview){if(filters.confidence===undefined)where.push("o.confidence='confirmed'");where.push('o.priceCents IS NOT NULL AND o.priceCents>0');}
    if(!filters.includeUnavailable&&filters.status===undefined)where.push("o.status='active'");
    for(const [field,column,operator]of [['minPriceCents','priceCents','>='],['maxPriceCents','priceCents','<='],['minBattery','batteryPercent','>='],['maxBattery','batteryPercent','<=']])if(filters[field]!==undefined&&filters[field]!==null){where.push(`o.${column}${operator}?`);params.push(Number(filters[field]));}
    const textLike=value=>`%${foldText(String(value).slice(0,256)).replace(/[\\%_]/g,'\\$&')}%`;
    if(filters.supplierSearch){
      where.push(`buscas_fold_text(COALESCE(json_extract(o.data,'$.supplierName'),'') || ' ' || COALESCE(json_extract(o.data,'$.savedName'),'') || ' ' || COALESCE(json_extract(o.data,'$.displayName'),'') || ' ' || COALESCE(json_extract(o.data,'$.supplierPhone'),'') || ' ' || COALESCE(json_extract(o.data,'$.senderId'),'') || ' ' || COALESCE(o.supplierKey,'')) LIKE ? ESCAPE '\\'`);
      params.push(textLike(filters.supplierSearch));
    }
    if(filters.warranty){where.push(`buscas_fold_text(COALESCE(json_extract(o.data,'$.warranty'),'')) LIKE ? ESCAPE '\\'`);params.push(textLike(filters.warranty));}
    for(const [field,column]of [['excludedSupplierKeys','supplierKey'],['excludedGroupIds','chatId']])if(filters[field]?.length){if(!Array.isArray(filters[field])||filters[field].length>1000)throw new Error('Bloqueios BUSCAS inválidos.');where.push(`(o.${column} IS NULL OR o.${column} NOT IN(${filters[field].map(()=>'?').join(',')}))`);params.push(...filters[field]);}
    // A forwarded copy has no proven original supplier identity. When its exact
    // fingerprint is already attributed to a blocked supplier, hide the copy as
    // well, before pagination. Independent original sellers remain independent.
    if(filters.excludedSupplierKeys?.length){
      where.push(`(o.fingerprint IS NULL OR NOT (EXISTS(SELECT 1 FROM buscas_messages source WHERE source.chatId=o.chatId AND source.messageId=o.messageId AND source.forwarded=1) AND EXISTS(SELECT 1 FROM buscas_offers blocked WHERE blocked.fingerprint=o.fingerprint AND blocked.supplierKey IN(${filters.excludedSupplierKeys.map(()=>'?').join(',')}))))`);
      params.push(...filters.excludedSupplierKeys);
    }
    // A later unavailability announcement for the same unequivocal product also
    // invalidates an older price, rather than allowing that stale offer to rank.
    if(filters.latest||filters.latestPerProduct||filters.latestOnly){
      const hasTo=filters.to!==undefined&&filters.to!==null&&filters.to!=='',blocked=filters.excludedGroupIds?.length?filters.excludedGroupIds:[];
      where.push(`(o.productKey IS NULL OR o.supplierKey IS NULL OR NOT EXISTS(SELECT 1 FROM buscas_offers newer WHERE newer.supplierKey=o.supplierKey AND newer.productKey=o.productKey AND newer.confidence='confirmed' AND newer.status IN('active','unavailable') AND (newer.messageAt>o.messageAt OR (newer.messageAt=o.messageAt AND newer.rowid>o.rowid))${hasTo?' AND newer.messageAt<=?':''}${blocked.length?` AND newer.chatId NOT IN(${blocked.map(()=>'?').join(',')})`:''}))`);
      if(hasTo)params.push(timestamp(filters.to));
      if(blocked.length)params.push(...blocked);
    }
    const order=filters.order==='recent'?'o.messageAt DESC,o.rowid DESC':filters.order==='price-desc'?'o.priceCents DESC,o.messageAt DESC,o.rowid DESC':'o.priceCents ASC,o.messageAt DESC,o.rowid DESC';
    return page('buscas_offers',filters,{ids:'o.id',chatId:'o.chatId',groupId:'o.chatId',groupIds:'o.chatId',supplierKey:'o.supplierKey',supplierKeys:'o.supplierKey',modelKey:'o.modelKey',storageGB:'o.storageGB',colorKey:'o.colorKey',condition:'o.condition',confidence:'o.confidence',status:'o.status',priceKind:'o.priceKind',productKey:'o.productKey',fingerprint:'o.fingerprint'},where,params,order);
  }
  function saveAuthorization(value){value=scoped(value);return transaction(()=>{
    const id=identifier(value?.id),old=decode(prepared('SELECT data FROM buscas_authorizations WHERE id=?').get(id));
    const data={...old,...value,id,createdAt:old?.createdAt??timestamp(value.createdAt)},principalId=value.principalId??value.accountId??value.senderId??value.userId??null;
    prepared(`INSERT INTO buscas_authorizations(id,principalId,active,createdAt,data)VALUES(?,?,?,?,?) ON CONFLICT(id)DO UPDATE SET principalId=excluded.principalId,active=excluded.active,data=excluded.data`).run(id,principalId,value.active===false||value.enabled===false?0:1,data.createdAt,encode(data));return data;
  });}
  function saveRunRaw(value) {
    value=scoped(value);
    const id=identifier(value?.id),old=decode(prepared('SELECT data FROM buscas_runs WHERE id=?').get(id));
    if(old&&['chatId','messageId','userId','actorId'].some(key=>old[key]!==value[key]))throw new Error('A identidade operacional da busca não pode ser alterada.');
    const data={...old,...value,id,createdAt:old?.createdAt??timestamp(value.createdAt??value.requestedAt),status:value.status??'pending'};
    prepared(`INSERT INTO buscas_runs(id,chatId,messageId,userId,createdAt,status,data)VALUES(?,?,?,?,?,?,?) ON CONFLICT(id)DO UPDATE SET status=excluded.status,data=excluded.data`).run(id,data.chatId??null,data.messageId??null,data.userId??data.actorId??null,data.createdAt,data.status,encode(data));
    prepared(`INSERT INTO buscas_history(id,userId,chatId,createdAt,status,data)VALUES(?,?,?,?,?,?) ON CONFLICT(id)DO UPDATE SET status=excluded.status,data=excluded.data`).run(id,data.userId??data.actorId??null,data.chatId??null,data.createdAt,data.status,encode(data));return data;
  }
  function claimRun(value){return transaction(()=>{
    // Private account routes may legitimately change between PN and LID after
    // reconnect. Retain the real reply chat while reserving the command once
    // per central actor/message, including rows written by earlier revisions.
    if(['whatsapp-private','whatsapp-self'].includes(value?.source)&&value?.actorId&&value?.messageId){
      const old=decode(prepared("SELECT data FROM buscas_runs WHERE userId=? AND messageId=? AND json_extract(data,'$.source') IN ('whatsapp-private','whatsapp-self') LIMIT 1").get(identifier(value.actorId),identifier(value.messageId)));
      if(old)return {claimed:false,run:old};
    }
    if(value?.chatId&&value?.messageId){const old=decode(prepared('SELECT data FROM buscas_runs WHERE chatId=? AND messageId=?').get(identifier(value.chatId),identifier(value.messageId)));if(old)return {claimed:false,run:old};}
    if(value?.id){const old=decode(prepared('SELECT data FROM buscas_runs WHERE id=?').get(value.id));if(old)return {claimed:false,run:old};}
    return {claimed:true,run:saveRunRaw({...value,id:value.id??randomUUID()})};
  });}
  function saveDelivery(value){value=scoped(value);return transaction(()=>{
    const id=identifier(value?.id),old=decode(prepared('SELECT data FROM buscas_deliveries WHERE id=?').get(id)),data={...old,...value,id,createdAt:old?.createdAt??timestamp(value.createdAt)};
    if(!['pending','sending','confirmed','uncertain','failed','cancelled'].includes(data.status))throw new Error('Estado de entrega BUSCAS inválido.');
    if(old&&old.runId!==data.runId)throw new Error('A busca associada à entrega não pode ser alterada.');
    if(old?.status==='confirmed'&&data.status!=='confirmed')throw new Error('Uma entrega confirmada não pode voltar à fila.');
    if(old?.status==='uncertain'&&['pending','sending'].includes(data.status))throw new Error('Uma entrega incerta precisa de revisão.');
    prepared(`INSERT INTO buscas_deliveries(id,runId,status,createdAt,messageId,nextAttemptAt,data)VALUES(?,?,?,?,?,?,?) ON CONFLICT(id)DO UPDATE SET status=excluded.status,messageId=excluded.messageId,nextAttemptAt=excluded.nextAttemptAt,data=excluded.data`).run(id,identifier(data.runId),data.status,data.createdAt,data.messageId??null,timestamp(data.nextAttemptAt,0),encode(data));return data;
  });}
  const audit=(action,actor,detail)=>store.addAudit({actorId:typeof actor==='string'?actor:actor?.id??actor?.userId??null,actorName:actor?.name??null,action,detail,at:Date.now()});
  const api={
    upsertSearchMessage:upsertMessage,deleteSearchMessages:deleteMessages,getSearchMessage:getMessage,querySearchOffers:queryOffers,
    getSearchOffer:id=>decode(prepared('SELECT data FROM buscas_offers WHERE id=?').get(identifier(id))),
    updateSearchOffer(id,patch){return transaction(()=>{const old=api.getSearchOffer(id);if(!old)throw new Error('Oferta BUSCAS não encontrada.');if(['id','chatId','messageId','supplierKey','messageAt','originalAt'].some(key=>patch[key]!==undefined&&patch[key]!==old[key]))throw new Error('A identidade da oferta não pode ser alterada.');const data={...old,...patch,id},message=getMessage(old.chatId,old.messageId);if(message?.deletedAt&&data.status!=='deleted')throw new Error('Oferta de mensagem excluída não pode ser reativada.');if(!['active','unavailable','deleted'].includes(data.status)||!['confirmed','review'].includes(data.confidence))throw new Error('Estado de oferta inválido.');data.priceCents=optionalInt(data.priceCents);if(data.priceCents!==null&&data.priceCents<0)throw new Error('Preço de oferta inválido.');prepared('UPDATE buscas_offers SET modelKey=?,storageGB=?,colorKey=?,condition=?,batteryPercent=?,priceCents=?,priceKind=?,confidence=?,status=?,productKey=?,fingerprint=?,data=? WHERE id=?').run(data.modelKey??null,optionalInt(data.storageGB),data.colorKey??null,data.condition??null,optionalInt(data.batteryPercent),data.priceCents,data.priceKind??'unknown',data.confidence,data.status,data.productKey??null,data.fingerprint??null,encode(data),id);return data;});},
    listSearchMessages(filters={}){return page('buscas_messages',filters,{chatId:'chatId',groupIds:'chatId',messageId:'messageId',senderId:'senderId'},filters.includeDeleted?[]:['deletedAt IS NULL'],[],'originalAt DESC,rowid DESC');},
    saveSearchAuthorization:saveAuthorization,getSearchAuthorization:id=>decode(prepared('SELECT data FROM buscas_authorizations WHERE id=?').get(identifier(id))),
    findSearchAuthorization:principalId=>decode(prepared('SELECT data FROM buscas_authorizations WHERE principalId=?').get(identifier(principalId))),
    listSearchAuthorizations:filters=>page('buscas_authorizations',filters,{active:'active',principalId:'principalId',ids:'id'}),
    deleteSearchAuthorization:id=>transaction(()=>prepared('DELETE FROM buscas_authorizations WHERE id=?').run(identifier(id))),
    claimSearchRun:claimRun,saveSearchRun:value=>transaction(()=>saveRunRaw(value)),getSearchRun:id=>decode(prepared('SELECT data FROM buscas_runs WHERE id=?').get(identifier(id))),
    updateSearchRun(id,patch){const old=api.getSearchRun(id);if(!old)throw new Error('Busca não encontrada.');return transaction(()=>saveRunRaw({...old,...patch,id}));},
    listSearchRuns:filters=>page('buscas_runs',filters,{userId:'userId',actorId:'userId',chatId:'chatId',status:'status',statuses:'status'}),
    listSearchHistory:filters=>page('buscas_history',filters,{userId:'userId',actorId:'userId',chatId:'chatId',status:'status'}),
    saveSearchDelivery:saveDelivery,getSearchDelivery:id=>decode(prepared('SELECT data FROM buscas_deliveries WHERE id=?').get(identifier(id))),
    updateSearchDelivery(id,patch){const old=api.getSearchDelivery(id);if(!old)throw new Error('Entrega BUSCAS não encontrada.');return saveDelivery({...old,...patch,id});},
    listSearchDeliveries:filters=>page('buscas_deliveries',filters,{runId:'runId',status:'status',statuses:'status',messageId:'messageId'},filters?.dueAt===undefined?[]:['nextAttemptAt<=?'],filters?.dueAt===undefined?[]:[timestamp(filters.dueAt)],filters?.order==='recent'?'createdAt DESC,rowid DESC':'createdAt ASC,rowid ASC'),
    getSearchDeliverySummaries(runIds){
      if(!Array.isArray(runIds)||runIds.length>1000)throw new Error('Lote de buscas excede o limite.');
      const ids=[...new Set(runIds.map(id=>identifier(id,'Busca')))];if(!ids.length)return [];
      // Aggregate at the database boundary: no delivery text, protocol identity
      // or credentials are loaded into the history response, and no N+1 reads.
      const rows=prepared(`SELECT runId,COUNT(*) parts,
        SUM(status='pending') pending,SUM(status='sending') sending,
        SUM(status='confirmed') confirmed,SUM(status='uncertain') uncertain,
        SUM(status='failed') failed,SUM(status='cancelled') cancelled,
        json_group_array(DISTINCT json_extract(data,'$.target')) targets,
        MIN(createdAt) firstCreatedAt,
        MIN(CAST(json_extract(data,'$.submittedAt') AS INTEGER)) firstSubmittedAt,
        MAX(CAST(json_extract(data,'$.submittedAt') AS INTEGER)) lastSubmittedAt,
        MAX(CAST(json_extract(data,'$.resultAt') AS INTEGER)) lastResultAt
        FROM buscas_deliveries WHERE COALESCE(json_extract(data,'$.errorNotice'),0)=0 AND runId IN(${ids.map(()=>'?').join(',')}) GROUP BY runId`).all(...ids);
      return rows.map(row=>({runId:row.runId,parts:Number(row.parts),counts:Object.fromEntries(['pending','sending','confirmed','uncertain','failed','cancelled'].map(status=>[status,Number(row[status])])),targets:JSON.parse(row.targets).filter(target=>typeof target==='string'),firstCreatedAt:row.firstCreatedAt,firstSubmittedAt:row.firstSubmittedAt,lastSubmittedAt:row.lastSubmittedAt,lastResultAt:row.lastResultAt}));
    },
    recordSearchGap(value){value=scoped(value);return transaction(()=>{const id=identifier(value?.id??randomUUID()),old=decode(prepared('SELECT data FROM buscas_gaps WHERE id=?').get(id)),data={...old,...value,id,startedAt:old?.startedAt??timestamp(value.startedAt),endedAt:value.endedAt===null||value.endedAt===undefined?null:timestamp(value.endedAt)};prepared(`INSERT INTO buscas_gaps(id,startedAt,endedAt,chatId,data)VALUES(?,?,?,?,?) ON CONFLICT(id)DO UPDATE SET endedAt=excluded.endedAt,data=excluded.data`).run(id,data.startedAt,data.endedAt,data.chatId??null,encode(data));return data;});},
    listSearchGaps:filters=>page('buscas_gaps',filters,{chatId:'chatId'},[],[],'startedAt DESC,rowid DESC'),
    setSearchMonitorStarted:at=>store.setSetting('buscasMonitorStartedAt',timestamp(at)),
    getSearchMonitorStats(){const m=prepared('SELECT COUNT(*) messages,MAX(capturedAt) lastCapturedAt,MAX(originalAt) lastOriginalAt,COALESCE(SUM(deletedAt IS NOT NULL),0) deleted FROM buscas_messages').get(),o=prepared("SELECT COUNT(*) offers,COALESCE(SUM(confidence='review' AND status='active'),0) review,COALESCE(SUM(confidence='confirmed' AND status='active'),0) confirmed FROM buscas_offers").get(),inbox=prepared("SELECT COUNT(*) n,COALESCE(SUM(status IN('queued','pending')),0) queued,COALESCE(SUM(status='failed'),0) failed FROM buscas_inbox").get(),gap=prepared('SELECT COUNT(*) totalGaps,COALESCE(SUM(endedAt IS NULL),0) openGaps FROM buscas_gaps').get(),history=prepared('SELECT COUNT(*) n FROM buscas_history').get();const groups=prepared('SELECT chatId,COUNT(*) messages,MAX(capturedAt) lastCapturedAt,MAX(originalAt) lastOriginalAt FROM buscas_messages GROUP BY chatId ORDER BY lastCapturedAt DESC LIMIT 500').all();return {...m,...o,...gap,totalMessages:Number(m.messages),totalOffers:Number(o.offers),history:Number(history.n),startedAt:store.getSetting('buscasMonitorStartedAt',null),inbox:Number(inbox.n),queued:Number(inbox.queued),failedInbox:Number(inbox.failed),groups,gaps:api.listSearchGaps({limit:20}).items};},
    enqueueSearchInbox(value,{maximum=10000}={}){value=scoped(value);return transaction(()=>{const id=identifier(value?.id??hash(encode(value))),old=prepared('SELECT 1 FROM buscas_inbox WHERE id=?').get(id);if(old)return {enqueued:false,duplicate:true,id};const count=Number(prepared('SELECT COUNT(*) n FROM buscas_inbox').get().n);if(count>=limit(maximum,10000,100000))return {enqueued:false,full:true,id,count};const data={...value,id,status:value.status??'pending',createdAt:timestamp(value.createdAt)};prepared('INSERT INTO buscas_inbox(id,status,createdAt,data)VALUES(?,?,?,?)').run(id,data.status,data.createdAt,encode(data));return {enqueued:true,id,count:count+1};});},
    getSearchInboxCount:()=>Number(prepared('SELECT COUNT(*) n FROM buscas_inbox').get().n),
    listSearchInbox:filters=>page('buscas_inbox',filters,{status:'status'},[],[],'createdAt ASC,rowid ASC'),
    updateSearchInbox(id,patch){return transaction(()=>{const old=decode(prepared('SELECT data FROM buscas_inbox WHERE id=?').get(identifier(id)));if(!old)throw new Error('Captura BUSCAS não encontrada.');const data={...old,...patch,id};prepared('UPDATE buscas_inbox SET status=?,data=? WHERE id=?').run(data.status,encode(data),id);return data;});},
    deleteSearchInbox:id=>transaction(()=>prepared('DELETE FROM buscas_inbox WHERE id=?').run(identifier(id))),
    deleteSearchHistory({actor}={}){return transaction(()=>{const count=Number(prepared('SELECT COUNT(*) n FROM buscas_history').get().n);prepared('DELETE FROM buscas_history').run();const record=audit('buscas.history.clear',actor,{count,preserved:'messages, offers, command dedupe ledger and delivery ledger'});return {count,auditId:record.id};});},
    deleteSearchBase({actor}={}){return transaction(()=>{const messages=Number(prepared('SELECT COUNT(*) n FROM buscas_messages').get().n),offers=Number(prepared('SELECT COUNT(*) n FROM buscas_offers').get().n);prepared('DELETE FROM buscas_offers').run();prepared('DELETE FROM buscas_messages').run();prepared('DELETE FROM buscas_inbox').run();const record=audit('buscas.base.clear',actor,{messages,offers,preserved:'campaigns, settings, users, search history and operational ledgers'});return {messages,offers,auditId:record.id};});},
    applySearchRetention({days=30,at,now,maxMessages=100000,historyDays=90}={}){return transaction(()=>{const currentAt=timestamp(at??now),cutoff=currentAt-limit(days,30,3650)*86400000,historyCutoff=currentAt-limit(historyDays,90,3650)*86400000;let removed=0;const erase=rows=>{for(const row of rows){prepared('DELETE FROM buscas_offers WHERE chatId=? AND messageId=?').run(row.chatId,row.messageId);removed+=Number(prepared('DELETE FROM buscas_messages WHERE chatId=? AND messageId=?').run(row.chatId,row.messageId).changes);}};if(days)erase(prepared('SELECT chatId,messageId FROM buscas_messages WHERE originalAt<? LIMIT 1000').all(cutoff));if(maxMessages)erase(prepared('SELECT chatId,messageId FROM buscas_messages ORDER BY originalAt DESC,rowid DESC LIMIT 1000 OFFSET ?').all(limit(maxMessages,100000,1000000)));if(historyDays)prepared('DELETE FROM buscas_history WHERE createdAt<?').run(historyCutoff);return {removed};});}
  };
  // Singular aliases keep call sites consistent with the existing alert store.
  api.listSearchAuthorization=api.listSearchAuthorizations;
  api.querySearchMessages=api.listSearchMessages;
  api.listSearchRun=api.listSearchRuns;
  api.listSearchDelivery=api.listSearchDeliveries;
  api.listSearchGap=api.listSearchGaps;
  Object.assign(store,api);
  return store;
}

module.exports={createSearchSchema,attachSearchStore};
