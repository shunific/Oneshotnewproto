const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createEmailService, detectReservationActions, buildEmail } = require(path.resolve(__dirname, '../server-email.cjs'));

// A tiny in-memory sqlite stand-in for the two tables the email service touches.
function makeDb({ settings = {}, sent = [] } = {}) {
  const log = [];
  const store = { systemSettings: { ...settings } };
  const all = (sql, values, cb) => {
    if (typeof values === 'function') { cb = values; values = []; }
    if (/FROM systemSettings/i.test(sql)) {
      return cb(null, Object.entries(store.systemSettings).map(([keyName, settingValue]) => ({ keyName, settingValue })));
    }
    return cb(null, []);
  };
  const get = (sql, values, cb) => {
    if (/email_notifications/i.test(sql)) {
      const [reservationId, action, signature] = values;
      const hit = sent.find(r => r.reservationId === reservationId && r.action === action && r.signature === (signature || ''));
      return cb(null, hit ? { id: 1 } : null);
    }
    return cb(null, null);
  };
  const run = (sql, values, cb) => {
    if (/INSERT INTO email_notifications/i.test(sql)) {
      const [reservationId, action, recipient, status, detail] = values;
      log.push({ reservationId, action, recipient, status, detail });
      if (status === 'sent') sent.push({ reservationId, action, signature: detail || '' });
    }
    return cb ? cb.call({ changes: 1 }, null) : undefined;
  };
  return { db: { all, get, run }, log };
}

const baseReservation = {
  id: 'ABC123', customerName: 'Jane Doe', email: 'jane@example.com',
  date: '2026-12-01T00:00:00.000Z', timeSlot: '19:00', durationHours: 2,
  partySize: 4, status: 'pending', totalAmount: 500, downPaymentAmount: 100,
  downPaymentPaid: 0, balancePaid: 0,
};

test('detectReservationActions maps each lifecycle change to the right email', () => {
  assert.deepEqual(detectReservationActions(null, { status: 'pending' }).map(e => e.action), ['created']);
  assert.deepEqual(detectReservationActions({ status: 'pending' }, { status: 'confirmed' }).map(e => e.action), ['confirmed']);
  assert.deepEqual(detectReservationActions({ status: 'confirmed' }, { status: 'checked-in' }).map(e => e.action), ['checked-in']);
  assert.deepEqual(detectReservationActions({ status: 'checked-in' }, { status: 'completed' }).map(e => e.action), ['completed']);
  assert.deepEqual(detectReservationActions({ status: 'pending' }, { status: 'cancelled', cancellationReason: 'Changed plans' }).map(e => e.action), ['cancelled']);
  assert.deepEqual(detectReservationActions({ status: 'pending' }, { status: 'pending-refund' }).map(e => e.action), ['refund-pending']);
  assert.deepEqual(detectReservationActions({ status: 'pending-refund' }, { status: 'cancelled' }).map(e => e.action), ['refund-settled']);
});

test('a customer reschedule that staff confirms emails a rescheduled notice with the new slot', () => {
  const marker = '__RESCHEDULE_REQUEST__' + JSON.stringify({ requestedDate: '2026-12-05T00:00:00.000Z', requestedTime: '20:00', reason: 'Work' });
  const events = detectReservationActions(
    { status: 'pending-reschedule', cancellationReason: marker },
    { status: 'confirmed', date: '2026-12-05T00:00:00.000Z', timeSlot: '20:00' });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'rescheduled');
  assert.equal(events[0].extras.newTimeSlot, '20:00');
});

test('a declined reschedule request emails a reschedule-declined notice, not a confirmation', () => {
  const marker = '__RESCHEDULE_REQUEST__' + JSON.stringify({ decision: 'rejected', reason: 'Fully booked', requestedDate: '2026-12-05', requestedTime: '20:00' });
  const events = detectReservationActions({ status: 'pending-reschedule' }, { status: 'confirmed', cancellationReason: marker });
  assert.deepEqual(events.map(e => e.action), ['reschedule-declined']);
  assert.equal(events[0].extras.reason, 'Fully booked');
});

test('payment flags only email once, on the transition to paid', () => {
  assert.deepEqual(detectReservationActions({ downPaymentPaid: 0 }, { downPaymentPaid: 1 }).map(e => e.action), ['payment-received']);
  assert.deepEqual(detectReservationActions({ downPaymentPaid: 1 }, { downPaymentPaid: 1 }).map(e => e.action), []);
});

test('buildEmail renders the action, booking reference and venue footer', () => {
  const { subject, html, text } = buildEmail({
    action: 'cancelled',
    reservation: baseReservation,
    venue: { name: 'One Shot Bar', phone: '09171234567', address: 'Manila' },
    extras: { reason: 'Customer changed plans' },
  });
  assert.match(subject, /ABC123/);
  assert.match(html, /One Shot Bar/);
  assert.match(html, /09171234567/);
  assert.match(html, /Customer changed plans/);
  assert.match(text, /Booking reference: ABC123/);
});

test('a configured transport sends the email and records it as sent', async () => {
  const { db, log } = makeDb({ settings: { resendApiKey: 're_test', emailFromAddress: 'no-reply@oneshot.test' } });
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, text: async () => '' }; };
  try {
    const service = createEmailService(db, { logger: { log() {}, error() {} } });
    const result = await service.notifyReservationAction({ action: 'confirmed', reservation: baseReservation });
    assert.equal(result.sent, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.deepEqual(calls[0].body.to, ['jane@example.com']);
    assert.equal(log.filter(r => r.status === 'sent').length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('without a transport the email is skipped, not failed, and never throws', async () => {
  const { db, log } = makeDb({ settings: {} });
  const service = createEmailService(db, { logger: { log() {}, error() {} } });
  const result = await service.notifyReservationAction({ action: 'confirmed', reservation: baseReservation });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'not-configured');
  assert.equal(log.filter(r => r.status === 'skipped').length, 1);
});

test('a reservation without an email address is never sent', async () => {
  const { db } = makeDb({ settings: { resendApiKey: 're_test' } });
  const service = createEmailService(db, { logger: { log() {}, error() {} } });
  const result = await service.notifyReservationAction({ action: 'confirmed', reservation: { ...baseReservation, email: '' } });
  assert.deepEqual(result, { sent: false, reason: 'no-recipient' });
});

test('identical retries are de-duplicated, but a new schedule still sends', async () => {
  const sent = [];
  const { db } = makeDb({ settings: { resendApiKey: 're_test' }, sent });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
  try {
    const service = createEmailService(db, { logger: { log() {}, error() {} } });
    const first = await service.notifyReservationChange({
      prev: { status: 'confirmed', date: baseReservation.date, timeSlot: '19:00' },
      updates: { status: 'confirmed', date: '2026-12-03T00:00:00.000Z', timeSlot: '21:00' },
      reservation: { ...baseReservation, date: '2026-12-03T00:00:00.000Z', timeSlot: '21:00' },
    });
    assert.deepEqual(first.map(r => r.sent), [true]);
    // Same reschedule replayed -> duplicate, no second send.
    const replay = await service.notifyReservationChange({
      prev: { status: 'confirmed', date: baseReservation.date, timeSlot: '19:00' },
      updates: { status: 'confirmed', date: '2026-12-03T00:00:00.000Z', timeSlot: '21:00' },
      reservation: { ...baseReservation, date: '2026-12-03T00:00:00.000Z', timeSlot: '21:00' },
    });
    assert.deepEqual(replay.map(r => r.reason), ['duplicate']);
    // A different schedule is a genuinely new event.
    const moved = await service.notifyReservationChange({
      prev: { status: 'confirmed', date: '2026-12-03T00:00:00.000Z', timeSlot: '21:00' },
      updates: { status: 'confirmed', date: '2026-12-09T00:00:00.000Z', timeSlot: '18:00' },
      reservation: { ...baseReservation, date: '2026-12-09T00:00:00.000Z', timeSlot: '18:00' },
    });
    assert.deepEqual(moved.map(r => r.sent), [true]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a delivery failure is recorded and swallowed so the reservation change still stands', async () => {
  const { db, log } = makeDb({ settings: { resendApiKey: 're_test' } });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 422, text: async () => 'bad domain' });
  try {
    const service = createEmailService(db, { logger: { log() {}, error() {} } });
    const result = await service.notifyReservationAction({ action: 'confirmed', reservation: baseReservation });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'delivery-failed');
    assert.equal(log.filter(r => r.status === 'failed').length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
