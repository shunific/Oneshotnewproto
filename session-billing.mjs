const fail = (status, message) => Object.assign(new Error(message), { status });

// Shared Last Play / courtesy decision window after the booked end.
export const EXTENSION_DECISION_MINUTES = 2;
export const EXTENSION_DECISION_SECONDS = EXTENSION_DECISION_MINUTES * 60;
// Kept so older callers that still import the previous name keep working.
export const OVERTIME_GRACE_MINUTES = EXTENSION_DECISION_MINUTES;

function money(value, status = 409) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)) || Number(value.toFixed(2)) !== value) {
    throw fail(status, 'Amounts must be nonnegative currency values with at most two decimal places.');
  }
  return Math.round(value * 100);
}

// 🟢 Tiered Overtime Billing (Overtime Bill Only — No Extra Regular Hour):
// - 0 to 2:00 past booked end: ₱0 (Last Play Buffer)
// - 2:01 to 29:59 past booked end: 0.5 hr (50% of overtime rate)
// - 30:00 to 60:00 past booked end: 1.0 hr (100% of overtime rate; customer may finish the rest of the hour)
// - Pattern repeats if they stay past the hour (60:01–89:59 -> 1.5h, 90:00–120:00 -> 2.0h)
export function computeOvertimeTier(rawPastEndSecs, overtimeRateCents) {
  if (!Number.isFinite(rawPastEndSecs) || rawPastEndSecs <= EXTENSION_DECISION_SECONDS) {
    return {
      overtimeMins: 0,
      billedOvertimeHours: 0,
      overtimeCents: 0,
      isAutoExtendedOvertime: false,
      overtimeLabel: 'Last Play Buffer',
    };
  }

  const fullCompletedHours = Math.floor((rawPastEndSecs - 1) / 3600);
  const secsIntoHour = ((rawPastEndSecs - 1) % 3600) + 1; // 1..3600
  const isAutoExtendedOvertime = secsIntoHour >= 1800; // 30:00+ into the overtime hour
  const billedOvertimeHours = fullCompletedHours + (isAutoExtendedOvertime ? 1 : 0.5);
  const overtimeCents = Math.round(billedOvertimeHours * overtimeRateCents);

  return {
    overtimeMins: Math.ceil(rawPastEndSecs / 60),
    billedOvertimeHours,
    overtimeCents,
    isAutoExtendedOvertime,
    overtimeLabel: billedOvertimeHours === 0.5
      ? 'Half-Hour Overtime'
      : `Full ${billedOvertimeHours}h Overtime (Play Remaining Time)`,
  };
}

// 🟢 Shared Timer State for Table Monitor, Live Monitor, and AppContext Auto-End
export function getSessionTimerState(session, nowMs, nextReservationMs = null) {
  if (!session || !session.startTime) {
    return {
      mode: 'idle',
      displayMs: 0,
      percentLeft: 0,
      isOpenTime: false,
      isGrace: false,
      isOvertime: false,
      isOvertimeExtension: false,
      cappedByReservation: false,
      reservationCutoffMs: null,
      effectiveEndMs: null,
      billedOvertimeHours: 0,
      overtimeLabel: '',
    };
  }

  const startMs = Date.parse(session.startTime);
  const elapsedMs = Math.max(0, nowMs - startMs);

  // Open Time (counting UP)
  if (session.isOpenTime || session.durationMinutes === null || session.durationMinutes === undefined) {
    return {
      mode: 'open',
      displayMs: elapsedMs,
      percentLeft: 100,
      isOpenTime: true,
      isGrace: false,
      isOvertime: false,
      isOvertimeExtension: false,
      cappedByReservation: false,
      reservationCutoffMs: null,
      effectiveEndMs: null,
      billedOvertimeHours: 0,
      overtimeLabel: '',
    };
  }

  const totalMs = Number(session.durationMinutes) * 60000;
  const scheduledEndMs = startMs + totalMs;
  const remainingMs = scheduledEndMs - nowMs;
  const decisionMs = EXTENSION_DECISION_MINUTES * 60000;

  // 1. Normal booked duration counting DOWN
  if (remainingMs > 0) {
    return {
      mode: 'fixed',
      displayMs: remainingMs,
      percentLeft: Math.max(0, Math.min(100, (remainingMs / totalMs) * 100)),
      isOpenTime: false,
      isGrace: false,
      isOvertime: false,
      isOvertimeExtension: false,
      cappedByReservation: false,
      reservationCutoffMs: null,
      effectiveEndMs: scheduledEndMs,
      billedOvertimeHours: 0,
      overtimeLabel: '',
    };
  }

  // 🟢 Overtime already waived by Admin -> no longer tagged as overtime
  if (session.overtimeWaived) {
    return {
      mode: 'overtime-waived',
      displayMs: 0,
      percentLeft: 0,
      isOpenTime: false,
      isGrace: false,
      isOvertime: false,
      isOvertimeExtension: false,
      isOvertimeWaived: true,
      cappedByReservation: false,
      reservationCutoffMs: null,
      effectiveEndMs: scheduledEndMs,
      billedOvertimeHours: 0,
      overtimeLabel: 'Overtime Waived',
    };
  }

  // 2. Last Play 2-minute buffer counting DOWN
  if (remainingMs > -decisionMs) {
    return {
      mode: 'grace',
      displayMs: Math.max(0, decisionMs + remainingMs),
      percentLeft: 0,
      isOpenTime: false,
      isGrace: true,
      isOvertime: false,
      isOvertimeExtension: false,
      cappedByReservation: false,
      reservationCutoffMs: null,
      effectiveEndMs: scheduledEndMs + decisionMs,
      billedOvertimeHours: 0,
      overtimeLabel: 'Last Play Buffer',
    };
  }

  // 3. Past Last Play buffer -> Overtime or Overtime Extension Countdown
  const rawPastEndMs = Math.max(0, nowMs - scheduledEndMs);
  const rawPastEndSecs = Math.floor(rawPastEndMs / 1000);
  const fullCompletedHours = Math.floor((Math.max(1, rawPastEndSecs) - 1) / 3600);
  const secsIntoHour = ((Math.max(1, rawPastEndSecs) - 1) % 3600) + 1;
  const currentHourEndMs = scheduledEndMs + (fullCompletedHours + 1) * 3600000;

  // Check if an upcoming reservation falls within this overtime hour
  const validResMs = Number.isFinite(nextReservationMs) && nextReservationMs >= scheduledEndMs
    ? nextReservationMs
    : null;
  const cappedByReservation = Boolean(validResMs && validResMs <= currentHourEndMs);
  const effectiveEndMs = cappedByReservation ? validResMs : currentHourEndMs;

  // Reservation time reached -> must auto-end here (billed strictly at reservation time)
  if (cappedByReservation && nowMs >= validResMs) {
    const cappedSecs = Math.max(0, Math.floor((validResMs - scheduledEndMs) / 1000));
    const tier = computeOvertimeTier(cappedSecs, 100);
    return {
      mode: 'reservation-ended',
      displayMs: 0,
      percentLeft: 0,
      isOpenTime: false,
      isGrace: false,
      isOvertime: true,
      isOvertimeExtension: true,
      cappedByReservation: true,
      reservationCutoffMs: validResMs,
      effectiveEndMs: validResMs,
      billedOvertimeHours: tier.billedOvertimeHours,
      overtimeLabel: tier.overtimeLabel,
    };
  }

  // 30:00+ into overtime hour -> Flip to Countdown ("30 mins left", capped by reservation if any)
  if (secsIntoHour >= 1800) {
    const leftMs = Math.max(0, effectiveEndMs - nowMs);
    const windowStartMs = scheduledEndMs + fullCompletedHours * 3600000 + 1800000;
    const windowSpanMs = Math.max(1, effectiveEndMs - windowStartMs);
    const billedHours = fullCompletedHours + 1;

    return {
      mode: 'overtime-extension',
      displayMs: leftMs,
      percentLeft: Math.max(0, Math.min(100, (leftMs / windowSpanMs) * 100)),
      isOpenTime: false,
      isGrace: false,
      isOvertime: true,
      isOvertimeExtension: true,
      cappedByReservation,
      reservationCutoffMs: cappedByReservation ? validResMs : null,
      effectiveEndMs,
      billedOvertimeHours: billedHours,
      overtimeLabel: cappedByReservation
        ? `${billedHours}h Overtime (Ends for Res.)`
        : `${billedHours}h Overtime Ext.`,
    };
  }

  // 2:01 to 29:59 -> Half-Hour Overtime counting UP
  const upMs = fullCompletedHours === 0
    ? Math.max(0, rawPastEndMs - decisionMs)
    : rawPastEndMs - fullCompletedHours * 3600000;
  const billedHours = fullCompletedHours + 0.5;

  return {
    mode: 'overtime',
    displayMs: upMs,
    percentLeft: 0,
    isOpenTime: false,
    isGrace: false,
    isOvertime: true,
    isOvertimeExtension: false,
    cappedByReservation,
    reservationCutoffMs: cappedByReservation ? validResMs : null,
    effectiveEndMs,
    billedOvertimeHours: billedHours,
    overtimeLabel: billedHours === 0.5 ? 'Half-Hour Overtime' : `${billedHours}h Overtime`,
  };
}

export function calculateSessionBill(session, now, useProrated, waiveOvertime = false) {
  if (!session || typeof session !== 'object' || typeof useProrated !== 'boolean' || !Number.isFinite(now)) {
    throw fail(409, 'Stored session billing input is invalid.');
  }
  const start = Date.parse(session.startTime);
  if (!Number.isFinite(start) || start > now) throw fail(409, 'Stored session start time is invalid.');
  const pricingVersion = Object.hasOwn(session, 'pricingVersion') ? session.pricingVersion : 0;
  if (Object.hasOwn(session, 'pricingVersion') && ![1, 2].includes(pricingVersion)) {
    throw fail(409, 'Stored pricing version is unsupported.');
  }
  const reservation = pricingVersion === 2 ? session.reservationPricing : null;
  let rate, discountCents = 0;
  const alreadyPaid = money(session.amountPaid);
  const booked = session.durationMinutes;
  if (booked !== null && (!Number.isSafeInteger(booked) || booked <= 0)) {
    throw fail(409, 'Stored duration is invalid.');
  }
  if (pricingVersion === 2) {
    const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
    const validCents = value => Number.isSafeInteger(value) && value >= 0 && value <= 240000000;
    if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation) ||
        !uuid(reservation.claimId) || !uuid(reservation.ownerUserId) ||
        typeof reservation.reservationId !== 'string' || !reservation.reservationId.trim() || reservation.reservationId.trim() !== reservation.reservationId || reservation.reservationId.length > 120 ||
        !Number.isSafeInteger(reservation.sourceRevision) || reservation.sourceRevision <= 0 || !Number.isSafeInteger(reservation.claimRevision) || reservation.claimRevision !== reservation.sourceRevision + 1 ||
        session.reservationId !== reservation.reservationId || session.hourlyRate !== null ||
        !['grossCents', 'discountCents', 'netCents', 'verifiedPaidCents'].every(key => validCents(reservation[key])) ||
        reservation.discountCents > reservation.grossCents || reservation.netCents !== reservation.grossCents - reservation.discountCents ||
        reservation.verifiedPaidCents > reservation.netCents || alreadyPaid !== reservation.verifiedPaidCents) {
      throw fail(409, 'Stored reservation pricing snapshot is invalid.');
    }
    if (useProrated || session.isOpenTime !== false || !Number.isSafeInteger(booked) || booked < 60 || booked > 1440 || booked % 60 !== 0 || booked !== reservation.durationMinutes) {
      throw fail(409, 'Reservation duration or prorating requires venue-rule review.');
    }
    rate = 0;
    discountCents = reservation.discountCents;
  } else {
    rate = money(session.hourlyRate);
    if (pricingVersion === 1 && rate <= 0) throw fail(409, 'Stored hourly rate is invalid.');
  }

  const overtimeRateCents = pricingVersion >= 1 ? money(session.overtimeRate) : rate;
  if (pricingVersion >= 1 && overtimeRateCents <= 0) throw fail(409, 'Stored overtime rate is invalid.');
  if (typeof session.customerName !== 'string' || !session.customerName.trim() || typeof session.isOpenTime !== 'boolean' || !Array.isArray(session.orders || [])) {
    throw fail(409, 'Stored session is invalid.');
  }

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
  const rawPastEndSecs = elapsedBilling ? 0 : Math.max(0, Math.floor((now - start - booked * 60000) / 1000));

  const overtimeTier = elapsedBilling
    ? { overtimeMins: 0, billedOvertimeHours: 0, overtimeCents: 0, isAutoExtendedOvertime: false, overtimeLabel: '' }
    : computeOvertimeTier(rawPastEndSecs, overtimeRateCents);

 const effectiveWaive = Boolean(waiveOvertime || session.overtimeWaived);
  const overtimeMins = effectiveWaive ? 0 : overtimeTier.overtimeMins;
  const billedOvertimeHours = effectiveWaive ? 0 : overtimeTier.billedOvertimeHours;
  const overtimeCents = effectiveWaive ? 0 : overtimeTier.overtimeCents;

  const billableMins = Math.max(60, elapsedMins);
  const tableCents = pricingVersion === 2
    ? reservation.grossCents
    : elapsedBilling
      ? Math.round(Math.ceil(billableMins / 30) * rate / 2)
      : Math.round(booked * rate / 60);

  const fnbCents = (session.orders || []).reduce((total, order) => {
    if (!order || typeof order.id !== 'string' || !Number.isSafeInteger(order.qty) || order.qty <= 0) {
      throw fail(409, 'Stored orders are invalid.');
    }
    return total + money(order.price) * order.qty;
  }, 0);

  const totalCents = tableCents - discountCents + overtimeCents + fnbCents;
  if (!Number.isSafeInteger(totalCents) || !Number.isSafeInteger(totalCents + discountCents)) {
    throw fail(409, 'Session amount is too large.');
  }

  return {
    discountCents,
    overtimeRateCents,
    pricingVersion,
    elapsedMins,
    overtimeMins,
    billedOvertimeHours,
    isAutoExtendedOvertime: overtimeTier.isAutoExtendedOvertime,
    overtimeLabel: effectiveWaive ? 'Overtime Waived (Admin)' : overtimeTier.overtimeLabel,
    overtimeWaived: Boolean(effectiveWaive && overtimeTier.overtimeCents > 0),
    tableCents,
    overtimeCents,
    fnbCents,
    totalCents,
    alreadyPaid,
    balanceCents: Math.max(0, totalCents - alreadyPaid),
    refundCents: Math.max(0, alreadyPaid - totalCents),
  };
}

export function previewSessionBill(session, nowMillis, useProrated = false, waiveOvertime = false) {
  const bill = calculateSessionBill(session, nowMillis, useProrated, waiveOvertime);
  return {
    elapsedMins: bill.elapsedMins,
    alreadyPaid: bill.alreadyPaid / 100,
    bookedCharge: bill.tableCents / 100,
    bookingDiscount: bill.discountCents / 100,
    overtimeCharge: bill.overtimeCents / 100,
    posOrdersTotal: bill.fnbCents / 100,
    totalDue: bill.totalCents / 100,
    balance: bill.balanceCents / 100,
    refundDue: bill.refundCents / 100,
    isOvertime: !bill.overtimeWaived && bill.overtimeMins > 0,
    overtimeMins: bill.overtimeMins,
    billedOvertimeHours: bill.billedOvertimeHours,
    isAutoExtendedOvertime: bill.isAutoExtendedOvertime,
    overtimeLabel: bill.overtimeLabel,
    overtimeWaived: bill.overtimeWaived,
    isOpenTime: session.isOpenTime,
    overtimeRate: bill.overtimeRateCents / 100,
  };
}

// The venue uses the Manila calendar day: Mon–Thu weekday, Fri–Sun weekend.
// Snapshot this selection once at admission; billing never re-reads the clock policy.
export function selectWalkInStartPricing(settings, startedAt) {
  if (!Number.isFinite(startedAt)) throw fail(409, 'Session start time is invalid.');
  const local = new Date(startedAt + 8 * 3600000);
  if (!Number.isFinite(local.getTime())) throw fail(409, 'Session start time is invalid.');
  const day = local.getUTCDay();
  const policyDay = [0, 5, 6].includes(day) ? 'weekend' : 'weekday';
  const numeric = value => typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  const validRate = value => Number.isFinite(value) && value > 0 && value <= 5000 && Number(value.toFixed(2)) === value;
  const base = numeric(settings?.hourlyRate), overtimeRate = numeric(settings?.overtimeRate);
  const activeValue = settings?.[policyDay === 'weekday' ? 'isWeekdayHappyHourActive' : 'isWeekendHappyHourActive'];
  const active = activeValue === true || activeValue === 'true' ? true : activeValue === false || activeValue === 'false' ? false : null;
  if (!validRate(base) || !validRate(overtimeRate) || active === null) {
    throw fail(409, 'Review the saved hourly, overtime and Happy Hour policy before starting play.');
  }
  let isHappyHour = false, hourlyRate = base;
  if (active) {
    const from = settings[policyDay + 'HappyHourStart'], to = settings[policyDay + 'HappyHourEnd'];
    const time = value => typeof value === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
    const happyRate = numeric(settings[policyDay + 'HappyHourRate']);
    if (!time(from) || !time(to) || from === to || !validRate(happyRate)) {
      throw fail(409, 'Review the active Happy Hour window and rate before starting play.');
    }
    const minute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const current = local.getUTCHours() * 60 + local.getUTCMinutes(), start = minute(from), end = minute(to);
    isHappyHour = start < end ? current >= start && current < end : current >= start || current < end;
    if (isHappyHour) hourlyRate = happyRate;
  }
  return { hourlyRate, overtimeRate, isHappyHour, policyDay };
}