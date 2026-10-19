const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sqlite3 = require('sqlite3');
const { registerOrderRoutes } = require('../server-orders.cjs');
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, error => error ? reject(error) : resolve()));
const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orders-test-'));
  const filename = path.join(directory, 'fixture.db');
  const db = await new Promise((resolve, reject) => { const connection = new sqlite3.Database(filename, error => error ? reject(error) : resolve(connection)); });
  t.after(async () => { await new Promise(resolve => db.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await run(db, 'CREATE TABLE tables(id TEXT PRIMARY KEY,status TEXT,isActive INTEGER,sessionData TEXT)');
  await run(db, 'CREATE TABLE inventory(id TEXT PRIMARY KEY,name TEXT,price REAL,stock INTEGER,isActive INTEGER)');
  await run(db, 'INSERT INTO tables VALUES(?,?,?,?)', ['t1','occupied',1,JSON.stringify({customerName:'Fixture',startTime:'2026-10-19T08:00:00.000Z',durationMinutes:60,isOpenTime:false,hourlyRate:150,amountPaid:0,orders:[]})]);
  await run(db, "INSERT INTO inventory VALUES('a','Apple',12.50,5,1),('b','Bread',20,3,1),('c','Closed',2,4,0)");
  const routes = {};
  registerOrderRoutes({post(route, handler) { routes[route] = handler; }}, filename);
  let counter = 0;
  async function call(cart, extra = {}) {
    const result = {status:200};
    const res = {status(value){result.status=value;return this;},json(body){result.body=body;return this;}};
    const voiding = extra.orderIndex !== undefined;
    await routes[voiding ? '/api/tables/:id/orders/:orderIndex/void' : '/api/tables/:id/orders']({
      params:{id:extra.id || 't1',orderIndex:String(extra.orderIndex)},
      body:{cart,expectedSessionStartTime:extra.expectedSessionStartTime === undefined ? '2026-10-19T08:00:00.000Z' : extra.expectedSessionStartTime,requestId:extra.requestId || `request_${++counter}`,expectedOrder:extra.expectedOrder},
    },res);
    return result;
  }
  return {db,call,stock:async () => (await all(db,'SELECT id,stock FROM inventory ORDER BY id')),session:async () => JSON.parse((await all(db,'SELECT sessionData FROM tables'))[0].sessionData)};
}

test('server prices, duplicate cart aggregation and price-specific merging persist',async t=>{
  const f=await fixture(t);
  let result=await f.call([{id:'a',qty:1,price:0},{id:'a',qty:1}]);
  assert.equal(result.status,200);assert.equal(result.body.session.orders[0].price,12.5);assert.equal(result.body.inventory[0].stock,3);
  await run(f.db,"UPDATE inventory SET price=13 WHERE id='a'");
  result=await f.call([{id:'a',qty:1}]);assert.equal(result.body.session.orders.length,2);
  result=await f.call([{id:'a',qty:1}]);assert.equal(result.body.session.orders[1].qty,2);
});

test('invalid carts and missing/inactive tables or inventory rollback all changes',async t=>{
  const f=await fixture(t);const initial=await f.stock();
  for(const cart of [[],[{id:'a',qty:0}],[{id:'a',qty:1.5}],[{id:'a',qty:Infinity}],[{id:'a',qty:1},{id:'missing',qty:1}],[{id:'a',qty:1},{id:'c',qty:1}],[{id:'a',qty:1},{id:'b',qty:4}]]){
    assert.ok((await f.call(cart)).status>=400);assert.deepEqual(await f.stock(),initial);assert.deepEqual((await f.session()).orders,[]);
  }
  assert.equal((await f.call([{id:'a',qty:1}],{id:'missing'})).status,404);
  for(const sql of ["UPDATE tables SET isActive=0", "UPDATE tables SET isActive=1,status='available'", "UPDATE tables SET status='occupied',sessionData='invalid'"]){
    await run(f.db,sql);assert.equal((await f.call([{id:'a',qty:1}])).status,409);assert.deepEqual(await f.stock(),initial);
  }
});

test('concurrent orders cannot oversell stock',async t=>{
  const f=await fixture(t);const results=await Promise.all([f.call([{id:'a',qty:4}]),f.call([{id:'a',qty:4}])]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await f.stock())[0].stock,1);assert.equal((await f.session()).orders[0].qty,4);
});

test('concurrent duplicate submits and replay consume stock once',async t=>{
  const f=await fixture(t);const cart=[{id:'a',qty:2}];const extra={requestId:'same_request'};
  const results=await Promise.all([f.call(cart,extra),f.call(cart,extra)]);assert.ok(results.every(r=>r.status===200));
  assert.equal((await f.call(cart,extra)).status,200);assert.equal((await f.stock())[0].stock,3);assert.equal((await f.session()).orders[0].qty,2);
});

test('void validates expected order and concurrent replay restores exactly once',async t=>{
  const f=await fixture(t);await f.call([{id:'a',qty:2},{id:'b',qty:1}]);
  assert.equal((await f.call(null,{orderIndex:0})).status,400);
  assert.equal((await f.call(null,{orderIndex:0,expectedOrder:{id:'b',qty:1,price:20}})).status,409);
  const extra={orderIndex:0,expectedOrder:{id:'a',qty:2,price:12.5},requestId:'void_request'};
  const results=await Promise.all([f.call(null,extra),f.call(null,extra)]);assert.ok(results.every(r=>r.status===200));
  assert.equal((await f.call(null,extra)).status,200);assert.equal((await f.stock())[0].stock,5);assert.equal((await f.session()).orders[0].id,'b');
  assert.equal((await f.call(null,{...extra,requestId:'different_request'})).status,409);
});

test('invalid stored prices and unsafe quantities leave session and inventory intact',async t=>{
  const f=await fixture(t);await run(f.db,"UPDATE inventory SET price=12.345 WHERE id='a'");
  assert.equal((await f.call([{id:'a',qty:1}])).status,409);assert.equal((await f.stock())[0].stock,5);assert.deepEqual((await f.session()).orders,[]);
});


test('stale session requests and old request replays cannot affect a replacement session',async t=>{
  const f=await fixture(t);
  const cart=[{id:'a',qty:2}];
  await f.call(cart,{requestId:'old_session_request'});
  const oldOrder={id:'a',qty:2,price:12.5};
  await run(f.db,'UPDATE tables SET sessionData = ?', [JSON.stringify({startTime:'2026-10-19T09:00:00Z',customerName:'Replacement',durationMinutes:60,isOpenTime:false,hourlyRate:150,amountPaid:0,orders:[]})]);
  const stock=await f.stock();
  assert.equal((await f.call(cart,{requestId:'old_session_request'})).status,409);
  assert.equal((await f.call(cart,{requestId:'new_request_stale_session'})).status,409);
  assert.equal((await f.call(null,{orderIndex:0,expectedOrder:oldOrder})).status,409);
  assert.deepEqual(await f.stock(),stock);
  assert.deepEqual((await f.session()).orders,[]);
  const accepted=await f.call(cart,{expectedSessionStartTime:'2026-10-19T09:00:00.000Z'});
  assert.equal(accepted.status,200);
  assert.equal((await f.stock())[0].stock,1);
});

test('requires a valid session identity and rejects missing stored session start time',async t=>{
  const f=await fixture(t);
  for(const value of [null,'invalid','2026-10-19']) {
    assert.equal((await f.call([{id:'a',qty:1}],{expectedSessionStartTime:value})).status,400);
  }
  await run(f.db,'UPDATE tables SET sessionData = ?', [JSON.stringify({orders:[]})]);
  assert.equal((await f.call([{id:'a',qty:1}])).status,409);
  assert.equal((await f.stock())[0].stock,5);
});


test('a SQLite lock timeout is retryable and does not masquerade as a definitive rejection',async t=>{
  const f=await fixture(t);
  const cart=[{id:'a',qty:2}];
  const stable={requestId:'committed_then_lost_response'};
  assert.equal((await f.call(cart,stable)).status,200);
  await run(f.db,'BEGIN IMMEDIATE');
  try {
    assert.equal((await f.call(cart,stable)).status,503);
  } finally {
    await run(f.db,'ROLLBACK');
  }
  const retried=await f.call(cart,stable);
  assert.equal(retried.status,200);
  assert.equal((await f.stock())[0].stock,3);
  assert.equal((await f.session()).orders[0].qty,2);
});


test('invalid persisted billing snapshots reject order and void before changing stock or bill',async t=>{
  const f=await fixture(t);
  const valid={...(await f.session()),orders:[{id:'a',name:'Apple',price:12.5,qty:1}]};
  const invalid=[{pricingVersion:2},{pricingVersion:1,overtimeRate:undefined},{pricingVersion:1,overtimeRate:0},{durationMinutes:0},{amountPaid:-1},{orders:[{id:'a',price:12.5,qty:0}]},{orders:[{id:'a',price:12.345,qty:1}]}];
  for(const patch of invalid){
    const session=JSON.parse(JSON.stringify({...valid,...patch}));
    await run(f.db,'UPDATE tables SET sessionData=?',[JSON.stringify(session)]);
    const stock=await f.stock();
    const added=await f.call([{id:'b',qty:1}]);
    assert.equal(added.status,409,JSON.stringify(patch));
    const removed=await f.call(null,{orderIndex:0,expectedOrder:{id:'a',qty:1,price:12.5}});
    assert.equal(removed.status,409,JSON.stringify(patch));
    assert.deepEqual(await f.stock(),stock);assert.deepEqual(await f.session(),session);
  }
});

test('a new order that makes the full bill overflow rolls back stock and session together',async t=>{
  const f=await fixture(t);
  const session={...(await f.session()),startTime:new Date(Date.now()-30*60000).toISOString(),hourlyRate:90071992547400};
  await run(f.db,'UPDATE tables SET sessionData=?',[JSON.stringify(session)]);
  const stock=await f.stock();
  assert.equal((await f.call([{id:'a',qty:1}],{expectedSessionStartTime:session.startTime})).status,409);
  assert.deepEqual(await f.stock(),stock);assert.deepEqual(await f.session(),session);
});
