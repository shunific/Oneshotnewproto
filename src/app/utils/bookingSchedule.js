import { eventBlockIntervals } from './eventAvailability.js';

const minute = 60_000;
const mins = value => {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value || ''));
  return match && +match[1] < 24 && +match[2] < 60 ? +match[1] * 60 + +match[2] : NaN;
};
export function bookingDay(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(value + 'T00:00:00');
  return new Date(value);
}
export function bookingDayKey(value) {
  const date = bookingDay(value);
  return [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
}
function offsetDay(day, offset) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()+offset);
}
export function closureOn(day, closures) {
  return (closures || []).find(row => row.type === 'weekly'
    ? Number(row.dayOfWeek ?? row.day_of_week) === day.getDay()
    : bookingDayKey(row.date ?? row.closedDate ?? row.closed_date) === bookingDayKey(day));
}
export const holdsBooking = row => ['pending','confirmed','checked-in','pending-reschedule','seated'].includes(row.status);
function opening(day, rates) {
  const weekend = [0,5,6].includes(day.getDay());
  const start = mins((weekend && rates?.weekendStartTime) || rates?.weekdayStartTime || '12:00');
  const end = mins((weekend && rates?.weekendEndTime) || rates?.weekdayEndTime || '02:00');
  return [start, end <= start ? end + 1440 : end];
}

// Minutes are relative to the selected calendar day's midnight, including sessions
// that start before midnight and finish the next morning.
export function freeIntervals(day, table, settings, excludeId) {
  if (!table || table.isActive === false || table.isActive === 0 || table.status === 'maintenance' || closureOn(day,settings.closedDates)) return [];
  const midnight = offsetDay(day,0).getTime();
  const previous = offsetDay(day,-1), tomorrow = offsetDay(day,1);
  const [start,end] = opening(day,settings.rates);
  const priorEnd = opening(previous,settings.rates)[1]-1440;
  const windows = [[start,closureOn(tomorrow,settings.closedDates) ? Math.min(1440,end) : end]];
  if (priorEnd > 0 && !closureOn(previous,settings.closedDates)) windows.unshift([0,priorEnd]);
  const blocks = [...eventBlockIntervals(settings.events,table.id,day),
    ...eventBlockIntervals(settings.events,table.id,tomorrow).map(([a,b])=>[a+1440,b+1440])];
  for (const r of settings.reservations || []) {
    if (r.id === excludeId || r.tableId !== table.id || !holdsBooking(r)) continue;
    const date = bookingDay(r.date);
    const from = (offsetDay(date,0).getTime()-midnight)/minute + mins(r.timeSlot);
    blocks.push([from,from + Number(r.durationHours)*60]);
  }
  if (table.status === 'occupied' && table.session?.startTime) {
    const from = (new Date(table.session.startTime).getTime()-midnight)/minute;
    const until = table.session.durationMinutes == null ? 1440 : from + Number(table.session.durationMinutes);
    if (table.session.durationMinutes != null || bookingDayKey(day) === bookingDayKey(new Date(settings.now ?? Date.now()))) blocks.push([from,until]);
  }
  const earliest = Math.ceil(((settings.now ?? Date.now())-midnight)/minute) + 60;
  let free = windows.map(([a,b])=>[Math.max(a,earliest),b]);
  for (const [a,b] of blocks) {
    if (!(a<b)) continue;
    free = free.flatMap(([left,right])=> b<=left || a>=right ? [[left,right]] : [[left,Math.min(a,right)],[Math.max(b,left),right]]);
  }
  return free.filter(([a,b])=>a<1440 && b>a);
}

export function slotCapacity(day, time, table, settings, excludeId) {
  if (!day || !time) return 0;
  const start = mins(time);
  const window = freeIntervals(day,table,settings,excludeId).find(([a,b])=>start>=a && start<b);
  return window ? Math.min(Math.floor((window[1]-start)/60),Number(settings.maxHours)||24) : 0;
}
