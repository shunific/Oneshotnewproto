const {test}=require('node:test');const assert=require('node:assert/strict');const {readFileSync}=require('node:fs');const {join}=require('node:path');const {transform}=require('esbuild');
test('late unauthorized response from an old login cannot end a newer POS session',async()=>{
 const originalFetch=global.fetch,originalWindow=global.window;const events=[];let release;
 const old=new Promise(resolve=>release=resolve);
 global.window={location:{hostname:'localhost',port:'31371',origin:'http://localhost:31371'},dispatchEvent:event=>events.push(event.type)};
 global.fetch=async url=>String(url).endsWith('/api/auth/login')?new Response('{}',{status:200}):String(url).endsWith('/api/old')?old:new Response('{}',{status:401});
 try{
  const {code}=await transform(readFileSync(join(__dirname,'../src/app/utils/localApi.ts'),'utf8'),{loader:'ts',format:'esm'});
  const api=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  const pending=api.localFetch('http://localhost:3001/api/old');
  await api.authRequest('login',{username:'QA',password:'test-only'});
  release(new Response('{}',{status:401}));await pending;assert.deepEqual(events,[]);
  await api.localFetch('http://localhost:3001/api/current');assert.deepEqual(events,['oneshot-session-ended']);
  await api.localFetch('http://localhost:3001/api/auth/me');assert.equal(events.length,1);
 }finally{global.fetch=originalFetch;global.window=originalWindow;}
});
test('successful credential rotation protects the new session before its response body completes',async()=>{
 const originalFetch=global.fetch,originalWindow=global.window;const events=[];let releaseOld,releaseBody,headersSeen;
 const old=new Promise(resolve=>releaseOld=resolve),seen=new Promise(resolve=>headersSeen=resolve);
 global.window={location:{hostname:'localhost',port:'31371',origin:'http://localhost:31371'},dispatchEvent:event=>events.push(event.type)};
 let bodyReleased=false;
 const body=new ReadableStream({start(controller){releaseBody=()=>{if(bodyReleased)return;bodyReleased=true;controller.enqueue(new TextEncoder().encode('{}'));controller.close();};}});
 global.fetch=async url=>{if(String(url).endsWith('/api/auth/change-password')){headersSeen();return new Response(body,{status:200});}return old;};
 try{
  const {code}=await transform(readFileSync(join(__dirname,'../src/app/utils/localApi.ts'),'utf8'),{loader:'ts',format:'esm'});
  const api=await import('data:text/javascript;base64,'+Buffer.from(code+'\n// delayed body regression').toString('base64'));
  const pending=api.localFetch('http://localhost:3001/api/old');const change=api.authRequest('change-password',{currentPassword:'QA',newPassword:'QA-new'});
  await seen;await new Promise(setImmediate);releaseOld(new Response('{}',{status:401}));await pending;assert.deepEqual(events,[]);
  releaseBody();await change;
 }finally{releaseBody?.();global.fetch=originalFetch;global.window=originalWindow;}
});
