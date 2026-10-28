'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const ui=require('../src/ui/recovery-presenter.js');
const at=Date.UTC(2026,9,21,17,9);
const campaign={state:'active',lastRoundScheduledAt:at,lastRoundAt:at,executionPendingRoundId:'running-1',nextRunAt:null,roundAnchorAt:at};
test('running persisted round never appears interrupted merely because the next round is not scheduled yet',()=>{
 const runtime={runtime:{runningRound:true,roundStatus:'running',roundId:'running-1'}};
 const view=ui.timing(campaign,runtime),html=ui.renderTiming(campaign,runtime);
 assert.equal(view.runningRound,true);assert.equal(view.next,null);assert.match(view.status,/Rodada em andamento/);assert.doesNotMatch(view.status,/interrompida/);
 assert.match(html,/A calcular ao concluir a rodada/);assert.doesNotMatch(html,/<strong>—<\/strong>/);
});
test('a pending ID with no runtime evidence requests status rather than fabricating an interruption',()=>{
 assert.equal(ui.timing(campaign).status,'Verificando o andamento da rodada');
 assert.match(ui.timing(campaign,{roundStatus:'interrupted'}).status,/interrompida/);
});
test('backend estimate is identified as a forecast and never fabricates a frontend grid',()=>{
 const op={runtime:{runningRound:true,roundStatus:'running',nextRoundEstimateAt:at+600000}};
 const view=ui.timing(campaign,op);assert.equal(view.next,at+600000);assert.equal(view.nextIsEstimate,true);assert.match(view.nextLabel,/previsão/);
 const absent=ui.timing(campaign,{runtime:{runningRound:true}});assert.equal(absent.next,null);
});
test('actual scheduled next round takes priority over an estimate and recovery remains explicit',()=>{
 const c={...campaign,nextRunAt:at+1200000,executionRecovery:{status:'Conexão recuperada — aguardando próximo horário de rodada'}};
 const view=ui.timing(c,{runtime:{runningRound:false,roundStatus:'interrupted',nextRoundEstimateAt:at+600000}});
 assert.equal(view.next,c.nextRunAt);assert.equal(view.nextIsEstimate,false);assert.equal(view.status,c.executionRecovery.status);
});
test('paused in-flight attempt shows the pending result without promising another round',()=>{
 const view=ui.timing({...campaign,state:'paused'}, {runtime:{runningRound:true,stoppingRound:true,nextRoundEstimateAt:at+600000}});
 assert.equal(view.runningRound,false);assert.match(view.status,/aguardando resultado/);assert.equal(view.next,null);assert.match(view.nextText,/Nenhuma nova rodada/);
});
test('accepted and uncertain counts remain distinct from delivery and campaign-wide totals are not relabeled as round progress',()=>{
 const op={counts:{accepted:2000},runtime:{runningRound:true,roundStatus:'running',roundCounts:{queued:4,sending:1,accepted:6,delivered:2,uncertain:1,failed:0}}};
 const view=ui.timing(campaign,op);assert.match(view.progress,/6 aceitos pela integração/);assert.match(view.progress,/2 entregas confirmadas/);assert.match(view.progress,/1 incertos/);assert.doesNotMatch(view.progress,/2000/);
 assert.equal(ui.timing(campaign,{counts:{accepted:2000}}).progress,'');
});
test('drafts and ended campaigns do not display stale next times as new authorised work',()=>{
 for(const state of ['draft','stopped'])assert.equal(ui.timing({...campaign,state,nextRunAt:at+600000}).next,null);
 assert.match(ui.timing({...campaign,state:'draft'}).nextText,/Nenhuma rodada autorizada/);
});
test('runtime status and count values remain escaped or rejected before display',()=>{
 const html=ui.renderTiming({...campaign,executionRecovery:{status:'<script>x</script>'}},{runtime:{roundStatus:'interrupted',roundCounts:{accepted:'<img>'}}});assert.doesNotMatch(html,/<script>|<img>/);assert.match(html,/&lt;script/);
});
