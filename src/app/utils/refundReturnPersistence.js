const PREFIX = 'oneshot_refund_return_pending:';
const generations = new WeakMap();
const generation = storage => generations.get(storage) || 0;
export function clearRefundReturnDrafts(storage, exceptLocalId = null) {
  if (storage && (typeof storage === 'object' || typeof storage === 'function')) generations.set(storage,generation(storage)+1);
  const keep = exceptLocalId === null ? null : PREFIX + encodeURIComponent(exceptLocalId) + ':';
  for (let index=storage.length-1;index>=0;index--) { const name=storage.key(index); if(name?.startsWith(PREFIX)&&(!keep||!name.startsWith(keep)))storage.removeItem(name); }
}
export const validRefundReference = value => typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9 -]+$/.test(value) && value.replace(/[ -]/g,'').length >= 3;
const fields = ['requestId','expectedActorId','expectedRefundDueCents','method','reference','reason','acknowledgedReturned'];
function key(staffId,receiptId) {
  if (typeof staffId !== 'string' || !staffId || typeof receiptId !== 'string' || !receiptId) throw new Error('Administrator and receipt identity are required.');
  return PREFIX + encodeURIComponent(staffId) + ':' + encodeURIComponent(receiptId);
}
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(name=>!fields.includes(name)) || typeof input.expectedActorId !== 'string' || !input.expectedActorId.trim() || input.expectedActorId.length > 128 || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId) || !Number.isSafeInteger(input.expectedRefundDueCents) || input.expectedRefundDueCents <= 0 || !['cash','gcash'].includes(input.method) || input.acknowledgedReturned !== true || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000 || (input.reference !== undefined && (typeof input.reference !== 'string' || input.reference.length > 128)) || (input.method === 'gcash' && !validRefundReference(input.reference))) throw new Error('Review the full refund amount, return method, reference and reason.');
  return input;
}
export function receiptRefundCents(receipt) {
  const value = receipt?.refund_due;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value*100)) || Math.abs(value*100-Math.round(value*100)) > 0.000001) throw new Error('Stored refund liability needs reconciliation.');
  return Math.round(value*100);
}
export function pendingRefundReturn(storage,staffId,receiptId) {
  if (!storage) throw new Error('Keep this tab open and restore session storage before recording a return.');
  const raw = storage.getItem(key(staffId,receiptId));
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length > 4096) throw new Error('Pending refund return needs staff review.');
  let record;try { record=JSON.parse(raw); } catch { throw new Error('Pending refund return needs staff review.'); }
  if (record?.staffId !== staffId || record?.receiptId !== receiptId || Object.keys(record).some(name=>!['staffId','receiptId','input'].includes(name))) throw new Error('Pending refund return identity could not be verified.');
  const input=validate(record.input);
  if(input.expectedActorId!==staffId)throw new Error('Pending refund administrator identity does not match.');
  return input;
}
export function validateRefundReturnSnapshot(value,receiptId) {
  if (value?.fundsTransferred !== false || value.receipt?.id !== receiptId) throw new Error('The authoritative receipt could not be verified.');
  const cents=receiptRefundCents(value.receipt),audit=value.refundReturn;
  if (audit !== null && (!audit || typeof audit.id !== 'string' || !audit.id || audit.receiptId !== receiptId || audit.amountCents !== cents || cents <= 0 || !['cash','gcash'].includes(audit.method) || typeof audit.requestId !== 'string' || typeof audit.actorId !== 'string' || !audit.actorId || typeof audit.actorName !== 'string' || !audit.actorName || typeof audit.reason !== 'string' || !audit.reason.trim() || (audit.reference !== null && typeof audit.reference !== 'string') || (audit.method === 'gcash' && !validRefundReference(audit.reference)) || typeof audit.createdAt !== 'string' || !Number.isFinite(Date.parse(audit.createdAt)) || value.receipt.refund_status !== 'returned')) throw new Error('Refund return audit needs reconciliation.');
  if (value.receipt.refund_status === 'returned' && !audit) throw new Error('Returned receipt is missing its audit.');
  return value;
}
function assertAck(value,staffId,receiptId,input) {
  validateRefundReturnSnapshot(value,receiptId);
  const audit=value.refundReturn;
  if (!audit || audit.actorId !== staffId || audit.requestId !== input.requestId || audit.amountCents !== input.expectedRefundDueCents || audit.method !== input.method || audit.reference !== (input.reference === undefined ? null : input.reference.trim()) || audit.reason !== input.reason.trim()) throw new Error('Return result is unconfirmed. Retry the exact pending request; do not return money again.');
}
function clearMatching(storage,staffId,receiptId,input) {
  const stored=pendingRefundReturn(storage,staffId,receiptId);
  if (stored && JSON.stringify(stored) === JSON.stringify(input)) storage.removeItem(key(staffId,receiptId));
}
export function reconcileRefundReturn(storage,staffId,receiptId,value,isCurrent=()=>true) {
  if (!isCurrent()) throw new Error('Administrator account changed.');
  const pending=pendingRefundReturn(storage,staffId,receiptId);
  if (!pending) return false;
  assertAck(value,staffId,receiptId,pending);
  if (!isCurrent()) throw new Error('Administrator account changed.');
  clearMatching(storage,staffId,receiptId,pending);return true;
}
export async function confirmRefundReturn(request,storage,staffId,receiptId,input,isCurrent=()=>true) {
  validate(input);
  if(input.expectedActorId!==staffId)throw new Error('Administrator account changed.');
  if (!isCurrent()) throw new Error('Administrator account changed.');
  const old=pendingRefundReturn(storage,staffId,receiptId);
  const epoch=generation(storage);
  if (old && JSON.stringify(old)!==JSON.stringify(input)) throw new Error('Retry the exact pending return before editing this record.');
  const record={staffId,receiptId,input};storage.setItem(key(staffId,receiptId),JSON.stringify(record));
  if (!isCurrent()) throw new Error('Administrator account changed.');
  let value;
  try { value=await request(input); }
  catch(error) {
    if (isCurrent() && generation(storage)===epoch && error?.committed===false && [400,404,409].includes(error.status)) {
      try { clearMatching(storage,staffId,receiptId,input); }
      catch { throw Object.assign(new Error('The return was rejected, but recovery storage could not be updated. Keep this tab open and restore session storage before continuing.'),{cause:error}); }
    }
    throw error;
  }
  if (!isCurrent() || generation(storage)!==epoch) throw new Error('Administrator account changed. Keep the pending request for the original administrator.');
  assertAck(value,staffId,receiptId,input);
  clearMatching(storage,staffId,receiptId,input);return value;
}
