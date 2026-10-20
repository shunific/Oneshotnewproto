const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const esbuild=require('esbuild');
const {selectWalkInStartPricing}=require('../session-billing.mjs');
const source=fs.readFileSync(require.resolve('../src/app/pages/Tables.tsx'),'utf8');
const handlers=source.slice(source.indexOf('  const confirmCheckout ='),source.indexOf('  const handleConfirmExtend ='));
const code=esbuild.transformSync(handlers+'\nglobalThis.handlers={confirmCheckout,handleConfirmEnd,handleWalkout};',{loader:'ts'}).code;
function harness(checkoutTable){
 const calls={receipt:[],ending:[],messages:[],busy:[]};
 const snapshot={startTime:'2026-10-19T08:00:00Z',isOpenTime:false,durationMinutes:120,orders:[{id:'a',qty:1,price:25}]};
 const context={checkoutTable,checkoutInFlight:{current:false},setIsSavingCheckout:v=>calls.busy.push(v),setCompletedReceipt:v=>calls.receipt.push(v),setEndingTableId:v=>calls.ending.push(v),setEndingSessionSnapshot:()=>{},setShowVoidModal:()=>{},refreshPendingCheckout:()=>{},staffProfile:{fullName:'QA staff'},flash:(...v)=>calls.messages.push(v),endingTableId:'t1',endInfo:{balance:265},endingSessionSnapshot:snapshot,pendingCheckout:null,pendingCheckoutError:'',endPayStatus:'paid',endPayMethod:'cash',endCashTendered:'300',endPartialAmount:'',useProrated:false,endGcashRef:'',debtName:'QA',debtContact:''};
 vm.runInNewContext(code,context);return{...context,calls,context};
}
const saved={receipt:{receipt_no:'REC-saved',table_name:'QA table',customer_name:'QA customer',play_end_time:'2026-10-19T09:00:00Z',duration_minutes:60,table_charge:300,overtime_charge:0,overtime_rate:150,overtime_minutes:0,fnb_charge:25,total_amount:325,balance_due:0},history:{orders:[{id:'a',qty:1,price:25}]},alreadyPaid:60,totalPaidNow:265,change:35,refundDue:0};
test('checkout failure preserves modal and receipt state and releases busy guard',async()=>{
 const h=harness(async()=>{throw new Error('Storage unavailable');});await h.handlers.handleConfirmEnd();assert.equal(h.calls.receipt.length,0);assert.equal(h.calls.ending.length,0);assert.deepEqual(h.calls.busy,[true,false]);assert.equal(h.checkoutInFlight.current,false);assert.equal(h.calls.messages[0][1],'error');
});
test('checkout displays server-confirmed amounts and closes modal only after acknowledgement',async()=>{
 let payload;const h=harness(async(id,value)=>{assert.equal(id,'t1');payload=value;return saved;});await h.handlers.handleConfirmEnd();assert.equal(payload.tendered,300);assert.equal(payload.expectedSession,h.endingSessionSnapshot);assert.equal(h.calls.receipt[0].totalPaidNow,265);assert.equal(h.calls.receipt[0].refundDue,0);assert.equal(h.calls.receipt[0].change,35);assert.equal(h.calls.receipt[0].id,'REC-saved');assert.deepEqual(h.calls.ending,[null]);
});
test('retry sends original pending checkout even when displayed payment inputs changed',async()=>{
 const original={expectedSession:{isOpenTime:false,durationMinutes:60},tendered:80};let received;const h=harness(async(id,payload)=>{received={id,payload};return saved;});h.context.pendingCheckout={tableId:'oldtable',payload:original};await h.handlers.handleConfirmEnd();assert.equal(received.id,'oldtable');assert.equal(received.payload,original);
});
test('walkout uses same atomic checkout and records no new payment',async()=>{
 let payload;const h=harness(async(id,value)=>{payload=value;return saved;});await h.handlers.handleWalkout();assert.equal(payload.closureKind,'walkout');assert.equal(payload.paymentStatus,'unpaid');assert.equal(payload.tendered,0);assert.equal(h.calls.receipt.length,1);
});
test('concurrent click cannot dispatch another checkout before first response',async()=>{
 let resolve;let count=0;const h=harness(()=>{count++;return new Promise(done=>{resolve=done;});});const first=h.handlers.handleConfirmEnd();await h.handlers.handleConfirmEnd();assert.equal(count,1);resolve(saved);await first;assert.equal(h.checkoutInFlight.current,false);
});
const assignCode=esbuild.transformSync(source.slice(source.indexOf('  const handleAssign ='),source.indexOf('  const refreshPendingCheckout ='))+'\nglobalThis.assignHandler=handleAssign;',{loader:'ts'}).code;
const extendCode=esbuild.transformSync(source.slice(source.indexOf('  const handleConfirmExtend ='),source.indexOf('  const handleAddToCart ='))+'\nglobalThis.extendHandler=handleConfirmExtend;',{loader:'ts'}).code;
test('assignment refuses a table that became held or unverified while its form was open',async()=>{
 let requests=0;const messages=[];const context={sessionInFlight:{current:false},assigningTableId:'t1',customerName:'QA',availableTables:[],assignTable:async()=>{requests++;},flash:(message,kind)=>messages.push({message,kind})};
 vm.runInNewContext(assignCode,context);await context.assignHandler({preventDefault(){}});assert.equal(requests,0);assert.equal(context.sessionInFlight.current,false);assert.equal(messages[0].kind,'error');assert.match(messages[0].message,/no longer available/);
});
test('session assignment save rejection preserves form and never removes queue or marks reservation complete',async()=>{
 const calls=[];const context={selectWalkInStartPricing,rates:{hourlyRate:150,overtimeRate:300,isWeekdayHappyHourActive:false,isWeekendHappyHourActive:false},sessionInFlight:{current:false},assigningTableId:'t1',availableTables:[{id:'t1'}],customerName:'QA',durationMinutes:60,effectiveHourly:150,effectiveOvertime:300,paymentOption:'payNow',amountPaid:'150',selectedCustomer:{kind:'queue',id:'q1'},assignTable:async()=>{throw new Error('CAS conflict');},removeFromQueue:()=>calls.push('queue'),updateReservationStatus:()=>calls.push('reservation'),setAssigningTableId:()=>calls.push('close'),setSelectedCustomer:()=>calls.push('customer'),setCustomerName:()=>calls.push('name'),setDurationMinutes:()=>{},setAmountPaid:()=>{},setPaymentOption:()=>{},setIsSavingSession:()=>{},flash:()=>calls.push('error')};
 vm.runInNewContext(assignCode,context);await context.assignHandler({preventDefault(){}});assert.deepEqual(calls,['error']);assert.equal(context.sessionInFlight.current,false);
});
test('session extension save rejection retains modal and amount instead of reporting success',async()=>{
 const calls=[];const context={sessionInFlight:{current:false},extendingTableId:'t1',extendingTable:{session:{amountPaid:60}},extendPayStatus:'paid',extendCharge:150,extendPartialAmount:'',extendMinutes:60,extendSession:async()=>{throw new Error('CAS conflict');},assignTable:async()=>{},setExtendingTableId:()=>calls.push('close'),setIsSavingSession:()=>{},flash:(message,kind)=>calls.push(kind)};
 vm.runInNewContext(extendCode,context);await context.extendHandler({preventDefault(){}});assert.deepEqual(calls,['error']);assert.equal(context.sessionInFlight.current,false);
});

const voidCode=esbuild.transformSync(source.slice(source.indexOf('  const handleVoidSession ='),source.indexOf('  const extendingTable ='))+'\nglobalThis.voidHandler=handleVoidSession;',{loader:'ts'}).code;
test('cashier session-void UI cannot dispatch and administrator sends original snapshot with waiver reason',async()=>{
 let payload;const errors=[];const context={staffProfile:{isAdmin:false},endingTableId:'t1',endingSessionSnapshot:{startTime:'2026-10-19T08:00:00Z'},voidReason:'QA accidental booking',pendingCheckout:null,pendingCheckoutError:'',checkoutInFlight:{current:false},setVoidError:v=>errors.push(v),confirmCheckout:async(id,value)=>{payload=value;}};
 vm.runInNewContext(voidCode,context);await context.voidHandler();assert.equal(payload,undefined);assert.match(errors[0],/administrator/);
 context.staffProfile.isAdmin=true;await context.voidHandler();assert.equal(payload.closureKind,'void');assert.equal(payload.tendered,0);assert.equal(payload.reason,'QA accidental booking');assert.equal(payload.expectedSession,context.endingSessionSnapshot);
});

test('fully discounted reservation void preserves zero extra waiver instead of deducting the booking discount twice',async()=>{
 const zero={...saved,receipt:{...saved.receipt,table_charge:100,subtotal:100,booking_discount_amount:100,discount_amount:100,total_amount:0,original_amount:0,void_reason:'QA fully discounted',payment_status:'voided'}};
 const h=harness(async()=>zero);await h.handlers.handleConfirmEnd();assert.equal(h.calls.receipt[0].bookingDiscount,100);assert.equal(h.calls.receipt[0].waivedAmount,0);assert.equal(h.calls.receipt[0].totalDue,0);
});

test('queued assignment dispatches one seating operation and never separately starts a session or removes the entry',async()=>{
 const calls=[],messages=[];let fail=false;
 const context={selectWalkInStartPricing:()=>({hourlyRate:150,overtimeRate:300}),rates:{},sessionInFlight:{current:false},assigningTableId:'t1',availableTables:[{id:'t1'}],customerName:'QA queue',durationMinutes:60,effectiveHourly:150,effectiveOvertime:300,paymentOption:'payNow',amountPaid:'50',selectedCustomer:{kind:'queue',id:'q1'},seatQueueCustomer:async(id,tableId,proposal)=>{calls.push({id,tableId,proposal});if(fail)throw Error('seat rejected');return{replayed:false};},assignTable:async()=>assert.fail('separate table start'),removeFromQueue:()=>assert.fail('separate queue removal'),setAssigningTableId:()=>calls.push('close'),setSelectedCustomer:()=>{},setCustomerName:()=>{},setDurationMinutes:()=>{},setAmountPaid:()=>{},setPaymentOption:()=>{},setIsSavingSession:()=>{},flash:(m,k)=>messages.push(k)};
 vm.runInNewContext(assignCode,context);await context.assignHandler({preventDefault(){}});
 assert.equal(calls[0].id,'q1');assert.equal(calls[0].tableId,'t1');assert.equal(calls[0].proposal.amountPaid,50);assert.equal(calls[0].proposal.paymentStatus,'payNow');assert.equal(Object.hasOwn(calls[0].proposal,'startTime'),false);assert.equal(calls[1],'close');assert.equal(messages.pop(),'success');
 calls.length=0;fail=true;await context.assignHandler({preventDefault(){}});assert.equal(calls.length,1);assert.equal(messages.pop(),'error');
 calls.length=0;fail=false;context.durationMinutes='open';context.currentOpenLimit=()=>new Date(Date.now()+3600000).toISOString();await context.assignHandler({preventDefault(){}});assert.equal(calls[0].proposal.amountPaid,0);assert.equal(calls[0].proposal.paymentStatus,'payLater');assert.equal(calls[0].proposal.durationMinutes,null);
});

test('assignment UI snapshots the selected Happy Hour base and separate overtime, and refuses a stale boundary price',async()=>{
 const now=Date.parse('2026-10-19T17:59:59+08:00');class Clock extends Date{static now(){return now;}}
 const rates={hourlyRate:150,overtimeRate:300,isWeekdayHappyHourActive:true,weekdayHappyHourRate:100,weekdayHappyHourStart:'15:00',weekdayHappyHourEnd:'18:00'};
 let session,selectedClock;const messages=[];
 const context={Date:Clock,selectWalkInStartPricing,rates,sessionInFlight:{current:false},assigningTableId:'t1',availableTables:[{id:'t1'}],customerName:'QA HH',durationMinutes:120,effectiveHourly:100,effectiveOvertime:300,paymentOption:'payNow',amountPaid:'200',selectedCustomer:null,assignTable:async(_id,s)=>{session=s;},setAssigningTableId:()=>{},setSelectedCustomer:()=>{},setCustomerName:()=>{},setDurationMinutes:()=>{},setAmountPaid:()=>{},setPaymentOption:()=>{},setIsSavingSession:()=>{},setPricingClock:v=>{selectedClock=v;},flash:(m,k)=>messages.push(k)};
 vm.runInNewContext(assignCode,context);await context.assignHandler({preventDefault(){}});assert.equal(session.hourlyRate,100);assert.equal(session.overtimeRate,300);assert.equal(session.amountPaid,200);assert.equal(messages.pop(),'success');
 session=null;context.effectiveHourly=150;await context.assignHandler({preventDefault(){}});assert.equal(session,null);assert.equal(selectedClock,now);assert.equal(messages.pop(),'error');
});
