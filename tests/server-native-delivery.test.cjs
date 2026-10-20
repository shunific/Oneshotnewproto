const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {withNativeDeviceFixture}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const {createNativeEventDelivery}=require('../server-native-delivery.cjs');
const {createCloudStaffService,validateNativeEventAckResult}=require('../server-cloud-staff.cjs');
const rows=(db,sql)=>new Promise((resolve,reject)=>db.all(sql,(error,result)=>error?reject(error):resolve(result)));
const A=input.command.expectedStaffId,B='22222222-2222-4222-8222-222222222222';
const clone=value=>JSON.parse(JSON.stringify(value));
function ackFor(envelope,replayed=false){
 const body=JSON.parse(envelope.payload);
 return {ack:{eventId:envelope.eventId,eventType:envelope.eventType,claimId:envelope.claimId,deviceId:envelope.deviceId,reservationId:body.reservationId,payloadSha256:createHash('sha256').update(envelope.payload,'utf8').digest('hex'),state:envelope.eventType==='admission'?'checked-in':'completed',revision:input.result.claim.claimRevision+(envelope.eventType==='admission'?1:2),receiptId:envelope.eventType==='admission'?null:body.receipt.id,receivedAt:'2026-10-19T12:00:00.123Z',acceptedBy:envelope.actorId},replayed,recordType:'reservation-lifecycle-ack',fundsTransferred:false};
}
function setup(f,overrides={}){
 const calls={keys:0,sign:0,network:[],accepted:new Map()};
 const signer=f.makeSigner({loadDeviceKey:async deviceId=>{calls.keys++;return{deviceId,keyId:f.keyId,key:f.key};}});
 const resolveActor=async()=>f.context.active?{localStaffId:f.context.localStaffId,cloudUserId:f.context.cloudUserId,generation:f.context.generation}:null;
 const isActorCurrent=(_,actor)=>f.context.active&&actor.localStaffId===f.context.localStaffId&&actor.cloudUserId===f.context.cloudUserId&&actor.generation===f.context.generation;
 const signEvent=async(token,command)=>{calls.sign++;return signer.sign(token,command);};
 const sendSignedEvent=async(token,envelope)=>{
  calls.network.push(clone(envelope));
  if(calls.accepted.has(envelope.eventId))return{...clone(calls.accepted.get(envelope.eventId)),replayed:true};
  const result=ackFor(envelope);calls.accepted.set(envelope.eventId,clone(result));return result;
 };
 const options={resolveActor,isActorCurrent,signEvent,sendSignedEvent,...overrides};
 return{calls,options,delivery:createNativeEventDelivery(f.file,options),command:{eventType:'admission',eventId:f.admission.outboxEventId}};
}

test('original native admission commits exact ACK and marker atomically; local recovery has fresh auth but no key/network calls',async()=>withNativeDeviceFixture(input,async f=>{
 const d=setup(f);const before=await rows(f.db,'SELECT * FROM tables');
 const first=await d.delivery.deliver('qa-token',d.command);
 assert.equal(first.ack.state,'checked-in');assert.equal(first.ack.acceptedBy,A);assert.equal(first.replayed,false);
 assert.equal((await rows(f.db,'SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,first.ack.receivedAt);
 assert.equal((await rows(f.db,'SELECT * FROM native_event_deliveries')).length,1);
 assert.deepEqual(await rows(f.db,'SELECT * FROM tables'),before);
 f.context.cloudUserId=B;f.context.localStaffId='other-approved-shift';f.context.generation++;
 const replay=await d.delivery.deliver('qa-token',d.command);
 assert.equal(replay.replayed,true);assert.equal(replay.ack.acceptedBy,A);
 assert.equal(d.calls.keys,1);assert.equal(d.calls.network.length,1);
 f.context.active=false;await assert.rejects(d.delivery.deliver('qa-token',d.command),{status:403});
 assert.equal(d.calls.keys,1);assert.equal(d.calls.network.length,1);
}));

test('delivery command is exact and copied before awaiting identity',async()=>withNativeDeviceFixture(input,async f=>{
 const d=setup(f);
 for(const extra of ['payload','actorId','deviceId','keyId'])await assert.rejects(d.delivery.deliver('qa-token',{...d.command,[extra]:'forged'}),{status:400});
 assert.equal(d.calls.keys,0);
 let resume,count=0;
 const delayed=createNativeEventDelivery(f.file,{...d.options,resolveActor:async()=>{if(++count===1)await new Promise(resolve=>{resume=resolve;});return{localStaffId:f.context.localStaffId,cloudUserId:f.context.cloudUserId,generation:f.context.generation};}});
 const mutable={...d.command};const pending=delayed.deliver('qa-token',mutable);mutable.eventId='88888888-8888-4888-8888-888888888888';resume();
 assert.equal((await pending).ack.eventId,d.command.eventId);
}));

test('lost cloud response retries the same original event and retains original accepting actor',async()=>withNativeDeviceFixture(input,async f=>{
 const d=setup(f);let lost=true;
 const delivery=createNativeEventDelivery(f.file,{...d.options,sendSignedEvent:async(...args)=>{const result=await d.options.sendSignedEvent(...args);if(lost){lost=false;throw Object.assign(new Error('synthetic lost ACK'),{status:503});}return result;}});
 await assert.rejects(delivery.deliver('qa-token',d.command),{status:503});
 assert.equal((await rows(f.db,'SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,null);
 assert.equal((await rows(f.db,'SELECT * FROM native_event_deliveries')).length,0);
 f.context.cloudUserId=B;f.context.generation++;
 const result=await delivery.deliver('qa-token',d.command);
 assert.equal(result.replayed,true);assert.equal(result.ack.acceptedBy,A);
 assert.equal(d.calls.network.length,2);assert.equal(d.calls.accepted.size,1);
 assert.equal(d.calls.network[0].payload,d.calls.network[1].payload);
}));

test('late local write failure rolls back delivery ledger and outbox marker after remote acceptance',async()=>withNativeDeviceFixture(input,async f=>{
 const d=setup(f);
 await f.run("CREATE TRIGGER fail_delivery BEFORE UPDATE ON native_checkin_outbox BEGIN SELECT RAISE(ABORT,'synthetic acknowledgement write failure'); END");
 await assert.rejects(d.delivery.deliver('qa-token',d.command),{status:503});
 assert.equal((await rows(f.db,'SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,null);
 assert.equal((await rows(f.db,'SELECT * FROM native_event_deliveries')).length,0);
 await f.run('DROP TRIGGER fail_delivery');
 const recovered=await d.delivery.deliver('qa-token',d.command);
 assert.equal(recovered.replayed,true);assert.equal(d.calls.accepted.size,1);
}));

test('generation or account changes after remote acceptance cannot mark local delivery',async()=>{
 for(const change of [c=>c.generation++,c=>c.cloudUserId=B,c=>c.active=false])await withNativeDeviceFixture(input,async f=>{
  const d=setup(f);const delivery=createNativeEventDelivery(f.file,{...d.options,sendSignedEvent:async(...args)=>{const result=await d.options.sendSignedEvent(...args);change(f.context);return result;}});
  await assert.rejects(delivery.deliver('qa-token',d.command),{status:403});
  assert.equal((await rows(f.db,'SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,null);
  assert.equal((await rows(f.db,'SELECT * FROM native_event_deliveries')).length,0);
 });
});

test('malformed or mismatched cloud acknowledgement leaves original event pending',async()=>{
 for(const patch of [r=>({...r,fundsTransferred:true}),r=>({...r,extra:true}),r=>({...r,ack:{...r.ack,eventId:'88888888-8888-4888-8888-888888888888'}}),r=>({...r,ack:{...r.ack,payloadSha256:'0'.repeat(64)}}),r=>({...r,ack:{...r.ack,acceptedBy:B}}),r=>({...r,ack:{...r.ack,revision:99}}),r=>({...r,ack:{...r.ack,receivedAt:'2026-10-19T12:00:00Z'}})])await withNativeDeviceFixture(input,async f=>{
  const d=setup(f);const delivery=createNativeEventDelivery(f.file,{...d.options,sendSignedEvent:async(_token,envelope)=>patch(ackFor(envelope))});
  await assert.rejects(delivery.deliver('qa-token',d.command));
  assert.equal((await rows(f.db,'SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,null);
  assert.equal((await rows(f.db,'SELECT * FROM native_event_deliveries')).length,0);
 });
});

test('delivered marker without ledger or altered acknowledged body requires reconciliation before signing/network',async()=>{
 await withNativeDeviceFixture(input,async f=>{
  const d=setup(f);await f.run("UPDATE native_checkin_outbox SET delivered_at='2026-10-19T12:00:00.123Z'");
  await assert.rejects(d.delivery.deliver('qa-token',d.command),{status:409,code:'NATIVE_DELIVERY_RECONCILIATION_REQUIRED'});
  assert.equal(d.calls.keys,0);assert.equal(d.calls.network.length,0);
 });
 await withNativeDeviceFixture(input,async f=>{
  const d=setup(f);await d.delivery.deliver('qa-token',d.command);
  await f.run("UPDATE native_event_deliveries SET response_json='{}'");
  await assert.rejects(d.delivery.deliver('qa-token',d.command),{status:409,code:'NATIVE_DELIVERY_RECONCILIATION_REQUIRED'});
  assert.equal(d.calls.keys,1);assert.equal(d.calls.network.length,1);
 });
});

test('completion waits for local admission acknowledgement and never mutates reused tables or archived receipts',async()=>withNativeDeviceFixture(input,async f=>{
 const d=setup(f);const closed=await f.checkout();const command={eventType:'reservation-completion',eventId:closed.reservationCompletion.eventId};
 await assert.rejects(d.delivery.deliver('qa-token',command),{status:409,code:'NATIVE_ADMISSION_ACK_REQUIRED'});
 assert.equal(d.calls.keys,0);assert.equal(d.calls.network.length,0);
 await d.delivery.deliver('qa-token',d.command);
 await f.run("UPDATE tables SET status='occupied',sessionData='next guest bill'");
 const before={tables:await rows(f.db,'SELECT * FROM tables'),receipts:await rows(f.db,'SELECT * FROM e_receipts'),history:await rows(f.db,'SELECT * FROM session_history')};
 const result=await d.delivery.deliver('qa-token',command);
 assert.equal(result.ack.state,'completed');assert.equal(result.ack.receiptId,closed.receipt.id);
 assert.deepEqual({tables:await rows(f.db,'SELECT * FROM tables'),receipts:await rows(f.db,'SELECT * FROM e_receipts'),history:await rows(f.db,'SELECT * FROM session_history')},before);
 assert.equal((await rows(f.db,'SELECT * FROM native_event_deliveries')).length,2);
 assert.equal((await d.delivery.deliver('qa-token',command)).replayed,true);
 assert.equal(d.calls.keys,2);assert.equal(d.calls.network.length,2);
}));

test('concurrent delivery deduplicates the same remote ACK and local delivery ledger',async()=>withNativeDeviceFixture(input,async f=>{
 const d=setup(f);const results=await Promise.all([d.delivery.deliver('qa-token',d.command),d.delivery.deliver('qa-token',d.command)]);
 assert.equal(results.length,2);assert.deepEqual(results[0].ack,results[1].ack);
 assert.equal((await rows(f.db,'SELECT * FROM native_event_deliveries')).length,1);assert.equal(d.calls.accepted.size,1);
}));

test('unsupported delivery schema fails before any private key or network access',async()=>withNativeDeviceFixture(input,async f=>{
 const d=setup(f);await f.run('CREATE TABLE native_event_deliveries(event_id TEXT PRIMARY KEY)');
 await assert.rejects(d.delivery.deliver('qa-token',d.command),{status:409});
 assert.equal(d.calls.keys,0);assert.equal(d.calls.network.length,0);
}));

test('strict cloud ACK adapter sends the copied staff-authorized envelope only through authenticated RPC and validates replay actor',async()=>withNativeDeviceFixture(input,async f=>{
 const historical=await f.makeSigner().sign('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});
 const {keyId,signature,...unsigned}=historical;const envelope={...unsigned,version:2};
 const calls=[];let remoteActor=A,originalAck,pause=false,resume;
 const service=createCloudStaffService({enabled:true,key:'sb_publishable_'+'q'.repeat(30),isLocalSessionActive:async()=>true,fetchImpl:async(url,init)=>{
  calls.push({url,init});
  const response=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  if(url.includes('/token'))return response({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600});
  if(url.endsWith('/oneshot_staff_identity')){if(pause){pause=false;await new Promise(resolve=>{resume=resolve;});}return response({userId:remoteActor,venueId:'oneshot',role:'cashier',email:'qa@example.invalid'});}
  if(url.endsWith('/oneshot_staff_ack_native_event')){assert.equal(init.headers.Authorization,'Bearer private-access');const body=JSON.parse(init.body);assert.deepEqual(Object.keys(body),['payload']);assert.deepEqual(body.payload,envelope);originalAck=ackFor(envelope);return response(originalAck);}
  throw new Error('Unexpected request');
 }});
 await service.connect('qa-token','qa@example.invalid','existing-synthetic-password');
 await assert.rejects(service.ackNativeEvent('qa-token',historical),{status:400});
 const mutable={...envelope};pause=true;const pending=service.ackNativeEvent('qa-token',mutable);
 await new Promise(setImmediate);mutable.payload='{}';resume();
 const result=await pending;
 assert.equal(result.ack.acceptedBy,A);assert.equal(calls.filter(c=>c.url.endsWith('/oneshot_staff_ack_native_event')).length,1);
 const replayEnvelope={...envelope,actorId:B};
 assert.equal(validateNativeEventAckResult({...originalAck,replayed:true},replayEnvelope).ack.acceptedBy,A);
 await assert.rejects(service.ackNativeEvent('qa-token',replayEnvelope),{status:403});
 for(const patch of [{key:'forged'}, {signature:'bad'}, {payload:'{}'}])await assert.rejects(service.ackNativeEvent('qa-token',{...envelope,...patch}),{status:400});
 assert.equal(calls.filter(c=>c.url.endsWith('/oneshot_staff_ack_native_event')).length,1);
}));


test('cloud delivery callback runs without a held local SQLite write transaction',async()=>withNativeDeviceFixture(input,async f=>{
 const d=setup(f);const delivery=createNativeEventDelivery(f.file,{...d.options,sendSignedEvent:async(...args)=>{
  await f.run('BEGIN IMMEDIATE');await f.run('ROLLBACK');return d.options.sendSignedEvent(...args);
 }});
 assert.equal((await delivery.deliver('qa-token',d.command)).ack.state,'checked-in');
}));

test('a changed acknowledged original event body blocks local replay without consulting key or cloud',async()=>withNativeDeviceFixture(input,async f=>{
 const d=setup(f);await d.delivery.deliver('qa-token',d.command);
 await f.run("UPDATE native_checkin_outbox SET payload_json='{}'");
 await assert.rejects(d.delivery.deliver('qa-token',d.command),{status:409});
 assert.equal(d.calls.keys,1);assert.equal(d.calls.network.length,1);
}));
