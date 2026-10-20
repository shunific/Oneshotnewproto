import { hasTimedSession } from './cloudTables.js';
const MINUTE = 60000;

function minutes(time) {
  if (!/^\d{2}:\d{2}$/.test(time || '')) return NaN;
  const [h, m] = time.split(':').map(Number);
  return h < 24 && m < 60 ? h * 60 + m : NaN;
}

function day(date) {
  if (date instanceof Date) return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const [y, m, d] = String(date || '').slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function at(date, time) {
  return new Date(day(date).getTime() + minutes(time) * MINUTE);
}

function isFullClosure(closure) {
  const full = closure.isFullDay ?? closure.is_full_day;
  return full === true || full === 1 || full === 'true' || full === '1' || full == null;
}

export function closureMatches(closure, date) {
  if (closure.status === 'cancelled' || closure.cancelled_at) return false;
  if (closure.type === 'weekly') return Number(closure.dayOfWeek ?? closure.day_of_week) === date.getDay();
  return day(closure.date ?? closure.closedDate ?? closure.closed_date).getTime() === day(date).getTime();
}

export function isDateFullyClosed(date, closedDates = []) {
  return closedDates.some(c => closureMatches(c, date) && isFullClosure(c));
}

function blocksTable(reservation) {
  return !['cancelled', 'completed', 'pending-refund'].includes(reservation.status);
}

export function reservationInterval(reservation) {
  const start = at(reservation.date, reservation.timeSlot);
  return { start, end: new Date(start.getTime() + Number(reservation.durationHours) * 60 * MINUTE) };
}

export function reservationsForDate(reservations, tableId, date) {
  const start = day(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return reservations.filter(reservation => {
    const other = reservationInterval(reservation);
    return blocksTable(reservation) && reservation.tableId === tableId && other.start < end && other.end > start;
  }).sort((a, b) => reservationInterval(a).start - reservationInterval(b).start);
}

export function operatingHours(date, rates) {
  const weekend = [0, 5, 6].includes(day(date).getDay());
  return {
    start: weekend ? (rates.weekendStartTime ?? '12:00') : (rates.weekdayStartTime ?? '12:00'),
    end: weekend ? (rates.weekendEndTime ?? '00:00') : (rates.weekdayEndTime ?? '01:00'),
  };
}

export function minutesUntilClose(date, time, rates, closedDates = []) {
  const start = at(date, time);
  if (!Number.isFinite(start.getTime())) return 0;
  let close = 0;
  // A calendar-day early-morning slot can belong to the previous day's overnight hours.
  for (const offset of [-1, 0]) {
    const anchor = day(date);
    anchor.setDate(anchor.getDate() + offset);
    const hours = operatingHours(anchor, rates);
    const open = at(anchor, hours.start);
    const end = at(anchor, hours.end);
    if (end <= open) end.setDate(end.getDate() + 1);
    if (start >= open && start < end) close = Math.max(close, end.getTime());
  }
  if (!close) return 0;

  for (const offset of [0, 1]) {
    const current = day(date);
    current.setDate(current.getDate() + offset);
    const next = new Date(current);
    next.setDate(next.getDate() + 1);
    if (start >= next || close <= current.getTime()) continue;
    for (const closure of closedDates.filter(c => closureMatches(c, current))) {
      if (isFullClosure(closure)) {
        close = Math.min(close, current.getTime());
        continue;
      }
      const openMins = minutes(closure.openTime ?? closure.open_time);
      let closeMins = minutes(closure.closeTime ?? closure.close_time);
      if (!Number.isFinite(openMins) || !Number.isFinite(closeMins)) return 0;
      if (closeMins === 0) closeMins = 1440;
      // Partial-day overrides describe the hours available on this calendar date.
      const segment = Math.max(start.getTime(), current.getTime());
      const minuteOfDay = (segment - current.getTime()) / MINUTE;
      if (closeMins > openMins) {
        if (minuteOfDay < openMins || minuteOfDay >= closeMins) close = Math.min(close, segment);
        else close = Math.min(close, current.getTime() + closeMins * MINUTE);
      } else if (minuteOfDay < closeMins) {
        close = Math.min(close, current.getTime() + closeMins * MINUTE);
      } else if (minuteOfDay < openMins) close = Math.min(close, segment);
    }
  }
  return Math.max(0, (close - start.getTime()) / MINUTE);
}

export function withoutBookingInterval(reservations, booking) {
  if (!booking || !blocksTable(booking)) return reservations;
  const own = reservationInterval(booking);
  const index = reservations.findIndex(row => {
    const interval = reservationInterval(row);
    return blocksTable(row) && row.tableId === booking.tableId &&
      interval.start.getTime() === own.start.getTime() && interval.end.getTime() === own.end.getTime();
  });
  return index < 0 ? reservations : reservations.filter((_, i) => i !== index);
}

function peakConcurrentBookings(reservations, start, end, excludeReservationId) {
  const changes = new Map();
  for (const row of reservations) {
    if (row.id === excludeReservationId || !blocksTable(row)) continue;
    const interval = reservationInterval(row);
    if (!Number.isFinite(interval.start.getTime()) || !Number.isFinite(interval.end.getTime()) || interval.end <= interval.start) return null;
    if (interval.start >= end || interval.end <= start) continue;
    const from = Math.max(start.getTime(), interval.start.getTime());
    const to = Math.min(end.getTime(), interval.end.getTime());
    changes.set(from, (changes.get(from) || 0) + 1);
    changes.set(to, (changes.get(to) || 0) - 1);
  }
  let occupied = 0, peak = 0;
  for (const [time, delta] of [...changes].sort(([a], [b]) => a - b)) {
    if (time >= end.getTime()) break;
    occupied += delta;
    peak = Math.max(peak, occupied);
  }
  return peak;
}

export function validateBookingSlot({ date, time, duration, tableId, rates, terms = {}, closedDates = [], reservations = [], tables = [], excludeReservationId, now = new Date() }) {
  const start = at(date, time);
  if (!Number.isFinite(start.getTime()) || !Number.isInteger(duration) || duration < 1 || duration > 24) return 'invalid';
  if (!tableId) return 'no_table';
  if (start <= now) return 'past';
  if (start.getTime() < now.getTime() + Number(terms.advanceBookingHours ?? 1) * 60 * MINUTE) return 'advance';
  if (duration < Number(terms.minHours ?? 1) || duration > Number(terms.maxHours ?? 24)) return 'invalid';
  if (duration * 60 > minutesUntilClose(date, time, rates, closedDates)) return 'closed';
  const end = new Date(start.getTime() + duration * 60 * MINUTE);
  const table = tables.find(t => t.id === tableId);
  if (!table || table.isActive === false || table.isActive === 0 || table.status === 'maintenance') return 'no_table';
  for (const reservation of reservations) {
    if (reservation.id === excludeReservationId || reservation.tableId !== tableId || !blocksTable(reservation)) continue;
    const other = reservationInterval(reservation);
    if (start < other.end && end > other.start) return 'table_conflict';
  }
  if (table.status === 'occupied' && !hasTimedSession(table.session)) return 'active_conflict';
  if (table.status === 'occupied') {
    const sessionStart = new Date(table.session.startTime);
    const sessionEnd = new Date(sessionStart.getTime() + Number(table.session.durationMinutes) * MINUTE);
    if (start < sessionEnd && end > sessionStart) return 'active_conflict';
  }
  const weekend = [0, 5, 6].includes(day(date).getDay());
  const capacity = weekend ? rates.weekendOnlineCapacityLimit : rates.weekdayOnlineCapacityLimit;
  if (rates.bookingCapacityMode !== 'tables' || !Number.isSafeInteger(capacity) || capacity < 0) return 'invalid';
  const peak = peakConcurrentBookings(reservations, start, end, excludeReservationId);
  if (peak === null) return 'invalid';
  if (peak >= capacity) return 'full';
  return 'valid';
}
