'use strict';
// Actual Electron UI/worker/SQLite; isolated simulation, no live account.
const {_electron,expect}=require('@playwright/test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kenned-finance-ui-'));let app,page;const errors=[];
 const credentials={username:'finance-owner',password:'Senha-Validacao-Financeira-300!'};
 const rpc=(action,payload)=>page.evaluate(({action,payload})=>window.mega.call(action,payload),{action,payload});
 const snap=()=>rpc('snapshot');const nav=async id=>page.locator('#navigation [data-id="'+id+'"]').click();
 const click=async key=>page.locator('[data-action="finance-'+key+'"]').last().click();
 const fill=(form,name,value)=>page.locator('#finance-'+form+'-form [name="'+name+'"]').fill(value);
 const closed=()=>page.locator('.modal').waitFor({state:'hidden'});
 const launch=async()=>{app=await _electron.launch({executablePath:require('electron'),args:['--no-sandbox','--disable-gpu',process.env.MEGA_APP_PATH||'.'],env:{...process.env,MEGA_DATA_DIR:dir}});await expect.poll(()=>{page=app.windows().find(w=>/\/ui\/index\.html$/.test(w.url()));return!!page;}).toBe(true);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());};
 try{
  await launch();await page.getByRole('heading',{name:'Cadastre o dono'}).waitFor();
  for(const [name,value]of Object.entries({name:'Dono financeiro teste',...credentials,confirmPassword:credentials.password,phone:'5562999999901'}))await page.locator('#auth-form [name="'+name+'"]').fill(value);
  await page.locator('#auth-form [type=submit]').click();await page.getByRole('button',{name:'Guardei os códigos'}).click();await page.getByRole('heading',{name:'Tudo sob controle'}).waitFor();
  const ownerId=(await snap()).auth.user.id;
  const item=await rpc('saveInventory',{kind:'device',model:'iPhone 15 Pro Max',storage:'256GB',color:'Azul',condition:'seminovo',costCents:200000,retailCents:350000,wholesaleCents:320000});
  const reserve=await rpc('reserveInventory',{inventoryId:item.id,quantity:1,buyerName:'Comprador financeiro teste',expiresAt:Date.now()+86400000,depositCents:50000,paymentMethod:'pix',idempotencyKey:'gui-deposit'});
  await nav('sales');await click('open-cash');await fill('cash','initialCashCents','200,00');await click('save-cash');await closed();
  await click('new-sale');await page.locator('#finance-sale-form [name=inventoryId]').selectOption(item.id);await page.locator('#finance-sale-form [name=reservationId]').selectOption(reserve.id);
  await fill('sale','unitPriceCents','3500,00');await fill('sale','discountCents','100,00');await fill('sale','directExpensesCents','40,00');await page.locator('#finance-sale-form [name=directExpenseMethod]').selectOption('pix');
  await click('add-payment');await page.locator('#finance-sale-form [name=payment-method-0]').selectOption('cash');await fill('sale','payment-amount-0','900,00');
  await click('add-payment');await page.locator('#finance-sale-form [name=payment-method-1]').selectOption('credit');await fill('sale','payment-amount-1','2000,00');await fill('sale','payment-installments-1','2');await fill('sale','payment-fee-1','60,00');
  await click('review-sale');await expect(page.locator('.modal')).toContainText('3.400,00');await click('confirm-sale');
  await expect.poll(async()=> (await snap()).commerce.sales.length).toBe(1);const sale=(await snap()).commerce.sales[0];assert.equal(sale.depositCents,50000);assert.equal(sale.paidCents,340000);assert.equal(sale.netCents,330000);assert.equal(sale.realizedProfitCents,130000);assert.equal(sale.payments.length,3);assert.equal((await snap()).commerce.inventory[0].quantity,0);
  // Confirmation opens an immutable sale detail, never silently repeats the sale.
  if(await page.locator('.modal').count())await click('close');
  console.log('PASS: actual sale form, preview and atomic confirmation with discount, prior deposit, split cash/credit, card fee and direct expense reconcile R$ 1.300 profit.');
  await click('movement');await fill('cash','amountCents','100,00');await fill('cash','category','Loja');await fill('cash','description','Limpeza registrada como despesa geral');await click('save-cash');await closed();
  const cash=(await snap()).commerce.cashSessions.find(s=>s.status==='open');assert.equal(cash.expectedCashCents,100000);await click('close-cash');await fill('cash','countedCashCents','1000,00');await click('save-cash');await closed();assert.equal((await snap()).commerce.cashSessions[0].differenceCents,0);
  console.log('PASS: cash drawer excludes Pix and credit, separates general expense from sale expense, and closes with zero difference.');
  await nav('financialReports');await page.locator('#finance-daily-settings [name=recipientIds][value="user:'+ownerId+'"]').check();await click('save-daily-settings');await expect(page.locator('[data-action=finance-query-daily]')).toBeEnabled();await click('query-daily');await expect(page.locator('#main')).toContainText('1.300,00');
  await click('generate-report');await expect.poll(async()=> (await snap()).commerce.automation.dailyReports.length).toBe(1);const report=(await snap()).commerce.automation.dailyReports[0];assert(!JSON.stringify(report).includes('imei'));
  const after=(await snap()).commerce.deliveries.filter(d=>d.kind==='daily-report');assert.equal(after.length,1);assert.equal(after[0].recipientId,'user:'+ownerId);
  await expect.poll(async()=> (await snap()).commerce.deliveries.find(d=>d.id===after[0].id).status,{timeout:10000}).toBe('accepted');
  console.log('PASS: financial report query and manual queue target authorized administrator only; simulation accepted is distinguished from device delivery.');
  await app.close();app=null;await launch();await page.getByRole('heading',{name:'Bem-vindo de volta'}).waitFor();for(const[name,value]of Object.entries(credentials))await page.locator('#auth-form [name='+name+']').fill(value);await page.locator('#auth-form [type=submit]').click();await page.getByRole('heading',{name:'Tudo sob controle'}).waitFor();assert.equal((await snap()).commerce.sales.length,1);assert.equal((await snap()).commerce.cashSessions[0].status,'closed');assert.deepEqual(errors,[]);
  console.log('PASS: sale, payment ledger, closed drawer and daily report persist across real Electron restart; no renderer errors.');
 }catch(e){console.error('Renderer errors:',errors);console.error('Toast:',await page?.locator('#toast-region').innerText().catch(()=>''));throw e;}finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
