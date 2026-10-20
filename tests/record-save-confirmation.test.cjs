const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),esbuild=require('esbuild'),express=require('express'),sqlite3=require('sqlite3');
const serverSource=fs.readFileSync(path.join(__dirname,'../server.cjs'),'utf8'),provider=fs.readFileSync(path.join(__dirname,'../src/app/context/AppContext.tsx'),'utf8'),page=fs.readFileSync(path.join(__dirname,'../src/app/pages/LostAndFound.tsx'),'utf8');
const sql=(db,s,a=[])=>new Promise((r,j)=>db.run(s,a,e=>e?j(e):r())),rows=(db,s)=>new Promise((r,j)=>db.all(s,(e,v)=>e?j(e):r(v)));
const original={id:'lf_qa_record',itemName:'QA wallet',description:'QA only',foundDate:'2026-10-20T04:00:00.000Z',status:'found',image:null,claimedBy:null,claimedDate:null,isArchived:false};
const claim={status:'claimed',claimedBy:'QA claimant',claimedDate:'2026-10-20T05:00:00.000Z',isArchived:true};
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oneshot-record-confirmation-')),db=new sqlite3.Database(path.join(dir,'test.db'));
 await sql(db,'CREATE TABLE lost_and_found(id TEXT PRIMARY KEY,itemName TEXT,description TEXT,foundDate TEXT,status TEXT,image TEXT,claimedBy TEXT,claimedDate TEXT,isArchived INTEGER)');
 await sql(db,'CREATE TABLE activities(id TEXT PRIMARY KEY,type TEXT,description TEXT,timestamp TEXT,metadata TEXT)');
 await sql(db,'INSERT INTO lost_and_found VALUES(?,?,?,?,?,?,?,?,?)',Object.values({...original,isArchived:0}));
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.staff={id:'qa-staff',fullName:'QA Staff'};next();});
 const snippets=[serverSource.slice(serverSource.indexOf("app.post('/api/lost-and-found'"),serverSource.indexOf("app.post('/api/watchlist'")),serverSource.slice(serverSource.indexOf('const lostRecordFields ='),serverSource.indexOf("app.post('/api/reservations'")),serverSource.slice(serverSource.indexOf("app.post('/api/activities'"),serverSource.indexOf("app.put('/api/reservations/:id'"))];
 vm.runInNewContext(snippets.join('\n'),{app,db,Date,JSON,Object,Array,Number});
 const http=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
 t.after(async()=>{await new Promise(r=>http.close(r));await new Promise(r=>db.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const call=async(endpoint,method,body)=>{const r=await fetch(`http://127.0.0.1:${http.address().port}${endpoint}`,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
 return{db,call,record:async()=>({...((await rows(db,'SELECT * FROM lost_and_found'))[0]),isArchived:(await rows(db,'SELECT * FROM lost_and_found'))[0].isArchived===1})};
}
test('claim, revert and archive return actual saved rows; stale claim never overwrites another operator',async t=>{
 const f=await fixture(t),saved=await f.call('/api/lost-and-found/'+original.id,'PUT',{expectedRecord:original,patch:claim});assert.equal(saved.status,200);assert.deepEqual(saved.body.record,{...original,...claim});
 assert.equal((await f.call('/api/lost-and-found/'+original.id,'DELETE',{expectedRecord:original})).status,409);
 const reverted=await f.call('/api/lost-and-found/'+original.id,'PUT',{expectedRecord:saved.body.record,patch:{status:'found',claimedBy:null,claimedDate:null,isArchived:false}});assert.equal(reverted.status,200);
 const archived=await f.call('/api/lost-and-found/'+original.id,'DELETE',{expectedRecord:reverted.body.record});assert.equal(archived.status,200);assert.equal(archived.body.record.isArchived,true);assert.deepEqual(await f.record(),archived.body.record);
});
test('two claimants cannot both confirm the same original item',async t=>{
 const f=await fixture(t),result=await Promise.all(['QA A','QA B'].map(name=>f.call('/api/lost-and-found/'+original.id,'PUT',{expectedRecord:original,patch:{...claim,claimedBy:name}})));assert.deepEqual(result.map(r=>r.status).sort(),[200,409]);assert.equal((await f.record()).claimedBy,result.find(r=>r.status===200).body.record.claimedBy);
});
test('failed/missing/invalid lost-item writes cannot return successful acknowledgements',async t=>{
 const f=await fixture(t);await sql(f.db,"CREATE TRIGGER reject_lost BEFORE UPDATE ON lost_and_found BEGIN SELECT RAISE(ABORT,'QA internal SQL');END");
 const failed=await f.call('/api/lost-and-found/'+original.id,'PUT',{expectedRecord:original,patch:claim});assert.equal(failed.status,503);assert.doesNotMatch(JSON.stringify(failed.body),/internal SQL/);assert.deepEqual(await f.record(),original);
 await sql(f.db,'DROP TRIGGER reject_lost');assert.equal((await f.call('/api/lost-and-found/missing','DELETE',{expectedRecord:{...original,id:'missing'}})).status,404);
 for(const patch of [{...claim,claimedBy:''},{...claim,claimedDate:'invalid'},{status:'claimed'},{...claim,itemName:'overwrite'}])assert.equal((await f.call('/api/lost-and-found/'+original.id,'PUT',{expectedRecord:original,patch})).status,400);
});
test('lost-item creation returns the persisted null/default fields needed for immediate claim',async t=>{
 const f=await fixture(t),created=await f.call('/api/lost-and-found','POST',{id:'lf_new_qa',itemName:'QA bag',description:'QA',foundDate:original.foundDate,status:'found',image:''});assert.equal(created.status,201);assert.equal(created.body.record.claimedBy,null);assert.equal(created.body.record.isArchived,false);assert.equal((await f.call('/api/lost-and-found/lf_new_qa','PUT',{expectedRecord:created.body.record,patch:claim})).status,200);
});
test('activity acknowledgement is authoritative, replay is exact and conflicting IDs reject',async t=>{
 const f=await fixture(t),body={id:'act_qa_original',type:'admin_action',description:'QA action (Action by: Spoof)',metadata:{actorId:'spoof',actorName:'Spoof',module:'QA'}};
 const saved=await f.call('/api/activities','POST',body);assert.equal(saved.status,201);assert.equal(saved.body.metadata.actorId,'qa-staff');assert.equal(saved.body.metadata.actorName,'QA Staff');assert.equal(saved.body.description,'QA action (Action by: QA Staff)');assert.ok(Number.isFinite(Date.parse(saved.body.timestamp)));
 const replay=await f.call('/api/activities','POST',body);assert.equal(replay.status,200);assert.deepEqual(replay.body,saved.body);assert.equal((await rows(f.db,'SELECT * FROM activities')).length,1);
 assert.equal((await f.call('/api/activities','POST',{...body,description:'Different action'})).status,409);
});
test('activity failure and malformed input cannot pretend the log was saved',async t=>{
 const f=await fixture(t),body={id:'act_qa_failure',type:'admin_action',description:'QA action'};await sql(f.db,"CREATE TRIGGER reject_activity BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT,'QA private SQL');END");assert.equal((await f.call('/api/activities','POST',body)).status,503);assert.equal((await rows(f.db,'SELECT * FROM activities')).length,0);
 for(const patch of [{id:''},{type:'bad type'},{description:''},{metadata:[]}])assert.equal((await f.call('/api/activities','POST',{...body,...patch})).status,400);
});
test('activity display, actor filters and export use saved attribution instead of spoofed description text',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/app/pages/ActivityLog.tsx'),'utf8'),start=source.indexOf('  const getActor ='),end=source.indexOf('  const cleanDescription =',start);
 const actor=vm.runInNewContext(esbuild.transformSync(source.slice(start,end)+'\ngetActor;',{loader:'ts'}).code,{});
 assert.equal(actor({description:'QA (Action by: Spoof)',metadata:{actorId:'qa-staff',actorName:'QA Staff'}}),'QA Staff');
 assert.equal(actor({description:'QA (Action by: Spoof)',metadata:{actorId:'qa-staff'}}),'qa-staff');
 assert.equal(actor({description:'QA (Action by: Spoof)'}),'Unknown legacy actor');
});
function lostProvider(request,refresh=async()=>({ok:false})){
 const state={items:[{...original}],updates:[]},identityRef={current:'qa'},identityGeneration={current:1};
 const scope={identityRef,identityGeneration,authMutationInFlight:{current:false},Error,JSON,Object,Array,encodeURIComponent,syncToDB:request,localFetch:refresh,setLostItems:update=>{state.updates.push(update);state.items=update(state.items);}};Object.defineProperty(scope,'lostItems',{get:()=>state.items});
 const start=provider.indexOf('  const saveLostTransition ='),end=provider.indexOf('  const addWatchlistItem =',start);vm.runInNewContext(esbuild.transformSync(provider.slice(start,end)+'\nglobalThis.api={updateLostItem,deleteLostItem};',{loader:'ts'}).code,scope);return{state,scope,identityRef,identityGeneration,...scope.api};
}
test('lost-item provider keeps failed actions unconfirmed and applies only the returned saved record',async()=>{
 const fail=lostProvider(async()=>{throw Error('QA database unavailable');});await assert.rejects(fail.updateLostItem(original.id,claim),/Review the saved record/);assert.deepEqual(fail.state.items,[original]);
 const good=lostProvider(async(_url,_method,body)=>({id:original.id,record:{...body.expectedRecord,...body.patch}}));await good.updateLostItem(original.id,claim);assert.equal(good.state.items[0].status,'claimed');
 const bad=lostProvider(async()=>({id:original.id}));await assert.rejects(bad.deleteLostItem(original.id));assert.deepEqual(bad.state.items,[original]);
});
test('account switch cannot apply a delayed lost-item response or deferred React update',async()=>{
 let release;const gate=new Promise(r=>release=r);const f=lostProvider(async()=>{await gate;return{id:original.id,record:{...original,...claim}};});const pending=f.updateLostItem(original.id,claim);f.identityGeneration.current++;release();await assert.rejects(pending,/Account changed/);assert.deepEqual(f.state.items,[original]);
 const g=lostProvider(async()=>({id:original.id,record:{...original,...claim}}));await g.updateLostItem(original.id,claim);g.identityGeneration.current++;const next=[];assert.equal(g.state.updates[0](next),next);
});
test('activity provider never inserts phantom logs and protects late responses after sign-out',async()=>{
 const start=provider.indexOf('  const addActivity ='),end=provider.indexOf('\n  const ',start+3),code=esbuild.transformSync(provider.slice(start,end)+'\nglobalThis.log=addActivity;',{loader:'ts'}).code;
 for(const mode of ['failed','invalid','changed','saved']){let inserts=0,warnings=0;const identityGeneration={current:1};const scope={Date,Math,JSON,Error,identityRef:{current:'qa'},identityGeneration,authMutationInFlight:{current:false},staffProfile:{id:'qa',fullName:'QA'},setActivities:()=>inserts++,toast:{warning:()=>warnings++},syncToDB:async(_url,_method,input)=>{assert.equal(inserts,0);if(mode==='failed')throw Error('QA fail');if(mode==='changed')identityGeneration.current++;return mode==='invalid'?{id:input.id}:{...input,timestamp:new Date().toISOString(),metadata:{actorId:'qa'}};}};vm.runInNewContext(code,scope);await scope.log('admin_action','QA');assert.equal(inserts,mode==='saved'?1:0);assert.equal(warnings,['failed','invalid'].includes(mode)?1:0);}
});
test('claim form preserves claimant on failed save and prevents duplicate clicks',async()=>{
 const state={modal:'qa',name:'QA',flashes:[],calls:0},scope={Error,Date,mounted:{current:true},pageOwner:{current:{id:'qa'}},transitionBusy:{current:false},isSubmitting:false,claimName:'QA',claimModalId:original.id,setIsSubmitting(){},setClaimModalId:v=>state.modal=v,setClaimName:v=>state.name=v,flash:(...x)=>state.flashes.push(x),updateLostItem:async()=>{state.calls++;throw Error('QA save failed');}};
 const start=page.indexOf('  const handleClaim ='),end=page.indexOf('\n  return (',start);vm.runInNewContext(esbuild.transformSync(page.slice(start,end)+'\nglobalThis.claim=handleClaim;',{loader:'tsx'}).code,scope);await scope.claim({preventDefault(){}});assert.equal(state.modal,'qa');assert.equal(state.name,'QA');assert.equal(state.flashes.at(-1)[1],'error');
 let release;scope.updateLostItem=async()=>{state.calls++;await new Promise(r=>release=r);};const pending=scope.claim({preventDefault(){}});await scope.claim({preventDefault(){}});assert.equal(state.calls,2);release();await pending;assert.equal(state.modal,null);assert.equal(state.name,'');assert.equal(state.flashes.at(-1)[1],'success');
});
