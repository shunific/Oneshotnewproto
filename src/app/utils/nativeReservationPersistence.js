const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=120&&value.trim()===value;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const fields=['requestId','id','tableId','expectedRevision','expectedStaffId','expectedOvertimeRate'];
const validCommand=value=>exact(value,fields)&&uuid(value.requestId)&&id(value.id)&&id(value.tableId)&&uuid(value.expectedStaffId)&&Number.isSafeInteger(value.expectedRevision)&&value.expectedRevision>0&&value.expectedRevision<Number.MAX_SAFE_INTEGER&&typeof value.expectedOvertimeRate==='number'&&Number.isFinite(value.expectedOvertimeRate)&&value.expectedOvertimeRate>0&&value.expectedOvertimeRate<=5000&&Number(value.expectedOvertimeRate.toFixed(2))===value.expectedOvertimeRate;
const prefix=(local,cloud)=>`oneshot_native_checkin:${encodeURIComponent(local)}:${encodeURIComponent(cloud)}:`;
const key=(local,cloud,command)=>prefix(local,cloud)+command.requestId;
const unconfirmed=()=>new Error('Check-in is unconfirmed. Keep and retry its original request.');
const sameIdentity=(left,right)=>fields.filter(field=>field!=='expectedOvertimeRate').every(field=>left[field]===right[field]);
function readRecord(raw,name,local,cloud){
 if(!raw||raw.length>8192)throw unconfirmed();let row;try{row=JSON.parse(raw);}catch{throw unconfirmed();}
 const reviewed=exact(row,['version','localStaffId','cloudUserId','command','previousCommands'])&&row.version===2&&Array.isArray(row.previousCommands)&&row.previousCommands.length>=1&&row.previousCommands.length<=5;
 if((!reviewed&&!exact(row,['localStaffId','cloudUserId','command']))||row.localStaffId!==local||row.cloudUserId!==cloud||!validCommand(row.command)||row.command.expectedStaffId!==cloud||name!==key(local,cloud,row.command))throw unconfirmed();
 const previousCommands=reviewed?row.previousCommands:[];
 if(previousCommands.some(previous=>!validCommand(previous)||!sameIdentity(previous,row.command)))throw unconfirmed();
 return{...row,previousCommands};
}
export function pendingNativeCheckins(storage,local,cloud){
 if(!id(local)||!uuid(cloud))return[];const pending=[];
 for(let i=0;i<storage.length;i++){const name=storage.key(i);if(!name?.startsWith(prefix(local,cloud)))continue;if(pending.length>=1000)throw unconfirmed();pending.push(readRecord(storage.getItem(name),name,local,cloud).command);}
 return pending;
}
export function persistNativeCheckin(storage,local,cloud,command){
 if(!id(local)||!uuid(cloud)||!validCommand(command)||command.expectedStaffId!==cloud)throw unconfirmed();
 const existing=pendingNativeCheckins(storage,local,cloud);if(existing.some(row=>row.id===command.id&&row.requestId!==command.requestId))throw new Error('Retry this booking’s existing check-in before starting another.');
 const name=key(local,cloud,command),prior=storage.getItem(name);
 if(prior){const row=readRecord(prior,name,local,cloud);if(canonical(row.command)!==canonical(command))throw unconfirmed();return prior;}
 const raw=canonical({localStaffId:local,cloudUserId:cloud,command});storage.setItem(name,raw);if(storage.getItem(name)!==raw)throw unconfirmed();return raw;
}
export async function reviewNativeCheckinRate(options){
 const{storage,localStaffId,cloudUserId,command,isCurrent,expectedOvertimeRate}=options;
 if(!isCurrent())throw unconfirmed();const name=key(localStaffId,cloudUserId,command),before=persistNativeCheckin(storage,localStaffId,cloudUserId,command),row=readRecord(before,name,localStaffId,cloudUserId);
 const updated={...command,expectedOvertimeRate};if(!validCommand(updated))throw unconfirmed();
 if(expectedOvertimeRate===command.expectedOvertimeRate)throw new Error('The current saved overtime rate already matches this request. Retry the original check-in.');
 if(row.previousCommands.length>=5)throw new Error('Five rate reviews are already retained. Keep this request and ask the administrator to reconcile its saved admission before another rate change.');
 const raw=canonical({version:2,localStaffId,cloudUserId,command:updated,previousCommands:[...row.previousCommands,command]});
 if(!isCurrent()||storage.getItem(name)!==before)throw unconfirmed();storage.setItem(name,raw);if(storage.getItem(name)!==raw)throw unconfirmed();
 return deliver({...options,command:updated},false);
}
function admitted(result,command){
 const session=result?.table?.session;
 return exact(result,['requestId','claimId','phase','cloudAcknowledged','table','outboxEventId','replayed','syncError'])&&result.requestId===command.requestId&&uuid(result.claimId)&&uuid(result.outboxEventId)&&result.phase==='admitted'&&typeof result.replayed==='boolean'&&typeof result.cloudAcknowledged==='boolean'&&(result.cloudAcknowledged?result.syncError===null:exact(result.syncError,['code','message'])&&result.syncError.code==='NATIVE_SYNC_PENDING'&&typeof result.syncError.message==='string')&&exact(result.table,['id','status','session'])&&result.table.id===command.tableId&&result.table.status==='occupied'&&session?.reservationId===command.id&&session.pricingVersion===2&&session.overtimeRate===command.expectedOvertimeRate&&session.reservationPricing?.claimId===result.claimId&&session.reservationPricing?.reservationId===command.id&&session.reservationPricing?.sourceRevision===command.expectedRevision;
}
async function deliver(options,cancel){
 const{storage,localStaffId,cloudUserId,command,request,isCurrent}=options;
 if(!isCurrent())throw unconfirmed();const raw=persistNativeCheckin(storage,localStaffId,cloudUserId,command),name=key(localStaffId,cloudUserId,command),matches=()=>isCurrent()&&storage.getItem(name)===raw;
 if(!matches())throw unconfirmed();let result;
 try{result=await request(cancel?'/api/native/reservation-checkins/cancel':'/api/native/reservation-checkins',JSON.parse(JSON.stringify(command)));}
 catch(error){
  if(cancel||error?.status!==409||error?.code!=='CHECKIN_REQUEST_CONFLICT'||!matches())throw error;
  const row=readRecord(raw,name,localStaffId,cloudUserId),attempted=new Set([command.expectedOvertimeRate]);
  for(const previous of [...row.previousCommands].reverse()){
   if(attempted.has(previous.expectedOvertimeRate))continue;attempted.add(previous.expectedOvertimeRate);if(!matches())throw unconfirmed();
   let replay;
   try{replay=await request('/api/native/reservation-checkins',JSON.parse(JSON.stringify(previous)));}
   catch(priorError){if(priorError?.status===409&&priorError?.code==='CHECKIN_REQUEST_CONFLICT')continue;throw priorError;}
   if(!matches()||replay?.replayed!==true||!admitted(replay,previous))throw unconfirmed();
   storage.removeItem(name);return replay;
  }
  throw error;
 }
 if(!matches())throw unconfirmed();
 if(cancel){
  if(exact(result,['requestId','cancelled','phase','claimId'])&&result.requestId===command.requestId&&result.cancelled===false&&['claimed','admitted'].includes(result.phase)&&uuid(result.claimId))return result;
  if(!exact(result,['requestId','reservationId','deviceId','tableId','cancelled','replayed','recordType','fundsTransferred'])||result.requestId!==command.requestId||result.reservationId!==command.id||result.tableId!==command.tableId||!uuid(result.deviceId)||result.cancelled!==true||typeof result.replayed!=='boolean'||result.recordType!=='reservation-check-in-cancellation'||result.fundsTransferred!==false)throw unconfirmed();
 }else if(!admitted(result,command))throw unconfirmed();
 storage.removeItem(name);return result;
}
export const submitNativeCheckin=options=>deliver(options,false);
export const cancelNativeCheckin=options=>deliver(options,true);
export function mappedNativeTable(reservation,mappings,tables){
 if(reservation?.status!=='confirmed'||!id(reservation.tableId))return null;
 const matches=mappings.filter(row=>row.cloudTableId===reservation.tableId);if(matches.length!==1)return null;
 const table=tables.find(row=>row.id===matches[0].tableId);return table&&table.isActive===true&&table.status==='available'&&!table.session?table:null;
}
export function validateNativeMappings(value){
 if(!exact(value,['deviceId','mappings','recordType','fundsTransferred'])||!uuid(value.deviceId)||value.recordType!=='staff-native-table-mappings'||value.fundsTransferred!==false||!Array.isArray(value.mappings)||value.mappings.length>1000)throw new Error('Physical table mappings could not be verified.');
 const local=new Set(),cloud=new Set();for(const row of value.mappings){if(!exact(row,['tableId','cloudTableId'])||!id(row.tableId)||!id(row.cloudTableId)||local.has(row.tableId)||cloud.has(row.cloudTableId))throw new Error('Physical table mappings could not be verified.');local.add(row.tableId);cloud.add(row.cloudTableId);}return value.mappings.map(row=>({...row}));
}
export function validateNativePending(value,cloudUserId){
 if(!exact(value,['events','checkins'])||!Array.isArray(value.events)||!Array.isArray(value.checkins)||value.events.length>1000||value.checkins.length>1000)throw unconfirmed();
 const events=value.events.map(row=>{if(!exact(row,['eventType','eventId','claimId','reservationId'])||!['admission','reservation-completion','reservation-move-prepare','reservation-move-commit','reservation-move-abort','reservation-move-cancel'].includes(row.eventType)||!uuid(row.eventId)||!uuid(row.claimId)||!id(row.reservationId))throw unconfirmed();return{...row};});
 const checkins=value.checkins.map(row=>{const{phase,...original}=row||{};if(!['prepared','claimed'].includes(phase)||!validCommand({...original,expectedOvertimeRate:1})||row.expectedStaffId!==cloudUserId)throw unconfirmed();return{...row};});return{events,checkins};
}
export function validateNativeSyncAck(result,event){
 const ack=result?.ack,states={admission:'checked-in','reservation-completion':'completed','reservation-move-prepare':'move-prepared','reservation-move-commit':'moved','reservation-move-abort':'move-aborted','reservation-move-cancel':'move-cancelled'};
 if(!exact(result,['ack','replayed','recordType','fundsTransferred'])||result.recordType!=='reservation-lifecycle-ack'||result.fundsTransferred!==false||typeof result.replayed!=='boolean'||!exact(ack,['eventId','eventType','claimId','deviceId','reservationId','payloadSha256','state','revision','receiptId','receivedAt','acceptedBy'])||ack.eventId!==event.eventId||ack.eventType!==event.eventType||ack.claimId!==event.claimId||ack.reservationId!==event.reservationId||ack.state!==states[event.eventType]||(event.eventType==='reservation-completion'?!uuid(ack.receiptId):ack.receiptId!==null)||!uuid(ack.deviceId)||!uuid(ack.acceptedBy)||!Number.isSafeInteger(ack.revision)||ack.revision<1||typeof ack.payloadSha256!=='string'||!/^[a-f0-9]{64}$/.test(ack.payloadSha256)||typeof ack.receivedAt!=='string'||!Number.isFinite(Date.parse(ack.receivedAt))||new Date(ack.receivedAt).toISOString()!==ack.receivedAt)throw unconfirmed();return result;
}
