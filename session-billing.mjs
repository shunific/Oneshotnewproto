const fail = (status, message) => Object.assign(new Error(message), { status });
function money(value, status = 409) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)) || Number(value.toFixed(2)) !== value) throw fail(status, 'Amounts must be nonnegative currency values with at most two decimal places.');
  return Math.round(value * 100);
}
export function calculateSessionBill(session, now, useProrated) {
  if (!session || typeof session !== 'object' || typeof useProrated!=='boolean' || !Number.isFinite(now)) throw fail(409, 'Stored session billing input is invalid.');
  const start = Date.parse(session.startTime);
  if (!Number.isFinite(start) || start > now) throw fail(409, 'Stored session start time is invalid.');
  const pricingVersion = Object.hasOwn(session,'pricingVersion') ? session.pricingVersion : 0;
  if (Object.hasOwn(session,'pricingVersion') && ![1,2].includes(pricingVersion)) throw fail(409, 'Stored pricing version is unsupported.');
  const reservation = pricingVersion === 2 ? session.reservationPricing : null;
  let rate, discountCents = 0;
  const alreadyPaid = money(session.amountPaid);
  const booked = session.durationMinutes;
  if (booked !== null && (!Number.isSafeInteger(booked) || booked <= 0)) throw fail(409, 'Stored duration is invalid.');
  if (pricingVersion === 2) {
    const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
    const validCents = value => Number.isSafeInteger(value) && value >= 0 && value <= 240000000;
    if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation) ||
        !uuid(reservation.claimId) || !uuid(reservation.ownerUserId) ||
        typeof reservation.reservationId !== 'string' || !reservation.reservationId.trim() || reservation.reservationId.trim() !== reservation.reservationId || reservation.reservationId.length > 120 ||
        !Number.isSafeInteger(reservation.sourceRevision) || reservation.sourceRevision <= 0 || !Number.isSafeInteger(reservation.claimRevision) || reservation.claimRevision !== reservation.sourceRevision + 1 ||
        session.reservationId !== reservation.reservationId || session.hourlyRate !== null ||
        !['grossCents','discountCents','netCents','verifiedPaidCents'].every(key => validCents(reservation[key])) ||
        reservation.discountCents > reservation.grossCents || reservation.netCents !== reservation.grossCents - reservation.discountCents ||
        reservation.verifiedPaidCents > reservation.netCents || alreadyPaid !== reservation.verifiedPaidCents) throw fail(409, 'Stored reservation pricing snapshot is invalid.');
    if (useProrated || session.isOpenTime !== false || !Number.isSafeInteger(booked) || booked < 60 || booked > 1440 || booked % 60 !== 0 || booked !== reservation.durationMinutes) throw fail(409, 'Reservation duration or prorating requires venue-rule review.');
    rate = 0;
    discountCents = reservation.discountCents;
  } else {
    rate = money(session.hourlyRate);
    if (pricingVersion === 1 && rate <= 0) throw fail(409, 'Stored hourly rate is invalid.');
  }
  const overtimeRateCents = pricingVersion >= 1 ? money(session.overtimeRate) : rate;
  if (pricingVersion >= 1 && overtimeRateCents <= 0) throw fail(409, 'Stored overtime rate is invalid.');
  if (typeof session.customerName !== 'string' || !session.customerName.trim() || typeof session.isOpenTime !== 'boolean' || !Array.isArray(session.orders || [])) throw fail(409, 'Stored session is invalid.');
  // Open-time play stops at the reviewed venue boundary even if staff settle later.
  let billUntil = now;
  if (Object.hasOwn(session, 'latestEndTime')) {
    const limit = Date.parse(session.latestEndTime);
    if (pricingVersion !== 1 || session.isOpenTime !== true ||
        typeof session.latestEndTime !== 'string' || !Number.isFinite(limit) ||
        new Date(limit).toISOString() !== session.latestEndTime || limit <= start) {
      throw fail(409, 'Stored open-time play limit is invalid.');
    }
    billUntil = Math.min(now, limit);
  }
  const elapsedMins = Math.ceil(Math.floor((billUntil - start) / 1000) / 60);
  if (!Number.isSafeInteger(elapsedMins)) throw fail(409, 'Stored session elapsed time is invalid.');
  const elapsedBilling = session.isOpenTime || booked === null || useProrated;
  const overtimeMins = elapsedBilling ? 0 : Math.max(0, Math.ceil(Math.floor((now - start - booked * 60000) / 1000) / 60));
  const billableMins = Math.max(60, elapsedMins);
  const tableCents = pricingVersion === 2 ? reservation.grossCents : elapsedBilling ? Math.round(Math.ceil(billableMins / 30) * rate / 2) : Math.round(booked * rate / 60);
  const overtimeCents = Math.round(overtimeMins * overtimeRateCents / 60);
  const fnbCents = (session.orders || []).reduce((total, order) => {
    if (!order || typeof order.id !== 'string' || !Number.isSafeInteger(order.qty) || order.qty <= 0) throw fail(409, 'Stored orders are invalid.');
    return total + money(order.price) * order.qty;
  }, 0);
  const totalCents = tableCents - discountCents + overtimeCents + fnbCents;
  if (!Number.isSafeInteger(totalCents) || !Number.isSafeInteger(totalCents + discountCents)) throw fail(409, 'Session amount is too large.');
  return { discountCents, overtimeRateCents, pricingVersion, elapsedMins, overtimeMins, tableCents, overtimeCents, fnbCents, totalCents, alreadyPaid, balanceCents: Math.max(0, totalCents - alreadyPaid), refundCents: Math.max(0, alreadyPaid - totalCents) };
}
export function previewSessionBill(session, nowMillis, useProrated=false) {
  const bill=calculateSessionBill(session,nowMillis,useProrated);
  return {elapsedMins:bill.elapsedMins,alreadyPaid:bill.alreadyPaid/100,bookedCharge:bill.tableCents/100,bookingDiscount:bill.discountCents/100,overtimeCharge:bill.overtimeCents/100,posOrdersTotal:bill.fnbCents/100,totalDue:bill.totalCents/100,balance:bill.balanceCents/100,refundDue:bill.refundCents/100,isOvertime:bill.overtimeMins>0,overtimeMins:bill.overtimeMins,isOpenTime:session.isOpenTime,overtimeRate:bill.overtimeRateCents/100};
}

// The venue uses the Manila calendar day: Mon–Thu weekday, Fri–Sun weekend.
// Snapshot this selection once at admission; billing never re-reads the clock policy.
export function selectWalkInStartPricing(settings, startedAt) {
  if (!Number.isFinite(startedAt)) throw fail(409, 'Session start time is invalid.');
  const local = new Date(startedAt + 8 * 3600000);
  if (!Number.isFinite(local.getTime())) throw fail(409, 'Session start time is invalid.');
  const day = local.getUTCDay();
  const policyDay = [0,5,6].includes(day) ? 'weekend' : 'weekday';
  const numeric = value => typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  const validRate = value => Number.isFinite(value) && value > 0 && value <= 5000 && Number(value.toFixed(2)) === value;
  const base = numeric(settings?.hourlyRate), overtimeRate = numeric(settings?.overtimeRate);
  const activeValue = settings?.[policyDay === 'weekday' ? 'isWeekdayHappyHourActive' : 'isWeekendHappyHourActive'];
  const active = activeValue === true || activeValue === 'true' ? true : activeValue === false || activeValue === 'false' ? false : null;
  if (!validRate(base) || !validRate(overtimeRate) || active === null) throw fail(409, 'Review the saved hourly, overtime and Happy Hour policy before starting play.');
  let isHappyHour = false, hourlyRate = base;
  if (active) {
    const from = settings[policyDay + 'HappyHourStart'], to = settings[policyDay + 'HappyHourEnd'];
    const time = value => typeof value === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
    const happyRate = numeric(settings[policyDay + 'HappyHourRate']);
    if (!time(from) || !time(to) || from === to || !validRate(happyRate)) throw fail(409, 'Review the active Happy Hour window and rate before starting play.');
    const minute = value => Number(value.slice(0,2)) * 60 + Number(value.slice(3));
    const current = local.getUTCHours() * 60 + local.getUTCMinutes(), start = minute(from), end = minute(to);
    isHappyHour = start < end ? current >= start && current < end : current >= start || current < end;
    if (isHappyHour) hourlyRate = happyRate;
  }
  return { hourlyRate, overtimeRate, isHappyHour, policyDay };
}
