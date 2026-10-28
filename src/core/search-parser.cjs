'use strict';

// This module deliberately uses a small deterministic grammar. Supplier text is
// data: it cannot change this grammar, the query or application permissions.
const { createHash } = require('node:crypto');
const MAX_TEXT = 262144;
const COLOR_LABELS = {
  silver:'Silver', black:'Preto', white:'Branco', blue:'Azul', green:'Verde',
  pink:'Rosa', purple:'Roxo', red:'Vermelho', yellow:'Amarelo', gold:'Dourado',
  gray:'Cinza', graphite:'Grafite', midnight:'Meia-noite', starlight:'Estelar',
  'natural titanium':'Titânio natural', 'black titanium':'Titânio preto',
  'white titanium':'Titânio branco', 'blue titanium':'Titânio azul',
  'desert titanium':'Titânio deserto', 'space gray':'Cinza espacial',
};
const BUILTIN_ALIASES = {
  prata:'silver', preto:'black', negra:'black', branco:'white', azul:'blue',
  verde:'green', rosa:'pink', roxo:'purple', vermelho:'red', amarelo:'yellow',
  dourado:'gold', cinza:'gray', grey:'gray', grafite:'graphite',
  'meia noite':'midnight', estelar:'starlight', 'cinza espacial':'space gray',
  'titanio natural':'natural titanium', 'titanio preto':'black titanium',
  'titanio branco':'white titanium', 'titanio azul':'blue titanium',
  'titanio deserto':'desert titanium', 'titanium natural':'natural titanium',
  'titanium black':'black titanium', 'titanium white':'white titanium',
  'titanium blue':'blue titanium', 'titanium desert':'desert titanium',
  'semi novo':'seminovo', 'semi nova':'seminovo', seminova:'seminovo',
  selado:'lacrado', selada:'lacrado', lacrada:'lacrado', usada:'usado',
  lacrados:'lacrado', seminovos:'seminovo', usados:'usado',
};
const COLORS = Object.keys(COLOR_LABELS).sort((a,b)=>b.length-a.length);
const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(s\s*\d{1,2})\s*\+/g,'$1 plus').replace(/([a-z])(?=\d)/g,'$1 ').replace(/(\d)(?=[a-z])/g,'$1 ').replace(/\bpro\s*max\b/g,'pro max').replace(/\b(gb|tb)(?=[a-z])/g,'$1 ').replace(/\bsemi[-\s]+nov[oa]\b/g,'seminovo');
const clean = value => fold(value).replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');

function aliasEntries(aliases) {
  if (!aliases) return [];
  if (Array.isArray(aliases)) return aliases.map(a=>[a.alias ?? a.from ?? a.name,a.canonical ?? a.value ?? a.to]).filter(a=>typeof a[0]==='string'&&typeof a[1]==='string');
  if (typeof aliases!=='object') return [];
  const entries=[];
  for (const [key,value] of Object.entries(aliases)) {
    if (typeof value==='string') { entries.push([key,value]); }
    else if (Array.isArray(value)) { for (const alias of value) if (typeof alias==='string') entries.push([alias,key]); }
    else if (value && typeof value==='object') { for (const [alias,canonical] of Object.entries(value)) if (typeof canonical==='string') entries.push([alias,canonical]); }
  }
  return entries;
}

function normalize(text,aliases) {
  let normalized = ` ${clean(text)} `;
  // Longer phrases go first; aliases are one pass, never instructions or regex.
  const entries=[...aliasEntries(aliases).filter(([from])=>/^[\p{L}\p{N}\s_-]+$/u.test(from)),...Object.entries(BUILTIN_ALIASES)].map(([from,to])=>[clean(from),clean(to)]).filter(([from,to])=>from&&to&&from!==to).sort((a,b)=>b[0].length-a[0].length);
  for (const [from,to] of entries.slice(0,256)) normalized=normalized.replace(new RegExp(`(?<= )${escapeRE(from)}(?= )`,'g'),to);
  return normalized.trim().replace(/\s+/g,' ');
}

function extractModels(text,{inferIPhone=false}={}) {
  const matches=[];
  const patterns=[
    {re:/\biphone\s+(\d{1,2})(?:\s+(pro\s+max|pro|plus|mini|air))?\b/g, model:m=>`iPhone ${m[1]}${m[2]?` ${title(m[2])}`:''}`},
    {re:/\biphone\s+(xs\s+max|xs|xr|x|se)(?:\s+(20\d{2}))?\b/g, model:m=>`iPhone ${m[1].toUpperCase()}${m[2]?` ${m[2]}`:''}`},
    {re:/\b(?:samsung\s+)?(?:galaxy\s+)?(s|a|m|f)\s*(\d{1,2})(?:\s+(ultra|plus|fe))?(?:\s+([45])\s+g)?\b/g, model:m=>`Samsung ${m[1].toUpperCase()}${m[2]}${m[3]?` ${m[3]==='fe'?'FE':title(m[3])}`:''}${m[4]?` ${m[4]}G`:''}`},
    {re:/\b(?:samsung\s+)?(?:galaxy\s+)?note\s*(\d{1,2})(?:\s+(ultra|plus))?\b/g, model:m=>`Samsung Note ${m[1]}${m[2]?` ${title(m[2])}`:''}`},
    {re:/\b(?:samsung\s+)?(?:galaxy\s+)?z\s*(fold|flip)\s*(\d{1,2})\b/g, model:m=>`Samsung Z ${title(m[1])}${m[2]}`},
    {re:/\b(?:xiaomi\s+)?(redmi\s+note|poco\s+[xfm])\s*(\d{1,2})(?:\s+(pro\s+plus|pro|plus))?\b/g, model:m=>`${title(m[1])} ${m[2]}${m[3]?` ${title(m[3])}`:''}`},
  ];
  for(const {re,model} of patterns) for(const match of text.matchAll(re)) matches.push({model:model(match),start:match.index,end:match.index+match[0].length});
  if (!matches.length && inferIPhone) {
    // This explicit shorthand is the requested "18 pro Max Silver" grammar.
    const match=text.match(/^\s*(\d{1,2})(?:\s+(pro\s+max|pro|plus|mini|air))?\b/);
    if(match) matches.push({model:`iPhone ${match[1]}${match[2]?` ${title(match[2])}`:''}`,start:match.index,end:match.index+match[0].length,inferred:true});
  }
  return matches.map(m=>({...m,modelKey:clean(m.model)})).sort((a,b)=>a.start-b.start);
}
function title(text){return text.replace(/\b\w/g,c=>c.toUpperCase());}
function storageValues(text){
  const values=[];
  for(const m of text.matchAll(/\b(\d{1,4}(?:[.,]\d+)?)\s*(gb|tb)\b/g)) {const gb=Number(m[1].replace(',','.'))*(m[2]==='tb'?1024:1);if(Number.isInteger(gb)&&gb>0&&gb<=8192) values.push(gb);}
  // "256/512GB" states two capacities, not one 512GB product.
  for(const m of text.matchAll(/\b(\d{2,4})\s*\/\s*\d{2,4}\s*gb\b/g)) values.push(Number(m[1]));
  return [...new Set(values)];
}
function colorValues(text){
  const result=[]; let rest=` ${text} `;
  for(const color of COLORS){const re=new RegExp(`(?<= )${escapeRE(color)}(?= )`,'g');if(re.test(rest)){result.push(color);rest=rest.replace(re,' ');}}
  return [...new Set(result)];
}
function conditionValues(text){return [...new Set([...text.matchAll(/\b(lacrado|seminovo|usado|cpo)\b/g)].map(m=>m[1]))];}
function details(raw,aliases){
  const n=normalize(raw,aliases),storages=storageValues(fold(raw)),colors=colorValues(n),conditions=conditionValues(n);
  const battery=n.match(/\b(?:bateria|saude(?: da bateria)?|battery)\s*(?:em|de)?\s*(\d{1,3})\b/);
  const warranty=String(raw).match(/(?:garantia|warranty)[^\n;|]{0,100}/i)?.[0]?.trim()??null;
  return {n,storages,colors,conditions,storageGB:storages.length===1?storages[0]:null,colorKey:colors.length===1?colors[0]:null,color:colors.length===1?COLOR_LABELS[colors[0]]??title(colors[0]):null,condition:conditions.length===1?conditions[0]:null,batteryPercent:battery&&Number(battery[1])<=100?Number(battery[1]):null,warranty};
}

function parseQuery(text,{aliases}={}){
  if(typeof text!=='string'||text.length>2048) throw new RangeError('Busca muito longa. Use até 2.048 caracteres.');
  const d=details(text,aliases),models=extractModels(d.n,{inferIPhone:true}),model=models.length===1?models[0]:null;
  let rest=d.n;
  if(model) rest=rest.slice(0,model.start)+' '+rest.slice(model.end);
  rest=rest.replace(/\b\d{1,4}(?:[.,]\d+)?\s*(?:gb|tb)\b/g,' ');
  for(const color of COLORS) rest=rest.replace(new RegExp(`\\b${escapeRE(color)}\\b`,'g'),' ');
  rest=rest.replace(/\b(?:lacrado|seminovo|usado|cpo)\b/g,' ');
  let batteryMin=null,batteryMax=null,priceMinCents=null,priceMaxCents=null;
  const battery=rest.match(/\b(?:bateria|saude(?: da bateria)?)\s*(?:minima|min|acima de|a partir de)?\s*(\d{1,3})\b/);
  if(battery&&Number(battery[1])<=100){batteryMin=Number(battery[1]);rest=rest.replace(battery[0],' ');}
  // UI numeric filters are accepted directly by rankOffers; natural-language
  // price/supplier filters remain unknown rather than accidentally broadening.
  rest=rest.replace(/\b(?:iphone|samsung|galaxy)\b/g,model?' ':'$&').trim();
  const unknownTokens=rest.split(/\s+/).filter(Boolean);
  const errors=[];
  if(models.length>1) errors.push('Informe apenas um modelo e uma versão por busca.');
  if(d.storages.length>1) errors.push('Informe apenas uma capacidade por busca.');
  if(d.colors.length>1) errors.push('Informe apenas uma cor por busca.');
  if(d.conditions.length>1) errors.push('Informe apenas uma condição por busca.');
  if(!model) errors.push('Modelo não reconhecido. Informe a família e a versão do aparelho.');
  if(unknownTokens.length) errors.push(`Filtros não reconhecidos: ${unknownTokens.join(' ')}.`);
  return {text:text.trim(),model:model?.model??null,modelKey:model?.modelKey??null,storageGB:d.storageGB,color:d.color,colorKey:d.colorKey,condition:d.condition,batteryPercent:d.batteryPercent,batteryMin,batteryMax,priceMinCents,priceMaxCents,warranty:null,unknownTokens,errors,valid:errors.length===0,inferredFamily:model?.inferred?'iPhone':null};
}

function priceCandidates(raw){
  const prices=[];
  const phoneSpans=[...raw.matchAll(/(?:\+?55[\s.-]*)?\(?\d{2}\)?[\s.-]+\d{4,5}[\s.-]*\d{4}\b/g)].map(m=>[m.index,m.index+m[0].length]);
  // Match BRL currency independently from model/storage/battery numbers.
  const re=/(?:R\s*\$\s*)?(?:\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d{1,6},\d{2}|\d{3,6})(?![\d.,])/gi;
  for(const match of raw.matchAll(re)){
    const start=match.index,end=start+match[0].length,before=fold(raw.slice(Math.max(0,start-65),start)),after=fold(raw.slice(end,end+35));
    if(/[\d.,]/.test(raw[start-1]??'')||/^\s*(?:gb|tb|%|mah|meses|anos|dias|w|watts)\b/i.test(after)) continue;
    if(!/R\s*\$/i.test(match[0])&&(phoneSpans.some(([a,b])=>start>=a&&end<=b)||/\b(?:telefone|contato|whats(?:app)?|vendas)\s*[:=-]?\s*(?:[+\d\s().-]*)$/.test(before))) continue;
    if(/(?:\+?\d[\s().-]*){6,}$/.test(raw.slice(Math.max(0,start-25),start))&&/telefone|contato|whats|vendas|\+55/.test(fold(raw.slice(Math.max(0,start-60),end)))) continue;
    const amount=Number(match[0].replace(/R\s*\$/i,'').trim().replace(/\./g,'').replace(',','.'));
    if(!Number.isFinite(amount)||amount<=0||amount>1000000) continue;
    const currency=/R\s*\$/i.test(match[0]);
    if(!currency&&amount<300) continue;
    const nearest=before.split(/[;|\n]/).at(-1);
    let excluded=null;
    if(/\d{1,3}\s*x\s*(?:de\s*)?$|\b(?:parcela(?:s)?|prestacao(?:s)?|mensalidade)\s*(?:de|:|=)?\s*$/.test(nearest)) excluded='installment';
    else if(/\b(?:entrada|sinal|desconto|descontos|economia|cashback|frete|taxa)\s*(?:de|:|=)?\s*$/.test(nearest)) excluded='not-total';
    else if(/\b(?:capa|capinha|carregador|pelicula|fone|airpods|cabo|acessorios?)\b[^\d]{0,25}$/.test(nearest)) excluded='accessory';
    else if(/^\s*(?:\/\s*mes|por mes|mensais|cada parcela|de entrada|de desconto|desconto|a prazo|parcelado)\b/.test(after)||/\b(?:no cartao|a prazo|parcelado)\s*[:=-]?\s*$/.test(nearest)) excluded='not-cash';
    else if(/\b(?:sku|codigo|ref|referencia|pedido|lote\s+numero)\s*[:#-]?\s*$/.test(nearest)) excluded='identifier';
    // "de 7.500 por 7.000": the superseded reference price is not the sale price.
    else if(/\bde\s*$/.test(nearest)&&/^\s*por\s+(?:r\s*\$\s*)?[\d.]+(?:,\d{2})?/.test(after)) excluded='old-price';
    let priceKind='cash';
    if(/\b(?:a partir de|partir de|desde)\s*$/.test(nearest)) priceKind='from';
    else if(/\b(?:lote|atacado|minimo\s+\d+|compra minima)[^\n;|]{0,40}$/.test(nearest)||/^\s*(?:no lote|por lote|lote|atacado|minimo\s+\d+)\b/.test(after)) priceKind='lot';
    prices.push({priceCents:Math.round(amount*100),priceKind,start,end,excluded});
  }
  return prices;
}

function extractContacts(text){
  const contacts=[];
  // Only a labelled contact is interpreted. A national number is retained as
  // supplied, without inventing a country code or a wa.me URL.
  const re=/\b(?:contato(?:\s+(?:para|de)\s+vendas)?|vendas|telefone|whats(?:app)?)\s*[:=-]?\s*(\+?\(?\d[\d\s().-]{7,30})/gi;
  for(const m of text.matchAll(re)){
    const raw=m[1].trim().replace(/[\s.-]+$/,'');
    const digits=raw.replace(/\D/g,'');
    if(digits.length<10||digits.length>15||/^0/.test(digits)||/^\s*@(?:lid|s\.whatsapp\.net)/i.test(text.slice(m.index+m[0].length))) continue;
    const explicitInternational=raw.startsWith('+')||(/^55/.test(digits)&&[12,13].includes(digits.length));
    const contactPhone=explicitInternational?digits:null;
    contacts.push({contactPhone,contactRaw:raw,line:text.slice(text.lastIndexOf('\n',m.index)+1,text.indexOf('\n',m.index)<0?text.length:text.indexOf('\n',m.index)).trim()});
  }
  return [...new Map(contacts.map(c=>[c.contactPhone??c.contactRaw,c])).values()];
}

function productFingerprint(offer){
  offer.productKey=[offer.modelKey,offer.storageGB??'?',offer.colorKey??'?',offer.condition??'?'].join('|');
  offer.fingerprint=createHash('sha256').update([offer.productKey,offer.priceCents??'?',offer.priceKind,clean(offer.originalExcerpt)].join('|')).digest('hex');
  return offer;
}

function makeOffer(raw,context,{aliases}={}){
  const d=details(raw,aliases),models=extractModels(d.n),model=models.length===1?models[0]:context.model;
  if(!model) return null;
  const reasons=[];
  if(models.length>1) reasons.push('multiple_models');
  if(models.some(m=>/^\s+(?:pro|max|ultra|plus|mini|air|lite|fe|promax|[45]\s+g)\b/.test(d.n.slice(m.end)))) reasons.push('unsupported_model_variant');
  if(d.storages.length>1) reasons.push('ambiguous_storage');
  if(d.colors.length>1) reasons.push('ambiguous_color');
  if(d.conditions.length>1) reasons.push('ambiguous_condition');
  const prices=priceCandidates(raw),usable=prices.filter(p=>!p.excluded);
  const unique=[...new Map(usable.map(p=>[`${p.priceCents}|${p.priceKind}`,p])).values()];
  if(unique.length>1) reasons.push('ambiguous_price');
  if(!unique.length) reasons.push(prices.some(p=>p.excluded==='installment')?'installment_without_total':'missing_total_price');
  const price=unique.length===1?unique[0]:null;
  const observation=normalize(raw,aliases);
  const unavailable=/\b(?:esgotado|esgotada|indisponivel|sem estoque|vendido|vendida|nao disponivel)\b/.test(observation);
  const min=observation.match(/\b(?:minimo|minima|min|a partir de|acima de)\s+(\d+)\s*(?:unidades|un|pecas|aparelhos)\b/);
  const lot=/\b(?:preco (?:do|para|exclusivo (?:para|do)) lote|somente (?:em|no) lote|apenas (?:em|no) lote|no lote|atacado|compra minima|minimo\s+\d+\s*(?:unidades|un|pecas|aparelhos))\b/.test(observation);
  const storageGB=d.storages.length===1?d.storageGB:d.storages.length?null:context.storageGB??null;
  const colorKey=d.colors.length===1?d.colorKey:d.colors.length?null:context.colorKey??null;
  const condition=d.conditions.length===1?d.condition:d.conditions.length?null:context.condition??null;
  // An exact unavailability statement is a tombstone, not a zero-price offer.
  // Unknown capacity/color/condition must not invalidate distinct old variants.
  if(unavailable&&storageGB!==null&&colorKey!==null&&condition!==null&&reasons.length===1&&reasons[0]==='missing_total_price') reasons.length=0;
  const excerpt=[context.header,raw].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join('\n');
  const contacts=extractContacts(raw),contact=contacts.length===1?contacts[0]:null;
  const priceKind=price?(lot?'lot':price.priceKind):'unknown',minPurchase=min?Number(min[1]):null;
  const priceQualifier=priceKind==='from'?'a partir de':priceKind==='lot'?`lote / atacado${minPurchase?`; compra mínima: ${minPurchase} unidades`:''}`:null;
  return productFingerprint({model:model.model,modelKey:model.modelKey,storageGB,colorKey,color:colorKey?COLOR_LABELS[colorKey]??title(colorKey):null,condition,batteryPercent:d.batteryPercent??context.batteryPercent??null,warranty:d.warranty??context.warranty??null,notes:raw.trim(),priceCents:price?.priceCents??null,priceKind,priceQualifier,minPurchase,contactPhone:contact?.contactPhone??null,contactRaw:contact?.contactRaw??null,originalExcerpt:excerpt,confidence:reasons.length?'review':'confirmed',reviewReasons:reasons,unavailable,status:unavailable?'unavailable':'active'});
}

function splitPriceVariants(raw,aliases){
  const prices=priceCandidates(raw).filter(p=>!p.excluded);
  if(prices.length<2) return [raw];
  // Split explicit row delimiters only when each side contains a price and its
  // own color/capacity. A bare pair of prices is left ambiguous for review.
  const chunks=raw.split(/\s*(?:\||;|\s\/\s)\s*/).filter(Boolean);
  if(chunks.length>1&&chunks.every(chunk=>priceCandidates(chunk).some(p=>!p.excluded)&&(details(chunk,aliases).storages.length===1||details(chunk,aliases).colors.length===1))) return chunks;
  // Common supplier format: "Silver 7.000 Blue 7.100".
  const parts=[];let start=0;
  for(let i=0;i<prices.length;i++){
    const end=i===prices.length-1?raw.length:prices[i].end;
    const chunk=raw.slice(start,end).trim();start=end;
    if(!chunk) return [raw];
    parts.push(chunk);
  }
  if(parts.every(chunk=>{const d=details(chunk,aliases);return d.colors.length===1||d.storages.length===1;})) return parts;
  return [raw];
}

function parseOffers(text,{aliases}={}){
  if(typeof text!=='string'||text.length>MAX_TEXT) throw new RangeError('Mensagem de oferta excede o limite de 256 KiB.');
  const lines=text.split(/\r?\n/);if(lines.length>4096) throw new RangeError('Mensagem de oferta excede o limite de 4.096 linhas.');
  const offers=[];let context={},last=[],globalCondition=null;
  for(const rawLine of lines){
    const raw=rawLine.trim();if(!raw) continue;
    const d=details(raw,aliases),models=extractModels(d.n),prices=priceCandidates(raw),hasPrice=prices.length>0;
    // Standalone accessories never become phones by inherited header context.
    if(/^(?:[\W_]*)(?:capa|capinha|carregador|pelicula|fone|airpods|cabo|acessorios?)\b/.test(fold(raw))) {last=[];continue;}
    if(models.length===1){
      context={model:models[0],storageGB:d.storageGB,colorKey:d.colorKey,condition:d.condition??globalCondition,batteryPercent:d.batteryPercent,warranty:d.warranty,header:raw,modelHeader:raw};
    } else if(models.length>1) context={...context,model:models[0],header:raw};
    if(!hasPrice){
      if(models.length){last=[];if(/\b(?:esgotado|esgotada|indisponivel|sem estoque|vendido|vendida|nao disponivel)\b/.test(d.n)){const offer=makeOffer(raw,context,{aliases});if(offer){offers.push(offer);last=[offer];}}continue;}
      const contacts=extractContacts(raw);
      if(contacts.length===1&&last.length){for(const offer of last){offer.contactPhone=contacts[0].contactPhone;offer.contactRaw=contacts[0].contactRaw;offer.originalExcerpt+='\n'+raw;offer.notes+='\n'+raw;productFingerprint(offer);}continue;}
      if(/^[\W_]*(?:lacrados|seminovos|usados)[\W_]*$/i.test(raw)){globalCondition=d.condition;context={...context,condition:d.condition,header:raw};last=[];continue;}
      // A capacity/color header applies only to the following items. Conditions
      // and observations after a priced row apply to that row, never globally.
      let headerRest=d.n.replace(/\b\d{1,4}(?:[.,]\d+)?\s*(?:gb|tb)\b/g,' ').replace(/\b(?:lacrado|seminovo|usado|cpo)\b/g,' ');
      for(const color of COLORS) headerRest=headerRest.replace(new RegExp(`\\b${escapeRE(color)}\\b`,'g'),' ');
      const isHeader=(d.storages.length||d.colors.length)&&!headerRest.trim();
      if(isHeader){context={...context,storageGB:d.storages.length?d.storageGB:context.storageGB,colorKey:d.colors.length?d.colorKey:context.colorKey,header:[context.header,raw].filter(Boolean).join('\n')};last=[];continue;}
      const observation=/\b(?:bateria|saude|garantia|cpo|lacrado|seminovo|usado|esgotado|indisponivel|sem estoque|vendido|observacao|obs|detalhe|avaria|marca|nota fiscal|nf|lote|atacado|minimo|compra minima)\b/.test(d.n);
      if(observation&&last.length){
        for(const offer of last){offer.originalExcerpt+='\n'+raw;offer.notes+='\n'+raw;if(d.batteryPercent!==null) offer.batteryPercent=d.batteryPercent;if(d.warranty) offer.warranty=d.warranty;if(d.condition&&!offer.condition) offer.condition=d.condition;if(/\b(?:esgotado|indisponivel|sem estoque|vendido)\b/.test(d.n)){offer.unavailable=true;offer.status='unavailable';}if(/\b(?:lote|atacado|compra minima)\b/.test(d.n)) offer.priceKind='lot';const minimum=d.n.match(/\b(?:minimo|minima|min)\s+(\d+)\s*(?:un|unidades|pecas|aparelhos)\b/);if(minimum)offer.minPurchase=Number(minimum[1]);productFingerprint(offer);}
      }else if(d.condition){globalCondition=d.condition;context={...context,condition:d.condition,header:raw};last=[];}
      else if(/\b(?:esgotado|indisponivel|sem estoque|vendido)\b/.test(d.n)&&context.model){const offer=makeOffer(raw,context,{aliases});if(offer){offers.push(offer);last=[offer];}}
      continue;
    }
    last=[];
    if(!models.length&&d.storages.length===1) context={...context,storageGB:d.storageGB,header:[context.modelHeader,raw].filter(Boolean).join('\n')};
    for(const chunk of splitPriceVariants(raw,aliases)){
      const offer=makeOffer(chunk,context,{aliases});if(offer){offers.push(offer);last.push(offer);}
    }
  }
  const contacts=extractContacts(text);
  if(contacts.length===1) for(const offer of offers){if(!offer.contactRaw){offer.contactPhone=contacts[0].contactPhone;offer.contactRaw=contacts[0].contactRaw;}if(!offer.originalExcerpt.includes(contacts[0].line)){offer.originalExcerpt+='\n'+contacts[0].line;offer.notes+='\n'+contacts[0].line;productFingerprint(offer);}}
  return offers;
}

function supplierKey(offer){return String(offer.supplierKey??offer.supplierId??offer.senderJid??offer.senderId??offer.senderPhone??offer.phone??offer.messageId??offer.id??'unknown');}
function originalTime(offer){const value=offer.messageAt??offer.originalAt??offer.timestamp??offer.createdAt??0;return typeof value==='number'?value:Date.parse(value)||0;}
function rankOffers(offers,query,settings={}){
  if(!query||query.valid===false||query.unknownTokens?.length||!query.modelKey) return [];
  const latest=new Map();
  for(const offer of offers){
    if(!offer?.modelKey) continue;
    const key=supplierKey(offer)+'|'+(offer.productKey??[offer.modelKey,offer.storageGB??'?',offer.colorKey??'?',offer.condition??'?'].join('|'));
    const previous=latest.get(key);if(!previous||originalTime(offer)>originalTime(previous)||(originalTime(offer)===originalTime(previous)&&String(offer.messageId??offer.id??'')>String(previous.messageId??previous.id??''))) latest.set(key,offer);
  }
  let found=[...latest.values()].filter(offer=>{
    if(offer.confidence!=='confirmed'||offer.unavailable||['unavailable','deleted'].includes(offer.status)||!Number.isSafeInteger(offer.priceCents)||offer.priceCents<=0) return false;
    if(offer.modelKey!==query.modelKey) return false;
    for(const key of ['storageGB','colorKey','condition']) if(query[key]!=null&&offer[key]!==query[key]) return false;
    const minBattery=query.batteryMin??query.batteryPercent;if(minBattery!=null&&(offer.batteryPercent==null||offer.batteryPercent<minBattery)) return false;
    if(query.batteryMax!=null&&(offer.batteryPercent==null||offer.batteryPercent>query.batteryMax)) return false;
    if(query.priceMinCents!=null&&offer.priceCents<query.priceMinCents) return false;
    if(query.priceMaxCents!=null&&offer.priceCents>query.priceMaxCents) return false;
    if(query.supplierKey!=null&&supplierKey(offer)!==String(query.supplierKey)) return false;
    if(query.warranty!=null&&!normalize(offer.warranty??'').includes(normalize(query.warranty))) return false;
    const criterion=settings.priceCriterion??settings.priceCriteria??'cash';
    if(criterion==='cash'&&offer.priceKind!=='cash') return false;
    if(['from','lot'].includes(criterion)&&offer.priceKind!==criterion) return false;
    if(settings.blockedSuppliers?.includes(supplierKey(offer))||settings.blockedGroups?.includes(offer.groupId)) return false;
    return true;
  });
  // Only forwarded copies (or the same verified supplier) may collapse across
  // different sender identities. Equal prices alone are never a duplicate.
  const dedup=new Map();
  for(const offer of found.sort((a,b)=>originalTime(b)-originalTime(a))){
    const fingerprint=offer.fingerprint??productFingerprint({...offer}).fingerprint;
    const key=fingerprint;
    const entries=dedup.get(key)??[];
    const existing=entries.find(entry=>supplierKey(entry)===supplierKey(offer)||entry.forwarded||entry.isForwarded||offer.forwarded||offer.isForwarded);
    if(existing){
      const original=!offer.forwarded&&!offer.isForwarded&&(existing.forwarded||existing.isForwarded)?offer:existing;
      const origins=[...(existing.origins??[{groupId:existing.groupId,messageId:existing.messageId}]),...(offer.origins??[{groupId:offer.groupId,messageId:offer.messageId}])];
      const merged={...original,origins,forwardedCopies:true};entries[entries.indexOf(existing)]=merged;
    }else entries.push({...offer});
    dedup.set(key,entries);
  }
  found=[...dedup.values()].flat().sort((a,b)=>a.priceCents-b.priceCents||originalTime(b)-originalTime(a)||supplierKey(a).localeCompare(supplierKey(b)));
  if(settings.onePerSupplier){const seen=new Set();found=found.filter(o=>{const key=supplierKey(o);if(seen.has(key))return false;seen.add(key);return true;});}
  const internalLimit=Number.isInteger(settings.candidateLimit)?Math.max(1,Math.min(500,settings.candidateLimit)):null;
  const requested=internalLimit??settings.resultCount??settings.maxResults??10;
  return found.slice(0,Math.max(1,Math.min(internalLimit?500:10,Number.isInteger(requested)?requested:10)));
}

module.exports={normalize,parseQuery,parseOffers,rankOffers};
