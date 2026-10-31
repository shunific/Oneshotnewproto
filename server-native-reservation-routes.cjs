function registerNativeReservationRoutes(app,{requireAuth,runtime}={}){
 const middleware=Array.isArray(requireAuth)?requireAuth:[requireAuth];
 if(!middleware.length||!middleware.every(fn=>typeof fn==='function')||!runtime)throw TypeError('Authenticated native reservation services are required.');
 const errorReply=(res,error)=>res.status([400,401,403,404,409,503].includes(error.status)?error.status:503).json({error:error.status?error.message:'Reservation synchronization could not be confirmed. Retry the original operation.',...(typeof error.code==='string'?{code:error.code}:{})});
 app.post('/api/native/reservation-checkins',requireAuth,async(req,res)=>{
  try{
   const body=req.body,fields=['requestId','id','tableId','expectedRevision','expectedStaffId','expectedOvertimeRate'];
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==6||!fields.every(key=>Object.hasOwn(body,key))||typeof body.expectedOvertimeRate!=='number'||!Number.isFinite(body.expectedOvertimeRate)||body.expectedOvertimeRate<=0||body.expectedOvertimeRate>5000||Number(body.expectedOvertimeRate.toFixed(2))!==body.expectedOvertimeRate)return res.status(400).json({error:'Review the original check-in request and overtime rate.'});
   const command=Object.fromEntries(fields.map(key=>[key,body[key]])),service=await runtime;
   const {expectedOvertimeRate,...claimCommand}=command;
   await service.claim(req.authToken,claimCommand);
   const admitted=await service.admit(req.authToken,{requestId:command.requestId,expectedOvertimeRate});
   try{
    await service.deliver(req.authToken,{eventType:'admission',eventId:admitted.outboxEventId});
    res.json({...admitted,cloudAcknowledged:true,syncError:null});
   }catch(error){
    if([401,403].includes(error.status))throw error;
    res.json({...admitted,cloudAcknowledged:false,syncError:{code:'NATIVE_SYNC_PENDING',message:'Local admission is saved. Cloud acknowledgement is pending; retry the original event.'}});
   }
  }catch(error){errorReply(res,error);}
 });
 app.post('/api/native/reservation-checkins/cancel',requireAuth,async(req,res)=>{
  try{res.json(await(await runtime).cancelCheckin(req.authToken,req.body));}catch(error){errorReply(res,error);}
 });
 app.post('/api/native/reservation-sync/retry',requireAuth,async(req,res)=>{
  try{res.json(await(await runtime).deliver(req.authToken,req.body));}catch(error){errorReply(res,error);}
 });
 app.get('/api/native/reservation-sync',requireAuth,async(req,res)=>{
  try{res.json(await(await runtime).pendingSync(req.authToken));}catch(error){errorReply(res,error);}
 });
 app.get('/api/native/reservation-table-mappings',requireAuth,async(req,res)=>{
  try{res.json(await(await runtime).tableMappings(req.authToken));}catch(error){errorReply(res,error);}
 });
}
module.exports={registerNativeReservationRoutes};
