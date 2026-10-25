const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express'),sqlite3=require('sqlite3');
const {mkdtemp,rm}=require('node:fs/promises');
const path=require('node:path'),os=require('node:os');
const {registerQueueRoutes,queueOperationDefinitions}=require('../server-queue.cjs');
const {initializeReservationMoveSchema}=require('../server-reservation-moves.cjs');
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
const rows=(db,sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,r)=>e?reject(e):resolve(r)));
async function fixture(t,options={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'oneshot-queue-')),file=path.join(dir,'qa.sqlite');
 const db=await new Promise((resolve,reject)=>{const c=new sqlite3.Database(file,e=>e?reject(e):resolve(c));});let server;
 t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));await rm(dir,{recursive:true,force:true});});
 await run(db,'CREATE TABLE activities (id TEXT PRIMARY KEY,type TEXT,description TEXT,timestamp DATETIME,metadata TEXT)');
 await run(db,'CREATE TABLE queue (id TEXT PRIMARY KEY,customerName TEXT,contactNumber TEXT,partySize INTEGER,status TEXT,queueNumber INTEGER,notes TEXT,arrivalTime DATETIME DEFAULT CURRENT_TIMESTAMP)');await run(db,'CREATE TABLE tables (id TEXT PRIMARY KEY,name TEXT,status TEXT,isActive INTEGER,sessionData TEXT)');await run(db,'CREATE TABLE systemSettings(keyName TEXT PRIMARY KEY,settingValue TEXT)');
 await require('./venue-fixture.cjs').seedVenue(db);
 const settings={hourlyRate:'150',overtimeRate:'300',isWeekdayHappyHourActive:'true',weekdayHappyHourRate:'100',weekdayHappyHourStart:'15:00',weekdayHappyHourEnd:'18:00',isWeekendHappyHourActive:'false',weekdayMinPartySize:'1',weekdayMaxPartySize:'8',weekendMinPartySize:'4',weekendMaxPartySize:'10'};
 for(const [key,value]of Object.entries(settings))await run(db,'INSERT INTO systemSettings VALUES(?,?)',[key,value]);
 await run(db,"INSERT INTO tables VALUES('a','QA A','available',1,NULL),('b','QA B','available',1,NULL)");await initializeReservationMoveSchema(db);
 if(options.beforeReady)await options.beforeReady(db);
 const auth={active:true,id:'qa_staff_a',lookups:0,revokeAt:0,failAfterCommit:false,failAfterRejection:false};let time=Date.parse('2026-10-19T14:00:00+08:00');
 const app=express();app.use(express.json());app.use((req,res,next)=>{const original=res.json.bind(res);res.json=body=>{if(((auth.failAfterCommit&&body?.outcome==='applied')||(auth.failAfterRejection&&body?.outcome==='rejected'))&&body.replayed===false){auth.failAfterCommit=false;auth.failAfterRejection=false;throw Error('QA private lost response');}return original(body);};next();});
 const config={requireAuth:[(req,res,next)=>{if(req.headers.authorization!=='QA synthetic')return res.status(401).json({error:'Sign in.'});req.authToken='qa-session';req.staff={id:auth.id,fullName:'QA Cashier'};next();}],resolveActor:async()=>{auth.lookups++;if(auth.revokeAt===auth.lookups)auth.active=false;return auth.active?{localStaffId:auth.id}:null;},isActorCurrent:(_,actor)=>auth.active&&actor.localStaffId===auth.id,now:()=>time};
 const routes=registerQueueRoutes(app,file,config);await routes.ready;
 const restart=()=>registerQueueRoutes(express(),file,config).ready;
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const call=async(command,authenticated=true)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/queue/operations`,{method:'POST',headers:{'content-type':'application/json',...(authenticated?{authorization:'QA synthetic'}:{})},body:JSON.stringify(command)});return{status:response.status,body:await response.json()};};
 let serial=0;const add=extra=>({requestId:'qa_add_'+ ++serial,kind:'add',customerName:' QA queue customer ',contactNumber:' 09123456789 ',partySize:2,notes:' QA synthetic only ',...extra});
 const newRow=async()=>{const result=await call(add());assert.equal(result.status,200,JSON.stringify(result.body));return result.body.queue;};
 const seat=(queue,extra={})=>({requestId:'qa_seat_'+ ++serial,kind:'seat',queueId:queue.id,expectedQueue:queue,tableId:'a',session:{durationMinutes:60,isOpenTime:false,hourlyRate:150,overtimeRate:300,pricingVersion:1,amountPaid:75,paymentStatus:'payNow'},...extra});
 return{db,file,auth,call,add,newRow,seat,restart,setTime:value=>{time=Date.parse(value);},all:table=>rows(db,'SELECT * FROM '+table),setting:(key,value)=>run(db,'UPDATE systemSettings SET settingValue=? WHERE keyName=?',[value,key])};
}
test('add uses server identity/time and durable monotonic number seeded from valid legacy values; exact concurrent replay never duplicates',async t=>{
 const f=await fixture(t,{beforeReady:db=>run(db,"INSERT INTO queue VALUES('old','QA old',NULL,2,'seated',7,NULL,'2026-10-19 01:00:00'),('invalid-number','QA old',NULL,2,'waiting','not-number',NULL,'2026-10-19 01:00:00')")});
 const command=f.add();const results=await Promise.all([f.call(command),f.call(command)]);assert.ok(results.every(r=>r.status===200));assert.equal(results[0].body.queue.queueNumber,8);assert.equal(results[1].body.queueId,results[0].body.queueId);const row=results[0].body.queue;assert.match(row.id,/^q_/);assert.equal(row.customerName,'QA queue customer');assert.equal(row.arrivalTime,'2026-10-19T06:00:00.000Z');assert.equal(Object.keys(results[0].body).length,7);
 await f.call({requestId:'qa_remove_added',kind:'remove',queueId:row.id,expectedQueue:row});const next=await f.newRow();assert.equal(next.queueNumber,9);assert.equal((await f.all('queue_operations')).length,3);
});
test('call/remove compare full faithful snapshot; call only waiting and durable rejection never resurrects after state changes',async t=>{
 const f=await fixture(t,{beforeReady:db=>run(db,"INSERT INTO queue VALUES('qa-legacy','QA Legacy',NULL,2,'waiting',4,NULL,'2026-10-19 04:05:06')")});
 const queue=(await f.all('queue')).find(r=>r.id==='qa-legacy');const call={requestId:'qa_call_legacy',kind:'call',queueId:queue.id,expectedQueue:queue};const applied=await f.call(call);assert.equal(applied.status,200);assert.equal(applied.body.queue.arrivalTime,queue.arrivalTime);assert.equal(applied.body.queue.contactNumber,null);assert.equal(applied.body.queue.notes,null);
 const stale=await f.call({requestId:'qa_remove_stale',kind:'remove',queueId:queue.id,expectedQueue:queue});assert.equal(stale.status,409);assert.equal(stale.body.outcome,'rejected');assert.equal(Object.keys(stale.body).length,9);
 await run(f.db,"UPDATE queue SET status='waiting' WHERE id='qa-legacy'");assert.equal((await f.call({requestId:'qa_remove_stale',kind:'remove',queueId:queue.id,expectedQueue:queue})).body.replayed,true);assert.equal((await f.all('queue')).length,1);
 const replay=await f.call(call);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal((await f.all('queue'))[0].status,'waiting');
});
test('seat atomically transfers authoritative queue identity, saved rates and upfront cash ledger then replay never touches later guest',async t=>{
 const f=await fixture(t),queue=await f.newRow(),command=f.seat(queue);const first=await f.call(command);assert.equal(first.status,200,JSON.stringify(first.body));const session=first.body.table.session;
 assert.equal(Object.keys(session).length,13);assert.equal(session.customerName,queue.customerName);assert.equal(session.customerPhone,queue.contactNumber);assert.equal(session.partySize,queue.partySize);assert.equal(session.startTime,'2026-10-19T06:00:00.000Z');assert.equal(session.hourlyRate,150);assert.equal(session.overtimeRate,300);assert.equal(session.isPaid,false);assert.equal(session.paymentStatus,'payLater');assert.deepEqual(session.orders,[]);assert.equal((await f.all('queue')).length,0);
 const payment=(await f.all('session_payments'))[0];assert.equal(payment.amount,75);assert.equal(payment.operation_id,command.requestId);assert.equal(payment.payment_method,'cash');
 await run(f.db,"UPDATE tables SET sessionData='QA newer guest' WHERE id='a'");await f.restart();const replay=await f.call(command);assert.equal(replay.status,200);assert.deepEqual(replay.body,{...first.body,replayed:true});assert.equal((await f.all('tables')).find(r=>r.id==='a').sessionData,'QA newer guest');assert.equal((await f.all('session_payments')).length,1);
});
test('competing seats/remove/call cannot duplicate one guest or change occupied table',async t=>{
 const f=await fixture(t),queue=await f.newRow();const results=await Promise.all([f.call(f.seat(queue,{requestId:'qa_compete_seat_a'})),f.call(f.seat(queue,{requestId:'qa_compete_seat_b',tableId:'b'})),f.call({requestId:'qa_compete_remove',kind:'remove',queueId:queue.id,expectedQueue:queue}),f.call({requestId:'qa_compete_call',kind:'call',queueId:queue.id,expectedQueue:queue})]);
 assert.equal(results.filter(r=>r.status===200).length,1);assert.ok(results.every(r=>r.status===200||r.status===409));assert.ok((await f.all('tables')).filter(r=>r.status==='occupied').length<=1);assert.ok((await f.all('session_payments')).length<=1);assert.equal((await f.all('queue_operations')).length,5);
});
test('held or occupied target yields durable exact rejection and same request stays rejected after release',async t=>{
 const f=await fixture(t),queue=await f.newRow(),command=f.seat(queue);await run(f.db,"INSERT INTO native_reservation_move_holds VALUES('a','qa foreign move','qa foreign claim')");const first=await f.call(command);assert.equal(first.status,409);assert.equal(first.body.code,'QUEUE_OPERATION_REJECTED');assert.equal(first.body.queueId,queue.id);assert.equal(first.body.queue,null);assert.equal(first.body.table,null);
 await run(f.db,"DELETE FROM native_reservation_move_holds WHERE table_id='a'");assert.deepEqual((await f.call(command)).body,{...first.body,replayed:true});assert.equal((await f.all('queue')).length,1);assert.equal((await f.all('tables')).find(r=>r.id==='a').status,'available');assert.equal((await f.all('session_payments')).length,0);
});
test('party policy, missing config, current Happy Hour boundary and business-invalid credit reject durably',async t=>{
 const f=await fixture(t);await f.setting('weekdayMinPartySize','3');const rejected=f.add();assert.equal((await f.call(rejected)).status,409);await f.setting('weekdayMinPartySize','1');assert.equal((await f.call(rejected)).body.replayed,true);const queue=await f.newRow();
 const stale=f.seat(queue,{requestId:'qa_stale_boundary'});f.setTime('2026-10-19T15:00:00+08:00');assert.equal((await f.call(stale)).body.outcome,'rejected');f.setTime('2026-10-19T14:59:00+08:00');assert.equal((await f.call(stale)).body.replayed,true);
 f.setTime('2026-10-19T15:00:00+08:00');const proposal={...stale.session,hourlyRate:100,amountPaid:101};assert.equal((await f.call(f.seat(queue,{session:proposal}))).body.outcome,'rejected');
 const saved=await f.call(f.seat(queue,{session:{...proposal,amountPaid:100}}));assert.equal(saved.status,200);assert.equal(saved.body.table.session.hourlyRate,100);assert.equal(saved.body.table.session.isPaid,true);f.setTime('2026-10-19T18:01:00+08:00');assert.equal((await f.call({...f.seat(queue),requestId:saved.body.requestId,session:{...proposal,amountPaid:100}})).body.replayed,true);
 await f.setting('weekdayMaxPartySize','0');const invalid=await f.call(f.add());assert.equal(invalid.status,409);assert.equal(invalid.body.outcome,'rejected');
});
test('open session permits only zero credit/payLater and policy day is Mon–Thu versus Fri–Sun',async t=>{
 const f=await fixture(t),queue=await f.newRow();f.setTime('2026-10-23T14:00:00+08:00');const wrongParty=await f.call(f.seat(queue));assert.equal(wrongParty.status,409);assert.match(wrongParty.body.error,/Party size/);
 f.setTime('2026-10-19T14:00:00+08:00');const invalid={durationMinutes:null,isOpenTime:true,latestEndTime:'2026-10-19T15:59:00.000Z',hourlyRate:150,overtimeRate:300,pricingVersion:1,amountPaid:1,paymentStatus:'payNow'};assert.equal((await f.call(f.seat(queue,{session:invalid}))).body.outcome,'rejected');const result=await f.call(f.seat(queue,{session:{...invalid,amountPaid:0,paymentStatus:'payLater'}}));assert.equal(result.status,200);assert.equal(result.body.table.session.isPaid,false);assert.equal(result.body.table.session.durationMinutes,null);assert.equal(result.body.table.session.latestEndTime,'2026-10-19T15:59:00.000Z');assert.equal((await f.all('session_payments')).length,0);
});
test('malformed/forged commands and unauthorized/crossactor replay never emit definitive rejection proof',async t=>{
 const f=await fixture(t),command=f.add();assert.equal((await f.call(command,false)).status,401);for(const extra of [{id:'forged'},{queueNumber:123},{status:'called'},{arrivalTime:'forged'},{actorId:'other'}]){const r=await f.call({...command,...extra});assert.equal(r.status,400);assert.equal(r.body.outcome,undefined);}
 const first=await f.call(command);assert.equal(first.status,200);f.auth.id='qa_staff_b';const denied=await f.call(command);assert.equal(denied.status,403);assert.equal(denied.body.outcome,undefined);f.auth.id='qa_staff_a';assert.equal((await f.call(command)).body.replayed,true);
 const queue=first.body.queue;for(const extra of [{startTime:'forged'},{isPaid:true},{orders:[]},{customerName:'forged'},{reservationPricing:{}}]){const r=await f.call(f.seat(queue,{session:{...f.seat(queue).session,...extra}}));assert.equal(r.status,400);assert.equal(r.body.outcome,undefined);}
});
test('late payment, queue deletion or operation journal failures roll back every seat write and never return rejection metadata',async t=>{
 for(const stage of ['payment','delete','journal'])await t.test(stage,async t=>{
  const f=await fixture(t),queue=await f.newRow(),command=f.seat(queue);const trigger=stage==='payment'?"BEFORE INSERT ON session_payments":stage==='delete'?"BEFORE DELETE ON queue":"BEFORE INSERT ON queue_operations";await run(f.db,`CREATE TRIGGER qa_late ${trigger} BEGIN SELECT RAISE(ABORT,'QA private late error'); END`);
  const failed=await f.call(command);assert.equal(failed.status,503);assert.equal(failed.body.outcome,undefined);assert.doesNotMatch(JSON.stringify(failed.body),/QA private/);assert.equal((await f.all('queue')).length,1);assert.equal((await f.all('tables')).find(r=>r.id==='a').status,'available');assert.equal((await f.all('session_payments')).length,0);assert.equal((await f.all('queue_operations')).length,1);await run(f.db,'DROP TRIGGER qa_late');assert.equal((await f.call(command)).status,200);
 });
});
test('unknown response after committed add recovers original immutable result without consuming another number',async t=>{
 const f=await fixture(t),command=f.add();f.auth.failAfterCommit=true;const lost=await f.call(command);assert.equal(lost.status,503);assert.equal(lost.body.outcome,undefined);assert.equal((await f.all('queue')).length,1);const replay=await f.call(command);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(replay.body.queue.queueNumber,1);assert.equal((await f.all('queue')).length,1);assert.equal((await f.newRow()).queueNumber,2);
});
test('authorization revoked while waiting for SQLite lock or before commit denies without any queued effect',async t=>{
 const f=await fixture(t);await run(f.db,'BEGIN IMMEDIATE');const pending=f.call(f.add());for(let i=0;i<100&&f.auth.lookups<1;i++)await new Promise(resolve=>setTimeout(resolve,2));f.auth.active=false;await run(f.db,'ROLLBACK');const denied=await pending;assert.equal(denied.status,403);assert.equal((await f.all('queue')).length,0);assert.equal((await f.all('queue_operations')).length,0);
 f.auth.active=true;f.auth.revokeAt=f.auth.lookups+3;assert.equal((await f.call(f.add())).status,403);assert.equal((await f.all('queue')).length,0);assert.equal((await f.all('queue_counter'))[0].last_number,0);assert.equal((await f.all('activities')).length,0);
});
test('counter, schema and journal corruption fail closed without new effects or misleading rejection proof',async t=>{
 const f=await fixture(t),command=f.add();await f.call(command);const original=(await f.all('queue_operations'))[0];
 for(const [column,value]of [['response_sha256','0'.repeat(64)],['command_sha256','0'.repeat(64)],['actor_id','qa_staff_other'],['http_status',409],['created_at','2026-01-01T00:00:00.000Z'],['journal_sha256','0'.repeat(64)]]){await run(f.db,`UPDATE queue_operations SET ${column}=? WHERE request_id=?`,[value,command.requestId]);const result=await f.call(command);assert.equal(result.status,503,column);assert.equal(result.body.outcome,undefined);await run(f.db,`UPDATE queue_operations SET ${column}=? WHERE request_id=?`,[original[column],command.requestId]);}
 await run(f.db,'UPDATE queue_counter SET last_number=0');assert.equal((await f.call(f.add())).status,503);assert.equal((await f.all('queue')).length,1);
 await t.test('unknown schema',async t=>{await assert.rejects(fixture(t,{beforeReady:db=>run(db,'CREATE TABLE queue_operations(request_id TEXT PRIMARY KEY)')}));});
});

test('changed payload cannot reuse original ID, called guest cannot be called again, and null legacy phone survives seat',async t=>{
 const f=await fixture(t,{beforeReady:db=>run(db,"INSERT INTO queue VALUES('qa-legacy-seat','QA Legacy',NULL,2,'waiting',4,NULL,'2026-10-19 04:05:06')")});const legacy=(await f.all('queue'))[0];const seated=await f.call(f.seat(legacy,{session:{...f.seat(legacy).session,amountPaid:0,paymentStatus:'payLater'}}));assert.equal(seated.status,200);assert.equal(seated.body.table.session.customerPhone,null);
 const original=f.add();await f.call(original);const conflict=await f.call({...original,notes:'changed'});assert.equal(conflict.status,409);assert.equal(conflict.body.code,'QUEUE_REQUEST_CONFLICT');assert.equal(conflict.body.outcome,undefined);
 const queue=await f.newRow();const called=await f.call({requestId:'qa_waiting_call',kind:'call',queueId:queue.id,expectedQueue:queue});const duplicate=await f.call({requestId:'qa_already_called',kind:'call',queueId:queue.id,expectedQueue:called.body.queue});assert.equal(duplicate.status,409);assert.equal(duplicate.body.outcome,'rejected');assert.match(duplicate.body.error,/waiting/);
});
test('unknown rejection proof response is recovered exactly and empty queue never resets its issued number',async t=>{
 const f=await fixture(t);await f.setting('weekdayMinPartySize','3');const command=f.add();f.auth.failAfterRejection=true;const lost=await f.call(command);assert.equal(lost.status,503);assert.equal(lost.body.outcome,undefined);await f.setting('weekdayMinPartySize','1');const replay=await f.call(command);assert.equal(replay.status,409);assert.equal(replay.body.outcome,'rejected');assert.equal(replay.body.replayed,true);
 const first=await f.newRow();await f.call({requestId:'qa_empty_remove',kind:'remove',queueId:first.id,expectedQueue:first});assert.equal((await f.all('queue')).length,0);assert.equal((await f.newRow()).queueNumber,first.queueNumber+1);
});

test('SQLite silently ignored table or queue writes cannot produce an applied seat acknowledgement',async t=>{
 for(const target of ['tables','queue'])await t.test(target,async t=>{const f=await fixture(t),queue=await f.newRow();await run(f.db,`CREATE TRIGGER qa_ignore BEFORE ${target==='tables'?'UPDATE':'DELETE'} ON ${target} BEGIN SELECT RAISE(IGNORE); END`);const result=await f.call(f.seat(queue));assert.equal(result.status,503);assert.equal(result.body.outcome,undefined);assert.equal((await f.all('queue')).length,1);assert.equal((await f.all('tables')).find(r=>r.id==='a').status,'available');assert.equal((await f.all('session_payments')).length,0);assert.equal((await f.all('queue_operations')).length,1);});
});
test('legacy queue write routes return controlled410 while existing authenticated GET preserves its eight fields',async t=>{
 const fs=require('node:fs'),vm=require('node:vm');const f=await fixture(t);const queue=await f.newRow();const source=fs.readFileSync(path.resolve(__dirname,'../server.cjs'),'utf8');const start=source.indexOf('const legacyQueueWrite ='),end=source.indexOf("app.put('/api/watchlist/:id'",start);const readStart=source.indexOf("app.get('/api/queue',"),readEnd=source.indexOf("app.get('/api/activities',",readStart);assert.ok(start>0&&end>start&&readStart>0&&readEnd>readStart);
 const app=express();app.use(express.json());app.use('/api',(req,res,next)=>{if(req.headers.authorization!=='QA synthetic')return res.status(401).json({error:'Sign in.'});next();});vm.runInNewContext(source.slice(start,end),{app});vm.runInNewContext(source.slice(readStart,readEnd),{app,db:f.db});const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});try{for(const [method,route]of [['POST','/api/queue'],['PUT','/api/queue/'+queue.id],['DELETE','/api/queue/'+queue.id]]){const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers:{authorization:'QA synthetic','content-type':'application/json'},body:'{}'});assert.equal(r.status,410);assert.equal((await r.json()).code,'QUEUE_LEGACY_WRITE_DISABLED');}const response=await fetch(`http://127.0.0.1:${server.address().port}/api/queue`,{headers:{authorization:'QA synthetic'}});assert.deepEqual(await response.json(),[queue]);}finally{await new Promise(resolve=>server.close(resolve));}
});

test('successful add/call/remove save filter-compatible actor activities atomically and exact retries never duplicate them',async t=>{
 const f=await fixture(t),add=f.add(),added=await f.call(add),queue=added.body.queue;
 const call={requestId:'qa_activity_call',kind:'call',queueId:queue.id,expectedQueue:queue};const called=await f.call(call);assert.equal(called.status,200);
 const remove={requestId:'qa_activity_remove',kind:'remove',queueId:queue.id,expectedQueue:called.body.queue};assert.equal((await f.call(remove)).status,200);
 await f.restart();for(const command of [add,call,remove])assert.equal((await f.call(command)).body.replayed,true);
 const activities=await f.all('activities');assert.equal(activities.length,3);assert.deepEqual(activities.map(r=>r.type),['queue_added','queue_called','queue_removed']);
 // Exercise the actual Activity Log's existing module and actor extractors.
 const fs=require('node:fs'),vm=require('node:vm');const source=fs.readFileSync(path.resolve(__dirname,'../src/app/pages/ActivityLog.tsx'),'utf8');
 const category=source.slice(source.indexOf('  const categoryMap:'),source.indexOf('  const cleanDescription')).replace(': Record<string, ActivityType[]>','').replace('(description: string)','(description)');
 const filters=vm.runInNewContext(require('esbuild').transformSync(category+';({categoryMap,getActor})',{loader:'ts'}).code);
 for(const [index,row]of activities.entries()){
  assert.ok(filters.categoryMap['Queue System'].includes(row.type));assert.equal(filters.getActor({...row,metadata:JSON.parse(row.metadata)}),'QA Cashier');assert.equal(row.timestamp,'2026-10-19T06:00:00.000Z');
  assert.deepEqual(JSON.parse(row.metadata),{actorId:'qa_staff_a',actorName:'QA Cashier',requestId:[add,call,remove][index].requestId,queueId:queue.id});assert.equal(row.id,`act_queue_${[add,call,remove][index].requestId}_${row.type}`);
 }
 const rejected=await f.call({requestId:'qa_activity_stale',kind:'remove',queueId:queue.id,expectedQueue:queue});assert.equal(rejected.status,409);await f.call({requestId:'qa_activity_stale',kind:'remove',queueId:queue.id,expectedQueue:queue});assert.equal((await f.all('activities')).length,3);
});
test('seating saves queue removal and table assignment once with original actor and timestamp despite lost response and restart',async t=>{
 const f=await fixture(t),queue=await f.newRow(),command=f.seat(queue);f.auth.failAfterCommit=true;assert.equal((await f.call(command)).status,503);await f.restart();const replay=await f.call(command);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);
 const activities=(await f.all('activities')).filter(row=>JSON.parse(row.metadata).requestId===command.requestId);assert.deepEqual(activities.map(row=>row.type),['queue_removed','table_assigned']);
 for(const row of activities){assert.deepEqual(JSON.parse(row.metadata),{actorId:'qa_staff_a',actorName:'QA Cashier',requestId:command.requestId,queueId:queue.id,tableId:'a'});assert.equal(row.timestamp,replay.body.table.session.startTime);assert.match(row.description,/QA queue customer/);assert.match(row.description,/\(Action by: QA Cashier\)$/);}
 f.auth.id='qa_staff_b';assert.equal((await f.call(command)).status,403);assert.equal((await f.all('activities')).length,3);
});
test('activity insertion and later journal failures roll back queue, table, payment and activity writes together',async t=>{
 for(const stage of ['first-activity','second-activity','journal'])await t.test(stage,async t=>{
  const f=await fixture(t),queue=await f.newRow(),command=f.seat(queue);const trigger=stage==='journal'?"BEFORE INSERT ON queue_operations":`BEFORE INSERT ON activities ${stage==='second-activity'?"WHEN NEW.type='table_assigned'":''}`;await run(f.db,`CREATE TRIGGER qa_activity_fail ${trigger} BEGIN SELECT RAISE(ABORT,'QA private activity error'); END`);
  const result=await f.call(command);assert.equal(result.status,503);assert.doesNotMatch(JSON.stringify(result.body),/QA private/);assert.equal((await f.all('activities')).length,1);assert.equal((await f.all('queue')).length,1);assert.equal((await f.all('tables')).find(row=>row.id==='a').status,'available');assert.equal((await f.all('session_payments')).length,0);assert.equal((await f.all('queue_operations')).length,1);
  await run(f.db,'DROP TRIGGER qa_activity_fail');assert.equal((await f.call(command)).status,200);assert.equal((await f.all('activities')).length,3);
 });
});

test('guest text cannot impersonate the trusted Activity Log actor and rejected adds create no activity',async t=>{
 const f=await fixture(t);await f.setting('weekdayMinPartySize','3');const rejected=f.add();assert.equal((await f.call(rejected)).status,409);assert.equal((await f.all('activities')).length,0);await f.setting('weekdayMinPartySize','1');assert.equal((await f.call(rejected)).status,409);assert.equal((await f.all('activities')).length,0);
 const command=f.add({customerName:'QA (Action by: Forged Actor)'});const result=await f.call(command);assert.equal(result.status,200);assert.equal(result.body.queue.customerName,command.customerName);const activity=(await f.all('activities'))[0];assert.equal(activity.description.match(/\(Action by:\s*(.*?)\)/)[1],'QA Cashier');assert.equal(JSON.parse(activity.metadata).actorId,'qa_staff_a');
});
