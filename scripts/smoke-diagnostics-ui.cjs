'use strict';
// Actual Electron renderer/worker/SQLite with an isolated simulation profile.
// No production account, recipient or Windows notification receipt is tested.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {_electron,expect}=require('@playwright/test');
const {createStore}=require('../src/core/store.cjs');
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kenned-trace-ui-231-'));
  const traceId='55555555-4444-4333-8222-111111111111',at=Date.now(),store=await createStore(dir);
  store.setSetting('integrationMode','simulated');
  for(const [index,stage,code,level]of [[0,'transport.received','WA_EVENT_RECEIVED','info'],[1,'buscas.authorized','SEARCH_AUTHORIZED','info'],[2,'transport.failed','WA_SUBMISSION_ERROR_403','error']])store.addDiagnostic({id:'trace-ui-'+index,traceId,at:at+index,createdAt:at+index,stage,code,level,description:stage==='transport.failed'?'A integração recusou a submissão.':'Etapa registrada.',targetId:'5562999990101@s.whatsapp.net',...(level==='error'?{technicalError:'Protocolo 403; token=segredo_controlado',guidance:'Verifique a sessão e envie um novo comando após corrigir a conexão.'}:{})});
  store.close();let app,page;const errors=[];
  try{
    app=await _electron.launch({executablePath:require('electron'),args:['--no-sandbox','--disable-gpu',...(process.env.MEGA_PROXY_TEST?['--proxy-server=http://proxy:8080']:[]),process.env.MEGA_APP_PATH||'.'],env:{...process.env,MEGA_DATA_DIR:dir},timeout:30000});
    await expect.poll(()=>{page=app.windows().find(w=>/\/ui\/index\.html$/.test(w.url()));return !!page;},{timeout:20000}).toBe(true);
    page.on('pageerror',error=>errors.push(error.message));
    await page.getByRole('heading',{name:'Cadastre o dono'}).waitFor();await expect.poll(async()=>{const state=await page.evaluate(()=>window.mega.call('licenseStatus'));return state?.allowed===true;},{timeout:30000}).toBe(true);
    for(const [name,value]of Object.entries({name:'Dono teste diagnóstico',username:'owner-trace-ui',password:'Senha-Diagnostico-231-Segura!',confirmPassword:'Senha-Diagnostico-231-Segura!'}))await page.locator('#auth-form [name="'+name+'"]').fill(value);
    await page.locator('#auth-form [type=submit]').click();await page.getByRole('button',{name:'Guardei os códigos'}).click();await page.evaluate(async()=>{let r=await window.mega.call('licenseRefresh');if(r?.error||r?.allowed!==true)throw new Error(r?.error||'Real licensing service did not authorize test device');r=await window.mega.call('resumeAutomation');if(r?.error)throw new Error(r.error);});
    await page.locator('#navigation [data-id=diagnostics]').click();await expect(page.locator('[data-page-filter=traceId]')).toBeVisible();
    await page.locator('[data-page-filter=traceId]').fill(traceId);await page.locator('[data-page-filter=traceId]').dispatchEvent('change');
    await expect(page.locator('#main [data-action=view-trace]')).toHaveCount(3);
    await page.locator('#main [data-action=view-trace]').first().click();
    await expect(page.getByRole('heading',{name:'Rastreamento da operação'})).toBeVisible();
    const modal=page.locator('#modal-root');await expect(modal).toContainText('WA_SUBMISSION_ERROR_403');await expect(modal).toContainText('token=[omitido]');await expect(modal).not.toContainText('segredo_controlado');
    const stages=await modal.locator('tbody tr td:first-child .table-subtitle').allTextContents();assert.deepEqual(stages,['transport.received','buscas.authorized','transport.failed']);
    await page.getByRole('button',{name:'Fechar',exact:true}).last().click();
    await page.locator('#navigation [data-id=alerts]').click();await page.getByRole('button',{name:'Enviar alerta de teste'}).click();
    await expect(page.locator('#toast-region .toast.error')).toContainText('destinatário');
    await expect(page.locator('#main .delivery-status')).toHaveCount(0);
    await page.locator('[data-action=logout]').click();await expect(page.getByRole('heading',{name:'Bem-vindo de volta'})).toBeVisible();await expect(page.locator('#modal-root')).not.toContainText('WA_SUBMISSION_ERROR_403');
    assert.deepEqual(errors,[]);console.log('Diagnostics Electron: original trace filtered, chronological full route, specific protocol reason, credential redaction, no configured-recipient false success, logout removal passed. Isolated simulation; no real WhatsApp or physical Windows delivery.');
  }finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
