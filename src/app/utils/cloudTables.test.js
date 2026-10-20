import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapCloudTable } from './cloudTables.js';

test('cloud and native casing preserve active occupied sessions consistently', () => {
  const session = { customerName: 'QA', startTime: '2026-10-18T06:00:00Z', durationMinutes: 120, orders: [{ qty: 1 }] };
  for (const keys of [['isactive', 'sessiondata'], ['is_active', 'session_data'], ['isActive', 'sessionData']]) {
    const table = mapCloudTable({ id: 'QA', status: 'occupied', [keys[0]]: 1, [keys[1]]: JSON.stringify(session) });
    assert.equal(table.isActive, true);
    assert.equal(table.status, 'occupied');
    assert.deepEqual(table.session, session);
  }
});

test('inactive flags and missing activity never become bookable', () => {
  for (const active of [false, 0, 'false', '0', undefined, null]) {
    assert.equal(mapCloudTable({ isActive: active }).isActive, false);
  }
});

test('one malformed session does not discard the snapshot or free an occupied table', () => {
  const tables = [{ id: 'bad', isactive: 1, status: 'occupied', sessiondata: '{broken' }, { id: 'good', isactive: 1, status: 'available' }].map(mapCloudTable);
  assert.equal(tables.length, 2);
  assert.equal(tables[0].status, 'maintenance');
  assert.equal(tables[1].status, 'available');
  for (const sessionData of ['[]', '42', 'true']) {
    assert.equal(mapCloudTable({ status: 'available', sessionData }).status, 'maintenance');
  }
});

test('occupied tables with absent or incomplete session timing stay unavailable', () => {
  for (const sessionData of [null, undefined, {}, { startTime: 'invalid', durationMinutes: 60 }, { startTime: '2026-10-18', durationMinutes: null }]) {
    assert.equal(mapCloudTable({ status: 'occupied', isActive: true, sessionData }).status, 'maintenance');
  }
});
