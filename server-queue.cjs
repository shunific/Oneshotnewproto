const sqlite3=require('sqlite3');
const {assertVenueAvailability}=require('./server-venue-availability.cjs');
const {reviewedOpenLimit}=require('./server-table-start.cjs');
const {randomUUID,createHash}=require('node:crypto');
const {canonicalSession}=require('./server-session-identity.cjs');
const {assertTableNotHeld}=require('./server-reservation-moves.cjs');
const {selectWalkInStartPricing,calculateSessionBill}=require('./session-billing.mjs');
const fail=(status,code,message)=>Object.assign(Error(message),{status,code});
const corrupt=()=>fail(503,'QUEUE_RECONCILIATION_REQUIRED','Queue records need reconciliation. Keep the original request.');
const changed=()=>fail(403,'QUEUE_ACCOUNT_CHANGED','Staff account changed. Sign in as the original account before retrying.');
const semantic=message=>Object.assign(Error(message),{queueRejected:true});
const same=(a,b)=>canonicalSession(a)===canonicalSession(b);
const hash=value=>createHash('sha256').update(canonicalSession(value)).digest('hex');
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&v.length>0&&v.length<=120&&v.trim()===v;
const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const money=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&Number.isSafeInteger(Math.round(v*100))&&Math.abs(v*100-Math.round(v*100))<0.000001;
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,function(e){e?reject(e):resolve(this);}));
const one=async(db,sql,args=[])=>{const result=await run(db,sql,args);if(result.changes!==1)throw corrupt();return result;};
const get=(db,sql,args=[])=>new Promise((resolve,reject)=>db.get(sql,args,(e,r)=>e?reject(e):resolve(r)));
const all=(db,sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,r)=>e?reject(e):resolve(r)));
const open=file=>new Promise((resolve,reject)=>{const db=new sqlite3.Database(file,sqlite3.OPEN_READWRITE,e=>{if(e){db.close(()=>{});reject(e);}else{db.configure('busyTimeout',5000);resolve(db);}});});
const close=db=>new Promise(resolve=>db.close(()=>resolve()));
const normalized=sql=>sql.replace(' IF NOT EXISTS','').replace(/\s+/g,' ').trim();
const queueOperationDefinitions=[
 ['queue_operations',`CREATE TABLE IF NOT EXISTS queue_operations (request_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1), actor_id TEXT NOT NULL, command_json TEXT NOT NULL, command_sha256 TEXT NOT NULL, http_status INTEGER NOT NULL CHECK(http_status IN (200,409)), response_json TEXT NOT NULL, response_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, journal_sha256 TEXT NOT NULL)`],
 ['queue_counter',`CREATE TABLE IF NOT EXISTS queue_counter (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL CHECK(schema_version=1), last_number INTEGER NOT NULL CHECK(last_number>=0), number_sha256 TEXT NOT NULL)`],
 ['session_payments','CREATE TABLE IF NOT EXISTS session_payments (id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, table_id TEXT NOT NULL, session_start TEXT NOT NULL, amount REAL NOT NULL, payment_method TEXT NOT NULL, payment_reference TEXT, created_at TEXT NOT NULL)']
];
const counterHash=last=>hash({version:1,lastNumber:last});
const journalHash=(actorId,command,response,status,createdAt)=>hash({version:1,actorId,command,response,status,createdAt});
async function initializeQueueSchema(db){
 for(const [name,ddl]of queueOperationDefinitions){await run(db,ddl);const row=await get(db,"SELECT sql FROM sqlite_master WHERE type='table' AND name=?",[name]);if(!row||normalized(row.sql)!==normalized(ddl))throw corrupt();}
 const max=await get(db,"SELECT MAX(queueNumber) value FROM queue WHERE typeof(queueNumber)='integer' AND queueNumber>=1 AND queueNumber<=?",[Number.MAX_SAFE_INTEGER]);
 const seed=max.value===null?0:max.value;if(!Number.isSafeInteger(seed)||seed<0)throw corrupt();
 await run(db,'INSERT INTO queue_counter VALUES(1,1,?,?) ON CONFLICT(singleton) DO NOTHING',[seed,counterHash(seed)]);
 const row=await get(db,'SELECT * FROM queue_counter WHERE singleton=1');if(!row||row.schema_version!==1||!Number.isSafeInteger(row.last_number)||row.last_number<seed||row.number_sha256!==counterHash(row.last_number))throw corrupt();
}
const queueKeys=['id','customerName','contactNumber','partySize','status','queueNumber','notes','arrivalTime'];
function validQueue(row){return exact(row,queueKeys)&&id(row.id)&&text(row.customerName,200)&&!!row.customerName.trim()&&(row.contactNumber===null||text(row.contactNumber,200))&&Number.isSafeInteger(row.partySize)&&row.partySize>0&&row.partySize<=1000&&['waiting','called'].includes(row.status)&&Number.isSafeInteger(row.queueNumber)&&row.queueNumber>0&&(row.notes===null||text(row.notes,2000))&&typeof row.arrivalTime==='string'&&row.arrivalTime.length<=80&&Number.isFinite(Date.parse(row.arrivalTime));}
function commandOf(input){
 const fields=input?.kind==='add'?['requestId','kind','customerName','contactNumber','partySize','notes']:input?.kind==='seat'?['requestId','kind','queueId','expectedQueue','tableId','session']:['requestId','kind','queueId','expectedQueue'];
 if(!exact(input,fields)||typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId)||!['add','call','remove','seat'].includes(input.kind))throw fail(400,'INVALID_QUEUE_COMMAND','Choose a complete queue action with its original request ID.');
 if(input.kind==='add'){
  if(!text(input.customerName,120)||!input.customerName.trim()||!text(input.contactNumber,40)||!text(input.notes,2000)||!Number.isSafeInteger(input.partySize)||input.partySize<1||input.partySize>1000)throw fail(400,'INVALID_QUEUE_COMMAND','Review the customer name, contact, party size and notes.');
 }else if(!id(input.queueId)||!validQueue(input.expectedQueue)||input.expectedQueue.id!==input.queueId)throw fail(400,'INVALID_QUEUE_COMMAND','Refresh the original queue record before continuing.');
 if(input.kind==='seat'){
  const s=input.session;
  if(!id(input.tableId)||!exact(s,['durationMinutes','isOpenTime','hourlyRate','overtimeRate','pricingVersion','amountPaid','paymentStatus',...(s?.isOpenTime?['latestEndTime']:[])])||typeof s.isOpenTime!=='boolean'||s.pricingVersion!==1||!money(s.hourlyRate)||!money(s.overtimeRate)||!money(s.amountPaid)||!['payNow','payLater'].includes(s.paymentStatus)||(s.isOpenTime?s.durationMinutes!==null:!Number.isSafeInteger(s.durationMinutes)||s.durationMinutes<15||s.durationMinutes>1440||s.durationMinutes%15!==0))throw fail(400,'INVALID_QUEUE_COMMAND','Review the fixed or open session proposal and payment details.');
 }
 return JSON.parse(canonicalSession(input));
}
const rejectedMessages=new Set(['Review the saved party size policy before using the queue.','Party size is outside the saved policy for today.','The queue record changed. Refresh before choosing another action.','Only a waiting guest can be called.','Queue numbering is exhausted. Ask an administrator to reconcile it.','Choose an active available empty table.','The table is held by an unresolved transfer. Recover that transfer first.','Review the saved pricing policy before starting play.','The session rates changed. Refresh and review the current quote.','Open sessions require no prepaid amount and pay later.','Pay later cannot record an upfront payment.','Upfront payment cannot exceed the fixed session quote.','Review the saved venue calendar and open-time limit before seating.']);
async function policy(db,startedAt){
 const rows=await all(db,'SELECT keyName,settingValue FROM systemSettings');const settings=Object.fromEntries(rows.map(row=>[row.keyName,row.settingValue]));
 const local=new Date(startedAt+8*3600000),prefix=[0,5,6].includes(local.getUTCDay())?'weekend':'weekday';
 const value=key=>typeof settings[key]==='string'&&/^[1-9][0-9]*$/.test(settings[key])?Number(settings[key]):NaN;
 const min=value(prefix+'MinPartySize'),max=value(prefix+'MaxPartySize');
 if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||min<1||max>1000||min>max)throw semantic('Review the saved party size policy before using the queue.');
 return{settings,min,max};
}
const responseFor=(command,queueId,outcome,queue=null,table=null)=>({requestId:command.requestId,kind:command.kind,queueId,outcome,queue,table,replayed:false});
function verifyResponse(command,response,status){
 const rejected=status===409,keys=['requestId','kind','queueId','outcome','queue','table','replayed',...(rejected?['code','error']:[])];
 if(!exact(response,keys)||response.requestId!==command.requestId||response.kind!==command.kind||response.replayed!==false||response.outcome!==(rejected?'rejected':'applied'))throw corrupt();
 if(rejected){if(response.queueId!==(command.kind==='add'?null:command.queueId)||response.queue!==null||response.table!==null||response.code!=='QUEUE_OPERATION_REJECTED'||!rejectedMessages.has(response.error))throw corrupt();return;}
 if(command.kind==='add'||command.kind==='call'){
  if(!validQueue(response.queue)||response.queueId!==response.queue.id||response.table!==null)throw corrupt();
  if(command.kind==='add'){
   if(!/^q_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(response.queue.id)||response.queue.customerName!==command.customerName.trim()||response.queue.contactNumber!==command.contactNumber.trim()||response.queue.partySize!==command.partySize||response.queue.notes!==command.notes.trim()||response.queue.status!=='waiting'||new Date(response.queue.arrivalTime).toISOString()!==response.queue.arrivalTime)throw corrupt();
  }else if(response.queueId!==command.queueId||!same(response.queue,{...command.expectedQueue,status:'called'})||command.expectedQueue.status!=='waiting')throw corrupt();
 }else{
  if(response.queueId!==command.queueId||response.queue!==null)throw corrupt();
  if(command.kind==='remove'){if(response.table!==null)throw corrupt();return;}
  const table=response.table,s=table?.session,p=command.session,q=command.expectedQueue;
  if(!exact(table,['id','status','session'])||table.id!==command.tableId||table.status!=='occupied'||!exact(s,['customerName','customerPhone','partySize','startTime','durationMinutes','isOpenTime','hourlyRate','overtimeRate','pricingVersion','amountPaid','paymentStatus','isPaid','orders',...(p.isOpenTime&&Object.hasOwn(p,'latestEndTime')?['latestEndTime']:[])])||typeof s.startTime!=='string'||!Number.isFinite(Date.parse(s.startTime))||new Date(s.startTime).toISOString()!==s.startTime)throw corrupt();
  const base=p.isOpenTime?0:Math.round(Math.round(p.hourlyRate*100)*p.durationMinutes/60),paid=Math.round(p.amountPaid*100),isPaid=!p.isOpenTime&&paid>=base;
  const expected={...p,customerName:q.customerName,customerPhone:q.contactNumber,partySize:q.partySize,startTime:s.startTime,paymentStatus:isPaid?'paid':'payLater',isPaid,orders:[]};
  if(!same(s,expected))throw corrupt();calculateSessionBill(s,Date.parse(s.startTime),false);
 }
}
async function saveOperation(db,actor,command,response,status,createdAt){
 verifyResponse(command,response,status);
 await one(db,'INSERT INTO queue_operations VALUES(?,1,?,?,?,?,?,?,?,?)',[command.requestId,actor.localStaffId,canonicalSession(command),hash(command),status,canonicalSession(response),hash(response),createdAt,journalHash(actor.localStaffId,command,response,status,createdAt)]);
}
async function saveQueueActivities(db,actor,staff,command,response,createdAt){
 const actorName=staff?.id===actor.localStaffId&&(staff.fullName||staff.username)||actor.localStaffId;
 // Metadata carries authoritative attribution; descriptions remain human-readable.
 const display=value=>String(value).replace(/[()\r\n]/g,' ').trim();
 const displayActor=display(actorName),guest=display(response.queue?.customerName||command.expectedQueue?.customerName),tableId=display(command.tableId);
 const events=command.kind==='add'?[['queue_added',`Added ${guest} to the queue.`]]:command.kind==='call'?[['queue_called',`Called ${guest} from the queue.`]]:command.kind==='remove'?[['queue_removed',`Removed ${guest} from the queue.`]]:[['queue_removed',`Seated ${guest} from the queue at table ${tableId}.`],['table_assigned',`Assigned table ${tableId} to ${guest} from the queue.`]];
 const metadata=JSON.stringify({actorId:actor.localStaffId,actorName,requestId:command.requestId,queueId:response.queueId,...(command.kind==='seat'?{tableId:command.tableId}:{})});
 for(const [type,description]of events)await one(db,'INSERT INTO activities (id,type,description,timestamp,metadata) VALUES(?,?,?,?,?)',[`act_queue_${command.requestId}_${type}`,type,`${description} (Action by: ${displayActor})`,createdAt,metadata]);
}
function registerQueueRoutes(app,dbPath,{requireAuth,resolveActor,isActorCurrent,now=Date.now,readyBefore=Promise.resolve()}={}){
 const guards=Array.isArray(requireAuth)?requireAuth:[requireAuth];if(!guards.length||!guards.every(g=>typeof g==='function')||typeof resolveActor!=='function'||typeof isActorCurrent!=='function')throw TypeError('Trusted local queue authorization is required.');
 const fresh=async(token,expected)=>{const a=await resolveActor(token);if(!id(a?.localStaffId)||(expected&&a.localStaffId!==expected.localStaffId)||isActorCurrent(token,a)!==true)throw changed();return{localStaffId:a.localStaffId};};
 const ready=(async()=>{let db,begun=false;try{await readyBefore;db=await open(dbPath);await run(db,'BEGIN IMMEDIATE');begun=true;await initializeQueueSchema(db);await run(db,'COMMIT');begun=false;}catch(e){if(begun)await run(db,'ROLLBACK').catch(()=>{});throw e;}finally{if(db)await close(db);}})();
 app.post('/api/queue/operations',...guards,async(req,res)=>{
  let db,begun=false;
  try{
   const command=commandOf(req.body),token=req.authToken,actor=await fresh(token);await ready;
   db=await open(dbPath);await run(db,'BEGIN IMMEDIATE');begun=true;await fresh(token,actor);await initializeQueueSchema(db);
   const prior=await get(db,'SELECT * FROM queue_operations WHERE request_id=?',[command.requestId]);
   if(prior){
    let response,savedCommand;try{response=JSON.parse(prior.response_json);savedCommand=JSON.parse(prior.command_json);}catch{throw corrupt();}
    if(prior.schema_version!==1||!id(prior.actor_id)||prior.command_json!==canonicalSession(savedCommand)||prior.command_sha256!==hash(savedCommand)||prior.response_sha256!==hash(response)||prior.response_json!==canonicalSession(response)||typeof prior.created_at!=='string'||!Number.isFinite(Date.parse(prior.created_at))||new Date(prior.created_at).toISOString()!==prior.created_at||prior.journal_sha256!==journalHash(prior.actor_id,savedCommand,response,prior.http_status,prior.created_at))throw corrupt();
    try{if(!same(commandOf(savedCommand),savedCommand))throw corrupt();verifyResponse(savedCommand,response,prior.http_status);}catch{throw corrupt();}
    if(prior.actor_id!==actor.localStaffId)throw changed();
    if(prior.command_json!==canonicalSession(command))throw fail(409,'QUEUE_REQUEST_CONFLICT','This request ID belongs to different queue details. Keep the original request.');
    if(command.kind==='seat'&&prior.http_status===200&&response.table.session.amountPaid>0){const payment=await get(db,'SELECT * FROM session_payments WHERE operation_id=?',[command.requestId]);if(!payment||payment.table_id!==command.tableId||payment.session_start!==response.table.session.startTime||payment.amount!==response.table.session.amountPaid||payment.payment_method!=='cash'||payment.payment_reference!==null||payment.created_at!==response.table.session.startTime)throw corrupt();}
    await fresh(token,actor);await run(db,'COMMIT');begun=false;return res.status(prior.http_status).json({...response,replayed:true});
   }
   const startedAt=now();if(!Number.isFinite(startedAt))throw corrupt();const createdAt=new Date(startedAt).toISOString();let response,status=200;
   try{
    if(command.kind==='add'){
     const terms=await policy(db,startedAt);if(command.partySize<terms.min||command.partySize>terms.max)throw semantic('Party size is outside the saved policy for today.');
     const counter=await get(db,'SELECT * FROM queue_counter WHERE singleton=1');if(counter.last_number>=Number.MAX_SAFE_INTEGER)throw semantic('Queue numbering is exhausted. Ask an administrator to reconcile it.');const number=counter.last_number+1;
     const row={id:'q_'+randomUUID(),customerName:command.customerName.trim(),contactNumber:command.contactNumber.trim(),partySize:command.partySize,status:'waiting',queueNumber:number,notes:command.notes.trim(),arrivalTime:createdAt};
     await one(db,'INSERT INTO queue(id,customerName,contactNumber,partySize,status,queueNumber,notes,arrivalTime) VALUES(?,?,?,?,?,?,?,?)',queueKeys.map(k=>row[k]));await one(db,'UPDATE queue_counter SET last_number=?,number_sha256=? WHERE singleton=1',[number,counterHash(number)]);response=responseFor(command,row.id,'applied',row);
    }else{
     const row=await get(db,'SELECT id,customerName,contactNumber,partySize,status,queueNumber,notes,arrivalTime FROM queue WHERE id=?',[command.queueId]);if(!row||!same(row,command.expectedQueue))throw semantic('The queue record changed. Refresh before choosing another action.');if(!validQueue(row))throw corrupt();
     if(command.kind==='call'){if(row.status!=='waiting')throw semantic('Only a waiting guest can be called.');await one(db,"UPDATE queue SET status='called' WHERE id=?",[row.id]);response=responseFor(command,row.id,'applied',{...row,status:'called'});}
     else if(command.kind==='remove'){await one(db,'DELETE FROM queue WHERE id=?',[row.id]);response=responseFor(command,row.id,'applied');}
     else{
      const terms=await policy(db,startedAt);if(row.partySize<terms.min||row.partySize>terms.max)throw semantic('Party size is outside the saved policy for today.');let selected;try{selected=selectWalkInStartPricing(terms.settings,startedAt);}catch{throw semantic('Review the saved pricing policy before starting play.');}
      const proposal=command.session;if(proposal.hourlyRate!==selected.hourlyRate||proposal.overtimeRate!==selected.overtimeRate)throw semantic('The session rates changed. Refresh and review the current quote.');
      if(proposal.isOpenTime&&(proposal.amountPaid!==0||proposal.paymentStatus!=='payLater'))throw semantic('Open sessions require no prepaid amount and pay later.');if(proposal.paymentStatus==='payLater'&&proposal.amountPaid!==0)throw semantic('Pay later cannot record an upfront payment.');
      const base=proposal.isOpenTime?0:Math.round(Math.round(selected.hourlyRate*100)*proposal.durationMinutes/60);if(Math.round(proposal.amountPaid*100)>base)throw semantic('Upfront payment cannot exceed the fixed session quote.');
      try{await assertTableNotHeld(db,command.tableId);}catch(e){if(e.code==='NATIVE_MOVE_TABLE_HELD')throw semantic('The table is held by an unresolved transfer. Recover that transfer first.');throw e;}
      const table=await get(db,'SELECT id,status,isActive,sessionData FROM tables WHERE id=?',[command.tableId]);if(!table||table.status!=='available'||table.isActive!==1||table.sessionData!==null)throw semantic('Choose an active available empty table.');
      const isPaid=!proposal.isOpenTime&&Math.round(proposal.amountPaid*100)>=base,session={...proposal,customerName:row.customerName,customerPhone:row.contactNumber,partySize:row.partySize,startTime:createdAt,paymentStatus:isPaid?'paid':'payLater',isPaid,orders:[]};calculateSessionBill(session,startedAt,false);
      try{const venue=await assertVenueAvailability(db,{tableId:table.id,session:{...session,latestEndTime:undefined},now:startedAt,operation:'start'});reviewedOpenLimit(proposal,venue);if(session.isOpenTime)session.latestEndTime=venue.latestEndTime;}catch(e){if(e.code?.startsWith('VENUE_'))throw semantic('Review the saved venue calendar and open-time limit before seating.');throw e;}
      await one(db,"UPDATE tables SET status='occupied',sessionData=? WHERE id=?",[JSON.stringify(session),table.id]);
      if(session.amountPaid>0)await one(db,'INSERT INTO session_payments VALUES(?,?,?,?,?,?,?,?)',[randomUUID(),command.requestId,table.id,session.startTime,session.amountPaid,'cash',null,session.startTime]);
      await one(db,'DELETE FROM queue WHERE id=?',[row.id]);response=responseFor(command,row.id,'applied',null,{id:table.id,status:'occupied',session});
     }
    }
   }catch(e){if(!e.queueRejected||!rejectedMessages.has(e.message))throw e;status=409;response={...responseFor(command,command.kind==='add'?null:command.queueId,'rejected'),code:'QUEUE_OPERATION_REJECTED',error:e.message};}
   if(status===200)await saveQueueActivities(db,actor,req.staff,command,response,createdAt);
   await saveOperation(db,actor,command,response,status,createdAt);await fresh(token,actor);await run(db,'COMMIT');begun=false;res.status(status).json(response);
  }catch(e){if(begun)await run(db,'ROLLBACK').catch(()=>{});const known=[400,403,409].includes(e.status);res.status(known?e.status:503).json({error:known?e.message:'Queue action could not be confirmed. Keep and retry the same original request.',...(known&&e.code?{code:e.code}:{})});}
  finally{if(db)await close(db);}
 });
 return{ready};
}
module.exports={registerQueueRoutes,initializeQueueSchema,queueOperationDefinitions};
