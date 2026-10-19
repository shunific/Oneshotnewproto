const test=require('node:test'),assert=require('node:assert/strict'),esbuild=require('esbuild'),Module=require('node:module'),path=require('node:path');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const tables=[
 {id:'source',name:'QA Held Source',status:'occupied',isActive:true,session:{customerName:'QA Guest',startTime:new Date().toISOString(),durationMinutes:60,isOpenTime:false}},
 {id:'target',name:'QA Held Destination',status:'available',isActive:true,session:null},
 {id:'free',name:'QA Free Table',status:'available',isActive:true,session:null},
 {id:'inactive',name:'QA Inactive Table',status:'available',isActive:false,session:null},
 {id:'broken',name:'QA Session Still Present',status:'available',isActive:true,session:{customerName:'QA Other Guest'}},
];
const move={sourceId:'source',targetId:'target',phase:'prepared'};
test('available capacity excludes both held tables, inactive tables and an occupied payload despite its stale status',async()=>{
 const {readTableAvailability}=await import('../src/app/utils/tableAvailability.js');
 for(const phase of ['prepared','aborting','local-committed']){
  const state=readTableAvailability(tables,[{...move,phase}]);
  assert.deepEqual(state.availableTables.map(t=>t.id),['free']);assert.deepEqual([...state.heldTableIds],['source','target']);
 }
 assert.deepEqual(readTableAvailability(tables,[]).availableTables.map(t=>t.id),['target','free']);
 assert.deepEqual(readTableAvailability(tables,[move],'Recovery status unverified').availableTables,[]);
});
const built=new Map();async function page(name){
 if(!built.has(name))built.set(name,(async()=>{
  const filename=path.resolve(__dirname,name+'.floor-review.cjs');
  const result=await esbuild.build({entryPoints:[path.resolve(__dirname,'../src/app/pages/'+name+'.tsx')],bundle:true,write:false,loader:{'.png':'dataurl'},platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime'],plugins:[{name:'qa-floor-context',setup(build){
   build.onResolve({filter:/context\/AppContext$/},()=>({path:'context',namespace:'qa-floor'}));build.onResolve({filter:/^react-router$/},()=>({path:'router',namespace:'qa-floor'}));
   build.onLoad({filter:/.*/,namespace:'qa-floor'},args=>({contents:args.path==='context'?'exports.useAppContext=()=>globalThis.__oneshotQaFloor;':'exports.useNavigate=()=>()=>{};',loader:'js'}));
  }}]});
  const compiled=new Module(filename,module);compiled.filename=filename;compiled.paths=module.paths;compiled._compile(result.outputFiles[0].text,filename);return compiled.exports[name];
 })());return built.get(name);
}
async function render(name,error='',extra={}){
 const {readTableAvailability}=await import('../src/app/utils/tableAvailability.js');
 globalThis.__oneshotQaFloor={tables,...readTableAvailability(tables,[move],error),pendingReservationMoves:[move],reservationMoveError:error,queue:[{id:'qa-called',customerName:'QA Waiting Guest',partySize:2,status:'called',joinedAt:new Date()}],reservations:[],watchlist:[],staffUsers:[],promoCodes:[],announcements:[],closedDates:[],rates:{},reservationTerms:{},staffProfile:{isAdmin:false},feedback:[],activities:[],sessionHistory:[],weather:null,inventory:[],...extra};
 try{return renderToStaticMarkup(React.createElement(await page(name)));}finally{delete globalThis.__oneshotQaFloor;}
}
test('actual Overview and Queue render the same capacity and never offer the held or inactive destination',async()=>{
 const overview=await render('OverviewDashboard');assert.match(overview,/Available Tables<\/p><p[^>]*>1<\/p>/);assert.match(overview,/QA Held Destination.*?Transfer held/);
 const queue=await render('Queue');assert.match(queue,/Available Tables \(1\)/);assert.match(queue,/QA Free Table/);assert.doesNotMatch(queue,/QA Held Destination|QA Inactive Table|QA Session Still Present/);
 const live=await render('LiveMonitor');assert.match(live,/1 Available/);assert.equal((live.match(/TRANSFER HELD/g)||[]).length,2);assert.doesNotMatch(live,/QA Inactive Table/);
 const admin=await render('AdminDashboard');assert.match(admin,/>1<\/p><p[^>]*>Available Tables/);
});
test('unknown recovery status renders a warning, unknown capacity and disabled Queue assignment',async()=>{
 const overview=await render('OverviewDashboard','Unknown recovery');assert.match(overview,/Available Tables<\/p><p[^>]*>—<\/p>/);assert.match(overview,/role="alert"/);
 const queue=await render('Queue','Unknown recovery');assert.match(queue,/role="alert"/);assert.match(queue,/Available Tables \(0\)/);assert.match(queue,/<button[^>]*disabled=""[^>]*>Assign Table<\/button>/);
 assert.match(queue,/Check transfer recovery/);assert.doesNotMatch(queue,/Next table free in/);
 const live=await render('LiveMonitor','Unknown recovery');assert.match(live,/— Available/);assert.doesNotMatch(live,/>OPEN<|Walk-in Welcome/);
 const admin=await render('AdminDashboard','Unknown recovery');assert.match(admin,/>—<\/p><p[^>]*>Available Tables/);
});

test('actual Table Monitor counts inactive maintenance cards in its maintenance and All filters',async()=>{
 const fixture=[{id:'free',name:'QA Free',status:'available',isActive:true,session:null},{id:'maintenance',name:'QA Maintenance',status:'maintenance',isActive:false,maintenanceReason:'QA cleaning',session:null}];
 const html=await render('Tables','',{tables:fixture,availableTables:[fixture[0]],heldTableIds:new Set(),pendingReservationMoves:[],pendingQueueOperations:[]});
 assert.match(html,/>1<\/p><p[^>]*>Maintenance<\/p>/);
 assert.match(html,/QA Maintenance/);assert.match(html,/QA cleaning/);
 assert.match(html,/All\s*<span[^>]*>2<\/span>/);
});
