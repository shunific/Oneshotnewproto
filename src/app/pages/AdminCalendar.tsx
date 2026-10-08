import { useState } from 'react';
import { useAppContext, ClosedDate } from '../context/AppContext';
import { CalendarX2, X, Plus, CheckCircle, AlertTriangle, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isBefore, startOfDay, addMonths, subMonths } from 'date-fns';

const todayStart = startOfDay(new Date());

export function AdminCalendar() {
  const { closedDates, addClosedDate, removeClosedDate, updateClosedDate } = useAppContext();
  const [viewMonth, setViewMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [showForm, setShowForm]   = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toast, setToast]         = useState<string | null>(null);
  const [form, setForm] = useState({ reason: '', isFullDay: true, openTime: '12:00', closeTime: '22:00' });

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

  // Calendar days
  const monthStart = startOfMonth(viewMonth);
  const monthEnd   = endOfMonth(viewMonth);
  const days       = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const startPad   = monthStart.getDay(); // 0=Sun

  const dateKey = (d: Date) => format(d, 'yyyy-MM-dd');
  const closedMap = new Map(closedDates.map(c => [c.date, c]));

  const handleDayClick = (day: Date) => {
    if (isBefore(day, todayStart)) return; // can't close past dates
    const key = dateKey(day);
    const existing = closedMap.get(key);
    if (existing) {
      // Open edit
      setEditingId(existing.id);
      setForm({ reason: existing.reason, isFullDay: existing.isFullDay, openTime: existing.openTime || '12:00', closeTime: existing.closeTime || '22:00' });
    } else {
      setEditingId(null);
      setForm({ reason: '', isFullDay: true, openTime: '12:00', closeTime: '22:00' });
    }
    setSelectedDate(day);
    setShowForm(true);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDate) return;
    const key = dateKey(selectedDate);
    if (editingId) {
      updateClosedDate(editingId, { reason: form.reason, isFullDay: form.isFullDay, openTime: form.openTime, closeTime: form.closeTime });
      flash('Closing date updated!');
    } else {
      addClosedDate({ date: key, reason: form.reason, isFullDay: form.isFullDay, openTime: form.openTime, closeTime: form.closeTime });
      flash(`${format(selectedDate, 'MMMM d')} marked as closed!`);
    }
    setShowForm(false); setSelectedDate(null); setEditingId(null);
  };

  const handleRemove = () => {
    if (!editingId) return;
    removeClosedDate(editingId);
    setShowForm(false); setSelectedDate(null); setEditingId(null);
    flash('Closing date removed.');
  };

  const upcoming = closedDates.filter(c => !isBefore(new Date(c.date), todayStart)).sort((a,b) => a.date.localeCompare(b.date));
  const past      = closedDates.filter(c => isBefore(new Date(c.date), todayStart)).sort((a,b) => b.date.localeCompare(a.date));

  return (
    <div className="space-y-5">
      {toast && (
        <div className="flex items-center gap-2 bg-emerald-950/40 border border-emerald-700/40 text-emerald-400 text-sm px-4 py-3 rounded-xl">
          <CheckCircle size={14} /> {toast}
        </div>
      )}

      <div className="bg-amber-950/20 border border-amber-900/30 rounded-xl p-4 flex items-start gap-3">
        <AlertTriangle size={15} className="text-amber-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-600/80 leading-relaxed">
          Click any <strong>future</strong> date to mark it as closed. Customers will not be able to make reservations on these dates.
          Past dates are read-only.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Calendar */}
        <div className="lg:col-span-2 bg-neutral-950 border border-neutral-800 rounded-2xl overflow-hidden">
          {/* Month nav */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
            <button onClick={() => setViewMonth(m => subMonths(m, 1))}
              className="p-2 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors">
              <ChevronLeft size={16} />
            </button>
            <h2 className="text-sm font-bold text-neutral-200">{format(viewMonth, 'MMMM yyyy')}</h2>
            <button onClick={() => setViewMonth(m => addMonths(m, 1))}
              className="p-2 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors">
              <ChevronRight size={16} />
            </button>
          </div>

          <div className="p-4">
            {/* Day headers */}
            <div className="grid grid-cols-7 mb-2">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                <div key={d} className="text-center text-[10px] text-neutral-600 uppercase tracking-wider font-semibold py-1">{d}</div>
              ))}
            </div>

            {/* Days grid */}
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: startPad }).map((_, i) => <div key={`pad-${i}`} />)}
              {days.map(day => {
                const key = dateKey(day);
                const closed  = closedMap.get(key);
                const isPast  = isBefore(day, todayStart);
                const isToday = isSameDay(day, new Date());

                return (
                  <button
                    key={key}
                    onClick={() => handleDayClick(day)}
                    disabled={isPast}
                    className={`
                      relative aspect-square rounded-xl flex flex-col items-center justify-center text-sm transition-all
                      ${isPast ? 'text-neutral-700 cursor-default' : 'hover:bg-neutral-800 cursor-pointer'}
                      ${isToday ? 'ring-1 ring-amber-500/50' : ''}
                      ${closed ? 'bg-rose-950/40 border border-rose-800/40 text-rose-400' : isPast ? '' : 'text-neutral-300'}
                    `}
                  >
                    <span className={`font-semibold text-xs ${isToday ? 'text-amber-400' : ''}`}>{format(day, 'd')}</span>
                    {closed && (
                      <span className="text-[8px] text-rose-500/80 leading-none mt-0.5">{closed.isFullDay ? 'Closed' : 'Partial'}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Legend */}
            <div className="flex items-center gap-4 mt-4 pt-3 border-t border-neutral-800">
              <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded bg-rose-950/60 border border-rose-800/40" /><span className="text-[10px] text-neutral-500">Closed (full day)</span></div>
              <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded ring-1 ring-amber-500/50" /><span className="text-[10px] text-neutral-500">Today</span></div>
            </div>
          </div>
        </div>

        {/* Upcoming closures */}
        <div className="space-y-4">
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-neutral-800">
              <p className="text-xs font-bold text-neutral-200 flex items-center gap-2"><CalendarX2 size={13} className="text-rose-400" /> Upcoming Closures ({upcoming.length})</p>
            </div>
            <div className="divide-y divide-neutral-800/50 max-h-64 overflow-y-auto">
              {upcoming.length === 0 ? (
                <p className="px-4 py-6 text-xs text-neutral-600 text-center">No upcoming closures</p>
              ) : upcoming.map(c => (
                <div key={c.id} className="px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-rose-400">{format(new Date(c.date + 'T12:00:00'), 'EEE, MMM d yyyy')}</p>
                    <p className="text-[11px] text-neutral-500 truncate">{c.reason || 'No reason given'}</p>
                    <p className="text-[10px] text-neutral-700">{c.isFullDay ? 'Full day' : `${c.openTime}–${c.closeTime}`}</p>
                  </div>
                  <button onClick={() => removeClosedDate(c.id)}
                    className="p-1.5 text-neutral-600 hover:text-rose-400 hover:bg-rose-950/20 rounded-lg transition-colors flex-shrink-0">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {past.length > 0 && (
            <div className="bg-neutral-950 border border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-800">
                <p className="text-xs font-bold text-neutral-500">Past Closures ({past.length})</p>
              </div>
              <div className="divide-y divide-neutral-800/50 max-h-40 overflow-y-auto">
                {past.slice(0, 5).map(c => (
                  <div key={c.id} className="px-4 py-2.5">
                    <p className="text-[11px] font-semibold text-neutral-600">{format(new Date(c.date + 'T12:00:00'), 'MMM d yyyy')}</p>
                    <p className="text-[10px] text-neutral-700 truncate">{c.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Form Modal */}
      {showForm && selectedDate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-amber-900/30 rounded-2xl w-full max-w-sm shadow-2xl">
            <div className="px-6 py-4 border-b border-neutral-800 flex justify-between items-center">
              <div>
                <h2 className="text-base font-bold text-neutral-100">
                  {editingId ? 'Edit Closure' : 'Mark as Closed'}
                </h2>
                <p className="text-xs text-neutral-500">{format(selectedDate, 'EEEE, MMMM d, yyyy')}</p>
              </div>
              <button onClick={() => { setShowForm(false); setSelectedDate(null); }} className="p-2 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg"><X size={16} /></button>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div>
                <label className="text-xs text-neutral-400 mb-1.5 block font-medium">Reason *</label>
                <input type="text" value={form.reason} onChange={e => setForm(f=>({...f,reason:e.target.value}))} required autoFocus
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:border-amber-600/50 transition-colors placeholder-neutral-600"
                  placeholder="e.g. Holiday, Private Event, Staff Off Day" />
              </div>
              <label className="flex items-center gap-3 cursor-pointer">
                <div className={`w-10 h-5 rounded-full relative transition-colors ${form.isFullDay ? 'bg-rose-700' : 'bg-neutral-700'}`}
                  onClick={() => setForm(f=>({...f, isFullDay: !f.isFullDay}))}>
                  <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.isFullDay ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </div>
                <span className="text-xs text-neutral-300 font-medium">Full day closure</span>
              </label>
              {!form.isFullDay && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-neutral-400 mb-1.5 block">Open Time</label>
                    <input type="time" value={form.openTime} onChange={e => setForm(f=>({...f,openTime:e.target.value}))}
                      className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:border-amber-600/50 transition-colors" />
                  </div>
                  <div>
                    <label className="text-xs text-neutral-400 mb-1.5 block">Close Time</label>
                    <input type="time" value={form.closeTime} onChange={e => setForm(f=>({...f,closeTime:e.target.value}))}
                      className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:border-amber-600/50 transition-colors" />
                  </div>
                </div>
              )}
              <div className="flex gap-2 pt-1">
                {editingId && (
                  <button type="button" onClick={handleRemove}
                    className="px-3 py-2.5 bg-rose-950/30 hover:bg-rose-900/40 border border-rose-800/30 text-rose-400 text-sm rounded-xl transition-colors flex items-center gap-1.5">
                    <Trash2 size={13} /> Remove
                  </button>
                )}
                <button type="button" onClick={() => { setShowForm(false); setSelectedDate(null); }}
                  className="px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl transition-colors">Cancel</button>
                <button type="submit"
                  className="flex-1 bg-amber-600 hover:bg-amber-500 text-white text-sm rounded-xl font-semibold py-2.5 flex items-center justify-center gap-2">
                  <CalendarX2 size={14} /> {editingId ? 'Update' : 'Mark Closed'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
