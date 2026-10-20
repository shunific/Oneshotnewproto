const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),express=require('express'),sqlite3=require('sqlite3');
test('actual new-feedback HTTP handler refuses pre-resolved rows and administrator notes',async t=>{
 const db=new sqlite3.Database(':memory:'),run=(sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
 await run('CREATE TABLE feedback(id TEXT PRIMARY KEY, customerName TEXT,contactInfo TEXT,feedbackType TEXT,comment TEXT,reservationId TEXT,tags TEXT,date TEXT,status TEXT,notes TEXT)');
 const app=express();app.use(express.json());const source=fs.readFileSync(require.resolve('../server.cjs'),'utf8'),a=source.indexOf("app.post('/api/feedback',"),z=source.indexOf("require('./server-feedback.cjs')",a);
 assert.ok(a>0&&z>a);vm.runInNewContext(source.slice(a,z),{app,db,Date,JSON});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(async()=>{await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));});
 const call=body=>fetch('http://127.0.0.1:'+server.address().port+'/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'qa-feedback',customerName:'QA Synthetic',comment:'Test only',...body})});
 for(const bad of [{status:'resolved'},{status:'pending',notes:'forged admin resolution'},{notes:'forged admin resolution'}])assert.equal((await call(bad)).status,400);
 assert.equal((await call({status:'pending'})).status,201);
 const rows=await new Promise((resolve,reject)=>db.all('SELECT * FROM feedback',(e,r)=>e?reject(e):resolve(r)));assert.equal(rows.length,1);assert.equal(rows[0].status,'pending');assert.equal(rows[0].notes,null);
});
