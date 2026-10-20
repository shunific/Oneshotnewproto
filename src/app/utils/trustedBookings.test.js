import { uploadPrivateBookingReceipt } from './privateReceipts.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingCommand, mapOwnedReservation, submitTrustedBooking, readPendingBooking, clearPendingBookings, createOwnedReservationLoader } from './trustedBookings.js';
import { bookingPaymentSummary } from './bookingPaymentSummary.js';
const user = { id: '11111111-1111-1111-1111-111111111111', email_confirmed_at: '2026-10-19T00:00:00Z' };
const input = { tableId: 'table-1', date: '2026-10-25', timeSlot: '14:00', durationHours: 2, partySize: 2, customerName: 'QA Owner', contactNumber: '09123456789', acceptedTerms: true, expectedTerms: 'Venue terms', expectedTotalCents: 30000, expectedDownPaymentCents: 6000 };
const saved = { date: input.date, timeSlot: input.timeSlot, tableId: input.tableId, durationHours: input.durationHours, partySize: input.partySize, id: 'QA1234', customer_user_id: user.id, revision: 1, status: 'pending', total_amount_cents: 30000, down_payment_amount_cents: 6000, discount_amount_cents: 0, totalAmount: 300, downPaymentAmount: 60, discountAmount: 0, rescheduleCount: 0, downPaymentPaid: false, balancePaid: false, cancellationReason: undefined };
function storage() { const values = new Map(); return { get length() { return values.size; }, key: index => [...values.keys()][index], getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; }
function client(rpc, signedIn = user) { return { auth: { getUser: async () => ({ data: { user: signedIn } }) }, rpc }; }

test('create refuses client financial state, status, owner and public receipt URL fields', () => {
  for (const field of ['totalAmount', 'downPaymentPaid', 'balancePaid', 'status', 'customer_user_id', 'email', 'receiptImg', 'expectedCustomerId']) assert.throws(() => bookingCommand('create', { ...input, [field]: 'forged' }), /Unsupported booking field/);
});
test('terms and exact nonnegative cents must be reviewed', () => {
  assert.throws(() => bookingCommand('create', { ...input, acceptedTerms: false }), /terms/);
  assert.throws(() => bookingCommand('create', { ...input, expectedTotalCents: 1.5 }), /price/);
  assert.throws(() => bookingCommand('reschedule', { id: saved.id, expectedRevision: 0, date: input.date, timeSlot: input.timeSlot }), /Refresh/);
});
test('guest, anonymous and unverified users cannot dispatch a booking', async () => {
  for (const account of [null, { ...user, is_anonymous: true }, { ...user, email_confirmed_at: null }]) await assert.rejects(submitTrustedBooking(client(() => assert.fail('RPC called'), account), 'create', input, storage()), /verified customer/);
});
test('account changed before submission is rejected before dispatch', async () => {
  await assert.rejects(submitTrustedBooking(client(() => assert.fail('RPC called')), 'create', input, storage(), { expectedOwnerId: 'different-owner' }), /account changed/);
});
test('unknown response persists identical request and reload retry cannot duplicate with a new ID', async () => {
  const store = storage(); const calls = [];
  const api = client(async (name, args) => { calls.push({ name, args }); if (calls.length === 1) throw new Error('Connection lost after commit'); return { data: { reservation: saved, replayed: true } }; });
  await assert.rejects(submitTrustedBooking(api, 'create', input, store, { randomUUID: () => 'request-uuid' }), /unknown/);
  const pending = readPendingBooking(store, user.id);
  assert.equal(pending.requestId, 'request-uuid');
  assert.deepEqual(await submitTrustedBooking(api, pending.kind, pending.input, store, { retry: true }), saved);
  assert.equal(calls[1].args.payload.requestId, calls[0].args.payload.requestId);
  assert.equal(calls[1].args.payload.expectedCustomerId, user.id);
  assert.equal(calls[1].name, 'oneshot_booking_create');
  assert.equal(store.length, 0);
});
test('an unknown pending request blocks altered booking intent before another RPC', async () => {
  const store = storage(); let calls = 0;
  const api = client(async () => { calls++; throw new Error('timeout'); });
  await assert.rejects(submitTrustedBooking(api, 'create', input, store));
  await assert.rejects(submitTrustedBooking(api, 'create', { ...input, partySize: 3 }, store), /previous booking request/);
  assert.equal(calls, 1);
});
test('quote changes preserve server quote and clear rejected noncommitting request', async () => {
  const store = storage(); const quote = { totalCents: 40000, downPaymentCents: 10000, discountCents: 0 };
  await assert.rejects(submitTrustedBooking(client(async () => ({ error: { code: 'P0001', message: 'QUOTE_CHANGED', details: JSON.stringify(quote) } })), 'create', input, store), error => error.code === 'QUOTE_CHANGED' && assert.deepEqual(error.quote, quote) === undefined);
  assert.equal(store.length, 0);
});
test('unverified acknowledgements and auth failures retain request for a safe retry', async () => {
  for (const response of [{ data: { reservation: { ...saved, customer_user_id: 'another-owner' } } }, { data: null }, { error: { code: 'PGRST301', message: 'JWT expired' } }]) {
    const store = storage(); await assert.rejects(submitTrustedBooking(client(async () => response), 'create', input, store)); assert.ok(readPendingBooking(store, user.id));
  }
});
test('reschedule/cancel require revisions and send no arbitrary mutation fields', async () => {
  for (const kind of ['reschedule', 'cancel']) {
    let payload;
    const changes = kind === 'reschedule' ? { id: saved.id, expectedRevision: 2, date: input.date, timeSlot: input.timeSlot } : { id: saved.id, expectedRevision: 2, reason: 'QA cancellation' };
    await submitTrustedBooking(client(async (name, args) => { assert.equal(name, `oneshot_booking_${kind}`); payload = args.payload; return { data: { reservation: { ...saved, revision: 3, status: kind === 'cancel' ? 'cancelled' : 'pending' } } }; }), kind, changes, storage());
    assert.equal(payload.expectedRevision, 2); assert.equal(payload.expectedCustomerId, user.id);
    assert.throws(() => bookingCommand(kind, { ...changes, status: 'completed' }), /Unsupported/);
  }
});
test('auth switches clear private drafts while preserving current-owner reload retry only', () => {
  const store = storage(); store.setItem(`oneshot_pending_booking_v1:${user.id}`, '{}'); store.setItem('oneshot_pending_booking_v1:other', '{}'); store.setItem('unrelated', 'keep');
  clearPendingBookings(store, user.id); assert.equal(store.length, 2);
  clearPendingBookings(store); assert.equal(store.length, 1); assert.equal(store.getItem('unrelated'), 'keep');
});
test('old in-flight owner load cannot reinstall private rows after account switch or logout', async () => {
  let resolve; const applied = []; let queriedOwner;
  const api = { from(table) { assert.equal(table, 'reservations'); return { select(columns) { assert.match(columns, /customer_user_id/); return { eq(key, owner) { assert.equal(key, 'customer_user_id'); queriedOwner = owner; return { order() { return new Promise(done => { resolve = done; }); } }; } }; } }; } };
  const loader = createOwnedReservationLoader(api, rows => applied.push(rows));
  loader.changeOwner(user.id); const old = loader.refresh(); assert.equal(queriedOwner, user.id);
  loader.changeOwner('new-owner'); resolve({ data: [saved], error: null }); await old;
  assert.deepEqual(applied, [[], []]);
  loader.changeOwner(null); await loader.refresh(); assert.deepEqual(applied.at(-1), []);
});
test('owner loader rejects cross-owner response even if upstream RLS is misconfigured', async () => {
  const applied = []; const api = { from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [{ ...saved, customer_user_id: 'foreign-owner' }] }) }) }) }) };
  const loader = createOwnedReservationLoader(api, rows => applied.push(rows)); loader.changeOwner(user.id);
  await assert.rejects(loader.refresh(), /ownership/); assert.deepEqual(applied.at(-1), []);
});

 test('acknowledged prices must match the reviewed quote before confirming creation', async () => {
  for (const wrong of [{ total_amount_cents: 1 }, { down_payment_amount_cents: 0 }, { total_amount_cents: -1 }, { revision: 0 }]) {
    const store = storage();
    await assert.rejects(submitTrustedBooking(client(async () => ({ data: { reservation: { ...saved, ...wrong } } })), 'create', input, store));
    assert.ok(readPendingBooking(store, user.id));
  }
});

test('booking is never dispatched when the retry record cannot be persisted', async () => {
  const store = storage(); store.setItem = () => { throw new Error('Storage unavailable'); };
  await assert.rejects(submitTrustedBooking(client(() => assert.fail('Unrecoverable request was sent')), 'create', input, store), /Storage unavailable/);
});

test('null, boolean, empty and non-cent acknowledgements cannot masquerade as a free booking', async () => {
  const free = { ...input, expectedTotalCents: 0, expectedDownPaymentCents: 0 };
  for (const malformed of [null, false, '', ' ', [], {}, '0.0001', 0.001]) {
    const store = storage();
    await assert.rejects(submitTrustedBooking(client(async () => ({ data: { reservation: { ...saved, totalAmount: malformed, downPaymentAmount: 0, total_amount_cents: malformed, down_payment_amount_cents: 0 } } })), 'create', free, store));
    assert.ok(readPendingBooking(store, user.id));
  }
});
test('unchanged revisions, uncancelled state and wrong saved schedules cannot confirm a change', async () => {
  for (const [kind, change, row] of [
    ['cancel', { id: saved.id, expectedRevision: 1 }, { ...saved, revision: 2 }],
    ['cancel', { id: saved.id, expectedRevision: 1 }, { ...saved, revision: 1, status: 'cancelled' }],
    ['reschedule', { id: saved.id, expectedRevision: 1, date: input.date, timeSlot: '16:00' }, { ...saved, revision: 2 }],
    ['create', input, { ...saved, tableId: 'wrong-table' }],
  ]) {
    const store = storage();
    await assert.rejects(submitTrustedBooking(client(async () => ({ data: { reservation: row } })), kind, change, store));
    assert.ok(readPendingBooking(store, user.id));
  }
});

test('an account switch while a request is in flight cannot retain its old private retry draft', async () => {
  for (const lostResponse of [false, true]) {
    const store = storage(); let resolve, reject, active = true;
    const api = client(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    const operation = submitTrustedBooking(api, 'create', input, store, { isCurrentOwner: () => active });
    await new Promise(done => setTimeout(done, 0));
    assert.ok(readPendingBooking(store, user.id));
    active = false; clearPendingBookings(store);
    if (lostResponse) reject(new Error('Connection dropped')); else resolve({ data: { reservation: saved } });
    await assert.rejects(operation);
    assert.equal(store.length, 0);
  }
});

test('unknown legacy owner amounts stay unconfirmed instead of becoming zero peso balances', () => {
  for (const bad of [null, false, '', ' ', undefined]) {
    const mapped = mapOwnedReservation({ ...saved, total_amount_cents: null, down_payment_amount_cents: null, totalAmount: bad, downPaymentAmount: bad });
    assert.equal(mapped.totalAmount, null); assert.equal(mapped.downPaymentAmount, null);
    const summary = bookingPaymentSummary(mapped);
    assert.equal(summary.total, null); assert.equal(summary.balanceDisplay, 'Unconfirmed');
  }
});

test('canonical integer cents preserve large and fractional prices despite rounded legacy REAL fields', () => {
  const mapped = mapOwnedReservation({ ...saved, totalAmount: 2400000, downPaymentAmount: 600000, discountAmount: 17,
    total_amount_cents: 239999976, down_payment_amount_cents: '60000000', discount_amount_cents: 1713 });
  assert.equal(mapped.totalAmount, 2399999.76);
  assert.equal(mapped.downPaymentAmount, 600000);
  assert.equal(mapped.discountAmount, 17.13);
});
test('malformed canonical cents remain unknown and cannot fall back to rounded legacy money', async () => {
  for (const malformed of [false, '', ' ', -1, 1.5, '1.5', '1e2', {}, [], Number.MAX_SAFE_INTEGER + 1, '9007199254740992']) {
    const row = { ...saved, total_amount_cents: malformed, down_payment_amount_cents: malformed, discount_amount_cents: malformed };
    const mapped = mapOwnedReservation(row);
    assert.equal(mapped.totalAmount, null); assert.equal(mapped.downPaymentAmount, null); assert.equal(mapped.discountAmount, null);
    assert.equal(bookingPaymentSummary(mapped).balanceDisplay, 'Unconfirmed');
    const store = storage(); await assert.rejects(submitTrustedBooking(client(async () => ({ data: { reservation: row } })), 'create', input, store));
    assert.ok(readPendingBooking(store, user.id));
  }
});
test('nullable legacy canonical cents fall back only to verified legacy amounts and keep unknown nulls', () => {
  assert.equal(mapOwnedReservation({ ...saved, total_amount_cents: null }).totalAmount, 300);
  assert.equal(mapOwnedReservation({ ...saved, total_amount_cents: null, totalAmount: null }).totalAmount, null);
  assert.equal(mapOwnedReservation({ ...saved, total_amount_cents: 0 }).totalAmount, 0);
});
test('create acknowledgement compares exact canonical cents rather than rounded legacy REAL values', async () => {
  const row = { ...saved, totalAmount: 2400000, downPaymentAmount: 600000, total_amount_cents: 239999976, down_payment_amount_cents: 60000000, discount_amount_cents: 0 };
  const quote = { ...input, expectedTotalCents: 239999976, expectedDownPaymentCents: 60000000 };
  const mapped = await submitTrustedBooking(client(async () => ({ data: { reservation: row } })), 'create', quote, storage());
  assert.equal(mapped.totalAmount, 2399999.76);
  const store = storage(); await assert.rejects(submitTrustedBooking(client(async () => ({ data: { reservation: { ...row, total_amount_cents: 239999977 } } })), 'create', quote, store), /saved price/);
  assert.ok(readPendingBooking(store, user.id));
});

test('new RPC acknowledgements require all canonical amounts, with history fallback excluded', async () => {
  for (const column of ['total_amount_cents', 'down_payment_amount_cents', 'discount_amount_cents']) {
    for (const absent of [null, undefined]) {
      const store = storage(); const row = { ...saved, [column]: absent };
      await assert.rejects(submitTrustedBooking(client(async () => ({ data: { reservation: row } })), 'create', input, store), /acknowledgement/);
      assert.ok(readPendingBooking(store, user.id));
    }
  }
});


test('missing, foreign or unexpected receipt acknowledgement retains booking request for retry', async () => {
  const receiptPath = `${user.id}/33333333-3333-4333-8333-333333333333.png`;
  for (const [expected, actual] of [[receiptPath, undefined], [receiptPath, null], [undefined, false], [undefined, 0], [undefined, ''], [receiptPath, receiptPath.replace('33333333', '44444444')], [undefined, receiptPath]]) {
    const store = storage();
    await assert.rejects(submitTrustedBooking(client(async () => ({ data: { reservation: { ...saved, receiptImg: actual } } })), 'create', { ...input, receiptPath: expected }, store), /saved receipt/);
    assert.equal(readPendingBooking(store, user.id).input.receiptPath, expected);
  }
});


test('booking cannot dispatch public, malformed or another owner receipt references', async () => {
  for (const receiptPath of ['https://example.test/public.png', '', false, '../file.png', '22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333.png']) {
    const store = storage();
    await assert.rejects(submitTrustedBooking(client(() => assert.fail('Invalid receipt dispatched')), 'create', { ...input, receiptPath }, store));
    assert.equal(store.length, 0);
  }
});


test('late duplicate booking ACK, rejection or owner invalidation cannot clear a newer retry', async () => {
 for(const outcome of ['success','definitive','authchange','lost']) {
  const store=storage(), waits=[];let current=true;
  const api=client(()=>new Promise((resolve,reject)=>waits.push({resolve,reject})));
  const first=submitTrustedBooking(api,'create',input,store,{randomUUID:()=> 'old-request',isCurrentOwner:()=>current});
  await new Promise(done=>setTimeout(done,0));
  const duplicate=submitTrustedBooking(api,'create',input,store,{retry:true,isCurrentOwner:()=>current});
  await new Promise(done=>setTimeout(done,0));
  waits[0].resolve({data:{reservation:saved}});await first;
  const newRecord={ownerId:user.id,requestId:'new-request',kind:'create',input:{...input,timeSlot:'16:00'}};
  store.setItem(`oneshot_pending_booking_v1:${user.id}`,JSON.stringify(newRecord));
  if(outcome==='authchange')current=false;
  if(outcome==='lost') { current=false; waits[1].reject(Error('Lost ACK')); }
  else waits[1].resolve(outcome==='definitive'?{error:{code:'P0001',message:'REJECTED'}}:{data:{reservation:saved}});
  await assert.rejects(duplicate);
  assert.deepEqual(readPendingBooking(store,user.id),newRecord);
 }
});


test('only an exact confirmed booking retires the durable receipt retry record', async () => {
 const receiptPath=`${user.id}/33333333-3333-4333-8333-333333333333.png`;
 for(const outcome of ['confirmed','wrong-receipt','unknown']) {
  const store=storage();
  const api=client(async (name,{payload})=>{
   if(name==='oneshot_receipt_upload_intent')return {data:{bucket:'oneshot-receipts',path:receiptPath,declaredSize:payload.byteSize,declaredMime:payload.contentType,sha256:payload.sha256,expiresAt:new Date(Date.now()+900000).toISOString(),uploadAllowed:true,replayed:false}};
   if(outcome==='unknown')throw Error('Lost booking ACK');
   return {data:{reservation:{...saved,receiptImg:outcome==='confirmed'?receiptPath:null}}};
  });
  api.storage={from:()=>({upload:async path=>({data:{path}})})};
  const receipt=await uploadPrivateBookingReceipt(api,new Blob([Uint8Array.from([137,80,78,71,13,10,26,10,0])],{type:'image/png'}),{storage:store});
  const recordKey=`oneshot_pending_receipt_v1:${user.id}`;assert.ok(store.getItem(recordKey));
  const operation=submitTrustedBooking(api,'create',{...input,receiptPath:receipt.path},store);
  if(outcome==='confirmed') { await operation;assert.equal(store.getItem(recordKey),null); }
  else { await assert.rejects(operation);assert.ok(store.getItem(recordKey));assert.ok(readPendingBooking(store,user.id)); }
 }
});
