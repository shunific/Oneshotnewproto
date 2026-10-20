const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sqlite3 = require('sqlite3');
const { mkdtemp, rm, readdir, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerAuthRoutes, hashSecret } = require('../server-auth.cjs');
const { registerBackupRoutes } = require('../server-backup.cjs');
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, error => error ? reject(error) : resolve()));
const get = (db, sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row)));
const open = filename => new Promise((resolve, reject) => { const db = new sqlite3.Database(filename, error => error ? reject(error) : resolve(db)); });
const close = db => new Promise(resolve => db.close(resolve));

test('administrator backup is a restorable complete SQLite snapshot and leaves no temporary download files', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'oneshot-backup-test-'));
  const db = await open(path.join(folder, 'source.sqlite'));
  await run(db, 'CREATE TABLE staff (id TEXT PRIMARY KEY, username TEXT, password TEXT, fullName TEXT, role TEXT, phone TEXT, joinedDate TEXT, avatarImg TEXT, isActive INTEGER, isAdmin INTEGER, recoveryPin TEXT, isFirstLogin INTEGER)');
  const crypto = require('node:crypto');
  const password = await hashSecret(crypto.createHash('sha256').update('safe-qa-password').digest('hex'));
  const pin = await hashSecret('123456');
  for (const [id, admin] of [['admin',1],['cashier',0]]) await run(db, 'INSERT INTO staff VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)', [id,id,password,id,'cashier','','','',admin,pin]);
  await run(db, 'CREATE TABLE checkout_operations(request_id TEXT PRIMARY KEY,response_json TEXT)');
  await run(db, 'INSERT INTO checkout_operations VALUES (?,?)', ['qa-checkout', JSON.stringify({ receipt: 'QA receipt' })]);
  await run(db, 'CREATE TABLE session_payments(id TEXT PRIMARY KEY,amount REAL)');
  await run(db, "INSERT INTO session_payments VALUES ('qa-payment',75)");
  await run(db, 'CREATE TABLE session_state_operations(request_id TEXT PRIMARY KEY,response_json TEXT)');
  await run(db, "INSERT INTO session_state_operations VALUES ('qa-move','{\"replayed\":false}')");
  const app = express(); app.use(express.json());
  const auth = registerAuthRoutes(app, db); await auth.ready;
  await run(db, 'INSERT INTO auth_attempts VALUES (?,3,?)', ['recover:user:qa',Date.now()+900000]);
  registerBackupRoutes(app, db, { requireAdmin: auth.requireAdmin, tempRoot: folder });
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { auth.close(); await new Promise(resolve => server.close(resolve)); await close(db); await rm(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async username => {
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({username,password:'safe-qa-password'}) });
    assert.equal(response.status,200); return response.headers.get('set-cookie').split(';')[0];
  };
  assert.equal((await fetch(base + '/api/backup')).status,401);
  const cashier = await login('cashier');
  assert.equal((await fetch(base + '/api/backup', { headers: {Cookie:cashier} })).status,403);
  const admin = await login('admin');
  const response = await fetch(base + '/api/backup', { headers: {Cookie:admin} });
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.match(response.headers.get('content-disposition'), /attachment; filename="OneShot-backup-.*\.sqlite"/);
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.equal(buffer.subarray(0,16).toString(),'SQLite format 3\u0000');
  const restoredPath = path.join(folder,'restored.sqlite'); await writeFile(restoredPath,buffer,{mode:0o600});
  const restored = await open(restoredPath);
  try {
    const staff = await get(restored, "SELECT password,recoveryPin FROM staff WHERE id='admin'");
    assert.equal(staff.password,password); assert.equal(staff.recoveryPin,pin);
    assert.equal((await get(restored, "SELECT attempts FROM auth_attempts WHERE key='recover:user:qa'")).attempts,3);
    assert.equal((await get(restored, "SELECT response_json FROM checkout_operations WHERE request_id='qa-checkout'")).response_json,'{"receipt":"QA receipt"}');
    assert.equal((await get(restored, "SELECT amount FROM session_payments WHERE id='qa-payment'")).amount,75);
    assert.equal((await get(restored, "SELECT count(*) AS count FROM session_state_operations")).count,1);
    assert.equal((await get(restored,'PRAGMA integrity_check')).integrity_check,'ok');
  } finally { await close(restored); }
  for (let attempt=0;attempt<20;attempt++) {
    const temporary = (await readdir(folder)).filter(name=>name.startsWith('oneshot-backup-'));
    if (!temporary.length) break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal((await readdir(folder)).filter(name=>name.startsWith('oneshot-backup-')).length,0);
  assert.equal((await get(db,'SELECT count(*) AS count FROM staff')).count,2);
});

test('backup registration fails closed without administrator middleware', () => {
  assert.throws(()=>registerBackupRoutes(express(),{}),/administrator authorization/);
  assert.throws(()=>registerBackupRoutes(express(),{},{requireAdmin:[]}),/administrator authorization/);
});

test('failed SQLite export returns a generic error and removes its private temporary directory', async t => {
  const folder=await mkdtemp(path.join(os.tmpdir(),'oneshot-failed-backup-'));
  const app=express();
  registerBackupRoutes(app,{run(_sql,_params,done){done(new Error('private-path-and-database-details'));}},{tempRoot:folder,requireAdmin:(_req,_res,next)=>next()});
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(folder,{recursive:true,force:true});});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/backup`);
  assert.equal(response.status,503);assert.equal(JSON.stringify(await response.json()).includes('private-path'),false);
  for(let attempt=0;attempt<20&&(await readdir(folder)).length;attempt++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(await readdir(folder),[]);
});
