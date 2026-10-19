const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),esbuild=require('esbuild');
function refreshFixture() {
 const source=fs.readFileSync(require.resolve('../src/app/context/AppContext.tsx'),'utf8');
 const a=source.indexOf('  const refreshLiveMonitor ='),z=source.indexOf('  useEffect(() => {',a);
 const state={blockFeedback:null,history:[{id:'original',receipt:{refund_status:'pending'}}],requests:[],updates:[],historyRows:[{id:'original',receipt:{refund_status:'returned'}}],fail:false,deferred:null};
 const identityRef={current:'qa-admin'},identityGeneration={current:1};
 const scope={identityRef,identityGeneration,floorRefreshGeneration:{current:0},authMutationInFlight:{current:false},JSON,Promise,Array,localFetch:async url=>{state.requests.push(url);if(url.endsWith('/feedback')&&state.blockFeedback)await state.blockFeedback;if(url.endsWith('/session-history')){if(state.deferred)await state.deferred;if(state.fail)throw Error('QA history read failure');const snapshot=state.historyRows;return{ok:true,json:async()=>snapshot};}return{ok:true,json:async()=>[]};},applyPendingReservationMoves(){},setInventory(){},setTables(){},setQueue(){},setReservations(){},setStaffUsers(){},setActivities(){},setFeedback(){},setLostItems(){},setWatchlist(){},setRates(){},setReservationTerms(){},setAnnouncements(){},setSiteConfig(){},setClosedDates(){},setPromoCodes(){},setEvents(){},setIsSystemOffline(){},setLastSynced(){},remindPendingSessions(){},refreshPendingQueueOperations(){},setIsInitializing(){},setSessionHistory:update=>{state.updates.push(update);state.history=update(state.history);}};
 const fa=source.indexOf('  const forceFullSync ='),fz=source.indexOf('  useEffect(() => {',fa);
 vm.runInNewContext(esbuild.transformSync(source.slice(a,z)+source.slice(fa,fz)+'\nglobalThis.refresh=refreshLiveMonitor;globalThis.fullSync=forceFullSync;',{loader:'ts'}).code,scope);
 return{state,scope,identityRef,identityGeneration,refresh:scope.refresh,fullSync:scope.fullSync};
}
test('existing live refresh reloads saved receipt refund state and keeps history on failed reads',async()=>{
 const f=refreshFixture();await f.refresh();assert.equal(f.state.history[0].receipt.refund_status,'returned');assert.equal(f.state.requests.filter(x=>x.endsWith('/session-history')).length,1);
 const previous=f.state.history;f.state.fail=true;await f.refresh();assert.equal(f.state.history,previous);
 f.state.fail=false;f.state.historyRows={error:'bad shape'};await f.refresh();assert.equal(f.state.history,previous);
});
test('late history replies and deferred React updates cannot enter another staff account',async()=>{
 const f=refreshFixture();let release;f.state.deferred=new Promise(r=>{release=r;});const pending=f.refresh();f.identityGeneration.current++;release();await pending;assert.equal(f.state.history[0].receipt.refund_status,'pending');assert.equal(f.state.updates.length,0);
 const g=refreshFixture();await g.refresh();const queued=g.state.updates[0];g.identityRef.current='qa-other';const other=[{id:'other-private'}];assert.equal(queued(other),other);
});

test('a delayed older full sync cannot replace the newer refund snapshot from live refresh',async()=>{
 const f=refreshFixture();let release;f.state.blockFeedback=new Promise(r=>{release=r;});f.state.historyRows=[{id:'original',receipt:{refund_status:'pending'}}];const older=f.fullSync();
 await new Promise(resolve=>setImmediate(resolve));f.state.historyRows=[{id:'original',receipt:{refund_status:'returned'}}];await f.refresh();assert.equal(f.state.history[0].receipt.refund_status,'returned');
 release();await older;assert.equal(f.state.history[0].receipt.refund_status,'returned');assert.equal(f.state.updates.length,1);
});
test('CSV output preserves commas, quotes, line breaks and currency precision through a standard parser',async()=>{
 const {exportCsv}=await import('../src/app/utils/csvExport.js');const data=exportCsv(['Customer','Table','PHP'],[['QA, "A"\nTest','Archived table',125.25],['=1+1','qa',0],[' @SUM(A1:A2)','qa',null]]);
 const parsed=JSON.parse(require('node:child_process').execFileSync('python3',['-c','import csv,sys,json;print(json.dumps(list(csv.reader(sys.stdin))))'],{input:data,encoding:'utf8'}));
 assert.deepEqual(parsed,[['Customer','Table','PHP'],['QA, "A"\nTest','Archived table','125.25'],["'=1+1",'qa','0'],["' @SUM(A1:A2)",'qa','']]);
});

function financeRecord(id,startTime) {
 const endTime=new Date(new Date(startTime).getTime()+60000).toISOString();
 const h={id,customerName:'QA, "Export"\nTest',tableId:'qa-deleted-table',tableName:'QA Historical table',startTime,endTime,durationMinutes:1,totalAmount:9999,amountPaid:9999,orders:[]};
 return {...h,receipt:{id,receipt_no:id,table_id:h.tableId,table_name:h.tableName,customer_name:h.customerName,play_start_time:startTime,play_end_time:endTime,duration_minutes:1,table_charge:125.25,overtime_charge:0,fnb_charge:0,subtotal:125.25,discount_amount:0,total_amount:125.25,amount_paid:25.25,balance_due:100,refund_due:0,refund_status:'none',payment_status:'partial'}};
}
async function analyticsPage(context,initialStates=[]) {
 const React=require('react'),finance=await import('../src/app/utils/sessionFinancials.js'),csv=await import('../src/app/utils/csvExport.js');
 const states=[...initialStates],downloads=[],blobs=[];let cursor=0;
 const exports={},scope={module:{exports},exports,Blob,URL:{createObjectURL:blob=>{blobs.push(blob);return'blob:qa';},revokeObjectURL(){}},document:{createElement:()=>({click(){downloads.push(this.download);}})},window:{print(){}},require:name=>name==='react'?{...React,useState:initial=>{const index=cursor++;if(!(index in states))states[index]=initial;return[states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},useMemo:fn=>fn()}:name==='../context/AppContext'?{useAppContext:()=>context}:name==='../utils/sessionFinancials.js'?finance:name==='../utils/csvExport.js'?csv:require(name)};
 vm.runInNewContext(esbuild.transformSync(fs.readFileSync(require.resolve('../src/app/pages/Analytics.tsx'),'utf8'),{loader:'tsx',format:'cjs',jsx:'automatic'}).code,scope);
 const render=()=>{cursor=0;return scope.module.exports.Analytics();};
 const nodes=(node,out=[])=>{if(node&&typeof node==='object'){out.push(node);React.Children.forEach(node.props?.children,child=>nodes(child,out));}return out;};
 const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node?.props?text(node.props.children):'';
 return{states,blobs,downloads,render,nodes,text,html:()=>require('react-dom/server').renderToStaticMarkup(render())};
}
test('actual analytics export respects inclusive start-day boundaries, canonical receipt amounts and historical table names',async()=>{
 const start=new Date(2026,9,19,0,0,0,0),end=new Date(2026,9,19,23,59,59,999),next=new Date(2026,9,20,0,0,0,0);
 const context={tables:[],reservations:[],queue:[],sessionHistory:[financeRecord('qa-start',start.toISOString()),financeRecord('qa-end',end.toISOString()),financeRecord('qa-next',next.toISOString())]};
 const page=await analyticsPage(context,[{start:'2026-10-19',end:'2026-10-19'},false,'2026-10-19']);
 const tree=page.render();const button=page.nodes(tree).find(n=>n.type==='button'&&n.props.title==='Export Range');assert.equal(button.props.disabled,false);button.props.onClick();assert.equal(page.blobs.length,1);assert.equal(page.downloads[0],'Analytics_Export_2026-10-19_to_2026-10-19.csv');
 const data=await page.blobs[0].text(),rows=JSON.parse(require('node:child_process').execFileSync('python3',['-c','import csv,sys,json;print(json.dumps(list(csv.reader(sys.stdin))))'],{input:data,encoding:'utf8'}));
 assert.deepEqual(rows.slice(1).map(r=>r[0]),['qa-start','qa-end']);assert.equal(rows[1][1],context.sessionHistory[0].customerName);assert.equal(rows[1][2],'QA Historical table');assert.equal(rows[1][6],'125.25');assert.equal(rows[1][7],'25.25');assert.match(page.html(),/QA Historical table/);assert.match(page.html(),/History only/);assert.doesNotMatch(data,/9999/);
});
test('invalid and reversed date ranges warn and do not export; cleared shift date renders safely',async()=>{
 const context={tables:[],reservations:[],queue:[],sessionHistory:[]};
 for(const dates of [{start:'',end:'2026-10-19'},{start:'2026-02-31',end:'2026-03-01'},{start:'2026-10-20',end:'2026-10-19'}]){
  const page=await analyticsPage(context,[dates,false,'2026-10-19']);const button=page.nodes(page.render()).find(n=>n.type==='button'&&n.props.title==='Export Range');assert.equal(button.props.disabled,true);button.props.onClick();assert.equal(page.blobs.length,0);assert.match(page.html(),/Choose valid From and To dates/);
 }
 const page=await analyticsPage(context,[{start:'2026-10-19',end:'2026-10-19'},true,'']);assert.match(page.html(),/Choose a valid shift date/);const exportButton=page.nodes(page.render()).find(n=>n.type==='button'&&n.props.onClick?.name==='handleExportShiftCSV');assert.ok(exportButton);assert.equal(exportButton.props.disabled,true);exportButton.props.onClick();assert.equal(page.blobs.length,0);
});

test('shift export counts a linked reservation once while its cached status is still confirmed',async()=>{
 const h=financeRecord('qa-linked',new Date(2026,9,19,14,0).toISOString());h.receipt.reservation_id='qa-booking';
 const context={tables:[],queue:[],sessionHistory:[h],reservations:[{id:'qa-booking',date:'2026-10-19',status:'confirmed',customerName:'QA cached booking',totalAmount:9999,downPaymentPaid:true,downPaymentAmount:100,timeSlot:'14:00',durationHours:1,tableId:h.tableId}]};
 const page=await analyticsPage(context,[{start:'2026-10-19',end:'2026-10-19'},true,'2026-10-19']);const button=page.nodes(page.render()).find(n=>n.type==='button'&&n.props.onClick?.name==='handleExportShiftCSV');assert.equal(button.props.disabled,false);button.props.onClick();
 const rows=JSON.parse(require('node:child_process').execFileSync('python3',['-c','import csv,sys,json;print(json.dumps(list(csv.reader(sys.stdin))))'],{input:await page.blobs[0].text(),encoding:'utf8'}));assert.equal(rows.length,2);assert.equal(rows[1][1],'Reservation');assert.equal(rows[1][5],'QA Historical table');assert.equal(rows[1][7],'125.25');assert.equal(rows[1][8],'25.25');assert.doesNotMatch(page.html(),/QA cached booking/);
});
