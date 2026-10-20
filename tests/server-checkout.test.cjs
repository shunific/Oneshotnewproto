const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sqlite3 = require('sqlite3');
const {mkdtemp,rm} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {registerCheckoutRoutes,calculateCheckout} = require('../server-checkout.cjs');
const {registerOrderRoutes} = require('../server-orders.cjs');
const {registerRefundRoutes} = require('../server-refunds.cjs');
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,error=>error?reject(error):resolve()));
const all=(db,sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(error,rows)=>error?reject(error):resolve(rows)));
async function fixture(t, staff) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'checkout-test-'));const file=path.join(dir,'test.db');
  const db=await new Promise((resolve,reject)=>{const conn=new sqlite3.Database(file,error=>error?reject(error):resolve(conn));});
  await run(db,'CREATE TABLE tables (id TEXT PRIMARY KEY,name TEXT,status TEXT,isActive INTEGER,sessionData TEXT)');
  await run(db,'CREATE TABLE session_history (id TEXT PRIMARY KEY,customerName TEXT,tableId TEXT,tableName TEXT,startTime TEXT,endTime TEXT,durationMinutes INTEGER,totalAmount REAL,amountPaid REAL,orders TEXT,status TEXT,closureReason TEXT,partySize INTEGER)');
  await run(db,'CREATE TABLE e_receipts (id TEXT PRIMARY KEY,receipt_no TEXT UNIQUE,reservation_id TEXT,customer_name TEXT,table_id TEXT,table_name TEXT,play_start_time TEXT,play_end_time TEXT,duration_minutes INTEGER,table_rate REAL,table_charge REAL,overtime_charge REAL,fnb_charge REAL,subtotal REAL,discount_amount REAL,total_amount REAL,amount_paid REAL,balance_due REAL,payment_method TEXT,payment_status TEXT,created_at TEXT)');
  await run(db,'CREATE TABLE watchlist (id TEXT PRIMARY KEY,name TEXT,reason TEXT,description TEXT,status TEXT,dateAdded TEXT,isArchived INTEGER)');
  const session={customerName:'QA fixture',startTime:new Date(Date.now()-10*60000).toISOString(),durationMinutes:120,isOpenTime:false,hourlyRate:150,amountPaid:60,orders:[{id:'a',name:'Apple',price:12.5,qty:2}]};
  await run(db,'INSERT INTO tables VALUES(?,?,?,?,?)',['t1','QA table','occupied',1,JSON.stringify(session)]);
  await run(db,"CREATE TABLE inventory(id TEXT PRIMARY KEY,name TEXT,price REAL,stock INTEGER,isActive INTEGER)");
  await run(db,"INSERT INTO inventory VALUES('b','Bread',20,5,1)");
  const auth={staff};
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.staff=auth.staff;next();});registerCheckoutRoutes(app,file);registerOrderRoutes(app,file);registerRefundRoutes(app,file,{requireAdmin:(_req,_res,next)=>next()});
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));await rm(dir,{recursive:true,force:true});});
  let n=0;
  const body=extra=>({requestId:`checkout_request_${++n}`,expectedSessionStartTime:session.startTime,expectedSession:session,paymentStatus:'paid',paymentMethod:'cash',tendered:300,useProrated:false,...extra});
  const call=async payload=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/tables/t1/checkout`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});return{status:response.status,body:await response.json()};};
  const order=async()=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/tables/t1/orders`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:'concurrent_order',expectedSessionStartTime:session.startTime,cart:[{id:'b',qty:1}]})});return {status:response.status,body:await response.json()};};
  return{db,file,session,body,call,order,auth,refund:async(id,payload)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/e-receipts/${id}/refund-return`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});return{status:response.status,body:await response.json()};},rows:table=>all(db,`SELECT * FROM ${table}`)};
}
test('checkout commits history, receipt and table release; change is not counted as revenue',async t=>{
 const f=await fixture(t);const r=await f.call(f.body());assert.equal(r.status,200);
 assert.equal(r.body.receipt.total_amount,325);assert.equal(r.body.receipt.amount_paid,325);assert.equal(r.body.totalPaidNow,265);assert.equal(r.body.change,35);
 assert.equal((await f.rows('tables'))[0].sessionData,null);assert.equal((await f.rows('tables'))[0].status,'available');
 assert.equal((await f.rows('session_history')).length,1);assert.equal((await f.rows('e_receipts')).length,1);assert.equal((await f.rows('checkout_operations')).length,1);
});
test('payment form cannot shadow the routed table in the durable checkout command',async t=>{
 const f=await fixture(t);for(const tableId of ['forged-other-table','t1',null])assert.equal((await f.call(f.body({tableId}))).status,400);
 assert.equal((await f.rows('e_receipts')).length,0);assert.equal((await f.rows('session_history')).length,0);assert.equal((await f.rows('tables'))[0].status,'occupied');
 assert.equal((await f.call(f.body())).status,200);
});
test('parallel duplicate and lost-response retries issue one receipt and preserve a newly reused table',async t=>{
 const f=await fixture(t);const payload=f.body();const results=await Promise.all([f.call(payload),f.call(payload)]);assert.ok(results.every(r=>r.status===200));assert.equal(results[0].body.receipt.id,results[1].body.receipt.id);
 const replacement={...f.session,startTime:new Date().toISOString(),customerName:'Replacement'};await run(f.db,"UPDATE tables SET status='occupied',sessionData=?",[JSON.stringify(replacement)]);
 const replay=await f.call(payload);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal((await f.rows('session_history')).length,1);assert.deepEqual(JSON.parse((await f.rows('tables'))[0].sessionData),replacement);
 assert.equal((await f.call({...payload,tendered:400})).status,409);
 assert.equal((await f.call(f.body())).status,409);
});
test('simultaneous different checkout requests cannot record two payments',async t=>{
 const f=await fixture(t);const results=await Promise.all([f.call(f.body()),f.call(f.body())]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await f.rows('e_receipts')).length,1);
});
test('unseen orders or extension changes reject stale checkout without releasing table',async t=>{
 const f=await fixture(t);await run(f.db,'UPDATE tables SET sessionData=?',[JSON.stringify({...f.session,orders:[...f.session.orders,{id:'b',price:30,qty:1}]})]);
 assert.equal((await f.call(f.body())).status,409);assert.equal((await f.rows('tables'))[0].status,'occupied');assert.equal((await f.rows('e_receipts')).length,0);
});
test('wrong money and malformed payment requests leave all business records untouched',async t=>{
 const f=await fixture(t);
 for(const extra of [{tendered:264},{tendered:-1},{tendered:1.234},{paymentStatus:'partial',tendered:0},{paymentStatus:'partial',tendered:265},{paymentStatus:'unpaid',tendered:1},{paymentMethod:'gcash',tendered:300,paymentReference:'ref'},{paymentMethod:'gcash',tendered:265},{expectedSession:null},{expectedSessionStartTime:'yesterday'}]) {
  assert.equal((await f.call(f.body(extra))).status,400);assert.equal((await f.rows('tables'))[0].status,'occupied');assert.equal((await f.rows('e_receipts')).length,0);
 }
});
test('receipt insert failure rolls history and table closure back; same request retries successfully',async t=>{
 const f=await fixture(t);await run(f.db,"CREATE TRIGGER fail_receipt BEFORE INSERT ON e_receipts BEGIN SELECT RAISE(ABORT,'disk fixture failure'); END");const payload=f.body();
 assert.equal((await f.call(payload)).status,503);assert.equal((await f.rows('session_history')).length,0);assert.equal((await f.rows('tables'))[0].status,'occupied');
 await run(f.db,'DROP TRIGGER fail_receipt');assert.equal((await f.call(payload)).status,200);assert.equal((await f.rows('session_history')).length,1);
});
test('partial and unpaid checkout persist actual remaining debt and payment status',async t=>{
 for(const [paymentStatus,tendered,paid,balance] of [['partial',100,160,165],['unpaid',0,60,265]]) {
  await t.test(paymentStatus,async t=>{const f=await fixture(t);const r=await f.call(f.body({paymentStatus,tendered}));assert.equal(r.status,200);assert.equal(r.body.receipt.amount_paid,paid);assert.equal(r.body.receipt.balance_due,balance);assert.equal(r.body.receipt.payment_status,'partial');assert.equal((await f.rows('watchlist')).length,1);});
 }
});
test('authoritative billing preserves prepaid, minimum hour, half-hour steps, overtime and refund semantics',()=>{
 const now=Date.parse('2026-10-19T08:00:00Z');const base={customerName:'QA',startTime:'2026-10-19T07:50:00Z',durationMinutes:120,isOpenTime:false,hourlyRate:150,amountPaid:300,orders:[]};
 assert.equal(calculateCheckout(base,now,false).totalCents,30000);
 const prorated=calculateCheckout(base,now,true);assert.equal(prorated.totalCents,15000);assert.equal(prorated.refundCents,15000);
 assert.equal(calculateCheckout({...base,isOpenTime:true,startTime:'2026-10-19T06:59:00Z'},now,false).totalCents,22500);
 assert.equal(calculateCheckout({...base,durationMinutes:60,startTime:'2026-10-19T06:58:00Z'},now,false).overtimeCents,500);
 assert.throws(()=>calculateCheckout({...base,startTime:'2026-10-19T09:00:00Z'},now,false));
});

test('order versus checkout race either includes a reviewed bill or rejects the stale checkout',async t=>{
 const f=await fixture(t);const [checkout,order]=await Promise.all([f.call(f.body()),f.order()]);
 assert.deepEqual([checkout.status,order.status].sort(),[200,409]);
 if(checkout.status===200) {assert.equal(checkout.body.receipt.total_amount,325);assert.equal((await f.rows('inventory'))[0].stock,5);assert.equal((await f.rows('tables'))[0].status,'available');}
 else {assert.equal((await f.rows('inventory'))[0].stock,4);assert.equal((await f.rows('tables'))[0].status,'occupied');assert.equal((await f.rows('session_history')).length,0);}
});

test('walkout records its status and debt flag atomically without inventing payment',async t=>{
 const f=await fixture(t);const r=await f.call(f.body({closureKind:'walkout',paymentStatus:'unpaid',tendered:0}));assert.equal(r.status,200);assert.equal(r.body.history.status,'walkout');assert.equal(r.body.receipt.amount_paid,60);assert.equal((await f.rows('watchlist'))[0].reason,'theft');
});

test('prepaid overpayment remains a durable pending refund instead of a fictional completed refund',async t=>{
 const f=await fixture(t);const prepaid={...f.session,amountPaid:300,orders:[]};await run(f.db,'UPDATE tables SET sessionData=?',[JSON.stringify(prepaid)]);
 const payload=f.body({expectedSession:prepaid,tendered:0,useProrated:true});const response=await f.call(payload);assert.equal(response.status,200);
 assert.equal(response.body.history.status,'refund_pending');assert.equal(response.body.receipt.refund_due,150);assert.equal(response.body.receipt.refund_status,'pending');assert.equal(response.body.receipt.payment_status,'refund_pending');
 const receipt=(await f.rows('e_receipts'))[0];assert.equal(receipt.refund_due,150);assert.equal(receipt.refund_status,'pending');assert.equal(receipt.amount_paid,150);
 const replay=await f.call(payload);assert.equal(replay.body.receipt.refund_status,'pending');assert.equal((await f.rows('e_receipts')).length,1);
});
test('invalid GCash references cannot settle or release the session',async t=>{
 const f=await fixture(t);
 for(const paymentReference of ['a-b',' -- ','QA_123','QA\t123','QA💰123','x'.repeat(121)]) {
  assert.equal((await f.call(f.body({paymentMethod:'gcash',tendered:265,paymentReference}))).status,400);
 }
 assert.equal((await f.rows('e_receipts')).length,0);assert.equal((await f.rows('session_history')).length,0);assert.equal((await f.rows('tables'))[0].status,'occupied');
});
test('electronic payment reference is durable on the saved receipt',async t=>{
 const f=await fixture(t);const response=await f.call(f.body({paymentMethod:'gcash',tendered:265,paymentReference:' QA-REFERENCE-001 '}));assert.equal(response.status,200);assert.equal(response.body.receipt.payment_reference,'QA-REFERENCE-001');assert.equal((await f.rows('e_receipts'))[0].payment_reference,'QA-REFERENCE-001');
});
test('receipt financial migration preserves existing rows and is safe across repeat checkout initialization',async t=>{
 const f=await fixture(t);await run(f.db,"INSERT INTO e_receipts (id,receipt_no,total_amount,amount_paid) VALUES ('legacy','REC-LEGACY',50,50)");
 const payload=f.body();assert.equal((await f.call(payload)).status,200);assert.equal((await f.call(payload)).status,200);
 const legacy=(await f.rows('e_receipts')).find(receipt=>receipt.id==='legacy');assert.equal(legacy.total_amount,50);assert.equal(legacy.refund_due,0);assert.equal(legacy.refund_status,'none');assert.equal(legacy.payment_reference,null);assert.equal(legacy.overtime_minutes,null);assert.equal(legacy.overtime_rate,null);assert.equal(legacy.pricing_version,null);
});

const voidBody=f=>f.body({closureKind:'void',reason:'QA accidental booking',tendered:0,paymentStatus:'unpaid',paymentMethod:'cash',useProrated:false});
const administrator={id:'qa-admin',fullName:'QA Administrator',isAdmin:true};
test('whole-session void rejects anonymous and cashier requests without changing money or stock',async t=>{
 for(const staff of [undefined,{id:'qa-cashier',isAdmin:false}]) {
  await t.test(staff?'cashier':'anonymous',async t=>{const f=await fixture(t,staff);assert.equal((await f.call(voidBody(f))).status,403);assert.equal((await f.rows('tables'))[0].status,'occupied');assert.equal((await f.rows('e_receipts')).length,0);assert.equal((await f.rows('inventory'))[0].stock,5);});
 }
});
test('administrator void atomically waives bill, retains consumed stock and records actor, reason and prepaid refund liability',async t=>{
 const f=await fixture(t,administrator);const beforeStock=(await f.rows('inventory'))[0].stock;
 const r=await f.call(voidBody(f));assert.equal(r.status,200);assert.equal(r.body.history.status,'voided');assert.equal(r.body.history.totalAmount,0);assert.equal(r.body.history.amountPaid,0);assert.match(r.body.history.closureReason,/qa-admin/);assert.match(r.body.history.closureReason,/consumed inventory remains deducted/);
 const receipt=(await f.rows('e_receipts'))[0];assert.equal(receipt.total_amount,0);assert.equal(receipt.subtotal,325);assert.equal(receipt.table_charge,300);assert.equal(receipt.fnb_charge,25);assert.equal(receipt.discount_amount,325);assert.equal(receipt.original_amount,325);assert.equal(receipt.void_reason,'QA accidental booking');assert.equal(receipt.void_actor_id,'qa-admin');assert.equal(receipt.void_actor_name,'QA Administrator');assert.equal(receipt.refund_due,60);assert.equal(receipt.refund_status,'pending');assert.equal(receipt.payment_status,'voided_refund_pending');assert.equal(receipt.amount_paid,0);assert.equal(receipt.balance_due,0);
 assert.equal((await f.rows('inventory'))[0].stock,beforeStock);assert.equal((await f.rows('tables'))[0].status,'available');assert.equal((await f.rows('watchlist')).length,0);
});
test('void duplicate, stale, reused-table and unauthorized replay cannot duplicate a waiver or clear another customer',async t=>{
 const f=await fixture(t,administrator);const payload=voidBody(f);const results=await Promise.all([f.call(payload),f.call(payload)]);assert.ok(results.every(r=>r.status===200));assert.equal(results[0].body.receipt.id,results[1].body.receipt.id);assert.equal((await f.rows('session_history')).length,1);
 f.auth.staff={id:'qa-cashier',isAdmin:false};assert.equal((await f.call(payload)).status,403);f.auth.staff=administrator;
 const replacement={...f.session,startTime:new Date().toISOString(),customerName:'Replacement'};await run(f.db,"UPDATE tables SET status='occupied',sessionData=?",[JSON.stringify(replacement)]);
 assert.equal((await f.call(payload)).body.replayed,true);assert.deepEqual(JSON.parse((await f.rows('tables'))[0].sessionData),replacement);assert.equal((await f.call({...payload,reason:'different reason'})).status,409);assert.equal((await f.call(voidBody(f))).status,409);assert.equal((await f.rows('e_receipts')).length,1);
});
test('void validation and failed receipt insertion preserve the active session and allow exact retry',async t=>{
 const f=await fixture(t,administrator);for(const extra of [{reason:''},{reason:'x'.repeat(1001)},{tendered:1},{paymentStatus:'paid'},{useProrated:true}])assert.equal((await f.call({...voidBody(f),...extra})).status,400);
 await run(f.db,"CREATE TRIGGER fail_void_receipt BEFORE INSERT ON e_receipts BEGIN SELECT RAISE(ABORT,'fixture write failure'); END");const payload=voidBody(f);assert.equal((await f.call(payload)).status,503);assert.equal((await f.rows('tables'))[0].status,'occupied');assert.equal((await f.rows('session_history')).length,0);
 await run(f.db,'DROP TRIGGER fail_void_receipt');assert.equal((await f.call(payload)).status,200);assert.equal((await f.rows('session_history')).length,1);
});


test('versioned overtime snapshot is audited and exact retries produce one immutable receipt',async t=>{
 const f=await fixture(t);const session={...f.session,startTime:new Date(Date.now()-62*60000).toISOString(),durationMinutes:60,pricingVersion:1,overtimeRate:75,orders:[],amountPaid:0};
 await run(f.db,'UPDATE tables SET sessionData=?',[JSON.stringify(session)]);
 await run(f.db,'CREATE TABLE systemSettings(keyName TEXT PRIMARY KEY,settingValue TEXT)');await run(f.db,"INSERT INTO systemSettings VALUES('overtimeRate','4999')");
 const payload=f.body({expectedSession:session,expectedSessionStartTime:session.startTime,tendered:500});
 const result=await f.call(payload);assert.equal(result.status,200);assert.equal(result.body.receipt.overtime_rate,75);assert.equal(result.body.receipt.pricing_version,1);assert.equal(result.body.receipt.overtime_charge,2.5);assert.equal(result.body.receipt.overtime_minutes,2);assert.equal(result.body.receipt.total_amount,152.5);
 await run(f.db,"UPDATE systemSettings SET settingValue='1'");const replay=await f.call(payload);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.deepEqual(replay.body.receipt,result.body.receipt);assert.equal((await f.rows('e_receipts')).length,1);assert.equal((await f.rows('checkout_operations')).length,1);
});
test('invalid version or overtime snapshot cannot close or create any financial rows',async t=>{
 const f=await fixture(t);
 for(const fields of [{pricingVersion:2,overtimeRate:75},{pricingVersion:1},{pricingVersion:1,overtimeRate:0},{pricingVersion:1,overtimeRate:1.001}]) {
  const session={...f.session,...fields};await run(f.db,'UPDATE tables SET sessionData=?',[JSON.stringify(session)]);
  assert.equal((await f.call(f.body({expectedSession:session}))).status,409);assert.equal((await f.rows('tables'))[0].status,'occupied');assert.equal((await f.rows('e_receipts')).length,0);assert.equal((await f.rows('session_history')).length,0);
 }
});
test('legacy checkout audits actual hourly fallback despite unrelated overtime fields',async t=>{
 const f=await fixture(t);const session={...f.session,overtimeRate:1};await run(f.db,'UPDATE tables SET sessionData=?',[JSON.stringify(session)]);
 const r=await f.call(f.body({expectedSession:session}));assert.equal(r.status,200);assert.equal(r.body.receipt.overtime_rate,150);assert.equal(r.body.receipt.pricing_version,0);
});
const reservationSession=require('./reservation-billing-fixture.cjs');
const seedAdmission=require('./admitted-reservation-fixture.cjs');
async function admitted(f,s){if(!f.auth.staff)f.auth.staff={id:'qa-cashier',isAdmin:false};await seedAdmission(f.db,f.file,s,'t1',f.auth.staff.id);}
test('reservation completion snapshots exact cents and distinct admission/closing staff without claiming cloud success',async t=>{
 const f=await fixture(t),s=reservationSession();await admitted(f,s);f.auth.staff={id:'next-shift-cashier',isAdmin:false};
 const payload=f.body({expectedSession:s,expectedSessionStartTime:s.startTime,tendered:200});const r=await f.call(payload);assert.equal(r.status,200);
 const events=await f.rows('native_reservation_completion_outbox');assert.equal(events.length,1);assert.equal(events[0].delivered_at,null);const event=JSON.parse(events[0].payload_json);
 assert.equal(event.admissionLocalStaffId,'qa-cashier');assert.equal(event.checkoutLocalStaffId,'next-shift-cashier');assert.equal(event.admissionCloudUserId,'33333333-3333-4333-8333-333333333333');assert.deepEqual(event.reservationPricing,s.reservationPricing);
 assert.deepEqual(event.amounts,{bookedGrossCents:30101,bookingDiscountCents:10001,bookedNetCents:20100,overtimeCents:0,foodAndDrinkCents:2500,sessionWaiverCents:0,totalCents:22600,allocatedPaidCents:22600,balanceCents:0});
 assert.equal(event.priorPaymentCents,4020);assert.equal(event.collectedNowCents,18580);assert.equal(event.tenderedCents,20000);assert.equal(event.changeCents,1420);assert.equal(event.refundDueCents,0);
 assert.deepEqual(r.body.reservationCompletion,{eventId:events[0].event_id,cloudAcknowledged:false});const replay=await f.call(payload);assert.equal(replay.status,200);assert.deepEqual(replay.body.reservationCompletion,r.body.reservationCompletion);assert.equal((await f.rows('native_reservation_completion_outbox')).length,1);
});
test('partial, walkout and void completion events retain debt or pending refund without inventing collected funds',async t=>{
 for(const mode of ['partial','walkout','void'])await t.test(mode,async t=>{
  const f=await fixture(t,administrator),s=reservationSession();await admitted(f,s);
  const extra=mode==='partial'?{paymentStatus:'partial',tendered:50}:mode==='walkout'?{closureKind:'walkout',paymentStatus:'unpaid',tendered:0}:{closureKind:'void',reason:'QA completion waiver',paymentStatus:'unpaid',tendered:0};
  const r=await f.call(f.body({expectedSession:s,expectedSessionStartTime:s.startTime,...extra}));assert.equal(r.status,200);const row=(await f.rows('native_reservation_completion_outbox'))[0],event=JSON.parse(row.payload_json);
  assert.equal(row.delivered_at,null);assert.equal(event.priorPaymentCents,4020);assert.equal(event.collectedNowCents,mode==='partial'?5000:0);assert.equal(event.amounts.balanceCents,mode==='partial'?13580:mode==='walkout'?18580:0);assert.equal(event.amounts.totalCents,mode==='void'?0:22600);assert.equal(event.amounts.sessionWaiverCents,mode==='void'?22600:0);assert.equal(event.refundDueCents,mode==='void'?4020:0);assert.equal(event.receipt.refund_status,mode==='void'?'pending':'none');assert.equal(r.body.reservationCompletion.cloudAcknowledged,false);
 });
});
test('legitimate recorded refund return preserves the original checkout completion snapshot and exact replay',async t=>{
 const f=await fixture(t,administrator),s=reservationSession();await admitted(f,s);
 const payload=f.body({expectedSession:s,expectedSessionStartTime:s.startTime,closureKind:'void',reason:'QA completion refund',paymentStatus:'unpaid',tendered:0});const first=await f.call(payload);assert.equal(first.status,200);const event=(await f.rows('native_reservation_completion_outbox'))[0];
 const returned=await f.refund(first.body.receipt.id,{requestId:'qa_actual_refund_return',expectedActorId:administrator.id,expectedRefundDueCents:4020,method:'cash',reason:'QA cash return acknowledged',acknowledgedReturned:true});assert.equal(returned.status,200);assert.equal(returned.body.receipt.refund_status,'returned');assert.equal(returned.body.fundsTransferred,false);
 const retry=await f.call(payload);assert.equal(retry.status,200);assert.equal(retry.body.replayed,true);assert.equal(retry.body.receipt.refund_status,'pending');assert.deepEqual((await f.rows('native_reservation_completion_outbox'))[0],event);assert.equal((await f.rows('e_receipts'))[0].refund_status,'returned');
});
test('reservation checkout requires signed-in local staff and rejects changed immutable admission identity',async t=>{
 const f=await fixture(t),s=reservationSession();await admitted(f,s);f.auth.staff=undefined;
 const body=f.body({expectedSession:s,expectedSessionStartTime:s.startTime,tendered:200});assert.equal((await f.call(body)).status,403);assert.equal((await f.rows('session_history')).length,0);
 f.auth.staff={id:'qa-cashier',isAdmin:false};const changed={...s,customerName:'Changed owner'};await run(f.db,'UPDATE tables SET sessionData=?',[JSON.stringify(changed)]);assert.equal((await f.call({...body,expectedSession:changed})).status,409);assert.equal((await f.rows('e_receipts')).length,0);assert.equal((await f.rows('tables'))[0].status,'occupied');
});
test('reservation checkout commits exact booking discount and verified deposit once with linked receipt/history',async t=>{
 const f=await fixture(t);const s=reservationSession();await admitted(f,s);const payload=f.body({expectedSession:s,expectedSessionStartTime:s.startTime,tendered:200,customerEmail:'renderer@invalid.test',customerPhone:'forged'});
 const results=await Promise.all([f.call(payload),f.call(payload)]);assert.ok(results.every(r=>r.status===200));const r=results[0].body;assert.equal(r.receipt.total_amount,226);assert.equal(r.receipt.subtotal,326.01);assert.equal(r.receipt.discount_amount,100.01);assert.equal(r.receipt.booking_discount_amount,100.01);assert.equal(r.receipt.table_charge,301.01);assert.equal(r.receipt.table_rate,null);assert.equal(r.receipt.original_amount,226);assert.equal(r.alreadyPaid,40.2);assert.equal(r.totalPaidNow,185.8);assert.equal(r.change,14.2);assert.equal(r.receipt.amount_paid,226);assert.equal(r.receipt.balance_due,0);assert.equal(r.receipt.reservation_id,s.reservationId);assert.equal(r.receipt.reservation_claim_id,s.reservationPricing.claimId);assert.equal(r.receipt.owner_user_id,s.reservationPricing.ownerUserId);assert.equal(r.receipt.customer_email,s.customerEmail);assert.equal(r.receipt.customer_phone,s.customerPhone);assert.equal(r.history.id,r.receipt.id);assert.equal(r.history.totalAmount,226);assert.equal(r.history.amountPaid,226);assert.equal((await f.rows('e_receipts')).length,1);assert.equal((await f.rows('session_history')).length,1);
 const reused={...f.session,startTime:new Date().toISOString()};await run(f.db,"UPDATE tables SET status='occupied',sessionData=?",[JSON.stringify(reused)]);assert.equal((await f.call(payload)).body.replayed,true);assert.deepEqual(JSON.parse((await f.rows('tables'))[0].sessionData),reused);
});
test('reservation overtime and F&B add to the immutable net quote; void preserves discount and pending prepaid liability',async t=>{
 for(const isVoid of [false,true])await t.test(isVoid?'void':'checkout',async t=>{
  const f=await fixture(t,{id:'qa_admin',isAdmin:true,fullName:'QA admin'});const s=reservationSession({startTime:new Date(Date.now()-121*60000-10000).toISOString()});await admitted(f,s);const r=await f.call(f.body({expectedSession:s,expectedSessionStartTime:s.startTime,tendered:isVoid?0:200,paymentStatus:isVoid?'unpaid':'paid',...(isVoid?{closureKind:'void',reason:'QA reservation waiver'}:{})}));assert.equal(r.status,200);assert.equal(r.body.receipt.overtime_charge,10);assert.equal(r.body.receipt.subtotal,336.01);assert.equal(r.body.receipt.booking_discount_amount,100.01);assert.equal(r.body.receipt.original_amount,236);assert.equal(r.body.receipt.total_amount,isVoid?0:236);assert.equal(r.body.receipt.discount_amount,isVoid?336.01:100.01);assert.equal(r.body.receipt.amount_paid,isVoid?0:236);assert.equal(r.body.history.totalAmount,r.body.receipt.total_amount);assert.equal(r.body.receipt.refund_due,isVoid?40.2:0);assert.equal(r.body.receipt.refund_status,isVoid?'pending':'none');assert.equal(r.body.receipt.table_rate,null);assert.equal(r.body.receipt.owner_user_id,s.reservationPricing.ownerUserId);
 });
});
test('invalid reservation billing and failed receipt persistence preserve session and verified credit for exact retry',async t=>{
 const f=await fixture(t);const s=reservationSession();await admitted(f,s);const payload=f.body({expectedSession:s,expectedSessionStartTime:s.startTime,tendered:200});assert.equal((await f.call({...payload,useProrated:true})).status,409);assert.equal((await f.rows('session_history')).length,0);
 await run(f.db,"CREATE TRIGGER fail_reservation_receipt BEFORE INSERT ON e_receipts BEGIN SELECT RAISE(ABORT,'QA failure'); END");assert.equal((await f.call(payload)).status,503);assert.equal((await f.rows('session_history')).length,0);assert.deepEqual(JSON.parse((await f.rows('tables'))[0].sessionData),s);await run(f.db,'DROP TRIGGER fail_reservation_receipt');assert.equal((await f.call(payload)).status,200);
});
test('additive reservation metadata migration keeps old receipt values and metadata NULL on reapplication',async t=>{
 const f=await fixture(t);await run(f.db,"INSERT INTO e_receipts(id,receipt_no,customer_name,table_rate,total_amount,discount_amount) VALUES('old','old-no','Legacy QA',150,300,0)");await f.call(f.body());const before=(await f.rows('e_receipts')).find(r=>r.id==='old');for(const key of ['booking_discount_amount','reservation_claim_id','owner_user_id'])assert.equal(before[key],null);assert.equal(before.table_rate,150);assert.equal(before.total_amount,300);assert.equal(before.discount_amount,0);await f.call(f.body());const after=(await f.rows('e_receipts')).find(r=>r.id==='old');assert.deepEqual(after,before);
});
test('reservation order validation keeps verified deposit and pricing snapshot while consuming inventory once',async t=>{
 const f=await fixture(t);const s=reservationSession({startTime:f.session.startTime});await admitted(f,s);const first=await f.order();assert.equal(first.status,200);assert.deepEqual(first.body.session.reservationPricing,s.reservationPricing);assert.equal(first.body.session.amountPaid,40.2);assert.equal(first.body.session.hourlyRate,null);assert.equal(first.body.session.pricingVersion,2);assert.equal(first.body.inventory[0].stock,4);assert.equal((await f.order()).status,200);assert.equal((await f.rows('inventory'))[0].stock,4);const updated=first.body.session;const r=await f.call(f.body({expectedSession:updated,expectedSessionStartTime:s.startTime,tendered:300}));assert.equal(r.status,200);assert.equal(r.body.receipt.total_amount,246);assert.equal(r.body.alreadyPaid,40.2);assert.equal(r.body.totalPaidNow,205.8);
});
