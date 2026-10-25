// QA only: use packaged modules with a real local-PostgreSQL claim and controlled transport.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const base = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(fs.readFileSync(path.join(base, process.argv[3] || 'native-reservation-qa-fixture-20261019.json')));
  assert.ok(path.basename(manifest.userData).startsWith('oneshot-reservation-qa-'));
  const archive = path.resolve(process.argv[2]);
  const sqlite3 = require(path.join(archive, 'node_modules/sqlite3'));
  const { createCloudStaffService, PROJECT_URL } = require(path.join(archive, 'server-cloud-staff.cjs'));
  const { createCheckinCoordinator } = require(path.join(archive, 'server-checkin.cjs'));
  const sql = JSON.parse(fs.readFileSync(path.join(base, 'staff-checkin-local-20261019.json')));
  const command = sql.successfulCommand, result = sql.successfulResult;
  const filename = path.join(manifest.userData, 'oneshot.db');
  const db = await new Promise((resolve,reject) => { const c = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE, e => e ? reject(e) : resolve(c)); });
  const run = (s,a=[]) => new Promise((resolve,reject) => db.run(s,a,e=>e?reject(e):resolve()));
  const get = (s,a=[]) => new Promise((resolve,reject) => db.get(s,a,(e,r)=>e?reject(e):resolve(r)));
  await run('CREATE TABLE IF NOT EXISTS native_checkin_device (singleton INTEGER PRIMARY KEY CHECK(singleton=1), device_id TEXT NOT NULL UNIQUE)');
  await run('INSERT INTO native_checkin_device(singleton,device_id) VALUES(1,?)', [command.deviceId]);
  const local = await get('SELECT id FROM staff WHERE username=?', ['qa_release_cashier']);
  assert.ok(local?.id);
  let calls=0;
  const reply = value => new Response(JSON.stringify(value), {status:200, headers:{'content-type':'application/json'}});
  const token='qa-packaged-contract-session';
  const service = createCloudStaffService({enabled:true,key:'sb_publishable_'+ 'x'.repeat(30),
    isLocalSessionActive:async t=>t===token,
    fetchImpl:async (url,init)=>{
      assert.ok(url.startsWith(PROJECT_URL+'/'));
      if(url.includes('/auth/v1/token')) return reply({access_token:'FIXTURE_ACCESS',refresh_token:'FIXTURE_REFRESH',expires_in:3600});
      if(url.endsWith('/oneshot_staff_identity')) return reply({userId:command.expectedStaffId,venueId:'oneshot',role:'cashier',email:'staff@example.invalid'});
      if(url.endsWith('/oneshot_staff_claim_checkin')) {assert.deepEqual(JSON.parse(init.body),{payload:command});calls++;return reply(result);}
      throw Error('Unexpected controlled transport call');
    }});
  await service.connect(token,'staff@example.invalid','existing-fixture-password');
  const actor={localStaffId:local.id,cloudUserId:command.expectedStaffId,generation:1};
  const coordinator=createCheckinCoordinator(filename,{claimCheckin:service.claimCheckin,
    resolveActor:async t=>t===token?actor:null,
    isActorCurrent:(t,a)=>t===token&&a.localStaffId===actor.localStaffId&&a.cloudUserId===actor.cloudUserId&&a.generation===1});
  const {deviceId,...nativeCommand}=command;
  await coordinator.claim(token,nativeCommand);
  const admission=await coordinator.admit(token,{requestId:command.requestId,expectedOvertimeRate:300});
  const replay=await coordinator.admit(token,{requestId:command.requestId,expectedOvertimeRate:300});
  assert.equal(calls,1); assert.equal(replay.replayed,true); assert.equal(admission.cloudAcknowledged,false);
  assert.equal(admission.table.session.amountPaid,60);
  assert.equal(admission.table.session.reservationPricing.grossCents,35000);
  assert.equal(admission.table.session.reservationPricing.discountCents,5000);
  assert.equal(admission.table.session.reservationPricing.netCents,30000);
  assert.equal((await get('SELECT COUNT(*) AS n FROM native_checkin_outbox')).n,1);
  const proof={PASS:true,scope:'Packaged coordinator + adapter + SQLite admission; real local PostgreSQL claim with controlled Auth/RPC transport',userData:manifest.userData,tableId:command.tableId,requestId:command.requestId,claimId:result.claim.claimId,cloudCalls:calls,outboxRows:1,credit:60,gross:350,discount:50,net:300,replayPreserved:true,cloudAcknowledged:false,liveWrites:false,limits:['No public check-in UI, hosted RPC, cloud acknowledgment or release exercised.']};
  fs.writeFileSync(path.join(base,process.argv[4] || 'native-rc8-admission-proof-20261019.json'),JSON.stringify(proof,null,2)+'\n');
  await new Promise(resolve=>db.close(resolve));
  console.log(JSON.stringify(proof));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
