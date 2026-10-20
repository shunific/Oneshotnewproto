const numberKeys = [
  'hourlyRate', 'overtimeRate', 'downPaymentPercent', 'bookingCutoffMinutes',
  'weekdayHappyHourRate', 'weekendHappyHourRate', 'weekdayOnlineCapacityLimit', 'weekendOnlineCapacityLimit',
  'minHours', 'maxHours', 'cancellationHours', 'advanceBookingHours',
  'weekdayMinPartySize', 'weekdayMaxPartySize', 'weekendMinPartySize', 'weekendMaxPartySize',
];
const timeKeys = [
  'weekdayStartTime', 'weekdayEndTime', 'weekendStartTime', 'weekendEndTime',
  'weekdayHappyHourStart', 'weekdayHappyHourEnd', 'weekendHappyHourStart', 'weekendHappyHourEnd',
];
const booleanKeys = ['isWeekdayHappyHourActive', 'isWeekendHappyHourActive'];
const textKeys = ['cancellationPolicy', 'termsAndConditions', 'bookingCapacityMode'];
const countKeys = ['weekdayOnlineCapacityLimit', 'weekendOnlineCapacityLimit', 'weekdayMinPartySize', 'weekdayMaxPartySize', 'weekendMinPartySize', 'weekendMaxPartySize'];
const canonicalKeys = new Map([...numberKeys, ...timeKeys, ...booleanKeys, ...textKeys].map(key => [key.toLowerCase(), key]));

export function parseSystemSettings(rows) {
  const settings = {};
  for (const row of rows) {
    const rawKey = row.keyname ?? row.key_name ?? row.keyName;
    if (typeof rawKey !== 'string') continue;
    const key = canonicalKeys.get(rawKey.replace(/_/g, '').toLowerCase());
    const raw = row.settingvalue ?? row.setting_value ?? row.content_value ?? row.settingValue;
    if (!key || raw == null) continue;
    if (booleanKeys.includes(key)) {
      if ([true, 1, '1', 'true'].includes(raw)) settings[key] = true;
      else if ([false, 0, '0', 'false'].includes(raw)) settings[key] = false;
    } else if (numberKeys.includes(key)) {
      if (!['number', 'string'].includes(typeof raw) || String(raw).trim() === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) continue;
      if (key === 'downPaymentPercent' && value > 100) continue;
      if (countKeys.includes(key) && (!Number.isSafeInteger(value) || (typeof raw === 'string' && !/^\d+(?:\.0+)?$/.test(raw.trim())))) continue;
      settings[key] = value;
    } else if (timeKeys.includes(key)) {
      if (typeof raw === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) settings[key] = raw;
    } else if (typeof raw === 'string') settings[key] = raw;
  }
  return settings;
}

export function hasBookingSettings(settings) {
  if (settings.bookingCapacityMode !== 'tables') return false;
  if (!['weekdayOnlineCapacityLimit', 'weekendOnlineCapacityLimit'].every(key => Number.isSafeInteger(settings[key]) && settings[key] >= 0)) return false;
  for (const prefix of ['weekday', 'weekend']) {
    const minimum = settings[`${prefix}MinPartySize`], maximum = settings[`${prefix}MaxPartySize`];
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 1 || maximum < minimum) return false;
  }
  const rate = settings.hourlyRate, percent = settings.downPaymentPercent;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100000 || Math.round(rate * 100) / 100 !== rate) return false;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return false;
  return ['weekdayStartTime', 'weekdayEndTime', 'weekendStartTime', 'weekendEndTime']
    .every(key => typeof settings[key] === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(settings[key]));
}

export function calculateDownPayment(total, percent) {
  if (!Number.isFinite(total) || total < 0 || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error('Invalid booking payment configuration.');
  }
  return Math.min(total, Math.ceil(total * percent / 100));
}
