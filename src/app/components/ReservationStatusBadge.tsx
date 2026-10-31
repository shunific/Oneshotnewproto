import React from 'react';

export interface ReservationStatusBadgeProps {
  status: string;
  className?: string;
  showDot?: boolean;
}

export function getReservationStatusConfig(status: string) {
  const s = (status || '').toLowerCase().trim();

  if (s === 'confirmed') {
    return {
      label: 'CONFIRMED',
      colorName: 'green',
      badgeClass: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      dotClass: 'bg-emerald-400',
      dotPulse: false
    };
  }

  if (s === 'pending') {
    return {
      label: 'PENDING',
      colorName: 'orange',
      badgeClass: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
      dotClass: 'bg-amber-400',
      dotPulse: true
    };
  }

  if (s === 'cancelled' || s === 'canceled') {
    return {
      label: 'CANCELLED',
      colorName: 'red',
      badgeClass: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
      dotClass: 'bg-rose-400',
      dotPulse: false
    };
  }

  if (s === 'pending-reschedule' || s === 'rescheduled') {
    return {
      label: 'PENDING RESCHEDULE',
      colorName: 'orange',
      badgeClass: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      dotClass: 'bg-amber-400',
      dotPulse: true
    };
  }

  if (s === 'pending-refund') {
    return {
      label: 'PENDING REFUND',
      colorName: 'red',
      badgeClass: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
      dotClass: 'bg-rose-400',
      dotPulse: true
    };
  }

  if (s === 'completed') {
    return {
      label: 'COMPLETED',
      colorName: 'blue',
      badgeClass: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
      dotClass: 'bg-sky-400',
      dotPulse: false
    };
  }

  if (s === 'checked-in' || s === 'seated') {
    return {
      label: 'CHECKED-IN',
      colorName: 'teal',
      badgeClass: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
      dotClass: 'bg-cyan-400',
      dotPulse: false
    };
  }

  if (s === 'no-show' || s === 'noshow') {
    return {
      label: 'NO-SHOW',
      colorName: 'red',
      badgeClass: 'bg-red-500/15 text-red-400 border-red-500/30',
      dotClass: 'bg-red-400',
      dotPulse: false
    };
  }

  // Fallback
  return {
    label: s.toUpperCase() || 'UNKNOWN',
    colorName: 'neutral',
    badgeClass: 'bg-neutral-800 text-neutral-300 border-neutral-700',
    dotClass: 'bg-neutral-400',
    dotPulse: false
  };
}

export const ReservationStatusBadge: React.FC<ReservationStatusBadgeProps> = ({
  status,
  className = '',
  showDot = true
}) => {
  const config = getReservationStatusConfig(status);

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border shadow-sm ${config.badgeClass} ${className}`}
    >
      {showDot && (
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${config.dotClass} ${
            config.dotPulse ? 'animate-pulse' : ''
          }`}
        />
      )}
      <span>{config.label}</span>
    </span>
  );
};
