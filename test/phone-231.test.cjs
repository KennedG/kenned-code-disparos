'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizePhone}=require('../src/core/phone.cjs');
test('phone display punctuation is normalized without changing country, DDD or subscriber digits',()=>{
  for(const display of ['5562999990001','+55 (62) 99999-0001','55.62.99999.0001','  +55 62 99999 0001  '])assert.equal(normalizePhone(display),'5562999990001');
  assert.equal(normalizePhone('+1 (202) 555-0123'),'12025550123');
  assert.equal(normalizePhone('556286660049'),'556286660049');
});
test('internal identifiers names malformed values and extra country assumptions never create a phone',()=>{
  for(const invalid of ['9876543212345@lid','5562999990001@s.whatsapp.net','Loja 5562999990001','55+62999990001','05562999990001','555','1234567890123456',null,undefined,5562999990001])assert.equal(normalizePhone(invalid),null);
});
