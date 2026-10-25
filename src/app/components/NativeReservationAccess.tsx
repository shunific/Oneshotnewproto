import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import { localFetch } from '../utils/localApi';
import { pendingNativeCheckins, submitNativeCheckin, cancelNativeCheckin, reviewNativeCheckinRate, mappedNativeTable, validateNativeMappings, validateNativePending, validateNativeSyncAck } from '../utils/nativeReservationPersistence';

async function nativeRequest(path: string, body?: unknown) {
  const response = await localFetch(`http://localhost:3001${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || 'The original reservation operation remains unconfirmed.'), { status: response.status, code: value.code });
  return value;
}
type Props = { localStaffId: string; cloudUserId: string; reservations: any[]; onRefreshBookings: () => Promise<void>; onAccountError: (error: any) => void };
export function NativeReservationAccess(props: Props) {
  const { tables, rates, forceFullSync } = useAppContext();
  return <NativeReservationPanel {...props} tables={tables} overtimeRate={rates.overtimeRate} refreshFloor={forceFullSync} />;
}
export function NativeReservationPanel({ localStaffId, cloudUserId, reservations, onRefreshBookings, onAccountError, tables, overtimeRate, refreshFloor, request = nativeRequest, storage = window.localStorage }: Props & { tables: any[]; overtimeRate: number; refreshFloor: () => Promise<void>; request?: typeof nativeRequest; storage?: Storage }) {
  const [mappings, setMappings] = useState<any[]>([]), [events, setEvents] = useState<any[]>([]), [serverCheckins, setServerCheckins] = useState<any[]>([]), [drafts, setDrafts] = useState<any[]>([]);
  const [rateReview, setRateReview] = useState<any>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(''), [draftError, setDraftError] = useState(false), [recoveryReady, setRecoveryReady] = useState(false);
  const mounted = useRef(true), pending = useRef(false), owner = useRef(`${localStaffId}:${cloudUserId}`);
  owner.current = `${localStaffId}:${cloudUserId}`;
  const currentOwner = `${localStaffId}:${cloudUserId}`;
  const isCurrent = () => mounted.current && owner.current === currentOwner;
  const readDrafts = () => { try { setDrafts(pendingNativeCheckins(storage, localStaffId, cloudUserId)); setDraftError(false); } catch { setDraftError(true); setError('A saved check-in request needs review. Its original data has been preserved.'); } };
  const report = (failure: any) => { if (!isCurrent()) return; setError(failure.message || 'Refresh or retry the original reservation operation.'); if (failure.status === 401 || failure.status === 403) { setMappings([]); setEvents([]); setServerCheckins([]); setDrafts([]); onAccountError(failure); } };
  const refresh = async () => {
    const results = await Promise.allSettled([request('/api/native/reservation-table-mappings'), request('/api/native/reservation-sync')]);
    if (!isCurrent()) return;
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'rejected') { if (index === 0) setMappings([]); else setRecoveryReady(false); report(result.reason); if ([401,403].includes(result.reason?.status)) return; continue; }
      try { if (index === 0) setMappings(validateNativeMappings(result.value)); else { const value = validateNativePending(result.value, cloudUserId); setEvents(value.events); setServerCheckins(value.checkins); setRecoveryReady(true); } } catch (failure) { if (index === 0) setMappings([]); else setRecoveryReady(false); report(failure); }
    }
    readDrafts();
  };
  useEffect(() => { mounted.current = true; readDrafts(); void refresh(); return () => { mounted.current = false; }; }, [localStaffId, cloudUserId]);
  const refreshViews = async () => {
    if (!isCurrent()) return;
    const results = await Promise.allSettled([refreshFloor(), onRefreshBookings(), refresh()]);
    if (!isCurrent()) return;
    for (const result of results) if (result.status === 'rejected' && [401,403].includes(result.reason?.status)) { report(result.reason); return; }
    if (results.some(value => value.status === 'rejected')) setError('The operation was saved, but refreshed views could not all be loaded. Refresh again before changing the floor.');
  };
  const act = async (operation: () => Promise<void>) => {
    if (pending.current || !isCurrent()) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try { await operation(); } catch (failure) { report(failure); }
    finally { if (isCurrent()) { readDrafts(); setBusy(false); } pending.current = false; }
  };
  const finishAdmission = async (result: any, expectedRate: number) => {
    if (!isCurrent()) return;
    setRateReview(null);
    const storedRate = result.table.session.overtimeRate;
    const original = result.replayed && storedRate !== expectedRate ? `This check-in already started with its stored overtime rate of ₱${storedRate.toFixed(2)} per hour. ` : '';
    setMessage(original + (result.cloudAcknowledged ? 'Check-in acknowledged by cloud. Refreshing the saved floor and booking status.' : 'Local check-in saved. Cloud acknowledgement is pending; use Retry sync below.'));
    // An archived response may describe a table already reused by another guest.
    // Only the authoritative floor refresh may replace current table state.
    await refreshViews();
  };
  const checkin = (command: any) => act(async () => {
    const result = await submitNativeCheckin({ storage, localStaffId, cloudUserId, command, request, isCurrent });
    await finishAdmission(result, command.expectedOvertimeRate);
  });
  const readRateReview = async (command: any) => {
    const [rates, pendingData] = await Promise.all([request('/api/settings/rates'), request('/api/native/reservation-sync')]);
    if (!isCurrent()) return null;
    const savedRate = rates?.overtimeRate;
    if (typeof savedRate !== 'number' || !Number.isFinite(savedRate) || savedRate <= 0 || savedRate > 5000 || Number(savedRate.toFixed(2)) !== savedRate) throw new Error('The saved overtime rate is unavailable. Refresh store settings before reviewing this check-in.');
    const saved = validateNativePending(pendingData, cloudUserId);
    setServerCheckins(saved.checkins); setEvents(saved.events); setRecoveryReady(true);
    const original = saved.checkins.find(row => row.requestId === command.requestId);
    if (!original || !['id','tableId','expectedRevision','expectedStaffId'].every(key => original[key] === command[key]) || saved.events.some(event => event.eventType === 'admission' && event.reservationId === command.id)) {
      setRateReview(null);
      await refreshViews();
      throw new Error('This original check-in is no longer awaiting admission. Retry its saved request or pending sync to recover the stored result.');
    }
    return { command: { ...command }, rate: savedRate };
  };
  const reviewRate = (command: any) => act(async () => {
    const review = await readRateReview(command);
    if (!review || !isCurrent()) return;
    if (review.rate === command.expectedOvertimeRate) { setRateReview(null); setMessage('The current saved overtime rate matches this request. Retry the original check-in.'); return; }
    setRateReview(review);
  });
  const confirmRateReview = () => act(async () => {
    if (!rateReview) return;
    const latest = await readRateReview(rateReview.command);
    if (!latest || !isCurrent()) return;
    if (latest.rate !== rateReview.rate) {
      setRateReview(latest.rate === latest.command.expectedOvertimeRate ? null : latest);
      setError('The saved overtime rate changed during review. Review the latest rate before confirming again.');
      return;
    }
    setRateReview(null);
    const result = await reviewNativeCheckinRate({ storage, localStaffId, cloudUserId, command: latest.command, expectedOvertimeRate: latest.rate, request, isCurrent });
    await finishAdmission(result, latest.rate);
  });
  const cancel = (command: any) => act(async () => {
    const result = await cancelNativeCheckin({ storage, localStaffId, cloudUserId, command, request, isCurrent });
    if (!isCurrent()) return;
    setRateReview(null);
    setMessage(result.cancelled ? 'Original pending check-in cancelled. A new check-in may now be requested.' : 'The original cloud claim exists. Retry its check-in to continue.');
    await refreshViews();
  });
  const retrySync = (event: any) => act(async () => {
    validateNativeSyncAck(await request('/api/native/reservation-sync/retry', { eventType: event.eventType, eventId: event.eventId }), event);
    if (!isCurrent()) return;
    setMessage('Original session update acknowledged by cloud. Refreshing saved status.');
    await refreshViews();
  });
  const recovered = [...drafts, ...serverCheckins.filter(row => !drafts.some(draft => draft.requestId === row.requestId)).map(({ phase: _phase, ...command }) => ({ ...command, expectedOvertimeRate: overtimeRate }))];
  const confirmed = reservations.filter(row => row.status === 'confirmed');
  return <section aria-label="Online reservation check-in" className="space-y-3 rounded-xl border border-emerald-900/60 p-4 text-sm">
    <h4 className="font-semibold text-emerald-300">Online reservation check-in</h4>
    <p className="text-neutral-400">Start an approved booking on its mapped physical table. Booking credit comes from the cloud’s verified payment record. Refunds remain an outside-app action.</p>
    {message && <p role="status" className="text-emerald-300">{message}</p>}
    {error && <p role="alert" className="text-amber-300">{error}</p>}
    {!recoveryReady && <p className="text-amber-300">Load current check-in recovery before starting another booking. Existing original requests can still be retried.</p>}
    <button disabled={busy} onClick={() => act(refresh)} className="underline">Refresh check-in and sync recovery</button>
    {recovered.map(command => <article key={command.requestId} className="space-y-2 rounded border border-amber-800 p-3">
      <p>Pending check-in · Booking {command.id} · Table {command.tableId}</p>
      <p className="text-neutral-400">Saved overtime expectation: ₱{command.expectedOvertimeRate.toFixed(2)} per hour. Review current settings if this rate has changed.</p>
      <button disabled={busy || draftError} onClick={() => checkin(command)} className="mr-4 underline">Retry original check-in</button>
      {serverCheckins.some(row => row.requestId === command.requestId) && !events.some(event => event.eventType === 'admission' && event.reservationId === command.id) && <button disabled={busy || draftError || !recoveryReady} onClick={() => reviewRate(command)} className="mr-4 underline">Review current overtime rate</button>}
      <button disabled={busy || draftError} onClick={() => cancel(command)} className="underline">Cancel pending check-in</button>
      <p className="text-xs text-neutral-500">Cancellation releases this request only after the cloud confirms it was never claimed. Existing claims are recovered.</p>
    </article>)}
    {rateReview && <section role="dialog" aria-label="Review check-in overtime rate" className="space-y-3 rounded border border-amber-600 p-4">
      <h5 className="font-semibold">Review overtime before admission</h5>
      <p>Previous expectation: ₱{rateReview.command.expectedOvertimeRate.toFixed(2)} per hour. Current saved rate: ₱{rateReview.rate.toFixed(2)} per hour.</p>
      <p className="text-neutral-400">Use the current saved rate for this original check-in if play has not started. An already-started session keeps its stored rate. The booking quote and verified deposit stay unchanged.</p>
      <button disabled={busy} onClick={confirmRateReview} className="mr-4 rounded bg-amber-700 px-3 py-2">Use reviewed rate and retry</button>
      <button disabled={busy} onClick={() => setRateReview(null)} className="underline">Keep original request</button>
    </section>}
    {events.map(event => <article key={event.eventId} className="flex flex-wrap items-center gap-3 rounded border border-amber-800 p-3">
      <span>{event.eventType === 'admission' ? 'Check-in' : event.eventType === 'reservation-completion' ? 'Checkout' : 'Table transfer'} sync pending · Booking {event.reservationId}</span>
      <button disabled={busy} onClick={() => retrySync(event)} className="underline">Retry sync</button>
    </article>)}
    {confirmed.map(booking => {
      const table = mappedNativeTable(booking, mappings, tables), original = recovered.some(command => command.id === booking.id);
      return <article key={booking.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-neutral-800 p-3">
        <div><p>{booking.customerName} · {booking.date} {booking.timeSlot}</p><p className="text-neutral-400">{table ? `Physical table: ${table.name || table.id}` : 'Mapped physical table is unavailable, occupied, or needs an approved mapping.'}</p></div>
        <button disabled={busy || draftError || !recoveryReady || original || !table || !Number.isFinite(overtimeRate) || overtimeRate <= 0} onClick={() => { if (table) void checkin({ requestId: crypto.randomUUID(), id: booking.id, tableId: table.id, expectedRevision: booking.revision, expectedStaffId: cloudUserId, expectedOvertimeRate: overtimeRate }); }} className="rounded bg-emerald-700 px-3 py-2 disabled:opacity-40">Check in booking</button>
      </article>;
    })}
    {!confirmed.length && <p className="text-neutral-500">Refresh online bookings to review approved reservations ready for check-in.</p>}
  </section>;
}
