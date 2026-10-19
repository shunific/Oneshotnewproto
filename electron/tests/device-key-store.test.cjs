const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { createDeviceKeyStore } = require('../device-key-store.cjs');

// The test provider models OS encryption with authenticated ciphertext; it is not an OS Keychain proof.
function encryptedProvider(overrides = {}) {
  const wrappingKey = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    async encryptStringAsync(text) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    async decryptStringAsync(buffer) {
      const decipher = createDecipheriv('aes-256-gcm', wrappingKey, buffer.subarray(0,12));
      decipher.setAuthTag(buffer.subarray(12,28));
      return { result: Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    },
    ...overrides,
  };
}
async function fixture(t, overrides = {}) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-device-key-test-'));
  // Resolve macOS /var -> /private/var once before supplying the trusted host path.
  const folder = await fs.realpath(created);
  t.after(() => fs.rm(folder,{recursive:true,force:true}));
  const rootPath = path.join(folder,'device-keys');
  const safeStorage = encryptedProvider();
  const options = { app: { isReady: () => true }, safeStorage, rootPath, platform: process.platform, processType: 'browser', ...overrides };
  const store = createDeviceKeyStore(options);
  const input = { version:1, deviceId:randomUUID(), keyId:randomUUID(), key:randomBytes(32) };
  const filename = path.join(rootPath,`${input.deviceId}.key`);
  return { folder, rootPath, safeStorage, options, store, input, filename };
}
const rejected = (promise, code = 'DEVICE_KEY_UNAVAILABLE') => assert.rejects(promise,error => error.code === code && !error.message.includes('private-secret'));

test('provisioning encrypts private credential and independent disposable loads do not share key buffers',async t=>{
  const f=await fixture(t);
  const original=Buffer.from(f.input.key);
  const saved=await f.store.provision(f.input);
  assert.deepEqual(saved,{version:1,deviceId:f.input.deviceId,keyId:f.input.keyId,created:true});
  assert.deepEqual(f.input.key,original,'provision never destroys owner-provided key');
  const bytes=await fs.readFile(f.filename);
  assert.equal(bytes.includes(original),false);assert.equal(bytes.includes(Buffer.from(original.toString('base64'))),false);
  assert.equal(bytes.includes(Buffer.from(f.input.deviceId)),false);
  if(process.platform!=='win32'){
    assert.equal((await fs.stat(f.rootPath)).mode&0o777,0o700);
    assert.equal((await fs.stat(f.filename)).mode&0o777,0o600);
  }
  const first=await f.store.loadDeviceKey(f.input.deviceId),second=await f.store.loadDeviceKey(f.input.deviceId);
  assert.equal(first.deviceId,f.input.deviceId);assert.equal(first.keyId,f.input.keyId);
  assert.deepEqual(first.key,original);assert.deepEqual(second.key,original);assert.notEqual(first.key,second.key);
  first.dispose();first.dispose();assert.deepEqual(first.key,Buffer.alloc(32));assert.deepEqual(second.key,original);
  second.dispose();const fresh=await f.store.loadDeviceKey(f.input.deviceId);assert.deepEqual(fresh.key,original);fresh.dispose();
  assert.deepEqual(await fs.readdir(f.rootPath),[`${f.input.deviceId}.key`]);
});

test('exact credential replay is idempotent and conflicting enrollment cannot overwrite prior ciphertext',async t=>{
  const f=await fixture(t);await f.store.provision(f.input);const before=await fs.readFile(f.filename);
  assert.equal((await f.store.provision({...f.input,key:Buffer.from(f.input.key)})).created,false);
  await rejected(f.store.provision({...f.input,key:randomBytes(32)}),'DEVICE_KEY_CONFLICT');
  await rejected(f.store.provision({...f.input,keyId:randomUUID()}),'DEVICE_KEY_CONFLICT');
  assert.deepEqual(await fs.readFile(f.filename),before);
  const loaded=await f.store.loadDeviceKey(f.input.deviceId);assert.deepEqual(loaded.key,f.input.key);loaded.dispose();
});

test('concurrent exact enrollment across independent store factories publishes one complete credential',async t=>{
  const f=await fixture(t);const other=createDeviceKeyStore(f.options);
  const outcomes=await Promise.all([f.store.provision(f.input),other.provision(f.input)]);
  assert.deepEqual(outcomes.map(value=>value.created).sort(),[false,true]);
  const loaded=await other.loadDeviceKey(f.input.deviceId);assert.deepEqual(loaded.key,f.input.key);loaded.dispose();
  assert.deepEqual(await fs.readdir(f.rootPath),[`${f.input.deviceId}.key`]);
});

test('concurrent conflicting enrollment never overwrites the winning credential',async t=>{
  const f=await fixture(t);const other=createDeviceKeyStore(f.options);const alternative={...f.input,keyId:randomUUID(),key:randomBytes(32)};
  const outcomes=await Promise.allSettled([f.store.provision(f.input),other.provision(alternative)]);
  assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);
  assert.equal(outcomes.find(value=>value.status==='rejected').reason.code,'DEVICE_KEY_CONFLICT');
  const expected=outcomes[0].status==='fulfilled'?f.input:alternative;
  const loaded=await f.store.loadDeviceKey(f.input.deviceId);assert.equal(loaded.keyId,expected.keyId);assert.deepEqual(loaded.key,expected.key);loaded.dispose();
  assert.deepEqual(await fs.readdir(f.rootPath),[`${f.input.deviceId}.key`]);
});

test('not-ready, renderer, unavailable encryption and Linux fallback providers fail before filesystem provisioning',async t=>{
  const f=await fixture(t);
  const variants=[{app:{isReady:()=>false}},{processType:'renderer'},{platform:'unsupported'},
    {platform:'linux',safeStorage:encryptedProvider({isEncryptionAvailable:()=>false})},
    {safeStorage:encryptedProvider({isAsyncEncryptionAvailable:async()=>false})},
    {safeStorage:encryptedProvider({encryptStringAsync:undefined})},
    {platform:'linux',safeStorage:encryptedProvider({getSelectedStorageBackend:()=> 'basic_text'})},
    {platform:'linux',safeStorage:encryptedProvider({getSelectedStorageBackend:()=> 'unknown'})}];
  for(const variant of variants){
    const store=createDeviceKeyStore({...f.options,...variant});
    await rejected(store.provision(f.input));await rejected(store.loadDeviceKey(f.input.deviceId));
  }
  assert.deepEqual(await fs.readdir(f.folder),[]);
});

test('strict input validation rejects malformed versions, UUID paths and non-32-byte keys',async t=>{
  const f=await fixture(t);
  for(const patch of [{version:'1'},{version:2},{deviceId:'../private-secret'},{deviceId:'x'},{deviceId:f.input.deviceId.toUpperCase()},{keyId:'../other'},{key:randomBytes(31)},{key:randomBytes(33)},{key:f.input.key.toString('base64')},{extra:true}]) await rejected(f.store.provision({...f.input,...patch}),'DEVICE_KEY_INVALID');
  for(const id of ['../private-secret','',null,`${f.input.deviceId}/../key`]) await rejected(f.store.loadDeviceKey(id),'DEVICE_KEY_INVALID');
  assert.deepEqual(await fs.readdir(f.folder),[]);
});

test('symlinked credential or root directory is rejected without modifying the referenced file',async t=>{
  const f=await fixture(t);await fs.mkdir(f.rootPath,{mode:0o700});
  const outside=path.join(f.folder,'outside-key');await fs.writeFile(outside,'private-secret-do-not-touch',{mode:0o600});
  await fs.symlink(outside,f.filename);
  await rejected(f.store.loadDeviceKey(f.input.deviceId));await rejected(f.store.provision(f.input));
  assert.equal(await fs.readFile(outside,'utf8'),'private-secret-do-not-touch');
  await fs.unlink(f.filename);await fs.rmdir(f.rootPath);await fs.symlink(f.folder,f.rootPath);
  await rejected(f.store.loadDeviceKey(f.input.deviceId));await rejected(f.store.provision(f.input));
  assert.equal(await fs.readFile(outside,'utf8'),'private-secret-do-not-touch');
});

test('symlinked ancestor directories cannot redirect a host store path',async t=>{
  const f=await fixture(t);const parentAlias=path.join(f.folder,'alias');await fs.symlink(f.folder,parentAlias);
  const store=createDeviceKeyStore({...f.options,rootPath:path.join(parentAlias,'redirected-keys')});
  await rejected(store.provision(f.input));
  assert.equal((await fs.readdir(f.folder)).includes('redirected-keys'),false);
});

test('insecure Unix permissions and oversized ciphertext fail closed',async t=>{
  if(process.platform==='win32'){t.skip('Unix permission enforcement is not a Windows ACL proof.');return;}
  const f=await fixture(t);await f.store.provision(f.input);
  await fs.chmod(f.filename,0o644);await rejected(f.store.loadDeviceKey(f.input.deviceId));await rejected(f.store.provision(f.input));
  await fs.chmod(f.filename,0o600);await fs.chmod(f.rootPath,0o755);await rejected(f.store.loadDeviceKey(f.input.deviceId));
  await fs.chmod(f.rootPath,0o700);await fs.writeFile(f.filename,Buffer.alloc(16385),{mode:0o600});
  await rejected(f.store.loadDeviceKey(f.input.deviceId));
});

test('malformed encrypted records and decryption failures never return credentials or leak details',async t=>{
  const f=await fixture(t);await f.store.provision(f.input);
  const original=await fs.readFile(f.filename);
  const valid={version:1,deviceId:f.input.deviceId,keyId:f.input.keyId,key:f.input.key.toString('base64')};
  for(const record of [{...valid,version:2},{...valid,deviceId:randomUUID()},{...valid,keyId:'bad'},{...valid,key:randomBytes(31).toString('base64')},{...valid,key:'?'.repeat(44)},{...valid,extra:true},null]){
    const encrypted=await f.safeStorage.encryptStringAsync(JSON.stringify(record));await fs.writeFile(f.filename,encrypted);
    await rejected(f.store.loadDeviceKey(f.input.deviceId));await rejected(f.store.provision(f.input));
    assert.deepEqual(await fs.readFile(f.filename),encrypted,'invalid existing record is never overwritten');
  }
  await fs.writeFile(f.filename,original);
  const failing=createDeviceKeyStore({...f.options,safeStorage:encryptedProvider({decryptStringAsync:async()=>{throw new Error('private-secret-keychain-details');}})});
  await rejected(failing.loadDeviceKey(f.input.deviceId));
  assert.deepEqual(await fs.readFile(f.filename),original);
});

test('temporary unavailability, invalid async responses and key rotation fail closed without plaintext fallback',async t=>{
  const f=await fixture(t);await f.store.provision(f.input);const original=await fs.readFile(f.filename);
  for(const output of [{result:'private-secret',shouldReEncrypt:true},{result:'private-secret'},'private-secret',{result:'private-secret',shouldReEncrypt:false,extra:true}]){
    const store=createDeviceKeyStore({...f.options,safeStorage:encryptedProvider({decryptStringAsync:async()=>output})});
    await rejected(store.loadDeviceKey(f.input.deviceId),output?.shouldReEncrypt===true?'DEVICE_KEY_REENCRYPT_REQUIRED':'DEVICE_KEY_UNAVAILABLE');
  }
  const unavailable=createDeviceKeyStore({...f.options,safeStorage:encryptedProvider({isAsyncEncryptionAvailable:async()=>{throw new Error('private-secret-details');}})});
  await rejected(unavailable.loadDeviceKey(f.input.deviceId));assert.deepEqual(await fs.readFile(f.filename),original);
});

test('publication failure removes temporary ciphertext and permits a later safe retry',async t=>{
  const f=await fixture(t);
  const failing=createDeviceKeyStore({...f.options,fs:{...fs,link:async()=>{throw new Error('private-secret-filesystem-details');}}});
  await rejected(failing.provision(f.input));assert.deepEqual(await fs.readdir(f.rootPath),[]);
  assert.equal((await f.store.provision(f.input)).created,true);
});

test('failed encryption round-trip cannot publish a corrupt credential',async t=>{
  const f=await fixture(t);
  const broken=encryptedProvider({encryptStringAsync:async()=>Buffer.from('private-secret-not-ciphertext'),decryptStringAsync:async()=>{throw new Error('private-secret-details');}});
  await rejected(createDeviceKeyStore({...f.options,safeStorage:broken}).provision(f.input));
  assert.deepEqual(await fs.readdir(f.rootPath),[]);
});


test('file replacement during OS decryption fails closed and does not return a stale key',async t=>{
  const f=await fixture(t);await f.store.provision(f.input);
  const provider={...f.safeStorage,decryptStringAsync:async ciphertext=>{
    const value=await f.safeStorage.decryptStringAsync(ciphertext);
    await fs.rename(f.filename,`${f.filename}.old`);
    await fs.writeFile(f.filename,Buffer.from('replaced-credential'),{mode:0o600});
    return value;
  }};
  await rejected(createDeviceKeyStore({...f.options,safeStorage:provider}).loadDeviceKey(f.input.deviceId));
});

test('short filesystem reads are assembled within the ciphertext size bound',async t=>{
  const f=await fixture(t);await f.store.provision(f.input);
  const shortReads={...fs,open:async(...args)=>{
    const handle=await fs.open(...args);
    return new Proxy(handle,{get(target,key){
      if(key==='read')return(buffer,offset,length,position)=>target.read(buffer,offset,Math.min(length,7),position);
      const value=target[key];return typeof value==='function'?value.bind(target):value;
    }});
  }};
  const loaded=await createDeviceKeyStore({...f.options,fs:shortReads}).loadDeviceKey(f.input.deviceId);
  assert.deepEqual(loaded.key,f.input.key);loaded.dispose();
});


test('macOS asynchronous availability does not depend on the unrelated synchronous provider',async t=>{
  const f=await fixture(t,{platform:'darwin',safeStorage:encryptedProvider({isEncryptionAvailable:()=>false})});
  assert.equal((await f.store.provision(f.input)).created,true);
  const loaded=await f.store.loadDeviceKey(f.input.deviceId);assert.deepEqual(loaded.key,f.input.key);loaded.dispose();
});
