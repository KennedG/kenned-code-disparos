'use strict';
// Remove display punctuation only. Never infer country code, missing digits,
// a Brazilian ninth digit, or a telephone from a JID/LID/internal identifier.
function normalizePhone(value) {
  if(typeof value!=='string'||value.length>80)return null;
  const text=value.trim();
  if(!/^\+?[\d\s().-]+$/.test(text))return null;
  const digits=text.replace(/[\s()+.-]/g,'');
  return /^[1-9]\d{9,14}$/.test(digits)?digits:null;
}
module.exports={normalizePhone};
