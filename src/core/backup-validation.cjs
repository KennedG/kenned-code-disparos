const validation=require('./validation.cjs');
const fail=message=>{throw new Error(`Backup inválido: ${message}`);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=512;
function collection(values,label){
  if(!Array.isArray(values)||values.length>10000)fail(`${label} inválidos.`);
  const map=new Map();
  for(const value of values){if(!object(value)||!id(value.id)||map.has(value.id))fail(`Identificadores de ${label} inválidos ou repetidos.`);map.set(value.id,value);}
  return map;
}
function validateBackupData(input){
  if(!object(input)||input.format!=='mega-disparos'||input.version!==1)fail('formato não reconhecido.');
  const groups=collection(input.groups,'grupos'),media=collection(input.media,'mídias');
  const campaigns=collection(input.campaigns,'campanhas'),templates=collection(input.templates||[],'modelos'),settings=collection(input.settings||[],'configurações');
  for(const [key,g] of groups){
    if(typeof g.name!=='string'||g.name.length>1024||(g.authorized!==undefined&&typeof g.authorized!=='boolean')||(g.simulation!==undefined&&typeof g.simulation!=='boolean'))fail('Dados de grupo inválidos.');
    groups.set(key,{...g,authorized:g.authorized??false,simulation:g.simulation??false});
  }
  for(const m of media.values())if(typeof m.name!=='string'||!m.name||m.name.length>512||!['image','video','document'].includes(m.type)||typeof m.mime!=='string'||!Number.isInteger(m.size)||m.size<1||m.size>64*1024*1024||!/^([a-f0-9]{64})$/i.test(m.sha256||''))fail('Dados de mídia inválidos.');
  const view={getCampaign:key=>campaigns.get(key),getGroup:key=>groups.get(key),getMedia:key=>media.get(key),getSetting:()=>1000};
  const cleanCampaigns=[];
  for(const c of campaigns.values()){
    if(typeof c.name!=='string'||!Array.isArray(c.groupIds)||c.groupIds.some(g=>!id(g))||new Set(c.groupIds).size!==c.groupIds.length||!Array.isArray(c.items)||!object(c.schedule)||!object(c.groupOverrides||{}))fail('Estrutura da campanha inválida.');
    for(const item of [ ...c.items,...Object.values(c.groupOverrides||{}).flatMap(v=>v?.items||[]) ])if(!object(item)||!id(item.id))fail('Identificadores de conteúdo inválidos.');
    for(const [group,override] of Object.entries(c.groupOverrides||{})){
      if(!object(override)||!c.groupIds.includes(group)||typeof override.enabled!=='boolean'||(override.items!==undefined&&!Array.isArray(override.items)))fail('Configuração individual de grupo inválida.');
    }
    try{cleanCampaigns.push(validation.campaign(c,view));}catch(error){fail(error.message);}
  }
  const cleanTemplates=[];
  for(const t of templates.values()){
    if(typeof t.name!=='string'||!t.name.trim()||t.name.length>120||!Array.isArray(t.items)||t.items.some(i=>!object(i)||!id(i.id)))fail('Modelo inválido.');
    try{cleanTemplates.push({...t,items:validation.items(t.items,view)});}catch(error){fail(error.message);}
  }
  for(const [key,{value}] of settings){
    if(key==='admins'&&(!Array.isArray(value)||value.some(n=>typeof n!=='string'||!/^\d{10,15}$/.test(n))))fail('Números administradores inválidos.');
    if(key==='theme'&&!['dark','light','system'].includes(value))fail('Tema inválido.');
    if(key==='maxSelectedGroups'&&(!Number.isInteger(value)||value<1||value>1000))fail('Limite de grupos inválido.');
    if(key==='closeBehavior'&&!['ask','tray','quit'].includes(value))fail('Preferência de fechamento inválida.');
    if(['launchAtLogin','minimizeToTray','unofficialAcknowledged','initialized'].includes(key)&&typeof value!=='boolean')fail('Preferência inválida.');
  }
  return {...input,groups:[...groups.values()],campaigns:cleanCampaigns,templates:cleanTemplates};
}
module.exports={validateBackupData};
