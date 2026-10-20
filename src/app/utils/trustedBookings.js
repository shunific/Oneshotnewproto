import { assertPrivateReceiptReference, forgetBookedReceiptUpload } from './privateReceipts.js';
const CREATE_FIELDS = ['tableId', 'date', 'timeSlot', 'durationHours', 'partySize', 'customerName', 'contactNumber', 'promoCode', 'paymentRef', 'receiptPath', 'acceptedTerms', 'expectedTerms', 'expectedTotalCents', 'expectedDownPaymentCents'];
const CHANGE_FIELDS = { reschedule: ['id', 'expectedRevision', 'date', 'timeSlot'], cancel: ['id', 'expectedRevision', 'reason'] };
const KEY = 'oneshot_pending_booking_v1';
export const OWNED_RESERVATION_COLUMNS = 'id,customer_user_id,revision,customerName,contactNumber,email,date,timeSlot,durationHours,partySize,tableId,status,totalAmount,total_amount_cents,downPaymentAmount,down_payment_amount_cents,downPaymentPaid,balancePaid,createdAt,cancellation_reason,promoCode,discountAmount,discount_amount_cents,paymentRef,receiptImg,rescheduleCount,refundStatus,refundMethod,refundNotes';

function canonicalCents(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function reservationCents(row, column, legacyField) {
  const canonical = row[column];
  if (canonical !== null && canonical !== undefined) return canonicalCents(canonical);
  return hasMoney(row[legacyField]) ? Math.round(Number(row[legacyField]) * 100) : null;
}

export function mapOwnedReservation(row) {
  const total = reservationCents(row, 'total_amount_cents', 'totalAmount');
  const downPayment = reservationCents(row, 'down_payment_amount_cents', 'downPaymentAmount');
  const discount = reservationCents(row, 'discount_amount_cents', 'discountAmount');
  return { ...row, revision: Number(row.revision), totalAmount: total === null ? null : total / 100, downPaymentAmount: downPayment === null ? null : downPayment / 100,
    discountAmount: discount === null ? null : discount / 100, rescheduleCount: Number(row.rescheduleCount || 0),
    downPaymentPaid: [true, 1, '1', 'true'].includes(row.downPaymentPaid), balancePaid: [true, 1, '1', 'true'].includes(row.balancePaid),
    cancellationReason: row.cancellation_reason || row.cancellationreason || undefined,
  };
}

function hasMoney(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value))) return false;
  const cents = Number(value) * 100;
  return Number.isFinite(cents) && cents >= 0 && Number.isSafeInteger(Math.round(cents)) && Math.abs(cents - Math.round(cents)) < 0.00001;
}

export async function verifiedBookingUser(client) {
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  if (!data?.user?.id || data.user.is_anonymous || !data.user.email_confirmed_at) throw new Error('Sign in with a verified customer account to manage bookings.');
  return data.user;
}

export function bookingCommand(kind, input) {
  const allowed = kind === 'create' ? CREATE_FIELDS : CHANGE_FIELDS[kind];
  if (!allowed || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid booking request.');
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unsupported booking field: ${key}`);
  if (kind === 'create') {
    if (input.acceptedTerms !== true || typeof input.expectedTerms !== 'string') throw new Error('Review and accept the current booking terms.');
    if (input.receiptPath != null) assertPrivateReceiptReference({ bucket: 'oneshot-receipts', path: input.receiptPath });
    for (const key of ['expectedTotalCents', 'expectedDownPaymentCents']) if (!Number.isSafeInteger(input[key]) || input[key] < 0) throw new Error('Review the booking price.');
  } else if (!input.id || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('Refresh your booking before making changes.');
  return Object.fromEntries(allowed.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
}

function pendingKey(ownerId) { return `${KEY}:${ownerId}`; }
export function readPendingBooking(storage, ownerId) {
  if (!storage || !ownerId) return null;
  const raw = storage.getItem(pendingKey(ownerId));
  if (!raw) return null;
  const record = JSON.parse(raw);
  if (record.ownerId !== ownerId || typeof record.requestId !== 'string') throw new Error('Invalid pending booking. Contact staff before creating another booking.');
  bookingCommand(record.kind, record.input);
  return record;
}
export function clearPendingBookings(storage, exceptOwnerId = null) {
  if (!storage) return;
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (key?.startsWith(`${KEY}:`) && key !== pendingKey(exceptOwnerId)) storage.removeItem(key);
  }
}
function clearMatchingBooking(storage, record) {
  const pending = readPendingBooking(storage, record.ownerId);
  if (!pending || pending.requestId !== record.requestId || pending.kind !== record.kind || JSON.stringify(pending.input) !== JSON.stringify(record.input)) return false;
  storage.removeItem(pendingKey(record.ownerId));
  return true;
}
export async function submitTrustedBooking(client, kind, input, storage, { retry = false, expectedOwnerId, isCurrentOwner = () => true, randomUUID = () => crypto.randomUUID() } = {}) {
  const user = await verifiedBookingUser(client);
  if (!isCurrentOwner() || (expectedOwnerId && user.id !== expectedOwnerId)) throw new Error('Your account changed. Review the booking under your current account.');
  const clean = bookingCommand(kind, input);
  if (kind === 'create' && clean.receiptPath != null) assertPrivateReceiptReference({ bucket: 'oneshot-receipts', path: clean.receiptPath }, user.id);
  const pending = readPendingBooking(storage, user.id);
  if (pending && (pending.kind !== kind || JSON.stringify(pending.input) !== JSON.stringify(clean))) {
    throw new Error('A previous booking request is unconfirmed. Retry that request or check My Bookings before making another change.');
  }
  if (retry && !pending) throw new Error('There is no pending booking request to retry.');
  const record = pending || { ownerId: user.id, kind, input: clean, requestId: randomUUID() };
  // Session storage survives a tab reload; changing accounts clears these private drafts.
  storage.setItem(pendingKey(user.id), JSON.stringify(record));
  let response;
  try { response = await client.rpc(`oneshot_booking_${kind}`, { payload: { ...clean, expectedCustomerId: user.id, requestId: record.requestId } }); }
  catch (error) { if (!isCurrentOwner()) clearMatchingBooking(storage, record); throw new Error('The booking result is unknown. Use Retry pending request; do not create a second booking.', { cause: error }); }
  if (!isCurrentOwner()) { clearMatchingBooking(storage, record); throw new Error('Your account changed. Sign in to the original account to review the booking result.'); }
  if (response.error) {
    const error = response.error;
    const definitive = ['22023', '23505', '42501', 'P0001'].includes(error.code);
    if (definitive) clearMatchingBooking(storage, record);
    if (String(error.message).includes('QUOTE_CHANGED')) {
      let quote;
      try {
        const value = JSON.parse(error.details);
        if (['totalCents', 'downPaymentCents', 'discountCents'].every(key => Number.isSafeInteger(value?.[key]) && value[key] >= 0)) quote = value;
      } catch { /* The form still retains the original quote. */ }
      const mismatch = new Error('The server price changed. Review the updated total and accept the terms again.');
      mismatch.code = 'QUOTE_CHANGED'; mismatch.quote = quote; throw mismatch;
    }
    throw error;
  }
  const row = response.data?.reservation;
  const rawRevision = row?.revision;
  const validRevision = (typeof rawRevision === 'number' || (typeof rawRevision === 'string' && /^\d+$/.test(rawRevision))) && Number.isSafeInteger(Number(rawRevision)) && Number(rawRevision) >= 1;
  const hasCanonicalMoney = row && ['total_amount_cents', 'down_payment_amount_cents', 'discount_amount_cents'].every(key => canonicalCents(row[key]) !== null);
  const saved = hasCanonicalMoney && validRevision ? mapOwnedReservation(row) : null;
  if (!saved?.id || !['pending', 'confirmed', 'checked-in', 'completed', 'cancelled', 'pending-refund', 'walkout'].includes(saved.status) || !Number.isFinite(saved.totalAmount) || saved.totalAmount < 0 || !Number.isFinite(saved.downPaymentAmount) || saved.downPaymentAmount < 0 || saved.customer_user_id !== user.id || !Number.isSafeInteger(Number(saved.revision)) || Number(saved.revision) < 1 || (kind !== 'create' && saved.id !== clean.id)) {
    throw new Error('The booking acknowledgement is incomplete. Retry the pending request to confirm its result.');
  }
  if (kind === 'create' && (reservationCents(row, 'total_amount_cents', 'totalAmount') !== clean.expectedTotalCents || reservationCents(row, 'down_payment_amount_cents', 'downPaymentAmount') !== clean.expectedDownPaymentCents)) throw new Error('The saved price could not be confirmed. Retry the pending request and contact staff before sending payment.');
  if (kind !== 'create' && saved.revision <= clean.expectedRevision) throw new Error('The saved revision could not be confirmed. Retry the pending request.');
  if (kind === 'cancel' && !['cancelled', 'pending-refund'].includes(saved.status)) throw new Error('The cancellation could not be confirmed. Retry the pending request.');
  if (kind !== 'cancel' && (saved.date !== clean.date || saved.timeSlot !== clean.timeSlot)) throw new Error('The saved schedule could not be confirmed. Retry the pending request.');
  if (kind === 'create' && (!['pending', 'confirmed'].includes(saved.status) || saved.tableId !== clean.tableId || Number(saved.durationHours) !== clean.durationHours || Number(saved.partySize) !== clean.partySize)) throw new Error('The saved booking details could not be confirmed. Retry the pending request.');
  if (kind === 'create' && (saved.receiptImg ?? null) !== (clean.receiptPath ?? null)) throw new Error('The saved receipt could not be confirmed. Retry the pending request before sending another receipt.');
  if (!clearMatchingBooking(storage, record)) throw new Error('This booking request was already handled or superseded. Check My Bookings for its result.');
  if (kind === 'create' && clean.receiptPath) forgetBookedReceiptUpload(storage, { bucket: 'oneshot-receipts', path: clean.receiptPath });
  return saved;
}

export function createOwnedReservationLoader(client, onRows) {
  let generation = 0;
  let ownerId = null;
  return {
    changeOwner(nextOwnerId) { ownerId = nextOwnerId; generation++; onRows([]); },
    async refresh() {
      const expected = ownerId;
      const version = ++generation;
      if (!expected) return;
      const { data, error } = await client.from('reservations').select(OWNED_RESERVATION_COLUMNS).eq('customer_user_id', expected).order('createdAt', { ascending: false });
      if (version !== generation || ownerId !== expected) return;
      if (error) { onRows([]); throw error; }
      if (!Array.isArray(data) || data.some(row => row.customer_user_id !== expected)) { onRows([]); throw new Error('Reservation ownership could not be verified.'); }
      onRows(data.map(mapOwnedReservation));
    },
  };
}
