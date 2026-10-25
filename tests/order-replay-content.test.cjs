const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const sqlite3 = require('sqlite3');
const { registerOrderRoutes } = require('../server-orders.cjs');
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, error => error ? reject(error) : resolve()));
const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
async function fixture(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'oneshot-order-content-'));
  const filename = path.join(folder, 'qa.db');
  const db = await new Promise((resolve, reject) => { const c = new sqlite3.Database(filename, error => error ? reject(error) : resolve(c)); });
  await run(db, 'CREATE TABLE tables(id TEXT PRIMARY KEY,status TEXT,isActive INTEGER,sessionData TEXT)');
  await run(db, 'CREATE TABLE inventory(id TEXT PRIMARY KEY,name TEXT,price REAL,stock INTEGER,isActive INTEGER)');
  const start = new Date(Date.now() - 600000).toISOString();
  const session = { customerName:'QA replay TEST ONLY', startTime:start, isOpenTime:false, durationMinutes:60, hourlyRate:150, amountPaid:0, orders:[] };
  await run(db, 'INSERT INTO tables VALUES(?,?,?,?)', ['t','occupied',1,JSON.stringify(session)]);
  await run(db, "INSERT INTO inventory VALUES('a','Apple',12.5,5,1),('b','Bread',20,3,1)");
  const app = express(); app.use(express.json()); registerOrderRoutes(app, filename);
  const server = await new Promise(resolve => { const s = app.listen(0,'127.0.0.1',()=>resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await new Promise(resolve => db.close(resolve)); await rm(folder,{recursive:true,force:true}); });
  const call = async (body, suffix='orders') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tables/t/${suffix}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedSessionStartTime:start,...body})});
    return {status:response.status,body:await response.json()};
  };
  const snapshot = async () => ({ tables:await all(db,'SELECT * FROM tables'),inventory:await all(db,'SELECT * FROM inventory ORDER BY id') });
  return { db,call,snapshot };
}
test('same order request ID cannot acknowledge a changed cart as its original commit', async t => {
  const f=await fixture(t); const original={requestId:'content_bound_order',cart:[{id:'a',qty:2}]};
  assert.equal((await f.call(original)).status,200); const before=await f.snapshot();
  assert.equal((await f.call({...original,cart:[{id:'b',qty:1}]})).status,409);
  assert.equal((await f.call({...original,cart:[{id:'a',qty:1}]})).status,409);
  assert.deepEqual(await f.snapshot(),before);
  assert.equal((await f.call(original)).status,200); assert.deepEqual(await f.snapshot(),before);
});
test('same void request ID cannot acknowledge a different order removal', async t => {
  const f=await fixture(t);
  assert.equal((await f.call({requestId:'prepare_two_orders',cart:[{id:'a',qty:2},{id:'b',qty:1}]})).status,200);
  const original={requestId:'content_bound_void',expectedOrder:{id:'a',qty:2,price:12.5}};
  assert.equal((await f.call(original,'orders/0/void')).status,200); const before=await f.snapshot();
  assert.equal((await f.call({...original,expectedOrder:{id:'b',qty:1,price:20}},'orders/0/void')).status,409);
  assert.deepEqual(await f.snapshot(),before);
  assert.equal((await f.call(original,'orders/0/void')).status,200); assert.deepEqual(await f.snapshot(),before);
});
test('legacy order operation with no content proof requires reconciliation without changing stock or bill', async t => {
  const f=await fixture(t);const original={requestId:'legacy_order_request',cart:[{id:'a',qty:2}]};
  const saved=await f.call(original); assert.equal(saved.status,200);
  const legacy={...saved.body.session,processedOrderOperations:saved.body.session.processedOrderOperations.map(({key,inventoryIds})=>({key,inventoryIds}))};
  await run(f.db,'UPDATE tables SET sessionData=? WHERE id=?',[JSON.stringify(legacy),'t']); const before=await f.snapshot();
  const retry=await f.call(original); assert.equal(retry.status,409);assert.match(retry.body.error,/reconcil/i);
  assert.deepEqual(await f.snapshot(),before);
});
