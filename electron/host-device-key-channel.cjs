const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const safe = () => Object.assign(new Error('The private device key is unavailable.'),{code:'DEVICE_KEY_UNAVAILABLE'});
function bounded(value,min,max) { return Number.isSafeInteger(value)&&value>=min&&value<=max; }

// Attach only to the fork owned by the main process; there is no renderer or provisioning channel.
function createHostDeviceKeyChannel({child,store,resolveDeviceId,timeoutMs=5000,maxPending=4,maxRequests=30,windowMs=60000,now=Date.now,processType=process.type}={}) {
  if((processType!==undefined&&processType!=='browser')||!child||typeof child.on!=='function'||typeof child.removeListener!=='function'||typeof child.send!=='function'||typeof store?.loadDeviceKey!=='function'||typeof resolveDeviceId!=='function'||typeof now!=='function'||!bounded(timeoutMs,10,30000)||!bounded(maxPending,1,16)||!bounded(maxRequests,1,120)||!bounded(windowMs,100,3600000))throw new TypeError('A private main-process child channel and trusted device resolver are required.');
  let closed=false,deviceId,binding,windowStart=now(),requests=0;
  const records=new Map(),seen=new Set();
  const connected=()=>!closed&&child.connected===true;
  function dispose(record) {
    if(record.serialized){record.serialized.fill(0);record.serialized=null;}
    const lease=record.lease;
    if(!lease)return Promise.resolve();
    if(record.disposing)return record.disposal||Promise.resolve();
    record.disposing=true;
    // Invoke synchronous wipes immediately and consume asynchronous cleanup failures.
    try { record.disposal=Promise.resolve(lease.dispose?.()).catch(()=>{}); }
    catch { record.disposal=Promise.resolve(); }
    return record.disposal;
  }
  function finish(record) {
    record.done=true;clearTimeout(record.timer);const disposal=dispose(record);
    if(record.workFinished)records.delete(record.requestId);
    return disposal;
  }
  function deny(requestId) {
    if(!connected())return;
    try { child.send({type:'device-key-result',requestId,ok:false,code:'DEVICE_KEY_UNAVAILABLE'},()=>{}); } catch {}
  }
  async function expectedDevice() {
    if(deviceId)return deviceId;
    if(!binding)binding=Promise.resolve().then(resolveDeviceId).then(value=>{
      if(!uuid(value))throw safe();
      deviceId=value;return value;
    }).finally(()=>{binding=null;});
    return binding;
  }
  async function load(record) {
    try {
      const expected=await expectedDevice();
      if(record.done||!connected())return;
      if(record.deviceId!==expected)throw safe();
      record.lease=await store.loadDeviceKey(expected);
      if(record.done||!connected())return;
      const lease=record.lease;
      if(!lease||lease.deviceId!==expected||!uuid(lease.keyId)||!Buffer.isBuffer(lease.key)||lease.key.length!==32||typeof lease.dispose!=='function')throw safe();
      record.serialized=Array.from(lease.key);
      const packet={type:'device-key-result',requestId:record.requestId,ok:true,deviceId:expected,keyId:lease.keyId,key:record.serialized};
      try { child.send(packet,()=>finish(record)); }
      catch {finish(record);deny(record.requestId);}
    } catch {
      if(!record.done){finish(record);deny(record.requestId);}
    } finally {
      record.workFinished=true;
      if(record.done||!connected())await finish(record);
    }
  }
  function onMessage(input) {
    if(!connected()||input?.type!=='device-key-load')return;
    if(!exact(input,['type','requestId','deviceId'])||!uuid(input.requestId)||!uuid(input.deviceId))return;
    const request={requestId:input.requestId,deviceId:input.deviceId};
    if(records.has(request.requestId)||seen.has(request.requestId))return;
    const time=now();
    if(time-windowStart>=windowMs){windowStart=time;requests=0;seen.clear();}
    if(requests>=maxRequests)return;
    requests++;seen.add(request.requestId);
    if(records.size>=maxPending){deny(request.requestId);return;}
    const record={...request,done:false,workFinished:false,disposing:false};records.set(record.requestId,record);
    record.timer=setTimeout(()=>{if(!record.done){finish(record);deny(record.requestId);}},timeoutMs);
    void load(record);
  }
  function close() {
    if(closed)return Promise.resolve();closed=true;
    child.removeListener('message',onMessage);child.removeListener('disconnect',close);child.removeListener('exit',close);child.removeListener('error',close);
    const cleanup=[...records.values()].map(finish);seen.clear();
    return Promise.all(cleanup).then(()=>{});
  }
  child.on('message',onMessage);child.on('disconnect',close);child.on('exit',close);child.on('error',close);
  return Object.freeze({close});
}
module.exports={createHostDeviceKeyChannel};
