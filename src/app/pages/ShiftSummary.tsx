import { useState, useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { format, isToday, startOfDay, endOfDay } from 'date-fns';
import {
  Printer, Calendar, Users, Clock, DollarSign,
  CheckCircle, Table2, TrendingUp, BarChart2
} from 'lucide-react';

const formatPHP = (amount: number) => `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

const statusConfig: Record<string, { label: string; color: string }> = {
  pending:      { label: 'Pending',    color: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  confirmed:    { label: 'Confirmed',  color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  'checked-in': { label: 'Checked In', color: 'bg-sky-500/10 text-sky-400 border-sky-500/20' },
  completed:    { label: 'Completed',  color: 'bg-neutral-700/50 text-neutral-400 border-neutral-700' },
  cancelled:    { label: 'Cancelled',  color: 'bg-rose-500/10 text-rose-400 border-rose-500/20' },
};

export function ShiftSummary() {
  const { tables, reservations, queue } = useAppContext();

  const [selectedDate, setSelectedDate] = useState<string>(format(new Date(), 'yyyy-MM-dd'));

  const dayStart = useMemo(() => startOfDay(new Date(selectedDate + 'T00:00:00')), [selectedDate]);
  const dayEnd   = useMemo(() => endOfDay(new Date(selectedDate + 'T00:00:00')), [selectedDate]);

  const dayReservations = useMemo(() => reservations.filter(r => {
    const d = new Date(r.date);
    return d >= dayStart && d <= dayEnd;
  }), [reservations, dayStart, dayEnd]);

  // Stats
  const tablesUsedToday = useMemo(() => {
    const used = new Set<string>();
    dayReservations.forEach(r => { if (r.tableId) used.add(r.tableId); });
    return used.size;
  }, [dayReservations]);

  const totalSessions = dayReservations.length;

  const revenueCollected = useMemo(() => {
    return dayReservations
      .filter(r => r.status !== 'cancelled')
      .reduce((s, r) => {
        let paid = 0;
        if (r.downPaymentPaid) paid += r.downPaymentAmount;
        if (r.balancePaid) paid += (r.totalAmount - r.downPaymentAmount);
        return s + paid;
      }, 0);
  }, [dayReservations]);

  const reservationsServed = useMemo(() =>
    dayReservations.filter(r => r.status === 'checked-in' || r.status === 'completed').length,
    [dayReservations]
  );

  const avgDuration = useMemo(() => {
    const completed = dayReservations.filter(r => r.status !== 'cancelled');
    if (!completed.length) return 0;
    return completed.reduce((s, r) => s + r.durationHours, 0) / completed.length;
  }, [dayReservations]);

  const isSelectedToday = isToday(new Date(selectedDate + 'T00:00:00'));

  const statCards = [
    {
      label: 'Tables Used',
      value: tablesUsedToday,
      icon: Table2,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10 border-emerald-500/20',
    },
    {
      label: 'Total Sessions',
      value: totalSessions,
      icon: BarChart2,
      color: 'text-sky-400',
      bg: 'bg-sky-500/10 border-sky-500/20',
    },
    {
      label: 'Revenue Collected',
      value: formatPHP(revenueCollected),
      icon: DollarSign,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10 border-amber-500/20',
    },
    {
      label: 'Reservations Served',
      value: reservationsServed,
      icon: CheckCircle,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10 border-emerald-500/20',
    },
    {
      label: 'Avg Session Duration',
      value: avgDuration > 0 ? `${avgDuration.toFixed(1)}h` : '—',
      icon: Clock,
      color: 'text-violet-400',
      bg: 'bg-violet-500/10 border-violet-500/20',
    },
    {
      label: 'Queue Served (Today)',
      value: isSelectedToday ? queue.filter(q => q.status === 'called' || q.status === 'seated').length : '—',
      icon: Users,
      color: 'text-rose-400',
      bg: 'bg-rose-500/10 border-rose-500/20',
    },
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-neutral-100 flex items-center gap-2">
            <TrendingUp size={18} className="text-emerald-400" /> Shift Summary Report
          </h1>
          <p className="text-xs text-neutral-500 mt-0.5">Daily summary of table activity, revenue, and reservations.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-neutral-950 border border-neutral-800 rounded-xl px-3 py-2">
            <Calendar size={14} className="text-neutral-500" />
            <input
              type="date"
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
              className="bg-transparent text-sm text-neutral-200 focus:outline-none"
            />
          </div>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-300 text-sm rounded-xl font-semibold transition-all"
          >
            <Printer size={14} /> Print Report
          </button>
        </div>
      </div>

      {/* Date Label */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-500">Showing data for:</span>
        <span className="text-xs font-semibold text-neutral-200 bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1">
          {format(new Date(selectedDate + 'T00:00:00'), 'EEEE, MMMM d, yyyy')}
          {isSelectedToday && <span className="ml-2 text-emerald-400">(Today)</span>}
        </span>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {statCards.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="bg-neutral-950 border border-neutral-800 rounded-xl p-4">
            <div className="flex items-center gap-3 mb-2">
              <div className={`w-8 h-8 rounded-lg border flex items-center justify-center ${bg}`}>
                <Icon size={15} className={color} />
              </div>
              <p className="text-xs text-neutral-500 font-semibold">{label}</p>
            </div>
            <p className={`text-2xl font-black ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Reservations Table */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-800 flex items-center justify-between">
          <h3 className="text-sm font-bold text-neutral-200">
            Reservations for {format(new Date(selectedDate + 'T00:00:00'), 'MMM d, yyyy')}
          </h3>
          <span className="text-xs text-neutral-500">{dayReservations.length} total</span>
        </div>

        {dayReservations.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <Calendar size={28} className="mx-auto text-neutral-700 mb-2" />
            <p className="text-sm text-neutral-500">No reservations for this date.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-neutral-800 bg-neutral-900/40">
                  {['Customer', 'Time', 'Duration', 'Party', 'Table', 'Status', 'Total', 'Paid'].map(h => (
                    <th key={h} className="text-left text-[10px] text-neutral-500 uppercase tracking-wider font-semibold px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/50">
                {dayReservations.map(r => {
                  const cfg = statusConfig[r.status] || statusConfig.pending;
                  const tableName = r.tableId ? tables.find(t => t.id === r.tableId)?.name || r.tableId : '—';
                  const amtPaid = (r.downPaymentPaid ? r.downPaymentAmount : 0) + (r.balancePaid ? r.totalAmount - r.downPaymentAmount : 0);
                  return (
                    <tr key={r.id} className="hover:bg-neutral-900/40 transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-sm font-semibold text-neutral-200">{r.customerName}</p>
                        <p className="text-xs text-neutral-500">{r.contactNumber}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-neutral-400">{r.timeSlot}</td>
                      <td className="px-4 py-3 text-sm text-neutral-400">{r.durationHours}h</td>
                      <td className="px-4 py-3 text-sm text-neutral-400">{r.partySize} pax</td>
                      <td className="px-4 py-3 text-sm text-neutral-400">{tableName}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${cfg.color}`}>
                          {cfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-neutral-200 font-semibold">{formatPHP(r.totalAmount)}</td>
                      <td className="px-4 py-3 text-sm text-emerald-400 font-semibold">{formatPHP(amtPaid)}</td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Totals row */}
              <tfoot>
                <tr className="border-t border-neutral-700 bg-neutral-900/30">
                  <td colSpan={6} className="px-4 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">Totals</td>
                  <td className="px-4 py-3 text-sm font-black text-white">
                    {formatPHP(dayReservations.filter(r => r.status !== 'cancelled').reduce((s, r) => s + r.totalAmount, 0))}
                  </td>
                  <td className="px-4 py-3 text-sm font-black text-emerald-400">
                    {formatPHP(dayReservations.reduce((s, r) => {
                      let p = 0;
                      if (r.downPaymentPaid) p += r.downPaymentAmount;
                      if (r.balancePaid) p += r.totalAmount - r.downPaymentAmount;
                      return s + p;
                    }, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Active Tables Status (live, only if today) */}
      {isSelectedToday && (
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-neutral-800">
            <h3 className="text-sm font-bold text-neutral-200">Live Table Status</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 p-4">
            {tables.filter(t => t.isActive).map(t => (
              <div key={t.id} className={`rounded-xl border p-3 text-center ${
                t.status === 'occupied'    ? 'bg-rose-950/20 border-rose-800/30' :
                t.status === 'reserved'   ? 'bg-amber-950/20 border-amber-800/30' :
                t.status === 'maintenance'? 'bg-orange-950/20 border-orange-800/30' :
                'bg-neutral-900 border-neutral-800'
              }`}>
                <p className="text-xs font-semibold text-neutral-300 mb-1">{t.name}</p>
                <p className={`text-[10px] font-bold uppercase tracking-wider ${
                  t.status === 'occupied'    ? 'text-rose-400' :
                  t.status === 'reserved'   ? 'text-amber-400' :
                  t.status === 'maintenance'? 'text-orange-400' :
                  'text-emerald-400'
                }`}>{t.status}</p>
                {t.session && (
                  <p className="text-[9px] text-neutral-600 mt-1 truncate">{t.session.customerName}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
