const {app,safeStorage}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {createDeviceKeyStore}=require('../electron/device-key-store.cjs');
const digest=b=>createHash('sha256').update(b).digest('hex');
let stage='startup';const observed={};
const root=process.env.ONESHOT_KEY_PROBE_ROOT;
if(!root||!path.isAbsolute(root))throw Error('An explicit isolated QA root is required.');
require('node:fs').mkdirSync(path.join(root,'electron-profile'),{mode:0o700,recursive:true});
app.setName('One Shot QA Synthetic Key Store Probe');
app.setPath('userData',path.join(root,'electron-profile'));
app.whenReady().then(async()=>{
 const canonical=await fs.realpath(root),mode=process.env.ONESHOT_KEY_PROBE_MODE;
 const recordFile=path.join(canonical,'public-test-metadata.json');
 const provider={isAsyncEncryptionAvailable:async()=>{stage='availability';return safeStorage.isAsyncEncryptionAvailable();},encryptStringAsync:async value=>{stage='encrypt';let v;try{v=await safeStorage.encryptStringAsync(value);}catch(error){observed.providerErrorName=error.name;observed.providerErrorCode=error.code||null;observed.providerErrorMessage=String(error.message).replaceAll(value,'[SYNTHETIC PLAINTEXT REDACTED]');throw error;}observed.encryptedBuffer=Buffer.isBuffer(v);observed.ciphertextBytes=v?.length;return v;},decryptStringAsync:async value=>{stage='decrypt';const v=await safeStorage.decryptStringAsync(value);observed.decryptedFields=Object.keys(v||{});observed.shouldReEncrypt=v?.shouldReEncrypt;return v;}};
 const store=createDeviceKeyStore({app,safeStorage:provider,rootPath:path.join(canonical,'encrypted-device-credentials')});
 let metadata,key;
 try{
  if(mode==='provision'){
   key=randomBytes(32);metadata={deviceId:randomUUID(),keyId:randomUUID(),sha256:digest(key)};
   const result=await store.provision({version:1,deviceId:metadata.deviceId,keyId:metadata.keyId,key});
   if(!result.created)throw Error('Unexpected existing synthetic credential.');
   await fs.writeFile(recordFile,JSON.stringify(metadata),{mode:0o600,flag:'wx'});
  }else if(mode==='reload')metadata=JSON.parse(await fs.readFile(recordFile,'utf8'));
  else throw Error('Invalid probe mode.');
  const lease=await store.loadDeviceKey(metadata.deviceId);
  try{if(lease.keyId!==metadata.keyId||digest(lease.key)!==metadata.sha256)throw Error('Synthetic key mismatch.');}
  finally{await lease.dispose();}
  const stat=await fs.stat(path.join(canonical,'encrypted-device-credentials',metadata.deviceId+'.key'));
  process.stdout.write(JSON.stringify({passed:true,mode,processType:process.type,asyncEncryptionAvailable:await safeStorage.isAsyncEncryptionAvailable(),credentialRoundTrip:true,keyBufferZeroed:lease.key.every(b=>b===0),encryptedFileMode:stat.mode&0o777,syntheticOnly:true,ownerEnrolled:false,limits:['Unsigned development Electron identity only; no signed release or upgrade continuity proof.','No cloud enrollment, renderer exposure, real account credential or funds.']})+'\n');
 }finally{if(key)key.fill(0);}
 app.quit();
}).catch(error=>{process.stdout.write(JSON.stringify({passed:false,mode:process.env.ONESHOT_KEY_PROBE_MODE,code:error.code||'PROBE_FAILED',stage,observed,syntheticOnly:true,ownerEnrolled:false})+'\n');app.exit(1);});
