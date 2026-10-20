import { useEffect, useRef, useState } from 'react';
import { loadCustomerFinalReceipt } from '../utils/customerFinalReceipts';
import { formatPesos } from '../utils/bookingPaymentSummary';

export function FinalReceiptDetails({ receipt }: { receipt: any }) {
  const money = (value: number) => formatPesos(value / 100);
  return <section aria-label="Final itemized receipt" className="mt-3 rounded-xl border border-neutral-700 bg-neutral-950 p-4 text-xs text-neutral-300 space-y-2">
    <h4 className="font-bold text-white">Final itemized receipt</h4>
    <p className="break-all font-mono">{receipt.receiptNumber}</p>
    <p>{receipt.tableName} · {receipt.durationMinutes} minutes</p>
    <p>{new Date(receipt.startTime).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} – {new Date(receipt.endTime).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT</p>
    <dl className="space-y-1">
      <div className="flex justify-between gap-4"><dt>Booked table charge</dt><dd>{money(receipt.bookedGrossCents)}</dd></div>
      <div className="flex justify-between gap-4"><dt>Booking discount</dt><dd>−{money(receipt.bookingDiscountCents)}</dd></div>
      <div className="flex justify-between gap-4"><dt>Overtime</dt><dd>{money(receipt.overtimeCents)}</dd></div>
      {receipt.orders.map((item: any, index: number) => <div key={`${item.id}-${index}`} className="flex justify-between gap-4"><dt>{item.name} × {item.quantity} @ {money(item.unitCents)}</dt><dd>{money(item.totalCents)}</dd></div>)}
      <div className="flex justify-between gap-4"><dt>Food and drink total</dt><dd>{money(receipt.foodAndDrinkCents)}</dd></div>
      {receipt.voided && <div className="flex justify-between gap-4"><dt>Void waiver</dt><dd>−{money(receipt.waiverCents)}</dd></div>}
      <div className="flex justify-between gap-4 font-bold text-white border-t border-neutral-700 pt-2"><dt>Final bill</dt><dd>{money(receipt.totalCents)}</dd></div>
      <div className="flex justify-between gap-4"><dt>Verified booking credit</dt><dd>{money(receipt.originalVerifiedCreditCents)}</dd></div>
      <div className="flex justify-between gap-4"><dt>Collected at checkout</dt><dd>{money(receipt.collectedAtCheckoutCents)}</dd></div>
      <div className="flex justify-between gap-4"><dt>Amount applied to bill</dt><dd>{money(receipt.allocatedPaidCents)}</dd></div>
      <div className="flex justify-between gap-4"><dt>Remaining at checkout</dt><dd>{money(receipt.remainingCents)}</dd></div>
      {receipt.refundDueCents > 0 && <div className="flex justify-between gap-4 text-amber-300"><dt>Refund due at checkout</dt><dd>{money(receipt.refundDueCents)}</dd></div>}
    </dl>
    {receipt.voided && <p>Voided: {receipt.voidReason}</p>}
    <p className="text-neutral-500">Cloud accepted {new Date(receipt.acceptedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT. This saved receipt records checkout; viewing it does not transfer funds.</p>
    {receipt.refundDueCents > 0 && <p className="text-amber-300">Refund return was pending at checkout. Contact the venue for its current return status.</p>}
  </section>;
}

export function CustomerFinalReceipt({ client, booking, ownerId }: { client: any; booking: any; ownerId: string | null }) {
  const ownsBooking = !!ownerId && booking?.customer_user_id === ownerId;
  const key = ownsBooking ? `${ownerId}:${booking.id}` : null;
  const identity = useRef<string | null>(key); identity.current = key;
  const generation = useRef(0);
  const [state, setState] = useState<{ key: string | null; status: string; receipt: any; error: string }>({ key: null, status: 'idle', receipt: null, error: '' });
  useEffect(() => {
    generation.current++;
    setState({ key: null, status: 'idle', receipt: null, error: '' });
    const { data } = client.auth.onAuthStateChange((event: string, session: any) => {
      if (session?.user?.id === ownerId && session.user.email_confirmed_at && !session.user.is_anonymous && !['SIGNED_OUT', 'SIGNED_IN'].includes(event)) return;
      generation.current++;
      setState({ key: null, status: 'idle', receipt: null, error: '' });
    });
    return () => { generation.current++; data?.subscription?.unsubscribe(); };
  }, [client, ownerId, booking.id]);
  if (!ownsBooking) return null;
  const visible = state.key === key ? state : { status: 'idle', receipt: null, error: '' };
  const load = async () => {
    const attempt = ++generation.current;
    const isCurrent = () => identity.current === key && generation.current === attempt;
    setState({ key, status: 'loading', receipt: null, error: '' });
    try {
      const receipt = await loadCustomerFinalReceipt(client, { ownerId, reservationId: booking.id, date: booking.date, isCurrent });
      if (isCurrent()) setState({ key, status: receipt ? 'loaded' : 'pending', receipt, error: '' });
    } catch (error) {
      if (isCurrent()) setState({ key, status: 'error', receipt: null, error: error instanceof Error ? error.message : 'Final receipt is unavailable. Please retry.' });
    }
  };
  return <div className="w-full">
    <button type="button" onClick={load} disabled={visible.status === 'loading'} className="px-4 py-2 rounded-xl border border-emerald-900 text-emerald-300 text-xs font-bold disabled:opacity-50">
      {visible.status === 'loading' ? 'Loading final receipt…' : visible.status === 'loaded' ? 'Refresh Final Receipt' : 'View Final Receipt'}
    </button>
    {visible.status === 'pending' && <p role="status" className="mt-2 text-xs text-neutral-400">Final receipt pending. It becomes available after the venue checks out your session and synchronizes the completed receipt.</p>}
    {visible.status === 'error' && <p role="alert" className="mt-2 text-xs text-amber-300">{visible.error}</p>}
    {visible.receipt && <FinalReceiptDetails receipt={visible.receipt} />}
  </div>;
}
