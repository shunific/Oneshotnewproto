import { completedReservationStats } from '../utils/waitHistory';
import { localFetch } from '../utils/localApi';
import { useState, useEffect, useCallback, useMemo } from 'react';
import logoImg from '../../assets/40eb82831843e17a3c48a360fd80f0aaaa58ddc8.png';
import { useAppContext } from '../context/AppContext';
import { Table, QueueItem } from '../context/AppContext';
import { Clock, Users, Sparkles, Cpu, RefreshCw } from 'lucide-react';
import { addMinutes, differenceInMinutes } from 'date-fns';
import { EXTENSION_DECISION_MINUTES } from '../../../session-billing.mjs';

// ── Helpers ────────────────────────────────────────────────────
function getSessionTimer(table: Table, nowMs: number): {
  mm: string;
  ss: string;
  isOvertime: boolean;
  isGrace: boolean;
  percentLeft: number;
  label: string;
  overtimeTierLabel: string;
  isOpenTime: boolean;
} {
  if (!table.session || !table.session.startTime) {
    return {
      mm: '--',
      ss: '--',
      isOvertime: false,
      isGrace: false,
      percentLeft: 0,
      label: '',
      overtimeTierLabel: '',
      isOpenTime: false,
    };
  }

  const start = new Date(table.session.startTime).getTime();
  const elapsed = Math.max(0, nowMs - start);

  // Handle "Open Time" (Pay-as-you-go, counting UP)
  if (table.session.durationMinutes === null || table.session.isOpenTime) {
    const hh = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
    const mm = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
    const ss = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');

    return {
      mm: hh !== '00' ? hh : mm, // Show hours if over 60 mins, otherwise minutes
      ss: hh !== '00' ? mm : ss, // Show minutes if over 60 mins, otherwise seconds
      isOvertime: false,
      isGrace: false,
      percentLeft: 100,
      label: 'Elapsed Time',
      overtimeTierLabel: '',
      isOpenTime: true,
    };
  }

  // Handle "Fixed Duration" (Counting DOWN)
  const totalMs = table.session.durationMinutes * 60000;
  const remaining = totalMs - elapsed;
  const decisionMs = EXTENSION_DECISION_MINUTES * 60000;
  const isOvertime = remaining <= -decisionMs;
  const isGrace = remaining <= 0 && !isOvertime;

  // During the 2-minute Last Play buffer, count down time left to extend; afterwards count overtime.
  const shownMs = isGrace
    ? Math.max(0, decisionMs + remaining)
    : isOvertime
      ? Math.abs(remaining) - decisionMs
      : remaining;

  const mm = String(Math.floor(shownMs / 60000)).padStart(2, '0');
  const ss = String(Math.floor((shownMs % 60000) / 1000)).padStart(2, '0');
  const percentLeft = Math.max(0, Math.min(100, (remaining / totalMs) * 100));
  const label = isGrace
    ? `${mm}:${ss} Last Play`
    : isOvertime
      ? `+${mm}:${ss} Overtime`
      : `${mm}:${ss} remaining`;

  // Match the half-hour (<30m) vs full-hour (30m+) overtime conversion tier
  let overtimeTierLabel = '';
  if (isOvertime) {
    const rawPastEndMins = Math.ceil(Math.abs(remaining) / 60000);
    const fullCompletedHours = Math.floor((rawPastEndMins - 1) / 60);
    const minInHour = ((rawPastEndMins - 1) % 60) + 1;
    const billedHours = fullCompletedHours + (minInHour >= 30 ? 1 : 0.5);
    overtimeTierLabel = billedHours === 0.5 ? 'Half-Hour Overtime' : `${billedHours}h Overtime Ext.`;
  }

  return { mm, ss, isOvertime, isGrace, percentLeft, label, overtimeTierLabel, isOpenTime: false };
}

function formatWaitLabel(mins: number): string {
  const rounded = Math.round(mins);
  if (rounded <= 0) return 'Available Now';
  if (rounded < 60) return `~${rounded} mins`;
  const hrs = Math.floor(rounded / 60);
  const rem = rounded % 60;
  return rem > 0 ? `~${hrs}h ${rem}m` : `~${hrs}h`;
}

// ── Single Table Card ──────────────────────────────────────────
function TableCard({
  table,
  held,
  availabilityVerified,
  nowMs,
}: {
  table: Table;
  held: boolean;
  availabilityVerified: boolean;
  nowMs: number;
}) {
  const timer = getSessionTimer(table, nowMs);
  const badge =
    table.name.match(/\d+/)?.[0].slice(0, 3) ||
    table.name
      .trim()
      .split(/\s+/)
      .map(word => word[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();

  if (held || (table.status === 'available' && !availabilityVerified)) {
    return (
      <div className="rounded-2xl border-2 border-amber-800 bg-amber-950/30 p-5 text-center text-amber-300">
        <p className="break-words text-sm font-semibold">{table.name}</p>
        <p className="mt-3 font-bold">{held ? 'TRANSFER HELD' : 'CHECK AVAILABILITY'}</p>
        <p className="mt-2 text-xs">Resolve transfer recovery in Table Monitor.</p>
        {table.session && <p className="mt-3 text-sm">{timer.label}</p>}
      </div>
    );
  }

  if (table.status === 'maintenance') {
    return (
      <div className="bg-orange-950/40 border-2 border-orange-800/40 rounded-2xl p-5 flex flex-col items-center gap-3 opacity-60">
        <div className="w-10 h-10 rounded-xl bg-orange-600/20 border border-orange-600/30 flex items-center justify-center">
          <span className="text-orange-500 font-black text-lg">{badge}</span>
        </div>
        <div className="text-center">
          <p className="text-xs text-neutral-400 font-semibold uppercase tracking-wider">{table.name}</p>
          <div className="flex items-center justify-center gap-1.5 mt-2">
            <span className="w-2 h-2 rounded-full bg-orange-500" />
            <span className="text-orange-500 font-black text-lg">MAINTENANCE</span>
          </div>
          <p className="text-[11px] text-orange-600 mt-1">{table.maintenanceReason || 'Unavailable'}</p>
        </div>
      </div>
    );
  }

  if (table.status === 'available') {
    return (
      <div className="relative bg-emerald-950/20 border-2 border-emerald-800/30 rounded-2xl p-5 flex flex-col items-center gap-3 overflow-hidden">
        <div className="w-10 h-10 rounded-xl bg-emerald-600/20 border border-emerald-600/30 flex items-center justify-center">
          <span className="text-emerald-500 font-black text-lg">{badge}</span>
        </div>
        <div className="text-center">
          <p className="text-xs text-neutral-400 font-semibold uppercase tracking-wider">{table.name}</p>
          <div className="flex items-center justify-center gap-1.5 mt-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
            <span className="text-emerald-500 font-black text-lg">OPEN</span>
          </div>
          <p className="text-[11px] text-emerald-600 mt-1">Walk-in Welcome</p>
        </div>
      </div>
    );
  }

  if (table.status === 'reserved') {
    return (
      <div className="bg-sky-950/40 border-2 border-sky-800/40 rounded-2xl p-5 flex flex-col items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-sky-600/20 border border-sky-600/30 flex items-center justify-center">
          <span className="text-sky-400 font-black text-lg">{badge}</span>
        </div>
        <div className="text-center">
          <p className="text-xs text-neutral-400 font-semibold uppercase tracking-wider">{table.name}</p>
          <div className="flex items-center justify-center gap-1.5 mt-2">
            <span className="w-2 h-2 rounded-full bg-sky-500" />
            <span className="text-sky-400 font-black text-lg">RESERVED</span>
          </div>
          <p className="text-[11px] text-sky-600 mt-1">Pre-booked</p>
        </div>
      </div>
    );
  }

  // Occupied Status (In Use, Last Play Buffer, Open Time, Overtime)
  const isOvertime = timer.isOvertime;
  const isGrace = timer.isGrace;
  const isOpenTime = timer.isOpenTime;

  const colorClass = isOvertime
    ? 'bg-rose-500/20 border-rose-500 text-rose-400 animate-pulse'
    : isGrace
      ? 'bg-amber-500/15 border-amber-500 text-amber-400 animate-pulse'
      : isOpenTime
        ? 'bg-blue-950/40 border-blue-800/40 text-blue-400'
        : 'bg-amber-950/40 border-amber-800/40 text-amber-400';

  const badgeClass = isOvertime
    ? 'bg-rose-500/20 text-rose-400 border-rose-500/30'
    : isGrace
      ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
      : isOpenTime
        ? 'bg-blue-500/20 text-blue-400 border-blue-500/30'
        : 'bg-amber-500/20 text-amber-400 border-amber-500/30';

  const barClass = isOvertime
    ? 'bg-rose-500/40'
    : isGrace
      ? 'bg-amber-500/50'
      : isOpenTime
        ? 'bg-blue-400/50'
        : timer.percentLeft < 15
          ? 'bg-rose-500'
          : timer.percentLeft < 30
            ? 'bg-amber-500'
            : 'bg-emerald-500';

  return (
    <div className={`relative border-2 rounded-2xl p-5 flex flex-col gap-3 overflow-hidden ${colorClass}`}>
      <div className="flex items-start justify-between">
        <div className="w-9 h-9 rounded-xl bg-black/20 border border-white/10 flex items-center justify-center flex-shrink-0">
          <span className="font-black text-white">{badge}</span>
        </div>
        <div className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${badgeClass}`}>
          {isOvertime ? '⚠ OVERTIME' : isGrace ? 'LAST PLAY' : isOpenTime ? 'OPEN TIME' : 'IN USE'}
        </div>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-wider font-semibold opacity-70">{table.name}</p>
        <p className="font-bold text-sm mt-0.5 truncate text-white">{table.session?.customerName || '—'}</p>
      </div>

      <div className="text-center">
        <p className="text-[10px] uppercase tracking-wider mb-1 opacity-80">
          {isOpenTime
            ? 'Time Elapsed'
            : isGrace
              ? `Extend within ${EXTENSION_DECISION_MINUTES}m`
              : isOvertime
                ? timer.overtimeTierLabel || 'Overtime'
                : 'Time Left'}
        </p>
        <div className="font-black text-4xl tabular-nums tracking-tight text-white">
          {isOvertime ? `+${timer.mm}:${timer.ss}` : `${timer.mm}:${timer.ss}`}
        </div>

        <div className="mt-2 h-1.5 bg-black/40 rounded-full overflow-hidden relative">
          {!isOvertime && !isGrace && !isOpenTime && (
            <div className={`h-full rounded-full transition-all duration-1000 ${barClass}`} style={{ width: `${timer.percentLeft}%` }} />
          )}
          {(isOvertime || isGrace) && <div className={`h-full w-full ${barClass}`} />}
          {isOpenTime && (
            <div className="h-full w-full bg-blue-900/50 overflow-hidden relative">
              <div className={`absolute inset-0 w-1/2 ${barClass} animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] skew-x-12`} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Queue Row ──────────────────────────────────────────────────
function QueueRow({
  item,
  position,
  estWait,
  isNextUp,
}: {
  item: QueueItem;
  position: number;
  estWait: string;
  isNextUp: boolean;
}) {
  const isAvailableNow = estWait === 'Available Now';

  return (
    <div
      className={`flex items-center gap-3.5 px-4 py-3 rounded-xl border transition-all ${
        item.status === 'called'
          ? 'bg-emerald-950/40 border-emerald-700/40'
          : isNextUp
            ? 'bg-emerald-950/20 border-emerald-700/40'
            : 'bg-neutral-900/60 border-neutral-800/60'
      }`}
    >
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 font-black text-sm ${
          item.status === 'called' || isNextUp
            ? 'bg-emerald-600 text-white'
            : 'bg-neutral-800 border border-neutral-700 text-neutral-400'
        }`}
      >
        {position}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className={`font-bold text-sm truncate ${item.status === 'called' ? 'text-emerald-300' : 'text-white'}`}>
            {item.customerName}
          </p>
          {isNextUp && item.status !== 'called' && (
            <span className="px-1.5 py-0.5 bg-emerald-600/20 text-emerald-400 text-[9px] font-bold rounded uppercase tracking-wider flex-shrink-0">
              Next
            </span>
          )}
        </div>
        <p className="text-[11px] text-neutral-500">
          {item.partySize} person{item.partySize > 1 ? 's' : ''}
        </p>
      </div>
      {item.status === 'called' ? (
        <div className="flex items-center gap-1.5 bg-emerald-600/20 border border-emerald-600/30 px-2.5 py-1 rounded-full flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs text-emerald-400 font-semibold">Proceed to counter</span>
        </div>
      ) : (
        <div className="text-right flex-shrink-0 flex flex-col items-end">
          <div
            className={`flex items-center gap-1 font-bold text-xs px-2 py-0.5 rounded-md border ${
              isAvailableNow
                ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                : 'bg-amber-500/10 text-amber-400 border-amber-500/25'
            }`}
          >
            <Clock size={10} />
            <span>{estWait}</span>
          </div>
          <p className="text-[9px] text-neutral-600 uppercase tracking-wider font-semibold mt-0.5">AI Estimate</p>
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────
export function LiveMonitor() {
  const {
    tables = [],
    availableTables = [],
    heldTableIds,
    reservationMoveError,
    queue = [],
    reservations = [],
    refreshLiveMonitor,
    rates,
  } = useAppContext();

  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(new Date());

  const safeHeldIds = useMemo(
    () => (heldTableIds instanceof Set ? heldTableIds : new Set<string>()),
    [heldTableIds]
  );

  // Live 1-second clock for table timers
  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(clock);
  }, []);

  // Auto-sync live floor every 5 seconds so separate display screens stay up to date
  useEffect(() => {
    const poll = setInterval(() => {
      void refreshLiveMonitor();
    }, 5000);
    return () => clearInterval(poll);
  }, [refreshLiveMonitor]);

  const refreshFloor = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshLiveMonitor();
    } finally {
      setRefreshing(false);
    }
  };

  const calledQueue = useMemo(() => queue.filter(q => q.status === 'called'), [queue]);
  const waitingOnly = useMemo(() => queue.filter(q => q.status === 'waiting'), [queue]);
  const displayQueue = useMemo(() => [...calledQueue, ...waitingOnly], [calledQueue, waitingOnly]);

  // ========================================================================
  // 🧠 NEURAL NETWORK AI WAIT-TIME ESTIMATION (Matches Queue.tsx & Web)
  // ========================================================================
  const [aiSessionMinutes, setAiSessionMinutes] = useState<number>(45);
  const [isAILoading, setIsAILoading] = useState(true);

  const fetchAIPrediction = useCallback(
    async (signal: AbortSignal) => {
      if (reservationMoveError || safeHeldIds.size > 0) {
        setIsAILoading(false);
        return;
      }
      setIsAILoading(true);
      try {
        const activeTables = tables.filter(t => t.isActive && t.status === 'occupied' && t.session);
        const currentOccupancyRate = activeTables.length / Math.max(1, tables.length);
        const nextPartySize = waitingOnly[0]?.partySize || 2;

        const res = await localFetch('http://localhost:3001/api/ai/predict-wait-time', {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            partySize: nextPartySize,
            hasOrders: true,
            completedReservations: completedReservationStats(reservations),
            currentOccupancyRate,
          }),
        });

        const data = await res.json();
        if (signal.aborted) return;

        const predicted = Number(data?.estimatedMinutes);
        setAiSessionMinutes(Number.isFinite(predicted) && predicted >= 15 ? predicted : 45);
      } catch {
        if (signal.aborted) return;
        const stats = completedReservationStats(reservations);
        setAiSessionMinutes(stats?.typicalBookedMinutes || 45);
      }
      setIsAILoading(false);
    },
    [tables, safeHeldIds, reservationMoveError, reservations, waitingOnly]
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchAIPrediction(controller.signal);
    return () => controller.abort();
  }, [fetchAIPrediction]);

  // Compute next-person wait time + individual wait estimate for every waiting customer
  const { nextPersonWait, perPersonWaitMap } = useMemo(() => {
    const waitMap = new Map<string, string>();

    if (reservationMoveError || safeHeldIds.size > 0) {
      waitingOnly.forEach(item => waitMap.set(item.id, 'Check transfer recovery'));
      return { nextPersonWait: 'Check transfer recovery', perPersonWaitMap: waitMap };
    }

    // 1. Collect when each playable table becomes free (in minutes from now)
    const tableFreeAt: number[] = [];

    for (let i = 0; i < availableTables.length; i++) {
      tableFreeAt.push(0); // Free right now
    }

    const activeTables = tables.filter(
      t => t.isActive && t.status === 'occupied' && t.session && !safeHeldIds.has(t.id)
    );

    activeTables.forEach(t => {
      const start = new Date(t.session!.startTime);
      const isOpen = Boolean(t.session!.isOpenTime || !t.session!.durationMinutes);
      const elapsed = Math.max(0, differenceInMinutes(now, start));

      if (!isOpen) {
        const end = addMinutes(start, Number(t.session!.durationMinutes));
        const remaining = differenceInMinutes(end, now);
        if (remaining > 0) {
          tableFreeAt.push(remaining + 2); // +2 mins table cleanup
          return;
        }
      }

      // Open time or overtime: use Brain.js predicted session length minus elapsed time
      const aiRemaining = Math.max(15, aiSessionMinutes - elapsed);
      tableFreeAt.push(aiRemaining + 2);
    });

    if (tableFreeAt.length === 0) {
      waitingOnly.forEach(item => waitMap.set(item.id, 'No tables open'));
      return { nextPersonWait: 'No tables open', perPersonWaitMap: waitMap };
    }

    const sessionTurnaround = Math.max(15, aiSessionMinutes) + 2;

    // 2. Checked-in priority reservations claim the earliest open tables first
    const priorityCheckedIn = reservations.filter(r => r.status === 'checked-in');
    priorityCheckedIn.forEach(r => {
      tableFreeAt.sort((a, b) => a - b);
      const earliest = tableFreeAt[0];
      const resDurationMins = (Number(r.durationHours) || 1) * 60;
      tableFreeAt[0] = earliest + resDurationMins + 2;
    });

    // 3. Called customers are proceeding to the counter, so they reserve the next open slots
    calledQueue.forEach(() => {
      tableFreeAt.sort((a, b) => a - b);
      tableFreeAt[0] = tableFreeAt[0] + sessionTurnaround;
    });

    // 4. If no one is waiting, show wait time for the next arriving walk-in
    if (waitingOnly.length === 0) {
      tableFreeAt.sort((a, b) => a - b);
      return {
        nextPersonWait: formatWaitLabel(tableFreeAt[0]),
        perPersonWaitMap: waitMap,
      };
    }

    // 5. Assign each waiting person their own individual wait estimate (FCFS)
    let firstWait = 'Available Now';
    waitingOnly.forEach((item, index) => {
      tableFreeAt.sort((a, b) => a - b);
      const myWait = tableFreeAt[0];
      const label = formatWaitLabel(myWait);
      if (index === 0) firstWait = label;
      waitMap.set(item.id, label);
      tableFreeAt[0] = myWait + sessionTurnaround;
    });

    return {
      nextPersonWait: firstWait,
      perPersonWaitMap: waitMap,
    };
  }, [tables, availableTables, safeHeldIds, reservationMoveError, reservations, calledQueue, waitingOnly, aiSessionMinutes, now]);

  const availableCount = reservationMoveError ? '—' : availableTables.length;
  const occupiedCount = tables.filter(t => t.isActive && t.status === 'occupied').length;
  const reservedCount = tables.filter(t => t.isActive && t.status === 'reserved').length;

  const timeStr = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const dateStr = now.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const nowMs = now.getTime();

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col overflow-auto">
      {/* Header Bar */}
      <header className="flex-none bg-black/60 border-b border-neutral-800/80 px-6 py-4 flex items-center justify-between backdrop-blur-sm">
        <div className="flex items-center gap-4">
          <img
            src={logoImg}
            alt="One Shot Logo"
            className="w-10 h-10 object-contain rounded-xl flex-shrink-0 bg-neutral-900 border border-neutral-800 p-0.5 shadow-lg shadow-emerald-950/20"
          />
          <div>
            <p className="text-white font-black text-base tracking-tight leading-tight">ONE SHOT BAR &amp; BILLIARDS</p>
            <p className="text-[11px] text-neutral-500 uppercase tracking-widest">Table Status &amp; Walk-in Queue</p>
          </div>
        </div>

        <button
          type="button"
          disabled={refreshing}
          onClick={refreshFloor}
          className="rounded-lg border border-neutral-700 px-3 py-2 text-xs font-bold text-neutral-200 hover:border-emerald-500 disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : 'Refresh tables'}
        </button>

        {/* Live clock */}
        <div className="text-right">
          <p className="text-2xl font-black text-white tabular-nums tracking-tight">{timeStr}</p>
          <p className="text-[11px] text-neutral-500">{dateStr}</p>
        </div>
      </header>

      {/* Status Summary & Color Indicators Bar */}
      <div className="flex-none bg-neutral-900/60 border-b border-neutral-800/60 px-6 py-2.5 flex flex-wrap items-center gap-4 sm:gap-6">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.9)]" />
          <span className="text-xs font-bold text-emerald-300">{availableCount} Available</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.6)]" />
          <span className="text-xs font-bold text-amber-300">{occupiedCount} In Use</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
          <span className="text-xs font-medium text-blue-300">Open Time</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" />
          <span className="text-xs font-medium text-rose-300">Overtime</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-sky-500" />
          <span className="text-xs font-bold text-sky-300">{reservedCount} Reserved</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-orange-500" />
          <span className="text-xs font-medium text-orange-300">Maintenance</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[11px] text-neutral-400 uppercase tracking-widest font-semibold">Live</span>
        </div>
      </div>

      {/* Main Body */}
      <div className="flex-1 flex flex-col lg:flex-row gap-0 overflow-hidden">
        {/* Tables Section */}
        <div className="flex-1 p-6 overflow-auto">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1 h-5 bg-emerald-500 rounded-full" />
            <h2 className="text-sm font-bold text-neutral-300 uppercase tracking-widest">Table Status</h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
            {tables
              .filter(table => table.isActive)
              .map(table => (
                <TableCard
                  key={table.id}
                  table={table}
                  held={safeHeldIds.has(table.id)}
                  availabilityVerified={availableTables.some(available => available.id === table.id)}
                  nowMs={nowMs}
                />
              ))}
          </div>
        </div>

        {/* Queue Section */}
        <div className="lg:w-80 xl:w-96 flex-none border-t lg:border-t-0 lg:border-l border-neutral-800/60 bg-neutral-950/60 flex flex-col">
          <div className="px-5 pt-5 pb-3 border-b border-neutral-800/40 space-y-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-1 h-5 bg-amber-500 rounded-full" />
                <h2 className="text-sm font-bold text-neutral-300 uppercase tracking-widest">Walk-in Queue</h2>
              </div>
              <p className="text-[11px] text-neutral-600 pl-3.5 flex items-center gap-1">
                <Sparkles size={11} className="text-emerald-400" /> Powered by Predictive AI
              </p>
            </div>

            {/* 🟢 Next-Person AI Wait Banner (Matches Queue.tsx & Web) */}
            <div className="bg-gradient-to-r from-emerald-950/60 to-emerald-900/20 border border-emerald-800/50 rounded-xl p-3.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center flex-shrink-0">
                  {isAILoading ? (
                    <RefreshCw size={14} className="text-emerald-400 animate-spin" />
                  ) : (
                    <Cpu size={14} className="text-emerald-400 animate-pulse" />
                  )}
                </div>
                <div className="min-w-0">
                  <span className="text-[9px] text-emerald-400/80 font-black uppercase tracking-widest block">
                    Next Up Wait
                  </span>
                  <span className="text-xs text-emerald-100 font-semibold truncate block">
                    {waitingOnly.length > 0 ? waitingOnly[0].customerName : 'Next Walk-in'}
                  </span>
                </div>
              </div>
              <span
                className={`font-black flex-shrink-0 ${
                  reservationMoveError || safeHeldIds.size > 0
                    ? 'text-xs text-amber-300'
                    : 'text-lg text-emerald-400'
                }`}
              >
                {nextPersonWait}
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-4">
            {displayQueue.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 gap-3">
                <div className="w-14 h-14 rounded-full bg-emerald-950/40 border border-emerald-800/30 flex items-center justify-center">
                  <Users size={22} className="text-emerald-600" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-emerald-400">No Queue</p>
                  <p className="text-[11px] text-neutral-600 mt-0.5">Walk right in — tables available!</p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {displayQueue.map((item, i) => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    position={i + 1}
                    estWait={perPersonWaitMap.get(item.id) || 'Available Now'}
                    isNextUp={waitingOnly[0]?.id === item.id}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Queue footer info */}
          <div className="p-4 border-t border-neutral-800/40">
            <div className="bg-neutral-900/80 border border-neutral-800/60 rounded-xl p-3 space-y-1.5 text-[11px]">
              <div className="flex justify-between">
                <span className="text-neutral-600">Parties waiting</span>
                <span className="text-neutral-300 font-semibold">{waitingOnly.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600">Base Rate per hour</span>
                <span className="text-emerald-400 font-semibold">₱{rates?.hourlyRate || 0} / hr</span>
              </div>
            </div>
            <p className="text-[10px] text-neutral-700 text-center mt-3 leading-relaxed">
              Please see staff at the counter to
              <br />
              join the queue or for assistance.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}