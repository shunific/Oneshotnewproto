import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadPrivateBookingReceipt as uploadReceipt, clearPendingReceiptUploads, forgetBookedReceiptUpload, downloadPrivateBookingReceipt, assertPrivateReceiptReference, RECEIPT_BUCKET, MAX_RECEIPT_BYTES } from './privateReceipts.js';
function memoryStorage() {
 const values = new Map(); return { get length(){return values.size;}, key:index=>[...values.keys()][index] ?? null, getItem:key=>values.get(key) ?? null, setItem:(key,value)=>values.set(key,String(value)), removeItem:key=>values.delete(key) };
}
const clientStores = new WeakMap();
function uploadPrivateBookingReceipt(client, file, options) {
 if (!clientStores.has(client)) clientStores.set(client,memoryStorage());
 return uploadReceipt(client,file,options || {storage:clientStores.get(client)});
}
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const path = `${owner}/33333333-3333-4333-8333-333333333333.png`;
const file = (tail = 0) => new Blob([Uint8Array.from([137,80,78,71,13,10,26,10,tail])], { type:'image/png' });
function fixture(options = {}) {
  const calls = [], intents = new Map(), objects = new Map();
  let user = { id: owner, email_confirmed_at:'2026-10-19', is_anonymous:false, ...options.user };
  const client = {
    auth:{ getUser:async()=>({ data:{ user }, error:options.authError }) },
    rpc:async(name, { payload })=>{
      calls.push({ rpc:name, payload });
      assert.equal(name, 'oneshot_receipt_upload_intent');
      const replayed = intents.has(payload.requestId);
      if (!replayed) intents.set(payload.requestId, `${payload.expectedCustomerId}/${crypto.randomUUID()}.${payload.contentType === 'image/png' ? 'png' : 'jpg'}`);
      const intent = { bucket:RECEIPT_BUCKET, path:intents.get(payload.requestId), declaredSize:payload.byteSize, declaredMime:payload.contentType, sha256:payload.sha256, expiresAt:new Date(Date.now()+900000).toISOString(), replayed, uploadAllowed:true };
      options.onIntent?.();
      return { data:options.intentResult ? options.intentResult(intent) : intent, error:options.intentError };
    },
    storage:{ from(bucket) {
      calls.push({ bucket });
      return {
        upload:async(uploadPath, body, config)=>{
          calls.push({ uploadPath, body, config });
          options.onUpload?.();
          if (options.commitBeforeFailure) objects.set(uploadPath, body);
          if (options.uploadThrows) throw Error('Connection lost');
          if (options.uploadResult) return options.uploadResult;
          if (objects.has(uploadPath)) return { error:Error('Asset Already Exists') };
          objects.set(uploadPath, body);
          return { data:{ path:uploadPath }, error:null };
        },
        download:async(downloadPath)=>{
          calls.push({ downloadPath }); options.onDownload?.();
          return options.downloadResult || (objects.has(downloadPath) ? { data:objects.get(downloadPath), error:null } : { error:Object.assign(Error('Not found'),{statusCode:'404'}) });
        },
      };
    } },
  };
  return { client, calls, intents, objects, setUser:value=>{user=value;} };
}
test('private upload uses only server-issued owner path and immutable options', async()=>{
  const {client,calls}=fixture(); const result=await uploadPrivateBookingReceipt(client,file());
  const request=calls.find(x=>x.rpc), upload=calls.find(x=>x.uploadPath);
  assert.equal(request.payload.expectedCustomerId, owner);
  assert.equal(request.payload.byteSize, 9); assert.match(request.payload.sha256,/^[0-9a-f]{64}$/);
  assert.match(result.path,new RegExp(`^${owner}/[0-9a-f-]{36}\\.png$`));
  assert.deepEqual(upload.config,{upsert:false,contentType:'image/png',cacheControl:'0'});
  assert.deepEqual(Object.keys(result).sort(),['bucket','path']); assert.ok(Object.isFrozen(result));
});
test('same content reselected reuses exact request; changed bytes get distinct intent', async()=>{
  const {client,calls}=fixture(), body=file();
  const first=await uploadPrivateBookingReceipt(client,body);
  const retry=await uploadPrivateBookingReceipt(client,body);
  const sameBytes=await uploadPrivateBookingReceipt(client,file());
  const different=await uploadPrivateBookingReceipt(client,file(1));
  assert.equal(first.path,retry.path); assert.equal(first.path,sameBytes.path); assert.notEqual(first.path,different.path);
  const requests=calls.filter(x=>x.rpc).map(x=>x.payload);
  assert.deepEqual(requests[0],requests[1]); assert.deepEqual(requests[0],requests[2]); assert.notEqual(requests[0].requestId,requests[3].requestId);
  assert.ok(calls.some(x=>x.downloadPath===first.path));
});
test('unverified, anonymous, malformed and failed auth never requests intent or storage',async()=>{
  for(const options of [{user:{email_confirmed_at:null}},{user:{is_anonymous:true}},{user:{id:'../../other'}},{authError:Error('Expired')}]){
    const {client,calls}=fixture(options);await assert.rejects(uploadPrivateBookingReceipt(client,file()));assert.equal(calls.length,0);
  }
});
test('invalid MIME, size, empty and spoofed image headers fail before any request',async()=>{
  for(const body of [new Blob([],{type:'image/png'}),new Blob(['text'],{type:'image/svg+xml'}),new Blob(['forged'],{type:'image/png'}),{type:'image/png',size:MAX_RECEIPT_BYTES+1}]){
    const {client,calls}=fixture();await assert.rejects(uploadPrivateBookingReceipt(client,body));assert.equal(calls.length,0);
  }
});
test('quota/unknown intent failures never fall back to an arbitrary upload path',async()=>{
  for (const intentError of [Error('RECEIPT_UPLOAD_LIMIT'),Error('RECEIPT_UNLINKED_LIMIT'),Error('Response lost')]) {
    const {client,calls}=fixture({intentError});await assert.rejects(uploadPrivateBookingReceipt(client,file()));
    assert.equal(calls.filter(x=>x.bucket).length,0);
  }
});
test('changed intent path, MIME, size, hash or missing acknowledgement prevents upload',async()=>{
  for(const change of [v=>null,v=>({...v,path:v.path.replace(owner,other)}),v=>({...v,declaredMime:'image/jpeg'}),v=>({...v,declaredSize:1}),v=>({...v,sha256:'0'.repeat(64)}),v=>({...v,expiresAt:null}),v=>({...v,replayed:undefined}),v=>({...v,uploadAllowed:undefined})]){
    const {client,calls}=fixture({intentResult:change});await assert.rejects(uploadPrivateBookingReceipt(client,file()));
    assert.equal(calls.filter(x=>x.uploadPath).length,0);
  }
});
test('lost intent acknowledgement retries the same ID rather than consuming another slot',async()=>{
  const options={intentError:Error('Response lost')}, {client,calls,intents}=fixture(options), body=file();
  await assert.rejects(uploadPrivateBookingReceipt(client,body)); options.intentError=null;
  await uploadPrivateBookingReceipt(client,body);
  assert.equal(intents.size,1); assert.deepEqual(calls.filter(x=>x.rpc)[0].payload,calls.filter(x=>x.rpc)[1].payload);
});
test('lost upload acknowledgement recovers only matching saved bytes on exact private path',async()=>{
  for(const failure of [{uploadResult:{error:Error('Lost ACK')}},{uploadThrows:true},{uploadResult:{data:null}},{uploadResult:{data:{path:'wrong/path.png'}}}]){
    const {client,calls}=fixture({...failure,commitBeforeFailure:true}); const result=await uploadPrivateBookingReceipt(client,file());
    assert.equal(calls.find(x=>x.downloadPath).downloadPath,result.path);
  }
  for(const saved of [file(1),new Blob(['wrong'],{type:'image/png'}),new Blob([await file().arrayBuffer()],{type:'image/jpeg'})]){
    const {client}=fixture({uploadResult:{error:Error('Unknown')},downloadResult:{data:saved}});
    await assert.rejects(uploadPrivateBookingReceipt(client,file()),/unconfirmed/);
  }
});
test('uncertain upload without saved bytes retains the same selected-file intent for retry',async()=>{
  const options={uploadResult:{error:Error('Unavailable')}}, {client,calls,intents}=fixture(options), body=file();
  await assert.rejects(uploadPrivateBookingReceipt(client,body),/unconfirmed/);
  options.uploadResult=null;
  await uploadPrivateBookingReceipt(client,body);
  assert.equal(intents.size,1); const uploads=calls.filter(x=>x.uploadPath);assert.equal(uploads[0].uploadPath,uploads[1].uploadPath);
});
test('concurrent attempts with the same selected file converge to one saved object',async()=>{
  const {client,intents,objects}=fixture(), body=file();const results=await Promise.all([uploadPrivateBookingReceipt(client,body),uploadPrivateBookingReceipt(client,body)]);
  assert.equal(results[0].path,results[1].path);assert.equal(intents.size,1);assert.equal(objects.size,1);
});
test('account changes during intent or upload cannot return an old receipt to the new account',async()=>{
  for(const stage of ['onIntent','onUpload']){
    const options={}, f=fixture(options);options[stage]=()=>f.setUser({id:other,email_confirmed_at:'2026-10-19',is_anonymous:false});
    await assert.rejects(uploadPrivateBookingReceipt(f.client,file()),/account changed/);
    if(stage==='onIntent')assert.equal(f.calls.filter(x=>x.uploadPath).length,0);
  }
});
test('JPEG receipt uses server jpg path without original filename',async()=>{
  const {client}=fixture();const body=new Blob([Uint8Array.from([255,216,255,0])],{type:'image/jpeg'});
  assert.match((await uploadPrivateBookingReceipt(client,body)).path,/\.jpg$/);
});
test('owner download validates private scope, type, size and fresh identity',async()=>{
  const {client,calls}=fixture({downloadResult:{data:file()}});assert.ok(await downloadPrivateBookingReceipt(client,{bucket:RECEIPT_BUCKET,path}) instanceof Blob);
  assert.equal(calls.find(x=>x.downloadPath).downloadPath,path);
  for(const data of [null,new Blob([],{type:'image/png'}),new Blob(['forged'],{type:'image/png'}),new Blob(['svg'],{type:'image/svg+xml'})])
    await assert.rejects(downloadPrivateBookingReceipt(fixture({downloadResult:{data}}).client,{bucket:RECEIPT_BUCKET,path}));
  const options={}, f=fixture(options);options.downloadResult={data:file()};options.onDownload=()=>f.setUser({id:other,email_confirmed_at:'2026-10-19'});
  await assert.rejects(downloadPrivateBookingReceipt(f.client,{bucket:RECEIPT_BUCKET,path}),/account changed/);
});
test('public URLs, other buckets, owner mismatch and traversal are rejected before storage',async()=>{
  for(const ref of ['https://example.test/public.png',{bucket:'oneshot-assets',path},{bucket:RECEIPT_BUCKET,path:path.replace(owner,other)},{bucket:RECEIPT_BUCKET,path:`${owner}/../file.png`}]){
    const {client,calls}=fixture();await assert.rejects(downloadPrivateBookingReceipt(client,ref));assert.equal(calls.length,0);
  }
  assert.deepEqual(assertPrivateReceiptReference({bucket:RECEIPT_BUCKET,path}),{bucket:RECEIPT_BUCKET,path});
});

test('expired intent recovers existing receipt without attempting an unauthorized upload',async()=>{
  const {client,calls}=fixture({intentResult:v=>({...v,uploadAllowed:false}),downloadResult:{data:file()}});
  await uploadPrivateBookingReceipt(client,file());
  assert.equal(calls.filter(x=>x.uploadPath).length,0);
});
test('expired permission plus definite missing object requests a new intent on next retry',async()=>{
  const options={intentResult:v=>({...v,uploadAllowed:false})}, {client,calls}=fixture(options), body=file();
  await assert.rejects(uploadPrivateBookingReceipt(client,body),/expired/);
  options.intentResult=null;
  await uploadPrivateBookingReceipt(client,body);
  const requests=calls.filter(x=>x.rpc);
  assert.notEqual(requests[0].payload.requestId,requests[1].payload.requestId);
  assert.equal(calls.filter(x=>x.uploadPath).length,1);
});
test('expired permission with unknown download result retains request until existence is known',async()=>{
  const options={intentResult:v=>({...v,uploadAllowed:false}),downloadResult:{error:Object.assign(Error('Unavailable'),{status:503})}}, {client,calls}=fixture(options), body=file();
  await assert.rejects(uploadPrivateBookingReceipt(client,body),/unconfirmed/);
  await assert.rejects(uploadPrivateBookingReceipt(client,body),/unconfirmed/);
  assert.deepEqual(calls.filter(x=>x.rpc)[0].payload,calls.filter(x=>x.rpc)[1].payload);
});

test('new client and reselected identical bytes recover persisted unknown intent payload',async()=>{
 const storage=memoryStorage(), options={intentError:Error('Lost ACK')}, f=fixture(options);
 await assert.rejects(uploadReceipt(f.client,file(),{storage}));options.intentError=null;
 const result=await uploadReceipt({...f.client},file(),{storage});
 const requests=f.calls.filter(call=>call.rpc);assert.deepEqual(requests[0].payload,requests[1].payload);assert.equal(f.intents.size,1);
 const stored=JSON.parse(storage.getItem(storage.key(0)));assert.equal(stored[0].path,result.path);
 assert.deepEqual(Object.keys(stored[0]).sort(),['byteSize','contentType','path','requestId','sha256']);
});
test('concurrent different File objects with identical content share durable request',async()=>{
 const storage=memoryStorage(), f=fixture();
 const results=await Promise.all([uploadReceipt(f.client,file(),{storage}),uploadReceipt({...f.client},file(),{storage})]);
 assert.equal(results[0].path,results[1].path);assert.equal(f.intents.size,1);assert.equal(f.objects.size,1);
});
test('missing, unreadable and readonly recovery storage fail before intent dispatch',async()=>{
 for(const storage of [null,{...memoryStorage(),getItem(){throw Error('Blocked');}},{...memoryStorage(),setItem(){throw Error('Readonly');}}]){
  const f=fixture();await assert.rejects(uploadReceipt(f.client,file(),{storage}));assert.equal(f.calls.length,0);
 }
 const storage=memoryStorage(), f=fixture();await uploadReceipt(f.client,file(),{storage});storage.setItem=()=>{throw Error('Readonly');};
 const before=f.calls.length;await assert.rejects(uploadReceipt(f.client,file(),{storage}));assert.equal(f.calls.length,before);
});
test('corrupt or oversized recovery state fails closed before any intent',async()=>{
 for(const raw of ['{','null','{}','[{}]',JSON.stringify(Array(6).fill({}))]){
  const storage=memoryStorage(),f=fixture();storage.setItem('oneshot_pending_receipt_v1:'+owner,raw);
  await assert.rejects(uploadReceipt(f.client,file(),{storage}),/invalid/);assert.equal(f.calls.length,0);
 }
});
test('at most five pending content records persist and unknown responses retain each one',async()=>{
 const storage=memoryStorage(),f=fixture({intentError:Error('Unknown')});
 for(let index=0;index<5;index++)await assert.rejects(uploadReceipt(f.client,file(index),{storage}));
 await assert.rejects(uploadReceipt(f.client,file(5),{storage}),/pending booking/);assert.equal(f.calls.filter(call=>call.rpc).length,5);
 await assert.rejects(uploadReceipt(f.client,file(0),{storage}));assert.equal(f.calls.filter(call=>call.rpc).length,6);
});
test('account pruning clears only receipt records outside retained owner',async()=>{
 const storage=memoryStorage();storage.setItem('unrelated','keep');storage.setItem('oneshot_pending_receipt_v1:'+owner,'[]');storage.setItem('oneshot_pending_receipt_v1:'+other,'[]');
 clearPendingReceiptUploads(storage,owner);assert.equal(storage.getItem('oneshot_pending_receipt_v1:'+other),null);assert.equal(storage.getItem('oneshot_pending_receipt_v1:'+owner),'[]');assert.equal(storage.getItem('unrelated'),'keep');
 clearPendingReceiptUploads(storage);assert.equal(storage.length,1);
});
test('confirmed booking retires only its matching saved path; cleanup is best effort',async()=>{
 const storage=memoryStorage(),f=fixture();const first=await uploadReceipt(f.client,file(),{storage});const second=await uploadReceipt(f.client,file(1),{storage});
 assert.equal(forgetBookedReceiptUpload(storage,first),true);assert.equal(forgetBookedReceiptUpload(storage,first),false);
 const records=JSON.parse(storage.getItem(storage.key(0)));assert.equal(records.length,1);assert.equal(records[0].path,second.path);
 assert.equal(forgetBookedReceiptUpload(null,first),false);storage.setItem(storage.key(0),'{');assert.equal(forgetBookedReceiptUpload(storage,second),false);
});
test('late intent completion after pruning cannot reinstall old receipt record',async()=>{
 const storage=memoryStorage(),options={},f=fixture(options);options.onIntent=()=>clearPendingReceiptUploads(storage);
 await assert.rejects(uploadReceipt(f.client,file(),{storage}),/request changed/);assert.equal(storage.length,0);assert.equal(f.calls.filter(call=>call.uploadPath).length,0);
});
test('late consumed upload completion cannot replace or erase a newer content operation',async()=>{
 const storage=memoryStorage(),options={},f=fixture(options);let replacement;
 options.onUpload=()=>{
  const key=storage.key(0),record=JSON.parse(storage.getItem(key))[0];
  assert.equal(forgetBookedReceiptUpload(storage,{bucket:RECEIPT_BUCKET,path:record.path}),true);
  replacement={sha256:record.sha256,byteSize:record.byteSize,contentType:record.contentType,requestId:crypto.randomUUID()};storage.setItem(key,JSON.stringify([replacement]));
 };
 await assert.rejects(uploadReceipt(f.client,file(),{storage}),/request changed/);
 assert.deepEqual(JSON.parse(storage.getItem(storage.key(0))),[replacement]);
});
test('expired definite404 rotation is durable across client reload and file reselection',async()=>{
 const storage=memoryStorage(),options={intentResult:value=>({...value,uploadAllowed:false})},f=fixture(options);
 await assert.rejects(uploadReceipt(f.client,file(),{storage}),/expired/);const rotated=JSON.parse(storage.getItem(storage.key(0)))[0].requestId;
 options.intentResult=null;await uploadReceipt({...f.client},file(),{storage});assert.equal(f.calls.filter(call=>call.rpc)[1].payload.requestId,rotated);
});
test('account change during original digest prevents recovery persistence and intent',async()=>{
 const storage=memoryStorage(),f=fixture();
 class SwitchingBlob extends Blob { async arrayBuffer(){const bytes=await super.arrayBuffer();f.setUser({id:other,email_confirmed_at:'2026-10-19'});return bytes;} }
 const body=new SwitchingBlob([await file().arrayBuffer()],{type:'image/png'});
 await assert.rejects(uploadReceipt(f.client,body,{storage}),/account changed/);assert.equal(storage.length,0);assert.equal(f.calls.length,0);
});
test('account change during recovered byte digest cannot return receipt',async()=>{
 const storage=memoryStorage(),options={uploadResult:{error:Error('Lost ACK')}},f=fixture(options);
 class SwitchingBlob extends Blob { async arrayBuffer(){const bytes=await super.arrayBuffer();f.setUser({id:other,email_confirmed_at:'2026-10-19'});return bytes;} }
 options.downloadResult={data:new SwitchingBlob([await file().arrayBuffer()],{type:'image/png'})};
 await assert.rejects(uploadReceipt(f.client,file(),{storage}),/account changed/);
});


test('coercible identifiers, digests and oversized recovery metadata are rejected before RPC', async()=>{
 const f=fixture(), storage=memoryStorage();
 await uploadReceipt(f.client,file(),{storage});
 const key=storage.key(0), original=JSON.parse(storage.getItem(key))[0];
 for(const wrong of [{...original,requestId:[original.requestId]},{...original,sha256:[original.sha256]},{...original,path:[original.path]}]){
  storage.setItem(key,JSON.stringify([wrong]));const before=f.calls.length;
  await assert.rejects(uploadReceipt(f.client,file(),{storage}),/invalid/);assert.equal(f.calls.length,before);
 }
 storage.setItem(key,' '.repeat(4097));const before=f.calls.length;
 await assert.rejects(uploadReceipt(f.client,file(),{storage}),/invalid/);assert.equal(f.calls.length,before);
});
test('A to B to A prune during initial digest cannot recreate old upload intent',async()=>{
 const storage=memoryStorage(),f=fixture();
 class PruningBlob extends Blob {async arrayBuffer(){const bytes=await super.arrayBuffer();f.setUser({id:other,email_confirmed_at:'2026-10-19'});clearPendingReceiptUploads(storage);f.setUser({id:owner,email_confirmed_at:'2026-10-19'});return bytes;}}
 const body=new PruningBlob([await file().arrayBuffer()],{type:'image/png'});
 await assert.rejects(uploadReceipt(f.client,body,{storage}),/request changed/);assert.equal(storage.length,0);assert.equal(f.calls.length,0);
});
test('A to B to A prune during intent response cannot persist path or upload',async()=>{
 const storage=memoryStorage(),options={},f=fixture(options);options.onIntent=()=>{f.setUser({id:other,email_confirmed_at:'2026-10-19'});clearPendingReceiptUploads(storage);f.setUser({id:owner,email_confirmed_at:'2026-10-19'});};
 await assert.rejects(uploadReceipt(f.client,file(),{storage}),/request changed/);assert.equal(storage.length,0);assert.equal(f.calls.filter(x=>x.uploadPath).length,0);
});
test('A to B to A prune during recovered digest prevents old success without touching new state',async()=>{
 const storage=memoryStorage(),options={uploadResult:{error:Error('Lost ACK')}},f=fixture(options);let replacement;
 class PruningBlob extends Blob {async arrayBuffer(){const bytes=await super.arrayBuffer();const key=storage.key(0),record=JSON.parse(storage.getItem(key))[0];clearPendingReceiptUploads(storage);replacement={...record,requestId:crypto.randomUUID()};storage.setItem(key,JSON.stringify([replacement]));return bytes;}}
 options.downloadResult={data:new PruningBlob([await file().arrayBuffer()],{type:'image/png'})};
 await assert.rejects(uploadReceipt(f.client,file(),{storage}),/request changed/);assert.deepEqual(JSON.parse(storage.getItem(storage.key(0))),[replacement]);
});
test('failed prune still invalidates in-flight work and independent storage keeps its generation',async()=>{
 const storage=memoryStorage(),independent=memoryStorage(),f=fixture();
 class PruningBlob extends Blob {async arrayBuffer(){const bytes=await super.arrayBuffer();storage.key=()=>{throw Error('Blocked');};storage.setItem('oneshot_pending_receipt_v1:'+owner,'[]');assert.throws(()=>clearPendingReceiptUploads(storage));return bytes;}}
 await assert.rejects(uploadReceipt(f.client,new PruningBlob([await file().arrayBuffer()],{type:'image/png'}),{storage}),/request changed/);assert.equal(f.calls.length,0);
 assert.ok((await uploadReceipt(f.client,file(),{storage:independent})).path);
});
