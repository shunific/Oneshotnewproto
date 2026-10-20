// QA only: actual native coordinator/order/checkout and stored JWT v2 events; no keys.
const path=require('node:path');
const express=require(path.join(process.env.ONESHOT_PROOF_PACKAGE_ARCHIVE||path.resolve(__dirname,'..'),'node_modules/express'));
const {registerCheckoutRoutes}=require(path.join(process.env.ONESHOT_PROOF_PACKAGE_ARCHIVE||path.resolve(__dirname,'..'),'server-checkout.cjs'));
const {registerOrderRoutes}=require(path.join(process.env.ONESHOT_PROOF_PACKAGE_ARCHIVE||path.resolve(__dirname,'..'),'server-orders.cjs'));
const {withNativeStaffFixture}=require('./native-staff-cross-contract.fixture.cjs');
const {readStoredNativeEvent}=require('../server-device-proof.cjs');
const {validateNativeEventEnvelope}=require('../server-cloud-staff.cjs');
async function main(input){
 return withNativeStaffFixture(input,async f=>{
  const envelope=async(_token,command)=>{const event=await readStoredNativeEvent(f.file,command);return validateNativeEventEnvelope({version:2,deviceId:event.deviceId,actorId:f.context.cloudUserId,eventType:event.eventType,eventId:event.eventId,claimId:event.claimId,payload:event.payload});};
  const admission=await envelope('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});
  if((!input.mode||input.mode==='paid')&&!input.checkoutRequestId){
   const result=await f.checkout();
   return {admission,completion:await envelope('qa-token',{eventType:'reservation-completion',eventId:result.reservationCompletion.eventId})};
  }
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.staff={id:f.context.localStaffId,isAdmin:input.mode==='void',fullName:'QA Native Manager'};next();});
  registerCheckoutRoutes(app,f.file);registerOrderRoutes(app,f.file);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try{
   const call=async(route,payload)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const v=await r.json();if(r.status!==200)throw Error('Synthetic native fixture operation failed');return v;};
   const ordered=await call('/api/tables/'+input.command.tableId+'/orders',{requestId:'qa_lifecycle_order',expectedSessionStartTime:f.admission.table.session.startTime,cart:[{id:'qa-proof-drink',qty:1}]});
   const mode=input.mode;
   const payload={requestId:input.checkoutRequestId||'qa_lifecycle_checkout',expectedSession:ordered.session,expectedSessionStartTime:ordered.session.startTime,paymentStatus:mode==='paid'?'paid':mode==='partial'?'partial':'unpaid',paymentMethod:'cash',tendered:mode==='paid'?input.result.claim.netTotalCents/100+25-input.result.claim.verifiedPaidCents/100:mode==='partial'?1:0,useProrated:false,closureKind:mode==='void'?'void':mode==='walkout'?'walkout':'checkout',...(mode==='void'?{reason:'QA approved waiver TEST ONLY'}:{})};
   const result=await call('/api/tables/'+input.command.tableId+'/checkout',payload);
   return {admission,completion:await envelope('qa-token',{eventType:'reservation-completion',eventId:result.reservationCompletion.eventId})};
  }finally{await new Promise(resolve=>server.close(resolve));}
 });
}
let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>raw+=v);process.stdin.on('end',()=>main(JSON.parse(raw)).then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>{console.error('Synthetic lifecycle native fixture failed');process.exitCode=1;}));
