const test=require('node:test'),assert=require('node:assert/strict');
test('local errors show staff actions without response bodies or transport internals',async()=>{
 const {localRequestError}=await import('../src/app/utils/localRequestError.js');
 for(const status of [0,400,401,403,404,409,500,503]){
  const response={error:'SQLITE_ERROR SELECT password FROM staff secret',code:'UNKNOWN_PRIVATE_CODE',private:'QA sentinel'};
  const error=localRequestError(status,response);assert.equal(error.status,status);assert.equal(error.response,response);assert.doesNotMatch(error.message,/SQLITE|password|secret|SELECT|QA sentinel|UNKNOWN_PRIVATE_CODE/);assert.ok(error.message.length>20);
 }
 assert.match(localRequestError(503,{code:'CLOUD_NOT_CONFIGURED'}).message,/administrator.*retry the original action/);
});
test('human error mapping preserves exact rejection metadata so only a durable matching pre-intent response clears a draft',async()=>{
 const {localRequestError}=await import('../src/app/utils/localRequestError.js'),{saveSessionChange}=await import('../src/app/utils/sessionPersistence.js');
 const payload={expectedSession:{pricingVersion:2,startTime:'2026-10-19T00:00:00.000Z'},targetId:'target',expectedTargetStatus:'available',expectedTargetSession:null};
 for(const valid of [true,false]){
  const map=new Map(),storage={get length(){return map.size},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
  const response={code:'NATIVE_MOVE_NOT_STARTED',requestId:valid?'qa_error_original':'qa_other_request',sourceId:'source',error:'Do not display this raw error'};
  await assert.rejects(saveSessionChange({storage,tableId:'source',kind:'move',payload,newId:()=> 'qa_error_original',request:async()=>{throw localRequestError(409,response);}}));
  assert.equal(storage.length,valid?0:1);assert.doesNotMatch(localRequestError(409,response).message,/Do not display/);
 }
});
