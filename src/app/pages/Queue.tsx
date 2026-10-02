import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import { 
  UserPlus, X, Bell, CheckCircle, Clock, Users, ChevronDown, ChevronUp, 
  Calendar as CalendarIcon, AlertCircle, Star, Sparkles, Plus, Minus,
  RefreshCw, AlertTriangle, Cpu
} from 'lucide-react';
import { formatDistanceToNow, format, isToday, isTomorrow, differenceInMinutes, addMinutes, differenceInSeconds } from 'date-fns';
import { useNavigate } from 'react-router';

export function Queue() {
  const { queue, addToQueue, removeFromQueue, callQueueItem, tables, reservations, cancelReservation, reservationTerms } = useAppContext() as any;
  const navigate = useNavigate();
  
  // 🟢 Dynamic max party size based on the current day
  const currentDay = new Date().getDay();
  const isWeekend = currentDay === 0 || currentDay === 5 || currentDay === 6;
  const maxAllowedPartySize = isWeekend ? (reservationTerms?.weekendMaxPartySize || 20) : (reservationTerms?.weekdayMaxPartySize || 20);

  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [partySize, setPartySize] = useState(2);
  const [notes, setNotes] = useState('');
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);

  // 🟢 TOAST STATE WITH 5S TIMER & FADE OUT
  const [toastState, setToastState] = useState<{msg: string, type: 'success' | 'error' | 'loading'} | null>(null);
  const toastTimeout = useRef<NodeJS.Timeout | null>(null);

  const flash = (msg: string, type: 'success' | 'error' | 'loading' = 'success') => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToastState({ msg, type });
    if (type !== 'loading') {
      toastTimeout.current = setTimeout(() => setToastState(null), 5000);
    }
  };

  // Live clock
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Priority queue: checked-in reservation customers jump ahead
  const checkedInReservations = reservations.filter((r: any) => r.status === 'checked-in');
  const waiting = queue.filter((q: any) => q.status === 'waiting');
  const called = queue.filter((q: any) => q.status === 'called');
  const availableTables = tables.filter((t: any) => t.status === 'available');

  // ========================================================================
  // 🧠 NEURAL NETWORK AI INTEGRATION
  // ========================================================================
  const [aiWaitTime, setAiWaitTime] = useState<string>('Analyzing data...');
  const [isAILoading, setIsAILoading] = useState(true);

  const fetchAIPrediction = useCallback(async () => {
    setIsAILoading(true);
    try {
      const activeTables = tables.filter((t: any) => t.status === 'occupied' && t.session);
      const freeTables = tables.filter((t: any) => t.status === 'available').length;
      
      // 1. If there are enough free tables for everyone waiting PLUS a new walk-in:
      if (freeTables > waiting.length) {
        setAiWaitTime("Available Now");
        setIsAILoading(false);
        return;
      }

      const currentOccupancyRate = activeTables.length / Math.max(1, tables.length);
      const nextPartySize = waiting[0]?.partySize || 2;
      
      // 2. Send local venue state to the Brain.js Neural Network
      const res = await fetch('http://localhost:3001/api/ai/predict-wait-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          partySize: nextPartySize, 
          hasOrders: true, // Conservative prediction assumes customers will order
          currentOccupancyRate 
        })
      });
      
      const data = await res.json();
      
      // 3. Find the table finishing closest to now
      const elapsedTimes = activeTables.map((t: any) => differenceInMinutes(now, new Date(t.session.startTime)));
      const maxElapsed = Math.max(...elapsedTimes, 0); 
      
      // 4. Calculate Base Wait (AI Prediction minus Time Already Spent)
      let baseWait = Math.max(0, data.estimatedMinutes - maxElapsed);
      
      // 5. Add Queue Friction (Only for people who don't fit in the free tables)
      const unseatedQueue = Math.max(0, waiting.length - freeTables);
      const totalWait = baseWait + (unseatedQueue * 10) + 2; // +2 mins for physical table cleanup
      
      if (totalWait < 60) {
        setAiWaitTime(`~${Math.round(totalWait)} mins`);
      } else {
        setAiWaitTime(`~${Math.floor(totalWait / 60)}h ${Math.round(totalWait % 60)}m`);
      }
      
    } catch (e) {
      console.error("AI Predict Error:", e);
      setAiWaitTime("~45 mins (Fallback)"); 
    }
    setIsAILoading(false);
  }, [tables, waiting, now]);

  // Poll the AI engine every 30 seconds for dynamic adjustments
  useEffect(() => {
    fetchAIPrediction();
    const aiInterval = setInterval(fetchAIPrediction, 30000);
    return () => clearInterval(aiInterval);
  }, [fetchAIPrediction]);


  // Get upcoming reservations (today and future)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const upcomingReservations = reservations
    .filter((r: any) => {
      if (r.status === 'cancelled' || r.status === 'completed') return false;
      const resDate = new Date(r.date);
      resDate.setHours(0, 0, 0, 0);
      return resDate.getTime() >= todayStart.getTime();
    })
    .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, 10);

  const CharCount = ({ current, max }: { current?: string, max: number }) => {
    const len = current?.length || 0;
    return (
      <span className={`text-[10px] ${len >= max ? 'text-rose-400 font-bold' : 'text-neutral-600'}`}>
        {len}/{max}
      </span>
    );
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      flash("Customer Name is required.", "error");
      return;
    }
    
    if (partySize > maxAllowedPartySize) {
      flash(`The maximum walk-in party size allowed today is ${maxAllowedPartySize} based on store policy.`, "error");
      return;
    }
    
    addToQueue({ customerName: name.trim(), contactNumber: contact, partySize, notes });
    flash(`${name.trim()} added to the waiting queue.`, "success");
    
    setName('');
    setContact('');
    setPartySize(2);
    setNotes('');
    setShowAddForm(false);
  };

  const handleCallCustomer = (customerId: string, customerName: string) => {
    // 🟢 DEFENSE 1: Zero Tables Validation Warning
    if (availableTables.length === 0) {
      if (!window.confirm(`⚠️ Wait! There are NO available tables right now.\n\nAre you sure you want to call ${customerName} to the counter? (e.g., A table is currently packing up)`)) {
        return;
      }
    }

    // 🟢 DEFENSE 2: Priority Bypass Lockout & Audit
    if (checkedInReservations.length > 0) {
      if (!window.confirm(`🚨 PRIORITY BYPASS DETECTED!\n\nYou have ${checkedInReservations.length} Checked-In Reservation(s) waiting for a table. Are you absolutely sure you want to skip them to seat a walk-in?\n\nClicking OK will log this override to the security audit trail.`)) {
        return;
      }
      addActivity('admin_action', `⚠️ PRIORITY BYPASS: Staff bypassed waiting reservations to manually call walk-in customer: ${customerName}`);
    }

    callQueueItem(customerId);
    flash(`Called ${customerName} from the queue.`, "success");
    
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(`${customerName}, your table is ready. Please proceed to the counter.`);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      window.speechSynthesis.speak(utterance);
    }
  };

  // 🟢 NEW: Calculate exact physical time until the closest table finishes
  const getNearestEndTime = () => {
    const active = tables.filter((t: any) => t.status === 'occupied' && t.session && !t.session.isOpenTime && t.session.durationMinutes);
    if (active.length === 0) return null;
    
    const remainingTimes = active.map((t: any) => {
      const endTime = addMinutes(new Date(t.session.startTime), t.session.durationMinutes);
      return differenceInMinutes(endTime, now);
    }).sort((a, b) => a - b);
    
    const nearest = remainingTimes[0];
    if (nearest <= 0) return "Table finishing now";
    
    const hrs = Math.floor(nearest / 60);
    const mins = nearest % 60;
    if (hrs > 0) return `Next table ends in ${hrs}h ${mins}m`;
    return `Next table ends in ~${mins}m`;
  };

  return (
    <div className="space-y-5 relative pb-20">

      {/* 🟢 TOP-RIGHT FLOATING TOAST WITH 5S TIMER & FADE OUT */}
      {toastState && (
        <div 
          className="fixed top-6 right-6 z-[99999] animate-in slide-in-from-top-4 fade-in duration-300"
          style={{ animation: toastState.type !== 'loading' ? 'toast-fade-out 5s forwards' : 'none' }}
        >
          <div className={`relative overflow-hidden flex items-start gap-3 px-5 py-4 rounded-xl border shadow-2xl backdrop-blur-md min-w-[320px] max-w-md ${
            toastState.type === 'success' 
              ? 'bg-emerald-950/90 border-emerald-900/50 text-emerald-400' 
              : toastState.type === 'loading'
              ? 'bg-sky-950/90 border-sky-900/50 text-sky-400'
              : 'bg-rose-950/90 border-rose-900/50 text-rose-400'
          }`}>
            <div className="mt-0.5 flex-shrink-0">
              {toastState.type === 'success' ? <CheckCircle size={18} /> : toastState.type === 'loading' ? <RefreshCw size={18} className="animate-spin" /> : <AlertTriangle size={18} />}
            </div>
            <span className="text-sm font-semibold leading-snug whitespace-pre-wrap pr-4">{toastState.msg}</span>
            {toastState.type !== 'loading' && (
              <button 
                onClick={() => { setToastState(null); if (toastTimeout.current) clearTimeout(toastTimeout.current); }} 
                className="absolute top-4 right-4 text-neutral-500 hover:text-white transition-colors"
              >
                <X size={14} />
              </button>
            )}
            {toastState.type !== 'loading' && (
              <div 
                className={`absolute bottom-0 left-0 h-1 ${toastState.type === 'success' ? 'bg-emerald-500' : 'bg-rose-500'}`}
                style={{ animation: 'toast-shrink 5s linear forwards' }}
              />
            )}
          </div>
          <style>{`
            @keyframes toast-shrink {
              0% { width: 100%; }
              100% { width: 0%; }
            }
            @keyframes toast-fade-out {
              0%, 90% { opacity: 1; transform: translateY(0); }
              100% { opacity: 0; transform: translateY(-10px); }
            }
          `}</style>
        </div>
      )}

      {/* Header Actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 flex items-center gap-2">
            <Users size={15} className="text-amber-400" />
            <span className="text-sm font-semibold text-neutral-200">{waiting.length} Waiting</span>
          </div>
          {availableTables.length > 0 && (
            <div className="bg-emerald-950/30 border border-emerald-800/40 rounded-xl px-4 py-2.5 flex items-center gap-2">
              <CheckCircle size={15} className="text-emerald-400" />
              <span className="text-sm font-semibold text-emerald-400">{availableTables.length} Table{availableTables.length > 1 ? 's' : ''} Available</span>
            </div>
          )}
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-xl transition-all font-semibold shadow-lg shadow-emerald-900/30"
        >
          <UserPlus size={15} /> Add to Queue
          {showAddForm ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      {/* Add Form */}
      {showAddForm && (
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-5 shadow-xl">
          <h3 className="text-sm font-semibold text-neutral-300 mb-4 flex items-center gap-2">
            <UserPlus size={15} className="text-emerald-500" /> Register Walk-in Customer (FCFS)
          </h3>
          <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Full Name *</label>
                <CharCount current={name} max={50} />
              </div>
              <input type="text" value={name} maxLength={50} onChange={e => setName(e.target.value)} className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 placeholder-neutral-600" placeholder="Customer name" required autoFocus />
            </div>
            
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Contact Number</label>
              </div>
              <input type="tel" value={contact} maxLength={11} onChange={e => setContact(e.target.value.replace(/\D/g, ''))} className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 placeholder-neutral-600" placeholder="09xx-xxx-xxxx" />
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Party Size</label>
                <span className="text-[10px] text-emerald-500 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">Max {maxAllowedPartySize}</span>
              </div>
              <div className="flex items-center gap-3 bg-neutral-900 border border-neutral-800 rounded-lg p-1.5">
                <button type="button" onClick={() => setPartySize(p => Math.max(1, p - 1))} className="flex-1 h-8 flex items-center justify-center bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md transition-colors"><Minus size={14}/></button>
                <span className="w-12 text-center text-sm font-bold text-neutral-200">{partySize > maxAllowedPartySize ? maxAllowedPartySize : partySize}</span>
                <button type="button" disabled={partySize >= maxAllowedPartySize} onClick={() => setPartySize(p => Math.min(maxAllowedPartySize, p + 1))} className="flex-1 h-8 flex items-center justify-center bg-emerald-600/20 hover:bg-emerald-600/30 disabled:bg-neutral-800 disabled:text-neutral-700 text-emerald-400 rounded-md transition-colors"><Plus size={14}/></button>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Notes (optional)</label>
                <CharCount current={notes} max={100} />
              </div>
              <input type="text" value={notes} maxLength={100} onChange={e => setNotes(e.target.value)} className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 placeholder-neutral-600" placeholder="Special requests..." />
            </div>
            <div className="sm:col-span-2 flex gap-3">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-xl font-semibold transition-all shadow-lg shadow-emerald-900/30 flex items-center justify-center gap-2"
              >
                <UserPlus size={15} /> Add to Queue
              </button>
            </div>
          </form>
        </div>
      )}

      {/* FCFS Notice */}
      <div className="flex items-center gap-2.5 bg-blue-950/20 border border-blue-900/30 rounded-xl px-4 py-3">
        <Clock size={15} className="text-blue-400 flex-none" />
        <p className="text-xs text-blue-300">
          <strong>First Come, First Served (FCFS)</strong> — Customers are served in the order they arrived. The position in queue is based on arrival time.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Main Queue */}
        <div className="lg:col-span-2 space-y-3">

          {/* Priority Queue: Checked-In Reservations */}
          {checkedInReservations.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs text-sky-400 uppercase tracking-widest font-semibold flex items-center gap-2">
                <Star size={12} className="text-sky-400" /> Priority — Checked-In Reservations ({checkedInReservations.length})
              </h2>
              {checkedInReservations.map((r: any) => (
                <div key={r.id} className="bg-sky-950/20 border border-sky-800/40 rounded-xl p-4 flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-sky-600 text-white flex items-center justify-center font-black text-sm flex-none">
                    <Star size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-neutral-200 truncate">{r.customerName}</p>
                      <span className="px-1.5 py-0.5 bg-sky-600/20 text-sky-400 text-[10px] font-bold rounded uppercase tracking-wider flex-shrink-0">Priority</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 mt-0.5">
                      <span className="text-xs text-neutral-500 flex items-center gap-1">
                        <Users size={10} /> {r.partySize} pax
                      </span>
                      <span className="text-xs text-neutral-500">{r.contactNumber}</span>
                      <span className="text-xs text-sky-500">
                        {isToday(new Date(r.date)) ? 'Today' : isTomorrow(new Date(r.date)) ? 'Tomorrow' : format(new Date(r.date), 'MMM d')} · {r.timeSlot} · {r.durationHours}h
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-none">
                    <button
                      onClick={() => {
                        const targetTable = (r.tableId && tables.find((t: any) => t.id === r.tableId && t.status === 'available' && t.isActive)) 
                          ? r.tableId 
                          : availableTables[0]?.id;
                        sessionStorage.setItem('assignCustomer', JSON.stringify({
                          kind: 'reservation',
                          id: r.id,
                          name: r.customerName,
                          partySize: r.partySize,
                          contact: r.contactNumber,
                          durationHours: r.durationHours,
                          timeSlot: r.timeSlot
                        }));
                        if (targetTable) sessionStorage.setItem('assignTableId', targetTable);
                        navigate('/staff/tables');
                      }}
                      className="flex items-center gap-1.5 px-3 py-2 bg-sky-600/20 hover:bg-sky-600/30 text-sky-400 text-xs font-semibold rounded-lg border border-sky-700/30 transition-colors"
                    >
                      Assign Table
                    </button>
                    <button
                      onClick={() => {
                        setCancelTarget(r.id);
                        setShowCancelDialog(true);
                      }}
                      title="Cancel / Dismiss Reservation"
                      className="p-2 bg-rose-600/20 hover:bg-rose-600/40 text-rose-400 rounded-lg transition-colors border border-rose-700/30"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between mb-2 mt-4">
            <h2 className="text-xs text-neutral-500 uppercase tracking-widest font-semibold flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400" /> 
              <span>Walk-in Queue ({waiting.length})</span>
            </h2>
          </div>

          {/* 🟢 NEURAL NETWORK PREDICTION BADGE */}
          <div className="bg-gradient-to-r from-emerald-950/60 to-emerald-900/20 border border-emerald-800/50 rounded-2xl p-5 mb-4 flex items-center justify-between shadow-[0_0_20px_rgba(16,185,129,0.05)] relative overflow-hidden group">
            <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl transition-all group-hover:bg-emerald-500/20" />
            <div className="flex items-center gap-4 relative z-10">
              <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shadow-inner">
                {isAILoading ? (
                  <RefreshCw size={18} className="text-emerald-400 animate-spin" />
                ) : (
                  <Cpu size={18} className="text-emerald-400 animate-pulse" />
                )}
              </div>
              <div>
                <span className="text-[10px] text-emerald-400/80 font-black uppercase tracking-widest block mb-0.5">Neural Network AI</span>
                <span className="text-sm text-emerald-100 font-semibold tracking-tight">Estimated Wait Time</span>
              </div>
            </div>
            <div className="text-right relative z-10 flex flex-col items-end">
              <span className="text-3xl font-black text-emerald-400 drop-shadow-[0_0_8px_rgba(16,185,129,0.3)]">
                {aiWaitTime}
              </span>
              <div className="flex flex-col items-end mt-1 space-y-1.5">
                <span className="text-[9px] text-emerald-500/60 font-medium uppercase">Updates Live</span>
                {/* 🟢 THE NEAREST END TIME BADGE */}
                {getNearestEndTime() && availableTables.length === 0 && (
                  <span className="text-[10px] text-emerald-300/90 font-semibold bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/50 flex items-center gap-1.5 shadow-sm">
                    <Clock size={10} className="text-emerald-400" /> {getNearestEndTime()}
                  </span>
                )}
              </div>
            </div>
          </div>

          {waiting.length === 0 ? (
            <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-10 text-center shadow-sm">
              <CheckCircle size={32} className="mx-auto text-emerald-500/40 mb-3" />
              <p className="text-neutral-400 font-semibold">No customers in queue</p>
              <p className="text-xs text-neutral-600 mt-1">Add walk-in customers using the button above</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {waiting.map((item: any, index: number) => (
                <div
                  key={item.id}
                  className={`bg-neutral-950 border rounded-xl p-4 flex items-center gap-4 transition-all ${
                    index === 0 ? 'border-emerald-700/40 shadow-sm shadow-emerald-900/10' : 'border-neutral-800'
                  }`}
                >
                  {/* Position */}
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-lg flex-none ${
                    index === 0 ? 'bg-emerald-600 text-white' : 'bg-neutral-800 text-neutral-400'
                  }`}>
                    {index + 1}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-neutral-200 truncate">{item.customerName}</p>
                      {item.queueNumber && (
                        <span className="px-1.5 py-0.5 bg-neutral-800 text-neutral-500 text-[10px] font-mono font-bold rounded border border-neutral-700 flex-shrink-0">
                          #{String(item.queueNumber).padStart(3, '0')}
                        </span>
                      )}
                      {index === 0 && (
                        <span className="px-1.5 py-0.5 bg-emerald-600/20 text-emerald-400 text-[10px] font-bold rounded uppercase tracking-wider flex-shrink-0">Next</span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-3 mt-0.5">
                      <span className="text-xs text-neutral-500 flex items-center gap-1">
                        <Users size={10} /> {item.partySize} pax
                      </span>
                      <span className="text-xs text-neutral-500 flex items-center gap-1">
                        <Clock size={10} /> {formatDistanceToNow(new Date(item.arrivalTime), { addSuffix: true })}
                      </span>
                      {item.contactNumber && (
                        <span className="text-xs text-neutral-500">{item.contactNumber}</span>
                      )}
                    </div>
                    {item.notes && (
                      <p className="text-[11px] text-neutral-600 mt-1 italic line-clamp-2" title={item.notes}>"{item.notes}"</p>
                    )}
                  </div>

                  {/* Arrival time */}
                  <div className="hidden sm:block text-right flex-none">
                    <p className="text-xs text-neutral-600">{format(new Date(item.arrivalTime), 'h:mm a')}</p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-none">
                    <button
                      onClick={() => handleCallCustomer(item.id, item.customerName)}
                      title="Call customer"
                      className="p-2 bg-amber-600/20 hover:bg-amber-600/40 text-amber-400 rounded-lg transition-colors border border-amber-700/30"
                    >
                      <Bell size={14} />
                    </button>
                    <button
                      onClick={() => {
                        // 🟢 NEW: Delete Confirmation
                        if (window.confirm(`Are you sure you want to remove ${item.customerName} from the queue?`)) {
                          removeFromQueue(item.id);
                          flash("Customer removed from queue.", "success");
                        }
                      }}
                      title="Remove from queue"
                      className="p-2 bg-rose-600/20 hover:bg-rose-600/40 text-rose-400 rounded-lg transition-colors border border-rose-700/30"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Called Customers */}
          {called.length > 0 && (
            <div className="mt-5 space-y-2">
              <h2 className="text-xs text-neutral-600 uppercase tracking-widest font-semibold flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-400" /> Called ({called.length})
              </h2>
              {called.map((item: any) => (
                <div key={item.id} className="bg-neutral-950 border border-blue-900/30 rounded-xl p-3 flex items-center gap-3">
                  <Bell size={14} className="text-blue-400 flex-none" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-neutral-200 truncate">{item.customerName}</p>
                    <p className="text-xs text-neutral-500 truncate">{item.partySize} pax · {item.contactNumber}</p>
                  </div>
                  <button
                    onClick={() => {
                      const targetTable = availableTables[0]?.id;
                      sessionStorage.setItem('assignCustomer', JSON.stringify({
                        kind: 'queue',
                        id: item.id,
                        name: item.customerName,
                        partySize: item.partySize,
                        contact: item.contactNumber,
                        notes: item.notes
                      }));
                      if (targetTable) sessionStorage.setItem('assignTableId', targetTable);
                      navigate('/staff/tables');
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 text-xs font-semibold rounded-lg border border-blue-700/30 transition-colors flex-none"
                  >
                    Assign Table
                  </button>
                  <button
                    onClick={() => {
                      // 🟢 NEW: Delete Confirmation
                      if (window.confirm(`Are you sure you want to remove ${item.customerName} from the queue?`)) {
                        removeFromQueue(item.id);
                        flash("Customer removed from queue.", "success");
                      }
                    }}
                    className="p-1.5 text-neutral-500 hover:text-rose-400 hover:bg-rose-950/30 rounded-lg transition-colors flex-none"
                    title="Remove"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sidebar: Available Tables */}
        <div className="space-y-3">
          <h2 className="text-xs text-neutral-500 uppercase tracking-widest font-semibold flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" /> Available Tables ({availableTables.length})
          </h2>
          {availableTables.length === 0 ? (
            <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-6 text-center">
              <p className="text-sm text-neutral-500">No tables available</p>
              <button onClick={() => navigate('/staff/tables')} className="text-xs text-emerald-500 hover:text-emerald-400 mt-2 font-semibold transition-colors">
                View Table Monitor →
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {availableTables.map((table: any) => (
                <div key={table.id} className="bg-neutral-950 border border-emerald-800/30 rounded-xl p-4 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-semibold text-neutral-200">{table.name}</p>
                    <span className="text-[10px] bg-emerald-500/15 text-emerald-400 font-bold px-2 py-0.5 rounded uppercase border border-emerald-500/20">Free</span>
                  </div>
                  {(checkedInReservations.length > 0 || called.length > 0 || waiting.length > 0) && (() => {
                    let targetCustomer = null;
                    let isRes = false;

                    // 1. Is there a priority reservation strictly assigned to THIS table?
                    const specificRes = checkedInReservations.find((r: any) => r.tableId === table.id);
                    // 2. Is there a priority reservation with NO specific table assignment?
                    const flexibleRes = checkedInReservations.find((r: any) => !r.tableId);

                    if (specificRes) {
                      targetCustomer = specificRes;
                      isRes = true;
                    } else if (flexibleRes) {
                      targetCustomer = flexibleRes;
                      isRes = true;
                    } else {
                      // 🟢 DEFENSE: If priority customers are waiting for OTHER specific tables, bypass them for THIS table so we can seat walk-ins!
                      targetCustomer = called.length > 0 ? called[0] : waiting.length > 0 ? waiting[0] : null;
                    }

                    if (!targetCustomer) return null;

                    return (
                      <button
                        onClick={() => {
                          sessionStorage.setItem('assignCustomer', JSON.stringify({
                            kind: isRes ? 'reservation' : 'queue',
                            id: targetCustomer.id,
                            name: targetCustomer.customerName,
                            partySize: targetCustomer.partySize,
                            contact: targetCustomer.contactNumber,
                            notes: targetCustomer.notes,
                            ...(isRes ? { durationHours: targetCustomer.durationHours, timeSlot: targetCustomer.timeSlot } : {})
                          }));
                          sessionStorage.setItem('assignTableId', table.id);
                          navigate('/staff/tables');
                        }}
                        className={`w-full text-xs py-2 rounded-lg transition-colors font-medium flex items-center justify-center gap-1.5 border ${
                          isRes 
                            ? 'bg-sky-600/20 hover:bg-sky-600/30 text-sky-400 border-sky-700/30'
                            : 'bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border-emerald-700/30'
                        }`}
                      >
                        <UserPlus size={12} />
                        Assign {targetCustomer.customerName} {isRes && specificRes ? '(Reserved)' : ''}
                      </button>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}
          <button
            onClick={() => navigate('/staff/tables')}
            className="w-full text-xs text-neutral-500 hover:text-neutral-300 py-2.5 border border-neutral-800 rounded-xl hover:bg-neutral-900 transition-colors"
          >
            Go to Table Monitor →
          </button>
        </div>
      </div>

      {/* Upcoming Reservations Calendar */}
      <div className="space-y-3 mt-8 border-t border-neutral-800/50 pt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xs text-neutral-500 uppercase tracking-widest font-semibold flex items-center gap-2">
            <CalendarIcon size={14} /> Upcoming Reservations ({upcomingReservations.length})
          </h2>
          <button
            onClick={() => navigate('/staff/reservations')}
            className="text-xs text-emerald-500 hover:text-emerald-400 font-semibold transition-colors"
          >
            View all →
          </button>
        </div>

        {upcomingReservations.length === 0 ? (
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-10 text-center shadow-sm">
            <CalendarIcon size={32} className="mx-auto text-neutral-700 mb-3" />
            <p className="text-neutral-500">No upcoming reservations</p>
          </div>
        ) : (
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl overflow-hidden shadow-sm">
            <div className="divide-y divide-neutral-800/50">
              {upcomingReservations.map((reservation: any) => {
                const minsUntil = differenceInMinutes(new Date(reservation.date), new Date());
                const isNearTime = minsUntil >= 0 && minsUntil <= 60;
                const isPast = minsUntil < 0;
                const tableName = reservation.tableId ? tables.find((t: any) => t.id === reservation.tableId)?.name : null;

                return (
                  <div
                    key={reservation.id}
                    className={`px-4 py-3 hover:bg-neutral-900/60 transition-colors ${isNearTime ? 'bg-amber-500/5 border-l-2 border-amber-500' : ''} ${isPast ? 'opacity-60' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-neutral-200">{reservation.customerName}</p>
                          {isNearTime && (
                            <div className="flex items-center gap-1 bg-amber-500/15 border border-amber-500/30 rounded px-1.5 py-0.5">
                              <AlertCircle size={10} className="text-amber-400" />
                              <span className="text-[10px] text-amber-400 font-bold uppercase tracking-wide">Soon</span>
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 mt-1 text-xs text-neutral-500">
                          <span className="flex items-center gap-1">
                            <Clock size={10} />
                            {isToday(new Date(reservation.date)) ? 'Today' : isTomorrow(new Date(reservation.date)) ? 'Tomorrow' : format(new Date(reservation.date), 'MMM d')}, {reservation.timeSlot}
                          </span>
                          <span>{reservation.durationHours}h</span>
                          <span>{reservation.partySize} pax</span>
                          {tableName && (
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded font-bold border ${
                                isNearTime ? 'bg-amber-500/20 text-amber-400 border-amber-500/30 animate-pulse' : 'bg-neutral-800 text-neutral-400 border-neutral-700'
                              }`}
                            >
                              {tableName}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setCancelTarget(reservation.id);
                          setShowCancelDialog(true);
                        }}
                        className="flex-none p-1.5 text-neutral-600 hover:text-rose-400 hover:bg-rose-950/30 rounded-lg transition-colors"
                        title="Cancel reservation"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Cancel Reservation Dialog */}
      {showCancelDialog && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="px-6 py-4 border-b border-neutral-800 flex justify-between items-center">
              <div>
                <h2 className="text-base font-bold text-neutral-100">Cancel Reservation</h2>
                <p className="text-xs text-neutral-500">Are you sure?</p>
              </div>
              <button onClick={() => setShowCancelDialog(false)} className="p-2 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors">
                <X size={16} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="space-y-2">
                <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Reason for cancellation</label>
                <select
                  value={cancelReason}
                  onChange={e => setCancelReason(e.target.value)}
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-3 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                >
                  <option value="">Select reason...</option>
                  <option value="Customer no-show">Customer no-show</option>
                  <option value="Customer requested">Customer requested</option>
                  <option value="Overbooking">Overbooking</option>
                  <option value="Table unavailable">Table unavailable</option>
                  <option value="Payment not received">Payment not received</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowCancelDialog(false)} className="px-4 py-3 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl font-bold transition-colors">
                  Keep Booking
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (cancelTarget) {
                      cancelReservation(cancelTarget, cancelReason || 'No reason provided');
                      setShowCancelDialog(false);
                      setCancelReason('');
                      setCancelTarget(null);
                      flash("Reservation cancelled successfully.", "success");
                    }
                  }}
                  className="flex-1 px-4 py-3 bg-rose-600 hover:bg-rose-500 text-white text-sm rounded-xl font-bold transition-all shadow-lg shadow-rose-900/30 flex items-center justify-center gap-2"
                >
                  <X size={15} /> Confirm Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}