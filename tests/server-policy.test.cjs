const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3');
const { registerPolicyRoutes, RATES, TERMS } = require('../server-policy.cjs');
const run = (db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,error=>error?reject(error):resolve()));
const all = (db,sql)=>new Promise((resolve,reject)=>db.all(sql,(error,rows)=>error?reject(error):resolve(rows)));
function policy() {
  return {
    rates: {hourlyRate:150,overtimeRate:100,downPaymentPercent:20,bookingCutoffMinutes:45,weekdayStartTime:'09:00',weekdayEndTime:'23:00',isWeekdayHappyHourActive:true,weekdayHappyHourRate:90,weekdayHappyHourStart:'10:00',weekdayHappyHourEnd:'14:00',weekdayOnlineCapacityLimit:5,weekendStartTime:'09:00',weekendEndTime:'01:00',isWeekendHappyHourActive:false,weekendHappyHourRate:100,weekendHappyHourStart:'10:00',weekendHappyHourEnd:'14:00',weekendOnlineCapacityLimit:6},
    terms: {minHours:1,maxHours:24,cancellationHours:24,advanceBookingHours:1,cancellationPolicy:'Cancellation policy',termsAndConditions:'Review the terms',weekdayMinPartySize:1,weekdayMaxPartySize:10,weekendMinPartySize:1,weekendMaxPartySize:10}
  };
}
async function fixture(t,{seed=true,table=true}={}) {
  const directory=await mkdtemp(join(tmpdir(),'oneshot-policy-'));
  const path=join(directory,'settings.sqlite');
  const db=new sqlite3.Database(path);
  if (table) await run(db,'CREATE TABLE systemSettings(keyName TEXT PRIMARY KEY,settingValue TEXT,updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)');
  if (table && seed) {
    for (const [key,value] of Object.entries({...policy().rates,...policy().terms})) await run(db,'INSERT INTO systemSettings(keyName,settingValue) VALUES(?,?)',[key,String(value)]);
    await run(db,'INSERT INTO systemSettings(keyName,settingValue) VALUES(?,?)',['unrelatedPrivateSetting','preserve-me']);
  }
  const app=express();app.use(express.json());
  app.use((req,res,next)=>{req.staff=req.headers['x-user']==='cashier'?{id:'cashier',isAdmin:0,isActive:1,isFirstLogin:0}:req.headers['x-user']==='anonymous'?undefined:{id:'admin',isAdmin:1,isActive:1,isFirstLogin:0};next();});
  let guardCalls=0;
  registerPolicyRoutes(app,path,{requireAdmin:[(req,res,next)=>{guardCalls++;next();}]});
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));await rm(directory,{recursive:true,force:true});});
  async function call(method='GET',body,user='admin') {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/settings/policy`,{method,headers:{'Content-Type':'application/json','x-user':user},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};
  }
  const input=revision=>({expectedActorId:'admin',expectedRevision:revision,...policy()});
  const rows=()=>all(db,'SELECT * FROM systemSettings ORDER BY keyName');
  return {db,call,input,rows,guardCalls:()=>guardCalls};
}
test('typed combined snapshot and atomic zero-valued save preserve unrelated settings',async t=>{
  const f=await fixture(t),before=await f.call();
  assert.equal(before.status,200);assert.equal(before.cache,'no-store');assert.deepEqual(before.body.settings,policy());assert.deepEqual(before.body.missingKeys,[]);assert.deepEqual(before.body.invalidKeys,[]);assert.match(before.body.revision,/^[0-9a-f]{64}$/);assert.equal(before.body.actorId,'admin');
  assert.equal(Object.hasOwn(before.body.settings.rates,'unrelatedPrivateSetting'),false);
  const body=f.input(before.body.revision);
  for (const key of ['downPaymentPercent','bookingCutoffMinutes','weekdayHappyHourRate','weekendHappyHourRate','weekdayOnlineCapacityLimit','weekendOnlineCapacityLimit']) body.rates[key]=0;
  for (const key of ['cancellationHours','advanceBookingHours']) body.terms[key]=0;
  body.rates.isWeekdayHappyHourActive=false;
  const saved=await f.call('PUT',body);
  assert.equal(saved.status,200);assert.deepEqual(saved.body.settings,{rates:body.rates,terms:body.terms});assert.notEqual(saved.body.revision,before.body.revision);
  assert.deepEqual((await f.call()).body,saved.body);
  assert.equal((await f.rows()).find(row=>row.keyName==='unrelatedPrivateSetting').settingValue,'preserve-me');
  assert.equal((await f.call('PUT',body)).status,409);assert.equal(f.guardCalls(),4);
});
test('missing or invalid persisted fields remain explicit and GET creates no schema',async t=>{
  const f=await fixture(t,{seed:false});
  await run(f.db,"INSERT INTO systemSettings(keyName,settingValue) VALUES ('hourlyRate','oops'),('downPaymentPercent','0'),('isWeekdayHappyHourActive','0')");
  const got=await f.call();assert.equal(got.status,200);assert.equal(got.body.settings.rates.hourlyRate,null);assert.equal(got.body.settings.rates.downPaymentPercent,0);assert.equal(got.body.settings.rates.isWeekdayHappyHourActive,null);
  assert.deepEqual(got.body.invalidKeys,['hourlyRate','isWeekdayHappyHourActive']);assert.equal(got.body.missingKeys.length,RATES.length+TERMS.length-3);
  const empty=await fixture(t,{table:false});assert.equal((await empty.call()).status,503);assert.deepEqual(await all(empty.db,"SELECT name FROM sqlite_master WHERE type='table'"),[]);
});
test('cashiers and missing identity cannot read or save, actor mismatch cannot mutate',async t=>{
  const f=await fixture(t),before=await f.rows(),revision=(await f.call()).body.revision;
  for (const user of ['cashier','anonymous']) {assert.equal((await f.call('GET',undefined,user)).status,403);assert.equal((await f.call('PUT',f.input(revision),user)).status,403);}
  const body=f.input(revision);body.expectedActorId='other-admin';assert.equal((await f.call('PUT',body)).status,409);assert.deepEqual(await f.rows(),before);
});
test('strict shape, numeric, text, time and range validation reject whole save',async t=>{
  const f=await fixture(t),revision=(await f.call()).body.revision,before=await f.rows();
  const mutations=[b=>b.rates.hourlyRate='150',b=>b.rates.hourlyRate=-1,b=>b.rates.hourlyRate=0,b=>b.rates.overtimeRate=0,b=>b.rates.weekdayEndTime=b.rates.weekdayStartTime,b=>b.rates.weekdayHappyHourRate=0,b=>b.rates.weekdayHappyHourEnd=b.rates.weekdayHappyHourStart,b=>b.rates.hourlyRate=5000.01,b=>b.rates.hourlyRate=0.000000001,b=>b.rates.hourlyRate=1.001,b=>b.rates.downPaymentPercent=100.01,b=>b.rates.bookingCutoffMinutes=1441,b=>b.rates.bookingCutoffMinutes=1.5,b=>b.rates.weekdayStartTime='24:00',b=>b.rates.weekdayStartTime='9:00',b=>b.rates.isWeekdayHappyHourActive=1,b=>b.rates.unknown=1,b=>delete b.rates.hourlyRate,b=>b.terms.minHours=0,b=>b.terms.minHours=25,b=>b.terms.minHours=2.5,b=>b.terms.maxHours=0,b=>b.terms.advanceBookingHours=-1,b=>b.terms.advanceBookingHours=169,b=>b.terms.cancellationHours=169,b=>b.terms.weekdayMinPartySize=11,b=>b.terms.weekendMaxPartySize=1001,b=>b.terms.cancellationPolicy='x'.repeat(20001),b=>b.expectedRevision='bad',b=>b.unknown=1];
  for (const mutate of mutations) {const body=f.input(revision);mutate(body);const result=await f.call('PUT',body);assert.equal(result.status,400,JSON.stringify(body));}
  assert.deepEqual(await f.rows(),before);
});
test('late SQLite failure rolls back prior writes without exposing database details',async t=>{
  const f=await fixture(t),revision=(await f.call()).body.revision,before=await f.rows();
  await run(f.db,"CREATE TRIGGER reject_late_policy BEFORE UPDATE ON systemSettings WHEN NEW.keyName='weekendMaxPartySize' BEGIN SELECT RAISE(ABORT,'sensitive database failure'); END");
  const body=f.input(revision);body.rates.hourlyRate=321;body.terms.weekendMaxPartySize=12;
  const result=await f.call('PUT',body);assert.equal(result.status,503);assert.equal(JSON.stringify(result.body).includes('sensitive'),false);assert.deepEqual(await f.rows(),before);
});
test('concurrent stale revisions permit one complete winner and unrelated edits also conflict',async t=>{
  const f=await fixture(t),revision=(await f.call()).body.revision,a=f.input(revision),b=f.input(revision);
  a.rates.hourlyRate=111;a.terms.cancellationPolicy='A';b.rates.hourlyRate=222;b.terms.cancellationPolicy='B';
  const results=await Promise.all([f.call('PUT',a),f.call('PUT',b)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const winner=results.find(r=>r.status===200);assert.deepEqual((await f.call()).body.settings,winner.body.settings);
  const input=f.input(winner.body.revision);await run(f.db,"UPDATE systemSettings SET settingValue='external change' WHERE keyName='unrelatedPrivateSetting'");
  assert.equal((await f.call('PUT',input)).status,409);
});

test('registration requires authentication and denial middleware responses are private',async t=>{
  assert.throws(()=>registerPolicyRoutes(express(),'unused'),/authentication middleware/);
  assert.throws(()=>registerPolicyRoutes(express(),'unused',{requireAdmin:[]}),/authentication middleware/);
  const app=express();registerPolicyRoutes(app,'unused',{requireAdmin:(req,res)=>res.status(401).json({error:'Sign in'})});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/settings/policy`);assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('pragma'),'no-cache');
});
