const prefix = staffId => `oneshot_pending_queue:${encodeURIComponent(staffId)}:`;
const queueFields = ['id','customerName','contactNumber','partySize','status','queueNumber','notes','arrivalTime'];
const proposalFields = ['durationMinutes','isOpenTime','hourlyRate','overtimeRate','pricingVersion','amountPaid','paymentStatus'];
const sessionFields = ['customerName','customerPhone','partySize','startTime','durationMinutes','isOpenTime','hourlyRate','overtimeRate','pricingVersion','amountPaid','paymentStatus','isPaid','orders'];
const exact = (value, fields) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value,key));
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1000;
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value*100)) && Math.abs(value*100-Math.round(value*100)) < 0.000001;
const nullableText = value => value === null || typeof value === 'string';
const validQueue = row => exact(row,queueFields) && text(row.id) && text(row.customerName) && nullableText(row.contactNumber) && nullableText(row.notes) && Number.isSafeInteger(row.partySize) && row.partySize > 0 && ['waiting','called'].includes(row.status) && Number.isSafeInteger(row.queueNumber) && row.queueNumber > 0 && typeof row.arrivalTime === 'string' && Number.isFinite(Date.parse(row.arrivalTime));
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
const resource = command => command.kind === 'add' ? 'add' : `entry:${encodeURIComponent(command.queueId)}`;
const keyFor = (staffId, command) => prefix(staffId)+resource(command);
const failure = () => new Error('The queue result is unconfirmed. Retry the original action from Queue recovery before changing it.');

function validCommand(command) {
  if (!text(command?.requestId)) return false;
  if (command.kind === 'add') return exact(command,['requestId','kind','customerName','contactNumber','partySize','notes']) && text(command.customerName) && typeof command.contactNumber === 'string' && typeof command.notes === 'string' && Number.isSafeInteger(command.partySize) && command.partySize > 0;
  if (!['call','remove','seat'].includes(command.kind) || !validQueue(command.expectedQueue) || command.queueId !== command.expectedQueue.id) return false;
  if (command.kind !== 'seat') return exact(command,['requestId','kind','queueId','expectedQueue']);
  const session = command.session;
  return exact(command,['requestId','kind','queueId','expectedQueue','tableId','session']) && text(command.tableId) && exact(session,proposalFields) && typeof session.isOpenTime === 'boolean' && (session.durationMinutes === null || Number.isSafeInteger(session.durationMinutes)) && money(session.hourlyRate) && money(session.overtimeRate) && money(session.amountPaid) && session.pricingVersion === 1 && ['payNow','payLater'].includes(session.paymentStatus);
}

export function queueSnapshot(row) {
  const snapshot = Object.fromEntries(queueFields.map(key => [key,row?.[key]]));
  if (!validQueue(snapshot)) throw new Error('Refresh the saved queue before changing this customer.');
  return snapshot;
}

export function pendingQueueOperations(storage,staffId) {
  if (!text(staffId)) return [];
  const records=[];
  for(let index=0;index<storage.length;index++) {
    const key=storage.key(index);
    if (!key?.startsWith(prefix(staffId))) continue;
    if (records.length >= 200) throw failure();
    const raw=storage.getItem(key);
    if (!raw || raw.length > 65536) throw failure();
    let record; try { record=JSON.parse(raw); } catch { throw failure(); }
    if (!exact(record,['staffId','command']) || record.staffId!==staffId || !validCommand(record.command) || key!==keyFor(staffId,record.command)) throw failure();
    records.push(record);
  }
  return records;
}

function validApplied(result,command) {
  if (!exact(result,['requestId','kind','queueId','outcome','queue','table','replayed']) || result.outcome!=='applied' || !binding(result,command)) return false;
  if (command.kind==='add') return validQueue(result.queue) && result.queue.status==='waiting' && result.queue.id===result.queueId && ['customerName','contactNumber','notes'].every(key=>result.queue[key]===command[key].trim()) && result.queue.partySize===command.partySize && result.table===null;
  if (command.kind==='call') return validQueue(result.queue) && canonical(result.queue)===canonical({...command.expectedQueue,status:'called'}) && result.table===null;
  if (result.queue!==null) return false;
  if (command.kind==='remove') return result.table===null;
  const table=result.table,session=table?.session,proposal=command.session;
  const isPaid=!proposal.isOpenTime && Math.round(proposal.amountPaid*100)===Math.round(proposal.hourlyRate*100*proposal.durationMinutes/60);
  return exact(table,['id','status','session']) && table.id===command.tableId && table.status==='occupied' && exact(session,sessionFields) && session.customerName===command.expectedQueue.customerName && session.customerPhone===command.expectedQueue.contactNumber && session.partySize===command.expectedQueue.partySize && typeof session.startTime==='string' && Number.isFinite(Date.parse(session.startTime)) && proposalFields.filter(key=>key!=='paymentStatus').every(key=>session[key]===proposal[key]) && session.paymentStatus===(isPaid?'paid':'payLater') && session.isPaid===isPaid && Array.isArray(session.orders) && session.orders.length===0;
}
function binding(result,command) {
  return result.requestId===command.requestId && result.kind===command.kind && (command.kind==='add' ? result.outcome==='rejected'?result.queueId===null:text(result.queueId) : result.queueId===command.queueId) && typeof result.replayed==='boolean';
}
function provenRejection(error,command) {
  const result=error?.response;
  return error?.status===409 && exact(result,['requestId','kind','queueId','outcome','queue','table','replayed','code','error']) && binding(result,command) && result.outcome==='rejected' && result.code==='QUEUE_OPERATION_REJECTED' && result.queue===null && result.table===null && text(result.error);
}
async function deliver({storage,staffId,command,request,isCurrent}) {
  const key=keyFor(staffId,command),original=storage.getItem(key);
  if(original!==JSON.stringify({staffId,command})) throw failure();
  const matches=()=>isCurrent() && storage.getItem(key)===original;
  if (!matches()) throw failure();
  let result;
  try { result=await request('/api/queue/operations',JSON.parse(JSON.stringify(command))); }
  catch(error) {
    if (matches() && provenRejection(error,command)) storage.removeItem(key);
    throw error;
  }
  if (!matches() || !validApplied(result,command)) throw failure();
  storage.removeItem(key);
  return result;
}
export async function saveQueueOperation({storage,staffId,kind,payload,request,isCurrent=()=>true,newId=()=>crypto.randomUUID()}) {
  if (!text(staffId) || !isCurrent()) throw failure();
  const candidate=JSON.parse(JSON.stringify({...payload,kind,requestId:newId()}));
  if(kind==='add')for(const key of ['customerName','contactNumber','notes'])if(typeof candidate[key]==='string')candidate[key]=candidate[key].trim();
  if (!validCommand(candidate)) throw new Error('The queue action is incomplete. Refresh and try again.');
  const records=pendingQueueOperations(storage,staffId);
  const existing=records.find(record=>resource(record.command)===resource(candidate));
  let command=existing?.command;
  if (command && canonical({...candidate,requestId:command.requestId})!==canonical(command)) throw failure();
  if (!command) {
    command=candidate;
    const raw=JSON.stringify({staffId,command});
    if (raw.length>65536) throw failure();
    storage.setItem(keyFor(staffId,command),raw);
    if (storage.getItem(keyFor(staffId,command))!==raw) throw failure();
  }
  return deliver({storage,staffId,command,request,isCurrent});
}
export async function retryQueueOperation({storage,staffId,requestId,request,isCurrent=()=>true}) {
  const record=pendingQueueOperations(storage,staffId).find(record=>record.command.requestId===requestId);
  if (!record || !isCurrent()) throw failure();
  return deliver({storage,staffId,command:record.command,request,isCurrent});
}
