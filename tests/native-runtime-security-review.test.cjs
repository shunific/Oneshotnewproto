const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const express=require('express'),sqlite3=require('sqlite3');
const {registerAuthRoutes,hashSecret}=require('../server-auth.cjs');
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
async function fixture(t){
 const db=new sqlite3.Database(':memory:');
 await run(db,'CREATE TABLE staff(id TEXT PRIMARY KEY,username TEXT,password TEXT,fullName TEXT,role TEXT,phone TEXT,joinedDate TEXT,avatarImg TEXT,isActive INTEGER,isAdmin INTEGER,recoveryPin TEXT,isFirstLogin INTEGER)');
 for(const [id,username,password,isAdmin] of [['root','administrator','qa-admin-password',1],['cashier','cashier','qa-cashier-password',0]]){
  const digest=createHash('sha256').update(password).digest('hex');
  await run(db,'INSERT INTO staff VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id,username,digest,username,'cashier','','','',1,isAdmin,await hashSecret('1234'),0]);
 }
 const app=express();app.use(express.json());const ended=[];
 const auth=registerAuthRoutes(app,db,{onSessionEnd:token=>ended.push(token)});await auth.ready;
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(async()=>{auth.close();await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));});
 const call=async(route,method,body,cookie)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const admin=await call('/api/auth/login','POST',{username:'administrator',password:'qa-admin-password'});
 const cashier=await call('/api/auth/login','POST',{username:'cashier',password:'qa-cashier-password'});
 assert.equal(admin.status,200);assert.equal(cashier.status,200);
 return{auth,ended,token:cashier.cookie.split('=')[1],update:body=>call('/api/staff/cashier','PUT',body,admin.cookie)};
}
for(const [name,patch] of [['deactivation',{isActive:false}],['role change',{role:'manager'}],['privilege change',{isAdmin:true}],['username change',{username:'cashier-renamed'}],['explicit security-field rewrite',{isActive:true}]])test(`administrator ${name} immediately invalidates the cached native actor without waiting for a new DB-backed auth read`,async t=>{
 const f=await fixture(t);assert.deepEqual(await f.auth.resolveSessionActor(f.token),{localStaffId:'cashier'});assert.equal(f.auth.isSessionCurrent(f.token,'cashier'),true);
 assert.equal((await f.update(patch)).status,200);
 assert.equal(f.auth.isSessionCurrent(f.token,'cashier'),false);
 assert.ok(f.ended.includes(f.token));
});

test('administrator profile-only edits preserve the connected native session',async t=>{
 const f=await fixture(t);
 assert.deepEqual(await f.auth.resolveSessionActor(f.token),{localStaffId:'cashier'});
 assert.equal((await f.update({fullName:'QA renamed cashier',phone:'0000000000',avatarImg:''})).status,200);
 assert.equal(f.auth.isSessionCurrent(f.token,'cashier'),true);
 assert.deepEqual(await f.auth.resolveSessionActor(f.token),{localStaffId:'cashier'});
 assert.equal(f.ended.includes(f.token),false);
});
