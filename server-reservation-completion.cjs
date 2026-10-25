const { createHash, randomUUID } = require('node:crypto');
const { canonicalSession } = require('./server-session-identity.cjs');
const { checkinDefinitions, normalizeSql } = require('./server-checkin-schema.cjs');
const { validateCheckinClaimResult } = require('./server-cloud-staff.cjs');
const { calculateSessionBill } = require('./session-billing.mjs');
const fail = message => Object.assign(new Error(message), { status: 409 });
const same = (a, b) => canonicalSession(a) === canonicalSession(b);
const hash = value => createHash('sha256').update(canonicalSession(value)).digest('hex');
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, error => error ? reject(error) : resolve()));
const get = (db, sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row)));
const parse = value => { try { return JSON.parse(value); } catch { throw fail('Saved reservation operation requires reconciliation.'); } };
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value === value.trim();
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const cents = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) throw fail('Saved reservation amount requires reconciliation.');
  return Math.round(value * 100);
};
const definition = `CREATE TABLE IF NOT EXISTS native_reservation_completion_outbox (
  event_id TEXT PRIMARY KEY, checkout_request_id TEXT NOT NULL UNIQUE,
  claim_id TEXT NOT NULL UNIQUE, reservation_id TEXT NOT NULL, device_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL, delivered_at TEXT)`;
async function assertCompletionSchema(db) {
  const actual = await get(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='native_reservation_completion_outbox'");
  const normalized = value => value.replace(' IF NOT EXISTS', '').replace(/\s+/g, ' ').trim();
  if (!actual || normalized(actual.sql) !== normalized(definition)) throw fail('Unsupported completion journal schema requires owner reconciliation.');
}
async function initializeCompletionSchema(db) {
  await run(db, definition);
  await assertCompletionSchema(db);
}
async function admissionForSession(db, session) {
  try {
    calculateSessionBill(session, Date.parse(session.startTime), false);
    for (const [name, ddl] of checkinDefinitions) {
      const schema = await get(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [name]);
      if (!schema || normalizeSql(schema.sql) !== normalizeSql(ddl)) throw Error('Unsupported admission schema');
    }
    const row = await get(db, 'SELECT * FROM native_checkin_operations WHERE claim_id=?', [session.reservationPricing.claimId]);
    if (!row || row.phase !== 'admitted' || !textId(row.local_staff_id)) throw Error('Missing admission');
    const request = parse(row.request_json), claim = parse(row.claim_json), admitted = parse(row.response_json);
    const requestFields = ['requestId','id','tableId','expectedRevision','expectedStaffId','deviceId'];
    if (!request || Array.isArray(request) || Object.keys(request).length !== requestFields.length || Object.keys(request).some(k => !requestFields.includes(k)) || !uuid(request.requestId) || !uuid(request.expectedStaffId) || !uuid(request.deviceId) || !textId(request.id) || !textId(request.tableId) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1 || request.expectedRevision >= Number.MAX_SAFE_INTEGER || !uuid(admitted.outboxEventId)) throw Error('Invalid original command');
    validateCheckinClaimResult({ claim, replayed: true, recordType: 'reservation-check-in-claim', fundsTransferred: false }, request);
    if (row.request_fingerprint !== hash(request) || row.request_id !== request.requestId || row.cloud_user_id !== request.expectedStaffId || row.device_id !== request.deviceId || row.table_id !== request.tableId || row.reservation_id !== request.id || row.claim_id !== claim.claimId) throw Error('Mismatched claim binding');
    const initial = admitted.table?.session;
    if (!initial || admitted.requestId !== row.request_id || admitted.claimId !== row.claim_id || admitted.phase !== 'admitted' || admitted.cloudAcknowledged !== false || admitted.table.id !== row.table_id || admitted.table.status !== 'occupied' || row.admission_fingerprint !== hash({ requestId: row.request_id, expectedOvertimeRate: initial.overtimeRate })) throw Error('Mismatched admission response');
    const expectedPricing = { claimId: claim.claimId, reservationId: claim.reservationId, ownerUserId: claim.ownerUserId, sourceRevision: claim.sourceRevision, claimRevision: claim.claimRevision, durationMinutes: claim.durationMinutes, grossCents: claim.grossTotalCents, discountCents: claim.discountCents, netCents: claim.netTotalCents, verifiedPaidCents: claim.verifiedPaidCents };
    const expectedInitial = { customerName: claim.customerName, customerEmail: claim.email, customerPhone: claim.contactNumber, reservationId: claim.reservationId, partySize: claim.partySize, startTime: initial.startTime, durationMinutes: claim.durationMinutes, isOpenTime: false, hourlyRate: null, overtimeRate: initial.overtimeRate, pricingVersion: 2, amountPaid: claim.verifiedPaidCents / 100, isPaid: claim.verifiedPaidCents === claim.netTotalCents, paymentStatus: claim.verifiedPaidCents === claim.netTotalCents ? 'paid' : 'payLater', orders: [], reservationPricing: expectedPricing };
    calculateSessionBill(initial, Date.parse(initial.startTime), false);
    if (!same(initial, expectedInitial)) throw Error('Changed initial session');
    for (const field of Object.keys(expectedInitial).filter(field => field !== 'orders')) {
      if (!same(session[field], initial[field])) throw Error('Changed immutable reservation field');
    }
    const event = await get(db, 'SELECT * FROM native_checkin_outbox WHERE request_id=?', [row.request_id]);
    const expectedEvent = { eventId: admitted.outboxEventId, type: 'admission', requestId: row.request_id, claimId: row.claim_id, reservationId: row.reservation_id, deviceId: row.device_id, tableId: row.table_id, localStaffId: row.local_staff_id, cloudUserId: row.cloud_user_id, sessionStartTime: initial.startTime, overtimeRateCents: Math.round(initial.overtimeRate * 100) };
    if (!event || event.event_id !== admitted.outboxEventId || event.claim_id !== row.claim_id || event.event_type !== 'admission' || event.created_at !== initial.startTime || !same(parse(event.payload_json), expectedEvent)) throw Error('Missing admission event');
    return { row, claim, admitted };
  } catch { throw fail('Reservation admission could not be verified. Preserve the session and reconcile its original claim.'); }
}
function snapshot(response, session) {
  const receipt = response.receipt;
  return { receipt, history: response.history, reservationPricing: session.reservationPricing,
    amounts: { bookedGrossCents: cents(receipt.table_charge), bookingDiscountCents: cents(receipt.booking_discount_amount),
      bookedNetCents: session.reservationPricing.netCents, overtimeCents: cents(receipt.overtime_charge), foodAndDrinkCents: cents(receipt.fnb_charge),
      sessionWaiverCents: cents(receipt.discount_amount) - cents(receipt.booking_discount_amount),
      totalCents: cents(receipt.total_amount), allocatedPaidCents: cents(receipt.amount_paid), balanceCents: cents(receipt.balance_due) },
    priorPaymentCents: cents(response.alreadyPaid), collectedNowCents: cents(response.totalPaidNow),
    tenderedCents: cents(response.tendered), changeCents: cents(response.change), refundDueCents: cents(response.refundDue) };
}
async function completionPosition(db, session, tableId) {
  const position=await require('./server-native-delivery.cjs').readAcceptedReservationPosition(db,session,tableId);
  if(!position)return {};
  return {expectedRevision:position.cloud_revision,positionSequence:position.position_sequence,previousPositionEventId:position.position_event_id};
}
async function recordReservationCompletion(db, { session, response, staff, closureKind }) {
  if (!textId(staff?.id)) throw Object.assign(new Error('Staff sign-in is required to settle a reservation.'), { status: 403 });
  const { row, admitted } = await admissionForSession(db, session);
  await initializeCompletionSchema(db);
  if (await get(db, 'SELECT event_id FROM native_reservation_completion_outbox WHERE claim_id=?', [row.claim_id])) throw fail('This reservation already has a completion. Recover the original checkout.');
  const eventId = randomUUID();
  const position=await completionPosition(db,session,response.id);
  const payload = { version: Object.hasOwn(position,'expectedRevision')?2:1, ...position, eventId, type: 'reservation-completion', checkoutRequestId: response.requestId,
    claimRequestId: row.request_id, claimId: row.claim_id, reservationId: row.reservation_id, deviceId: row.device_id,
    admissionEventId: admitted.outboxEventId, admissionTableId: row.table_id, checkoutTableId: response.id,
    admissionLocalStaffId: row.local_staff_id, admissionCloudUserId: row.cloud_user_id, checkoutLocalStaffId: staff.id,
    sessionStartTime: session.startTime, closureKind, ...snapshot(response, session) };
  await run(db, 'INSERT INTO native_reservation_completion_outbox(event_id,checkout_request_id,claim_id,reservation_id,device_id,receipt_id,payload_json,payload_sha256,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)', [eventId,response.requestId,row.claim_id,row.reservation_id,row.device_id,response.receipt.id,JSON.stringify(payload),hash(payload),response.receipt.created_at]);
  return { eventId, cloudAcknowledged: false };
}
async function verifyReservationCompletionReplay(db, response, expectedSession) {
  if (expectedSession.pricingVersion !== 2) {
    if (response.receipt?.pricing_version === 2 || response.reservationCompletion) throw fail('Saved checkout type requires reconciliation.');
    return;
  }
  const { row, admitted } = await admissionForSession(db, expectedSession);
  try {
    await assertCompletionSchema(db);
    const event = await get(db, 'SELECT * FROM native_reservation_completion_outbox WHERE checkout_request_id=?', [response.requestId]);
    if (!event || response.reservationCompletion?.cloudAcknowledged !== false || response.reservationCompletion.eventId !== event.event_id || response.receipt.pricing_version !== 2 || response.receipt.reservation_claim_id !== row.claim_id || response.receipt.reservation_id !== row.reservation_id) throw Error('Missing completion');
    const payload = parse(event.payload_json);
    const currentPosition=await completionPosition(db,expectedSession,response.id);
    const position=payload.version===2?currentPosition:{};
    if(payload.version===1&&Object.hasOwn(currentPosition,'expectedRevision')&&(currentPosition.positionSequence!==0||currentPosition.previousPositionEventId!==admitted.outboxEventId||currentPosition.expectedRevision!==parse(row.claim_json).claimRevision+1||response.id!==row.table_id))throw Error('Legacy completion cannot discard moved position');
    if(payload.version!==1&&payload.version!==2)throw Error('Unsupported completion version');
    if(payload.version===2&&!Object.hasOwn(position,'expectedRevision'))throw Error('Missing completion position');
    const expected = { version: payload.version, ...position, eventId: event.event_id, type: 'reservation-completion', checkoutRequestId: response.requestId,
      claimRequestId: row.request_id, claimId: row.claim_id, reservationId: row.reservation_id, deviceId: row.device_id,
      admissionEventId: admitted.outboxEventId, admissionTableId: row.table_id, checkoutTableId: response.id,
      admissionLocalStaffId: row.local_staff_id, admissionCloudUserId: row.cloud_user_id, checkoutLocalStaffId: payload.checkoutLocalStaffId,
      sessionStartTime: expectedSession.startTime, closureKind: payload.closureKind, ...snapshot(response, expectedSession) };
    if (!textId(payload.checkoutLocalStaffId) || !['checkout','walkout','void'].includes(payload.closureKind) || !same(payload, expected) || event.payload_sha256 !== hash(payload) || event.claim_id !== row.claim_id || event.reservation_id !== row.reservation_id || event.device_id !== row.device_id || event.receipt_id !== response.receipt.id || event.created_at !== response.receipt.created_at) throw Error('Changed completion binding');
    const receipt = await get(db, 'SELECT * FROM e_receipts WHERE id=?', [event.receipt_id]);
    if (!receipt) throw Error('Missing receipt');
    for (const key of Object.keys(response.receipt)) {
      if (key === 'refund_status' && response.receipt.refund_status === 'pending' && receipt.refund_status === 'returned') {
        const returned = await get(db, 'SELECT amount_cents FROM receipt_refund_returns WHERE receipt_id=?', [receipt.id]);
        if (!returned || returned.amount_cents !== cents(receipt.refund_due)) throw Error('Missing refund return');
      } else if (!same(receipt[key], response.receipt[key])) throw Error('Changed receipt');
    }
    const history = await get(db, 'SELECT * FROM session_history WHERE id=?', [response.history.id]);
    if (!history) throw Error('Missing history');
    for (const key of Object.keys(response.history)) if (!same(key === 'orders' ? parse(history.orders) : history[key], response.history[key])) throw Error('Changed history');
  } catch { throw fail('Saved reservation completion requires reconciliation. Retry only the original checkout after review.'); }
}
module.exports = { initializeCompletionSchema, recordReservationCompletion, verifyReservationCompletionReplay, verifyReservationAdmission: admissionForSession };
