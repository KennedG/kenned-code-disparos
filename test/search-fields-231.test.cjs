'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseOffers,parseQuery,rankOffers}=require('../src/core/search-parser.cjs');
const {offerRow}=require('../src/core/search-excel.cjs');

test('explicit RAM never becomes storage and available fields reach Excel without inventing missing ones',()=>{
  for(const memory of ['8GB RAM','RAM: 8GB','Memória RAM: 8 GB']){
    const [offer]=parseOffers(`Samsung S24 Ultra 256GB ${memory} Black lacrado R$ 5.000,00`);
    assert.equal(offer.storageGB,256);assert.equal(offer.ramGB,8);assert.equal(offer.confidence,'confirmed');
    const row=offerRow(offer,'America/Sao_Paulo');assert.equal(row.ramGB,8);assert.equal(row.storageGB,256);assert.equal(row.category,'');
    assert.equal(rankOffers([{...offer,messageAt:Date.now(),supplierKey:'supplier'}],parseQuery('Samsung S24 Ultra 256GB')).length,1);
  }
  const [unknown]=parseOffers('iPhone 15 Pro Max 256GB Azul R$ 3.850,00');
  assert.equal(unknown.ramGB,null);assert.equal(unknown.category,null);
});
test('RAM observations and literal category apply to the corresponding phone only',()=>{
  const offers=parseOffers('Samsung S24 Ultra 256GB Preto R$ 5.000,00\nRAM: 12GB\nCategoria: smartphones\niPhone 15 Pro Max 256GB Azul R$ 3.850,00');
  assert.equal(offers.length,2);assert.equal(offers[0].ramGB,12);assert.equal(offers[0].category,'smartphones');
  assert.equal(offers[1].ramGB,null);assert.equal(offers[1].category,null);
  assert.match(offers[0].originalExcerpt,/RAM: 12GB/);assert.match(offers[0].originalExcerpt,/Categoria: smartphones/);
});
test('virtual or contradictory RAM is not silently treated as confirmed physical memory',()=>{
  const [virtual]=parseOffers('Samsung S24 Ultra 256GB RAM: 8GB virtual R$ 5.000');
  assert.equal(virtual.storageGB,256);assert.equal(virtual.ramGB,null);
  const [ambiguous]=parseOffers('Samsung S24 Ultra 256GB 8GB RAM ou 12GB RAM R$ 5.000');
  assert.equal(ambiguous.storageGB,256);assert.equal(ambiguous.confidence,'review');assert(ambiguous.reviewReasons.includes('ambiguous_ram'));
  assert.deepEqual(rankOffers([{...ambiguous,supplierKey:'supplier'}],parseQuery('Samsung S24 Ultra 256GB')),[]);
});
