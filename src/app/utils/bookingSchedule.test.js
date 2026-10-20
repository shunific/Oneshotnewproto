import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutesUntilClose, validateBookingSlot, isDateFullyClosed, reservationsForDate, withoutBookingInterval } from './bookingSchedule.js';

const rates = { bookingCapacityMode: 'tables', weekdayOnlineCapacityLimit: 6, weekendOnlineCapacityLimit: 6, weekdayStartTime: '12:00', weekdayEndTime: '01:00', weekendStartTime: '14:00', weekendEndTime: '00:00' };
const base = { date: new Date(2026, 9, 26), time: '14:00', duration: 2, tableId: 'qa-table', rates, now: new Date(2026, 9, 18, 12), reservations: [], tables: [{ id: 'qa-table', isActive: true, status: 'available' }] };
const validate = changes => validateBookingSlot({ ...base, ...changes });

test('weekday and Friday use their separately configured opening times', () => {
  assert.equal(validate({ time: '12:00' }), 'valid');
  assert.equal(validate({ date: new Date(2026, 9, 23), time: '12:00' }), 'closed');
  assert.equal(validate({ date: new Date(2026, 9, 23), time: '14:00' }), 'valid');
});

test('closing-time boundary permits ending exactly at close and rejects overruns', () => {
  assert.equal(validate({ time: '23:00', duration: 2 }), 'valid');
  assert.equal(validate({ time: '23:00', duration: 3 }), 'closed');
  assert.equal(validate({ date: new Date(2026, 9, 23), time: '23:00', duration: 1 }), 'valid');
  assert.equal(validate({ date: new Date(2026, 9, 23), time: '23:00', duration: 2 }), 'closed');
});

test('calendar-day early morning follows the previous operating window', () => {
  assert.equal(validate({ date: new Date(2026, 9, 27), time: '00:00', duration: 1 }), 'valid');
  assert.equal(validate({ date: new Date(2026, 9, 27), time: '01:00', duration: 1 }), 'closed');
  assert.equal(validate({ time: '09:00', duration: 1 }), 'closed');
});

test('specific and weekly full-day closures reject the slot', () => {
  assert.equal(validate({ closedDates: [{ date: '2026-10-26', isFullDay: true }] }), 'closed');
  assert.equal(validate({ closedDates: [{ type: 'weekly', dayOfWeek: 1, isFullDay: true }] }), 'closed');
  assert.equal(validate({ closedDates: [{ date: '2026-10-26', isFullDay: true, status: 'cancelled' }] }), 'valid');
});

test('partial closure allows its open period but rejects start/end outside it', () => {
  const closedDates = [{ closed_date: '2026-10-26', is_full_day: false, open_time: '15:00', close_time: '19:00' }];
  assert.equal(validate({ closedDates }), 'closed');
  assert.equal(validate({ closedDates, time: '15:00' }), 'valid');
  assert.equal(validate({ closedDates, time: '18:00' }), 'closed');
  assert.equal(isDateFullyClosed(base.date, closedDates), false);
});

test('a closure on the next calendar day cuts off an overnight booking', () => {
  const closedDates = [{ date: '2026-10-27', isFullDay: true }];
  assert.equal(validate({ closedDates, time: '23:00', duration: 1 }), 'valid');
  assert.equal(validate({ closedDates, time: '23:00', duration: 2 }), 'closed');
});

test('advance notice spans midnight and uses configured hours', () => {
  assert.equal(validate({ date: new Date(2026, 9, 27), time: '00:00', duration: 1, now: new Date(2026, 9, 26, 23, 30) }), 'advance');
  assert.equal(validate({ terms: { advanceBookingHours: 3 }, now: new Date(2026, 9, 26, 12) }), 'advance');
  assert.equal(validate({ terms: { advanceBookingHours: 2 }, now: new Date(2026, 9, 26, 12) }), 'valid');
  assert.equal(validate({ date: new Date(2026, 9, 17) }), 'past');
});

test('rescheduling excludes itself but still rejects another overlapping booking', () => {
  const booking = { id: 'QA1234', tableId: base.tableId, date: '2026-10-26', timeSlot: '14:00', durationHours: 2, status: 'pending' };
  assert.equal(validate({ reservations: [booking] }), 'table_conflict');
  assert.equal(validate({ reservations: [booking], excludeReservationId: booking.id }), 'valid');
  assert.equal(validate({ reservations: [booking, { ...booking, id: 'OTHER' }], excludeReservationId: booking.id }), 'table_conflict');
  assert.equal(validate({ reservations: [booking], time: '16:00' }), 'valid');
});

test('overlaps across midnight are checked even when reservation dates differ', () => {
  const reservations = [{ id: 'OTHER', tableId: base.tableId, date: '2026-10-26', timeSlot: '23:00', durationHours: 2, status: 'confirmed' }];
  assert.equal(validate({ date: new Date(2026, 9, 27), time: '00:00', duration: 1, reservations }), 'table_conflict');
});

test('cancelled and refund-pending bookings do not reserve a table', () => {
  for (const status of ['cancelled', 'completed', 'pending-refund']) {
    assert.equal(validate({ reservations: [{ id: 'OTHER', tableId: base.tableId, date: '2026-10-26', timeSlot: base.time, durationHours: 2, status }] }), 'valid');
  }
});

test('maintenance and inactive tables cannot be booked', () => {
  assert.equal(validate({ tables: [{ id: base.tableId, isActive: false }] }), 'no_table');
  assert.equal(validate({ tables: [{ id: base.tableId, status: 'maintenance' }] }), 'no_table');
});

test('an occupied session blocks its actual interval', () => {
  const tables = [{ id: base.tableId, status: 'occupied', session: { startTime: new Date(2026, 9, 26, 13), durationMinutes: 120 } }];
  assert.equal(validate({ tables }), 'active_conflict');
  assert.equal(validate({ tables, time: '15:00' }), 'valid');
});

test('invalid times and durations cannot bypass availability validation', () => {
  for (const time of ['', '99:00', '12:90', '12:x']) assert.equal(validate({ time }), 'invalid');
  for (const duration of [0, -1, NaN, Infinity]) assert.equal(validate({ duration }), 'invalid');
  assert.equal(validate({ duration: 3, terms: { maxHours: 2 } }), 'invalid');
});

test('duration choices stop at the real closing time', () => {
  assert.equal(minutesUntilClose(base.date, '23:30', rates), 90);
  assert.equal(minutesUntilClose(base.date, '09:00', rates), 0);
});

test('displayed table schedule agrees with midnight conflicts and released bookings', () => {
  const overnight = { id: 'NIGHT', tableId: base.tableId, date: '2026-10-26', timeSlot: '23:00', durationHours: 2, status: 'confirmed' };
  const refunded = { ...overnight, id: 'REFUND', status: 'pending-refund' };
  assert.deepEqual(reservationsForDate([overnight, refunded], base.tableId, new Date(2026, 9, 27)), [overnight]);
  assert.deepEqual(reservationsForDate([overnight], 'different-table', base.date), []);
});

test('missing or removed table cannot pass booking validation', () => {
  assert.equal(validate({ tables: [] }), 'no_table');
  assert.equal(validate({ tableId: 'removed-table' }), 'no_table');
});

test('unknown occupied-session end cannot be assumed free for future booking', () => {
  for (const session of [undefined, {}, { startTime: 'invalid', durationMinutes: 60 }, { startTime: '2026-10-18', durationMinutes: null }]) {
    assert.equal(validate({ tables: [{ id: base.tableId, isActive: true, status: 'occupied', session }] }), 'active_conflict');
  }
});

const busy = (id, tableId, timeSlot, durationHours, date = '2026-10-26', status = 'confirmed') => ({ id, tableId, timeSlot, durationHours, date, status });
test('capacity counts peak simultaneous bookings instead of all overlapping rows', () => {
  const reservations = [busy('one', 'other', '14:00', 2), busy('two', 'other', '16:00', 2)];
  const limited = { ...rates, weekdayOnlineCapacityLimit: 2 };
  assert.equal(validate({ rates: limited, duration: 4, reservations }), 'valid');
  assert.equal(validate({ rates: limited, duration: 4, reservations: [...reservations, busy('three', 'third', '15:00', 1)] }), 'full');
  assert.equal(validate({ rates: { ...limited, weekdayOnlineCapacityLimit: 1 }, reservations }), 'full');
  assert.equal(validate({ rates: { ...limited, weekdayOnlineCapacityLimit: 0 } }), 'full');
});
test('capacity uses half-open midnight intervals and releases cancelled bookings', () => {
  const reservations = [busy('one', 'other', '23:00', 1), busy('two', 'other', '00:00', 1, '2026-10-27'), busy('cancelled', 'third', '23:00', 2, '2026-10-26', 'cancelled')];
  assert.equal(validate({ rates: { ...rates, weekdayOnlineCapacityLimit: 2 }, time: '23:00', duration: 2, reservations }), 'valid');
  assert.equal(validate({ rates: { ...rates, weekdayOnlineCapacityLimit: 1 }, time: '23:00', duration: 2, reservations }), 'full');
});
test('malformed active intervals and unreviewed capacity cannot be treated as available', () => {
  assert.equal(validate({ rates: { ...rates, bookingCapacityMode: undefined } }), 'invalid');
  assert.equal(validate({ rates: { ...rates, weekdayOnlineCapacityLimit: 1.5 } }), 'invalid');
  assert.equal(validate({ reservations: [busy('bad', 'other', 'bad', 2)] }), 'invalid');
  assert.equal(validate({ duration: 1.5 }), 'invalid');
});
test('reschedule removes exactly its own anonymized interval and retains all other conflicts', () => {
  const own = busy('real-private-id', base.tableId, '14:00', 2);
  const rows = [busy('busy-0', base.tableId, '14:00', 2), busy('busy-1', 'other', '14:00', 2)];
  const filtered = withoutBookingInterval(rows, own);
  assert.deepEqual(filtered, [rows[1]]);
  assert.equal(validate({ reservations: filtered, rates: { ...rates, weekdayOnlineCapacityLimit: 2 } }), 'valid');
  assert.equal(validate({ reservations: filtered, rates: { ...rates, weekdayOnlineCapacityLimit: 1 } }), 'full');
  assert.equal(withoutBookingInterval(rows, undefined), rows);
  assert.equal(withoutBookingInterval(rows, { ...own, timeSlot: '20:00' }), rows);
  const duplicate = [...rows, { ...rows[0], id: 'busy-2' }];
  assert.equal(withoutBookingInterval(duplicate, own).length, 2);
  assert.equal(validate({ reservations: withoutBookingInterval(duplicate, own) }), 'table_conflict');
});
