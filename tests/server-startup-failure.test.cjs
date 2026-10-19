const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{mkdtemp,rm}=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
for(const type of ['exception','rejection'])test(`unexpected ${type} stops the actual backend instead of leaving a stalled helper or leaking details`,async()=>{
 const root=path.resolve(__dirname,'..'),dir=await mkdtemp(path.join(os.tmpdir(),'oneshot-fatal-qa-'));
 try{
  const trigger=type==='exception'?"process.nextTick(()=>{throw Error('QA_PRIVATE_FATAL_DETAIL')})":"process.nextTick(()=>{Promise.reject(Error('QA_PRIVATE_FATAL_DETAIL'))})";
  const result=spawnSync(process.execPath,['-e',`require('./server.cjs');${trigger}`],{cwd:root,env:{...process.env,NODE_ENV:'test',USER_DATA_PATH:dir,PORT:'0'},encoding:'utf8',timeout:10000});
  assert.equal(result.status,1,`${result.error||''} ${result.stderr}`);assert.equal(result.signal,null);assert.match(result.stderr,/Local server stopped after an unexpected failure/);assert.doesNotMatch(result.stdout+result.stderr,/QA_PRIVATE_FATAL_DETAIL/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
