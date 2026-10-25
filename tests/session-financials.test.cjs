const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const express=require('express'),sqlite3=require('sqlite3');
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
function record(id='qa-bill', overrides={}) {
 const h={id,customerName:'QA Synthetic',tableId:'qa-table',tableName:'QA table',startTime:'2026-10-19T06:00:00.000Z',endTime:'2026-10-19T07:00:00.000Z',durationMinutes:60,totalAmount:100,amountPaid:40,orders:[]};
 const r={id,receipt_no:id,reservation_id:null,customer_name:h.customerName,table_id:h.tableId,table_name:h.tableName,play_start_time:h.startTime,play_end_time:h.endTime,duration_minutes:60,table_charge:100,overtime_charge:0,fnb_charge:0,subtotal:100,discount_amount:0,total_amount:100,amount_paid:40,balance_due:60,refund_due:0,refund_status:'none',payment_status:'partial',void_reason:null,...overrides};
 return {...h,receipt:r};
}
test('receipt-backed totals count session once, keep paid/debt/returns distinct and exclude unknown or corrupt legacy money',async()=>{
 const {summarizeSessionFinancials,sessionFinancials}=await import('../src/app/utils/sessionFinancials.js');
 const partial=record(),pendingReturn=record('qa-return',{amount_paid:100,balance_due:0,refund_due:25,refund_status:'pending',payment_status:'refund_pending'});
 const returned=record('qa-returned',{amount_paid:100,balance_due:0,refund_due:30,refund_status:'returned',payment_status:'refund_pending'});
 const voided=record('qa-void',{discount_amount:100,total_amount:0,amount_paid:0,balance_due:0,refund_due:40,refund_status:'pending',payment_status:'voided_refund_pending'});
 const missing={...record('qa-legacy'),receipt:null},corrupt=record('qa-corrupt',{amount_paid:70,balance_due:60}),wrongOwner=record('qa-wrong',{customer_name:'Different identity'});
 assert.equal(sessionFinancials(corrupt),null);assert.equal(sessionFinancials(wrongOwner),null);
 assert.deepEqual(summarizeSessionFinancials([partial,pendingReturn,returned,voided,missing,corrupt,wrongOwner]),{billedCents:30000,appliedCents:24000,outstandingCents:6000,pendingReturnCents:6500,returnedCents:3000,verifiedCount:4,reviewCount:3});
 assert.deepEqual(summarizeSessionFinancials([partial,partial]),{billedCents:0,appliedCents:0,outstandingCents:0,pendingReturnCents:0,returnedCents:0,verifiedCount:0,reviewCount:2});
});
test('actual history HTTP route projects same-ID saved receipt from SQLite; missing receipts stay explicitly null',async t=>{
 const db=new sqlite3.Database(':memory:');const h=record(),r=h.receipt;delete h.receipt;
 await run(db,'CREATE TABLE session_history ('+Object.keys(h).map(k=>'"'+k+'" '+(typeof h[k]==='number'?'REAL':'TEXT')).join(',')+')');
 await run(db,'CREATE TABLE e_receipts ('+Object.keys(r).map(k=>'"'+k+'" '+(typeof r[k]==='number'?'REAL':'TEXT')).join(',')+')');
 await run(db,'INSERT INTO session_history VALUES('+Object.keys(h).map(()=>'?').join(',')+')',Object.entries(h).map(([k,v])=>k==='orders'?JSON.stringify(v):v));
 await run(db,'INSERT INTO e_receipts VALUES('+Object.keys(r).map(()=>'?').join(',')+')',Object.values(r));
 await run(db,"INSERT INTO session_history(id,endTime,orders) VALUES('qa-legacy','2026-10-19T08:00:00.000Z','[]')");
 const app=express(),source=fs.readFileSync(require.resolve('../server.cjs'),'utf8'),a=source.indexOf("app.get('/api/session-history',"),z=source.indexOf("app.get('/api/e-receipts/:id',",a);
 vm.runInNewContext(source.slice(a,z),{app,db,safeParseJSON:(v,f)=>{try{return JSON.parse(v)}catch{return f}}});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(async()=>{await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));});
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/session-history');assert.equal(response.status,200);const rows=await response.json();
 assert.equal(rows.find(x=>x.id==='qa-legacy').receipt,null);assert.deepEqual(rows.find(x=>x.id===h.id).receipt,r);
 const {summarizeSessionFinancials}=await import('../src/app/utils/sessionFinancials.js');assert.equal(summarizeSessionFinancials(rows).billedCents,10000);assert.equal(summarizeSessionFinancials(rows).reviewCount,1);
});

test('rendered dashboard and analytics use receipt money once and label actual floor occupancy',async()=>{
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),esbuild=require('esbuild');
 const finance=await import('../src/app/utils/sessionFinancials.js'),csv=await import('../src/app/utils/csvExport.js');
 const h=record();
 const context={staffUsers:[],tables:[{id:'qa-table',name:'QA table',status:'occupied',isActive:true},{id:'qa-free',name:'QA free',status:'available',isActive:true},{id:'qa-maint',name:'QA maintenance',status:'maintenance',isActive:false}],promoCodes:[],announcements:[],closedDates:[],rates:{},reservations:[{id:'same-booking',status:'completed',totalAmount:1000,date:'2026-10-19'}],feedback:[],weather:null,activities:[],sessionHistory:[h],queue:[],watchlist:[],availableTables:[],pendingReservationMoves:[],pendingQueueOperations:[]};
 function load(file,component){const exports={};const scope={module:{exports},exports,require:name=>name==='../context/AppContext'?{useAppContext:()=>context}:name==='../utils/sessionFinancials.js'?finance:name==='../utils/csvExport.js'?csv:name==='../utils/localApi'?{localFetch:()=>{throw Error('SSR must not fetch');}}:name==='react-router'?{useNavigate:()=>()=>{}}:name==='../components/PesoSign'?{PesoSign:()=>React.createElement('span',null,'₱')}:require(name)};vm.runInNewContext(esbuild.transformSync(fs.readFileSync(require.resolve('../src/app/pages/'+file),'utf8'),{loader:'tsx',format:'cjs',jsx:'automatic'}).code,scope);return renderToStaticMarkup(React.createElement(scope.module.exports[component]));}
 const dashboard=load('AdminDashboard.tsx','AdminDashboard');assert.match(dashboard,/Session Bills/);assert.match(dashboard,/₱100/);assert.doesNotMatch(dashboard,/₱1,100/);assert.match(dashboard,/Outstanding ₱60/);
 const analytics=load('Analytics.tsx','Analytics');assert.match(analytics,/Live Occupancy/);assert.match(analytics,/50%/);assert.match(analytics,/Number of session starts by hour/);assert.doesNotMatch(analytics,/Estimated table occupancy|Avg Occupancy|Total Revenue/);assert.match(analytics,/Pending prepaid returns/);
});
