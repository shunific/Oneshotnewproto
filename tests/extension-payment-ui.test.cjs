const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),esbuild=require('esbuild'),express=require('express'),sqlite3=require('sqlite3');
const {mkdtemp,rm}=require('node:fs/promises');
const source=fs.readFileSync(path.resolve(__dirname,'../src/app/pages/Tables.tsx'),'utf8'),provider=fs.readFileSync(path.resolve(__dirname,'../src/app/context/AppContext.tsx'),'utf8');
const scope={};vm.runInNewContext(esbuild.transformSync(source.slice(source.indexOf('const reviewExtensionPayment ='),source.indexOf('type CustomerSource ='))+'\nglobalThis.review=reviewExtensionPayment;',{loader:'ts'}).code,scope);const review=scope.review;
const run=(db,sql,args=[])=>new Promise((r,j)=>db.run(sql,args,e=>e?j(e):r()));
const all=(db,sql)=>new Promise((r,j)=>db.all(sql,(e,rows)=>e?j(e):r(rows)));
const event={preventDefault(){}};
test('extension payment review rejects malformed/overfull partial amounts and matches backend GCash reference syntax',()=>{
 for(const amount of ['', 'abc','50abc','1e2','0','-5','25.001','100','101','Infinity'])assert.throws(()=>review(60,'partial','cash',100,amount,'',''),/payment|Partial/);
 assert.equal(review(60,'partial','cash',100,'25.50','','').amount,25.5);
 for(const ref of ['AB','---','AB!12','A'.repeat(121),'A B'])assert.throws(()=>review(60,'paid','gcash',100,'','',ref),/GCash/);
 const result=review(60,'paid','gcash',100,'','',' AB-123 45 ');assert.equal(result.payment.reference,'AB-123 45');assert.equal(result.amount,100);
 assert.throws(()=>review(60,'paid','cash',100,'','99.99',''),/cover/);
 assert.equal(review(60,'paid','cash',100,'','150.00','').amount,100);
 for(const [mins,status]of [[60,'unpaid'],['open','unpaid']]){const result=review(mins,status,'gcash',100,'invalid','invalid','invalid');assert.equal(result.amount,0);assert.equal(result.payment.method,'cash');assert.equal(Object.hasOwn(result.payment,'reference'),false);}
});
async function fixture(t){
 const folder=await mkdtemp(path.join(os.tmpdir(),'oneshot-extension-ui-')),file=path.join(folder,'qa.db');const db=await new Promise((r,j)=>{const d=new sqlite3.Database(file,e=>e?j(e):r(d));});
 await run(db,'CREATE TABLE tables (id TEXT PRIMARY KEY,status TEXT,isActive INTEGER,sessionData TEXT)');
 const session={customerName:'QA extension',startTime:'2026-10-19T08:00:00.000Z',durationMinutes:60,isOpenTime:false,hourlyRate:100,overtimeRate:200,pricingVersion:1,amountPaid:0,isPaid:false,orders:[]};
 await run(db,"INSERT INTO tables VALUES('qa-table','occupied',1,?)",[JSON.stringify(session)]);await require('./venue-fixture.cjs').seedVenue(db);
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.staff={id:'qa-extension-staff'};next();});await require('../server-session-state.cjs').registerSessionStateRoutes(app,file,{now:()=>Date.parse('2026-10-19T08:30:00.000Z'),resolveActor:async()=>({localStaffId:'qa-extension-staff'}),isActorCurrent:()=>true}).ready;
 const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});t.after(async()=>{await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));await rm(folder,{recursive:true,force:true});});
 const persistence=await import('../src/app/utils/sessionPersistence.js'),map=new Map(),storage={get length(){return map.size;},key:index=>[...map.keys()][index],getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};
 const state={tables:[{id:'qa-table',session}],requests:[],lose:false,retry:null,activities:[],messages:[],closed:false};
 const providerScope={Error,localStorage:storage,...persistence,crypto:require('node:crypto'),toast:{warning:(_message,options)=>{state.retry=options.action.onClick;},error(){}},addActivity:(...args)=>state.activities.push(args),forceFullSync:async()=>{const [row]=await all(db,"SELECT * FROM tables WHERE id='qa-table'");state.tables=[{id:'qa-table',session:JSON.parse(row.sessionData)}];},syncToDB:async(endpoint,method,body)=>{
   state.requests.push(JSON.parse(JSON.stringify(body)));const response=await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(response.status>=400)throw Object.assign(Error(value.error),{status:response.status,response:value});if(state.lose){state.lose=false;throw Error('Synthetic lost committed reply');}return value;
 }};providerScope.toast.dismiss=()=>{};Object.defineProperty(providerScope,'tables',{get:()=>state.tables});
 const code=provider.slice(provider.indexOf('  const persistSessionChange ='),provider.indexOf('  const migrateSession ='))+'\nglobalThis.extend=extendSession;globalThis.resume=remindPendingSessions;';vm.runInNewContext(esbuild.transformSync(code,{loader:'ts'}).code,providerScope);
 const handlerScope={reviewExtensionPayment:review,sessionInFlight:{current:false},extendingTableId:'qa-table',extendingTable:{session},extendMinutes:60,extendPayStatus:'paid',extendPayMethod:'gcash',extendCharge:100,extendPartialAmount:'',extendCashTendered:'',extendGcashRef:' QA-123 45 ',extendSession:providerScope.extend,setIsSavingSession(){},setExtendingTableId:()=>{state.closed=true;},flash:(message,type)=>state.messages.push({message,type})};
 const handlerCode=source.slice(source.indexOf('  const handleConfirmExtend ='),source.indexOf('  const handleAddToCart ='))+'\nglobalThis.handler=handleConfirmExtend;';vm.runInNewContext(esbuild.transformSync(handlerCode,{loader:'ts'}).code,handlerScope);
 return{state,handlerScope,submit:()=>handlerScope.handler(event),storage,restartClient:()=>{const next={...providerScope};Object.defineProperty(next,'tables',{get:()=>state.tables});vm.runInNewContext(esbuild.transformSync(code,{loader:'ts'}).code,next);state.retry=null;next.resume();},rows:table=>all(db,'SELECT * FROM '+table),readSession:async()=>JSON.parse((await all(db,'SELECT sessionData FROM tables'))[0].sessionData)};
}
test('actual extension handler→provider→HTTP/SQLite saves selected GCash reference and exact credit',async t=>{
 const f=await fixture(t);await f.submit();assert.equal(f.state.closed,true);assert.equal(f.state.messages.at(-1).type,'success');const [payment]=await f.rows('session_payments');assert.equal(payment.payment_method,'gcash');assert.equal(payment.payment_reference,'QA-123 45');assert.equal(payment.amount,100);assert.equal((await f.readSession()).amountPaid,100);assert.equal((await f.readSession()).durationMinutes,120);assert.equal(f.storage.length,0);
});
test('lost committed extension reply retains original GCash payment across changed form and retry without double-credit',async t=>{
 const f=await fixture(t);f.state.lose=true;await f.submit();assert.equal(f.state.closed,false);assert.equal(f.state.messages.at(-1).type,'error');assert.equal(f.storage.length,1);assert.equal((await f.rows('session_payments')).length,1);const original=JSON.stringify(f.state.requests[0]);
 f.handlerScope.extendPayMethod='cash';f.handlerScope.extendCashTendered='150';await f.submit();assert.equal(f.state.requests.length,1);assert.equal(f.storage.length,1);assert.equal(f.state.closed,false);
 f.restartClient();assert.equal(typeof f.state.retry,'function');f.state.retry();await new Promise((resolve,reject)=>{let n=0;const tick=async()=>{if(f.storage.length===0)return resolve();if(n++>100)return reject(Error('Retry not completed'));setTimeout(tick,5);};tick();});
 assert.equal(JSON.stringify(f.state.requests[1]),original);assert.equal((await f.rows('session_payments')).length,1);assert.equal((await f.readSession()).amountPaid,100);assert.equal((await f.readSession()).durationMinutes,120);
});
test('partial cash credits only confirmed amount, invalid partial cannot dispatch, and unpaid creates no payment row',async t=>{
 for(const mode of ['partial','unpaid']){const f=await fixture(t);f.handlerScope.extendPayStatus=mode;f.handlerScope.extendPayMethod='cash';f.handlerScope.extendPartialAmount='25.50';if(mode==='partial'){f.handlerScope.extendPartialAmount='25abc';await f.submit();assert.equal(f.state.requests.length,0);assert.equal((await f.rows('session_payments')).length,0);f.handlerScope.extendPartialAmount='25.50';}await f.submit();assert.equal(f.state.closed,true);assert.equal((await f.readSession()).amountPaid,mode==='partial'?25.5:0);assert.equal((await f.rows('session_payments')).length,mode==='partial'?1:0);if(mode==='partial')assert.equal((await f.rows('session_payments'))[0].payment_reference,null);}
});
test('open-time explanatory text matches block billing and requires manual checkout',()=>{assert.doesNotMatch(source,/billed automatically.*exact time played/);assert.match(source,/one-hour minimum, then half-hour billing blocks/);assert.match(source,/Staff must open checkout to collect payment and end the session/);});
