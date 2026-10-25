const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3');
const { registerOrderRoutes } = require('../server-orders.cjs');
const run = (db, sql, args = []) => new Promise((resolve,reject) => db.run(sql,args,error => error ? reject(error) : resolve()));
const all = (db, sql) => new Promise((resolve,reject) => db.all(sql,(error,rows) => error ? reject(error) : resolve(rows)));
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(),'order-replay-independent-'));
  const filename = path.join(directory,'test.sqlite');
  const db = new sqlite3.Database(filename);
  await run(db,'CREATE TABLE tables(id TEXT PRIMARY KEY,status TEXT,isActive INTEGER,sessionData TEXT)');
  await run(db,'CREATE TABLE inventory(id TEXT PRIMARY KEY,name TEXT,price REAL,stock INTEGER,isActive INTEGER)');
  const start = new Date(Date.now()-600000).toISOString();
  await run(db,'INSERT INTO tables VALUES(?,?,?,?)',['t','occupied',1,JSON.stringify({customerName:'QA',startTime:start,isOpenTime:false,durationMinutes:60,hourlyRate:150,pricingVersion:1,overtimeRate:300,amountPaid:0,orders:[]})]);
  await run(db,"INSERT INTO inventory VALUES('a','Apple',12.5,10,1),('b','Bread',20,10,1)");
  const app = express();app.use(express.json());registerOrderRoutes(app,filename);
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));await rm(directory,{recursive:true,force:true});});
  const call = async body => {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/tables/t/orders`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedSessionStartTime:start,...body})});
    return {status:response.status,body:await response.json()};
  };
  return {start,call,snapshot:async()=>({tables:await all(db,'SELECT * FROM tables'),inventory:await all(db,'SELECT * FROM inventory ORDER BY id')})};
}
test('concurrent changed carts sharing one operation ID commit exactly one content-bound order',async t=>{
  const f=await fixture(t);
  const requests=[{requestId:'concurrent_content_id',cart:[{id:'a',qty:2}]},{requestId:'concurrent_content_id',cart:[{id:'b',qty:3}]}];
  const responses=await Promise.all(requests.map(f.call));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  const winner=responses.findIndex(r=>r.status===200),snapshot=await f.snapshot();
  const saved=JSON.parse(snapshot.tables[0].sessionData),item=requests[winner].cart[0];
  assert.equal(saved.orders.length,1);assert.equal(saved.orders[0].id,item.id);assert.equal(saved.orders[0].qty,item.qty);
  assert.equal(saved.processedOrderOperations.length,1);assert.match(saved.processedOrderOperations[0].requestFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(snapshot.inventory.find(row=>row.id===item.id).stock,10-item.qty);
  assert.equal(snapshot.inventory.find(row=>row.id!==item.id).stock,10);
  assert.equal((await f.call(requests[winner])).status,200);
  assert.equal((await f.call(requests[1-winner])).status,409);
  assert.deepEqual(await f.snapshot(),snapshot);
});
test('equivalent timestamp representations and JSON object key order replay without consuming stock again',async t=>{
  const f=await fixture(t),requestId='normalized_content_id';
  assert.equal((await f.call({requestId,cart:[{id:'a',qty:2}]})).status,200);
  const snapshot=await f.snapshot();
  const retry=await f.call({requestId,expectedSessionStartTime:f.start.replace('Z','+00:00'),cart:[{qty:2,id:'a'}]});
  assert.equal(retry.status,200);assert.deepEqual(await f.snapshot(),snapshot);
});
