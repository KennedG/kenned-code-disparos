'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_ROWS = 1_048_575; // Excel's physical worksheet limit, never a hidden query limit.
const COLUMNS = [
  ['Modelo', 'model', 29], ['Categoria', 'category', 19], ['RAM (GB)', 'ramGB', 13],
  ['Armazenamento (GB)', 'storageGB', 23], ['Cor', 'color', 22], ['Condição', 'condition', 17],
  ['Bateria (%)', 'batteryPercent', 15], ['Preço anunciado (R$)', 'price', 24],
  ['Tipo de preço', 'priceKind', 23], ['Fornecedor / republicador', 'supplierName', 32],
  ['Telefone do remetente', 'supplierPhone', 25], ['Contato informado na oferta', 'contactInOffer', 31],
  ['Grupo de origem', 'groupName', 33], ['Data e horário original', 'publishedAt', 29],
  ['Observações', 'observations', 56], ['Encaminhada', 'forwarded', 17]
];
function textCell(value, max = 32767) { return value == null ? '' : String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, max); }
function realPhone(value) { return typeof value === 'string' && /^[1-9]\d{9,14}$/.test(value) ? value : ''; }
function excelLocalDate(value, timezone) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(value).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
}
function offerRow(offer, timezone) {
  return {
    model: textCell(offer.model || offer.modelName || offer.modelKey), category: textCell(offer.category),
    ramGB: Number.isFinite(offer.ramGB) && offer.ramGB > 0 ? offer.ramGB : '',
    storageGB: Number.isFinite(offer.storageGB) && offer.storageGB > 0 ? offer.storageGB : '',
    color: textCell(offer.color || offer.colorName || offer.colorKey), condition: textCell(offer.condition),
    batteryPercent: Number.isFinite(offer.batteryPercent) && offer.batteryPercent >= 0 && offer.batteryPercent <= 100 ? offer.batteryPercent : '',
    price: Number.isSafeInteger(offer.priceCents) && offer.priceCents > 0 ? offer.priceCents / 100 : '',
    priceKind: textCell(offer.priceKind === 'cash' ? 'Total à vista' : offer.priceKind === 'from' ? 'A partir de' : offer.priceKind === 'lot' ? 'Exclusivo para lote' : offer.priceKind),
    supplierName: textCell(offer.savedName && offer.displayName && offer.savedName !== offer.displayName ? `${offer.savedName} (WhatsApp: ${offer.displayName})` : offer.supplierName || offer.displayName || offer.savedName),
    supplierPhone: realPhone(offer.supplierPhone), contactInOffer: textCell(offer.contactInOffer || offer.contactRaw || offer.contactPhone || offer.offerPhone),
    groupName: textCell(offer.groupName || offer.groupId), publishedAt: excelLocalDate(offer.originalAt || offer.messageAt, timezone),
    observations: textCell([offer.warranty, offer.priceQualifier, offer.minPurchase ? `Compra mínima: ${offer.minPurchase}` : null, offer.snippet || offer.originalExcerpt || offer.notes].filter(Boolean).join('\n')),
    forwarded: offer.forwarded ? 'Sim — remetente é republicador; fornecedor original não comprovado' : 'Não'
  };
}
async function generateSearchExcel({ offers, directory, metadata = {}, onProgress }) {
  if (workerData?.searchExcelWriter) throw new Error('O gravador do Excel não pode iniciar outra exportação.');
  if (!directory || (!Array.isArray(offers) && !offers?.[Symbol.asyncIterator] && !offers?.[Symbol.iterator])) throw new Error('Ofertas ou destino da exportação inválidos.');
  const timezone = metadata.timezone || 'America/Sao_Paulo'; new Intl.DateTimeFormat('pt-BR', { timeZone: timezone }).format();
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const exportId = randomUUID(), day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(metadata.generatedAt || Date.now());
  const name = `Kenned-Code-Ofertas-${day}-${exportId.slice(0, 8)}.xlsx`, filename = path.join(directory, name), temporary = `${filename}.tmp`;
  const worker = new Worker(__filename, { workerData: { searchExcelWriter: true, filename: temporary, metadata: { ...metadata, timezone }, columns: COLUMNS } });
  let nextId = 0, fatal, count = 0; const pending = new Map();
  const rejectAll = error => { fatal = error; for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  worker.on('message', result => { const entry = pending.get(result.id); if (!entry) return; pending.delete(result.id); result.error ? entry.reject(Object.assign(new Error(result.error.message), { code: result.error.code || 'SEARCH_EXCEL_ERROR' })) : entry.resolve(result); });
  worker.on('error', rejectAll); worker.on('exit', code => { if (code !== 0) rejectAll(Object.assign(new Error('A geração do Excel foi interrompida.'), { code: 'SEARCH_EXCEL_WORKER_STOPPED' })); });
  const send = (type, data = {}) => new Promise((resolve, reject) => { if (fatal) return reject(fatal); const id = ++nextId; pending.set(id, { resolve, reject }); worker.postMessage({ id, type, ...data }); });
  try {
    await send('ready'); let batch = [];
    for await (const offer of offers) {
      if (++count > MAX_ROWS) throw Object.assign(new Error('A pesquisa excede o limite físico de linhas do Excel. Restrinja os filtros e exporte novamente; nenhum resultado foi truncado.'), { code: 'SEARCH_EXCEL_ROW_LIMIT' });
      batch.push(offerRow(offer, timezone));
      if (batch.length === 100) { await send('rows', { rows: batch }); batch = []; onProgress?.(count); }
    }
    if (batch.length) await send('rows', { rows: batch });
    await send('finish', { count }); await worker.terminate();
    const stat = await fs.promises.stat(temporary);
    if (!stat.isFile() || stat.size < 1024 || stat.size > 64 * 1024 * 1024) throw Object.assign(new Error('O Excel não foi gerado ou excede o limite de documento de 64 MB da integração.'), { code: 'SEARCH_EXCEL_FILE_SIZE' });
    const signature = Buffer.alloc(4), handle = await fs.promises.open(temporary, 'r'); try { await handle.read(signature, 0, 4, 0); } finally { await handle.close(); }
    if (signature.toString('hex') !== '504b0304') throw new Error('O arquivo gerado não é um documento XLSX válido.');
    const digest = createHash('sha256'); for await (const bytes of fs.createReadStream(temporary)) digest.update(bytes);
    const durable = await fs.promises.open(temporary, 'r+'); try { await durable.sync(); } finally { await durable.close(); }
    await fs.promises.chmod(temporary, 0o600); await fs.promises.rename(temporary, filename);
    return { id: exportId, name, path: filename, mime: MIME, type: 'document', size: stat.size, sha256: digest.digest('hex'), count, generatedAt: metadata.generatedAt || Date.now() };
  } catch (error) { await worker.terminate().catch(() => {}); await fs.promises.unlink(temporary).catch(() => {}); await fs.promises.unlink(filename).catch(() => {}); throw error; }
}

if (!isMainThread && workerData?.searchExcelWriter) {
  const ExcelJS = require('exceljs');
  const metadata = workerData.metadata, workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: workerData.filename, useStyles: true, useSharedStrings: false });
  workbook.creator = 'Kenned Code Disparos'; workbook.created = new Date(metadata.generatedAt || Date.now());
  const sheet = workbook.addWorksheet('Ofertas', { views: [{ state: 'frozen', ySplit: 1 }], properties: { defaultRowHeight: 21 } });
  sheet.columns = workerData.columns.map(([header, key, width]) => ({ header, key, width }));
  const first = sheet.getRow(1); first.font = { bold: true, color: { argb: 'FFFFFFFF' } }; first.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF173753' } }; first.height = 25; first.commit();
  sheet.getColumn('price').numFmt = '"R$" #,##0.00'; sheet.getColumn('publishedAt').numFmt = 'dd/mm/yyyy hh:mm:ss';
  sheet.getColumn('supplierPhone').numFmt = '@'; sheet.getColumn('contactInOffer').numFmt = '@';
  let tail = Promise.resolve();
  parentPort.on('message', message => { tail = tail.then(async () => {
    if (message.type === 'rows') { for (const raw of message.rows) { if (raw.publishedAt) raw.publishedAt = new Date(raw.publishedAt); const row = sheet.addRow(raw); row.alignment = { vertical: 'top', wrapText: true }; row.commit(); } }
    else if (message.type === 'finish') {
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, message.count + 1), column: workerData.columns.length } }; sheet.commit();
      const info = workbook.addWorksheet('Informações', { views: [{ state: 'frozen', ySplit: 1 }] }); info.columns = [{ header: 'Informação', key: 'key', width: 28 }, { header: 'Valor', key: 'value', width: 95 }]; info.getRow(1).font = { bold: true }; info.getRow(1).commit();
      const rows = [['Gerado em', new Date(metadata.generatedAt || Date.now()).toLocaleString('pt-BR', { timeZone: metadata.timezone })], ['Fuso dos horários', metadata.timezone], ['Busca', metadata.query || ''], ['Escopo', metadata.selection === 'selected' ? 'Ofertas selecionadas' : metadata.selection === 'command' ? 'Resultados do comando privado, respeitando o limite de BUSCAS' : 'Todos os resultados filtrados'], ['Quantidade de ofertas', message.count], ['Limite do comando', metadata.resultLimit || 'Não se aplica à exportação completa'], ['Ordenação', metadata.order === 'recent' ? 'Oferta mais recente' : metadata.order === 'cashDescending' ? 'Maior preço' : 'Menor preço'], ['Filtros utilizados', JSON.stringify(metadata.filters || {})], ['Período consultado', JSON.stringify(metadata.period || {})], ['Rastreamento', metadata.traceId || ''], ['Avisos', (metadata.warnings || []).join('\n')], ['Informações ausentes', 'Células vazias indicam informações não identificadas; nenhum dado foi inventado.'], ['Telefones', 'Telefone do remetente e contato informado no anúncio são separados. Identificadores internos não são telefones.'], ['Condições', 'Valores conforme anúncios capturados. Confirme disponibilidade e condições com o fornecedor.']];
      for (const [key, value] of rows) { const row = info.addRow({ key, value: textCell(value) }); row.alignment = { wrapText: true, vertical: 'top' }; row.commit(); }
      info.commit(); await workbook.commit();
    }
    parentPort.postMessage({ id: message.id, ok: true });
  }).catch(error => { parentPort.postMessage({ id: message.id, error: { message: error.message, code: error.code } }); }); });
}
module.exports = { generateSearchExcel, offerRow, excelLocalDate, MIME, COLUMNS };
