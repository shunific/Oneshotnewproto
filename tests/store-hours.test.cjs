const test = require('node:test');
const assert = require('node:assert/strict');

// Manila (UTC+8) wall-clock time as an epoch millisecond value.
const at = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0);

test('after-midnight play still belongs to the previous operating day', async () => {
  const { getStoreWindowInfo } = await import('../src/app/utils/storeHours.js');
  // Thursday closes 5 AM. Friday 2:10 AM is still Thursday's shift.
  const rates = { weekdayStartTime: '12:00', weekdayEndTime: '05:00', weekendStartTime: '12:00', weekendEndTime: '02:00' };
  const info = getStoreWindowInfo(rates, at(2026, 11, 6, 2, 10));
  assert.equal(info.configured, true);
  assert.equal(info.isOpen, true);
  assert.ok(info.remaining > 160 && info.remaining <= 170, `remaining was ${info.remaining}`);
});

test('weekend schedule follows Fri-Sun and ends at its own closing time', async () => {
  const { getStoreWindowInfo } = await import('../src/app/utils/storeHours.js');
  const rates = { weekdayStartTime: '12:00', weekdayEndTime: '05:00', weekendStartTime: '12:00', weekendEndTime: '02:00' };
  // Saturday 3 AM started on Friday's weekend window, which closed at 2 AM.
  const closed = getStoreWindowInfo(rates, at(2026, 11, 7, 3, 0));
  assert.equal(closed.configured, true);
  assert.equal(closed.isOpen, false);
  // Sunday 10 PM uses the weekend schedule (Sunday is part of Fri-Sun).
  const open = getStoreWindowInfo(rates, at(2026, 11, 8, 22, 0));
  assert.equal(open.configured, true);
  assert.equal(open.isOpen, true);
});

test('non-overnight schedule opens and closes on the same calendar day', async () => {
  const { getStoreWindowInfo } = await import('../src/app/utils/storeHours.js');
  const rates = { weekdayStartTime: '09:00', weekdayEndTime: '23:00', weekendStartTime: '09:00', weekendEndTime: '23:00' };
  assert.equal(getStoreWindowInfo(rates, at(2026, 11, 2, 8, 0)).isOpen, false); // Monday 8 AM
  assert.equal(getStoreWindowInfo(rates, at(2026, 11, 2, 10, 0)).isOpen, true); // Monday 10 AM
  assert.equal(getStoreWindowInfo(rates, at(2026, 11, 2, 23, 0)).isOpen, false); // Monday 11 PM
});

test('invalid or incomplete hours do not produce a false closed state', async () => {
  const { getStoreWindowInfo } = await import('../src/app/utils/storeHours.js');
  assert.equal(getStoreWindowInfo({}, at(2026, 11, 6, 2, 10)).isOpen, true);
  assert.equal(getStoreWindowInfo({ weekdayStartTime: '09:00' }, at(2026, 11, 6, 2, 10)).isOpen, true);
  assert.equal(getStoreWindowInfo({ weekdayStartTime: '09:00', weekdayEndTime: '09:00', weekendStartTime: '09:00', weekendEndTime: '23:00' }, at(2026, 11, 6, 2, 10)).isOpen, true);
});
