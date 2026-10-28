'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../src/core/store.cjs');
const { CommerceFinance, dateKey } = require('../src/core/commerce-finance.cjs');

async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kenned-finance-')),clock={at:Date.parse('2026-10-05T15:00:00Z')};
  let store=await createStore(dir),service=new CommerceFinance({store,now:()=>clock.at});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const product=patch=>service.saveInventory({kind:'device',model:'iPhone 15 Pro Max',storage:'256GB',color:'Azul',condition:'Seminovo',costCents:200000,retailCents:350000,wholesaleCents:320000,...patch},'owner');
  const reopen=async()=>{store.close();store=await createStore(dir);service=new CommerceFinance({store,now:()=>clock.at});return service;};
  return {dir,clock,get store(){return store;},get service(){return service;},product,reopen};
}
const sale=(item,patch={})=>({inventoryId:item.id,quantity:1,audience:'retail',buyerName:'Comprador de teste',payments:[],idempotencyKey:crypto.randomUUID(),...patch});

test('known totals: original deposit, discount, split payments, card fee and direct expense reconcile exactly',async t=>{
  const f=await fixture(t),item=f.product(); f.clock.at=Date.parse('2026-10-04T15:00:00Z');
  const reserve=f.service.reserve({inventoryId:item.id,buyerName:'Comprador de teste',quantity:1,expiresAt:Date.parse('2026-10-06T15:00:00Z'),depositCents:50000,paymentMethod:'pix',idempotencyKey:'reserve'},'owner');
  f.clock.at=Date.parse('2026-10-05T15:00:00Z');f.service.openCash({initialCashCents:20000,idempotencyKey:'cash'},'owner');
  const sold=f.service.createSale(sale(item,{reservationId:reserve.id,discountCents:10000,feesCents:6000,directExpensesCents:4000,payments:[{method:'cash',amountCents:90000},{method:'credit',amountCents:200000,installments:2,feeCents:6000}]}),'owner');
  assert.equal(sold.totalCents,340000);assert.equal(sold.paidCents,340000);assert.equal(sold.outstandingCents,0);assert.equal(sold.netCents,330000);assert.equal(sold.realizedProfitCents,130000);assert.equal(sold.depositCents,50000);
  assert.equal(f.store.listEntities('sale_payments').length,3);assert.equal(f.store.getEntity('inventory',item.id).quantity,0);
  f.service.addCashMovement({direction:'out',kind:'expense',amountCents:10000,category:'Loja',description:'Limpeza da loja',idempotencyKey:'expense'},'owner');
  const report=f.service.dailyReport('2026-10-05');assert.equal(report.receivedCents,290000);assert.equal(report.receivedByMethod.cash,90000);assert.equal(report.receivedByMethod.credit,200000);assert.equal(report.totalCents,340000);assert.equal(report.generalExpensesCents,10000);assert.equal(report.directExpensesCents,4000);assert.equal(report.cashSessions[0].expectedCashCents,100000);
  const yesterday=f.service.dailyReport('2026-10-04');assert.equal(yesterday.totalCents,0);assert.equal(yesterday.receivedCents,50000);assert.equal(yesterday.unallocatedDepositsCents,50000);assert.equal(yesterday.priorSaleReceiptsCents,0);
});

test('partial sale and later payment preserve sale-day turnover and distinguish prior-sale receipt',async t=>{
  const f=await fixture(t),item=f.product({costCents:60000,retailCents:100000});
  const sold=f.service.createSale(sale(item,{payments:[{method:'pix',amountCents:30000}]}),'owner');assert.equal(sold.outstandingCents,70000);assert.equal(sold.paymentStatus,'partial');assert.equal(sold.estimatedProfitCents,40000);assert.equal(sold.realizedProfitCents,null);
  f.clock.at+=86400000;const completed=f.service.recordPayment({saleId:sold.id,payments:[{method:'pix',amountCents:70000}],idempotencyKey:'pay-rest'},'owner');assert.equal(completed.realizedProfitCents,40000);
  const report=f.service.dailyReport('2026-10-06');assert.equal(report.totalCents,0);assert.equal(report.receivedCents,70000);assert.equal(report.priorSaleReceiptsCents,70000);assert.equal(report.knownCostCents,0);
});

test('idempotent repeated clicks and persistence after reopening do not duplicate sales, cash or stock changes',async t=>{
  const f=await fixture(t),item=f.product(),input=sale(item,{payments:[{method:'pix',amountCents:350000}],idempotencyKey:'same-click'});
  const first=f.service.createSale(input,'owner'),second=f.service.createSale(input,'owner');assert.deepEqual(second,first);assert.equal(f.store.listEntities('sales').length,1);assert.equal(f.store.listEntities('sale_payments').length,1);
  assert.throws(()=>f.service.createSale({...input,discountCents:100},'owner'),{code:'IDEMPOTENCY_CONFLICT'});
  await f.reopen();assert.deepEqual(f.service.createSale(input,'owner'),first);assert.equal(f.service.listInventory()[0].status,'sold');assert.equal(f.service.listSales().length,1);
});

test('mid-transaction failure rolls back stock, sale, receipts, movement, reservation and operation marker',async t=>{
  const f=await fixture(t),item=f.product(),beforeEvents=f.store.listEntities('sale_events').length,original=f.store.saveEntity;let writes=0;
  f.store.saveEntity=function(table,row){if(++writes===4)throw Object.assign(new Error('Falha de gravação injetada'),{code:'EIO'});return original.call(this,table,row);};
  assert.throws(()=>f.service.createSale(sale(item,{payments:[{method:'pix',amountCents:350000}]}),'owner'),/gravação/);
  assert.equal(f.store.getEntity('inventory',item.id).quantity,1);assert.equal(f.store.listEntities('sales').length,0);assert.equal(f.store.listEntities('sale_payments').length,0);assert.equal(f.store.listEntities('cash_movements').length,0);assert.equal(f.store.listEntities('sale_events').length,beforeEvents);
  f.store.saveEntity=original;
});

test('reservation blocks another buyer and deposit cannot be reused or exceed total',async t=>{
  const f=await fixture(t),item=f.product();const reserve=f.service.reserve({inventoryId:item.id,buyerName:'Ana',quantity:1,expiresAt:f.clock.at+86400000,depositCents:50000,paymentMethod:'pix',idempotencyKey:'r'},'owner');
  assert.throws(()=>f.service.createSale(sale(item),'owner'),{code:'STOCK_UNAVAILABLE'});
  assert.throws(()=>f.service.createSale(sale(item,{reservationId:reserve.id,buyerName:'Outra pessoa'}),'owner'),/nome do comprador/);
  assert.throws(()=>f.service.createSale(sale(item,{reservationId:reserve.id,buyerName:'Ana',unitPriceCents:40000}),'owner'),/ultrapassam/);
  const sold=f.service.createSale(sale(item,{reservationId:reserve.id,buyerName:'Ana',payments:[]}),'owner');assert.equal(sold.paidCents,50000);assert.equal(sold.outstandingCents,300000);
  assert.throws(()=>f.service.createSale(sale(item,{reservationId:reserve.id,buyerName:'Ana'}),'owner'),{code:'RESERVATION_INVALID'});
});

test('released and expired reservation deposits remain refundable with exactly one durable outflow',async t=>{
  const f=await fixture(t),item=f.product();const reservation=f.service.reserve({inventoryId:item.id,buyerName:'Ana',expiresAt:f.clock.at+1000,depositCents:20000,paymentMethod:'pix',idempotencyKey:'r'},'owner');
  f.clock.at+=2000;assert.deepEqual(f.service.expireReservations(),[reservation.id]);assert.equal(f.service.listInventory()[0].availableQuantity,1);
  const input={reservationId:reservation.id,amountCents:20000,reason:'Reserva expirada',idempotencyKey:'refund-deposit'},r=f.service.refundReservation(input,'owner');assert.equal(r.depositRefundRequired,false);assert.equal(r.refundedDepositCents,20000);assert.deepEqual(f.service.refundReservation(input,'owner'),r);assert.equal(f.store.listEntities('sale_payments').length,2);
  assert.throws(()=>f.service.refundReservation({...input,amountCents:1,idempotencyKey:'another'},'owner'),/ultrapassa/);
});

test('cancel, financial refund and physical return are distinct audited operations with bounded replay',async t=>{
  const f=await fixture(t),item=f.product({retailCents:100000,costCents:60000});const sold=f.service.createSale(sale(item,{payments:[{method:'pix',amountCents:100000}],feesCents:1000,directExpensesCents:2000}),'owner');
  const canceled=f.service.cancelSale({saleId:sold.id,reason:'Cliente desistiu',idempotencyKey:'cancel'},'owner');assert.equal(canceled.refundPendingCents,100000);assert.equal(f.store.getEntity('inventory',item.id).quantity,0);
  assert.equal(f.service.dailyReport('2026-10-05').totalCents,0);assert.equal(f.service.dailyReport('2026-10-05').cancellationLossCents,3000);assert.equal(f.service.dailyReport('2026-10-05').stockReturnPendingCostCents,60000);
  const refund={saleId:sold.id,amountCents:100000,method:'pix',reason:'Estorno ao cliente',idempotencyKey:'refund'},refunded=f.service.refundSale(refund,'owner');assert.equal(refunded.refundPendingCents,0);assert.deepEqual(f.service.refundSale(refund,'owner'),refunded);assert.equal(f.store.getEntity('inventory',item.id).quantity,0);
  const returned=f.service.returnStock({saleId:sold.id,quantity:1,reason:'Produto devolvido',idempotencyKey:'return'},'owner');assert.equal(returned.returnedQuantity,1);assert.equal(f.store.getEntity('inventory',item.id).quantity,1);
  assert.throws(()=>f.service.returnStock({saleId:sold.id,quantity:1,reason:'Duplicada',idempotencyKey:'return-again'},'owner'),/excede/);assert.equal(f.service.dailyReport('2026-10-05').refundCents,100000);
});

test('partial approved refund changes effective paid/outstanding and correction retains history',async t=>{
  const f=await fixture(t),item=f.product({retailCents:100000,costCents:60000});const sold=f.service.createSale(sale(item,{payments:[{method:'pix',amountCents:100000}]}),'owner');
  const after=f.service.refundSale({saleId:sold.id,amountCents:20000,method:'pix',reason:'Desconto posterior aprovado',adjustmentApproved:true,idempotencyKey:'discount-refund'},'owner');assert.equal(after.paidCents,100000);assert.equal(after.effectivePaidCents,80000);assert.equal(after.outstandingCents,20000);assert.equal(after.realizedProfitCents,null);
  const corrected=f.service.correctSale({saleId:sold.id,discountCents:20000,reason:'Desconto registrado após estorno',idempotencyKey:'correct'},'owner');assert.equal(corrected.outstandingCents,0);assert.equal(corrected.realizedProfitCents,20000);assert.equal(f.store.listEntities('sale_events').filter(e=>e.kind==='sale.corrected').length,1);
});

test('untrusted payment fields cannot convert new-sale or later receipt into refund',async t=>{
  const f=await fixture(t),item=f.product({retailCents:100000});const sold=f.service.createSale(sale(item,{payments:[{method:'pix',amountCents:50000,direction:'out',kind:'refund',reservationId:'forged'}]}),'owner');assert.equal(sold.paidCents,50000);assert.equal(sold.refundedCents,0);assert.equal(sold.payments[0].kind,'payment');assert.equal(sold.payments[0].reservationId,null);
  const paid=f.service.recordPayment({saleId:sold.id,payments:[{method:'pix',amountCents:50000,direction:'out',kind:'refund'}],idempotencyKey:'rest'},'owner');assert.equal(paid.paidCents,100000);assert.equal(paid.refundedCents,0);
});

test('cash opening and close distinguish physical drawer from Pix/card, counted difference and general expense',async t=>{
  const f=await fixture(t);const opened=f.service.openCash({initialCashCents:20000,idempotencyKey:'open'},'owner');f.clock.at+=1000;
  f.service.addCashMovement({direction:'in',kind:'float',amountCents:3000,description:'Reforço',idempotencyKey:'float'},'owner');
  f.service.addCashMovement({direction:'out',kind:'expense',amountCents:1000,method:'pix',description:'Internet da loja',category:'Operacional',idempotencyKey:'expense'},'owner');
  f.service.addCashMovement({direction:'out',kind:'withdrawal',amountCents:5000,description:'Retirada',idempotencyKey:'withdrawal'},'owner');
  const closed=f.service.closeCash({sessionId:opened.id,countedCashCents:17500,idempotencyKey:'close'},'owner');assert.equal(closed.expectedCashCents,18000);assert.equal(closed.differenceCents,-500);assert.equal(f.service.dailyReport('2026-10-05').generalExpensesCents,1000);
  assert.throws(()=>f.service.addCashMovement({direction:'in',kind:'float',amountCents:1,description:'Tarde',idempotencyKey:'late'},'owner'),{code:'CASH_NOT_OPEN'});
  assert.equal(f.store.listEntities('cash_movements').find(m=>m.kind==='expense').category,'Operacional');
});

test('future receipts and close before already registered movement are rejected; overnight open cash is shown',async t=>{
  const f=await fixture(t);f.clock.at-=86400000;const opened=f.service.openCash({initialCashCents:0,idempotencyKey:'cash'},'owner');f.clock.at+=86400000;
  f.service.addCashMovement({direction:'in',kind:'float',amountCents:1000,description:'Entrada hoje',idempotencyKey:'float'},'owner');
  assert.equal(f.service.dailyReport('2026-10-05').cashSessions.length,1);
  assert.throws(()=>f.service.closeCash({sessionId:opened.id,countedCashCents:1000,closedAt:f.clock.at-1000,idempotencyKey:'too-early'},'owner'),/anterior/);
  assert.throws(()=>f.service.addCashMovement({direction:'in',kind:'float',amountCents:1000,description:'Entrada futura',occurredAt:f.clock.at+1000,idempotencyKey:'future'},'owner'),{code:'FINANCE_FUTURE_RECEIPT'});
});

test('accessory cost pool retains every cent across mixed-cost purchases, sale and stock return',async t=>{
  const f=await fixture(t),supplier=f.service.saveSupplier({name:'Fornecedor teste',phone:'5511999999999'},'owner'),item=f.product({kind:'accessory',model:'Cabo USB',quantity:2,costCents:100,retailCents:200});
  f.service.recordPurchase({supplierId:supplier.id,items:[{inventoryId:item.id,quantity:1,unitCostCents:101}],idempotencyKey:'buy'},'owner');assert.equal(f.service.listInventory()[0].costBasisTotalCents,301);
  const one=f.service.createSale(sale(item,{quantity:1,payments:[{method:'pix',amountCents:200}]}),'owner'),two=f.service.createSale(sale(item,{quantity:2,payments:[{method:'pix',amountCents:400}]}),'owner');assert.equal(one.costCents,100);assert.equal(two.costCents,201);assert.equal(one.costCents+two.costCents,301);assert.equal(f.service.listInventory()[0].quantity,0);
  f.service.cancelSale({saleId:two.id,reason:'Devolução',idempotencyKey:'cancel'},'owner');f.service.returnStock({saleId:two.id,quantity:1,reason:'Primeiro cabo',idempotencyKey:'return1'},'owner');f.service.returnStock({saleId:two.id,quantity:1,reason:'Segundo cabo',idempotencyKey:'return2'},'owner');assert.equal(f.service.listInventory()[0].costBasisTotalCents,201);
});

test('editing unchanged average cost preserves pool residual and recorded cost revaluation remains audited',async t=>{
  const f=await fixture(t),supplier=f.service.saveSupplier({name:'Fornecedor teste',phone:'5511999999999'},'owner'),item=f.product({kind:'accessory',model:'Cabo USB',quantity:2,costCents:100,retailCents:200});
  f.service.recordPurchase({supplierId:supplier.id,items:[{inventoryId:item.id,quantity:1,unitCostCents:101}],idempotencyKey:'buy'},'owner');
  const original=f.service.getInventory(item.id),edited=f.service.saveInventory({...original,color:'Preto',costCents:100},'owner');assert.equal(edited.costBasisTotalCents,301);
  const revalued=f.service.saveInventory({...edited,costCents:110},'owner');assert.equal(revalued.costBasisTotalCents,330);const event=f.store.listEntities('sale_events').find(e=>e.kind==='inventory.edited'&&e.costBasisTotalCents===330);assert.equal(event.previousCostBasisTotalCents,301);
  const audits=f.store.listEntities('audit');assert.ok(audits.length>0);assert.equal(audits.some(e=>e.details?.costBasisTotalCents!==undefined),false);
});

test('known credit-card fee on deposit cannot be removed from sale and remaining cost average follows exact pool',async t=>{
  const f=await fixture(t),item=f.product({retailCents:100000});const reservation=f.service.reserve({inventoryId:item.id,buyerName:'Ana',expiresAt:f.clock.at+10000,depositCents:20000,depositFeeCents:1000,paymentMethod:'credit',idempotencyKey:'reserve'},'owner');
  assert.throws(()=>f.service.createSale(sale(item,{reservationId:reservation.id,buyerName:'Ana',feesCents:0}),'owner'),/taxa total/);
  const sold=f.service.createSale(sale(item,{reservationId:reservation.id,buyerName:'Ana',payments:[{method:'pix',amountCents:80000}]}),'owner');assert.equal(sold.feesCents,1000);
  const cable=f.product({kind:'accessory',model:'Cabo',quantity:3,costCents:100,retailCents:200});f.store.saveEntity('inventory',{...cable,costBasisTotalCents:301});f.service.createSale(sale(cable,{quantity:1}),'owner');assert.equal(f.service.getInventory(cable.id).costBasisTotalCents,201);assert.equal(f.service.getInventory(cable.id).costCents,101);
});

test('historical cash report excludes later receipts and future close count/difference',async t=>{
  const f=await fixture(t);f.clock.at=Date.parse('2026-10-04T15:00:00Z');const opened=f.service.openCash({initialCashCents:20000,idempotencyKey:'cash'},'owner');
  f.clock.at=Date.parse('2026-10-05T15:00:00Z');f.service.addCashMovement({direction:'in',kind:'float',amountCents:3000,description:'Reforço hoje',idempotencyKey:'float'},'owner');f.service.closeCash({sessionId:opened.id,countedCashCents:23000,idempotencyKey:'close'},'owner');
  const yesterday=f.service.dailyReport('2026-10-04').cashSessions[0];assert.equal(yesterday.expectedCashCents,20000);assert.equal(yesterday.status,'open');assert.equal(Object.hasOwn(yesterday,'countedCashCents'),false);const today=f.service.dailyReport('2026-10-05').cashSessions[0];assert.equal(today.expectedCashCents,23000);assert.equal(today.differenceCents,0);
});

test('direct expense correction creates exact cash reversal without double-counting a general expense',async t=>{
  const f=await fixture(t),item=f.product({costCents:60000,retailCents:100000});f.service.openCash({initialCashCents:10000,idempotencyKey:'cash'},'owner');const sold=f.service.createSale(sale(item,{payments:[{method:'pix',amountCents:100000}],directExpensesCents:2000,directExpenseMethod:'cash'}),'owner');assert.equal(f.service.snapshot({financial:true}).cashSessions[0].expectedCashCents,8000);
  const corrected=f.service.correctSale({saleId:sold.id,directExpensesCents:1000,reason:'Reembolso de despesa confirmado',idempotencyKey:'correction'},'owner');assert.equal(corrected.realizedProfitCents,39000);assert.equal(f.service.snapshot({financial:true}).cashSessions[0].expectedCashCents,9000);assert.equal(f.service.dailyReport('2026-10-05').generalExpensesCents,0);
});

test('safe public stock omits cost pool, supplier, serial, IMEI and internal notes; unknown cost stays unknown',async t=>{
  const f=await fixture(t),item=f.product({costCents:null,imei:'123456789012345',serial:'SERIAL-TESTE',notes:'Observação interna'}),publicItem=f.service.snapshot({financial:false}).inventory[0];for(const key of ['costCents','costBasisTotalCents','imei','serial','notes','supplierId'])assert.equal(Object.hasOwn(publicItem,key),false);
  const sold=f.service.createSale(sale(item,{payments:[{method:'pix',amountCents:350000}]}),'owner');assert.equal(sold.costCents,null);assert.equal(sold.estimatedProfitCents,null);assert.equal(sold.realizedProfitCents,null);assert.equal(f.service.dailyReport('2026-10-05').unknownCostCount,1);
});

test('commercial reports filter audience/product/campaign and never invent campaign attribution',async t=>{
  const f=await fixture(t),a=f.product(),b=f.product({model:'Galaxy S24',retailCents:200000,wholesaleCents:180000,costCents:100000});f.service.createSale(sale(a,{payments:[{method:'pix',amountCents:350000}]}),'owner');f.service.createSale(sale(b,{audience:'wholesale',payments:[{method:'pix',amountCents:180000}]}),'owner');
  const all=f.service.periodReports({from:'2026-10-05',to:'2026-10-05'});assert.equal(all.saleCount,2);assert.equal(all.totalCents,530000);assert.equal(all.ticketAverageCents,265000);assert.equal(all.byCampaign[0].id,'unattributed');
  const filtered=f.service.periodReports({from:'2026-10-05',to:'2026-10-05',audience:'wholesale',inventoryId:b.id});assert.equal(filtered.saleCount,1);assert.equal(filtered.totalCents,180000);
});

test('financial records remain isolated between simulated and real modes and ordinary history cleanup preserves ledger',async t=>{
  const f=await fixture(t),item=f.product();f.service.createSale(sale(item),'owner');f.store.setSetting('integrationMode','simulated');assert.equal(f.service.listSales().length,0);assert.equal(f.service.listInventory().length,0);const sim=f.product({model:'Produto fictício'});f.service.createSale(sale(sim),'owner');assert.equal(f.service.listSales().length,1);
  f.store.setSetting('integrationMode','whatsapp');assert.equal(f.service.listSales()[0].productSnapshot.model,'iPhone 15 Pro Max');const events=f.store.listEntities('sale_events').length;f.store.clearHistories?.({categories:['campaigns','sends','errors','notifications']});assert.equal(f.service.listSales().length,1);assert.equal(f.store.listEntities('sale_events').length,events);
});

test('stale sale version, invalid money, unknown buyer and duplicate individual device identifiers reject',async t=>{
  const f=await fixture(t),item=f.product({imei:'123456789012345'});assert.throws(()=>f.product({imei:'123456789012345'}),{code:'STOCK_IDENTIFIER_DUPLICATE'});assert.throws(()=>f.service.createSale(sale(item,{buyerId:'not-real'}),'owner'),{code:'BUYER_NOT_FOUND'});assert.throws(()=>f.service.createSale(sale(item,{unitPriceCents:10.5}),'owner'),/centavos inteiros/);const sold=f.service.createSale(sale(item),'owner');
  assert.throws(()=>f.service.cancelSale({saleId:sold.id,expectedVersion:99,reason:'Desatualizado',idempotencyKey:'wrong-version'},'owner'),{code:'SALE_VERSION_CONFLICT'});
  assert.equal(dateKey(Date.parse('2026-10-05T02:59:59Z')),'2026-10-04');assert.equal(dateKey(Date.parse('2026-10-05T03:00:00Z')),'2026-10-05');
});

test('sale and reservation mark linked scheduled stock advertisement for review within the same transaction',async t=>{
  const f=await fixture(t),item=f.product();f.store.saveCampaign({id:'campaign-stock',name:'Anúncio',state:'draft',groupIds:[],items:[{id:'ad',kind:'text',text:'iPhone disponível',commercialRef:{lines:[{sourceType:'inventory',sourceId:item.id}]}}]});
  f.service.createSale(sale(item),'owner');const campaign=f.store.getCampaign('campaign-stock');assert.equal(campaign.commercialReviewRequired,true);assert.match(campaign.commercialReviewReason,/vendido/);
});

test('snapshot bounds recent financial history while sale payments, cash balance and full reports retain every record',async t=>{
  const f=await fixture(t),item=f.product({kind:'accessory',model:'Cabo',quantity:260,costCents:60,retailCents:100});
  const session=f.service.openCash({initialCashCents:1000,idempotencyKey:'cash'},'owner');
  const first=f.service.createSale(sale(item,{payments:[{method:'cash',amountCents:40},{method:'cash',amountCents:60}]}),'owner');
  const originalMovements=f.store.listEntities('cash_movements');
  f.store.transaction(()=>{
    for(let i=1;i<260;i++){
      const id=`fixture-sale-${i}`,at=f.clock.at+i;
      f.store.saveEntity('sales',{...first,id,createdAt:at,soldAt:at,payments:[]});
      first.payments.forEach((p,index)=>f.store.saveEntity('sale_payments',{...p,id:`fixture-payment-${i}-${index}`,saleId:id,createdAt:at,receivedAt:at}));
      originalMovements.forEach((m,index)=>f.store.saveEntity('cash_movements',{...m,id:`fixture-movement-${i}-${index}`,saleId:id,paymentId:`fixture-payment-${i}-${index}`,createdAt:at,occurredAt:at}));
    }
  });
  const originalList=f.store.listEntities,lookups=[];
  f.store.listEntities=function(table,filter={}){if(table==='sale_payments')lookups.push(filter);return originalList.call(this,table,filter);};
  const snapshot=f.service.snapshot({financial:true});
  assert.equal(snapshot.sales.length,250);assert.equal(snapshot.cashMovements.length,500);assert.equal(snapshot.sales.some(s=>s.id===first.id),false);
  assert.deepEqual(snapshot.historyWindow.sales,{total:260,shown:250,limit:250});assert.deepEqual(snapshot.historyWindow.cashMovements,{total:520,shown:500,limit:500});
  assert.equal(snapshot.cashSessions.find(s=>s.id===session.id).expectedCashCents,27000);assert(snapshot.sales.every(s=>s.paidCents===100&&s.payments.length===2));
  assert.equal(lookups.length,1);assert.equal(lookups[0].saleIds.length,250);
  assert.equal(f.service.listSales().length,260);
  const daily=f.service.dailyReport('2026-10-05');assert.equal(daily.saleCount,260);assert.equal(daily.totalCents,26000);assert.equal(daily.receivedCents,26000);assert.equal(daily.movements.length,520);
  const period=f.service.periodReports({from:'2026-10-05',to:'2026-10-05'});assert.equal(period.saleCount,260);assert.equal(period.totalCents,26000);
  assert.equal(f.service.snapshot({financial:false}).historyWindow,null);
});

test('campaign report separates period-recorded interest from actual orders without inferred attribution',async t=>{
  const f=await fixture(t),item=f.product();
  for(const id of ['campaign-sale','campaign-interest'])f.store.saveCampaign({id,name:id,state:'draft',groupIds:[],items:[]});
  f.service.createSale(sale(item,{campaignId:'campaign-sale'}),'owner');
  for(const [id,campaignId,createdAt]of [['linked-sale','campaign-sale',f.clock.at],['linked-interest','campaign-interest',f.clock.at],['old','campaign-interest',f.clock.at-86400000],['unlinked',null,f.clock.at]])f.store.saveEntity('buyer_demands',{id,campaignId,createdAt,status:'searching'});
  const report=f.service.periodReports({from:'2026-10-05',to:'2026-10-05'}),sold=report.byCampaign.find(r=>r.id==='campaign-sale'),interest=report.byCampaign.find(r=>r.id==='campaign-interest');
  assert.equal(sold.orderCount,1);assert.equal(sold.interestedCount,1);assert.equal(interest.orderCount,0);assert.equal(interest.interestedCount,1);assert.equal(report.saleCount,1);
  const filtered=f.service.periodReports({from:'2026-10-05',to:'2026-10-05',campaignId:'campaign-interest'});assert.equal(filtered.saleCount,0);assert.equal(filtered.byCampaign.length,1);assert.equal(filtered.byCampaign[0].interestedCount,1);
  assert.equal(f.service.periodReports({from:'2026-10-05',to:'2026-10-05',audience:'retail'}).byCampaign[0].interestedCount,0);
});

test('financial lookup indexes exist on fresh, current and migrated stores and select only related mode-scoped records',async t=>{
  const f=await fixture(t),indexes=['sales_mode_created','sale_payments_sale','sale_payments_reservation','cash_movements_session','cash_movements_mode_created'];
  f.store.saveEntity('sale_payments',{id:'related',saleId:'sale-a',reservationId:'reservation-a',createdAt:1});
  f.store.saveEntity('sale_payments',{id:'other',saleId:'sale-b',reservationId:'reservation-b',createdAt:2});
  f.store.saveEntity('cash_movements',{id:'cash-a',cashSessionId:'session-a',createdAt:1});
  f.store.saveEntity('cash_movements',{id:'cash-b',cashSessionId:'session-b',createdAt:2});
  for(const version of [null,8,7]){
    if(version!==null){
      const raw=new DatabaseSync(f.store.filename);for(const name of indexes)raw.exec(`DROP INDEX ${name}`);raw.exec(`PRAGMA user_version=${version}`);raw.close();await f.reopen();
    }
    const raw=new DatabaseSync(f.store.filename,{readOnly:true});
    try{
      const present=new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r=>r.name));for(const name of indexes)assert(present.has(name));
      const plan=raw.prepare("EXPLAIN QUERY PLAN SELECT data FROM sale_payments WHERE storageMode=? AND json_extract(data,'$.saleId') IN(?) ORDER BY createdAt DESC,rowid DESC").all('whatsapp','sale-a');assert(plan.some(row=>row.detail.includes('sale_payments_sale')));
    }finally{raw.close();}
    assert.deepEqual(f.store.listEntities('sale_payments',{saleIds:['sale-a']}).map(r=>r.id),['related']);
    assert.deepEqual(f.store.listEntities('sale_payments',{reservationIds:['reservation-a']}).map(r=>r.id),['related']);
    assert.deepEqual(f.store.listEntities('cash_movements',{cashSessionId:'session-a'}).map(r=>r.id),['cash-a']);
    assert.deepEqual(f.store.listEntities('sale_payments',{saleIds:[]}),[]);
  }
  f.store.setSetting('integrationMode','simulated');assert.deepEqual(f.store.listEntities('sale_payments',{saleIds:['sale-a']}),[]);
});
