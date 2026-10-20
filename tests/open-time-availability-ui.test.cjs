const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),esbuild=require('esbuild'),Module=require('node:module');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const source=fs.readFileSync(path.resolve(__dirname,'../src/app/pages/Tables.tsx'),'utf8');
const now=Date.parse('2099-10-19T06:00:00.000Z'),limit='2099-10-19T08:00:00.000Z';
const data={tableId:'qa-table',type:'open',latestEndTime:limit,limitingReason:'reservation',operatingDate:'2099-10-19',scope:'saved-local-policy'};
const event={preventDefault(){}};
const paymentScope={};vm.runInNewContext(esbuild.transformSync(source.slice(source.indexOf('const reviewExtensionPayment ='),source.indexOf('type CustomerSource ='))+'\nglobalThis.review=reviewExtensionPayment;',{loader:'ts'}).code,paymentScope);
test('preview requires exact saved-local table/limit envelope, rejects past/foreign/invalid responses',async()=>{
 const {validateOpenTimeAvailability:v}=await import('../src/app/utils/openTimeAvailability.js');
 for(const limitingReason of ['closing','reservation','event','closure'])assert.equal(v({...data,limitingReason},'qa-table',now).limitingReason,limitingReason);
 for(const value of [{...data,tableId:'other'},{...data,scope:'cloud'},{...data,latestEndTime:'2099-10-19T08:00:00Z'},{...data,latestEndTime:new Date(now).toISOString()},{...data,limitingReason:'unknown'},{...data,operatingDate:'2099-02-30'},{...data,operatingDate:'2099-99-99'},{...data,extra:1},null])assert.throws(()=>v(value,'qa-table',now),/could not be confirmed/);
});
test('async preview discards owner/table changes during HTTP or body waits and expired slow replies',async()=>{
 const {loadOpenTimeAvailability:load}=await import('../src/app/utils/openTimeAvailability.js');
 let current=true,release;const response={ok:true,json:async()=>data};
 const first=load({tableId:'qa-table',now:()=>now,isCurrent:()=>current,request:()=>new Promise(r=>release=r)});current=false;release(response);await assert.rejects(first,/changed/);
 current=true;let bodyRelease;const second=load({tableId:'qa-table',now:()=>now,isCurrent:()=>current,request:async()=>({ok:true,json:()=>new Promise(r=>bodyRelease=r)})});await new Promise(r=>setImmediate(r));current=false;bodyRelease(data);await assert.rejects(second,/changed/);
 let time=now;await assert.rejects(load({tableId:'qa-table',now:()=>time,isCurrent:()=>true,request:async()=>{time+=30000;return response;}}),/expired/);
 await assert.rejects(load({tableId:'qa-table',now:()=>now,isCurrent:()=>true,request:async()=>({ok:false})}),/unavailable/);
});
test('reviewed preview expires at30s and cannot be reused by another owner or table snapshot',async()=>{
 const {reviewedOpenTimeLimit:read}=await import('../src/app/utils/openTimeAvailability.js');
 const owner={id:'qa-staff'},preview={value:data,reviewedAt:now,owner,tableKey:'available'};const context={tableId:'qa-table',owner,tableKey:'available',now:now+29999};
 assert.equal(read(preview,context),limit);
 for(const change of [{now:now+30000},{owner:{id:'qa-staff'}},{tableId:'other'},{tableKey:'occupied'},{now:now-1}])assert.throws(()=>read(preview,{...context,...change}),/Refresh|confirmed/);
});
function assignment(){
 const messages=[],requests=[],closed=[];
 const scope={Date,sessionInFlight:{current:false},assigningTableId:'qa-table',availableTables:[{id:'qa-table'}],customerName:'QA open',durationMinutes:'open',effectiveHourly:150,effectiveOvertime:300,rates:{},selectWalkInStartPricing:()=>({hourlyRate:150}),paymentOption:'payLater',amountPaid:'0',selectedCustomer:null,currentOpenLimit:()=>limit,assignTable:async(id,payload)=>requests.push({id,payload}),seatQueueCustomer:async(id,tableId,payload)=>requests.push({id,tableId,payload}),setAssigningTableId:value=>closed.push(value),setSelectedCustomer(){},setCustomerName(){},setDurationMinutes(){},setAmountPaid(){},setPaymentOption(){},setIsSavingSession(){},flash:(message,type)=>messages.push({message,type})};
 const code=source.slice(source.indexOf('  const handleAssign ='),source.indexOf('  const refreshPendingCheckout ='))+'\nglobalThis.handler=handleAssign;';vm.runInNewContext(esbuild.transformSync(code,{loader:'ts'}).code,scope);return{scope,messages,requests,closed};
}
test('actual Start handler submits reviewed cap for direct/queue open sessions; missing review retains form',async()=>{
 for(const queue of [false,true]){const h=assignment();h.scope.selectedCustomer=queue?{kind:'queue',id:'qa-queue'}:null;await h.scope.handler(event);assert.equal(h.requests[0].payload.latestEndTime,limit);assert.equal(h.requests[0].payload.durationMinutes,null);assert.equal(h.requests[0].payload.amountPaid,0);assert.equal(h.messages.at(-1).type,'success');}
 const h=assignment();h.scope.currentOpenLimit=()=>{throw Error('Refresh the limit');};await h.scope.handler(event);assert.equal(h.requests.length,0);assert.equal(h.closed.length,0);assert.equal(h.messages.at(-1).type,'error');
 h.scope.durationMinutes=60;h.scope.paymentOption='payNow';h.scope.amountPaid='150';await h.scope.handler(event);assert.equal(Object.hasOwn(h.requests[0].payload,'latestEndTime'),false);
});
test('actual convert handler passes reviewed cap, refuses expired review and leaves fixed extension untouched',async()=>{
 const calls=[],messages=[];const scope={reviewExtensionPayment:paymentScope.review,sessionInFlight:{current:false},extendingTableId:'qa-table',extendingTable:{session:{startTime:new Date(now),durationMinutes:60}},extendPayStatus:'unpaid',extendPayMethod:'cash',extendPartialAmount:'',extendCashTendered:'',extendGcashRef:'',extendCharge:0,extendMinutes:'open',currentOpenLimit:()=>limit,extendSession:async(...args)=>calls.push(args),setExtendingTableId(){},setIsSavingSession(){},flash:(message,type)=>messages.push(type)};
 const code=source.slice(source.indexOf('  const handleConfirmExtend ='),source.indexOf('  const handleAddToCart ='))+'\nglobalThis.handler=handleConfirmExtend;';vm.runInNewContext(esbuild.transformSync(code,{loader:'ts'}).code,scope);
 await scope.handler(event);assert.equal(calls[0][3],limit);scope.currentOpenLimit=()=>{throw Error('Expired');};await scope.handler(event);assert.equal(calls.length,1);assert.equal(messages.at(-1),'error');scope.extendMinutes=60;await scope.handler(event);assert.equal(calls[1][3],undefined);
});
const target=path.resolve(__dirname,'open-time-card.compiled.cjs');const result=esbuild.buildSync({entryPoints:[path.resolve(__dirname,'../src/app/components/TableCard.tsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});const compiled=new Module(target,module);compiled.filename=target;compiled.paths=module.paths;compiled._compile(result.outputFiles[0].text,target);
function card(session){return renderToStaticMarkup(React.createElement(compiled.exports.TableCard,{table:{id:'qa-table',name:'QA table',status:'occupied',isActive:true,session},nextReservation:null,onAssign(){},onExtend(){},onEnd(){},onOrder(){}}));}
test('actual card stops timer at saved limit, disables Extend while End and F&B stay available; legacy copy truthful',()=>{
 const start=new Date(Date.now()-7200000).toISOString(),end=new Date(Date.now()-3600000).toISOString();const session={customerName:'QA',startTime:start,latestEndTime:end,durationMinutes:null,isOpenTime:true,pricingVersion:1,orders:[]};const html=card(session);
 assert.match(html,/Play stopped/);assert.match(html,/>01:00:00</);assert.match(html,/Play limit reached/);assert.match(html,/<button[^>]*disabled=""[^>]*>.*?Extend/s);for(const label of ['Add F&amp;B Orders','End']){const match=[...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].find(m=>m[2].includes(label));assert.ok(match,label);assert.doesNotMatch(match[1],/disabled/);}
 assert.match(card({...session,latestEndTime:undefined}),/Legacy open time: no saved stop limit/);assert.doesNotMatch(card({...session,latestEndTime:undefined}),/Play stopped/);
 assert.match(card({...session,latestEndTime:new Date(Date.now()+3600000).toISOString()}),/Manila/);
});
async function modal(){
 const helper=await import('../src/app/utils/openTimeAvailability.js');let hooks=[],cursor=0,pendingEffects=[];const requests=[],saves=[],timers=[];
 const table={id:'qa-table',name:'QA table',status:'available',isActive:true,session:null};
 const context={tables:[table],availableTables:[table],heldTableIds:new Set(),queue:[],reservations:[],inventory:[],pendingReservationMoves:[],reservationMoveError:'',staffProfile:{id:'qa-staff'},rates:{hourlyRate:150,overtimeRate:300,isWeekdayHappyHourActive:false,isWeekendHappyHourActive:false},reservationTerms:{maxHours:8},assignTable:async(id,session)=>saves.push({id,session}),addActivity(){}};
 const react={...React,useState(initial){const n=cursor++;if(!(n in hooks))hooks[n]=typeof initial==='function'?initial():initial;return[hooks[n],value=>{hooks[n]=typeof value==='function'?value(hooks[n]):value;}];},useRef(initial){const n=cursor++;if(!(n in hooks))hooks[n]={current:initial};return hooks[n];},useEffect(callback,deps){const n=cursor++,old=hooks[n];if(!old||!deps||deps.some((d,i)=>d!==old.deps[i])){old?.cleanup?.();hooks[n]={deps};pendingEffects.push(()=>{hooks[n].cleanup=callback();});}}};
 const child=()=>null,compiled={exports:{}};const localRequire=Module.createRequire(path.resolve(__dirname,'../src/app/pages/Tables.tsx'));
 const scope={module:compiled,exports:compiled.exports,Date,console,setTimeout:()=>0,clearTimeout(){},setInterval:callback=>{timers.push(callback);return 0;},clearInterval(){},localStorage:{length:0,getItem:()=>null},require:name=>name==='react'?react:name==='../context/AppContext'?{useAppContext:()=>context}:name==='../utils/localApi'?{localFetch:url=>new Promise(resolve=>requests.push({url,resolve}))}:name==='../utils/openTimeAvailability.js'?helper:name.startsWith('../components/')?{TableCard:child,PendingReservationMoves:child,PendingQueueActions:child}:localRequire(name)};
 vm.runInNewContext(esbuild.transformSync(source,{loader:'tsx',format:'cjs',jsx:'automatic'}).code,scope);
 const render=()=>{cursor=0;const tree=compiled.exports.Tables();for(const effect of pendingEffects.splice(0))effect();return tree;};
 const nodes=(node,result=[])=>{if(node&&typeof node==='object'){result.push(node);React.Children.forEach(node.props?.children,child=>nodes(child,result));}return result;};
 const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node?.props?text(node.props.children):'';
 const find=predicate=>{const node=nodes(render()).find(predicate);assert.ok(node);return node;};
 return{context,requests,saves,render,text,find,child,flush:()=>new Promise(r=>setImmediate(r))};
}
test('actual start modal shows saved Manila limit, keeps Open Time selectable with eight-hour fixed maximum, and waits for current-owner preview',async()=>{
 const h=await modal();h.find(n=>n.type===h.child&&n.props.table).props.onAssign();h.render();
 h.find(n=>n.type==='input'&&n.props.placeholder==='Enter customer name').props.onChange({target:{value:'QA modal'}});
 h.find(n=>n.type==='select'&&n.props.value===60).props.onChange({target:{value:'open'}});
 assert.equal(h.find(n=>n.type==='option'&&n.props.value==='open').props.disabled,undefined);
 assert.equal(h.find(n=>n.type==='button'&&h.text(n).includes('Start Timer')).props.disabled,true);
 assert.equal(h.requests.length,1);assert.match(h.requests[0].url,/qa-table\/availability\?type=open/);
 // An old account's response must not make Start available under a new staff identity.
 h.context.staffProfile={id:'qa-other'};h.render();h.requests[0].resolve({ok:true,json:async()=>data});await h.flush();
 assert.equal(h.find(n=>n.type==='button'&&h.text(n).includes('Start Timer')).props.disabled,true);
 h.requests[1].resolve({ok:true,json:async()=>data});await h.flush();
 assert.match(h.text(h.render()),/Manila \(reservation\).*Saved local schedule/);
 assert.equal(h.find(n=>n.type==='button'&&h.text(n).includes('Start Timer')).props.disabled,false);
 await h.find(n=>n.type==='form').props.onSubmit(event);assert.equal(h.saves.length,1);assert.equal(h.saves[0].session.latestEndTime,limit);
});

test('stop indicator requires the same valid v1 snapshot as billing and never invents a cap for malformed or legacy sessions',async()=>{
 const {openTimeStop:stop}=await import('../src/app/utils/openTimeAvailability.js');const session={pricingVersion:1,isOpenTime:true,startTime:'2099-10-19T06:00:00.000Z',latestEndTime:limit};assert.equal(stop(session,Date.parse(limit)).reached,true);for(const change of [{pricingVersion:undefined},{pricingVersion:2},{startTime:'invalid'},{latestEndTime:session.startTime},{isOpenTime:false}])assert.equal(stop({...session,...change},now),null);assert.equal(stop(session,NaN),null);
});
