import { useRef, useState } from 'react';
import { RefreshCw, Undo2, X } from 'lucide-react';
import { bookingDayKey } from '../utils/bookingSchedule.js';
import { clockLabel } from '../utils/clockDisplay';

export type RefundBooking = { id: string; email?: string; date: string | Date; timeSlot: string };

function showDialog(element: HTMLDialogElement | null) {
  if (element && !element.open) element.showModal();
}

export function RefundRequestDialog({ booking, phone, onClose, onSubmit }: {
  booking: RefundBooking;
  phone?: string;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const day = bookingDayKey(booking.date);
  const [hour, minute] = (booking.timeSlot || '').split(':');
  const start = new Date(`${day}T${hour.padStart(2, '0')}:${minute}:00+08:00`);
  const minutesUntil = (start.getTime() - Date.now()) / 60000;
  const hotline = phone?.split('|')[0].trim();

  const submit = async () => {
    if (pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError('');
    try {
      await onSubmit();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to submit your request. Please try again.');
      setSubmitting(false);
      pending.current = false;
    }
  };

  return (
    <dialog ref={showDialog} aria-labelledby="refund-title" aria-describedby="refund-summary"
      onCancel={event => { event.preventDefault(); if (!pending.current) onClose(); }}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-sm space-y-4 overflow-y-auto rounded-3xl border border-neutral-800 bg-neutral-950 p-6 text-neutral-100 shadow-2xl backdrop:bg-black/80 backdrop:backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="refund-title" className="flex items-center gap-2 text-lg font-black text-violet-400"><Undo2 size={18} />Request Refund</h3>
          <p className="mt-1 text-xs text-neutral-500">Reservation #{booking.id.toUpperCase()}</p>
        </div>
        <button type="button" aria-label="Close refund request" disabled={submitting} onClick={onClose} className="text-neutral-500 hover:text-neutral-100"><X size={18} /></button>
      </div>
      <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/50 p-3">
        <p className="text-sm font-semibold">{Number.isFinite(start.getTime()) ? start.toLocaleDateString('en-US', { timeZone: 'Asia/Manila', dateStyle: 'long' }) : day} · {clockLabel(booking.timeSlot)}</p>
        <p id="refund-summary" className="text-xs leading-relaxed text-neutral-400">Request cancellation of this booking and a refund of your down payment. Your booking will show Pending Refund until staff review it.</p>
        {minutesUntil < 60 && <p className="text-xs text-amber-500">{minutesUntil > 0 ? 'Your booking starts in less than one hour.' : 'The scheduled start time has passed.'} Staff will review refund eligibility.</p>}
      </div>
      <p className="text-xs leading-relaxed text-neutral-400">For GCash refund questions, contact {hotline || 'the venue'} with your reservation number.</p>
      {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
      <div className="flex gap-2 pt-2">
        <button type="button" disabled={submitting} onClick={onClose} className="flex-1 rounded-xl border border-neutral-800 bg-neutral-900 py-3 text-xs font-bold text-neutral-300 hover:bg-neutral-800">Keep booking</button>
        <button type="button" disabled={submitting} onClick={submit} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-violet-600 py-3 text-xs font-bold text-white hover:bg-violet-500 disabled:opacity-60">
          {submitting && <RefreshCw size={14} className="animate-spin" />}{submitting ? 'Submitting…' : 'Submit Request'}
        </button>
      </div>
    </dialog>
  );
}
