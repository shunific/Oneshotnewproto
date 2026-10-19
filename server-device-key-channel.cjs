const {randomUUID}=require('node:crypto');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=()=>Object.assign(new Error('The private device key is unavailable.'),{code:'DEVICE_KEY_UNAVAILABLE'});
const bounded=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
function createDeviceKeyClient({channel=process,timeoutMs=5000,leaseMs=5000,maxPending=4}={}) {
  if(!channel||typeof channel.on!=='function'||typeof channel.removeListener!=='function'||typeof channel.send!=='function'||!bounded(timeoutMs,10,30000)||!bounded(leaseMs,10,30000)||!bounded(maxPending,1,16))throw new TypeError('A private owned-parent IPC channel is required.');
  let closed=false;
  const pending=new Map(),leases=new Set();
  const available=()=>!closed&&channel.connected===true;
  const clearArray=value=>{if(Array.isArray(value)){try{value.fill(0);}catch{}}};
  function reject(record) {
    if(!pending.has(record.requestId))return;
    pending.delete(record.requestId);clearTimeout(record.timer);record.reject(fail());
  }
  function onMessage(input) {
    if(input?.type!=='device-key-result')return;
    const record=pending.get(input.requestId);
    if(!record){clearArray(input.key);return;}
    let key;
    try {
      if(!available())throw fail();
      if(input.ok===false){if(!exact(input,['type','requestId','ok','code'])||input.code!=='DEVICE_KEY_UNAVAILABLE')throw fail();reject(record);return;}
      if(!exact(input,['type','requestId','ok','deviceId','keyId','key'])||input.ok!==true||input.deviceId!==record.deviceId||!uuid(input.keyId)||!Array.isArray(input.key)||input.key.length!==32||Object.keys(input.key).length!==32||!input.key.every(byte=>Number.isSafeInteger(byte)&&byte>=0&&byte<=255))throw fail();
      key=Buffer.from(input.key);
      pending.delete(record.requestId);clearTimeout(record.timer);
      let disposed=false;
      const dispose=()=>{if(disposed)return;disposed=true;clearTimeout(timer);key.fill(0);leases.delete(dispose);};
      const timer=setTimeout(dispose,leaseMs);leases.add(dispose);
      record.resolve(Object.freeze({deviceId:record.deviceId,keyId:input.keyId,key,dispose}));
    } catch {if(key)key.fill(0);reject(record);}
    finally {clearArray(input.key);}
  }
  function close() {
    if(closed)return;closed=true;
    channel.removeListener('message',onMessage);channel.removeListener('disconnect',close);channel.removeListener('exit',close);
    for(const record of pending.values())reject(record);
    for(const dispose of [...leases])dispose();
  }
  async function loadDeviceKey(deviceId) {
    if(!uuid(deviceId)||!available()||pending.size+leases.size>=maxPending)throw fail();
    const requestId=randomUUID();
    return new Promise((resolve,rejectPromise)=>{
      const record={requestId,deviceId,resolve,reject:rejectPromise};pending.set(requestId,record);
      record.timer=setTimeout(()=>reject(record),timeoutMs);
      try {channel.send({type:'device-key-load',requestId,deviceId},error=>{if(error)reject(record);});}
      catch {reject(record);}
    });
  }
  channel.on('message',onMessage);channel.on('disconnect',close);channel.on('exit',close);
  return Object.freeze({loadDeviceKey,close});
}
module.exports={createDeviceKeyClient};
