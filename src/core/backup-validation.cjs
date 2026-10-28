const validation=require('./validation.cjs');
const fail=message=>{throw new Error(`Backup inválido: ${message}`);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=512;
const bounded=(value,min,max,integer=false)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max&&(!integer||Number.isInteger(value));
const optionalBool=(value,key)=>value[key]===undefined||typeof value[key]==='boolean';
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
  const contacts=collection(input.contacts||[],'contatos'),recipients=collection(input.alertRecipients||[],'destinatários de alertas');
  for(const value of [...contacts.values(),...recipients.values()]){
    if(typeof value.name!=='string'||!value.name.trim()||value.name.length>120||typeof value.phone!=='string'||!/^\+?\d{10,15}$/.test(value.phone))fail('Contato ou destinatário de alerta inválido.');
    if(value.userId!==undefined&&value.userId!==null&&!id(value.userId))fail('Usuário do destinatário inválido.');
    if(value.enabled!==undefined&&typeof value.enabled!=='boolean')fail('Estado do destinatário inválido.');
  }
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
    if(key==='reconnect'&&(!object(value)||!optionalBool(value,'enabled')||!optionalBool(value,'autoResume')||!bounded(value.maxAttempts??3,0,10,true)||!bounded(value.delaySeconds??15,3,3600)))fail('Reconexão inválida.');
    if(key==='notifications'&&(!object(value)||!optionalBool(value,'nativeEnabled')))fail('Notificações inválidas.');
    if(key==='retention'&&(!object(value)||!bounded(value.days??90,1,3650,true)||!bounded(value.maxEntries??20000,100,1000000,true)||!bounded(value.maxMegabytes??64,1,1024)))fail('Retenção de registros inválida.');
    if(key==='sound'){
      if(!object(value)||!optionalBool(value,'enabled')||!optionalBool(value,'repeat')||!bounded(value.volume??65,0,100)||!['soft','urgent','custom'].includes(value.sound??'soft')||!bounded(value.intervalSeconds??30,5,3600)||!bounded(value.maxRepeats??3,1,20,true)||!Array.isArray(value.events??[])||(value.events??[]).some(v=>!['disconnect','critical'].includes(v))||(value.customAudioId!==undefined&&value.customAudioId!==null&&!id(value.customAudioId)))fail('Preferências sonoras inválidas.');
      const quiet=value.quiet??{};if(!object(quiet)||!optionalBool(quiet,'enabled'))fail('Horário silencioso inválido.');
      try{validation.schedule({startTime:quiet.start??'22:00',endTime:quiet.end??'08:00'});}catch{fail('Horário silencioso inválido.');}
    }
    if(key==='webhook'){
      if(!object(value)||!optionalBool(value,'enabled')||typeof(value.url??'')!=='string')fail('Canal independente inválido.');
      if(value.url)try{const parsed=new URL(value.url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash)fail('Canal independente inválido.');}catch{fail('Canal independente inválido.');}
    }
  }
  return {...input,groups:[...groups.values()],campaigns:cleanCampaigns,templates:cleanTemplates,contacts:[...contacts.values()],alertRecipients:[...recipients.values()]};
}
module.exports={validateBackupData};
