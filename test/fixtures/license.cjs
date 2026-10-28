'use strict';

// Explicitly injected by isolated backend tests. This fixture is not shipped,
// is not a production fallback and makes no claim of hosted validation.
const {EventEmitter}=require('node:events');
const {licenseError}=require('../../src/core/license-policy.cjs');

function createLicenseFixture({clock=()=>Date.now(),state={}}={}){
  const service=new EventEmitter();
  let value={allowed:true,status:'trial',plan:'trial',trialStartedAt:clock(),expiresAt:clock()+72*60*60*1000,serverConfigured:true,...state};
  service.getStatus=()=>({...value,remainingMs:Math.max(0,value.expiresAt-clock())});
  service.initialize=async()=>service.getStatus();
  service.assertAllowed=operation=>{if(!value.allowed)throw licenseError(value,operation);};
  service.activate=async()=>{service.set({allowed:true,status:'active',plan:'monthly',expiresAt:clock()+30*24*60*60*1000,reason:null,reasonCode:null});return service.getStatus();};
  service.validate=async()=>service.getStatus();
  service.tick=async()=>service.getStatus();
  service.set=next=>{value={...value,...next};service.emit('change',service.getStatus());};
  return service;
}

module.exports={createLicenseFixture};
