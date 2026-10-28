'use strict';

const { randomUUID, createHash } = require('node:crypto');

const METHODS = ['cash', 'pix', 'debit', 'credit'];
const LIMIT = 1_000_000_000_000;
function fail(message, code = 'FINANCE_VALIDATION') { const error = new Error(message); error.code = code; return error; }
function money(value, field, nullable = false) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > LIMIT) throw fail(`${field}: informe um valor em centavos inteiros, não negativo.`);
  return value;
}
function sum(values) { const result = values.reduce((a, b) => a + b, 0); if (!Number.isSafeInteger(result) || Math.abs(result) > LIMIT) throw fail('O total excede o limite financeiro seguro.'); return result; }
function allocation(total, units, quantity) { return Number(BigInt(total) * BigInt(units) / BigInt(quantity)); }
function qty(value = 1) { if (!Number.isInteger(value) || value < 1 || value > 1_000_000) throw fail('Informe uma quantidade inteira entre 1 e 1.000.000.'); return value; }
function text(value, limit = 500, required = false) { const result = String(value ?? '').trim(); if ((required && !result) || result.length > limit || /[\x00]/.test(result)) throw fail(`Texto inválido ou maior que ${limit} caracteres.`); return result; }
function epoch(value, fallback) { if (value === undefined || value === null || value === '') return fallback; const result = typeof value === 'number' ? value : Date.parse(value); if (!Number.isFinite(result) || result < Date.UTC(2000, 0, 1) || result > Date.UTC(2201, 0, 1)) throw fail('Data e hora inválidas. Use uma data ISO com fuso.'); if (typeof value === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) throw fail('A data e hora precisa informar o fuso.'); return result; }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])); return value; }
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function dateKey(at, timezone = 'America/Sao_Paulo') { try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); } catch { throw fail('Fuso horário inválido.'); } }
function validDay(day) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day) throw fail('Informe uma data válida no formato AAAA-MM-DD.'); return day; }
function publicInventory(item) {
  const { costCents, costBasisTotalCents, supplierId, imei, serial, notes, acquisitionReference, ...publicData } = item;
  return publicData;
}

class CommerceFinance {
  constructor({ store, now = () => Date.now() } = {}) { if (!store) throw fail('Banco de dados obrigatório.'); this.store = store; this.now = now; }
  _get(table, id) { return this.store.getEntity(table, id); }
  _list(table, filter = {}) { return this.store.listEntities(table, filter); }
  _save(table, row) { return this.store.saveEntity(table, row); }
  _mode() { return this.store.getStorageMode?.() || 'whatsapp'; }
  _event(type, subjectId, actorId, details = {}) { const row = { id: randomUUID(), kind: type, subjectId, actorId, userId: actorId, createdAt: this.now(), ...details }; this._save('sale_events', row); this.store.addAudit?.({ action: `commerce.${type}`, subjectId, actorId, userId: actorId, at: row.createdAt, financialDetailsRestricted:true }); return row; }
  _operation(type, input, actorId, work) {
    const key = text(input?.idempotencyKey, 200, true);
    const id = `operation:${this._mode()}:${digest([type, key])}`, fingerprint = digest({ type, input, actorId: actorId || null });
    return this.store.transaction(() => {
      const previous = this._get('sale_events', id);
      if (previous) { if (previous.fingerprint !== fingerprint) throw fail('Esta operação já foi registrada com dados diferentes. Abra uma nova operação.', 'IDEMPOTENCY_CONFLICT'); return previous.result; }
      const result = work();
      this._save('sale_events', { id, kind: 'operation', operation: type, fingerprint, actorId, userId: actorId, createdAt: this.now(), result });
      return result;
    });
  }
  _inventory(id) { const item = this._get('inventory', id); if (!item || item.archived) throw fail('Produto não encontrado no estoque.', 'STOCK_NOT_FOUND'); return item; }
  _sale(id) { const sale = this._get('sales', id); if (!sale) throw fail('Venda não encontrada.', 'SALE_NOT_FOUND'); return sale; }
  _version(sale, input) { if (input.expectedVersion !== undefined && input.expectedVersion !== sale.version) throw fail('A venda foi alterada em outra operação. Atualize a tela antes de continuar.', 'SALE_VERSION_CONFLICT'); }
  _buyer(id) { if (id && !this._get('contacts', id)) throw fail('Comprador não encontrado no cadastro de contatos.', 'BUYER_NOT_FOUND'); }
  _activeReservations(id, at = this.now()) { return this._list('reservations').filter(r => r.inventoryId === id && r.status === 'active' && r.expiresAt > at); }
  _enrichStock(item) { const reservedQuantity = sum(this._activeReservations(item.id).map(r => r.quantity)); return { ...item, reservedQuantity, availableQuantity: Math.max(0, item.quantity - reservedQuantity), status: item.quantity === 0 ? 'sold' : reservedQuantity >= item.quantity ? 'reserved' : 'available' }; }
  _saveStock(item) { const costBasisTotalCents = item.costBasisTotalCents === undefined ? item.costCents === null ? null : money(item.costCents * item.quantity, 'Custo do estoque') : item.costBasisTotalCents; const costCents = item.quantity>0&&costBasisTotalCents!==null?Math.round(costBasisTotalCents/item.quantity):item.costCents; return this.store.saveEntity('inventory', { ...this._enrichStock(item), costCents,costBasisTotalCents, updatedAt: this.now() }); }
  getInventory(id) { return this._enrichStock(this._inventory(id)); }
  listInventory({ financial = true } = {}) { const reserved = new Map(); for (const r of this._list('reservations')) if(r.status === 'active' && r.expiresAt > this.now()) reserved.set(r.inventoryId, (reserved.get(r.inventoryId) || 0) + r.quantity); const items = this._list('inventory').filter(item => !item.archived).map(item => { const reservedQuantity = reserved.get(item.id) || 0; return {...item,reservedQuantity,availableQuantity:Math.max(0,item.quantity-reservedQuantity),status:item.quantity===0?'sold':reservedQuantity>=item.quantity?'reserved':'available'}; }); return financial ? items : items.map(publicInventory); }
  listSuppliers() { return this._list('suppliers'); }
  listPurchases() { return this._list('purchases'); }
  listReservations() {
    const reservations = this._list('reservations'), payments = new Map(), refunds = new Map();
    for (let offset = 0; offset < reservations.length; offset += 250) {
      const rows = reservations.slice(offset, offset + 250);
      for (const p of this._list('sale_payments', { reservationIds: rows.map(r => r.id) })) {
        payments.set(p.id, p);
        if (p.direction === 'out') refunds.set(p.reservationId, sum([refunds.get(p.reservationId) || 0, p.amountCents]));
      }
      const missing = rows.map(r => r.paymentId).filter(id => id && !payments.has(id));
      if (missing.length) for (const p of this._list('sale_payments', { ids: missing })) payments.set(p.id, p);
    }
    return reservations.map(r => { const deposit = payments.get(r.paymentId), refundedDepositCents = refunds.get(r.id) || 0; return { ...r, depositMethod: deposit?.method || null, refundedDepositCents, refundedCents: refundedDepositCents, depositPendingRefundCents: ['released', 'expired'].includes(r.status) ? Math.max(0, r.depositCents - refundedDepositCents) : 0 }; });
  }
  _salesWithPayments(sales) {
    const bySale = new Map();
    for (let offset = 0; offset < sales.length; offset += 250) for (const p of this._list('sale_payments', { saleIds: sales.slice(offset, offset + 250).map(s => s.id) })) {
      if (!bySale.has(p.saleId)) bySale.set(p.saleId, []);
      bySale.get(p.saleId).push(p);
    }
    return sales.map(s => this._saleTotals(s, bySale.get(s.id) || []));
  }
  listSales(filter = {}) { return this._salesWithPayments(this._list('sales', filter)); }
  snapshot({ financial = false } = {}) {
    const salesPage = financial ? this.store.queryEntities('sales', { limit: 250 }) : null, movementsPage = financial ? this.store.queryEntities('cash_movements', { limit: 500 }) : null;
    return { inventory: this.listInventory({ financial }), suppliers: financial ? this.listSuppliers() : [], purchases: financial ? this.listPurchases() : [], reservations: financial ? this.listReservations() : [], sales: salesPage ? this._salesWithPayments(salesPage.items) : [], cashSessions: financial ? this._list('cash_sessions').map(s => this._cashTotals(s)) : [], cashMovements: movementsPage?.items || [], historyWindow: financial ? { sales: { total: salesPage.total, shown: salesPage.items.length, limit: salesPage.limit }, cashMovements: { total: movementsPage.total, shown: movementsPage.items.length, limit: movementsPage.limit }, note: 'Esta tela mostra as 250 vendas e 500 movimentações mais recentes. Relatórios diários e por período incluem todos os registros.' } : null };
  }
  saveInventory(input, actorId) {
    if (!input || typeof input !== 'object') throw fail('Informe os dados do produto.');
    return this.store.transaction(() => {
      const old = input.id ? this._get('inventory', input.id) : null, data = { ...old, ...input };
      if (input.id && !old) throw fail('Produto não encontrado.');
      const kind = data.kind || 'device'; if (!['device', 'accessory'].includes(kind)) throw fail('Tipo de produto inválido.');
      const quantity = data.quantity ?? (kind === 'device' ? 1 : 0);
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1_000_000 || kind === 'device' && quantity > 1) throw fail('Aparelhos são individuais; acessórios usam quantidade inteira.');
      if (old && quantity !== old.quantity) throw fail('Altere quantidades por uma entrada, venda ou devolução registrada, preservando o histórico.', 'STOCK_QUANTITY_LEDGER_REQUIRED');
      const mediaIds = [...new Set(data.mediaIds || [])]; if (mediaIds.some(id => !this.store.getMedia(id))) throw fail('Uma foto selecionada não está disponível na biblioteca.');
      if (data.supplierId && !this._get('suppliers', data.supplierId)) throw fail('Fornecedor não encontrado.');
      const row = { id: old?.id || randomUUID(), kind, model: text(data.model || data.name, 150, true), storage: text(data.storage, 80), color: text(data.color, 80), condition: text(data.condition, 80), quantity,
        costCents: money(data.costCents, 'Custo', true), retailCents: money(input.retailCents ?? input.retailPriceCents ?? data.retailCents ?? data.retailPriceCents ?? 0, 'Preço de varejo'), wholesaleCents: money(input.wholesaleCents ?? input.wholesalePriceCents ?? data.wholesaleCents ?? data.wholesalePriceCents ?? 0, 'Preço de atacado'),
        supplierId: data.supplierId || null, mediaIds, imei: text(data.imei, 80), serial: text(data.serial, 100), battery: data.battery == null || data.battery === '' ? null : Number(data.battery), warranty: text(data.warranty, 500), notes: text(data.notes, 3000),
        entryAt: epoch(data.entryAt, old?.entryAt || this.now()), createdAt: old?.createdAt || this.now(), createdBy: old?.createdBy || actorId, updatedBy: actorId, archived: false };
      if (row.battery !== null && (!Number.isFinite(row.battery) || row.battery < 0 || row.battery > 100)) throw fail('Saúde da bateria deve ficar entre 0% e 100%.');
      if (row.imei || row.serial) for (const other of this._list('inventory')) if (other.id !== row.id && (row.imei && other.imei === row.imei || row.serial && other.serial === row.serial)) throw fail('IMEI ou número de série já cadastrado.', 'STOCK_IDENTIFIER_DUPLICATE');
      row.retailPriceCents = row.retailCents; row.wholesalePriceCents = row.wholesaleCents;
      row.costBasisTotalCents = old && (input.costCents === undefined || input.costCents === old.costCents) ? old.costBasisTotalCents : row.costCents === null ? null : money(row.costCents * quantity, 'Custo do estoque');
      const saved = this._saveStock(row);
      this._event(old ? 'inventory.edited' : 'inventory.created', saved.id, actorId, { quantity, supplierId: row.supplierId,previousCostBasisTotalCents:old?.costBasisTotalCents??null,costBasisTotalCents:saved.costBasisTotalCents });
      return saved;
    });
  }
  archiveInventory({ id, reason }, actorId) {
    return this.store.transaction(() => { const row = this._inventory(id); if (row.quantity > 0 || this._activeReservations(id).length) throw fail('Somente um item sem quantidade e sem reservas pode ser arquivado.'); const result = this._save('inventory', { ...row, archived: true, archiveReason: text(reason, 500, true), updatedAt: this.now() }); this._event('inventory.archived', id, actorId, { reason: result.archiveReason }); return result; });
  }
  saveSupplier(input, actorId) {
    return this.store.transaction(() => {
      const old = input.id ? this._get('suppliers', input.id) : null; if (input.id && !old) throw fail('Fornecedor não encontrado.');
      const data = { ...old, ...input }, phone = String(data.phone || '').replace(/[+ ()-]/g, '');
      if (!/^[1-9]\d{7,14}$/.test(phone)) throw fail('Informe o WhatsApp do fornecedor com código do país e DDD.');
      const row = { id: old?.id || randomUUID(), name: text(data.name, 150, true), phone, categories: [...new Set((data.categories || []).map(v => text(v, 100, true)))], paymentTerms: text(data.paymentTerms, 1000), warranty: text(data.warranty, 1000), deliveryDays: data.deliveryDays == null || data.deliveryDays === '' ? null : Number(data.deliveryDays), notes: text(data.notes, 3000), active: data.active !== false, createdAt: old?.createdAt || this.now(), updatedAt: this.now(), updatedBy: actorId };
      if (row.deliveryDays !== null && (!Number.isInteger(row.deliveryDays) || row.deliveryDays < 0 || row.deliveryDays > 3650)) throw fail('Prazo de entrega inválido.');
      this._save('suppliers', row); this._event(old ? 'supplier.edited' : 'supplier.created', row.id, actorId); return row;
    });
  }
  recordPurchase(input, actorId) {
    return this._operation('purchase', input, actorId, () => {
      if (!this._get('suppliers', input.supplierId)) throw fail('Selecione um fornecedor cadastrado.');
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 500) throw fail('Informe de 1 a 500 itens da compra.');
      const seen = new Set(), purchasedAt = epoch(input.purchasedAt, this.now()), lines = input.items.map(line => {
        let item;
        if (line.inventory) { item = this.saveInventory({ ...line.inventory, quantity: 0, supplierId: input.supplierId, costCents: line.unitCostCents }, actorId); }
        else item = this._inventory(line.inventoryId);
        if (seen.has(item.id)) throw fail('O mesmo produto não pode aparecer duas vezes na compra.'); seen.add(item.id);
        const quantity = qty(line.quantity), unitCostCents = money(line.unitCostCents, 'Custo unitário');
        if (item.kind === 'device' && (quantity !== 1 || item.quantity > 0)) throw fail('Cadastre cada aparelho individualmente antes de registrar a entrada.');
        const newQuantity = item.quantity + quantity, oldTotal = item.costBasisTotalCents === undefined ? item.costCents === null ? null : item.costCents * item.quantity : item.costBasisTotalCents;
        if(newQuantity>1_000_000) throw fail('A entrada ultrapassa o limite de quantidade do estoque.');
        const costBasisTotalCents = item.quantity > 0 && oldTotal === null ? null : sum([oldTotal || 0, money(unitCostCents * quantity, 'Custo da entrada')]);
        const costCents = costBasisTotalCents === null ? null : Math.round(costBasisTotalCents / newQuantity);
        this._saveStock({ ...item, quantity: newQuantity, costCents, costBasisTotalCents, supplierId: input.supplierId, entryAt: purchasedAt });
        return { inventoryId: item.id, model: item.model, quantity, unitCostCents, totalCents: money(unitCostCents * quantity, 'Total da compra') };
      });
      const row = { id: randomUUID(), supplierId: input.supplierId, items: lines, totalCents: sum(lines.map(v => v.totalCents)), purchasedAt, createdAt: this.now(), actorId, userId: actorId, notes: text(input.notes, 2000), status: 'recorded' };
      this._save('purchases', row); this._event('purchase.recorded', row.id, actorId); return row;
    });
  }
  _cashOpen() { const sessions = this._list('cash_sessions').filter(s => s.status === 'open'); if (sessions.length > 1) throw fail('Mais de um caixa aberto; revise o cadastro.', 'CASH_STATE_INVALID'); return sessions[0] || null; }
  _movement({ amountCents, method, direction = 'in', kind, description = '', occurredAt = this.now(), saleId, reservationId, paymentId, actorId, relatedExpense = false }) {
    money(amountCents, 'Movimentação'); if (!amountCents) return null;
    if (![...METHODS, 'unknown'].includes(method) || !['in','out'].includes(direction)) throw fail('Canal ou direção da movimentação inválido.'); if (occurredAt > this.now()) throw fail('Movimentações futuras não podem ser contabilizadas como recebidas.', 'FINANCE_FUTURE_RECEIPT'); const session = method === 'cash' ? this._cashOpen() : null;
    if (method === 'cash' && !session) throw fail('Abra o caixa antes de registrar um pagamento ou uma saída em dinheiro.', 'CASH_NOT_OPEN');
    if (session && occurredAt < session.openedAt) throw fail('O recebimento em dinheiro é anterior à abertura do caixa. Registre a data real ou uma correção auditada.', 'CASH_TIME_INVALID');
    const row = { id: randomUUID(), amountCents, method, direction, kind, description, occurredAt, createdAt: this.now(), cashSessionId: session?.id || null, saleId: saleId || null, reservationId: reservationId || null, paymentId: paymentId || null, actorId, userId: actorId, relatedExpense };
    this._save('cash_movements', row); return row;
  }
  _payment({ method, amountCents, installments = 1, feeCents = 0, receivedAt, saleId, reservationId, kind = 'payment', direction = 'in', actorId }) {
    if (!METHODS.includes(method)) throw fail('Forma de pagamento inválida.'); money(amountCents, 'Pagamento'); money(feeCents, 'Taxa');
    if (!amountCents || feeCents > amountCents) throw fail('O pagamento deve ser maior que zero e a taxa não pode ultrapassar o valor.');
    if (!Number.isInteger(installments) || installments < 1 || installments > 120 || method !== 'credit' && installments !== 1) throw fail('Parcelas só são permitidas no crédito, entre 1 e 120.');
    const row = { id: randomUUID(), method, amountCents, installments, feeCents, receivedAt, saleId: saleId || null, reservationId: reservationId || null, kind, direction, actorId, userId: actorId, createdAt: this.now() };
    this._save('sale_payments', row);
    this._movement({ amountCents, method, direction, kind: direction === 'out' ? 'refund' : kind, description: direction === 'out' ? 'Estorno registrado' : 'Pagamento registrado', occurredAt: receivedAt, saleId, reservationId, paymentId: row.id, actorId });
    return row;
  }
  reserve(input, actorId) {
    return this._operation('reservation', input, actorId, () => {
      const item = this._enrichStock(this._inventory(input.inventoryId)), quantity = qty(input.quantity), expiresAt = epoch(input.expiresAt, null);
      if (!expiresAt || expiresAt <= this.now()) throw fail('A reserva precisa ter um prazo futuro.');
      if (quantity > item.availableQuantity) throw fail('Não há quantidade disponível para esta reserva.', 'STOCK_UNAVAILABLE');
      this._buyer(input.buyerId);
      const depositCents = money(input.depositCents ?? 0, 'Sinal'), row = { id: randomUUID(), inventoryId: item.id, quantity, buyerId: input.buyerId || null, buyerName: text(input.buyerName, 150, !input.buyerId), expiresAt, depositCents, status: 'active', createdAt: this.now(), actorId, userId: actorId, notes: text(input.notes, 1000) };
      if (depositCents) row.paymentId = this._payment({ amountCents: depositCents, feeCents: money(input.depositFeeCents ?? 0, 'Taxa do sinal'), method: input.paymentMethod, installments: input.installments ?? 1, receivedAt: epoch(input.receivedAt, this.now()), reservationId: row.id, kind: 'reservation_deposit', actorId }).id;
      this._save('reservations', row); this._saveStock(item); this._event('reservation.created', row.id, actorId, { inventoryId: item.id, quantity, depositCents }); this._invalidateCampaigns(item.id, 'Produto reservado; revise a disponibilidade antes de divulgar.'); return row;
    });
  }
  releaseReservation(input, actorId) {
    return this._operation('reservation.release', input, actorId, () => {
      const id = input.id || input.reservationId, row = this._get('reservations', id); if (!row || row.status !== 'active') throw fail('Reserva ativa não encontrada.');
      const result = this._save('reservations', { ...row, status: 'released', releasedAt: this.now(), releaseReason: text(input.reason, 1000, true), depositRefundRequired: row.depositCents > 0 });
      this._saveStock(this._inventory(row.inventoryId)); this._event('reservation.released', id, actorId, { reason: result.releaseReason, depositCents: row.depositCents }); return result;
    });
  }
  refundReservation(input, actorId) {
    return this._operation('reservation.refund', input, actorId, () => {
      const id = input.reservationId || input.id, reservation = this._get('reservations', id);
      if (!reservation || !['released','expired'].includes(reservation.status)) throw fail('Libere ou deixe expirar a reserva antes de estornar o sinal.');
      const payment = this._get('sale_payments', reservation.paymentId); if (!payment || payment.saleId) throw fail('Este sinal não está disponível para estorno da reserva.');
      const amountCents = money(input.amountCents, 'Estorno do sinal'), previous = sum(this._list('sale_payments', { reservationIds: [id] }).filter(p => p.direction === 'out').map(p => p.amountCents));
      if (!amountCents || amountCents > payment.amountCents - previous) throw fail('O estorno ultrapassa o saldo do sinal recebido.');
      const reason = text(input.reason, 1000, true); this._payment({ method: payment.method, amountCents, receivedAt: epoch(input.refundedAt,this.now()), reservationId: id, kind:'reservation_refund',direction:'out',actorId });
      const refundedDepositCents = previous + amountCents, result = this._save('reservations', {...reservation,refundedDepositCents,depositRefundRequired:refundedDepositCents<payment.amountCents}); this._event('reservation.refunded',id,actorId,{amountCents,reason,method:payment.method}); return result;
    });
  }
  expireReservations() {
    return this.store.transaction(() => {
      const affected = []; for (const row of this._list('reservations', { status:'active' })) if (row.expiresAt <= this.now()) { this._save('reservations', { ...row, status: 'expired', expiredAt: this.now(), depositRefundRequired: row.depositCents > 0 }); this._saveStock(this._inventory(row.inventoryId)); this._event('reservation.expired', row.id, null); affected.push(row.id); } return affected;
    });
  }
  _saleTotals(sale, paymentRows) {
    const payments = paymentRows || this._list('sale_payments', { saleIds: [sale.id] }), paidCents = sum(payments.filter(p => p.direction === 'in').map(p => p.amountCents)), refundedCents = sum(payments.filter(p => p.direction === 'out').map(p => p.amountCents));
    const effectivePaidCents = paidCents - refundedCents, outstandingCents = sale.status === 'cancelled' ? 0 : Math.max(0, sale.totalCents - effectivePaidCents), netCents = sum([sale.totalCents, -sale.feesCents, -sale.directExpensesCents]), estimatedProfitCents = sale.costCents === null ? null : sum([netCents, -sale.costCents]);
    const finalized = sale.costCents !== null && sale.feesFinalized !== false && sale.expensesFinalized !== false && outstandingCents === 0 && sale.status !== 'cancelled';
    return { ...sale, paidCents, effectivePaidCents, outstandingCents, refundedCents, refundPendingCents: sale.status === 'cancelled' ? Math.max(0, paidCents - refundedCents) : 0, netCents, estimatedProfitCents, realizedProfitCents: finalized ? estimatedProfitCents : null, profitStatus: sale.status === 'cancelled' ? 'cancelled' : finalized ? 'realized' : 'estimated', paymentStatus: effectivePaidCents >= sale.totalCents ? 'paid' : effectivePaidCents > 0 ? 'partial' : 'pending', payments };
  }
  _writeSale(sale) { return this._save('sales', this._saleTotals(sale)); }
  _invalidateCampaigns(inventoryId, reason) {
    for (const campaign of this.store.listCampaigns?.() || []) {
      const itemRefs = [...(campaign.items || []), ...Object.values(campaign.groupOverrides || {}).flatMap(o => o.items || [])];
      const references = campaign.inventoryIds?.includes(inventoryId) || campaign.stockIds?.includes(inventoryId) || itemRefs.some(item => item.stockId === inventoryId || item.stockIds?.includes(inventoryId) || item.inventoryIds?.includes(inventoryId) || item.commercialRef?.lines?.some(line => line.sourceType === 'inventory' && line.sourceId === inventoryId)) || campaign.commercialRef?.lines?.some(line => line.sourceType === 'inventory' && line.sourceId === inventoryId);
      if (references) this.store.saveCampaign({ ...campaign, commercialReviewRequired: true, commercialReviewReason: reason, commercialChangedAt: this.now() });
    }
  }
  createSale(input, actorId) {
    return this._operation('sale', input, actorId, () => {
      const item = this._enrichStock(this._inventory(input.inventoryId)), quantity = qty(input.quantity), audience = input.audience || 'retail'; if (!['retail', 'wholesale'].includes(audience)) throw fail('Selecione varejo ou atacado.');
      const reservation = input.reservationId ? this._get('reservations', input.reservationId) : null;
      if (input.reservationId && (!reservation || reservation.status !== 'active' || reservation.expiresAt <= this.now() || reservation.inventoryId !== item.id || reservation.quantity !== quantity)) throw fail('A reserva não corresponde à venda ou expirou.', 'RESERVATION_INVALID');
      if (reservation && input.buyerId && reservation.buyerId && input.buyerId !== reservation.buyerId) throw fail('O comprador não corresponde à reserva.');
      this._buyer(input.buyerId || reservation?.buyerId);
      if (reservation && input.buyerName && reservation.buyerName && input.buyerName.trim().toLocaleLowerCase('pt-BR') !== reservation.buyerName.trim().toLocaleLowerCase('pt-BR') && !input.reservationBuyerOverrideApproved) throw fail('O nome do comprador difere da reserva. Revise e aprove explicitamente a alteração.');
      if (quantity > item.availableQuantity + (reservation?.quantity || 0)) throw fail('O produto não está disponível para esta venda.', 'STOCK_UNAVAILABLE');
      const unitPriceCents = money(input.unitPriceCents ?? (audience === 'retail' ? item.retailCents : item.wholesaleCents), 'Preço unitário'), grossCents = money(unitPriceCents * quantity, 'Valor da venda'), discountCents = money(input.discountCents ?? 0, 'Desconto'); if (discountCents > grossCents) throw fail('O desconto não pode ultrapassar o total.');
      const totalCents = grossCents - discountCents, soldAt = epoch(input.soldAt, this.now()), paymentInputs = input.payments || []; if (!Array.isArray(paymentInputs) || paymentInputs.length > 20) throw fail('Pagamentos inválidos.');
      const incomingCents = sum(paymentInputs.map(p => money(p.amountCents, 'Pagamento'))), depositPayment = reservation?.paymentId ? this._get('sale_payments', reservation.paymentId) : null;
      if (reservation?.depositCents && (!depositPayment || depositPayment.saleId || depositPayment.direction !== 'in')) throw fail('O sinal da reserva já foi utilizado ou precisa ser revisado.', 'DEPOSIT_INVALID');
      const depositCents = depositPayment?.amountCents || 0; if (sum([depositCents, incomingCents]) > totalCents) throw fail('Pagamentos e sinal ultrapassam o valor da venda; revise antes de confirmar.');
      const paymentFees = sum(paymentInputs.map(p => money(p.feeCents ?? 0, 'Taxa do pagamento'))), depositFeeCents = depositPayment?.feeCents || 0, feesCents = money(input.feesCents ?? sum([paymentFees, depositFeeCents]), 'Taxas');
      if ((paymentFees || depositFeeCents) && input.feesCents !== undefined && feesCents !== sum([paymentFees,depositFeeCents])) throw fail('A taxa total deve corresponder à soma das taxas dos pagamentos e do sinal, sem duplicação.');
      const directExpensesCents = money(input.directExpensesCents ?? 0, 'Despesas diretas'), pool = item.costBasisTotalCents === undefined ? item.costCents === null ? null : item.costCents * item.quantity : item.costBasisTotalCents;
      const costCents = pool === null ? null : allocation(pool,quantity,item.quantity);
      const row = { id: randomUUID(), inventoryId: item.id, productSnapshot: { model: item.model, storage: item.storage, color: item.color, condition: item.condition, kind: item.kind }, quantity, buyerId: input.buyerId || reservation?.buyerId || null, buyerName: text(input.buyerName || reservation?.buyerName, 150), audience, unitPriceCents, grossCents, discountCents, totalCents, costCents, feesCents, directExpensesCents, directExpenseMethod: input.directExpenseMethod || 'unknown', feesFinalized: input.feesFinalized !== false, expensesFinalized: input.expensesFinalized !== false, reservationId: reservation?.id || null, depositCents, soldAt, createdAt: this.now(), actorId, userId: actorId, campaignId: input.campaignId || null, status: 'completed', version: 1, returnedQuantity: 0 };
      if (row.campaignId && !this.store.getCampaign(row.campaignId)) throw fail('A campanha vinculada não foi encontrada.');
      if (depositPayment) { this._save('sale_payments', { ...depositPayment, saleId: row.id, appliedAt: this.now() }); for (const movement of this._list('cash_movements')) if (movement.paymentId === depositPayment.id) this._save('cash_movements', { ...movement, saleId: row.id }); }
      for (const payment of paymentInputs) this._payment({ ...payment, feeCents: payment.feeCents ?? 0, receivedAt: epoch(payment.receivedAt, soldAt), saleId: row.id, direction:'in',kind:'payment',reservationId:null,actorId });
      if (directExpensesCents) this._movement({ amountCents: directExpensesCents, method: input.directExpenseMethod || 'unknown', direction: 'out', kind: 'sale_expense', description: 'Despesa vinculada à venda', occurredAt: epoch(input.directExpenseAt,soldAt), saleId: row.id, actorId, relatedExpense: true });
      if (reservation) this._save('reservations', { ...reservation, status: 'consumed', saleId: row.id, consumedAt: this.now() });
      this._saveStock({ ...item, quantity: item.quantity - quantity, costBasisTotalCents: pool === null ? null : pool - costCents });
      const result = this._writeSale(row); this._event('sale.created', row.id, actorId, { inventoryId: item.id, quantity, totalCents, reservationId: row.reservationId }); this._invalidateCampaigns(item.id, 'Produto vendido; remova ou revise o anúncio antes do próximo envio.'); return result;
    });
  }
  recordPayment(input, actorId) {
    return this._operation('sale.payment', input, actorId, () => {
      const sale = this._saleTotals(this._sale(input.saleId)); if (sale.status === 'cancelled') throw fail('Uma venda cancelada não pode receber novos pagamentos.');
      this._version(sale,input);
      if (!Array.isArray(input.payments) || !input.payments.length || input.payments.length > 20) throw fail('Informe os pagamentos recebidos.');
      const receivedAt = epoch(input.receivedAt, this.now()), amountCents = sum(input.payments.map(p => money(p.amountCents, 'Pagamento'))); if (amountCents > sale.outstandingCents) throw fail('O recebimento excede o saldo restante.');
      const extraFees = sum(input.payments.map(p => money(p.feeCents ?? 0, 'Taxa do pagamento')));
      for (const payment of input.payments) this._payment({ ...payment, receivedAt: epoch(payment.receivedAt, receivedAt), saleId: sale.id,direction:'in',kind:'payment',reservationId:null,actorId });
      const result = this._writeSale({ ...sale, feesCents: sum([sale.feesCents, extraFees]), updatedAt: this.now(), version: sale.version + 1 }); this._event('sale.payment', sale.id, actorId, { amountCents, extraFees }); return result;
    });
  }
  cancelSale(input, actorId) {
    return this._operation('sale.cancel', input, actorId, () => { const sale = this._sale(input.saleId); this._version(sale,input); if (sale.status === 'cancelled') throw fail('Esta venda já está cancelada.'); const reason = text(input.reason, 1000, true), result = this._writeSale({ ...sale, status: 'cancelled', cancelledAt: epoch(input.cancelledAt, this.now()), cancellationReason: reason, version: sale.version + 1 }); this._event('sale.cancelled', sale.id, actorId, { reason, refundsRequiredCents: result.refundPendingCents, stockReturnRequired: sale.quantity > sale.returnedQuantity }); return result; });
  }
  refundSale(input, actorId) {
    return this._operation('sale.refund', input, actorId, () => {
      const sale = this._saleTotals(this._sale(input.saleId)), amountCents = money(input.amountCents, 'Estorno'), method = input.method;
      this._version(sale,input);
      if (!amountCents || amountCents > sale.paidCents - sale.refundedCents) throw fail('O estorno excede os pagamentos efetivamente registrados.');
      const receivedInMethod = sum(sale.payments.filter(p => p.method === method).map(p => p.direction === 'out' ? -p.amountCents : p.amountCents)); if (amountCents > receivedInMethod) throw fail('O estorno excede o valor recebido nesta forma de pagamento.');
      if (sale.status !== 'cancelled' && !input.adjustmentApproved) throw fail('Cancele a venda ou confirme explicitamente o estorno parcial aprovado antes de registrar.');
      const reason = text(input.reason, 1000, true); this._payment({ method, amountCents, receivedAt: epoch(input.refundedAt, this.now()), saleId: sale.id, kind: 'refund', direction: 'out', actorId });
      const result = this._writeSale({ ...sale, updatedAt: this.now(), version: sale.version + 1 }); this._event('sale.refunded', sale.id, actorId, { amountCents, method, reason }); return result;
    });
  }
  returnStock(input, actorId) {
    return this._operation('sale.stock-return', input, actorId, () => {
      const sale = this._sale(input.saleId), quantity = qty(input.quantity), reason = text(input.reason, 1000, true); this._version(sale,input); if (sale.status !== 'cancelled') throw fail('Cancele a venda antes de devolver o produto ao estoque.'); if (quantity > sale.quantity - (sale.returnedQuantity || 0)) throw fail('A devolução excede a quantidade vendida ainda não devolvida.');
      const item = this._inventory(sale.inventoryId); if (item.kind === 'device' && item.quantity > 0) throw fail('O aparelho já está no estoque.');
      const returnedQuantity = (sale.returnedQuantity || 0) + quantity, previousReturnedCost = sale.returnedCostCents || 0, returnedCostTotal = sale.costCents === null ? null : allocation(sale.costCents,returnedQuantity,sale.quantity), returnedCost = returnedCostTotal === null ? null : returnedCostTotal - previousReturnedCost;
      const pool = item.costBasisTotalCents === undefined ? item.costCents === null ? null : item.costCents * item.quantity : item.costBasisTotalCents, newPool = returnedCost === null || item.quantity>0 && pool===null ? null : sum([pool || 0, returnedCost]), newQuantity=item.quantity+quantity;
      this._saveStock({ ...item, quantity:newQuantity,costBasisTotalCents:newPool,costCents:newPool===null?null:Math.round(newPool/newQuantity) }); const result = this._writeSale({ ...sale, returnedQuantity,returnedCostCents:returnedCostTotal, updatedAt: this.now(), version: sale.version + 1 }); this._event('sale.stock-returned', sale.id, actorId, { quantity, returnedCostCents:returnedCost,reason }); return result;
    });
  }
  correctSale(input, actorId) {
    return this._operation('sale.correct', input, actorId, () => {
      const sale = this._saleTotals(this._sale(input.saleId)); if (sale.status === 'cancelled') throw fail('Uma venda cancelada não pode ser corrigida.');
      this._version(sale,input);
      const reason = text(input.reason, 1000, true), unitPriceCents = money(input.unitPriceCents ?? sale.unitPriceCents, 'Preço unitário'), grossCents = money(unitPriceCents * sale.quantity, 'Total da venda'), discountCents = money(input.discountCents ?? sale.discountCents, 'Desconto'); if (discountCents > grossCents) throw fail('O desconto excede a venda.');
      const totalCents = grossCents - discountCents; if (totalCents < sale.paidCents - sale.refundedCents) throw fail('A correção reduziria a venda abaixo do valor recebido. Registre primeiro um estorno aprovado.');
      const feesCents = money(input.feesCents ?? sale.feesCents, 'Taxas'), directExpensesCents = money(input.directExpensesCents ?? sale.directExpensesCents, 'Despesas');
      const expenseDelta=directExpensesCents-sale.directExpensesCents; if(expenseDelta) this._movement({amountCents:Math.abs(expenseDelta),method:input.directExpenseMethod||sale.directExpenseMethod||'unknown',direction:expenseDelta>0?'out':'in',kind:'sale_expense_correction',description:reason,occurredAt:this.now(),saleId:sale.id,actorId,relatedExpense:true});
      const result = this._writeSale({ ...sale, unitPriceCents, grossCents, discountCents, totalCents, feesCents,directExpensesCents, version: sale.version + 1, correctedAt: this.now(), correctionReason: reason }); this._event('sale.corrected', sale.id, actorId, { reason, before: { unitPriceCents: sale.unitPriceCents, discountCents: sale.discountCents, feesCents: sale.feesCents,directExpensesCents:sale.directExpensesCents }, after: { unitPriceCents, discountCents, feesCents,directExpensesCents } }); return result;
    });
  }
  openCash(input, actorId) {
    return this._operation('cash.open', input, actorId, () => { if (this._cashOpen()) throw fail('Já existe um caixa aberto.'); const row = { id: randomUUID(), initialCashCents: money(input.initialCashCents ?? 0, 'Saldo inicial'), openedAt: epoch(input.openedAt, this.now()), createdAt: this.now(), actorId, userId: actorId, status: 'open' }; this._save('cash_sessions', row); this._event('cash.opened', row.id, actorId, { initialCashCents: row.initialCashCents }); return this._cashTotals(row); });
  }
  addCashMovement(input, actorId) {
    return this._operation('cash.movement', input, actorId, () => {
      const direction = input.direction, kind = input.kind || 'adjustment'; if (!['in', 'out'].includes(direction) || !['expense', 'float', 'withdrawal', 'adjustment'].includes(kind)) throw fail('Tipo de movimentação inválido.');
      if (kind === 'expense' && direction !== 'out' || kind === 'float' && direction !== 'in' || kind === 'withdrawal' && direction !== 'out') throw fail('A direção não corresponde ao tipo da movimentação.');
      const method = input.method || 'cash'; if (!METHODS.includes(method)) throw fail('Forma de pagamento da movimentação inválida.');
      const amountCents = money(input.amountCents, 'Movimentação'); if (!amountCents) throw fail('A movimentação deve ser maior que zero.');
      const row = this._movement({ amountCents, method, direction, kind, description: text(input.description, 1000, true), occurredAt: epoch(input.occurredAt, this.now()), actorId }); if(input.category) {row.category=text(input.category,100,true); this._save('cash_movements',row);} this._event('cash.movement', row.id, actorId, { amountCents, method, direction, kind }); return row;
    });
  }
  _cashTotals(session) { if (session.status === 'closed') return session; const movements = this._list('cash_movements', { cashSessionId: session.id }).filter(m => m.method === 'cash'); return { ...session, expectedCashCents: sum([session.initialCashCents, ...movements.map(m => m.direction === 'out' ? -m.amountCents : m.amountCents)]) }; }
  closeCash(input, actorId) {
    return this._operation('cash.close', input, actorId, () => { const session = input.sessionId ? this._get('cash_sessions', input.sessionId) : this._cashOpen(); if (!session || session.status !== 'open') throw fail('Caixa aberto não encontrado.'); const expected = this._cashTotals(session), countedCashCents = money(input.countedCashCents, 'Dinheiro contado'); const row = { ...expected, countedCashCents, differenceCents: countedCashCents - expected.expectedCashCents, closedAt: epoch(input.closedAt, this.now()), closedBy: actorId, status: 'closed' }; if (row.closedAt < row.openedAt || row.closedAt > this.now()) throw fail('Horário de fechamento inválido.'); if(this._list('cash_movements').some(m=>m.cashSessionId===session.id && m.occurredAt>row.closedAt)) throw fail('O fechamento não pode ser anterior às movimentações do caixa.'); this._save('cash_sessions', row); this._event('cash.closed', row.id, actorId, { expectedCashCents: row.expectedCashCents, countedCashCents, differenceCents: row.differenceCents }); return row; });
  }
  dailyReport(day, timezone = 'America/Sao_Paulo') {
    validDay(day); dateKey(this.now(), timezone);
    const allSales = this.listSales(), sales = allSales.filter(s => dateKey(s.soldAt, timezone) === day), active = sales.filter(s => s.status !== 'cancelled'), cancelledToday = allSales.filter(s => s.status === 'cancelled' && dateKey(s.cancelledAt, timezone) === day);
    const payments = this._list('sale_payments').filter(p => dateKey(p.receivedAt, timezone) === day), movements = this._list('cash_movements').filter(m => dateKey(m.occurredAt, timezone) === day), generalExpenses = movements.filter(m => m.kind === 'expense' && !m.relatedExpense), receipts = payments.filter(p => p.direction === 'in'), refunds = payments.filter(p => p.direction === 'out');
    const receivedByMethod = Object.fromEntries(METHODS.map(method => [method, sum(receipts.filter(p => p.method === method).map(p => p.amountCents))])), refundedByMethod = Object.fromEntries(METHODS.map(method => [method, sum(refunds.filter(p => p.method === method).map(p => p.amountCents))]));
    const saleMap = new Map(allSales.map(s=>[s.id,s])); const priorSaleReceipts = receipts.filter(p => p.saleId && dateKey(saleMap.get(p.saleId)?.soldAt || p.receivedAt, timezone) < day), unallocatedDeposits = receipts.filter(p => p.kind === 'reservation_deposit' && (!p.saleId || dateKey(saleMap.get(p.saleId)?.soldAt || p.receivedAt,timezone)>day));
    const audience = Object.fromEntries(['retail', 'wholesale'].map(value => { const rows = active.filter(s => s.audience === value); return [value, { count: rows.length, quantity: sum(rows.map(s => s.quantity)), totalCents: sum(rows.map(s => s.totalCents)), knownCostCents: sum(rows.filter(s => s.costCents !== null).map(s => s.costCents)), estimatedProfitCents: sum(rows.filter(s => s.estimatedProfitCents !== null).map(s => s.estimatedProfitCents)), realizedProfitCents: sum(rows.filter(s => s.realizedProfitCents !== null).map(s => s.realizedProfitCents)), unknownCostCount: rows.filter(s => s.costCents === null).length }]; }));
    const grouped = new Map(); for (const sale of active) { const key = digest(sale.productSnapshot); const p = grouped.get(key) || { ...sale.productSnapshot, quantity: 0, totalCents: 0 }; p.quantity += sale.quantity; p.totalCents = sum([p.totalCents, sale.totalCents]); grouped.set(key, p); }
    const cashMovements = this._list('cash_movements');
    const cashSessions = this._list('cash_sessions').filter(s => dateKey(s.openedAt, timezone) <= day && (!s.closedAt || dateKey(s.closedAt, timezone) >= day)).map(s => { const expectedCashCents=sum([s.initialCashCents,...cashMovements.filter(m=>m.cashSessionId===s.id&&m.method==='cash'&&dateKey(m.occurredAt,timezone)<=day).map(m=>m.direction==='out'?-m.amountCents:m.amountCents)]); if(s.closedAt&&dateKey(s.closedAt,timezone)<=day) return {...s,expectedCashCents}; const{closedAt,closedBy,countedCashCents,differenceCents,...open}=s;return {...open,status:'open',expectedCashCents}; });
    return { date: day, timezone, generatedAt: this.now(), sales: active, products: [...grouped.values()], saleCount: active.length, soldQuantity: sum(active.map(s => s.quantity)), grossCents: sum(active.map(s => s.grossCents)), totalCents: sum(active.map(s => s.totalCents)), discountCents: sum(active.map(s => s.discountCents)), cancellationCount: cancelledToday.length, cancellationCents: sum(cancelledToday.map(s => s.totalCents)), knownCostCents: sum(active.filter(s => s.costCents !== null).map(s => s.costCents)), unknownCostCount: active.filter(s => s.costCents === null).length, feesCents: sum(active.map(s => s.feesCents)), directExpensesCents: sum(active.map(s => s.directExpensesCents)), cancellationLossCents: sum(cancelledToday.map(s => s.feesCents + s.directExpensesCents)),stockReturnPendingCostCents:sum(allSales.filter(s=>s.status==='cancelled'&&s.costCents!==null).map(s=>s.costCents-(s.returnedCostCents||0))), estimatedProfitCents: sum(active.filter(s => s.estimatedProfitCents !== null).map(s => s.estimatedProfitCents)), realizedProfitCents: sum(active.filter(s => s.realizedProfitCents !== null).map(s => s.realizedProfitCents)), generalExpensesCents: sum(generalExpenses.map(m => m.amountCents)), receivedByMethod, refundedByMethod, receivedCents: sum(receipts.map(p => p.amountCents)), refundCents: sum(refunds.map(p => p.amountCents)), priorSaleReceiptsCents: sum(priorSaleReceipts.map(p => p.amountCents)), unallocatedDepositsCents: sum(unallocatedDeposits.map(p => p.amountCents)), pendingCents: sum(active.map(s => s.outstandingCents)), refundPendingCents: sum(allSales.filter(s => s.status === 'cancelled').map(s => s.refundPendingCents)), audience, cashSessions, movements, note: 'Recebimentos são registros informados pelo usuário; cartões não representam confirmação de liquidação bancária. Sinais mantêm a data original e não são recebidos novamente na venda.' };
  }
  periodReports({ from, to, timezone = 'America/Sao_Paulo',audience,inventoryId,campaignId } = {}) {
    validDay(from); validDay(to); if (from > to) throw fail('O início deve ser anterior ao fim do período.'); dateKey(this.now(), timezone);
    if(audience && !['retail','wholesale'].includes(audience)) throw fail('Público do relatório inválido.'); const sales = this.listSales().filter(s => s.status !== 'cancelled' && dateKey(s.soldAt, timezone) >= from && dateKey(s.soldAt, timezone) <= to && (!audience||s.audience===audience) && (!inventoryId||s.inventoryId===inventoryId) && (!campaignId||(campaignId==='unattributed'?!s.campaignId:s.campaignId===campaignId))), map = (keyFn, labelFn) => { const groups = new Map(); for (const sale of sales) { const key = keyFn(sale); const current = groups.get(key) || { id: key, label: labelFn(sale), count: 0, quantity: 0, totalCents: 0, knownCostCents: 0, estimatedProfitCents: 0, realizedProfitCents: 0, unknownCostCount: 0 }; current.count++; current.quantity += sale.quantity; current.totalCents = sum([current.totalCents, sale.totalCents]); current.knownCostCents = sum([current.knownCostCents, sale.costCents || 0]); current.estimatedProfitCents = sum([current.estimatedProfitCents, sale.estimatedProfitCents || 0]); current.realizedProfitCents = sum([current.realizedProfitCents, sale.realizedProfitCents || 0]); if (sale.costCents === null) current.unknownCostCount++; groups.set(key, current); } return [...groups.values()].sort((a, b) => b.quantity - a.quantity); };
    const byCampaign = map(s => s.campaignId || 'unattributed', s => s.campaignId ? this.store.getCampaign(s.campaignId)?.name || s.campaignId : 'Sem vínculo registrado').map(row => ({ ...row, orderCount: row.count, interestedCount: 0 })), campaignRows = new Map(byCampaign.map(row => [row.id, row]));
    for (const demand of this._list('buyer_demands')) {
      if (!demand.campaignId || demand.deletedAt || !Number.isFinite(demand.createdAt) || (campaignId && demand.campaignId !== campaignId) || (audience && demand.audience !== audience) || (inventoryId && demand.inventoryId !== inventoryId)) continue;
      const day = dateKey(demand.createdAt, timezone); if (day < from || day > to) continue;
      let row = campaignRows.get(demand.campaignId);
      if (!row) { row = { id: demand.campaignId, label: this.store.getCampaign(demand.campaignId)?.name || demand.campaignId, count: 0, orderCount: 0, interestedCount: 0, quantity: 0, totalCents: 0, knownCostCents: 0, estimatedProfitCents: 0, realizedProfitCents: 0, unknownCostCount: 0 }; campaignRows.set(row.id, row); byCampaign.push(row); }
      row.interestedCount++;
    }
    return { from, to, timezone, saleCount: sales.length, quantity: sum(sales.map(s => s.quantity)), totalCents: sum(sales.map(s => s.totalCents)), ticketAverageCents: sales.length ? Math.round(sum(sales.map(s => s.totalCents)) / sales.length) : 0, knownCostCents: sum(sales.filter(s => s.costCents !== null).map(s => s.costCents)), estimatedProfitCents: sum(sales.filter(s => s.estimatedProfitCents !== null).map(s => s.estimatedProfitCents)), realizedProfitCents: sum(sales.filter(s => s.realizedProfitCents !== null).map(s => s.realizedProfitCents)), unknownCostCount: sales.filter(s => s.costCents === null).length, byProduct: map(s => s.inventoryId, s => s.productSnapshot.model), byAudience: map(s => s.audience, s => s.audience), byCampaign, attributionNote: 'Pedidos são vendas com vínculo de campanha registrado; interessados são demandas vinculadas criadas no período. Conversões não são presumidas.' };
  }
}

module.exports = { CommerceFinance, METHODS, money, dateKey, publicInventory };
