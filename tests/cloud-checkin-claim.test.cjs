const test = require('node:test');
const assert = require('node:assert/strict');
const { createCloudStaffService, registerCloudStaffRoutes } = require('../server-cloud-staff.cjs');
const STAFF='11111111-1111-4111-8111-111111111111',OWNER='22222222-2222-4222-8222-222222222222',DEVICE='33333333-3333-4333-8333-333333333333',REQUEST='44444444-4444-4444-8444-444444444444';
const input=()=>({requestId:REQUEST,id:'QA-CLAIM',expectedRevision:3,expectedStaffId:STAFF,deviceId:DEVICE,tableId:'local-table'});
const identity=()=>({userId:STAFF,venueId:'oneshot',role:'cashier',email:'staff@example.invalid'});
const result=()=>({claim:{claimId:'55555555-5555-4555-8555-555555555555',requestId:REQUEST,reservationId:'QA-CLAIM',actorUserId:STAFF,actorRole:'cashier',deviceId:DEVICE,tableId:'local-table',cloudTableId:'cloud-table',ownerUserId:OWNER,sourceRevision:3,claimRevision:4,state:'claim-pending',customerName:'QA Claim TEST ONLY',contactNumber:'09123456789',email:'customer@example.invalid',partySize:2,durationMinutes:120,bookingDate:'2026-10-19',timeSlot:'14:00',netTotalCents:27000,grossTotalCents:30000,discountCents:3000,requiredDepositCents:5400,verifiedPaidCents:5400},replayed:false,recordType:'reservation-check-in-claim',fundsTransferred:false});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
async function fixture({reply=result(),claimCall,role='cashier'}={}){
 const calls=[];let active=true,revoked=false;
 const service=createCloudStaffService({enabled:true,key:'sb_publishable_'+'x'.repeat(30),isLocalSessionActive:async()=>active,fetchImpl:async(url,init)=>{
  calls.push({url,init});
  if(url.includes('/auth/v1/token'))return response({access_token:'PRIVATE_ACCESS',refresh_token:'PRIVATE_REFRESH',expires_in:3600});
  if(url.includes('/auth/v1/logout'))return response({});
  if(url.endsWith('/oneshot_staff_identity'))return revoked?response({message:'STAFF_REQUIRED'},403):response({...identity(),role});
  if(url.endsWith('/oneshot_staff_claim_checkin'))return claimCall?claimCall(url,init):response(reply);
  throw Error('Unexpected route');
 }});
 await service.connect('local-session','staff@example.invalid','fixture-existing-password');
 return {service,calls,setActive:value=>{active=value;},setRevoked:value=>{revoked=value;},claimCalls:()=>calls.filter(c=>c.url.endsWith('/oneshot_staff_claim_checkin'))};
}
test('internal claim adapter sends only identity-bound original command and preserves canonical quote/payment cents',async()=>{
 const f=await fixture();const command=input();const saved=await f.service.claimCheckin('local-session',command);
 assert.deepEqual(saved,result());assert.deepEqual(JSON.parse(f.claimCalls()[0].init.body),{payload:command});
 assert.equal(f.claimCalls()[0].init.headers.Authorization,'Bearer PRIVATE_ACCESS');
 assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_ACCESS|PRIVATE_REFRESH/);
});
test('invalid claim commands cannot assert finances or send an RPC',async()=>{
 const f=await fixture();
 for(const patch of [{expectedRevision:0},{expectedRevision:1.5},{expectedRevision:Number.MAX_SAFE_INTEGER},{deviceId:'arbitrary-device'},{tableId:''},{tableId:' local-table'},{id:''},{requestId:'invalid'},{verifiedPaidCents:999999},{expectedTotalCents:1},{expectedStaffId:undefined}]){
  await assert.rejects(f.service.claimCheckin('local-session',{...input(),...patch}),{code:'INVALID_CHECKIN_CLAIM'});
 }
 await assert.rejects(f.service.claimCheckin('local-session',null),{code:'INVALID_CHECKIN_CLAIM'});assert.equal(f.claimCalls().length,0);
});
test('account mismatch and current membership revocation reject before a claim can be sent',async()=>{
 const f=await fixture();await assert.rejects(f.service.claimCheckin('local-session',{...input(),expectedStaffId:OWNER}),{code:'CLOUD_ACCOUNT_CHANGED'});
 f.setRevoked(true);await assert.rejects(f.service.claimCheckin('local-session',input()),{code:'CLOUD_SIGN_IN_REQUIRED'});assert.equal(f.claimCalls().length,0);
});
test('mismatched or malformed cloud claim snapshots are not usable financial authority',async()=>{
 const changes=[{claimId:'bad'},{requestId:OWNER},{reservationId:'other'},{actorUserId:OWNER},{actorRole:'administrator'},{deviceId:OWNER},{tableId:'other'},{cloudTableId:''},{ownerUserId:'bad'},{sourceRevision:4},{claimRevision:3},{state:'checked-in'},{customerName:''},{contactNumber:null},{email:'bad'},{partySize:0},{durationMinutes:1},{bookingDate:'2026-02-30'},{timeSlot:'24:00'},{timeSlot:['14:00']},{netTotalCents:27000.1},{grossTotalCents:29999},{requiredDepositCents:6000},{verifiedPaidCents:27001},{extraAuthority:'unsafe'}];
 for(const patch of changes){const r=result();Object.assign(r.claim,patch);const f=await fixture({reply:r});await assert.rejects(f.service.claimCheckin('local-session',input()),{code:'CLOUD_RESPONSE_INVALID'},JSON.stringify(patch));}
 for(const patch of [{fundsTransferred:true},{recordType:'payment'},{replayed:'yes'},{privateToken:'unsafe'},{claim:null}]){
  const f=await fixture({reply:{...result(),...patch}});await assert.rejects(f.service.claimCheckin('local-session',input()),{code:'CLOUD_RESPONSE_INVALID'});
 }
});
test('zero-deposit and fully paid authoritative snapshots preserve their exact credit without inventing a payment',async()=>{
 for(const paid of [0,27000]){const r=result();r.claim.requiredDepositCents=0;r.claim.verifiedPaidCents=paid;r.replayed=true;const f=await fixture({reply:r});assert.deepEqual(await f.service.claimCheckin('local-session',input()),r);}
});
test('local logout or cloud account disconnect during an unknown claim result prevents adoption',async()=>{
 for(const kind of ['logout','disconnect']){
  let release,entered;const gate=new Promise(done=>{release=done;}),started=new Promise(done=>{entered=done;});
  const f=await fixture({claimCall:async()=>{entered();await gate;return response(result());}});const pending=f.service.claimCheckin('local-session',input());await started;
  if(kind==='logout')f.setActive(false);else await f.service.disconnect('local-session');release();
  await assert.rejects(pending,{code:kind==='logout'?'LOCAL_SESSION_ENDED':'CLOUD_ACCOUNT_CHANGED'});assert.equal(f.claimCalls().length,1);
 }
});
test('input is snapshotted before awaits and an unknown cloud outcome never triggers automatic claim retry',async()=>{
 let original;const f=await fixture({claimCall:async(url,init)=>{original=JSON.parse(init.body).payload;throw Error('lost acknowledgement');}});
 const command=input();const pending=f.service.claimCheckin('local-session',command);command.id='mutated-after-dispatch';
 await assert.rejects(pending,{code:'CLOUD_UNAVAILABLE'});assert.deepEqual(original,input());assert.equal(f.claimCalls().length,1);
});
test('no public native claim route exists before the durable import coordinator is wired',()=>{
 const routes=[];registerCloudStaffRoutes({get:(path)=>routes.push(path),post:(path)=>routes.push(path)},{enabled:false});
 assert.ok(routes.every(path=>!path.includes('checkin')&&!path.includes('claim')));
});

test('exact replay preserves the original audited role after a legitimate staff promotion',async()=>{
 const r=result();r.replayed=true;const f=await fixture({reply:r,role:'manager'});
 const saved=await f.service.claimCheckin('local-session',input());
 assert.equal(saved.claim.actorRole,'cashier');assert.equal(saved.replayed,true);
 const bad=result();bad.replayed=true;bad.claim.actorRole='customer';
 const denied=await fixture({reply:bad,role:'manager'});
 await assert.rejects(denied.service.claimCheckin('local-session',input()),{code:'CLOUD_RESPONSE_INVALID'});
});

test('a fresh authorized database role change during claim creation preserves its authoritative audit role',async()=>{
 const r=result();r.claim.actorRole='manager';const f=await fixture({reply:r,role:'cashier'});
 const saved=await f.service.claimCheckin('local-session',input());
 assert.equal(saved.replayed,false);assert.equal(saved.claim.actorRole,'manager');assert.equal(saved.claim.actorUserId,STAFF);
});
