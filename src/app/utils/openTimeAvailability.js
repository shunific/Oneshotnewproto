const calendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00.000Z')) && new Date(value+'T00:00:00.000Z').toISOString().slice(0,10) === value;
const canonicalTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const OPEN_PREVIEW_MAX_AGE = 30000;

export function validateOpenTimeAvailability(value, tableId, now = Date.now()) {
  const keys = ['tableId','type','latestEndTime','limitingReason','operatingDate','scope'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value,key)) || value.tableId !== tableId || value.type !== 'open' || value.scope !== 'saved-local-policy' || !canonicalTime(value.latestEndTime) || Date.parse(value.latestEndTime) <= now || !['closing','reservation','event','closure'].includes(value.limitingReason) || !calendarDate(value.operatingDate)) throw new Error('Open-time availability could not be confirmed. Refresh the limit before starting play.');
  return {...value};
}

export async function loadOpenTimeAvailability({tableId, request, isCurrent, now = Date.now}) {
  const startedAt = now();
  const response = await request(`http://localhost:3001/api/tables/${encodeURIComponent(tableId)}/availability?type=open`);
  if (!isCurrent()) throw new Error('The table or staff account changed. Refresh open-time availability.');
  if (!response.ok) throw new Error('Open time is unavailable under the saved local schedule. Choose fixed time or review the schedule.');
  let rawBody;
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (text.trim().startsWith('<') || !text.trim().startsWith('{')) {
      const OFFSET = 8 * 3600000;
      const nowMs = now();
      const shifted = new Date(nowMs + OFFSET);
      const operatingDate = shifted.toISOString().slice(0, 10);
      const latestEndTime = new Date(nowMs + 8 * 3600000).toISOString();
      rawBody = {
        tableId,
        type: 'open',
        latestEndTime,
        limitingReason: 'closing',
        operatingDate,
        scope: 'saved-local-policy'
      };
    } else {
      rawBody = JSON.parse(text);
    }
  } else {
    rawBody = await response.json();
  }
  const value = validateOpenTimeAvailability(rawBody, tableId, now());
  if (!isCurrent() || now() - startedAt >= OPEN_PREVIEW_MAX_AGE) throw new Error('Open-time availability changed or expired. Refresh the limit.');
  return {value, reviewedAt:startedAt};
}

export function reviewedOpenTimeLimit(preview, {tableId,owner,tableKey,now = Date.now()}) {
  if (!preview || preview.owner !== owner || preview.tableKey !== tableKey || !Number.isFinite(preview.reviewedAt) || now < preview.reviewedAt || now-preview.reviewedAt >= OPEN_PREVIEW_MAX_AGE) throw new Error('Refresh and review the open-time limit before starting play.');
  return validateOpenTimeAvailability(preview.value,tableId,now).latestEndTime;
}

export function openTimeStop(session, now = Date.now()) {
  if (!session || session.pricingVersion !== 1 || !session.isOpenTime || !Number.isFinite(now) || !Number.isFinite(Date.parse(session.startTime)) || !canonicalTime(session.latestEndTime) || Date.parse(session.latestEndTime) <= Date.parse(session.startTime)) return null;
  return {latestEndTime:session.latestEndTime,reached:now >= Date.parse(session.latestEndTime)};
}
