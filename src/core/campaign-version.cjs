const {createHash}=require('node:crypto');
const CONFIG_FIELDS=['name','mode','intervalMinutes','spacingSeconds','schedule','dailyRoundLimit','dailySendLimit','groupIds','items','groupOverrides'];
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function configurationFingerprint(campaign){
  return createHash('sha256').update(JSON.stringify(canonical(Object.fromEntries(CONFIG_FIELDS.map(key=>[key,campaign?.[key]]))))).digest('hex');
}
module.exports={configurationFingerprint};
