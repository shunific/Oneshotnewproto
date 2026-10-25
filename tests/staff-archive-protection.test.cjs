const {test}=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),sqlite3=require('sqlite3'),crypto=require('node:crypto'),path=require('node:path');
const {registerAuthRoutes,hashSecret}=require(process.env.ONESHOT_AUTH_MODULE?path.resolve(process.env.ONESHOT_AUTH_MODULE):'../server-auth.cjs');
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
test('administrators cannot archive themselves or Master Super Admin, but can archive and restore ordinary staff',async t=>{
 const db=new sqlite3.Database(':memory:');await run(db,'CREATE TABLE staff (id TEXT PRIMARY KEY, username TEXT, password TEXT, fullName TEXT, role TEXT, phone TEXT, joinedDate TEXT, avatarImg TEXT, isActive INTEGER, isAdmin INTEGER, recoveryPin TEXT, isFirstLogin INTEGER)');
 const password=crypto.createHash('sha256').update('GuardAdmin9').digest('hex'),pin=await hashSecret('1234');
 for(const[id,admin]of[['admin_001',1],['qa_other_admin',1],['qa_guarded_cashier',0]])await run(db,'INSERT INTO staff VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id,id,password,id,admin?'manager':'cashier','','','',1,admin,pin,0]);
 const app=express();app.use(express.json());const auth=registerAuthRoutes(app,db);await auth.ready;const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});t.after(async()=>{auth.close();await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));});
 const call=async(route,method='GET',body,cookie)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const admin=await call('/api/auth/login','POST',{username:'qa_other_admin',password:'GuardAdmin9'});assert.equal(admin.status,200);
 const before=(await call('/api/staff','GET',undefined,admin.cookie)).body;
 for(const id of ['admin_001','qa_other_admin'])assert.equal((await call('/api/staff/'+id,'PUT',{isActive:false},admin.cookie)).status,403);
 assert.deepEqual((await call('/api/staff','GET',undefined,admin.cookie)).body,before);
 assert.equal((await call('/api/staff/qa_guarded_cashier','PUT',{isActive:false},admin.cookie)).status,200);assert.equal((await call('/api/auth/login','POST',{username:'qa_guarded_cashier',password:'GuardAdmin9'})).status,401);
 assert.equal((await call('/api/staff/qa_guarded_cashier','PUT',{isActive:true},admin.cookie)).status,200);assert.equal((await call('/api/auth/login','POST',{username:'qa_guarded_cashier',password:'GuardAdmin9'})).status,200);
});
