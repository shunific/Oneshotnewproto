import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { loadCustomerFinalReceipt, validateCustomerFinalReceipt, finalReceiptWindow } from './customerFinalReceipts.js';
const owner='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',claim='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',event='cccccccc-cccc-4ccc-8ccc-cccccccccccc',reservation='QA-FINAL-1';
function row({prior=60,collected=265,voided=false}={}){
 const total=voided?0:325,paid=Math.min(total,prior+collected),balance=total-paid,refund=Math.max(0,prior-total);
 const status=voided?refund?'voided_refund_pending':'voided':refund?'refund_pending':balance===0?'paid':paid>0?'partial':'unpaid';
 const receipt={id,receipt_no:'REC-'+id,reservation_id:reservation,reservation_claim_id:claim,owner_user_id:owner,pricing_version:2,table_rate:null,customer_name:'QA Owner',table_id:'LOCAL-1',table_name:'QA Table',play_start_time:'2026-10-19T06:00:00.000Z',play_end_time:'2026-10-19T08:00:00.000Z',created_at:'2026-10-19T08:00:00.000Z',duration_minutes:120,overtime_minutes:0,overtime_rate:300,table_charge:350,booking_discount_amount:50,overtime_charge:0,fnb_charge:25,subtotal:375,discount_amount:voided?375:50,original_amount:325,total_amount:total,amount_paid:paid,balance_due:balance,refund_due:refund,payment_status:status,refund_status:refund?'pending':'none',payment_method:'cash',void_reason:voided?'QA correction':null};
 return{receiptId:id,claimId:claim,eventId:event,reservationId:reservation,ownerUserId:owner,receipt,history:{id,customerName:'QA Owner',tableId:'LOCAL-1',tableName:'QA Table',startTime:receipt.play_start_time,endTime:receipt.play_end_time,durationMinutes:120,totalAmount:total,amountPaid:paid,orders:[{id:'water',name:'QA Water',price:25,qty:1}],status:voided?'voided':refund?'refund_pending':'completed'},settlement:{originalVerifiedBookingCreditCents:prior*100,nativeCollectedNowCents:collected*100,grandTotalCents:total*100,remainingCents:balance*100,refundDueCents:refund*100,bookingFullyCovered:!voided&&balance===0,allocation:voided?'voided':balance===0?'full-bill-settled':'unallocated-partial'},acceptedAt:'2026-10-19T08:00:01.000Z'};
}
function client(records=[row()]){
 const state={owner,error:null,calls:[],verified:true,anonymous:false};
 return{state,auth:{getUser:async()=>({data:{user:state.owner?{id:state.owner,email_confirmed_at:state.verified?'2026-10-01':null,is_anonymous:state.anonymous}:null},error:null})},rpc:async(name,args)=>{state.calls.push({name,args});return{data:{receipts:records,recordType:'owner-linked-final-receipt',fundsTransferred:false},error:state.error};}};
}
const request={ownerId:owner,reservationId:reservation,date:'2026-10-19'};
test('owner loader uses only the authenticated final-receipt RPC and validates paid itemized money separately from booking proof',async()=>{
 const c=client();const receipt=await loadCustomerFinalReceipt(c,request);assert.equal(receipt.receiptId,id);assert.equal(receipt.totalCents,32500);assert.equal(receipt.allocatedPaidCents,32500);assert.equal(receipt.originalVerifiedCreditCents,6000);assert.equal(receipt.collectedAtCheckoutCents,26500);assert.deepEqual(receipt.orders,[{id:'water',name:'QA Water',quantity:1,unitCents:2500,totalCents:2500}]);assert.deepEqual(c.state.calls,[{name:'oneshot_customer_final_receipts',args:{p_from:'2026-10-19',p_to:'2027-01-20'}}]);assert.equal(receipt.receiptImg,undefined);
});
test('partial/unpaid, zero-credit and void/refund receipts preserve saved allocation without inventing cash/change or refund return',()=>{
 for(const options of [{prior:60,collected:100},{prior:0,collected:0},{prior:0,collected:325},{prior:400,collected:0},{prior:60,collected:0,voided:true},{prior:0,collected:0,voided:true}]){const raw=row(options),receipt=validateCustomerFinalReceipt(raw,owner,reservation);assert.equal(receipt.remainingCents,raw.settlement.remainingCents);assert.equal(receipt.refundDueCents,raw.settlement.refundDueCents);assert.equal(receipt.allocatedPaidCents,Math.round(raw.receipt.amount_paid*100));assert.equal(receipt.tendered,undefined);assert.equal(receipt.change,undefined);}
});
test('cross-owner and mismatched reservation/claim/receipt/history bindings fail closed',async()=>{
 for(const mutate of [r=>r.ownerUserId=other,r=>r.receipt.owner_user_id=other,r=>r.receipt.reservation_id='OTHER',r=>r.receipt.reservation_claim_id=event,r=>r.history.id=claim,r=>r.history.tableId='OTHER',r=>r.history.customerName='OTHER_PRIVATE_CUSTOMER',r=>r.receipt.receipt_no='REC-OTHER']){const raw=row();mutate(raw);await assert.rejects(loadCustomerFinalReceipt(client([raw]),request),/verified/);}
 const c=client([row(),{...row(),ownerUserId:other,reservationId:'OTHER'}]);await assert.rejects(loadCustomerFinalReceipt(c,request));
});
test('tampered totals, credit, refund, order prices/types, overflow and nested JSON shapes cannot render a final receipt',()=>{
 for(const mutate of [r=>r.receipt.total_amount+=0.01,r=>r.settlement.nativeCollectedNowCents++,r=>r.settlement.originalVerifiedBookingCreditCents++,r=>r.receipt.discount_amount++,r=>r.receipt.amount_paid++,r=>r.receipt.balance_due++,r=>r.history.orders[0].price=26,r=>r.history.orders[0].qty=2,r=>r.history.orders[0].qty=Number.MAX_SAFE_INTEGER,r=>r.history.orders[0].price='25',r=>r.receipt.subtotal=[],r=>r.settlement.bookingFullyCovered='true',r=>r.settlement.refundDueCents=1,r=>r.receipt.duration_minutes=119,r=>r.receipt.overtime_charge=1,r=>r.history.orders={},r=>r.receipt=null,r=>r.history=null,r=>r.settlement=null]){const raw=row();mutate(raw);assert.throws(()=>validateCustomerFinalReceipt(raw,owner,reservation));}
});
test('auth failure, anonymous/unverified users and stale identity stop results; missing/failed RPC stays unavailable',async()=>{
 for(const update of [{owner:null},{owner:other},{anonymous:true},{verified:false}]){const c=client();Object.assign(c.state,update);await assert.rejects(loadCustomerFinalReceipt(c,request));assert.equal(c.state.calls.length,0);}
 const switched=client();switched.rpc=async()=>{switched.state.owner=other;return{data:{receipts:[row()],recordType:'owner-linked-final-receipt',fundsTransferred:false},error:null};};await assert.rejects(loadCustomerFinalReceipt(switched,request));
 let current=true;const stale=client();const original=stale.rpc;stale.rpc=async(...args)=>{const result=await original(...args);current=false;return result;};await assert.rejects(loadCustomerFinalReceipt(stale,{...request,isCurrent:()=>current}),/changed/);
 const failed=client();failed.state.error={code:'PGRST202',message:'PRIVATE_DATABASE_DETAIL'};await assert.rejects(loadCustomerFinalReceipt(failed,request),error=>!/PRIVATE_DATABASE_DETAIL/.test(error.message));assert.equal(await loadCustomerFinalReceipt(client([]),request),null);
});
test('duplicate or forged RPC envelopes and invalid date ranges fail closed',async()=>{
 await assert.rejects(loadCustomerFinalReceipt(client([row(),row()]),request));
 for(const data of [null,[],{receipts:[],recordType:'payment-proof',fundsTransferred:false},{receipts:[],recordType:'owner-linked-final-receipt',fundsTransferred:true}]){const c=client();c.rpc=async()=>({data,error:null});await assert.rejects(loadCustomerFinalReceipt(c,request));}
 assert.throws(()=>finalReceiptWindow('2026-02-30'));assert.deepEqual(finalReceiptWindow(new Date('2026-10-19T00:00:00Z')),{p_from:'2026-10-19',p_to:'2027-01-20'});
});
const require=createRequire(import.meta.url),React=require('react'),esbuild=require('esbuild'),{renderToStaticMarkup}=require('react-dom/server');
const componentSource=fs.readFileSync(new URL('../components/CustomerFinalReceipt.tsx',import.meta.url),'utf8');
function componentFixture(c,ownerId=owner){
 let hooks=[],cursor=0,effects=[];const fakeReact={...React,useState:initial=>{const n=cursor++;if(!(n in hooks))hooks[n]=initial;return[hooks[n],value=>{hooks[n]=typeof value==='function'?value(hooks[n]):value;}];},useRef:initial=>{const n=cursor++;if(!(n in hooks))hooks[n]={current:initial};return hooks[n];},useEffect:(effect,deps)=>{const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]?.cleanup?.();hooks[n]={deps};effects.push(()=>hooks[n].cleanup=effect());}}};
 let authCallback;const props={client:{...c,auth:{...c.auth,onAuthStateChange:callback=>{authCallback=callback;return{data:{subscription:{unsubscribe(){}}}};}}},booking:{id:reservation,date:'2026-10-19',customer_user_id:owner,status:'completed'},ownerId};
 const scope={module:{exports:{}},exports:{},Error,require:name=>name==='react'?fakeReact:name==='../utils/customerFinalReceipts'?{loadCustomerFinalReceipt}:name==='../utils/bookingPaymentSummary'?{formatPesos:value=>'PHP '+value.toFixed(2)}:require(name)};vm.runInNewContext(esbuild.transformSync(componentSource,{loader:'tsx',format:'cjs',jsx:'automatic'}).code,scope);
 const render=()=>{cursor=0;const tree=scope.module.exports.CustomerFinalReceipt(props);for(const effect of effects.splice(0))effect();return tree;};const html=()=>renderToStaticMarkup(render());const button=()=>React.Children.toArray(render()?.props.children).find(n=>n.type==='button');
 return{props,render,html,load:()=>button().props.onClick(),auth:(...args)=>authCallback(...args),renderDetails:receipt=>renderToStaticMarkup(React.createElement(scope.module.exports.FinalReceiptDetails,{receipt}))};
}
test('actual receipt component exposes itemized totals and honest partial/void/refund labels without payment proof/cash inventions',()=>{
 const f=componentFixture(client());for(const options of [{},{prior:60,collected:100},{prior:400,collected:0},{prior:60,collected:0,voided:true}]){const html=f.renderDetails(validateCustomerFinalReceipt(row(options),owner,reservation));assert.match(html,/Final itemized receipt/);assert.match(html,/QA Water/);assert.match(html,/Booked table charge/);assert.match(html,/Amount applied to bill/);assert.match(html,/Cloud accepted/);assert.doesNotMatch(html,/TENDERED|CHANGE|Payment proof|Refund returned/);if(options.voided)assert.match(html,/Void waiver/);if(options.prior===400||options.voided)assert.match(html,/Refund due at checkout/);}
});
test('visible owned booking component clears private results on auth failure/account switch and shows pending until accepted completion exists',async()=>{
 const c=client(),f=componentFixture(c);f.render();await f.load();assert.match(f.html(),/REC-aaaaaaaa/);f.auth('SIGNED_OUT',null);assert.doesNotMatch(f.html(),/REC-aaaaaaaa|QA Water/);await f.load();f.props.ownerId=other;assert.doesNotMatch(f.html(),/REC-aaaaaaaa|QA Water|View Final Receipt/);
 const pending=componentFixture(client([]));pending.render();await pending.load();assert.match(pending.html(),/Final receipt pending/);assert.doesNotMatch(pending.html(),/Cloud accepted/);
 const failedClient=client(),failed=componentFixture(failedClient);failed.render();await failed.load();failedClient.state.owner=null;await failed.load();assert.doesNotMatch(failed.html(),/REC-aaaaaaaa|QA Water/);assert.match(failed.html(),/Sign in with the verified account/);
});
test('HomePage ships visible final receipt access inside the owned booking list',()=>{const home=fs.readFileSync(new URL('../pages/HomePage.tsx',import.meta.url),'utf8');assert.match(home,/<CustomerFinalReceipt client=\{supabase\} booking=\{r\} ownerId=\{currentUser\?\.id \|\| null\}/);assert.match(home,/View Booking Summary/);});

test('three-minute overtime and fully discounted booking retain exact final cents and booking coverage semantics',()=>{
 const overtime=row({prior:60,collected:280});Object.assign(overtime.receipt,{play_end_time:'2026-10-19T08:03:00.000Z',created_at:'2026-10-19T08:03:00.000Z',duration_minutes:123,overtime_minutes:3,overtime_charge:15,subtotal:390,original_amount:340,total_amount:340,amount_paid:340});Object.assign(overtime.history,{endTime:overtime.receipt.play_end_time,durationMinutes:123,totalAmount:340,amountPaid:340,status:'completed_overtime'});overtime.settlement.grandTotalCents=34000;assert.equal(validateCustomerFinalReceipt(overtime,owner,reservation).overtimeCents,1500);
 const free=row({prior:0,collected:25});Object.assign(free.receipt,{booking_discount_amount:350,discount_amount:350,original_amount:25,total_amount:25,amount_paid:25,balance_due:0,payment_status:'paid'});Object.assign(free.history,{totalAmount:25,amountPaid:25});Object.assign(free.settlement,{grandTotalCents:2500,remainingCents:0,bookingFullyCovered:false,allocation:'full-bill-settled'});assert.equal(validateCustomerFinalReceipt(free,owner,reservation).totalCents,2500);
});
test('in-flight receipt results cannot reappear after sign-out or a changed owned booking',async()=>{
 let resolveRpc;const c=client();c.rpc=()=>new Promise(resolve=>{resolveRpc=resolve;});const f=componentFixture(c);f.render();const pending=f.load();for(let n=0;n<10&&!resolveRpc;n++)await Promise.resolve();assert.ok(resolveRpc);f.auth('SIGNED_OUT',null);resolveRpc({data:{receipts:[row()],recordType:'owner-linked-final-receipt',fundsTransferred:false},error:null});await pending;assert.doesNotMatch(f.html(),/REC-aaaaaaaa|QA Water|Cloud accepted/);
});

test('actual native SQLite → staff-JWT local PostgreSQL customer RPC sample validates and renders without contract adaptation',async()=>{
 const sample=JSON.parse(fs.readFileSync(new URL('./fixtures/customer-final-receipt-pg.json',import.meta.url),'utf8')),saved=sample.receipts[0];
 const c=client(sample.receipts);c.state.owner=saved.ownerUserId;const receipt=await loadCustomerFinalReceipt(c,{ownerId:saved.ownerUserId,reservationId:saved.reservationId,date:'2026-10-19'});assert.equal(receipt.receiptId,saved.receiptId);assert.equal(receipt.totalCents,22600);assert.equal(receipt.allocatedPaidCents,22600);assert.equal(receipt.remainingCents,0);assert.equal(receipt.orders.length,1);const html=componentFixture(c).renderDetails(receipt);assert.match(html,/QA proof drink/);assert.match(html,/Final itemized receipt/);assert.match(html,/PHP 226.00/);
});
