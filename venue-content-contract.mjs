export const venueCanonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
export const venueExact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export const venueFields={
  closure:['date','type','dayOfWeek','reason','isFullDay','openTime','closeTime'],
  event:['title','date','type','description','duration','registrationLink','bracketLink','minParticipants','maxParticipants','slotsFull','attachments','allowReservations','reservationTableCount','caterWalkIns','walkInTableCount','walkInTableIds','reservationTableIds','eventTableIds','isCancelled','cancelReason']
};

export function normalizeVenuePayload(kind, input) {
  if (!input || typeof input !== 'object') return {};
  if (kind === 'closure') {
    return {
      date: typeof input.date === 'string' ? input.date : '',
      type: input.type === 'weekly' ? 'weekly' : 'specific',
      dayOfWeek: input.dayOfWeek !== undefined && input.dayOfWeek !== null ? Number(input.dayOfWeek) : null,
      reason: String(input.reason || '').trim() || 'Scheduled Closure',
      isFullDay: input.isFullDay !== false,
      openTime: input.isFullDay ? null : (input.openTime || '12:00'),
      closeTime: input.isFullDay ? null : (input.closeTime || '02:00')
    };
  }
  const dates = typeof input.date === 'string' ? input.date : Array.isArray(input.date) ? input.date.join(',') : '';
  return {
    title: String(input.title || '').trim() || 'Untitled Event',
    date: dates,
    type: String(input.type || 'Event').trim(),
    description: String(input.description || '').trim(),
    duration: input.duration || (input.isWholeDay ? 'Whole Day' : `${input.startTime || '12:00'} - ${input.endTime || '00:00'}`),
    registrationLink: input.registrationLink || null,
    bracketLink: input.bracketLink || null,
    minParticipants: input.minParticipants ? Number(input.minParticipants) : null,
    maxParticipants: input.maxParticipants ? Number(input.maxParticipants) : null,
    slotsFull: Boolean(input.slotsFull),
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    allowReservations: Boolean(input.allowReservations),
    reservationTableCount: input.reservationTableCount ? Number(input.reservationTableCount) : null,
    caterWalkIns: Boolean(input.caterWalkIns),
    walkInTableCount: input.walkInTableCount ? Number(input.walkInTableCount) : null,
    walkInTableIds: Array.isArray(input.walkInTableIds) ? input.walkInTableIds : [],
    reservationTableIds: Array.isArray(input.reservationTableIds) ? input.reservationTableIds : [],
    eventTableIds: Array.isArray(input.eventTableIds) ? input.eventTableIds : (Array.isArray(input.selectedTableIds) ? input.selectedTableIds : []),
    isCancelled: Boolean(input.isCancelled),
    cancelReason: input.cancelReason || null
  };
}

export const venueRecordId=(kind,requestId)=>`${kind==='closure'?'cd':'ev'}_${requestId}`;

export function validateVenueCommand(kind, c) {
  const reqId = c?.requestId || crypto.randomUUID();
  const actor = c?.expectedActorId || 'admin_001';
  return {
    requestId: reqId,
    expectedActorId: actor,
    payload: normalizeVenuePayload(kind, c?.payload || {})
  };
}

export function validateVenueRecord(kind, r) {
  const id = String(r?.id || venueRecordId(kind, crypto.randomUUID()));
  return {
    id,
    ...normalizeVenuePayload(kind, r || {}),
    ...(kind === 'event' ? { createdAt: r?.createdAt || new Date().toISOString() } : {})
  };
}

export function validateVenueAck(kind, c, result) {
  const rec = result?.record || result || c?.payload || {};
  return validateVenueRecord(kind, rec);
}

export function isVenueReconciliation(kind, c, status, r) {
  return status === 409 && r?.code === 'VENUE_CREATE_RECONCILE';
}
