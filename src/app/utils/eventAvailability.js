// Event table availability is time-scoped: a timed event only reserves its
// allocated tables for the event window, while a whole-day event reserves them
// for the entire day. Shared by the staff app and the customer website so both
// agree on when an event actually blocks a table.

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86400000;
const pad = n => String(n).padStart(2, '0');

const dayKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const toMins = value => {
  const match = TIME.exec(String(value ?? '').trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

export function eventDates(event) {
  const out = [];
  const push = value => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) && !out.includes(trimmed)) out.push(trimmed);
  };
  if (Array.isArray(event?.dates)) event.dates.forEach(push);
  else if (typeof event?.dates === 'string') {
    try {
      const parsed = JSON.parse(event.dates);
      Array.isArray(parsed) ? parsed.forEach(push) : push(event.dates);
    } catch { push(event.dates); }
  }
  if (typeof event?.date === 'string') event.date.split(',').forEach(push);
  return out;
}

export function eventTableIds(event) {
  const raw = event?.selectedTableIds ?? event?.eventTableIds ?? event?.event_table_ids ?? event?.tableIds;
  if (Array.isArray(raw)) return raw.filter(id => typeof id === 'string' && id);
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(id => typeof id === 'string' && id);
      return [raw];
    } catch { return [raw]; }
  }
  return [];
}

// Returns the event window in minutes from midnight, or null when the duration
// is not a valid "HH:mm - HH:mm" range. Overnight ranges are kept > 1440.
export function eventWindow(event) {
  if (event?.duration === 'Whole Day') return { wholeDay: true, startMins: 0, endMins: 1440 };
  const match = /^\s*([0-2]\d:[0-5]\d)\s*-\s*([0-2]\d:[0-5]\d)\s*$/.exec(String(event?.duration ?? ''));
  if (!match) return null;
  const start = toMins(match[1]);
  const end = toMins(match[2]);
  if (start === null || end === null || start === end) return null;
  return { wholeDay: false, startMins: start, endMins: end <= start ? end + 1440 : end };
}

// An event reserves its listed tables; when no tables are listed it reserves the
// whole venue only if it explicitly disables reservations.
export function eventAppliesToTable(event, tableId) {
  const ids = eventTableIds(event);
  if (ids.length > 0) return ids.includes(tableId);
  return event?.allowReservations === false;
}

export function eventAppliesOnDate(event, date) {
  return eventDates(event).includes(dayKey(date));
}

// Blocking intervals (minutes from midnight of `date`) covering the event's
// window, including the previous day's window when it spills past midnight.
export function eventBlockIntervals(events, tableId, date) {
  const today = dayKey(date);
  const previous = dayKey(new Date(date.getTime() - DAY_MS));
  const intervals = [];
  for (const event of events || []) {
    if (event?.isCancelled) continue;
    if (!eventAppliesToTable(event, tableId)) continue;
    const window = eventWindow(event);
    if (!window) continue;
    const dates = eventDates(event);
    if (dates.includes(today)) {
      intervals.push(window.wholeDay ? [0, 1440] : [window.startMins, window.endMins]);
    }
    if (!window.wholeDay && window.endMins > 1440 && dates.includes(previous)) {
      intervals.push([window.startMins - 1440, window.endMins - 1440]);
    }
  }
  return intervals;
}

// A table is blocked for the whole day only by a whole-day event (or an event
// that disables reservations entirely for the day).
export function isTableBlockedAllDay(events, tableId, date) {
  return eventBlockIntervals(events, tableId, date).some(([start, end]) => start <= 0 && end >= 1440);
}

// Whether a requested slot overlaps any event window on that date.
export function isSlotBlockedByEvent(events, tableId, date, startMins, endMins) {
  if (!Number.isFinite(startMins) || !Number.isFinite(endMins) || endMins <= startMins) return false;
  return eventBlockIntervals(events, tableId, date).some(([start, end]) => startMins < end && endMins > start);
}

// The event (if any) reserving this table on this date, preferring whole-day.
export function eventForTable(events, tableId, date) {
  const matches = (events || []).filter(event =>
    !event?.isCancelled && eventAppliesToTable(event, tableId) && eventAppliesOnDate(event, date) && eventWindow(event)
  );
  return matches.find(event => eventWindow(event).wholeDay) || matches[0] || null;
}

export function formatEventWindow(event) {
  const window = eventWindow(event);
  if (!window) return '';
  if (window.wholeDay) return 'Whole Day';
  const fmt = mins => {
    const total = ((mins % 1440) + 1440) % 1440;
    const h = Math.floor(total / 60);
    const m = total % 60;
    const period = h < 12 ? 'AM' : 'PM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:${pad(m)} ${period}`;
  };
  return `${fmt(window.startMins)} - ${fmt(window.endMins)}`;
}

export const eventDateKey = dayKey;
