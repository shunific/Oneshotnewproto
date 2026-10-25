const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3');
const { registerSessionStateRoutes } = require('../server-session-state.cjs');
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, error => error ? reject(error) : resolve()));
const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
async function fixture(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'oneshot-session-'));
  const filename = path.join(folder, 'qa.db');
  const db = await new Promise((resolve, reject) => { const db = new sqlite3.Database(filename, error => error ? reject(error) : resolve(db)); });
  await run(db, 'CREATE TABLE tables (id TEXT PRIMARY KEY, status TEXT, isActive INTEGER, sessionData TEXT)');
  const session = { customerName: 'QA session', startTime: '2026-10-19T08:00:00.000Z', durationMinutes: 60, isOpenTime: false, hourlyRate: 150, overtimeRate: 300, pricingVersion: 1, amountPaid: 75, isPaid: false, orders: [{ id: 'water', name: 'Water', price: 20, qty: 1 }], processedOrderOperations: [{ key: 'submit:original', inventoryIds: ['water'] }] };
  await run(db, 'INSERT INTO tables VALUES (?, ?, 1, ?)', ['a', 'occupied', JSON.stringify(session)]);
  await run(db, "INSERT INTO tables VALUES ('b','available',1,NULL),('c','available',1,NULL)");
  await require('./venue-fixture.cjs').seedVenue(db);
  let clock=Date.parse('2026-10-19T08:30:00Z');
  const app = express(); app.use(express.json());app.use((req,_res,next)=>{req.staff={id:'qa-session-staff'};next();});
  const routes = registerSessionStateRoutes(app, filename,{now:()=>clock,resolveActor:async()=>({localStaffId:'qa-session-staff'}),isActorCurrent:()=>true}); await routes.ready;
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await new Promise(resolve => db.close(resolve)); await rm(folder, { recursive: true, force: true }); });
  let counter = 0;
  const call = async (kind, updates = {}, id = 'a') => {
    const body = { requestId: `session_request_${++counter}`, expectedSession: session, ...(kind === 'extend' ? { minutes: 30, tendered: 75, paymentMethod: 'cash' } : { targetId: 'b', expectedTargetStatus: 'available', expectedTargetSession: null }), ...updates };
    clock=Date.parse(body.expectedSession.startTime)+30*60000;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tables/${id}/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { db, session, call, table: async id => { const row = (await all(db, 'SELECT * FROM tables')).find(row => row.id === id); return { ...row, session: row.sessionData ? JSON.parse(row.sessionData) : null }; } };
}

test('GCash extension persists selected method and normalized reference exactly once on concurrent retry', async t => {
  const f = await fixture(t);
  const command = {requestId:'gcash_extension_retry',paymentMethod:'gcash',paymentReference:'  QA-123  ',tendered:75};
  const results = await Promise.all([f.call('extend',command),f.call('extend',command)]);
  assert.ok(results.every(result=>result.status===200));
  assert.equal(results.filter(result=>result.body.replayed).length,1);
  const payments = await all(f.db,'SELECT * FROM session_payments');
  assert.equal(payments.length,1);
  assert.equal(payments[0].payment_method,'gcash');
  assert.equal(payments[0].payment_reference,'QA-123');
  assert.equal(payments[0].amount,75);
  assert.equal((await f.table('a')).session.amountPaid,150);
  assert.equal((await f.call('extend',{...command,paymentReference:'QA-999'})).status,409);
  const later = {...f.session,customerName:'Later guest',startTime:'2026-10-19T09:00:00.000Z'};
  await run(f.db,'UPDATE tables SET sessionData=? WHERE id=?',[JSON.stringify(later),'a']);
  const replay = await f.call('extend',command);
  assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);
  assert.deepEqual((await f.table('a')).session,later);
  assert.equal((await all(f.db,'SELECT * FROM session_payments')).length,1);
});

test('partial GCash extension records only actual credit and cash never retains stale electronic reference', async t => {
  const f = await fixture(t);
  const partial = await f.call('extend',{paymentMethod:'gcash',paymentReference:'PART-123',tendered:20});
  assert.equal(partial.status,200);assert.equal(partial.body.session.amountPaid,95);
  assert.equal(partial.body.payment.amount,20);assert.equal(partial.body.payment.paymentMethod,'gcash');
  const cash = await f.call('extend',{expectedSession:partial.body.session,paymentMethod:'cash',paymentReference:'STALE-REFERENCE',tendered:75});
  assert.equal(cash.status,200);assert.equal(cash.body.payment.paymentMethod,'cash');assert.equal(cash.body.payment.paymentReference,null);
  const payments = await all(f.db,'SELECT * FROM session_payments');
  assert.equal(payments.length,2);assert.equal(payments.find(p=>p.payment_method==='cash').payment_reference,null);
});

test('malformed positive GCash references cannot change duration, credit or payment ledger', async t => {
  const f = await fixture(t);
  for (const paymentReference of ['', '   ', '--', 'AB', '<script>', 'A'.repeat(121), 'abc\n123']) {
    const result = await f.call('extend',{paymentMethod:'gcash',paymentReference,tendered:75});
    assert.equal(result.status,400);
    assert.deepEqual((await f.table('a')).session,f.session);
  }
  assert.equal((await all(f.db,'SELECT * FROM session_payments')).length,0);
  assert.equal((await all(f.db,'SELECT * FROM session_state_operations')).length,0);
  const unpaid = await f.call('extend',{paymentMethod:'gcash',paymentReference:'',tendered:0});
  assert.equal(unpaid.status,200);assert.equal(unpaid.body.payment,null);
  assert.equal((await all(f.db,'SELECT * FROM session_payments')).length,0);
});

test('session schema waits for upstream startup migrations and propagates their failure without opening its database',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'oneshot-startup-gate-')),filename=path.join(folder,'qa.db');
 t.after(()=>rm(folder,{recursive:true,force:true}));
 let release;const gate=new Promise(resolve=>{release=resolve;});let settled=false;
 const routes=registerSessionStateRoutes(express(),filename,{readyBefore:gate});
 routes.ready.then(()=>{settled=true;},()=>{settled=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
 const db=await new Promise((resolve,reject)=>{const d=new sqlite3.Database(filename,e=>e?reject(e):resolve(d));});
 assert.equal((await all(db,"SELECT name FROM sqlite_master WHERE type='table'")).length,0);
 release();await routes.ready;
 assert.equal((await all(db,"SELECT name FROM sqlite_master WHERE name IN ('session_state_operations','session_payments')")).length,2);
 await new Promise(resolve=>db.close(resolve));
 const rejected=registerSessionStateRoutes(express(),path.join(folder,'never-created.db'),{readyBefore:Promise.reject(Error('QA upstream migration failure'))});
 await assert.rejects(rejected.ready,/QA upstream migration failure/);
 assert.equal(require('node:fs').existsSync(path.join(folder,'never-created.db')),false);
});

test('extension preserves rate, stock orders and history; records payment exactly once on concurrent retry', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.call('extend', { requestId: 'same_extension' }), f.call('extend', { requestId: 'same_extension' })]);
  assert.ok(results.every(result => result.status === 200));
  const saved = (await f.table('a')).session;
  assert.equal(saved.durationMinutes, 90); assert.equal(saved.amountPaid, 150); assert.equal(saved.hourlyRate, 150); assert.equal(saved.overtimeRate, 300); assert.equal(saved.pricingVersion, 1);
  assert.deepEqual(saved.orders, f.session.orders); assert.deepEqual(saved.processedOrderOperations, f.session.processedOrderOperations);
  const payments = await all(f.db, 'SELECT * FROM session_payments');
  assert.equal(payments.length, 1); assert.equal(payments[0].amount, 75);
  assert.equal((await f.call('extend', { requestId: 'same_extension', tendered: 0 })).status, 409);
  assert.equal((await f.call('extend', { requestId: 'same_extension' })).body.replayed, true);
});

test('invalid extension and financial-field injection leave bill and payment ledger unchanged', async t => {
  const f = await fixture(t);
  for (const updates of [{ minutes: -30 }, { minutes: 1 }, { minutes: 1500 }, { tendered: -1 }, { tendered: 100 }, { tendered: 1.001 }, { paymentMethod: 'unknown' }, { paymentMethod: 'gcash' }, { hourlyRate: 1 }, { amountPaid: 9999 }, { minutes: 'open', tendered: 1 }]) {
    assert.equal((await f.call('extend', updates)).status, 400);
    assert.deepEqual((await f.table('a')).session, f.session);
  }
  assert.equal((await all(f.db, 'SELECT * FROM session_payments')).length, 0);
  const modified = { ...f.session, hourlyRate: 1 };
  assert.equal((await f.call('extend', { expectedSession: modified, tendered: 0 })).status, 409);
});

test('only one competing extension wins; open-time conversion cannot fabricate a payment', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.call('extend', { tendered: 0 }), f.call('extend', { tendered: 0 })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200,409]);
  const current = (await f.table('a')).session;
  const opened = await f.call('extend', { expectedSession: current, minutes: 'open', tendered: 0, expectedLatestEndTime:'2026-10-19T15:59:00.000Z' });
  assert.equal(opened.status, 200); assert.equal(opened.body.session.durationMinutes, null); assert.equal(opened.body.session.isOpenTime, true); assert.equal(opened.body.session.amountPaid, 75);
  assert.equal((await f.call('extend', { expectedSession: opened.body.session, tendered: 0 })).status, 409);
});

test('move atomically preserves bill and replays without moving a new customer', async t => {
  const f = await fixture(t);
  const moved = await f.call('move', { requestId: 'same_movement' });
  assert.equal(moved.status, 200);
  assert.equal((await f.table('a')).status, 'available'); assert.equal((await f.table('a')).session, null);
  assert.deepEqual((await f.table('b')).session, f.session);
  const newSession = { ...f.session, customerName: 'Next customer', startTime: '2026-10-19T10:00:00.000Z' };
  await run(f.db, "UPDATE tables SET status='occupied',sessionData=? WHERE id='a'", [JSON.stringify(newSession)]);
  assert.equal((await f.call('move', { requestId: 'same_movement' })).body.replayed, true);
  assert.deepEqual((await f.table('a')).session, newSession);
  assert.equal((await f.call('move', { requestId: 'same_movement', targetId: 'c' })).status, 409);
});

test('racing move destinations cannot duplicate a session and failed target write rolls back source', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.call('move'), f.call('move', { targetId: 'c' })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200,409]);
  const rows = await all(f.db, 'SELECT * FROM tables');
  assert.equal(rows.filter(row => row.status === 'occupied').length, 1);
  await run(f.db, "UPDATE tables SET status='available',sessionData=NULL");
  await run(f.db, "UPDATE tables SET status='occupied',sessionData=? WHERE id='a'", [JSON.stringify(f.session)]);
  await run(f.db, "CREATE TRIGGER reject_source_free BEFORE UPDATE ON tables WHEN NEW.id='a' AND NEW.status='available' BEGIN SELECT RAISE(ABORT, 'synthetic disk write failure'); END");
  assert.equal((await f.call('move')).status, 503);
  assert.deepEqual((await f.table('a')).session, f.session); assert.equal((await f.table('b')).session, null);
});

test('payment ledger failure rolls back extension and supports retry with same request ID', async t => {
  const f = await fixture(t);
  await run(f.db, "CREATE TRIGGER reject_payment BEFORE INSERT ON session_payments BEGIN SELECT RAISE(ABORT, 'synthetic payment failure'); END");
  assert.equal((await f.call('extend', { requestId: 'retry_extension' })).status, 503);
  assert.deepEqual((await f.table('a')).session, f.session);
  assert.equal((await all(f.db, 'SELECT * FROM session_state_operations')).length, 0);
  await run(f.db, 'DROP TRIGGER reject_payment');
  assert.equal((await f.call('extend', { requestId: 'retry_extension' })).status, 200);
});


test('invalid persisted billing snapshots cannot extend or move and do not record payments or operations',async t=>{
  const f=await fixture(t);
  const invalid=[{pricingVersion:2},{pricingVersion:1,overtimeRate:undefined},{pricingVersion:1,overtimeRate:0},{durationMinutes:0},{amountPaid:-1},{orders:[{id:'water',price:20,qty:0}]},{orders:[{id:'water',price:20.001,qty:1}]}];
  for(const patch of invalid){
    const session=JSON.parse(JSON.stringify({...f.session,...patch}));
    await run(f.db,"UPDATE tables SET status='occupied',sessionData=? WHERE id='a'",[JSON.stringify(session)]);
    for(const kind of ['extend','move']){
      const response=await f.call(kind,{expectedSession:session});
      assert.equal(response.status,409,`${kind}:${JSON.stringify(patch)}`);
      assert.deepEqual((await f.table('a')).session,session);
      assert.equal((await f.table('b')).session,null);
      assert.equal((await all(f.db,'SELECT * FROM session_payments')).length,0);
      assert.equal((await all(f.db,'SELECT * FROM session_state_operations')).length,0);
    }
  }
});

test('extension rejects a resulting full-bill overflow without changing session or payment ledger',async t=>{
  const f=await fixture(t);
  const session={...f.session,startTime:new Date(Date.now()-30*60000).toISOString(),hourlyRate:90071992547400,orders:[],amountPaid:0};
  await run(f.db,"UPDATE tables SET sessionData=? WHERE id='a'",[JSON.stringify(session)]);
  assert.equal((await f.call('extend',{expectedSession:session,tendered:75})).status,409);
  assert.deepEqual((await f.table('a')).session,session);
  assert.equal((await all(f.db,'SELECT * FROM session_payments')).length,0);
  assert.equal((await all(f.db,'SELECT * FROM session_state_operations')).length,0);
});

test('a committed extension remains replayable even if the current session later becomes invalid',async t=>{
  const f=await fixture(t);const request={requestId:'replay_committed_extension'};
  assert.equal((await f.call('extend',request)).status,200);
  const corrupt={...(await f.table('a')).session,pricingVersion:2};
  await run(f.db,"UPDATE tables SET sessionData=? WHERE id='a'",[JSON.stringify(corrupt)]);
  const replay=await f.call('extend',request);
  assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);
  assert.deepEqual((await f.table('a')).session,corrupt);
  assert.equal((await all(f.db,'SELECT * FROM session_payments')).length,1);
});
const reservationSession=require('./reservation-billing-fixture.cjs');
test('reservation session rejects all extensions and uncoordinated moves without changing the commercial snapshot',async t=>{
 const f=await fixture(t);const s=reservationSession();await run(f.db,'UPDATE tables SET sessionData=? WHERE id=?',[JSON.stringify(s),'a']);
 for(const minutes of [30,60,'open']){const r=await f.call('extend',{expectedSession:s,minutes,tendered:0});assert.equal(r.status,409);assert.match(r.body.error,/venue-rule review/);assert.deepEqual((await f.table('a')).session,s);}
 assert.equal((await all(f.db,'SELECT * FROM session_payments')).length,0);assert.equal((await all(f.db,'SELECT * FROM session_state_operations')).length,0);
 const moved=await f.call('move',{expectedSession:s,requestId:'reservation_move_exact'});assert.equal(moved.status,409);assert.match(moved.body.error,/trusted cloud permit/);assert.deepEqual((await f.table('a')).session,s);assert.equal((await f.table('b')).session,null);assert.equal((await all(f.db,'SELECT * FROM session_state_operations')).length,0);
});

test('Happy Hour extension retains the original start-selected base after the window and saved rates change',async t=>{
 const {selectWalkInStartPricing}=require('../session-billing.mjs');
 const f=await fixture(t),start=Date.parse('2026-10-15T17:59:00+08:00');
 const pricing=selectWalkInStartPricing({hourlyRate:150,overtimeRate:300,isWeekdayHappyHourActive:true,weekdayHappyHourRate:100,weekdayHappyHourStart:'15:00',weekdayHappyHourEnd:'18:00'},start);
 const session={...f.session,startTime:new Date(start).toISOString(),hourlyRate:pricing.hourlyRate,amountPaid:0};
 await run(f.db,'UPDATE tables SET sessionData=? WHERE id=?',[JSON.stringify(session),'a']);

 await run(f.db,"INSERT INTO systemSettings VALUES('hourlyRate','450'),('weekdayHappyHourRate','50'),('overtimeRate','600')");
 const saved=await f.call('extend',{expectedSession:session,minutes:60,tendered:100});
 assert.equal(saved.status,200);assert.equal(saved.body.extensionCharge,100);assert.equal(saved.body.session.hourlyRate,100);assert.equal(saved.body.session.overtimeRate,300);assert.equal(saved.body.session.durationMinutes,120);assert.equal(saved.body.session.amountPaid,100);
});
