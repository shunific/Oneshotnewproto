import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSystemSettings, hasBookingSettings, calculateDownPayment } from './systemSettings.js';

test('lowercase cloud keys, snake case and native camel case produce the same settings', () => {
  for (const [keyField, valueField, key] of [['keyname', 'settingvalue', 'hourlyrate'], ['key_name', 'setting_value', 'hourly_rate'], ['keyName', 'settingValue', 'hourlyRate']]) {
    assert.deepEqual(parseSystemSettings([{ [keyField]: key, [valueField]: '175.50' }]), { hourlyRate: 175.5 });
  }
});

test('zero and one numeric settings retain their numeric meaning', () => {
  assert.deepEqual(parseSystemSettings([
    { keyname: 'downpaymentpercent', settingvalue: '0' },
    { keyname: 'hourlyrate', settingvalue: '1' },
    { keyname: 'minhours', settingvalue: 1 },
    { keyname: 'advancebookinghours', settingvalue: 0 },
  ]), { downPaymentPercent: 0, hourlyRate: 1, minHours: 1, advanceBookingHours: 0 });
});

test('false happy-hour flags do not become truthy strings', () => {
  for (const value of ['false', '0', 0, false]) {
    assert.deepEqual(parseSystemSettings([{ key_name: 'is_weekday_happy_hour_active', setting_value: value }]), { isWeekdayHappyHourActive: false });
  }
});

test('invalid settings cannot overwrite a usable configuration', () => {
  assert.deepEqual(parseSystemSettings([
    { keyname: 'hourlyrate', settingvalue: 'NaN' },
    { keyname: 'hourlyrate', settingvalue: true },
    { keyname: 'downpaymentpercent', settingvalue: '101' },
    { keyname: 'weekdaystarttime', settingvalue: '25:00' },
    { keyname: 'weekdayendtime', settingvalue: '12:90' },
    { keyname: '__proto__', settingvalue: 'bad' },
    { keyname: 'maxhours', settingvalue: '' },
  ]), {});
  assert.equal(hasBookingSettings({}), false);
});

test('booking readiness requires configured prices, operating windows, table capacities and party ranges', () => {
  const settings = { hourlyRate: 175, downPaymentPercent: 0, weekdayStartTime: '12:00', weekdayEndTime: '01:00', weekendStartTime: '14:00', weekendEndTime: '00:00', bookingCapacityMode: 'tables', weekdayOnlineCapacityLimit: 0, weekendOnlineCapacityLimit: 150, weekdayMinPartySize: 1, weekdayMaxPartySize: 10, weekendMinPartySize: 2, weekendMaxPartySize: 20 };
  assert.equal(hasBookingSettings(settings), true);
  for (const key of Object.keys(settings)) {
    const incomplete = { ...settings }; delete incomplete[key];
    assert.equal(hasBookingSettings(incomplete), false);
  }
});

test('zero-percent deposits stay zero, while positive deposits retain whole-peso rounding', () => {
  assert.equal(calculateDownPayment(350, 0), 0);
  assert.equal(calculateDownPayment(350, 20), 70);
  assert.equal(calculateDownPayment(351, 20), 71);
  for (const percent of [-1, 101, NaN]) assert.throws(() => calculateDownPayment(350, percent));
});

test('down payments never exceed a sub-peso booking total', () => {
  assert.equal(calculateDownPayment(0.01, 20), 0.01);
  assert.equal(calculateDownPayment(0.99, 20), 0.99);
  assert.equal(calculateDownPayment(0.01, 0), 0);
  assert.equal(calculateDownPayment(300, 20), 60);
});

test('public table-count capacity mode survives parsing without obsolete percentage caps', () => {
  const rows = [
    { key_name: 'bookingCapacityMode', setting_value: 'tables' },
    { key_name: 'weekdayOnlineCapacityLimit', setting_value: '101.0' },
    { key_name: 'weekendOnlineCapacityLimit', setting_value: '500' },
  ];
  assert.deepEqual(parseSystemSettings(rows), { bookingCapacityMode: 'tables', weekdayOnlineCapacityLimit: 101, weekendOnlineCapacityLimit: 500 });
  for (const raw of ['1.5', -1, false, [], {}, 'NaN', '9007199254740992', '9007199254740991.1', '2.0000000000000001', '1e2', '']) assert.deepEqual(parseSystemSettings([{ key_name: 'weekdayOnlineCapacityLimit', setting_value: raw }]), {});
});
test('malformed modes, fractional counts, missing or reversed party ranges fail readiness', () => {
  const complete = { hourlyRate: 175.01, downPaymentPercent: 20, weekdayStartTime: '12:00', weekdayEndTime: '01:00', weekendStartTime: '14:00', weekendEndTime: '00:00', bookingCapacityMode: 'tables', weekdayOnlineCapacityLimit: 101, weekendOnlineCapacityLimit: 0, weekdayMinPartySize: 1, weekdayMaxPartySize: 10, weekendMinPartySize: 2, weekendMaxPartySize: 20 };
  assert.equal(hasBookingSettings(complete), true);
  for (const changes of [{ bookingCapacityMode: 'percent' }, { bookingCapacityMode: null }, { weekdayOnlineCapacityLimit: 1.5 }, { weekendOnlineCapacityLimit: Number.MAX_SAFE_INTEGER + 1 }, { weekdayMinPartySize: 0 }, { weekdayMaxPartySize: 0 }, { weekendMinPartySize: 21 }, { weekendMaxPartySize: 1.5 }, { hourlyRate: 0.001 }, { hourlyRate: 100001 }, { downPaymentPercent: 101 }, { weekdayStartTime: '25:00' }]) assert.equal(hasBookingSettings({ ...complete, ...changes }), false, JSON.stringify(changes));
});
