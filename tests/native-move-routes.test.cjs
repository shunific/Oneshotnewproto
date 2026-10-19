const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {registerNativeMoveRoutes}=require('../server-native-move-routes.cjs');
async function fixture(t,{recoverMove=async()=>({}),list=async()=>[]}={}){
 const app=express();app.use(express.json());const seen=[];
 registerNativeMoveRoutes(app,{requireAuth:[(req,res,next)=>{if(req.headers.authorization!=='QA synthetic')return res.status(401).json({error:'Sign in.'});req.authToken='qa-private-session';next();},(_req,_res,next)=>next()],runtime:Promise.resolve({recoverMove:async(...args)=>{seen.push(args);return recoverMove(...args);}}),listPendingMoves:list});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=async(method,body,auth=true)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/native/reservation-moves${method==='POST'?'/recover':''}`,{method,headers:{'content-type':'application/json',...(auth?{authorization:'QA synthetic'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};return{seen,call};
}
test('pending recovery and mutation both require local authentication before touching private services',async t=>{
 let reads=0;const f=await fixture(t,{list:async()=>{reads++;return[];}});assert.equal((await f.call('GET',null,false)).status,401);assert.equal((await f.call('POST',{requestId:'qa_original',action:'abort'},false)).status,401);assert.equal(reads,0);assert.equal(f.seen.length,0);
});
test('recovery routes publish only stored IDs and actions with server-owned staff session authority',async t=>{
 const moves=[{requestId:'qa_original',moveId:'11111111-1111-4111-8111-111111111111',sourceId:'a',targetId:'b',phase:'prepared'}];const result={requestId:'qa_original',phase:'aborted'};
 const f=await fixture(t,{recoverMove:async()=>result,list:async()=>moves});assert.deepEqual((await f.call('GET')).body,{moves});assert.deepEqual((await f.call('POST',{requestId:'qa_original',action:'abort'})).body,result);assert.deepEqual(f.seen,[['qa-private-session',{requestId:'qa_original',action:'abort'}]]);
 for(const key of ['payload','actorId','deviceId','keyId','signature'])assert.equal((await f.call('POST',{requestId:'qa_original',action:'abort',[key]:'forged'})).status,400);
 assert.equal(f.seen.length,1);
});
test('unexpected private failures do not escape through public recovery routes',async t=>{
 const f=await fixture(t,{recoverMove:async()=>{throw Error('QA_PRIVATE_PROVIDER_DETAIL');},list:async()=>{throw Error('QA_PRIVATE_DATABASE_DETAIL');}});
 for(const response of [await f.call('GET'),await f.call('POST',{requestId:'qa_original',action:'abort'})]){assert.equal(response.status,503);assert.doesNotMatch(JSON.stringify(response.body),/QA_PRIVATE/);}
});
