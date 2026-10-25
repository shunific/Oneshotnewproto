const {test}=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),sqlite3=require('sqlite3');
const {mkdtemp,rm}=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {registerImageRoutes,MAX_IMAGE_BYTES}=require('../server-images.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZKsAAAAASUVORK5CYII=','base64');
const webp=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64');
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'oneshot-images-')),file=path.join(dir,'qa.db');let db,server;
 const stop=async()=>{if(server){await new Promise(r=>server.close(r));server=null;}if(db){await new Promise(r=>db.close(r));db=null;}};
 const start=async()=>{db=await new Promise((resolve,reject)=>{const d=new sqlite3.Database(file,e=>e?reject(e):resolve(d));});await run(db,'CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY,mimeType TEXT,data BLOB)');const app=express();registerImageRoutes(app,db,{requireAuth:(req,res,next)=>req.headers.authorization==='QA synthetic'?next():res.status(401).json({error:'Sign in.'})});server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});};
 await start();t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
 const request=(route,options={},auth=true)=>fetch(`http://127.0.0.1:${server.address().port}${route}`,{...options,headers:{...(auth?{authorization:'QA synthetic'}:{}),...options.headers}});
 return{request,upload:async(data=png,mime='image/png',auth=true,extra)=>{const body=new FormData();body.append('image',new Blob([data],{type:mime}),'../../unsafe.svg');if(extra)body.append(...extra);return request('/api/images',{method:'POST',body},auth);},sql:(...args)=>run(db,...args),restart:async()=>{await stop();await start();}};
}
test('authenticated photo bytes and durable relative URL survive a database/server restart with private retrieval',async t=>{
 const f=await fixture(t);const uploaded=await f.upload();assert.equal(uploaded.status,201);const {url}=await uploaded.json();assert.match(url,/^\/api\/images\/[0-9a-f-]{36}$/);await f.restart();const image=await f.request(url);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('cache-control'),'no-store');assert.equal(image.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);assert.equal((await f.request(url,{},false)).status,401);assert.equal((await f.upload(png,'image/png',false)).status,401);
});
test('WebP and JPEG signatures are accepted only with matching allowed MIME; corrupt and active types are rejected',async t=>{
 const f=await fixture(t);assert.equal((await f.upload(webp,'image/webp')).status,201);const jpeg=Buffer.from([255,216,255,224,0,2,255,217]);assert.equal((await f.upload(jpeg,'image/jpeg')).status,201);
 for(const [bytes,mime]of [[png,'image/jpeg'],[png,'image/svg+xml'],[Buffer.from('<svg onload="x()"/>'),'image/svg+xml'],[Buffer.from('not an image'),'image/png'],[png.subarray(0,30),'image/png']])assert.equal((await f.upload(bytes,mime)).status,415);
});
test('size, missing file, unexpected fields and extra files are bounded without inserts',async t=>{
 const f=await fixture(t);assert.equal((await f.upload(Buffer.alloc(MAX_IMAGE_BYTES+1))).status,413);assert.equal((await f.request('/api/images',{method:'POST',body:new FormData()})).status,400);assert.equal((await f.upload(png,'image/png',true,['path','../../outside'])).status,400);assert.equal((await f.upload(png,'image/png',true,['image',new Blob([png],{type:'image/png'})])).status,400);
});
test('opaque storage failure and invalid/private legacy retrieval never expose server data',async t=>{
 const f=await fixture(t);await f.sql("CREATE TRIGGER qa_fail BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT,'QA private path'); END");const failed=await f.upload();assert.equal(failed.status,503);assert.doesNotMatch(await failed.text(),/QA private/);await f.sql('DROP TRIGGER qa_fail');await f.sql('INSERT INTO images VALUES(?,?,?)',['legacy_photo','image/png',png]);assert.equal((await f.request('/api/images/legacy_photo')).status,200);await f.sql('INSERT INTO images VALUES(?,?,?)',['legacy_svg','image/svg+xml',Buffer.from('<svg/>')]);assert.equal((await f.request('/api/images/legacy_svg')).status,404);assert.equal((await f.request('/api/images/%2e%2e%2fsecret')).status,404);assert.equal((await f.request('/api/images/missing')).status,404);
});
