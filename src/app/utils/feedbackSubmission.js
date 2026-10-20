import { verifiedBookingUser } from './trustedBookings.js';
const CATEGORIES = ['suggestion', 'complaint', 'lost_item', 'compliment', 'other'];
const FIELDS = ['customerName', 'contactInfo', 'feedbackType', 'comment', 'reservationId'];
const PREFIX = 'oneshot_pending_feedback_v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidPhone(value) {
  return typeof value === 'string' && /^(09\d{9}|639\d{9}|\+639\d{9})$/.test(value.trim());
}
function feedbackInput(input, allowEmail) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !FIELDS.includes(key))) throw new Error('Unsupported feedback fields.');
  for (const key of ['customerName', 'contactInfo', 'comment', 'feedbackType']) if (typeof input[key] !== 'string') throw new Error('Enter your name, message and contact details.');
  const customerName = input.customerName.trim(), comment = input.comment.trim(), contactInfo = input.contactInfo.trim();
  const validEmail = allowEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactInfo);
  if (!customerName || customerName.length > 120 || !comment || comment.length > 4000 || contactInfo.length > 254 || (!isValidPhone(contactInfo) && !validEmail)) throw new Error('Enter your name (up to 120 characters), message (up to 4000) and a valid contact number or permitted email.');
  if (!CATEGORIES.includes(input.feedbackType)) throw new Error('Choose a feedback category.');
  if (input.reservationId != null && (typeof input.reservationId !== 'string' || !input.reservationId.trim() || input.reservationId.trim().length > 100)) throw new Error('Enter a valid reservation ID belonging to your account.');
  return { customerName, contactInfo, feedbackType: input.feedbackType, comment, ...(input.reservationId ? { reservationId: input.reservationId.trim() } : {}) };
}
export function readPendingFeedback(storage, ownerId) {
  if (!storage || !ownerId) return null;
  const value = storage.getItem(`${PREFIX}${ownerId}`);
  if (!value) return null;
  const record = JSON.parse(value);
  if (record.ownerId !== ownerId || !UUID.test(record.requestId)) throw new Error('Pending feedback could not be verified. Contact staff before submitting again.');
  feedbackInput(record.input, true);
  return record;
}
export function clearPendingFeedback(storage, exceptOwnerId = null) {
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (key?.startsWith(PREFIX) && key !== `${PREFIX}${exceptOwnerId}`) storage.removeItem(key);
  }
}
function clearMatchingFeedback(storage, record) {
  const pending = readPendingFeedback(storage, record.ownerId);
  if (!pending || pending.requestId !== record.requestId || JSON.stringify(pending.input) !== JSON.stringify(record.input)) return false;
  storage.removeItem(`${PREFIX}${record.ownerId}`);
  return true;
}
export async function submitFeedback(client, input, { allowEmail = false, storage = globalThis.sessionStorage, expectedOwnerId, isCurrentOwner = () => true, retry = false, randomUUID = () => crypto.randomUUID() } = {}) {
  const clean = feedbackInput(input, allowEmail);
  const user = await verifiedBookingUser(client);
  if (!isCurrentOwner() || (expectedOwnerId && user.id !== expectedOwnerId)) throw new Error('Your account changed. Review the feedback before submitting.');
  if (!storage) throw new Error('Private retry storage is unavailable. No feedback was submitted.');
  const pending = readPendingFeedback(storage, user.id);
  if (pending && JSON.stringify(pending.input) !== JSON.stringify(clean)) throw new Error('A previous feedback request is unconfirmed. Retry that request before sending a different message.');
  if (retry && !pending) throw new Error('No pending feedback request.');
  const record = pending || { ownerId: user.id, requestId: randomUUID(), input: clean };
  storage.setItem(`${PREFIX}${user.id}`, JSON.stringify(record));
  let response;
  try { response = await client.rpc('oneshot_feedback_create', { payload: { ...clean, requestId: record.requestId, expectedCustomerId: user.id } }); }
  catch (error) {
    if (!isCurrentOwner()) clearMatchingFeedback(storage, record);
    throw new Error('The feedback result is unknown. Use Retry pending feedback; do not send a new copy.', { cause: error });
  }
  if (!isCurrentOwner()) { clearMatchingFeedback(storage, record); throw new Error('Your account changed. Contact staff to check the original feedback result.'); }
  if (response.error) {
    if (['P0001', '22023', '42501'].includes(response.error.code)) clearMatchingFeedback(storage, record);
    throw response.error;
  }
  const saved = response.data?.feedback;
  if (!saved || !UUID.test(saved.id) || saved.customer_user_id !== user.id || saved.status !== 'pending' || typeof saved.date !== 'string' || !Number.isFinite(Date.parse(saved.date))) throw new Error('Feedback was not confirmed. Retry the pending request to check its result.');
  if (!clearMatchingFeedback(storage, record)) throw new Error('This feedback request was already handled or superseded. Check its earlier result before submitting again.');
  return saved;
}
