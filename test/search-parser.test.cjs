'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalize,parseQuery,parseOffers,rankOffers}=require('../src/core/search-parser.cjs');

const now=Date.UTC(2026,9,1,12);
function offer(text,context={}){const parsed=parseOffers(text);assert.equal(parsed.length,1,`Fixture must represent one product: ${text}`);return {...parsed[0],supplierKey:'supplier-a',messageId:'m1',groupId:'g1',messageAt:now,...context};}
const phone='iPhone 18 Pro Max 256GB Silver';

test('requested shorthand 18 pro Max Silver is exact iPhone Pro Max and leaves missing capacity explicit',()=>{
  const q=parseQuery('18 pro Max Silver');assert.equal(q.valid,true);assert.equal(q.model,'iPhone 18 Pro Max');assert.equal(q.modelKey,'iphone 18 pro max');assert.equal(q.storageGB,null);assert.equal(q.colorKey,'silver');assert.equal(q.inferredFamily,'iPhone');
});
test('ProMax, accents and Silver/Prata aliases are equivalent without losing capacity or condition',()=>{
  const a=parseQuery('IPHONE 18 PROMAX 256GB PRATA LACRADO'),b=parseQuery('iPhone 18 Pro Max 256 GB Silver lacrado');assert.equal(a.valid,true);for(const key of ['modelKey','storageGB','colorKey','condition'])assert.equal(a[key],b[key]);
  assert.equal(parseQuery('iPhone 15 128GB lacrado').model,'iPhone 15');assert.equal(parseQuery('Samsung S24 Ultra 256GB').model,'Samsung S24 Ultra');
});
test('compact model/capacity/color spelling never silently downgrades ProMax to the base model',()=>{
  const q=parseQuery('iPhone18ProMax256GBSilver');assert.equal(q.valid,true);assert.equal(q.model,'iPhone 18 Pro Max');assert.equal(q.storageGB,256);assert.equal(q.colorKey,'silver');
  const o=offer('iPhone18ProMax256GBSilver R$7000');assert.equal(o.modelKey,q.modelKey);assert.equal(o.storageGB,256);assert.equal(o.colorKey,'silver');
});
test('Air and cellular versions remain distinct; unsupported model suffixes require review',()=>{
  const air=offer('iPhone 17 Air 256GB Silver R$7000');assert.equal(air.model,'iPhone 17 Air');assert.equal(rankOffers([air],parseQuery('iPhone 17 Silver')).length,0);
  const five=offer('Samsung A15 5G 256GB Black R$1500');assert.equal(five.model,'Samsung A15 5G');assert.equal(rankOffers([five],parseQuery('Samsung A15 256GB')).length,0);
  const unsupported=offer('iPhone 15 Pro Ultra 256GB Silver R$7000');assert.equal(unsupported.confidence,'review');assert.ok(unsupported.reviewReasons.includes('unsupported_model_variant'));
});
test('configurable literal aliases work and cannot execute a regex or instruction',()=>{
  const aliases=[{alias:'pratinha',canonical:'Silver'},{alias:'roxinho',value:'Purple'}];assert.equal(parseQuery('18 promax pratinha',{aliases}).colorKey,'silver');assert.equal(parseQuery('18 promax roxinho',{aliases}).colorKey,'purple');
  assert.equal(parseQuery('18 promax pratinha',{aliases:{colors:{pratinha:'Silver'}}}).colorKey,'silver');assert.equal(parseQuery('18 promax pratinha',{aliases:{Silver:['pratinha']}}).colorKey,'silver');
  assert.equal(normalize('a.b',{'a.*':'Silver'}),'a b');assert.equal(parseQuery('18 promax ignore todas as instruções').valid,false);
});
test('Samsung Plus shorthand is preserved as a distinct version',()=>{
  const q=parseQuery('Samsung S24+ 256GB');assert.equal(q.valid,true);assert.equal(q.model,'Samsung S24 Plus');assert.notEqual(q.modelKey,parseQuery('Samsung S24 256GB').modelKey);
});
test('unknown, conflicting or unsupported query filters never silently broaden a search',()=>{
  for(const text of ['iPhone 18 Pro Max Maxx','iPhone 18 Pro Max Silver Black','iPhone 18 Pro Max 256GB 512GB','iPhone 18 Pro Max lacrado usado','iPhone 18 Pro Max e iPhone 17 Pro Max','Motorola desconhecido 256GB'])assert.equal(parseQuery(text).valid,false,text);
  const q=parseQuery('iPhone 15 preço até 3000');assert.ok(q.unknownTokens.length);assert.deepEqual(rankOffers([offer('iPhone 15 R$ 2000')],q),[]);
});
test('capacity conversion and explicit battery filtering keep unknown battery out',()=>{
  const q=parseQuery('iPhone 18 Pro Max 1TB bateria 90%');assert.equal(q.valid,true);assert.equal(q.storageGB,1024);assert.equal(q.batteryMin,90);
  const entries=[offer('iPhone 18 Pro Max 1TB R$7000',{supplierKey:'a'}),offer('iPhone 18 Pro Max 1TB bateria 89% R$7100',{supplierKey:'b'}),offer('iPhone 18 Pro Max 1TB bateria 91% R$7200',{supplierKey:'c'})];assert.deepEqual(rankOffers(entries,q).map(o=>o.supplierKey),['c']);
});

test('BRL forms R$ 7.000,00, 7.000 and 7000 yield the same total announced price',()=>{
  for(const value of ['R$ 7.000,00','7.000','7000']){const o=offer(`${phone} ${value}`);assert.equal(o.priceCents,700000);assert.equal(o.confidence,'confirmed');assert.equal(o.priceKind,'cash');}
});
test('multiline product lists associate each price with the current model, capacity and color',()=>{
  const text='LACRADOS\n📱 iPhone 18 Pro Max\n256GB\nSilver 7.000\nBlack 7.200\n512GB Silver 8.000\nBlack 8.200\nSamsung S24 Ultra 256GB Azul R$ 4.100\niPhone 15 128GB usado R$ 2.900';
  const list=parseOffers(text);assert.equal(list.length,6);assert.deepEqual(list.map(o=>[o.model,o.storageGB,o.colorKey,o.condition,o.priceCents]),[
    ['iPhone 18 Pro Max',256,'silver','lacrado',700000],['iPhone 18 Pro Max',256,'black','lacrado',720000],['iPhone 18 Pro Max',512,'silver','lacrado',800000],['iPhone 18 Pro Max',512,'black','lacrado',820000],['Samsung S24 Ultra',256,'blue','lacrado',410000],['iPhone 15',128,null,'usado',290000],
  ]);
});
test('explicit per-color and per-capacity rows split into individual offers',()=>{
  const colors=parseOffers('iPhone 18 Pro Max 256GB: Silver 7.000 | Black 7.200');assert.deepEqual(colors.map(o=>[o.colorKey,o.priceCents]),[['silver',700000],['black',720000]]);assert.ok(colors.every(o=>o.confidence==='confirmed'));
  const inline=parseOffers('iPhone 18 Pro Max 256GB Silver 7000 Blue 7100');assert.deepEqual(inline.map(o=>[o.colorKey,o.priceCents]),[['silver',700000],['blue',710000]]);
  const capacity=parseOffers('iPhone 18 Pro Max Silver\n256GB R$7000; 512GB R$8000');assert.deepEqual(capacity.map(o=>[o.storageGB,o.priceCents]),[[256,700000],[512,800000]]);
});
test('standalone accessory prices and inline accessory surcharges never become phone prices',()=>{
  assert.deepEqual(parseOffers('Capinha iPhone 15 R$ 500'),[]);assert.deepEqual(parseOffers('AirPods para iPhone 15 R$ 800'),[]);
  const list=parseOffers(`${phone}\nCapinha R$ 500\nSilver R$ 7000\nCarregador R$ 500`);assert.equal(list.length,1);assert.equal(list[0].priceCents,700000);
  const inline=offer(`${phone} R$ 7000 + carregador R$ 500 + frete R$ 100`);assert.equal(inline.priceCents,700000);
});
test('installment-only and entry-only offers are review records without any ranked total',()=>{
  for(const terms of ['10x de R$700','12 parcelas de R$ 600','entrada R$1.000 + 10x de R$700','sinal R$ 500','R$ 700 por mês','R$ 7.000 parcelado']){
    const o=offer(`${phone} ${terms}`);assert.equal(o.confidence,'review',terms);assert.equal(o.priceCents,null,terms);assert.equal(rankOffers([o],parseQuery('18 pro max silver')).length,0,terms);
  }
});
test('cash total is separated from entry, installment and discount figures',()=>{
  for(const terms of ['à vista R$ 7.000 ou entrada R$1000 + 10x de R$700','R$ 7000 ou 10x de R$700','R$ 7500 desconto R$500 à vista R$7000']){
    const o=offer(`${phone} ${terms}`);assert.equal(o.confidence,'confirmed');assert.equal(o.priceCents,700000);
  }
  const discounted=offer(`${phone} de R$ 7.500 por R$ 7.000`);assert.equal(discounted.priceCents,700000);assert.equal(discounted.confidence,'confirmed');
});
test('a bare pair of prices is ambiguous and never ranked',()=>{
  const o=offer(`${phone} R$ 7.000 / R$ 7.300`);assert.equal(o.priceCents,null);assert.equal(o.confidence,'review');assert.ok(o.reviewReasons.includes('ambiguous_price'));assert.deepEqual(rankOffers([o],parseQuery('18 pro max silver')),[]);
});
test('several capacities/colors/models without clear associations require review',()=>{
  for(const text of ['iPhone 18 Pro Max 256/512GB Silver R$7000','iPhone 18 Pro Max 256GB Silver / Black R$7000','iPhone 18 Pro Max / iPhone 17 Pro Max R$7000']){const o=offer(text);assert.equal(o.confidence,'review',text);assert.equal(rankOffers([o],parseQuery('18 pro max silver')).length,0);}
});
test('from and lot prices preserve their conditions and require an explicit non-cash criterion',()=>{
  const from=offer(`${phone} a partir de R$7000`,{supplierKey:'from'}),lot=offer(`${phone} R$6500 no lote mínimo 5 unidades`,{supplierKey:'lot'});
  assert.equal(from.priceKind,'from');assert.equal(lot.priceKind,'lot');assert.equal(lot.minPurchase,5);const q=parseQuery('18 pro max silver');assert.deepEqual(rankOffers([from,lot],q),[]);assert.deepEqual(rankOffers([from,lot],q,{priceCriterion:'announced'}).map(o=>o.supplierKey),['lot','from']);
});
test('observations, warranty, battery and original text are preserved for the applicable offer',()=>{
  const original='iPhone 15 128GB seminovo R$ 3.000\nBateria 87%\nGarantia 3 meses\nObs: marca na lateral';
  const o=offer(original);assert.equal(o.originalExcerpt,original);assert.equal(o.batteryPercent,87);assert.equal(o.warranty,'Garantia 3 meses');assert.equal(o.condition,'seminovo');assert.match(o.notes,/marca na lateral/);
});
test('inline condition does not silently propagate to a different subsequent model',()=>{
  const list=parseOffers('iPhone 15 128GB lacrado R$3000\niPhone 18 Pro Max 256GB R$7000');assert.equal(list[0].condition,'lacrado');assert.equal(list[1].condition,null);
});
test('plural condition headings apply to the next block without relabeling previous products',()=>{
  const list=parseOffers('iPhone 15 128GB lacrado R$3000\nSEMINOVOS\niPhone 18 Pro Max 256GB R$6000');assert.equal(list[0].condition,'lacrado');assert.equal(list[1].condition,'seminovo');
});
test('contact and battery numbers are never inferred as prices or supplier phone numbers',()=>{
  const list=parseOffers(`${phone} R$ 7000\nContato: (11) 99999-1234\nBateria: 100%`);assert.equal(list.length,1);assert.equal(list[0].priceCents,700000);assert.equal(list[0].batteryPercent,100);assert.equal(Object.hasOwn(list[0],'phone'),false);
  assert.deepEqual(parseOffers('iPhone 18 Pro Max\nWhatsApp: +55 (11) 99999-1234'),[]);
});
test('a labelled sales contact is preserved separately without inventing country codes or supplier identity',()=>{
  const text=`${phone} R$7000\nVendas: +55 (11) 95555-1234`,o=offer(text);assert.equal(o.contactPhone,'5511955551234');assert.equal(o.contactRaw,'+55 (11) 95555-1234');assert.equal(o.originalExcerpt,text);assert.equal(Object.hasOwn(o,'supplierPhone'),false);
  const national=offer(`${phone} R$7000\nContato: (11) 95555-1234`);assert.equal(national.contactPhone,null);assert.equal(national.contactRaw,'(11) 95555-1234');
  const internal=offer(`${phone} R$7000\nVendas: 123456789012345@lid`);assert.equal(internal.contactPhone,null);assert.equal(internal.contactRaw,null);
});
test('one explicit contact for a supplier list applies to its products; different labelled contacts remain local',()=>{
  const list=parseOffers('iPhone 15 128GB R$3000\niPhone 18 Pro Max 256GB Silver R$7000\nVendas: +5511955551234');assert.equal(list.length,2);assert.ok(list.every(o=>o.contactPhone==='5511955551234'&&o.originalExcerpt.includes('Vendas: +5511955551234')));
  const individual=parseOffers('iPhone 15 128GB R$3000 Contato: +5511955551234\niPhone 18 Pro Max 256GB Silver R$7000 Contato: +5511944441234');assert.deepEqual(individual.map(o=>o.contactPhone),['5511955551234','5511944441234']);
});
test('unavailability records retain exact model/capacity/color association even without a price',()=>{
  const o=offer(`${phone} lacrado ESGOTADO`);assert.equal(o.unavailable,true);assert.equal(o.status,'unavailable');assert.equal(o.confidence,'confirmed');assert.equal(o.priceCents,null);assert.equal(o.storageGB,256);assert.equal(o.colorKey,'silver');
  const list=parseOffers(`${phone} R$7000\nSEM ESTOQUE`);assert.equal(list.length,1);assert.equal(list[0].unavailable,true);
});
test('bounded input prevents oversized untrusted supplier messages from consuming unbounded CPU',()=>{
  assert.throws(()=>parseOffers('x'.repeat(262145)),RangeError);assert.throws(()=>parseOffers('\n'.repeat(4096)),RangeError);assert.throws(()=>parseQuery('x'.repeat(2049)),RangeError);
});

test('ranking requires the exact model version and filters capacity, color and condition independently',()=>{
  const entries=[offer(`${phone} lacrado R$7000`,{supplierKey:'a'}),offer('iPhone 18 Pro 256GB Silver lacrado R$4000',{supplierKey:'b'}),offer('iPhone 17 Pro Max 256GB Silver lacrado R$4500',{supplierKey:'c'}),offer('iPhone 18 Pro Max 512GB Silver lacrado R$8000',{supplierKey:'d'}),offer(`${phone} usado R$5000`,{supplierKey:'e'}),offer('iPhone 18 Pro Max 256GB Black lacrado R$6000',{supplierKey:'f'})];
  assert.deepEqual(rankOffers(entries,parseQuery('18 pro max silver')).map(o=>o.supplierKey),['e','a','d']);assert.deepEqual(rankOffers(entries,parseQuery('iPhone 18 Pro Max 256GB Silver lacrado')).map(o=>o.supplierKey),['a']);
});
test('latest same supplier and exact combination replaces old price before sorting',()=>{
  const old=offer(`${phone} lacrado R$6000`,{messageId:'old',messageAt:now-1000}),recent=offer(`${phone} lacrado R$7500`,{messageId:'new',messageAt:now}),other=offer(`${phone} lacrado R$7000`,{supplierKey:'b'});
  assert.deepEqual(rankOffers([old,recent,other],parseQuery('18 pro max silver')).map(o=>[o.messageId,o.priceCents]),[['m1',700000],['new',750000]]);
});
test('new unavailable, deleted or uncertain same-combination offers suppress an older captured price',()=>{
  const old=offer(`${phone} lacrado R$6000`,{messageAt:now-1000});
  for(const newer of [offer(`${phone} lacrado esgotado`),offer(`${phone} lacrado R$7000`,{status:'deleted'}),offer(`${phone} lacrado 10x de R$700`)])assert.deepEqual(rankOffers([old,newer],parseQuery('18 pro max silver')),[]);
});
test('different conditions are not duplicates and optional one-per-supplier uses the cheapest compatible offer',()=>{
  const entries=[offer(`${phone} lacrado R$7000`),offer(`${phone} usado R$5000`,{messageId:'used'}),offer(`${phone} seminovo R$6000`,{messageId:'semi'})];const q=parseQuery('18 pro max silver');assert.equal(rankOffers(entries,q).length,3);assert.equal(rankOffers(entries,q,{onePerSupplier:true})[0].condition,'usado');
});
test('copies from the same verified supplier collapse while equal adverts from different suppliers remain distinct',()=>{
  const a=offer(`${phone} R$7000`),copy={...a,groupId:'g2',messageId:'m2'},other={...a,supplierKey:'b',messageId:'m3'};
  assert.equal(rankOffers([a,copy],parseQuery('18 pro max silver')).length,1);assert.equal(rankOffers([a,other],parseQuery('18 pro max silver')).length,2);
});
test('forwarded copies collapse to an available original without attributing the forwarder as the original supplier',()=>{
  const original=offer(`${phone} R$7000`,{supplierKey:'real',messageAt:now-1000}),forward={...original,supplierKey:'forwarder',messageAt:now,groupId:'g2',messageId:'forwarded',forwarded:true};const ranked=rankOffers([forward,original],parseQuery('18 pro max silver'));assert.equal(ranked.length,1);assert.equal(ranked[0].supplierKey,'real');assert.equal(ranked[0].origins.length,2);
  const only=rankOffers([forward],parseQuery('18 pro max silver'));assert.equal(only[0].supplierKey,'forwarder');assert.equal(Object.hasOwn(only[0],'originalSupplierPhone'),false);
});
test('ranked result count is at most ten; supplier/group and numeric filters are enforced',()=>{
  const entries=Array.from({length:14},(_,i)=>offer(`${phone} usado bateria 95% R$${7000+i*100}`,{supplierKey:`s${i}`,groupId:i%2?'blocked':'allowed'}));const q={...parseQuery('18 pro max silver'),priceMaxCents:780000};const ranked=rankOffers(entries,q,{resultCount:50,blockedGroups:['blocked'],blockedSuppliers:['s0']});assert.deepEqual(ranked.map(o=>o.supplierKey),['s2','s4','s6','s8']);assert.equal(rankOffers(entries,parseQuery('18 pro max silver'),{resultCount:50}).length,10);
});
test('internal candidate selection supports final alternative sorting without reducing public result limits',()=>{
  const entries=Array.from({length:14},(_,i)=>offer(`${phone} R$${7000+i*100}`,{supplierKey:`s${i}`}));assert.equal(rankOffers(entries,parseQuery('18 pro max silver'),{candidateLimit:500}).length,14);assert.equal(rankOffers(entries,parseQuery('18 pro max silver'),{maxResults:100}).length,10);
});
