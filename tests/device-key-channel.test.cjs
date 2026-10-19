const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events');
const {randomBytes,randomUUID}=require('node:crypto');
const {fork}=require('node:child_process');
const {mkdtemp,writeFile,rm}=require('node:fs/promises');
const path=require('node:path'),os=require('node:os');
const {createHostDeviceKeyChannel}=require('../electron/host-device-key-channel.cjs');
const {createDeviceKeyClient}=require('../server-device-key-channel.cjs');
const tick=()=>new Promise(setImmediate),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deviceId=randomUUID(),keyId=randomUUID();
function endpoint(){const peer=new EventEmitter();peer.connected=true;peer.messages=[];peer.send=function(message,callback){this.messages.push(message);callback?.();};return peer;}
function host(overrides={}){
 const child=endpoint(),keys=[],disposals=[];let resolved=0;
 const store={loadDeviceKey:async id=>{const key=randomBytes(32);keys.push(key);return{deviceId:id,keyId,key,dispose:()=>{key.fill(0);disposals.push(id);}};}};
 const channel=createHostDeviceKeyChannel({child,store,resolveDeviceId:async()=>{resolved++;return deviceId;},timeoutMs:100,...overrides});
 return{child,channel,keys,disposals,get resolved(){return resolved;}};
}
const request=(id=deviceId,requestId=randomUUID())=>({type:'device-key-load',requestId,deviceId:id});
const success=(sent,patch={})=>({type:'device-key-result',requestId:sent.requestId,ok:true,deviceId:sent.deviceId,keyId,key:Array(32).fill(42),...patch});

test('host loads only its bound device and clears serialized keys and lease after send callback',async()=>{
 const f=host();let finish;
 f.child.send=(packet,callback)=>{f.child.messages.push(packet);finish=callback;};
 f.child.emit('message',request());await tick();await tick();
 assert.equal(f.keys.length,1);assert.equal(f.disposals.length,0);assert.ok(f.child.messages[0].key.some(value=>value!==0));
 finish();await tick();
 assert.equal(f.disposals.length,1);assert.deepEqual(f.keys[0],Buffer.alloc(32));assert.ok(f.child.messages[0].key.every(value=>value===0));
 f.channel.close();
});

test('strict owned-child schema ignores unknown or duplicate commands and never loads arbitrary device keys',async()=>{
 const f=host();const command=request();
 for(const value of [{...command,payload:'forged'},{...command,requestId:'bad'}, {...command,deviceId:'../keys'}, {...command,type:'device-key-provision'}])f.child.emit('message',value);
 await tick();assert.equal(f.keys.length,0);assert.equal(f.resolved,0);
 f.child.emit('message',request(randomUUID()));await tick();assert.equal(f.keys.length,0);assert.equal(f.child.messages[0].ok,false);
 f.child.emit('message',command);f.child.emit('message',command);await tick();await tick();
 assert.equal(f.keys.length,1);assert.equal(f.resolved,1);assert.equal(f.disposals.length,1);
 f.channel.close();
});

test('trusted device binding is resolved once and remains stable for the owned child lifetime',async()=>{
 let value=deviceId,count=0;
 const f=host({resolveDeviceId:async()=>{count++;return value;}});
 f.child.emit('message',request());await tick();await tick();
 value=randomUUID();f.child.emit('message',request(value));await tick();
 assert.equal(count,1);assert.equal(f.keys.length,1);assert.equal(f.child.messages.at(-1).ok,false);f.channel.close();
});

test('host timeout retains the cap on unfinished OS loads and disposes late results without sending keys',async()=>{
 const child=endpoint();let release,disposals=0,loads=0;
 const channel=createHostDeviceKeyChannel({child,resolveDeviceId:async()=>deviceId,timeoutMs:20,maxPending:1,store:{loadDeviceKey:async()=>{loads++;await new Promise(resolve=>{release=resolve;});return{deviceId,keyId,key:Buffer.alloc(32,42),dispose:async()=>{disposals++;}};}}});
 child.emit('message',request());await tick();await sleep(40);
 assert.equal(child.messages[0].ok,false);
 child.emit('message',request());await tick();assert.equal(loads,1);
 release();await tick();await tick();assert.equal(disposals,1);assert.equal(child.messages.some(value=>value.ok===true),false);channel.close();
});

test('disconnect removes host listeners and handles rejecting asynchronous late disposal without unhandled rejections',async()=>{
 const child=endpoint();let release,disposals=0;
 const channel=createHostDeviceKeyChannel({child,resolveDeviceId:async()=>deviceId,store:{loadDeviceKey:async()=>{await new Promise(resolve=>{release=resolve;});return{deviceId,keyId,key:Buffer.alloc(32),dispose:async()=>{disposals++;throw new Error('private-disposal-details');}};}}});
 child.emit('message',request());await tick();child.connected=false;child.emit('disconnect');
 release();await tick();await tick();
 assert.equal(disposals,1);assert.equal(child.messages.length,0);assert.equal(child.listenerCount('message'),0);channel.close();
});

test('host sanitizes resolver/store/send failures and always disposes invalid leases',async()=>{
 for(const mode of ['resolver','store','invalid','send-throw','send-error']){
  const child=endpoint();let disposed=0;
  if(mode==='send-throw')child.send=()=>{throw new Error('private-send-details');};
  if(mode==='send-error')child.send=(packet,callback)=>{child.messages.push(packet);callback(new Error('private-send-details'));};
  const channel=createHostDeviceKeyChannel({child,timeoutMs:50,resolveDeviceId:async()=>{if(mode==='resolver')throw new Error('private-db-path');return deviceId;},store:{loadDeviceKey:async()=>{if(mode==='store')throw new Error('private-keychain-details');return{deviceId:mode==='invalid'?randomUUID():deviceId,keyId,key:Buffer.alloc(32,42),dispose:()=>{disposed++;}};}}});
  child.emit('message',request());await tick();await tick();
  assert.equal(child.messages.some(value=>JSON.stringify(value).includes('private-')),false);
  if(['invalid','send-throw','send-error'].includes(mode))assert.equal(disposed,1);
  channel.close();
 }
});

test('host limits request rate including rejections without creating unbounded reply work',async()=>{
 const f=host({maxRequests:2,maxPending:1});
 for(let index=0;index<12;index++)f.child.emit('message',request(randomUUID()));
 await tick();await tick();assert.equal(f.child.messages.length,2);assert.equal(f.keys.length,0);f.channel.close();
});

test('backend validates correlated response and returns independent disposable key leases while clearing wire arrays',async()=>{
 const peer=endpoint(),client=createDeviceKeyClient({channel:peer});
 const first=client.loadDeviceKey(deviceId),one=success(peer.messages[0]);peer.emit('message',one);
 const key=await first;assert.deepEqual(key.key,Buffer.alloc(32,42));assert.ok(one.key.every(value=>value===0));
 const second=client.loadDeviceKey(deviceId),two=success(peer.messages[1]);peer.emit('message',two);const other=await second;
 assert.notEqual(key.key,other.key);key.dispose();assert.deepEqual(key.key,Buffer.alloc(32));assert.deepEqual(other.key,Buffer.alloc(32,42));other.dispose();client.close();
});

test('backend rejects malformed or mismatched correlated replies and ignores unknown/duplicate responses safely',async()=>{
 for(const patch of [{deviceId:randomUUID()},{keyId:'bad'},{key:Array(31).fill(1)},{key:Array(32).fill(256)},{key:Array(32).fill('1')},{extra:'forged'},{ok:false,code:'private-details'}]){
  const peer=endpoint(),client=createDeviceKeyClient({channel:peer});const pending=client.loadDeviceKey(deviceId);const check=assert.rejects(pending,{code:'DEVICE_KEY_UNAVAILABLE'});
  peer.emit('message',success(peer.messages[0],patch));await check;client.close();
 }
 const peer=endpoint(),client=createDeviceKeyClient({channel:peer});const pending=client.loadDeviceKey(deviceId);
 const unknown=success({...peer.messages[0],requestId:randomUUID()});peer.emit('message',unknown);assert.ok(unknown.key.every(value=>value===0));
 const valid=success(peer.messages[0]);peer.emit('message',valid);const lease=await pending;
 const duplicate=success(peer.messages[0]);peer.emit('message',duplicate);assert.ok(duplicate.key.every(value=>value===0));assert.deepEqual(lease.key,Buffer.alloc(32,42));lease.dispose();client.close();
});

test('backend timeouts, pending/lease cap, parent disconnect and lease expiry fail closed without cached credentials',async()=>{
 const peer=endpoint(),client=createDeviceKeyClient({channel:peer,timeoutMs:20,leaseMs:20,maxPending:1});
 const pending=client.loadDeviceKey(deviceId),timeout=assert.rejects(pending,{code:'DEVICE_KEY_UNAVAILABLE'});
 await assert.rejects(client.loadDeviceKey(deviceId),{code:'DEVICE_KEY_UNAVAILABLE'});await timeout;
 const fresh=client.loadDeviceKey(deviceId);peer.emit('message',success(peer.messages.at(-1)));const lease=await fresh;
 await assert.rejects(client.loadDeviceKey(deviceId),{code:'DEVICE_KEY_UNAVAILABLE'});await sleep(40);assert.deepEqual(lease.key,Buffer.alloc(32));
 const last=client.loadDeviceKey(deviceId),disconnect=assert.rejects(last,{code:'DEVICE_KEY_UNAVAILABLE'});peer.connected=false;peer.emit('disconnect');await disconnect;
 await assert.rejects(client.loadDeviceKey(deviceId),{code:'DEVICE_KEY_UNAVAILABLE'});assert.equal(peer.listenerCount('message'),0);client.close();
});

test('backend close zeros already issued leases and send errors do not expose diagnostics',async()=>{
 const peer=endpoint(),client=createDeviceKeyClient({channel:peer});const pending=client.loadDeviceKey(deviceId);peer.emit('message',success(peer.messages[0]));const lease=await pending;client.close();assert.deepEqual(lease.key,Buffer.alloc(32));
 for(const throws of [true,false]){
  const failed=endpoint();failed.send=(_packet,callback)=>{if(throws)throw new Error('private-ipc-details');callback(new Error('private-ipc-details'));};
  const local=createDeviceKeyClient({channel:failed});await assert.rejects(local.loadDeviceKey(deviceId),error=>error.code==='DEVICE_KEY_UNAVAILABLE'&&!error.message.includes('private-ipc'));local.close();
 }
});

test('actual fork IPC transfers only a synthetic key and clears main/provider copies after serialization',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'oneshot-key-ipc-test-'));
 const file=path.join(directory,'child.cjs'),moduleFile=path.resolve(__dirname,'../server-device-key-channel.cjs');
 await writeFile(file,`const {createDeviceKeyClient}=require(${JSON.stringify(moduleFile)});const client=createDeviceKeyClient();client.loadDeviceKey(${JSON.stringify(deviceId)}).then(lease=>{const valid=lease.key.equals(Buffer.alloc(32,42));lease.dispose();const disposed=lease.key.equals(Buffer.alloc(32));client.close();process.send({type:'qa-finished',valid,disposed},()=>process.disconnect());}).catch(()=>{process.exitCode=1;process.disconnect();});`);
 const child=fork(file,[],{stdio:['ignore','ignore','ignore','ipc']});let disposed=0,provider;
 const channel=createHostDeviceKeyChannel({child,resolveDeviceId:async()=>deviceId,store:{loadDeviceKey:async()=>{provider=Buffer.alloc(32,42);return{deviceId,keyId,key:provider,dispose:()=>{provider.fill(0);disposed++;}};}}});
 t.after(async()=>{channel.close();if(child.exitCode===null&&child.signalCode===null)child.kill();await rm(directory,{recursive:true,force:true});});
 const finished=new Promise((resolve,reject)=>{child.on('message',value=>{if(value.type==='qa-finished')resolve(value);});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error('Synthetic child failed'));});});
 const result=await finished;assert.deepEqual(result,{type:'qa-finished',valid:true,disposed:true});await once(child,'exit');assert.equal(disposed,1);assert.deepEqual(provider,Buffer.alloc(32));
});

test('host send timeout clears ephemeral material and late callbacks cannot revive the request',async()=>{
 const f=host({timeoutMs:20});let callback;
 f.child.send=(packet,done)=>{f.child.messages.push(packet);if(packet.ok===true)callback=done;else done?.();};
 f.child.emit('message',request());await tick();await sleep(40);
 assert.equal(f.disposals.length,1);assert.deepEqual(f.keys[0],Buffer.alloc(32));assert.ok(f.child.messages.find(packet=>packet.ok===true).key.every(value=>value===0));
 const count=f.child.messages.length;callback();await tick();assert.equal(f.disposals.length,1);assert.equal(f.child.messages.length,count);await f.channel.close();
});
