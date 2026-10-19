import { validateNativeSyncAck } from './nativeReservationPersistence.js';

// Settlement is already committed. A transport failure leaves its original
// durable outbox event available through Cloud staff's recovery controls.
export async function syncCheckoutCompletion(saved, { request, isCurrent }) {
  if (!saved.reservationCompletion) return null;
  const pending = { cloudAcknowledged: false };
  if (!isCurrent()) return pending;
  const event = {
    eventType: 'reservation-completion', eventId: saved.reservationCompletion.eventId,
    claimId: saved.receipt?.reservation_claim_id, reservationId: saved.receipt?.reservation_id,
  };
  if (![event.eventId, event.claimId, saved.receipt?.id].every(value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) || !event.reservationId) return pending;
  try {
    const result = await request('/api/native/reservation-sync/retry', { eventType: event.eventType, eventId: event.eventId });
    if (!isCurrent()) return pending;
    validateNativeSyncAck(result, event);
    if (result.ack.state !== 'completed' || result.ack.receiptId !== saved.receipt.id) return pending;
    return { cloudAcknowledged: true };
  } catch { return pending; }
}
