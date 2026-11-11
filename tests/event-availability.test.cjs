const test = require('node:test'), assert = require('node:assert/strict');
const load = () => import('../src/app/utils/eventAvailability.js');

const timed = { id: 'e1', title: 'Tournament', date: '2026-10-22', duration: '15:00 - 17:00', eventTableIds: ['a'] };
const wholeDay = { id: 'e2', title: 'Holiday', date: '2026-10-22', duration: 'Whole Day', eventTableIds: ['a'] };
const day = new Date(2026, 9, 22);

test('a timed event only blocks its table inside the event window', async () => {
  const { isSlotBlockedByEvent, isTableBlockedAllDay } = await load();
  assert.equal(isTableBlockedAllDay([timed], 'a', day), false);
  assert.equal(isSlotBlockedByEvent([timed], 'a', day, 14 * 60, 15 * 60), false, 'slot ending as event starts');
  assert.equal(isSlotBlockedByEvent([timed], 'a', day, 14 * 60, 15 * 60 + 1), true, 'slot overlapping event start');
  assert.equal(isSlotBlockedByEvent([timed], 'a', day, 16 * 60, 18 * 60), true, 'slot inside event window');
  assert.equal(isSlotBlockedByEvent([timed], 'a', day, 17 * 60, 19 * 60), false, 'slot starting as event ends');
  assert.equal(isSlotBlockedByEvent([timed], 'a', day, 9 * 60, 11 * 60), false, 'slot before the event');
});

test('only allocated tables are blocked, other tables stay free', async () => {
  const { isSlotBlockedByEvent, isTableBlockedAllDay } = await load();
  assert.equal(isTableBlockedAllDay([timed], 'b', day), false);
  assert.equal(isSlotBlockedByEvent([timed], 'b', day, 16 * 60, 18 * 60), false);
});

test('a whole-day event blocks the allocated table for the entire day', async () => {
  const { isTableBlockedAllDay, isSlotBlockedByEvent } = await load();
  assert.equal(isTableBlockedAllDay([wholeDay], 'a', day), true);
  assert.equal(isSlotBlockedByEvent([wholeDay], 'a', day, 9 * 60, 10 * 60), true);
  assert.equal(isSlotBlockedByEvent([wholeDay], 'a', day, 22 * 60, 23 * 60), true);
});

test('events on other dates and cancelled events never block', async () => {
  const { isSlotBlockedByEvent, isTableBlockedAllDay } = await load();
  const other = { ...timed, date: '2026-10-23' };
  const cancelled = { ...wholeDay, isCancelled: true };
  assert.equal(isTableBlockedAllDay([other, cancelled], 'a', day), false);
  assert.equal(isSlotBlockedByEvent([other], 'a', day, 16 * 60, 18 * 60), false);
});

test('a multi-date event only blocks its listed dates', async () => {
  const { isTableBlockedAllDay } = await load();
  const multi = { ...wholeDay, date: '2026-10-21,2026-10-22' };
  assert.equal(isTableBlockedAllDay([multi], 'a', day), true);
  assert.equal(isTableBlockedAllDay([multi], 'a', new Date(2026, 9, 20)), false);
});

test('an event that disables reservations blocks the whole venue for the day', async () => {
  const { isTableBlockedAllDay } = await load();
  const venueWide = { id: 'e3', title: 'Private', date: '2026-10-22', duration: 'Whole Day', allowReservations: false };
  assert.equal(isTableBlockedAllDay([venueWide], 'any-table', day), true);
});

test('overnight event windows block the early hours of the next day', async () => {
  const { isSlotBlockedByEvent, isTableBlockedAllDay } = await load();
  const overnight = { id: 'e4', title: 'Late Night', date: '2026-10-22', duration: '22:00 - 01:00', eventTableIds: ['a'] };
  assert.equal(isTableBlockedAllDay([overnight], 'a', day), false);
  assert.equal(isSlotBlockedByEvent([overnight], 'a', day, 23 * 60, 24 * 60), true, 'before midnight');
  const nextDay = new Date(2026, 9, 23);
  assert.equal(isSlotBlockedByEvent([overnight], 'a', nextDay, 0, 30), true, 'after midnight');
  assert.equal(isSlotBlockedByEvent([overnight], 'a', nextDay, 2 * 60, 3 * 60), false, 'after the window');
});

test('eventForTable prefers a whole-day event and reports the window', async () => {
  const { eventForTable, formatEventWindow } = await load();
  const both = [timed, wholeDay];
  assert.equal(eventForTable(both, 'a', day).id, 'e2');
  assert.equal(eventForTable([timed], 'a', day).id, 'e1');
  assert.equal(eventForTable([timed], 'b', day), null);
  assert.equal(formatEventWindow(timed), '3:00 PM - 5:00 PM');
  assert.equal(formatEventWindow(wholeDay), 'Whole Day');
});

test('malformed durations are ignored instead of blocking', async () => {
  const { isTableBlockedAllDay, isSlotBlockedByEvent, eventWindow } = await load();
  const broken = { id: 'e5', date: '2026-10-22', duration: 'garbage', eventTableIds: ['a'] };
  assert.equal(eventWindow(broken), null);
  assert.equal(isTableBlockedAllDay([broken], 'a', day), false);
  assert.equal(isSlotBlockedByEvent([broken], 'a', day, 10 * 60, 12 * 60), false);
});
