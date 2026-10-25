const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
function handler(file, name, end, env) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf(`  const ${name} =`);
  assert(start >= 0, name);
  const finish = source.indexOf(end, start + 1);
  assert(finish > start, end);
  const js = esbuild.transformSync(source.slice(start, finish), {loader:'tsx'}).code;
  return vm.runInNewContext(`${js}; ${name}`, env);
}
function forms() {
  return {
    ratesForm:{hourlyRate:150,overtimeRate:175,downPaymentPercent:0,bookingCutoffMinutes:0,weekdayStartTime:'12:00',weekdayEndTime:'01:00',isWeekdayHappyHourActive:false,weekdayHappyHourRate:0,weekdayHappyHourStart:'15:00',weekdayHappyHourEnd:'18:00',weekdayOnlineCapacityLimit:0,weekendStartTime:'12:00',weekendEndTime:'00:00',isWeekendHappyHourActive:false,weekendHappyHourRate:0,weekendHappyHourStart:'15:00',weekendHappyHourEnd:'18:00',weekendOnlineCapacityLimit:3},
    termsForm:{minHours:2,maxHours:6,advanceBookingHours:0,cancellationHours:0,cancellationPolicy:'QA only',termsAndConditions:'QA only',weekdayMinPartySize:1,weekdayMaxPartySize:8,weekendMinPartySize:1,weekendMaxPartySize:8},
  };
}
test('policy review rejects missing fields instead of silently inventing times, capacity or happy-hour values', () => {
  const cases=[f=>f.ratesForm.weekdayStartTime='',f=>f.ratesForm.weekendHappyHourEnd='',f=>f.ratesForm.isWeekdayHappyHourActive='',f=>f.ratesForm.weekdayHappyHourRate='',f=>f.ratesForm.weekdayOnlineCapacityLimit='',f=>f.termsForm.minHours='',f=>f.termsForm.minHours=7];
  for(const mutate of [null,...cases]) {
    const form=forms();if(mutate)mutate(form);const notices=[],modal=[];
    const fn=handler('src/app/pages/AdminPolicyRatesEditor.tsx','handleReviewChanges','\n  const executeSave', {...form,policyRevision:'a'.repeat(64),flash:(...x)=>notices.push(x),setShowSummaryModal:x=>modal.push(x)});
    fn();assert.equal(modal.length,mutate?0:1);if(mutate)assert.equal(notices.at(-1)[1],'error');
  }
});
test('editor sends one complete save, preserves reviewed zero/capacity/duration values, and waits for confirmation', async () => {
  for(const reject of [false,true]) {
    const form=forms(),calls=[],notices=[],revisions=[],busy=[];let release;
    const gate=new Promise(resolve=>{release=resolve});
    const fn=handler('src/app/pages/AdminPolicyRatesEditor.tsx','executeSave','\n  const renderChangeRow', {...form,policyRevision:'a'.repeat(64),setShowSummaryModal(){},setIsSaving:x=>busy.push(x),setPolicyRevision:x=>revisions.push(x),setPolicyBaseline(){},setPolicyWarning(){},flash:(...x)=>notices.push(x),savePolicySettings:async(r,t,rev)=>{calls.push({r,t,rev});await gate;if(reject)throw Error('Synthetic save was not confirmed');return {revision:'b'.repeat(64),settings:{rates:r,terms:t}};}});
    const task=fn();assert.equal(calls.length,1);assert.equal(notices.length,0);assert.equal(revisions.length,0);
    assert.equal(calls[0].r.weekdayOnlineCapacityLimit,0);assert.equal(calls[0].r.weekendOnlineCapacityLimit,3);assert.equal(calls[0].r.downPaymentPercent,0);assert.equal(calls[0].r.bookingCutoffMinutes,0);assert.equal(calls[0].t.minHours,2);assert.equal(calls[0].t.maxHours,6);assert.equal(calls[0].t.advanceBookingHours,0);assert.equal(calls[0].t.cancellationHours,0);
    release();await task;assert.equal(busy.at(-1),false);assert.equal(notices.at(-1)[1],reject?'error':'success');assert.equal(revisions.length,reject?0:1);assert.equal(form.ratesForm.weekdayOnlineCapacityLimit,0);assert.equal(form.termsForm.minHours,2);
  }
});
test('provider adopts settings only after an exact actor-bound acknowledgement in the same account generation',async()=>{
  for(const mode of ['ok','denied','wrong-actor','mismatch','logout-during-json']) {
    const f=forms(),writes=[],activities=[];const identityRef={current:'admin'},identityGeneration={current:4};let release;
    const gate=new Promise(resolve=>{release=resolve});
    const response={actorId:'admin',revision:'b'.repeat(64),settings:{rates:{...f.ratesForm},terms:{...f.termsForm}}};if(mode==='wrong-actor')response.actorId='other';if(mode==='mismatch')response.settings.rates.hourlyRate=999;
    const env={identityRef,identityGeneration,staffProfile:{id:'admin',isAdmin:true},localFetch:async()=>({ok:mode!=='denied',json:async()=>{await gate;return response;}}),setRates:fn=>writes.push(fn({})),setReservationTerms:fn=>writes.push(fn({})),addActivity:(...x)=>activities.push(x)};
    const fn=handler('src/app/context/AppContext.tsx','savePolicySettings',' const addAnnouncement',env);
    const task=fn(f.ratesForm,f.termsForm,'a'.repeat(64));assert.equal(writes.length,0);if(mode==='logout-during-json'){identityRef.current=null;identityGeneration.current++;}release();
    if(mode==='ok'){await task;assert.equal(writes.length,2);assert.equal(activities.length,1);}else{await assert.rejects(task);assert.equal(writes.length,0);assert.equal(activities.length,0);}
  }
});
