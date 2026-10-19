const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),esbuild=require('esbuild');
function liveRefresh(env){
 const source=fs.readFileSync(path.resolve(__dirname,'../src/app/context/AppContext.tsx'),'utf8');
 const start=source.indexOf('  const applyPendingReservationMoves='),end=source.indexOf('\n  useEffect(',start);
 assert.ok(start>=0&&end>start);
 const fullStart=source.indexOf('  const forceFullSync ='),fullEnd=source.indexOf('\n  useEffect(',fullStart);
 const code=esbuild.transformSync(source.slice(start,end)+'\n'+source.slice(fullStart,fullEnd),{loader:'tsx'}).code;
 return vm.runInNewContext(code+';({refreshLiveMonitor,refreshReservationTransfers,forceFullSync})',env);
}
test('an older floor poll cannot erase newer held-table authority adopted by explicit recovery refresh in the same account',async()=>{
 const {readPendingReservationMoveList}=await import('../src/app/utils/sessionPersistence.js');
 const moves=[{requestId:'qa_floor_pending',moveId:'11111111-1111-4111-8111-111111111111',sourceId:'source',targetId:'target',phase:'prepared'}];
 let pending=[],error='',release;const gate=new Promise(resolve=>{release=resolve;});let requests=0;
 const env={identityRef:{current:'qa-staff'},identityGeneration:{current:1},authMutationInFlight:{current:false},floorRefreshGeneration:{current:0},readPendingReservationMoveList,
  setPendingReservationMoves:value=>{pending=value;},setReservationMoveError:value=>{error=value;},setTables(){},setQueue(){},setReservations(){},setInventory(){},
  localFetch:async url=>({ok:true,json:async()=>{if(!url.endsWith('/native/reservation-moves'))return[];requests++;if(requests===1){await gate;return{moves:[]};}return{moves};}}),
 };
 const refresh=liveRefresh(env),older=refresh.refreshLiveMonitor();await new Promise(resolve=>setImmediate(resolve));
 await refresh.refreshReservationTransfers();assert.equal(pending.length,1);assert.equal(error,'');
 release();await older;
 assert.deepEqual(JSON.parse(JSON.stringify(pending)),moves);
});

const held=[{requestId:'qa_floor_new_held',moveId:'22222222-2222-4222-8222-222222222222',sourceId:'source',targetId:'target',phase:'prepared'}];
const deferred=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return{promise,release};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(localFetch){
 const {readPendingReservationMoveList}=await import('../src/app/utils/sessionPersistence.js');
 const state={pending:[],error:'',tables:[],reservations:[],rates:{},initialized:true,writes:0};
 const set=name=>value=>{state[name]=typeof value==='function'?value(state[name]):value;state.writes++;};
 const env={identityRef:{current:'qa-staff'},identityGeneration:{current:1},authMutationInFlight:{current:false},floorRefreshGeneration:{current:0},readPendingReservationMoveList,localFetch,
  setPendingReservationMoves:set('pending'),setReservationMoveError:set('error'),setTables:set('tables'),setReservations:set('reservations'),setQueue:set('queue'),setInventory:set('inventory'),setRates:set('rates'),setIsInitializing:set('initialized'),
 };
 for(const name of ['setStaffUsers','setSessionHistory','setActivities','setFeedback','setLostItems','setWatchlist','setReservationTerms','setAnnouncements','setSiteConfig','setClosedDates','setPromoCodes','setEvents','setIsSystemOffline','setLastSynced','remindPendingSessions'])env[name]=()=>{};
 return{state,env,refresh:liveRefresh(env)};
}
const response=value=>({ok:true,json:async()=>value});
test('an older manual response cannot erase newer live-poll held authority',async()=>{
 const gate=deferred();let reads=0;
 const h=await harness(async url=>url.endsWith('/native/reservation-moves')?{ok:true,json:async()=>++reads===1?(await gate.promise,{moves:[]}):{moves:held}}:response([]));
 const old=h.refresh.refreshReservationTransfers();await tick();await h.refresh.refreshLiveMonitor();gate.release();await old;
 assert.deepEqual(JSON.parse(JSON.stringify(h.state.pending)),held);assert.equal(h.state.error,'');
});
test('a failed latest recovery read stays unknown after an older successful poll finishes',async()=>{
 const gate=deferred();let reads=0;
 const h=await harness(async url=>{if(!url.endsWith('/native/reservation-moves'))return response([]);if(++reads===2)return{ok:false};return{ok:true,json:async()=>{await gate.promise;return{moves:[]};}};});
 const old=h.refresh.refreshLiveMonitor();await tick();await h.refresh.refreshReservationTransfers();assert.ok(h.state.error);gate.release();await old;assert.ok(h.state.error);
});
test('an account switch while a recovery body is pending prevents every obsolete floor write',async()=>{
 const gate=deferred();
 const h=await harness(async url=>url.endsWith('/native/reservation-moves')?{ok:true,json:async()=>{await gate.promise;return{moves:held};}}:response([]));
 const old=h.refresh.refreshLiveMonitor();await tick();h.env.identityRef.current='qa-next-staff';h.env.identityGeneration.current++;gate.release();await old;assert.equal(h.state.writes,0);
});
for(const boundary of ['first-batch','second-batch'])test(`superseded full sync ${boundary} cannot replace newer floor data but completes settings and initialization`,async()=>{
 const gate=deferred(),counts=new Map();
 const h=await harness(async url=>{
  const endpoint=url.replace('http://localhost:3001/api/',''),count=(counts.get(endpoint)||0)+1;counts.set(endpoint,count);
  if(endpoint==='native/reservation-moves')return{ok:true,json:async()=>{if(count===1&&boundary==='first-batch')await gate.promise;return{moves:count===1?[]:held};}};
  if(endpoint==='tables')return response([{id:count===1?'old-table':'new-table'}]);
  if(endpoint==='reservations')return{ok:true,json:async()=>{if(count===1&&boundary==='second-batch')await gate.promise;return[{id:(boundary==='first-batch'?count===1:count===2)?'new-reservation':'old-reservation'}];}};
  if(endpoint==='settings/rates')return response({hourlyRate:175});
  return response([]);
 });
 const old=h.refresh.forceFullSync();await tick();await h.refresh.refreshLiveMonitor();gate.release();await old;
 assert.equal(h.state.tables[0].id,'new-table');assert.equal(h.state.reservations[0].id,'new-reservation');assert.deepEqual(JSON.parse(JSON.stringify(h.state.pending)),held);
 assert.equal(h.state.rates.hourlyRate,175);assert.equal(h.state.initialized,false);
});
