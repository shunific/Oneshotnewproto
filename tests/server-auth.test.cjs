const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const sqlite3 = require('sqlite3');
const { registerAuthRoutes, hashSecret } = require('../server-auth.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const exec = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, error => error ? reject(error) : resolve()));
const read = (db, id) => new Promise((resolve, reject) => db.get('SELECT * FROM staff WHERE id = ?', [id], (error, row) => error ? reject(error) : resolve(row)));
async function fixture(t, seed = true, options = {}) {
  const db = new sqlite3.Database(':memory:');
  await exec(db, 'CREATE TABLE staff (id TEXT PRIMARY KEY, username TEXT, password TEXT, fullName TEXT, role TEXT, phone TEXT, joinedDate TEXT, avatarImg TEXT, isActive INTEGER, isAdmin INTEGER, recoveryPin TEXT, isFirstLogin INTEGER)');
  if (seed) {
    for (const [id, username, password, admin, first] of [['root', 'administrator', 'safe-password', 1, 0], ['cashier', 'cashier', 'cashier-secret', 0, 0], ['newstaff', 'newstaff', 'temporary-password', 0, 1]]) await exec(db, 'INSERT INTO staff VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)', [id, username, sha(password), username, 'cashier', '', '', '', admin, await hashSecret('1234'), first]);
  }
  const app = express(); app.use(express.json());
  const auth = registerAuthRoutes(app, db, options); await auth.ready;
  app.get('/protected', auth.requireAuth, (req, res) => res.json({ id: req.staff.id }));
  app.get('/admin', auth.requireAdmin, (req, res) => res.json({ success: true }));
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { auth.close(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => db.close(resolve)); });
  const call = async (path, method = 'GET', body, cookie) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], cookieHeader: response.headers.get('set-cookie') };
  };
  const login = (username, password) => call('/api/auth/login', 'POST', { username, password });
  return { db, call, login, auth };
}

test('login migrates legacy digests, issues private cookies, enforces server roles and logout', async t => {
  const { db, call, login } = await fixture(t);
  assert.equal((await call('/protected')).status, 401);
  assert.equal((await login('cashier', sha('cashier-secret'))).status, 401);
  const cashier = await login(' CASHIER ', 'cashier-secret');
  assert.equal(cashier.status, 200);
  assert.match(cashier.cookieHeader, /HttpOnly; SameSite=Strict/);
  assert.match((await read(db, 'cashier')).password, /^scrypt\$/);
  assert.equal(cashier.body.user.password, undefined);
  assert.equal(cashier.body.user.recoveryPin, undefined);
  assert.equal((await call('/protected', 'GET', undefined, cashier.cookie)).status, 200);
  assert.equal((await call('/admin', 'GET', undefined, cashier.cookie)).status, 403);
  const users = await call('/api/staff', 'GET', undefined, cashier.cookie);
  assert.equal(users.body.length, 1);
  assert.equal(users.body[0].password, undefined);
  assert.equal(users.body[0].recoveryPin, undefined);
  assert.equal((await call('/api/staff/root', 'PUT', { isAdmin: true }, cashier.cookie)).status, 403);
  assert.equal((await call('/api/staff/cashier', 'PUT', { isAdmin: true }, cashier.cookie)).status, 400);
  assert.equal((await call('/api/staff/cashier', 'PUT', { fullName: 'Updated cashier' }, cashier.cookie)).status, 200);
  assert.equal((await call('/api/auth/logout', 'POST', {}, cashier.cookie)).status, 200);
  assert.equal((await call('/protected', 'GET', undefined, cashier.cookie)).status, 401);
});

test('first-login session cannot perform work until password and PIN setup commits', async t => {
  const { db, call, login } = await fixture(t);
  const setup = await login('newstaff', 'temporary-password');
  assert.equal(setup.body.requiresPasswordChange, true);
  assert.equal((await call('/protected', 'GET', undefined, setup.cookie)).status, 403);
  assert.equal((await call('/api/staff', 'GET', undefined, setup.cookie)).status, 403);
  assert.equal((await call('/api/auth/me', 'GET', undefined, setup.cookie)).status, 200);
  assert.equal((await call('/api/auth/change-password', 'POST', { currentPassword: 'temporary-password', newPassword: 'new-safe-password9', recoveryPin: '456789' }, setup.cookie)).status, 403);
  assert.equal((await call('/api/auth/setup', 'POST', { currentPassword: 'wrong', newPassword: 'new-safe-password9' }, setup.cookie)).status, 401);
  const issued = await call('/api/auth/setup', 'POST', { currentPassword: 'temporary-password', newPassword: 'new-safe-password9' }, setup.cookie);
  assert.equal(issued.status, 200); assert.match(issued.body.recoveryPin, /^\d{4}$/);
  assert.equal((await call('/protected', 'GET', undefined, issued.cookie)).status, 403);
  const changed = await call('/api/auth/acknowledge-pin', 'POST', { acknowledged: true }, issued.cookie);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.requiresPasswordChange, false);
  assert.equal((await call('/protected', 'GET', undefined, setup.cookie)).status, 401);
  assert.equal((await call('/protected', 'GET', undefined, changed.cookie)).status, 200);
  const stored = await read(db, 'newstaff');
  assert.match(stored.password, /^scrypt\$/); assert.match(stored.recoveryPin, /^scrypt\$/);
  assert.equal((await login('newstaff', 'new-safe-password9')).status, 200);
});

test('recovery is throttled durably, hashes PIN and revokes existing sessions', async t => {
  const { db, call, login } = await fixture(t);
  const cashier = await login('cashier', 'cashier-secret');
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/auth/recover', 'POST', { username: 'cashier', recoveryPin: '9999', newPassword: 'safe-recovered-password9' })).status, 401);
  assert.equal((await call('/api/auth/recover', 'POST', { username: 'cashier', recoveryPin: '1234', newPassword: 'safe-recovered-password9' })).status, 429);
  const attempts = await new Promise((resolve, reject) => db.get('SELECT attempts FROM auth_attempts WHERE key = ?', [`recover:user:${sha('cashier')}`], (e, r) => e ? reject(e) : resolve(r)));
  assert.equal(attempts.attempts, 5);
  await exec(db, 'UPDATE auth_attempts SET expires = 0');
  assert.equal((await call('/api/auth/recover', 'POST', { username: 'cashier', recoveryPin: '1234', newPassword: 'safe-recovered-password9' })).status, 200);
  assert.equal((await call('/protected', 'GET', undefined, cashier.cookie)).status, 401);
  assert.match((await read(db, 'cashier')).recoveryPin, /^scrypt\$/);
  assert.equal((await login('cashier', 'cashier-secret')).status, 401);
  assert.equal((await login('cashier', 'safe-recovered-password9')).status, 200);
});

test('admin creates restricted staff, rejects injected fields and safely resets credentials', async t => {
  const { db, call, login } = await fixture(t);
  const admin = await login('administrator', 'safe-password');
  const body = { id: 'newcashier', username: 'newcashier', fullName: 'QA cashier', password: 'new-temporary-password9', role: 'cashier', isFirstLogin: false, recoveryPin: '0000' };
  assert.equal((await call('/api/staff', 'POST', body)).status, 401);
  const created = await call('/api/staff', 'POST', body, admin.cookie);
  assert.equal(created.status, 201);
  const stored = await read(db, 'newcashier');
  assert.match(stored.password, /^scrypt\$/); assert.equal(stored.isFirstLogin, 1); assert.equal(stored.recoveryPin, '');
  assert.equal((await call('/api/staff', 'POST', { ...body, id: 'another', username: 'NEWCASHIER' }, admin.cookie)).status, 409);
  assert.equal((await call('/api/staff/newcashier', 'PUT', { 'password = NULL; --': 'x' }, admin.cookie)).status, 400);
  assert.equal((await call('/api/staff/newcashier', 'PUT', { password: sha('backdoor') }, admin.cookie)).status, 400);
  assert.equal((await call('/api/staff/root', 'PUT', { isAdmin: false }, admin.cookie)).status, 403);
  assert.equal((await call('/api/staff/newcashier/reset-password', 'POST', { newPassword: 'replacement-password9' }, admin.cookie)).status, 200);
  assert.equal((await login('newcashier', 'new-temporary-password9')).status, 401);
  assert.equal((await login('newcashier', 'replacement-password9')).body.requiresPasswordChange, true);
  const listing = await call('/api/staff', 'GET', undefined, admin.cookie);
  assert.equal(listing.body.length, 4);
  assert.ok(listing.body.every(row => row.password === undefined && row.recoveryPin === undefined));
});

test('first-install bootstrap works exactly once and old default root must change password', async t => {
  const { db, call, login } = await fixture(t, false);
  assert.equal((await call('/api/auth/bootstrap')).body.required, true);
  const body = { username: 'owner', fullName: 'QA owner', password: 'safe-owner-password9', recoveryPin: '123456' };
  assert.equal((await call('/api/auth/bootstrap', 'POST', body)).status, 201);
  assert.equal((await call('/api/auth/bootstrap', 'POST', body)).status, 409);
  assert.equal((await call('/api/auth/bootstrap')).body.required, false);
  assert.equal((await login('owner', 'safe-owner-password9')).body.requiresPasswordChange, false);
  await exec(db, 'UPDATE staff SET username = ?, password = ?, isFirstLogin = 0 WHERE id = ?', ['superadmin', sha('admin123'), 'admin_001']);
  const legacy = await login('superadmin', 'admin123');
  assert.equal(legacy.body.requiresPasswordChange, true);
  assert.equal((await call('/admin', 'GET', undefined, legacy.cookie)).status, 403);
});

test('password changes invalidate other sessions and account deactivation is enforced immediately', async t => {
  const { db, call, login } = await fixture(t);
  const first = await login('cashier', 'cashier-secret');
  const second = await login('cashier', 'cashier-secret');
  assert.equal((await call('/api/auth/verify', 'POST', { password: 'wrong' }, first.cookie)).status, 401);
  assert.equal((await call('/api/auth/verify', 'POST', { password: 'cashier-secret' }, first.cookie)).status, 200);
  const changed = await call('/api/auth/change-password', 'POST', { currentPassword: 'cashier-secret', newPassword: 'another-safe-password9' }, first.cookie);
  assert.equal(changed.status, 200);
  assert.equal((await call('/protected', 'GET', undefined, second.cookie)).status, 401);
  await exec(db, 'UPDATE staff SET isActive = 0 WHERE id = ?', ['cashier']);
  assert.equal((await call('/protected', 'GET', undefined, changed.cookie)).status, 401);
  assert.equal((await login('cashier', 'another-safe-password9')).status, 401);
});

for (const [reason, revoke] of [
  ['account deactivation', "UPDATE staff SET isActive = 0 WHERE id = 'cashier'"],
  ['credential replacement', "UPDATE staff SET password = 'revoked-test-credential' WHERE id = 'cashier'"],
]) {
  test(`a delayed request after ${reason} cannot erase a newer login cookie`, async t => {
    const { db, call, login, auth } = await fixture(t);
    const old = await login('cashier', 'cashier-secret');
    const originalGet = db.get.bind(db);
    let releaseRead;
    let enteredRead;
    const entered = new Promise(resolve => { enteredRead = resolve; });
    let armed = true;
    db.get = function (sql, args, callback) {
      if (armed && sql === 'SELECT * FROM staff WHERE id = ?' && args[0] === 'cashier') {
        armed = false;
        releaseRead = () => originalGet(sql, args, callback);
        enteredRead();
        return db;
      }
      return originalGet(sql, args, callback);
    };
    t.after(() => { db.get = originalGet; });
    const delayed = call('/api/auth/me', 'GET', undefined, old.cookie);
    await entered;
    await exec(db, revoke);
    const newer = await login('administrator', 'safe-password');
    assert.equal(newer.status, 200);
    let browserCookie = newer.cookie;
    releaseRead();
    const rejected = await delayed;
    assert.equal(rejected.status, 401);
    assert.equal(rejected.cookieHeader, null, 'A readonly rejection must not clear the newer browser cookie');
    if (rejected.cookie) browserCookie = rejected.cookie;
    assert.equal(browserCookie, newer.cookie);
    assert.equal(await auth.isSessionActive(old.cookie.split('=')[1]), false);
    assert.deepEqual((await call('/protected', 'GET', undefined, browserCookie)).body, { id: 'root' });
    const signedOut = await call('/api/auth/logout', 'POST', {}, browserCookie);
    assert.match(signedOut.cookieHeader, /Max-Age=0/);
    assert.equal((await call('/protected', 'GET', undefined, browserCookie)).status, 401);
  });
}

test('a delayed public recovery revokes its target without clearing a newer unrelated login cookie', async t => {
  const { db, call, login, auth } = await fixture(t);
  const old = await login('cashier', 'cashier-secret');
  const originalRun = db.run.bind(db);
  let enteredRecovery;
  let releaseRecovery;
  const entered = new Promise(resolve => { enteredRecovery = resolve; });
  let armed = true;
  db.run = function (sql, args, callback) {
    if (armed && sql === 'DELETE FROM auth_attempts WHERE key = ?' && args[0] === `recover:user:${sha('cashier')}`) {
      armed = false;
      releaseRecovery = () => originalRun(sql, args, callback);
      enteredRecovery();
      return db;
    }
    return originalRun(sql, args, callback);
  };
  t.after(() => { db.run = originalRun; });
  const recovering = call('/api/auth/recover', 'POST', { username: 'cashier', recoveryPin: '1234', newPassword: 'safe-recovered-test-password9' }, old.cookie);
  await entered;
  assert.equal(await auth.isSessionActive(old.cookie.split('=')[1]), false);
  let newer;
  try { newer = await login('administrator', 'safe-password'); }
  finally { releaseRecovery(); }
  const recovered = await recovering;
  assert.equal(newer.status, 200);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.cookieHeader, null, 'Public recovery must not mutate an unrelated browser cookie');
  const browserCookie = recovered.cookie || newer.cookie;
  assert.equal(browserCookie, newer.cookie);
  assert.deepEqual((await call('/protected', 'GET', undefined, browserCookie)).body, { id: 'root' });
  assert.equal((await call('/protected', 'GET', undefined, old.cookie)).status, 401);
  assert.equal((await login('cashier', 'safe-recovered-test-password9')).status, 200);
});

test('concurrent recovery guesses cannot exceed durable account limit', async t => {
  const { call } = await fixture(t);
  const attempts = await Promise.all(Array.from({ length: 12 }, () => call('/api/auth/recover', 'POST', { username: 'cashier', recoveryPin: '9999', newPassword: 'safe-recovered-password9' })));
  assert.equal(attempts.filter(result => result.status === 401).length, 5);
  assert.equal(attempts.filter(result => result.status === 429).length, 7);
});

test('sensitive username update rechecks password and cannot collide with another account', async t => {
  const { call, login } = await fixture(t);
  const cashier = await login('cashier', 'cashier-secret');
  assert.equal((await call('/api/auth/status')).body.needsBootstrap, false);
  assert.equal((await call('/api/auth/change-username', 'POST', { username: 'newcashier', currentPassword: 'wrong' }, cashier.cookie)).status, 401);
  assert.equal((await call('/api/auth/change-username', 'POST', { username: 'administrator', currentPassword: 'cashier-secret' }, cashier.cookie)).status, 409);
  const saved = await call('/api/auth/change-username', 'POST', { username: 'renamed-cashier', currentPassword: 'cashier-secret' }, cashier.cookie);
  assert.equal(saved.status, 200); assert.equal(saved.body.user.username, 'renamed-cashier');
  assert.equal((await login('renamed-cashier', 'cashier-secret')).status, 200);
});


test('previously disclosed plaintext PIN cannot recover and requires authenticated credential rotation', async t => {
  const { db, call, login } = await fixture(t);
  await exec(db, 'UPDATE staff SET recoveryPin = ? WHERE id = ?', ['1234', 'cashier']);
  assert.equal((await call('/api/auth/recover', 'POST', { username: 'cashier', recoveryPin: '1234', newPassword: 'attacker-password9' })).status, 401);
  const old = await login('cashier', 'cashier-secret');
  assert.equal(old.body.requiresPasswordChange, true);
  assert.equal(old.body.user.recoveryPinSet, false);
  assert.equal((await call('/protected', 'GET', undefined, old.cookie)).status, 403);
  const issued = await call('/api/auth/setup', 'POST', { currentPassword: 'cashier-secret', newPassword: 'rotated-safe-password9' }, old.cookie);
  assert.equal(issued.status, 200);
  const changed = await call('/api/auth/acknowledge-pin', 'POST', { acknowledged: true }, issued.cookie);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.user.recoveryPinSet, true);
  assert.equal((await call('/protected', 'GET', undefined, changed.cookie)).status, 200);
  assert.equal((await call('/api/auth/recover', 'POST', { username: 'cashier', recoveryPin: '1234', newPassword: 'attacker-password9' })).status, 401);
  assert.equal((await call('/api/auth/recover', 'POST', { username: 'cashier', recoveryPin: issued.body.recoveryPin, newPassword: 'recovered-safe-password9' })).status, 200);
});

 test('local session invalidation notifies cloud cleanup and rechecks current database credentials', async t => {
  const ended=[];const {db,auth,login,call}=await fixture(t,true,{onSessionEnd:token=>ended.push(token)});
  const signed=await login('cashier','cashier-secret');const token=signed.cookie.split('=')[1];
  assert.equal(await auth.isSessionActive(token),true);
  await exec(db,"UPDATE staff SET isActive=0 WHERE id='cashier'");
  assert.equal(await auth.isSessionActive(token),false);assert.deepEqual(ended,[token]);
  await call('/api/auth/logout','POST',{},signed.cookie);assert.deepEqual(ended,[token]);
 });
 test('ordinary local logout invokes cloud cleanup for exactly that session',async t=>{
  const ended=[];const {auth,login,call}=await fixture(t,true,{onSessionEnd:token=>ended.push(token)});
  const one=await login('cashier','cashier-secret'),two=await login('administrator','safe-password');
  await call('/api/auth/logout','POST',{},one.cookie);
  assert.deepEqual(ended,[one.cookie.split('=')[1]]);assert.equal(await auth.isSessionActive(two.cookie.split('=')[1]),true);
 });

test('private native actor resolution rechecks logout after its account read', async t => {
 const f=await fixture(t),login=await f.login('cashier','cashier-secret'),token=login.cookie.split('=')[1];
 assert.deepEqual(await f.auth.resolveSessionActor(token),{localStaffId:'cashier'});
 assert.equal(f.auth.isSessionCurrent(token,'cashier'),true);assert.equal(f.auth.isSessionCurrent(token,'root'),false);
 const get=f.db.get.bind(f.db);let release,entered;const seen=new Promise(resolve=>entered=resolve);
 f.db.get=(sql,args,callback)=>get(sql,args,(error,row)=>{
  if(sql==='SELECT * FROM staff WHERE id = ?'){entered();release=()=>callback(error,row);}
  else callback(error,row);
 });
 const pending=f.auth.resolveSessionActor(token);await seen;f.auth.invalidate('cashier');release();
 assert.equal(await pending,null);assert.equal(f.auth.isSessionCurrent(token,'cashier'),false);
 f.db.get=get;
});
test('private actor resolution excludes first-login, expired and deactivated sessions',async t=>{
 let time=0;const f=await fixture(t,true,{now:()=>time,sessionLifetime:1000});
 const setup=await f.login('newstaff','temporary-password');assert.equal(await f.auth.resolveSessionActor(setup.cookie.split('=')[1]),null);
 const signed=await f.login('cashier','cashier-secret'),token=signed.cookie.split('=')[1];time=1001;
 assert.equal(await f.auth.resolveSessionActor(token),null);assert.equal(f.auth.isSessionCurrent(token,'cashier'),false);
 time=0;const again=await f.login('cashier','cashier-secret'),next=again.cookie.split('=')[1];await exec(f.db,'UPDATE staff SET isActive=0 WHERE id=?',['cashier']);
 assert.equal(await f.auth.resolveSessionActor(next),null);assert.equal(f.auth.isSessionCurrent(next,'cashier'),false);
});

test('generated PIN setup stays restricted until explicit acknowledgement and never discloses the stored secret again', async t => {
 const {db,call,login}=await fixture(t);const initial=await login('newstaff','temporary-password');
 assert.equal((await call('/api/auth/acknowledge-pin','POST',{acknowledged:true},initial.cookie)).status,409);
 const issued=await call('/api/auth/setup','POST',{currentPassword:'temporary-password',newPassword:'qa-replacement-password9'},initial.cookie);
 assert.equal(issued.status,200);assert.deepEqual(Object.keys(issued.body).sort(),['recoveryPin','requiresPinBackup']);assert.match(issued.body.recoveryPin,/^\d{4}$/);
 const stored=await read(db,'newstaff');assert.equal(stored.isFirstLogin,1);assert.match(stored.recoveryPin,/^scrypt\$/);assert.notEqual(stored.recoveryPin,issued.body.recoveryPin);
 const me=await call('/api/auth/me','GET',undefined,issued.cookie);assert.equal(me.body.requiresPasswordChange,true);assert.equal(me.body.user.recoveryPin,undefined);
 assert.equal((await call('/protected','GET',undefined,issued.cookie)).status,403);
 assert.equal((await call('/api/auth/acknowledge-pin','POST',{acknowledged:false},issued.cookie)).status,400);
 const complete=await call('/api/auth/acknowledge-pin','POST',{acknowledged:true},issued.cookie);assert.equal(complete.status,200);assert.equal(complete.body.requiresPasswordChange,false);assert.equal(complete.body.recoveryPin,undefined);
 assert.equal((await call('/protected','GET',undefined,issued.cookie)).status,401);assert.equal((await call('/protected','GET',undefined,complete.cookie)).status,200);
 assert.equal((await call('/api/auth/setup','POST',{currentPassword:'qa-replacement-password9',newPassword:'other-qa-password9'},complete.cookie)).status,409);
});
test('lost setup reply cannot mark backup complete; new-password login remains restricted and can issue a replacement',async t=>{
 const {call,login}=await fixture(t);const initial=await login('newstaff','temporary-password');
 const lost=await call('/api/auth/setup','POST',{currentPassword:'temporary-password',newPassword:'qa-first-new-password9'},initial.cookie);assert.equal(lost.status,200);
 // Simulate losing both the response body and replacement cookie at the client.
 assert.equal((await call('/api/auth/me','GET',undefined,initial.cookie)).status,401);
 const retry=await login('newstaff','qa-first-new-password9');assert.equal(retry.body.requiresPasswordChange,true);assert.equal((await call('/api/auth/acknowledge-pin','POST',{acknowledged:true},retry.cookie)).status,409);
 const next=await call('/api/auth/setup','POST',{currentPassword:'qa-first-new-password9',newPassword:'qa-second-new-password9'},retry.cookie);assert.equal(next.status,200);assert.match(next.body.recoveryPin,/^\d{4}$/);
 const done=await call('/api/auth/acknowledge-pin','POST',{acknowledged:true},next.cookie);assert.equal(done.status,200);
 // A lost acknowledgement response is safely recovered through normal sign-in.
 const signed=await login('newstaff','qa-second-new-password9');assert.equal(signed.body.requiresPasswordChange,false);
 assert.equal((await call('/api/auth/recover','POST',{username:'newstaff',recoveryPin:next.body.recoveryPin,newPassword:'qa-recovered-password9'})).status,200);
});
test('first-login generated setup refuses supplied PINs and concurrent duplicate password changes',async t=>{
 const {call,login}=await fixture(t);const signed=await login('newstaff','temporary-password');
 assert.equal((await call('/api/auth/setup','POST',{currentPassword:'temporary-password',newPassword:'qa-unique-password9',recoveryPin:'1234'},signed.cookie)).status,400);
 const results=await Promise.all([0,1].map(()=>call('/api/auth/setup','POST',{currentPassword:'temporary-password',newPassword:'qa-unique-password9'},signed.cookie)));
 assert.equal(results.filter(r=>r.status===200).length,1);assert.ok(results.every(r=>[200,401,409].includes(r.status)));
 const issued=results.find(r=>r.status===200);const acknowledgements=await Promise.all([0,1].map(()=>call('/api/auth/acknowledge-pin','POST',{acknowledged:true},issued.cookie)));assert.equal(acknowledgements.filter(r=>r.status===200).length,1);
});

test('transient PIN acknowledgement write failure permits original-session retry without generating a replacement PIN',async t=>{
 const {db,call,login}=await fixture(t);const initial=await login('newstaff','temporary-password');
 const issued=await call('/api/auth/setup','POST',{currentPassword:'temporary-password',newPassword:'qa-retry-new-password9'},initial.cookie);assert.equal(issued.status,200);const before=await read(db,'newstaff');
 const originalRun=db.run.bind(db);let armed=true;
 db.run=function(sql,args,callback){if(armed&&sql.startsWith('UPDATE staff SET isFirstLogin = 0 WHERE')){armed=false;queueMicrotask(()=>callback(Object.assign(new Error('synthetic busy'),{code:'SQLITE_BUSY'})));return db;}return originalRun(sql,args,callback);};
 const failed=await call('/api/auth/acknowledge-pin','POST',{acknowledged:true},issued.cookie);assert.equal(failed.status,503);assert.equal((await call('/protected','GET',undefined,issued.cookie)).status,403);
 const retry=await call('/api/auth/acknowledge-pin','POST',{acknowledged:true},issued.cookie);assert.equal(retry.status,200);assert.equal((await call('/protected','GET',undefined,retry.cookie)).status,200);
 const after=await read(db,'newstaff');assert.equal(after.password,before.password);assert.equal(after.recoveryPin,before.recoveryPin);assert.equal(after.isFirstLogin,0);
});
test('failed PIN acknowledgement cannot restore eligibility to a revoked session',async t=>{
 const {db,call,login,auth}=await fixture(t);const initial=await login('newstaff','temporary-password');const issued=await call('/api/auth/setup','POST',{currentPassword:'temporary-password',newPassword:'qa-revoked-new-password9'},initial.cookie);assert.equal(issued.status,200);
 const originalRun=db.run.bind(db);let armed=true;db.run=function(sql,args,callback){if(armed&&sql.startsWith('UPDATE staff SET isFirstLogin = 0 WHERE')){armed=false;auth.invalidate('newstaff');queueMicrotask(()=>callback(Object.assign(new Error('synthetic busy'),{code:'SQLITE_BUSY'})));return db;}return originalRun(sql,args,callback);};
 assert.equal((await call('/api/auth/acknowledge-pin','POST',{acknowledged:true},issued.cookie)).status,503);assert.equal((await call('/api/auth/acknowledge-pin','POST',{acknowledged:true},issued.cookie)).status,401);
 const fresh=await login('newstaff','qa-revoked-new-password9');assert.equal(fresh.body.requiresPasswordChange,true);assert.equal((await call('/api/auth/acknowledge-pin','POST',{acknowledged:true},fresh.cookie)).status,409);
});

test('all new-password boundaries enforce letters and numbers while established legacy login remains usable',async t=>{
 const f=await fixture(t),admin=await f.login('administrator','safe-password'),cashier=await f.login('cashier','cashier-secret'),setup=await f.login('newstaff','temporary-password');
 for(const password of ['abcdefgh','12345678','!!!!!!!!','Short9','oneshotstaff','A1'+'x'.repeat(255)]){
  const requests=[['/api/auth/change-password',{currentPassword:'cashier-secret',newPassword:password},cashier.cookie],['/api/auth/setup',{currentPassword:'temporary-password',newPassword:password},setup.cookie],['/api/auth/recover',{username:'cashier',recoveryPin:'1234',newPassword:password}],['/api/staff/cashier/reset-password',{newPassword:password},admin.cookie],['/api/staff',{id:'qa-strength-created',username:'qa-strength-created',fullName:'QA strength',role:'cashier',password},admin.cookie]];
  for(const [route,body,cookie]of requests){const rejected=await f.call(route,'POST',body,cookie);assert.equal(rejected.status,400,route+' '+password);assert.match(rejected.body.error,/letters and numbers/);}
 }
 assert.equal((await f.login('cashier','cashier-secret')).status,200);assert.equal((await f.login('administrator','safe-password')).status,200);
 const before=await read(f.db,'cashier');const changed=await f.call('/api/auth/change-password','POST',{currentPassword:'cashier-secret',newPassword:'Letters9'},cashier.cookie);assert.equal(changed.status,200);assert.notEqual((await read(f.db,'cashier')).password,before.password);assert.equal((await f.login('cashier','cashier-secret')).status,401);assert.equal((await f.login('cashier','Letters9')).status,200);assert.equal((await f.call('/protected','GET',undefined,cashier.cookie)).status,401);
});
test('first-login actual temporary password cannot be reused and normal changes reject the current password',async t=>{
 const f=await fixture(t);await exec(f.db,'UPDATE staff SET password=? WHERE id=?',[sha('DefaultTemp9'),'newstaff']);const first=await f.login('newstaff','DefaultTemp9');assert.equal(first.body.requiresPasswordChange,true);const before=await read(f.db,'newstaff');const rejected=await f.call('/api/auth/setup','POST',{currentPassword:'DefaultTemp9',newPassword:'DefaultTemp9'},first.cookie);assert.equal(rejected.status,400);assert.match(rejected.body.error,/different password/);assert.deepEqual(await read(f.db,'newstaff'),before);assert.equal((await f.call('/protected','GET',undefined,first.cookie)).status,403);
 await exec(f.db,'UPDATE staff SET password=? WHERE id=?',[sha('CurrentPass9'),'cashier']);const signed=await f.login('cashier','CurrentPass9');assert.equal((await f.call('/api/auth/change-password','POST',{currentPassword:'CurrentPass9',newPassword:'CurrentPass9'},signed.cookie)).status,400);assert.equal((await f.call('/protected','GET',undefined,signed.cookie)).status,200);
});
test('initial administrator creation enforces the same new-password rule without treating legacy login as password creation',async t=>{
 const f=await fixture(t,false);for(const password of ['abcdefgh','12345678','!!!!!!!!'])assert.equal((await f.call('/api/auth/bootstrap','POST',{username:'qa-owner',fullName:'QA Owner',password,recoveryPin:'1234'})).status,400);assert.equal((await f.call('/api/auth/bootstrap','POST',{username:'qa-owner',fullName:'QA Owner',password:'OwnerNew9',recoveryPin:'1234'})).status,201);assert.equal((await f.login('qa-owner','OwnerNew9')).status,200);
});
