// Event → table blocking published to Supabase.
//
// The cloud `events` table has no per-table columns, so the customer website
// could never tell which tables an event actually occupies. The local machine
// is the source of truth for event setup, so this module turns local event rows
// into two shapes the public site already understands:
//   1. a JSON map stored in `cms` (key `eventTableAssignments`) that the
//      website merges into each event's `eventTableIds`;
//   2. `EVENT` reservation rows, one per date + table, used for per-slot
//      conflict checks and the "EVENT" chips in the booking schedule.
const EVENT_ASSIGNMENT_KEY = 'eventTableAssignments';

const parseIdList = (raw) => {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {}
  }
  return [];
};

const eventIsCancelled = (ev) =>
  !!ev && (ev.isCancelled === 1 || ev.isCancelled === true || ev.isCancelled === '1' || ev.isCancelled === 'true');

const toMinutes = (value) => {
  const [h = '0', m = '0'] = String(value || '').split(':');
  return (Number(h) || 0) * 60 + (Number(m) || 0);
};

const buildEventTableBlocking = (eventRows) => {
  const map = {};
  const reservations = [];

  for (const ev of eventRows || []) {
    if (!ev || eventIsCancelled(ev)) continue;

    const tableIds = [...new Set([...parseIdList(ev.eventTableIds), ...parseIdList(ev.reservationTableIds)])];
    if (tableIds.length === 0) continue;
    map[String(ev.id)] = tableIds;

    const dates = String(ev.date || '')
      .split(',')
      .map((d) => d.trim())
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (dates.length === 0) continue;

    const duration = String(ev.duration || 'Whole Day').trim();
    const wholeDay = duration === '' || duration === 'Whole Day';
    const [startRaw = '12:00', endRaw = ''] = wholeDay ? [] : duration.split('-').map((s) => s.trim());

    let durationHours = 12;
    if (!wholeDay) {
      const startMins = toMinutes(startRaw);
      let endMins = toMinutes(endRaw);
      if (endMins <= startMins) endMins += 24 * 60;
      durationHours = Math.max(1, Math.round((endMins - startMins) / 60));
    }

    for (const day of dates) {
      for (const tableId of tableIds) {
        reservations.push({
          id: `EVT-${ev.id}-${day.replace(/-/g, '')}-${tableId}`,
          customerName: `EVENT: ${ev.title || 'Event'}`,
          contactNumber: 'ADMIN',
          email: 'admin@oneshot.com',
          // Noon allows any timezone to resolve to the same calendar day.
          date: `${day}T12:00:00+08:00`,
          timeSlot: wholeDay ? '12:00' : startRaw,
          durationHours,
          partySize: Number(ev.maxParticipants) || 10,
          tableId,
          status: 'confirmed',
          totalAmount: 0,
          downPaymentAmount: 0,
          downPaymentPaid: 1,
          balancePaid: 1,
          paymentRef: 'EVENT',
          rescheduleCount: 0,
          createdAt: ev.createdAt || new Date().toISOString()
        });
      }
    }
  }

  return { map, reservations };
};

module.exports = { EVENT_ASSIGNMENT_KEY, parseIdList, eventIsCancelled, buildEventTableBlocking };
