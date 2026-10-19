const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sqlite3 = require('sqlite3');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerRefundRoutes } = require('../server-refunds.cjs');
const run = (db, sql, args=[]) => new Promise((resolve,reject)=>db.run(sql,args,error=>error?reject(error):resolve()));
const all = (db, sql, args=[]) => new Promise((resolve,reject)=>db.all(sql,args,(error,rows)=>error?reject(error):resolve(rows)));
const admin={id:'fixture-admin',fullName:'QA Administrator',isAdmin:true};
async function fixture(t, options={}) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'refund-return-test-'));const file=path.join(dir,'fixture.db');
 const db=await new Promise((resolve,reject)=>{const conn=new sqlite3.Database(file,error=>error?reject(error):resolve(conn));});
 await run(db,'CREATE TABLE e_receipts (id TEXT PRIMARY KEY,refund_due REAL,refund_status TEXT,total_amount REAL,amount_paid REAL,payment_status TEXT,payment_method TEXT,customer_name TEXT)');
 await run(db,"INSERT INTO e_receipts VALUES ('r1',60,'pending',150,150,'refund_pending','cash','QA fixture'),('r2',80,'pending',0,0,'voided_refund_pending','cash','QA void'),('r3',0,'none',150,150,'paid','cash','QA no refund')");
 await run(db,"CREATE TABLE tables(id TEXT PRIMARY KEY,status TEXT,sessionData TEXT)");await run(db,"INSERT INTO tables VALUES ('t1','occupied','replacement customer session')");
 await run(db,"CREATE TABLE session_history(id TEXT PRIMARY KEY,totalAmount REAL,status TEXT)");await run(db,"INSERT INTO session_history VALUES ('history',150,'refund_pending')");
 await run(db,"CREATE TABLE inventory(id TEXT PRIMARY KEY,stock INTEGER)");await run(db,"INSERT INTO inventory VALUES ('item',3)");
 const auth={user:admin,revoked:false,bypass:false};const app=express();app.use(express.json());
 const requireAdmin=(req,res,next)=>{req.staff=auth.user;if(auth.bypass)return next();if(auth.revoked || !auth.user?.isAdmin)return res.status(403).json({error:'Fixture authentication denied'});next();};
 registerRefundRoutes(app,file,{requireAdmin:options.middlewareArray?[requireAdmin]:requireAdmin});
 const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));await rm(dir,{recursive:true,force:true});});
 let n=0;
 const body=extra=>({requestId:`refund_return_${++n}`,expectedActorId:admin.id,expectedRefundDueCents:6000,method:'cash',reason:'QA verified full cash handover',acknowledgedReturned:true,...extra});
 const call=async(payload,id='r1',method='POST')=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/e-receipts/${encodeURIComponent(id)}/refund-return`,{method,headers:{'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify(payload)}:{})});return{status:response.status,body:await response.json(),headers:{cacheControl:response.headers.get('cache-control'),pragma:response.headers.get('pragma')}};};
 return{db,file,auth,body,call,rows:table=>all(db,`SELECT * FROM ${table}`),get:id=>call(null,id,'GET')};
}
test('registration fails closed when trusted administrator middleware is absent or invalid',()=>{
 for(const requireAdmin of [undefined,null,[],[()=>{},null],'function'])assert.throws(()=>registerRefundRoutes({},'unused',{requireAdmin}),/administrator authentication/);
});
test('GET is an exact admin receipt read and performs no migration, audit write or liability mutation',async t=>{
 const f=await fixture(t,{middlewareArray:true});const before=await readFile(f.file);const result=await f.get('r1');assert.equal(result.status,200);assert.equal(result.body.receipt.id,'r1');assert.equal(result.body.refundReturn,null);assert.equal(result.body.fundsTransferred,false);assert.deepEqual(await readFile(f.file),before);assert.equal((await all(f.db,"SELECT name FROM sqlite_master WHERE name='receipt_refund_returns'")).length,0);assert.equal((await f.get('missing')).status,404);
});
test('records full external return once while leaving the original receipt finances, history, reused table and inventory unchanged',async t=>{
 const f=await fixture(t);const original=(await f.rows('e_receipts'))[0];const tables=await f.rows('tables');const history=await f.rows('session_history');const inventory=await f.rows('inventory');const payload=f.body();const result=await f.call(payload);
 assert.equal(result.status,200);assert.equal(result.body.fundsTransferred,false);assert.equal(result.body.replayed,false);assert.equal(result.body.refundReturn.amountCents,6000);assert.equal(result.body.refundReturn.actorId,admin.id);assert.equal(result.body.refundReturn.actorName,admin.fullName);assert.equal(result.body.refundReturn.reason,payload.reason);
 assert.deepEqual({...result.body.receipt,refund_status:'pending'},original);assert.deepEqual(await f.rows('tables'),tables);assert.deepEqual(await f.rows('session_history'),history);assert.deepEqual(await f.rows('inventory'),inventory);
 const audit=await f.get('r1');assert.deepEqual(audit.body.refundReturn,result.body.refundReturn);assert.equal(audit.body.receipt.refund_due,60);assert.equal(audit.body.receipt.refund_status,'returned');
});
test('normal and voided pending refunds use identical full-return accounting',async t=>{
 const f=await fixture(t);const result=await f.call(f.body({expectedRefundDueCents:8000,method:'gcash',reference:'QA-123 456'}),'r2');assert.equal(result.status,200);assert.equal(result.body.receipt.payment_status,'voided_refund_pending');assert.equal(result.body.receipt.total_amount,0);assert.equal(result.body.receipt.refund_status,'returned');assert.equal(result.body.refundReturn.amountCents,8000);assert.equal(result.body.refundReturn.reference,'QA-123 456');
});
test('anonymous, cashier and revoked sessions are denied before read, write and successful request replay',async t=>{
 const f=await fixture(t);const payload=f.body();assert.equal((await f.call(payload)).status,200);
 for(const user of [undefined,{id:'cashier',isAdmin:false},{id:'bad-admin',isAdmin:'true'},{isAdmin:true}]){f.auth.user=user;f.auth.bypass=true;assert.equal((await f.call(payload)).status,403);assert.equal((await f.get('r1')).status,403);}
 f.auth.user=admin;f.auth.bypass=false;f.auth.revoked=true;assert.equal((await f.call(payload)).status,403);assert.equal((await f.get('r1')).status,403);assert.equal((await f.rows('receipt_refund_returns')).length,1);
});
test('concurrent identical requests and later replay return one immutable audit',async t=>{
 const f=await fixture(t);const payload=f.body();const results=await Promise.all([f.call(payload),f.call(payload)]);assert.ok(results.every(result=>result.status===200));assert.equal(results[0].body.refundReturn.id,results[1].body.refundReturn.id);const replay=await f.call(payload);assert.equal(replay.body.replayed,true);assert.equal(replay.body.fundsTransferred,false);assert.equal((await f.rows('receipt_refund_returns')).length,1);
});
test('concurrent different requests can record only one full return for the same receipt',async t=>{
 const f=await fixture(t);const results=await Promise.all([f.call(f.body()),f.call(f.body())]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await f.rows('receipt_refund_returns')).length,1);
});
test('request IDs are bound to receipt, original body and administrator identity even on replay',async t=>{
 const f=await fixture(t);const payload=f.body();assert.equal((await f.call(payload)).status,200);
 for(const extra of [{reason:'changed'},{method:'gcash',reference:'QA123'},{reference:''},{expectedRefundDueCents:6001}])assert.equal((await f.call({...payload,...extra})).status,409);
 f.auth.user={...admin,id:'another-admin'};assert.equal((await f.call(payload)).status,409);f.auth.user=admin;assert.equal((await f.call({...payload,expectedRefundDueCents:8000},'r2')).status,409);
});
test('GCash references cannot be reused through case, whitespace or hyphen formatting changes',async t=>{
 const f=await fixture(t);assert.equal((await f.call(f.body({method:'gcash',reference:' Qa-123 456 '}))).status,200);assert.equal((await f.call(f.body({expectedRefundDueCents:8000,method:'gcash',reference:'qA123456'}),'r2')).status,409);assert.equal((await f.rows('e_receipts')).find(row=>row.id==='r2').refund_status,'pending');assert.equal((await f.rows('receipt_refund_returns')).length,1);
});
test('strict body validation rejects tampering, partial amounts and incomplete acknowledgements before any writes',async t=>{
 const f=await fixture(t);for(const extra of [{actorId:'forged'},{expectedActorId:undefined},{expectedActorId:''},{expectedActorId:123},{fundsTransferred:true},{acknowledgedReturned:false},{acknowledgedReturned:'true'},{expectedRefundDueCents:0},{expectedRefundDueCents:-1},{expectedRefundDueCents:1.5},{expectedRefundDueCents:Number.MAX_SAFE_INTEGER+1},{method:'bank'},{reason:''},{reason:'x'.repeat(1001)},{reference:123},{reference:'x'.repeat(129)},{method:'gcash',reference:' - \t'},{method:'gcash',reference:'Ａ１２３４５６'},{method:'gcash',reference:'QA😀123'},{method:'gcash',reference:'a'},{method:'gcash',reference:'ab'},{requestId:'bad'}]){assert.equal((await f.call(f.body(extra))).status,400);}
 assert.equal((await f.call(f.body({expectedRefundDueCents:5999}))).status,409);assert.equal((await f.rows('e_receipts'))[0].refund_status,'pending');assert.equal((await all(f.db,"SELECT name FROM sqlite_master WHERE name='receipt_refund_returns'")).length,0);
});
test('missing, nonpending and malformed stored liabilities never silently become refund returns',async t=>{
 const f=await fixture(t);assert.equal((await f.call(f.body(),'missing')).status,404);assert.equal((await f.call(f.body(),'r3')).status,409);
 for(const due of [null,0,-1,60.001,'invalid',Number.MAX_SAFE_INTEGER]){await run(f.db,'UPDATE e_receipts SET refund_due=? WHERE id=?',[due,'r1']);assert.equal((await f.call(f.body())).status,409);}
 await run(f.db,"UPDATE e_receipts SET refund_due=60,refund_status='returned' WHERE id='r1'");assert.equal((await f.call(f.body())).status,409);assert.equal((await all(f.db,"SELECT name FROM sqlite_master WHERE name='receipt_refund_returns'")).length,0);
});
test('receipt write failure rolls back audit insertion and permits exact request retry after recovery',async t=>{
 const f=await fixture(t);await run(f.db,"CREATE TRIGGER fail_refund_update BEFORE UPDATE OF refund_status ON e_receipts BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END");const payload=f.body();assert.equal((await f.call(payload)).status,503);assert.equal((await f.rows('e_receipts'))[0].refund_status,'pending');assert.equal((await all(f.db,"SELECT name FROM sqlite_master WHERE name='receipt_refund_returns'")).length,0);
 await run(f.db,'DROP TRIGGER fail_refund_update');assert.equal((await f.call(payload)).status,200);assert.equal((await f.rows('receipt_refund_returns')).length,1);
});
test('repeated schema initialization preserves prior audits and cash returns allow an empty optional reference',async t=>{
 const f=await fixture(t);const first=await f.call(f.body({reference:''}));assert.equal(first.status,200);assert.equal(first.body.refundReturn.reference,'');const second=await f.call(f.body({expectedRefundDueCents:8000}),'r2');assert.equal(second.status,200);assert.equal((await f.rows('receipt_refund_returns')).length,2);assert.equal((await f.get('r1')).body.refundReturn.id,first.body.refundReturn.id);
});
test('changed liability or audit/receipt inconsistency prevents stale acknowledgement replay',async t=>{
 const f=await fixture(t);const payload=f.body();assert.equal((await f.call(payload)).status,200);await run(f.db,"UPDATE e_receipts SET refund_due=61 WHERE id='r1'");assert.equal((await f.call(payload)).status,409);await run(f.db,"UPDATE e_receipts SET refund_due=60,refund_status='pending' WHERE id='r1'");assert.equal((await f.call(payload)).status,409);assert.equal((await f.rows('receipt_refund_returns')).length,1);
});

test('readonly receipt and audit views stay consistent while a return is committed concurrently',async t=>{
 const f=await fixture(t);const reads=Array.from({length:20},()=>f.get('r1'));const [write,...results]=await Promise.all([f.call(f.body()),...reads]);assert.equal(write.status,200);
 for(const result of results){assert.equal(result.status,200);if(result.body.receipt.refund_status==='pending')assert.equal(result.body.refundReturn,null);else {assert.equal(result.body.receipt.refund_status,'returned');assert.equal(result.body.refundReturn.receiptId,'r1');}}
});

test('private receipt/audit responses disable caching for success, application errors and middleware denials',async t=>{
 const f=await fixture(t);const results=[await f.get('r1'),await f.get('missing'),await f.call(f.body({acknowledgedReturned:false})),await f.call(f.body())];f.auth.revoked=true;results.push(await f.get('r1'),await f.call(f.body()));
 for(const result of results){assert.equal(result.headers.cacheControl,'no-store');assert.equal(result.headers.pragma,'no-cache');}
});
test('refund audit schema prevents deleting the referenced receipt while preserving unrelated receipts',async t=>{
 const f=await fixture(t);assert.equal((await f.call(f.body())).status,200);await run(f.db,'PRAGMA foreign_keys = ON');
 await all(f.db,'SELECT name FROM sqlite_master');const relations=await all(f.db,'PRAGMA foreign_key_list(receipt_refund_returns)');assert.ok(relations.some(relation=>relation.table==='e_receipts' && relation.from==='receipt_id' && relation.to==='id' && relation.on_delete==='RESTRICT'));
 await assert.rejects(run(f.db,"DELETE FROM e_receipts WHERE id='r1'"),/FOREIGN KEY constraint/);await run(f.db,"DELETE FROM e_receipts WHERE id='r3'");assert.equal((await f.rows('receipt_refund_returns')).length,1);assert.equal((await f.get('r1')).body.refundReturn.receiptId,'r1');
});

test('POST reports definite noncommit only for rejected validation and rolled-back business conflicts',async t=>{
 const f=await fixture(t);
 const validation=await f.call(f.body({acknowledgedReturned:false}));assert.equal(validation.status,400);assert.equal(validation.body.committed,false);
 const stale=await f.call(f.body({expectedRefundDueCents:6001}));assert.equal(stale.status,409);assert.equal(stale.body.committed,false);
 const missing=await f.call(f.body(),'missing');assert.equal(missing.status,404);assert.equal(missing.body.committed,false);
 assert.equal((await f.call(f.body({method:'gcash',reference:'QA-123456'}))).status,200);
 const duplicate=await f.call(f.body({expectedRefundDueCents:8000,method:'gcash',reference:'qa123456'}),'r2');assert.equal(duplicate.status,409);assert.equal(duplicate.body.committed,false);
 const get=await f.get('missing');assert.equal(get.status,404);assert.equal(Object.hasOwn(get.body,'committed'),false);
 f.auth.revoked=true;const denied=await f.call(f.body());assert.equal(denied.status,403);assert.equal(Object.hasOwn(denied.body,'committed'),false);
});
test('SQL write failures and rollback failures never claim a definitive noncommit',async t=>{
 const f=await fixture(t);await run(f.db,"CREATE TRIGGER fail_return_write BEFORE UPDATE OF refund_status ON e_receipts BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 const failed=await f.call(f.body());assert.equal(failed.status,503);assert.equal(Object.hasOwn(failed.body,'committed'),false);await run(f.db,'DROP TRIGGER fail_return_write');
 const originalRun=sqlite3.Database.prototype.run;
 try {
  sqlite3.Database.prototype.run=function(sql,...args){if(sql==='ROLLBACK'){const callback=args.at(-1);queueMicrotask(()=>callback.call(this,new Error('Injected rollback confirmation failure')));return this;}return originalRun.call(this,sql,...args);};
  const unknown=await f.call(f.body({expectedRefundDueCents:6001}));assert.equal(unknown.status,503);assert.equal(Object.hasOwn(unknown.body,'committed'),false);assert.equal(unknown.body.fundsTransferred,false);
 } finally {sqlite3.Database.prototype.run=originalRun;}
});

test('first commit is bound to the administrator who reviewed the form, before opening or changing the database',async t=>{
 const f=await fixture(t);const payload=f.body();f.auth.user={id:'another-admin',fullName:'Other QA Administrator',isAdmin:true};
 const result=await f.call(payload);assert.equal(result.status,409);assert.equal(result.body.code,'ACCOUNT_CHANGED');assert.equal(result.body.committed,false);assert.equal((await f.rows('e_receipts'))[0].refund_status,'pending');assert.equal((await all(f.db,"SELECT name FROM sqlite_master WHERE name='receipt_refund_returns'")).length,0);
 const reviewed={...payload,expectedActorId:'another-admin'};assert.equal((await f.call(reviewed)).status,200);assert.equal((await f.rows('receipt_refund_returns'))[0].actor_id,'another-admin');
 f.auth.user=admin;const wrongActorReplay=await f.call(payload);assert.equal(wrongActorReplay.status,409);assert.equal(wrongActorReplay.body.committed,false);assert.equal((await f.rows('receipt_refund_returns')).length,1);
});
