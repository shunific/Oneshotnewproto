const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const sqlite3=require('sqlite3');
const {registerAuthRoutes,hashSecret}=require('../server-auth.cjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
async function fixture(t){
 const db=new sqlite3.Database(':memory:');
 await run(db,'CREATE TABLE staff (id TEXT PRIMARY KEY, username TEXT, password TEXT, fullName TEXT, role TEXT, phone TEXT, joinedDate TEXT, avatarImg TEXT, isActive INTEGER, isAdmin INTEGER, recoveryPin TEXT, isFirstLogin INTEGER)');
 const pin=await hashSecret('123456');
 for(const [id,active,admin,first] of [['cashier',1,0,0],['administrator',1,1,0],['inactiveadmin',0,1,0],['setupadmin',1,1,1],['manager',1,0,0]])await run(db,'INSERT INTO staff VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id,id,await hashSecret(sha(id+'-password')),id,'manager','','','',active,admin,pin,first]);
 const app=express();app.use(express.json());const auth=registerAuthRoutes(app,db);await auth.ready;
 app.get('/admin',auth.requireAdmin,(_req,res)=>res.json({success:true}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(async()=>{auth.close();await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));});
 const call=async(path,body,cookie)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const login=await call('/api/auth/login',{username:'cashier',password:'cashier-password'});assert.equal(login.status,200);
 return{db,auth,call,cookie:login.cookie,unlock:(body,cookie=login.cookie)=>call('/api/auth/unlock',body,cookie)};
}
test('current password and active administrator unlock preserve original cashier cookie, identity and permissions',async t=>{
 const {call,unlock,cookie}=await fixture(t);const before=await call('/api/auth/me',undefined,cookie);
 for(const body of [{password:'cashier-password'},{username:' Administrator ',password:'administrator-password'}]){
  const result=await unlock(body);assert.equal(result.status,200);assert.deepEqual(result.body,{success:true});assert.equal(result.cookie,undefined);
  assert.deepEqual(await call('/api/auth/me',undefined,cookie),before);assert.equal((await call('/admin',undefined,cookie)).status,403);
 }
 // Settings' own-password verifier must not become an administrator override.
 assert.equal((await call('/api/auth/verify',{password:'administrator-password'},cookie)).status,401);
});
test('wrong, nonadministrator, inactive and temporary administrator credentials cannot unlock',async t=>{
 const {unlock}=await fixture(t);
 for(const body of [{password:'wrong'},{username:'administrator',password:'wrong'},{username:'manager',password:'manager-password'},{username:'inactiveadmin',password:'inactiveadmin-password'},{username:'setupadmin',password:'setupadmin-password'},{username:'missing',password:'missing-password'}])assert.equal((await unlock(body)).status,403);
});
test('unlock requires a full current session, exact payload and durable bounded guesses',async t=>{
 const {unlock,call,cookie,db}=await fixture(t);
 assert.equal((await call('/api/auth/unlock',{password:'cashier-password'})).status,401);
 for(const body of [{password:'cashier-password',isAdmin:true},{username:'',password:'cashier-password'},{password:123},[]])assert.equal((await unlock(body)).status,400);
 for(let i=0;i<5;i++)assert.equal((await unlock({password:'wrong'})).status,403);
 assert.equal((await unlock({password:'cashier-password'})).status,429);
 const count=await new Promise((resolve,reject)=>db.get('SELECT attempts FROM auth_attempts WHERE key=?',['unlock:user:'+sha('cashier')],(e,row)=>e?reject(e):resolve(row.attempts)));assert.equal(count,5);
 await run(db,'UPDATE auth_attempts SET expires=0');assert.equal((await unlock({password:'cashier-password'})).status,200);
 await call('/api/auth/logout',{},cookie);assert.equal((await unlock({username:'administrator',password:'administrator-password'})).status,401);
});
for(const [name,sql,status] of [
 ['administrator demoted','UPDATE staff SET isAdmin=0 WHERE id=\'administrator\'',403],
 ['administrator deactivated','UPDATE staff SET isActive=0 WHERE id=\'administrator\'',403],
 ['administrator password replaced','UPDATE staff SET password=\'replaced\' WHERE id=\'administrator\'',403],
 ['cashier deactivated','UPDATE staff SET isActive=0 WHERE id=\'cashier\'',401],
 ['cashier password replaced','UPDATE staff SET password=\'replaced\' WHERE id=\'cashier\'',401],
])test('unlock rechecks after password work: '+name,async t=>{
 const {db,unlock}=await fixture(t);const original=db.all.bind(db);let changed=false;
 db.all=function(query,args,callback){if(query==='SELECT * FROM staff WHERE id IN (?, ?)'&&!changed){changed=true;db.run(sql,[],error=>error?callback(error):original(query,args,callback));return this;}return original(query,args,callback);};
 assert.equal((await unlock({username:'administrator',password:'administrator-password'})).status,status);assert.equal(changed,true);
});
test('a session revoked while administrator verification runs cannot unlock',async t=>{
 const {db,auth,unlock}=await fixture(t);const original=db.all.bind(db);
 db.all=function(query,args,callback){if(query==='SELECT * FROM staff WHERE id IN (?, ?)')auth.invalidate('cashier');return original(query,args,callback);};
 assert.equal((await unlock({username:'administrator',password:'administrator-password'})).status,401);
});
