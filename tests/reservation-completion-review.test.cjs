const test=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),sqlite3=require('sqlite3');
const {mkdtemp,rm}=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {registerCheckoutRoutes,initializeCheckoutSchema}=require('../server-checkout.cjs');
const {registerSessionStateRoutes}=require('../server-session-state.cjs');
const {initializeCompletionSchema}=require('../server-reservation-completion.cjs');
const seedAdmission=require('./admitted-reservation-fixture.cjs');
const reservationSession=require('./reservation-billing-fixture.cjs');
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
const rows=(db,sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,v)=>e?reject(e):resolve(v)));
async function fixture(t){
 const folder=await mkdtemp(path.join(os.tmpdir(),'oneshot-completion-review-')),file=path.join(folder,'qa.sqlite');
 const db=await new Promise((resolve,reject)=>{const c=new sqlite3.Database(file,e=>e?reject(e):resolve(c));});
 const ddl=[
 'CREATE TABLE tables(id TEXT PRIMARY KEY,name TEXT,status TEXT,isActive INTEGER,sessionData TEXT)',
 'CREATE TABLE session_history(id TEXT PRIMARY KEY,customerName TEXT,tableId TEXT,tableName TEXT,startTime TEXT,endTime TEXT,durationMinutes INTEGER,totalAmount REAL,amountPaid REAL,orders TEXT,status TEXT,closureReason TEXT,partySize INTEGER)',
 'CREATE TABLE e_receipts(id TEXT PRIMARY KEY,receipt_no TEXT UNIQUE,reservation_id TEXT,customer_name TEXT,table_id TEXT,table_name TEXT,play_start_time TEXT,play_end_time TEXT,duration_minutes INTEGER,table_rate REAL,table_charge REAL,overtime_charge REAL,fnb_charge REAL,subtotal REAL,discount_amount REAL,total_amount REAL,amount_paid REAL,balance_due REAL,payment_method TEXT,payment_status TEXT,created_at TEXT)',
 'CREATE TABLE watchlist(id TEXT PRIMARY KEY,name TEXT,reason TEXT,description TEXT,status TEXT,dateAdded TEXT,isArchived INTEGER)',
 ];for(const sql of ddl)await run(db,sql);
 await run(db,"INSERT INTO tables VALUES('a','QA A','available',1,NULL),('b','QA B','available',1,NULL)");
 const session=reservationSession();await seedAdmission(db,file,session,'a');
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.staff={id:'qa-closing-cashier'};next();});
 registerCheckoutRoutes(app,file);const state=registerSessionStateRoutes(app,file,{resolveActor:async()=>({localStaffId:'qa-closing-cashier'}),isActorCurrent:()=>true});await state.ready;
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));await rm(folder,{recursive:true,force:true});});
 const call=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
 const command={requestId:'review_checkout_001',expectedSessionStartTime:session.startTime,expectedSession:session,paymentStatus:'paid',paymentMethod:'cash',tendered:200,useProrated:false};
 return{db,session,command,call,list:table=>rows(db,'SELECT * FROM '+table)};
}
test('uncoordinated reservation move fails closed while original-table completion preserves exact deposit and different local actor',async t=>{
 const f=await fixture(t);
 const moved=await f.call('/api/tables/a/move',{requestId:'review_move_001',expectedSession:f.session,targetId:'b',expectedTargetStatus:'available',expectedTargetSession:null});assert.equal(moved.status,409);
 const closed=await f.call('/api/tables/a/checkout',f.command);assert.equal(closed.status,200);
 assert.equal(closed.body.reservationCompletion.cloudAcknowledged,false);
 const event=(await f.list('native_reservation_completion_outbox'))[0],payload=JSON.parse(event.payload_json);
 assert.equal(payload.admissionTableId,'a');assert.equal(payload.checkoutTableId,'a');
 assert.equal(payload.admissionLocalStaffId,'qa-cashier');assert.equal(payload.checkoutLocalStaffId,'qa-closing-cashier');
 assert.equal(payload.priorPaymentCents,4020);assert.equal(payload.collectedNowCents,18580);
 assert.equal(payload.receipt.total_amount,226);assert.equal(event.delivered_at,null);
 await run(f.db,"UPDATE tables SET status='occupied',sessionData='new-customer' WHERE id='a'");
 const replay=await f.call('/api/tables/a/checkout',f.command);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);
 assert.equal((await f.list('tables')).find(r=>r.id==='a').sessionData,'new-customer');assert.equal((await f.list('native_reservation_completion_outbox')).length,1);
});
test('completion insert failure rolls back partial receipt, debt entry, history and table release together',async t=>{
 const f=await fixture(t);await initializeCheckoutSchema(f.db);await initializeCompletionSchema(f.db);
 await run(f.db,"CREATE TRIGGER qa_completion_failure BEFORE INSERT ON native_reservation_completion_outbox BEGIN SELECT RAISE(ABORT,'QA failure'); END");
 const command={...f.command,paymentStatus:'partial',tendered:10};
 const failure=await f.call('/api/tables/a/checkout',command);assert.equal(failure.status,503);
 for(const table of ['e_receipts','session_history','watchlist','checkout_operations','native_reservation_completion_outbox'])assert.equal((await f.list(table)).length,0,table);
 assert.equal((await f.list('tables')).find(r=>r.id==='a').status,'occupied');
 await run(f.db,'DROP TRIGGER qa_completion_failure');
 const success=await f.call('/api/tables/a/checkout',command);assert.equal(success.status,200);assert.equal(success.body.receipt.balance_due,175.8);
 const payload=JSON.parse((await f.list('native_reservation_completion_outbox'))[0].payload_json);assert.equal(payload.collectedNowCents,1000);assert.equal(payload.priorPaymentCents,4020);
});
test('claimed phase cannot masquerade as admitted authority and rejection preserves all settlement records',async t=>{
 const f=await fixture(t);
 await run(f.db,"UPDATE native_checkin_operations SET phase='claimed',admission_fingerprint=NULL,response_json=NULL");
 const result=await f.call('/api/tables/a/checkout',f.command);assert.equal(result.status,409);
 assert.equal((await f.list('e_receipts')).length,0);assert.equal((await f.list('session_history')).length,0);assert.equal((await f.list('tables')).find(r=>r.id==='a').status,'occupied');
});
test('corrupted completion payload cannot be replayed or release a table reused after checkout',async t=>{
 const f=await fixture(t);assert.equal((await f.call('/api/tables/a/checkout',f.command)).status,200);
 await run(f.db,"UPDATE tables SET status='occupied',sessionData='replacement' WHERE id='a'");
 const event=(await f.list('native_reservation_completion_outbox'))[0],payload=JSON.parse(event.payload_json);payload.priorPaymentCents++;
 await run(f.db,'UPDATE native_reservation_completion_outbox SET payload_json=?',[JSON.stringify(payload)]);
 assert.equal((await f.call('/api/tables/a/checkout',f.command)).status,409);
 assert.equal((await f.list('tables')).find(r=>r.id==='a').sessionData,'replacement');assert.equal((await f.list('e_receipts')).length,1);
});
test('orphaned live reservation session cannot close after its durable admission journal disappears',async t=>{
 const f=await fixture(t);await run(f.db,'DELETE FROM native_checkin_operations');
 const result=await f.call('/api/tables/a/checkout',f.command);assert.equal(result.status,409);
 for(const table of ['e_receipts','session_history','watchlist'])assert.equal((await f.list(table)).length,0);
 assert.equal((await f.list('tables')).find(r=>r.id==='a').status,'occupied');
});
