const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const sqlite3 = require('sqlite3');
const { canonicalSession, calculateCheckout } = require('../server-checkout.cjs');
const { selectWalkInStartPricing } = require('../session-billing.mjs');
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function(error) { error ? reject(error) : resolve(this); }));
const get = (db, sql) => new Promise((resolve, reject) => db.get(sql, (error, row) => error ? reject(error) : resolve(row)));

// Execute the actual generic table handler, with synthetic trusted staff and a
// real SQLite database. No substitute implementation of the pricing guard.
async function fixture(t, { status = 'available', active = 1, session = null, raceKey, now, settings = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-start-pricing-'));
  const filename = path.join(dir, 'qa.sqlite');
  const db = new sqlite3.Database(filename), policyDb = new sqlite3.Database(filename);
  await run(db, 'CREATE TABLE tables (id TEXT PRIMARY KEY,status TEXT,isActive INTEGER,sessionData TEXT,name TEXT,maintenanceReason TEXT)');
  await require('../server-reservation-moves.cjs').initializeReservationMoveSchema(db);
  await run(db, 'CREATE TABLE systemSettings (keyName TEXT PRIMARY KEY,settingValue TEXT)');
  await run(db, "INSERT INTO systemSettings VALUES ('hourlyRate','150'),('overtimeRate','300'),('isWeekdayHappyHourActive','false'),('isWeekendHappyHourActive','false')");
  for (const [key, value] of Object.entries(settings)) await run(db, 'INSERT OR REPLACE INTO systemSettings VALUES (?,?)', [key, String(value)]);
  await require('./venue-fixture.cjs').seedVenue(db);
  await run(db, 'INSERT INTO tables VALUES (?,?,?,?,?,NULL)', ['qa', status, active, session && JSON.stringify(session), 'QA table']);
  let intercepted = 0;
  const wrapped = {
    get: (...args) => db.get(...args), all: (...args) => db.all(...args),
    run(sql, args, callback) {
      if (raceKey && /^UPDATE tables SET /.test(sql) && !intercepted++) {
        (async () => {
          // This policy commit occurs after the route's SELECT and immediately
          // before its actual guarded UPDATE, on an independent connection.
          await run(policyDb, 'BEGIN IMMEDIATE');
          if (raceKey === 'moveHold') await run(policyDb,"INSERT INTO native_reservation_move_holds VALUES('qa','qa-move','qa-claim')");
          else if (raceKey === 'isActive') await run(policyDb, "UPDATE tables SET isActive=0 WHERE id='qa'");
          else await run(policyDb, 'UPDATE systemSettings SET settingValue=? WHERE keyName=?', ['450', raceKey]);
          await run(policyDb, 'COMMIT');
          db.run(sql, args, callback);
        })().catch(error => callback.call({ changes: 0 }, error));
        return;
      }
      return db.run(sql, args, callback);
    },
  };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.staff = { id: 'qa-cashier', isAdmin: false }; next(); });
  const source = await fs.readFile(path.join(__dirname, '../server.cjs'), 'utf8');
  const begin = source.indexOf("app.put('/api/tables/:id',");
  const end = source.indexOf("\napp.post('/api/queue'", begin);
  const deleteBegin=source.indexOf("app.delete('/api/tables/:id',");
  vm.runInNewContext(source.slice(deleteBegin,begin),{app,db:wrapped,auth:{requireAdmin:(_req,_res,next)=>next()}});
  assert(begin >= 0 && end > begin, 'actual table route extraction boundary');
  const Clock = now === undefined ? Date : class extends Date { static now() { return now; } };
  vm.runInNewContext(source.slice(begin, end), { app, db: wrapped, canonicalSession, calculateCheckout, selectWalkInStartPricing, Date: Clock, console, startTableSession: async(_file,req,res)=>{
    if(raceKey&&!intercepted++){if(raceKey==='moveHold')await run(policyDb,"INSERT INTO native_reservation_move_holds VALUES('qa','qa-move','qa-claim')");else if(raceKey==='isActive')await run(policyDb,"UPDATE tables SET isActive=0 WHERE id='qa'");else await run(policyDb,'UPDATE systemSettings SET settingValue=? WHERE keyName=?',['450',raceKey]);}
    return require('../server-table-start.cjs').startTableSession(filename,req,res,{now:()=>now??Date.now(),resolveActor:async()=>({localStaffId:'qa-cashier'}),isActorCurrent:()=>true});
  },dbPath:filename,auth:{resolveSessionActor:async()=>({localStaffId:'qa-cashier'}),isSessionCurrent:()=>true} });
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await Promise.all([db, policyDb].map(connection => new Promise(resolve => connection.close(resolve))));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const candidate = { customerName: 'QA pricing', startTime: new Date((now ?? Date.now()) - 1000).toISOString(), isOpenTime: false, durationMinutes: 60, hourlyRate: 150, overtimeRate: 300, amountPaid: 0, orders: [], processedOrderOperations: [] };
  const call = async (patch = {}, top = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tables/qa`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'occupied', expectedStatus: status, expectedSession: session, session: { ...candidate, ...patch }, ...top }) });
    return { status: response.status, body: await response.json() };
  };
  const raw=async(method,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/tables/qa`,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  return { db, call, raw, candidate, row: () => get(db, "SELECT * FROM tables WHERE id='qa'"), intercepted: () => intercepted };
}

test('new session stores reviewed distinct rates and server-owned pricing version', async t => {
  const f = await fixture(t);
  assert.equal((await f.call()).status, 200);
  const row = await f.row(), saved = JSON.parse(row.sessionData);
  assert.equal(row.status, 'occupied'); assert.equal(saved.hourlyRate, 150); assert.equal(saved.overtimeRate, 300); assert.equal(saved.pricingVersion, 1);
  assert.equal(calculateCheckout(saved, Date.parse(saved.startTime) + 70 * 60000, false).overtimeCents, 5000);
});

for (const raceKey of ['hourlyRate', 'overtimeRate']) test(`policy ${raceKey} commit before the start transaction prevents stale start`, async t => {
  const f = await fixture(t, { raceKey });
  assert.equal((await f.call()).status, 409); assert.equal(f.intercepted(), 1);
  const row = await f.row(); assert.equal(row.status, 'available'); assert.equal(row.sessionData, null);
  assert.equal((await get(f.db, `SELECT settingValue FROM systemSettings WHERE keyName='${raceKey}'`)).settingValue, '450');
});

test('administrator deactivation committed before the start transaction prevents a new start', async t => {
  const f = await fixture(t, { raceKey: 'isActive' });
  assert.equal((await f.call()).status, 409); assert.equal(f.intercepted(), 1);
  const row = await f.row(); assert.equal(row.isActive, 0); assert.equal(row.status, 'available'); assert.equal(row.sessionData, null);
});

test('stale, forged, missing and malformed pricing cannot create a bill', async t => {
  const f = await fixture(t);
  for (const patch of [{ overtimeRate: 299 }, { hourlyRate: 149 }, { overtimeRate: undefined }, { overtimeRate: 0 }, { overtimeRate: -1 }, { overtimeRate: '300' }, { overtimeRate: 300.001 }, { hourlyRate: 150.001 }, { pricingVersion: 0 }, { pricingVersion: 2 }, { pricingVersion: '1' }, { pricingVersion: null }]) {
    const response = await f.call(patch); assert.ok([400,409].includes(response.status), JSON.stringify({ patch, response }));
    assert.equal((await f.row()).sessionData, null);
  }
  await run(f.db, "DELETE FROM systemSettings WHERE keyName='overtimeRate'");
  assert.equal((await f.call()).status, 409); assert.equal((await f.row()).sessionData, null);
});

test('new starts require an active available table and an occupied target status', async t => {
  for (const options of [{ active: 0 }, { status: 'maintenance' }, { status: 'event' }, { status: 'reserved' }, { status: 'occupied' }]) {
    await t.test(JSON.stringify(options), async t => {
      const f = await fixture(t, options); assert.equal((await f.call()).status, 409); assert.equal((await f.row()).sessionData, null);
    });
  }
  const f = await fixture(t);
  for (const status of ['available', 'reserved', undefined]) {
    assert.equal((await f.call({}, { status })).status, 409); assert.equal((await f.row()).sessionData, null);
  }
});

test('an active bill cannot be replaced with a newly priced session', async t => {
  const session = { customerName: 'Existing QA', startTime: new Date(Date.now()-60000).toISOString(), durationMinutes: 60, isOpenTime: false, hourlyRate: 150, overtimeRate: 75, pricingVersion: 1, amountPaid: 0, orders: [] };
  const f = await fixture(t, { status: 'occupied', session });
  assert.equal((await f.call()).status, 409); assert.deepEqual(JSON.parse((await f.row()).sessionData), session);
});

test('generic walk-in start cannot forge reservation or claim linkage',async t=>{
 const f=await fixture(t);
 for(const patch of [{reservationId:'QA-forged'},{reservationPricing:{}},{claimId:'QA-forged'},{ownerUserId:'QA-forged'},{hourlyRate:null,pricingVersion:2}]){
  assert.equal((await f.call(patch)).status,400);assert.equal((await f.row()).status,'available');assert.equal((await f.row()).sessionData,null);
 }
});

const happyPolicy = {isWeekdayHappyHourActive:true,weekdayHappyHourRate:100,weekdayHappyHourStart:'15:00',weekdayHappyHourEnd:'18:00',isWeekendHappyHourActive:true,weekendHappyHourRate:120,weekendHappyHourStart:'16:00',weekendHappyHourEnd:'20:00'};
test('actual start selects Manila Happy Hour and saves server time; client backdating cannot select a cheaper rate',async t=>{
 const now=Date.parse('2026-10-19T17:59:59+08:00');const f=await fixture(t,{now,settings:happyPolicy});
 assert.equal((await f.call({hourlyRate:150})).status,409);
 assert.equal((await f.call({hourlyRate:100,startTime:'2020-01-01T00:00:00Z'})).status,400);
 assert.equal((await f.call({hourlyRate:100})).status,200);
 const session=JSON.parse((await f.row()).sessionData);assert.equal(session.startTime,new Date(now).toISOString());assert.equal(session.hourlyRate,100);assert.equal(session.overtimeRate,300);
 assert.equal(calculateCheckout(session,now+120*60000,false).tableCents,10000);
 assert.equal(calculateCheckout(session,now+120*60000,false).overtimeCents,30000);
 const after=await fixture(t,{now:Date.parse('2026-10-19T18:00:00+08:00'),settings:happyPolicy});
 assert.equal((await after.call({hourlyRate:100,startTime:new Date(now).toISOString()})).status,409);
});
for(const raceKey of ['isWeekdayHappyHourActive','weekdayHappyHourRate','weekdayHappyHourStart','weekdayHappyHourEnd'])test(`Happy Hour ${raceKey} commit before the start transaction rejects the stale start`,async t=>{
 const f=await fixture(t,{now:Date.parse('2026-10-19T16:00:00+08:00'),settings:happyPolicy,raceKey});
 assert.equal((await f.call({hourlyRate:100})).status,409);assert.equal(f.intercepted(),1);assert.equal((await f.row()).sessionData,null);
});
test('missing or malformed selected-day Happy Hour policy cannot silently bill the regular rate',async t=>{
 const f=await fixture(t,{now:Date.parse('2026-10-19T16:00:00+08:00')});
 await run(f.db,"DELETE FROM systemSettings WHERE keyName='isWeekdayHappyHourActive'");assert.equal((await f.call()).status,409);
 await run(f.db,"INSERT INTO systemSettings VALUES('isWeekdayHappyHourActive','true')");assert.equal((await f.call()).status,409);assert.equal((await f.row()).sessionData,null);
});

test('a destination held by an unresolved reservation move cannot accept a new walk-in',async t=>{
  const f=await fixture(t);
  await run(f.db,'INSERT INTO native_reservation_move_holds VALUES(?,?,?)',['qa','qa-move','qa-claim']);
  assert.equal((await f.call()).status,409);
  assert.equal((await f.row()).sessionData,null);
});
test('a reservation hold acquired before the start transaction rejects the walk-in write',async t=>{
  const f=await fixture(t,{raceKey:'moveHold'});
  assert.equal((await f.call()).status,409);
  assert.equal((await f.row()).sessionData,null);
});

test('an empty destination held for reservation transfer cannot be deleted or relabelled by table handlers',async t=>{
 const f=await fixture(t);
 await run(f.db,'INSERT INTO native_reservation_move_holds VALUES(?,?,?)',['qa','qa-move','qa-claim']);
 assert.equal((await f.raw('DELETE',{expectedStatus:'available',expectedSession:null})).status,409);
 assert.equal((await f.raw('PUT',{maintenanceReason:'QA mutation while held'})).status,409);
 const row=await f.row();assert.equal(row.name,'QA table');assert.equal(row.status,'available');assert.equal(row.maintenanceReason,null);
});
