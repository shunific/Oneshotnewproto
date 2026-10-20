const prefix = 'oneshot_pending_session:';
export function pendingSessionChanges(storage) {
  const records = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) {
      const record = JSON.parse(storage.getItem(key));
      if (!record || !['extend','move'].includes(record.kind) || typeof record.tableId !== 'string' || !record.payload?.expectedSession || typeof record.requestId !== 'string') throw new Error('A saved session action needs reconciliation.');
      records.push(record);
    }
  }
  return records;
}
export async function saveSessionChange({ storage, request, tableId, kind, payload, newId = () => crypto.randomUUID() }) {
  const key = prefix + tableId;
  let record = pendingSessionChanges(storage).find(item => item.tableId === tableId);
  if (record && (record.kind !== kind || JSON.stringify(record.payload) !== JSON.stringify(payload))) throw new Error('Resolve the pending session action using Retry before making another change.');
  if (!record) { record = { tableId, kind, payload, requestId: newId() }; storage.setItem(key, JSON.stringify(record)); }
  const original=storage.getItem(key);
  const clearOwn=()=>{if(storage.getItem(key)===original)storage.removeItem(key);};
  let result;
  try { result = await request(`/api/tables/${encodeURIComponent(tableId)}/${kind}`, { ...record.payload, requestId: record.requestId }); }
  catch(error) {
    const reservationMove=kind==='move'&&record.payload.expectedSession.pricingVersion===2;
    const rejection=error.response;
    const notStarted=error.status===409&&rejection?.code==='NATIVE_MOVE_NOT_STARTED'&&rejection.requestId===record.requestId&&rejection.sourceId===tableId;
    if ((!reservationMove&&[400,404,409].includes(error.status))||(reservationMove&&notStarted)) clearOwn();
    throw error;
  }
  if(kind==='move'&&record.payload.expectedSession.pricingVersion===2&&result?.requestId===record.requestId&&result.phase==='aborted'&&(result.cloudAcknowledged===true||result.replayed===true)){clearOwn();return result;}
  if (result?.id !== tableId || result.requestId !== record.requestId || (kind === 'extend' ? !result.session : result.target?.id !== payload.targetId)) throw new Error('Session action was not confirmed. Retry the saved action.');
  clearOwn();
  return result;
}

export function readPendingReservationMoveList(value) {
  const fields=['requestId','moveId','sourceId','targetId','phase'];
  if(!value||Object.keys(value).length!==1||!Array.isArray(value.moves)||value.moves.length>1000)throw new Error('Pending transfers could not be verified. Refresh before changing held tables.');
  const seen=new Set(),moves=new Set();
  return value.moves.map(record=>{
    if(!record||Array.isArray(record)||Object.keys(record).length!==fields.length||fields.some(key=>!Object.hasOwn(record,key))||typeof record.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(record.requestId)||typeof record.moveId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.moveId)||!['sourceId','targetId'].every(key=>typeof record[key]==='string'&&record[key].length>0&&record[key].length<=120&&record[key].trim()===record[key])||record.sourceId===record.targetId||!['prepared','aborting','local-committed'].includes(record.phase)||seen.has(record.requestId)||moves.has(record.moveId))throw new Error('Pending transfers need reconciliation. Keep the original operation.');
    seen.add(record.requestId);moves.add(record.moveId);return Object.fromEntries(fields.map(key=>[key,record[key]]));
  });
}
export async function recoverReservationMove({storage,request,record,action,isCurrent=()=>true}) {
  readPendingReservationMoveList({moves:[record]});
  if(!['continue','abort'].includes(action)||!isCurrent())throw new Error('Review the current account and transfer before recovery.');
  if(action==='abort'&&record.phase==='local-committed')throw new Error('The session already moved. Retry its original transfer.');
  const key=prefix+record.sourceId,original=storage.getItem(key);
  const result=await request('/api/native/reservation-moves/recover',{requestId:record.requestId,action});
  if(!isCurrent())throw new Error('Staff account changed. Refresh the original transfer to confirm its outcome.');
  if(result?.requestId!==record.requestId||result.moveId!==record.moveId||!['committed','aborted'].includes(result.phase)||(result.cloudAcknowledged!==true&&result.replayed!==true)||(result.phase==='committed'&&(result.id!==record.sourceId||result.target?.id!==record.targetId)))throw new Error('Transfer recovery was not confirmed. Keep the original request and retry.');
  if(original!==null&&storage.getItem(key)===original){let draft;try{draft=JSON.parse(original);}catch{throw new Error('The saved transfer draft needs reconciliation.');}if(draft.requestId===record.requestId)storage.removeItem(key);}
  return result;
}
