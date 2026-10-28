'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { generateSearchExcel, offerRow, excelLocalDate } = require('../src/core/search-excel.cjs');

const at = Date.parse('2026-10-06T15:30:10-03:00');
const offer = { model: 'iPhone 15 Pro Max', storageGB: 256, color: 'Azul', condition: 'seminovo', batteryPercent: 85, priceCents: 385099, priceKind: 'cash', supplierName: '=Fornecedor não é fórmula', supplierPhone: '5562999991234', contactInOffer: '+55 (62) 98888-4321', groupName: 'Lojistas reais de teste', originalAt: at, snippet: 'iPhone 15 Pro Max 256GB Azul seminovo R$ 3.850,99' };
function directory(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kenned-excel-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('writes genuine XLSX numeric BRL/text phones, frozen headers, filters, local original time and metadata', async t => {
  const dir = directory(t), file = await generateSearchExcel({ offers: [offer], directory: dir, metadata: { generatedAt: at + 5000, timezone: 'America/Sao_Paulo', query: 'iPhone 15 Pro Max 256GB', filters: { storageGB: 256 }, period: { from: at - 7200000, to: at }, selection: 'selected', traceId: 'TEST-EXCEL' } });
  assert.equal(fs.readFileSync(file.path).subarray(0, 4).toString('hex'), '504b0304'); assert.equal(file.count, 1); assert.match(file.name, /Kenned-Code-Ofertas.*\.xlsx$/); assert.match(file.sha256, /^[a-f0-9]{64}$/);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file.path); const sheet = workbook.getWorksheet('Ofertas');
  assert.equal(sheet.rowCount, 2); assert.equal(sheet.getCell('H2').value, 3850.99); assert.match(sheet.getCell('H2').numFmt, /R\$/);
  assert.equal(sheet.getCell('K2').value, offer.supplierPhone); assert.equal(sheet.getCell('K2').type, ExcelJS.ValueType.String); assert.equal(sheet.getCell('K2').numFmt, '@');
  assert.equal(sheet.getCell('L2').value, offer.contactInOffer); assert.equal(sheet.getCell('J2').value, offer.supplierName); assert.equal(sheet.getCell('J2').type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell('B2').value, null); assert.equal(sheet.getCell('C2').value, null); assert.equal(sheet.getCell('N2').value.toISOString(), '2026-10-06T15:30:10.000Z');
  assert.equal(sheet.views[0].state, 'frozen'); assert.equal(sheet.views[0].ySplit, 1); assert.equal(sheet.autoFilter, 'A1:P2'); assert.ok(sheet.columns[0].width >= 20);
  const info = workbook.getWorksheet('Informações'); const values = info.getColumn(2).values.filter(Boolean).join('\n'); assert.match(values, /America\/Sao_Paulo/); assert.match(values, /storageGB/); assert.match(values, /Ofertas selecionadas/); assert.match(values, /TEST-EXCEL/);
});

test('streams more than one query page without truncation and preserves caller ordering', async t => {
  const dir = directory(t); async function* offers() { for (let i = 0; i < 1203; i++) yield { ...offer, priceCents: 700000 - i }; }
  const file = await generateSearchExcel({ offers: offers(), directory: dir, metadata: { timezone: 'America/Sao_Paulo', order: 'cashDescending', generatedAt: at } });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file.path); const sheet = workbook.getWorksheet('Ofertas');
  assert.equal(file.count, 1203); assert.equal(sheet.rowCount, 1204); assert.equal(sheet.getCell('H2').value, 7000); assert.equal(sheet.getCell('H1204').value, 6987.98); assert.equal(sheet.autoFilter, 'A1:P1204');
});

test('does not invent category RAM phone or unknown prices; keeps forwarded attribution separate', () => {
  const row = offerRow({ model: 'Samsung S24 Ultra', supplierPhone: '12345678901234@lid', priceCents: null, forwarded: true, contactRaw: '(62) 98888-4321' }, 'America/Sao_Paulo');
  assert.equal(row.category, ''); assert.equal(row.ramGB, ''); assert.equal(row.supplierPhone, ''); assert.equal(row.price, ''); assert.equal(row.contactInOffer, '(62) 98888-4321'); assert.match(row.forwarded, /republicador/); assert.equal(row.publishedAt, null);
  assert.equal(excelLocalDate(at, 'America/Sao_Paulo').toISOString(), '2026-10-06T15:30:10.000Z');
});

test('worker generation failure does not leave a document marked as completed', async t => {
  const dir = directory(t); async function* broken() { yield offer; throw new Error('Falha de captura durante exportação'); }
  await assert.rejects(generateSearchExcel({ offers: broken(), directory: dir }), /Falha de captura/); assert.equal(fs.readdirSync(dir).length, 0);
});

test('actual backend-worker nesting can generate XLSX without requiring Electron main thread', async t => {
  const { Worker } = require('node:worker_threads'); const dir = directory(t), modulePath = require.resolve('../src/core/search-excel.cjs');
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); require(workerData.modulePath).generateSearchExcel({ offers: workerData.offers, directory: workerData.directory, metadata: { timezone: 'America/Sao_Paulo' } }).then(result => parentPort.postMessage(result)).catch(error => { parentPort.postMessage({ error: error.message }); });`, { eval: true, workerData: { modulePath, directory: dir, offers: [offer] } });
    worker.once('message', value => { if (value.error) reject(new Error(value.error)); else resolve(value); }); worker.once('error', reject);
  });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(result.path); assert.equal(workbook.getWorksheet('Ofertas').getCell('H2').value, 3850.99);
});
