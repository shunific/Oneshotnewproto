// Store hours follow the same operating-day rules as the server venue availability
// check: Friday, Saturday and Sunday use the weekend schedule, and an after-midnight
// hour still belongs to the previous day's operating window (e.g. 2 AM Friday is
// Thursday's shift when Thursday closes at 5 AM).
const DAY = 86400000;
const OFFSET = 8 * 3600000; // Asia/Manila, matches server-venue-availability.cjs
const WEEKEND_DAYS = [0, 5, 6]; // Sun, Fri, Sat per Site Settings

export function parseStoreTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

const manilaMidnight = (ms) => {
  const shifted = new Date(ms + OFFSET);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - OFFSET;
};

export function getStoreWindowInfo(rates, nowMs = Date.now()) {
  const weekdayOpen = parseStoreTime(rates?.weekdayStartTime);
  const weekdayClose = parseStoreTime(rates?.weekdayEndTime);
  const weekendOpen = parseStoreTime(rates?.weekendStartTime);
  const weekendClose = parseStoreTime(rates?.weekendEndTime);

  // Incomplete or invalid schedules must not block play with a false "closed" state.
  if ([weekdayOpen, weekdayClose, weekendOpen, weekendClose].some((value) => value === null)) {
    return { configured: false, isOpen: true, remaining: null, windowMins: null };
  }
  if (weekdayOpen === weekdayClose || weekendOpen === weekendClose) {
    return { configured: false, isOpen: true, remaining: null, windowMins: null };
  }

  const today = manilaMidnight(nowMs);
  let window = null;

  // Check the operating day starting today and the one that started yesterday.
  for (const anchor of [today - DAY, today]) {
    const dayOfWeek = new Date(anchor + OFFSET).getUTCDay();
    const weekend = WEEKEND_DAYS.includes(dayOfWeek);
    const openMins = weekend ? weekendOpen : weekdayOpen;
    const closeMins = weekend ? weekendClose : weekdayClose;

    const opening = anchor + openMins * 60000;
    let closing = anchor + closeMins * 60000;
    if (closing <= opening) closing += DAY; // crosses midnight

    if (nowMs >= opening && nowMs < closing) {
      window = { opening, closing };
      break;
    }
  }

  if (!window) return { configured: true, isOpen: false, remaining: 0, windowMins: null };

  return {
    configured: true,
    isOpen: true,
    remaining: Math.max(0, (window.closing - nowMs) / 60000),
    windowMins: Math.round((window.closing - window.opening) / 60000),
  };
}
