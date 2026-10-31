import { localFetch } from '../utils/localApi';
import { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { useNavigate } from 'react-router';
import {
  TableProperties, Users, Calendar, 
  AlertTriangle, Clock, ChevronRight, CheckCircle2, ShieldAlert,
  Wifi, RefreshCw, Database, Download, X
} from 'lucide-react';
import { addMinutes, differenceInSeconds, differenceInMinutes, format } from 'date-fns';

const formatPHP = (amount: number) =>
  `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

function StatCard({ label, value, sub, color, icon: Icon, onClick }: {
  label: string; value: string | number; sub?: string;
  color: string; icon: React.ElementType; onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`bg-neutral-950 border border-neutral-800 rounded-xl p-5 flex items-start justify-between ${onClick ? 'cursor-pointer hover:border-neutral-700 transition-colors' : ''}`}
    >
      <div>
        <p className="text-xs text-neutral-500 uppercase tracking-wider font-semibold mb-1">{label}</p>
        <p className={`text-3xl font-black ${color}`}>{value}</p>
        {sub && <p className="text-xs text-neutral-500 mt-1">{sub}</p>}
      </div>
      <div className={`p-2.5 rounded-lg ${color.replace('text-', 'bg-').replace('-400', '-500/10').replace('-500', '-500/10')}`}>
        <Icon size={20} className={color} />
      </div>
    </div>
  );
}

export function OverviewDashboard() {
  const { 
    tables, queue, reservations, watchlist, 
    staffUsers, promoCodes, announcements, closedDates, rates, 
    staffProfile,availableTables,heldTableIds,reservationMoveError
  } = useAppContext() as any;
  const navigate = useNavigate();

  // ── Connectivity & Local Backup State ─────────────────────────
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date>(new Date());
  const [isBrowserOffline, setIsBrowserOffline] = useState(!navigator.onLine);
  const [offlineSince, setOfflineSince] = useState<Date | null>(null);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupSuccess, setBackupSuccess] = useState(false);
  const backupInFlight = useRef(false);

  useEffect(() => {
    const handleOnline = () => {
      setIsBrowserOffline(false);
      setOfflineSince(null);
    };
    const handleOffline = () => {
      setIsBrowserOffline(true);
      setOfflineSince(new Date());
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const isFullyOffline = isBrowserOffline;
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


  const handleRunLocalBackup = async () => {
    if (backupInFlight.current) return;
    if (!staffProfile?.isAdmin) { flash('Administrator required to download a full backup.', 'error'); return; }
    backupInFlight.current = true;
    setIsBackingUp(true);
    setBackupSuccess(false);
    let url: string | undefined;
    try {
      const response = await localFetch('http://localhost:3001/api/backup');
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(response.status === 403 ? 'Administrator required to download a full backup.' : data.error || 'The local backup could not be downloaded.');
      }
      const blob = await response.blob();
      if (blob.size < 100 || await blob.slice(0, 16).text() !== 'SQLite format 3\0') throw new Error('The server did not return a valid database backup.');
      url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `oneshot-backup-${format(new Date(), 'yyyy-MM-dd_HHmmss')}.sqlite`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setBackupSuccess(true);
      flash('Backup download started. Keep it private: it contains account and customer data.', 'success');
      setTimeout(() => setBackupSuccess(false), 5000);
    } catch (error: any) {
      flash(error.message || 'The local backup could not be downloaded.', 'error');
    } finally {
      if (url) { const completedUrl = url; setTimeout(() => URL.revokeObjectURL(completedUrl), 1000); }
      backupInFlight.current = false;
      setIsBackingUp(false);
    }
  };

  const handleManualSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    flash("Uploading local data to cloud...", "loading");
    try {
      const response = await localFetch('http://localhost:3001/api/sync-to-cloud', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.details || data.error || 'Supabase rejected the sync payload.');
      setLastSync(new Date());
      flash("Database successfully backed up to Cloud.", "success");
    } catch (error: any) {
      flash(`Sync Failed: ${error.message || 'Could not reach server'}`, 'error');
    } finally {
      setIsSyncing(false);
    }
  };

  const activeWatchlist = watchlist?.filter((w: any) => w.status === 'active' && !w.isArchived) || [];

  const available = availableTables.length;
  const occupied = tables.filter((t: any) => t.isActive && t.status === 'occupied').length;
  const reserved = tables.filter((t: any) => t.isActive && t.status === 'reserved').length;
  const waiting = queue.filter((q: any) => q.status === 'waiting').length;

  const waitingQueue = queue.filter((q: any) => q.status === 'waiting');
  const occupiedWithSession = tables.filter((t: any) => t.isActive && t.status === 'occupied' && t.session && !heldTableIds.has(t.id));

  const sortedEndTimes = occupiedWithSession
    .map((t: any) => addMinutes(new Date(t.session!.startTime), t.session!.durationMinutes || 0))
    .sort((a: any, b: any) => a.getTime() - b.getTime());

  const estimateWaitForPosition = (position: number): string => {
    if(reservationMoveError)return 'Check transfer recovery';
    const slotsNeeded = position - available;
    if (slotsNeeded <= 0) return 'Now';
    if (slotsNeeded > sortedEndTimes.length) return 'TBD';
    const endTime = sortedEndTimes[slotsNeeded - 1];
    const mins = Math.max(0, differenceInMinutes(endTime, new Date()));
    if (mins === 0) return '< 1 min';
    if (mins < 5) return '< 5 min';
    return `~${mins} min`;
  };

  const overallWait = waitingQueue.length > 0 ? estimateWaitForPosition(waitingQueue.length) : null;

  // 🟢 ENHANCED: Open Time is officially classified and visually tracked as Overtime
  const overtimeTables = tables.filter((t: any) => {
    if (!t.isActive || t.status !== 'occupied' || !t.session) return false;
    if (t.session.isOpenTime || t.session.durationMinutes === null) return true;
    const end = addMinutes(new Date(t.session.startTime), t.session.durationMinutes);
    return new Date() > end;
  });

 const alertTables = tables.filter((t: any) => {
    if (!t.isActive || t.status !== 'occupied' || !t.session) return false;
    if (t.session.isOpenTime || t.session.durationMinutes === null) return false; // Handled strictly by Overtime
    const end = addMinutes(new Date(t.session.startTime), t.session.durationMinutes);
    const secsLeft = differenceInSeconds(end, new Date());
    return secsLeft > 0 && secsLeft <= 900;
  });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const upcomingReservations = reservations
    .filter((r: any) => {
      if (r.status !== 'pending' && r.status !== 'confirmed') return false;
      const resDate = new Date(r.date);
      resDate.setHours(0, 0, 0, 0);
      return resDate.getTime() >= todayStart.getTime();
    })
    .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, 4);
    
  const getReservationStatusColor = (status: string) => {
    switch (status) {
      case 'confirmed': return 'text-emerald-400 bg-emerald-500/10';
      case 'pending': return 'text-amber-400 bg-amber-500/10';
      case 'checked-in': return 'text-blue-400 bg-blue-500/10';
      case 'completed': return 'text-neutral-400 bg-neutral-800';
      case 'cancelled': return 'text-rose-400 bg-rose-500/10';
      default: return 'text-neutral-400 bg-neutral-800';
    }
  };

 return (
    <div className="space-y-6 relative">
      {reservationMoveError&&<p role="alert" className="rounded-xl border border-amber-900 p-4 text-sm text-amber-300">Table availability needs verification. Open Table Monitor and refresh transfer recovery before assigning a table.</p>}
      
      {/* 🟢 TOP-RIGHT FLOATING TOAST WITH 5S TIMER & FADE OUT */}
      {toastState && (
        <div 
          className="fixed top-6 right-6 z-[9999] animate-in slide-in-from-top-4 fade-in duration-300"
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
              {toastState.type === 'success' ? <CheckCircle2 size={18} /> : toastState.type === 'loading' ? <RefreshCw size={18} className="animate-spin" /> : <AlertTriangle size={18} />}
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

      {/* ── Real-Time Status & Cloud Sync Bar ── */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl flex-shrink-0 ${
            isFullyOffline ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'
          }`}>
            {isFullyOffline ? <RefreshCw size={22} className="animate-spin" /> : <Wifi size={22} />}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-300">
                System Status
              </span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                isFullyOffline 
                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' 
                  : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              }`}>
                {isFullyOffline ? 'RECONNECTING TO CLOUD...' : 'ONLINE & SYNCED'}
              </span>
              <span className="text-neutral-700 hidden sm:inline">|</span>
              <span className="text-[11px] text-neutral-400 font-medium flex items-center gap-1">
                <Database size={11} className="text-emerald-500" /> Local Database Active
              </span>
            </div>
            <p className="text-xs text-neutral-500 mt-1">
              {isFullyOffline
                ? `Cloud disconnected${offlineSince ? ` since ${format(offlineSince, 'hh:mm a')}` : ''}. Continually attempting to reconnect...`
                : `Connected to Cloud Server. Last cloud sync completed at ${format(lastSync, 'hh:mm a')}.`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-end lg:self-auto">
          {backupSuccess && (
            <span className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5 mr-1 animate-fade-in">
              <CheckCircle2 size={14} /> Local JSON Saved
            </span>
          )}
          
          <button
            onClick={handleManualSync}
            disabled={isSyncing}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-bold transition-all border ${
              isSyncing 
                ? 'bg-neutral-900 text-neutral-500 border-neutral-800 cursor-wait' 
                : 'bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-400 border-emerald-600/20'
            }`}
          >
            <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} />
            <span>{isSyncing ? 'Syncing to Cloud...' : 'Run Cloud Backup'}</span>
          </button>

          {staffProfile?.isAdmin && (
            <button
              onClick={handleRunLocalBackup}
              disabled={isBackingUp}
              className="flex items-center gap-2 px-3.5 py-2 bg-neutral-900 hover:bg-neutral-800 border border-neutral-700/60 text-neutral-200 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
            >
              {isBackingUp ? (
                <RefreshCw size={14} className="animate-spin text-amber-400" />
              ) : (
                <Download size={14} className="text-amber-400" />
              )}
              <span>Download Local Backup</span>
            </button>
          )}
        </div>
      </div>

      {/* Alerts */}
      {(overtimeTables.length > 0 || alertTables.length > 0) && (
        <div className="space-y-2">
          {overtimeTables.map((t: any) => {
            const isOpen = t.session?.isOpenTime || t.session?.durationMinutes === null;
            return (
              <div key={t.id} className="flex items-center gap-3 bg-rose-950/30 border border-rose-800/40 rounded-xl px-4 py-3">
                <AlertTriangle size={16} className="text-rose-400 flex-none" />
                <span className="text-sm text-rose-300">
                  <strong>{t.name}</strong> — <span className="font-medium">{t.session?.customerName}</span>'s session {isOpen ? 'is on Open Time. Charges are actively accumulating.' : 'has exceeded the paid time. Overtime charges may apply.'}
                </span>
                <button onClick={() => navigate('/staff/tables')} className="ml-auto text-xs text-rose-400 hover:text-rose-300 font-semibold flex items-center gap-1">
                  View <ChevronRight size={12} />
                </button>
              </div>
            );
          })}
          {alertTables.map((t: any) => (
            <div key={t.id} className="flex items-center gap-3 bg-amber-950/30 border border-amber-800/40 rounded-xl px-4 py-3">
              <Clock size={16} className="text-amber-400 flex-none" />
              <span className="text-sm text-amber-300">
                <strong>{t.name}</strong> — <span className="font-medium">{t.session?.customerName}</span>'s session ends in less than 15 minutes.
              </span>
              <button onClick={() => navigate('/staff/tables')} className="ml-auto text-xs text-amber-400 hover:text-amber-300 font-semibold flex items-center gap-1">
                View <ChevronRight size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Available Tables" value={reservationMoveError?'—':available} sub={reservationMoveError?'Check transfer recovery':`of ${tables.length} total`} color="text-emerald-400" icon={TableProperties} onClick={() => navigate('/staff/tables')} />
        <StatCard label="Occupied" value={occupied} sub={`${reserved} reserved`} color="text-amber-400" icon={TableProperties} onClick={() => navigate('/staff/tables')} />
        <StatCard label="Waiting Queue" value={waiting} sub="FCFS order" color="text-purple-400" icon={Users} onClick={() => navigate('/staff/queue')} />
        <StatCard label="Overtime Tables" value={overtimeTables.length} sub="Requires attention" color="text-rose-400" icon={Clock} onClick={() => navigate('/staff/tables')} />
      </div>

      {/* Table Grid Quick View */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-neutral-300">Table Status</h2>
          <button onClick={() => navigate('/staff/tables')} className="text-xs text-emerald-500 hover:text-emerald-400 flex items-center gap-1 font-semibold">
            Manage Tables <ChevronRight size={12} />
          </button>
        </div>
        <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
          {tables.filter((t: any) => t.isActive).map((t: any) => {
            const isOpenTime = t.status === 'occupied' && t.session && (t.session.isOpenTime || t.session.durationMinutes === null);
            const isOvertime = t.status === 'occupied' && t.session && (isOpenTime || new Date() > addMinutes(new Date(t.session.startTime), t.session.durationMinutes!));
            const isAlert = !isOvertime && t.status === 'occupied' && t.session && (() => {
              const end = addMinutes(new Date(t.session!.startTime), t.session!.durationMinutes!);
              const secs = differenceInSeconds(end, new Date());
              return secs > 0 && secs <= 900;
            })();
            
            return (
              <div
                key={t.id}
                onClick={() => navigate('/staff/tables')}
                title={`${t.name}${t.session ? ` — ${t.session.customerName}` : ''} (${heldTableIds.has(t.id)?'transfer held':t.status})`}
                className={`aspect-square rounded-lg flex flex-col items-center justify-center text-center px-1 leading-tight cursor-pointer border transition-all text-[10px] font-bold
                  ${heldTableIds.has(t.id)||reservationMoveError ? 'bg-neutral-800/80 border-amber-800 text-amber-300' :
                    t.status === 'maintenance' ? 'bg-neutral-800/80 border-neutral-700 text-neutral-400 opacity-70' :
                    isOvertime ? 'bg-rose-500/20 border-rose-500 text-rose-400 animate-pulse' :
                    isAlert ? 'bg-rose-950/40 border-rose-500/50 text-rose-400' :
                    t.status === 'occupied' ? 'bg-amber-950/40 border-amber-800/40 text-amber-400' :
                    t.status === 'reserved' ? 'bg-cyan-950/40 border-cyan-800/40 text-cyan-400' :
                    'bg-emerald-950/20 border-emerald-800/30 text-emerald-400'}
                `}
              >
                {t.name.replace(/table\s*/i, '')}
                {heldTableIds.has(t.id)&&<span className="mt-1">Transfer held</span>}
              </div>
            );
          })}
        </div>
        
        <div className="flex flex-wrap items-center gap-4 mt-4">
          {[
            { color: 'bg-emerald-500', label: 'Open' },
            { color: 'bg-amber-500', label: 'In Use' },
            { color: 'bg-rose-500', label: 'Overtime / Open Time' },
            { color: 'bg-cyan-500', label: 'Reserved' },
            { color: 'bg-neutral-500', label: 'Maintenance' },
          ].map(item => (
            <div key={item.label} className="flex items-center gap-1.5">
              <span className={`w-2.5 h-2.5 rounded-sm ${item.color}`} />
              <span className="text-xs text-neutral-400 font-medium">{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Upcoming Reservations */}
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-neutral-300 flex items-center gap-2">
              <Calendar size={15} className="text-neutral-500" /> Upcoming Reservations
            </h2>
            <button onClick={() => navigate('/staff/reservations')} className="text-xs text-emerald-500 hover:text-emerald-400 flex items-center gap-1 font-semibold">
              View All <ChevronRight size={12} />
            </button>
          </div>
          {upcomingReservations.length === 0 ? (
            <div className="text-center py-6">
              <Calendar size={24} className="mx-auto text-neutral-700 mb-2" />
              <p className="text-sm text-neutral-600">No upcoming reservations</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {upcomingReservations.map((r: any) => (
                <div key={r.id} className="flex items-center gap-3 bg-neutral-900 rounded-lg px-3 py-2.5 border border-neutral-800/60">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-neutral-200 truncate">{r.customerName}</p>
                    <p className="text-xs text-neutral-500">
                      {format(new Date(r.date), 'MMM d')} · {r.timeSlot} · {r.durationHours}h · {r.partySize} pax
                    </p>
                  </div>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${getReservationStatusColor(r.status)}`}>
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Queue Snapshot */}
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-neutral-300 flex items-center gap-2">
              <Users size={15} className="text-neutral-500" /> Walk-in Queue
              {waiting > 0 && <span className="bg-amber-500 text-black text-[10px] font-black rounded-full w-4 h-4 flex items-center justify-center">{waiting}</span>}
            </h2>
            <button onClick={() => navigate('/staff/queue')} className="text-xs text-emerald-500 hover:text-emerald-400 flex items-center gap-1 font-semibold">
              Manage <ChevronRight size={12} />
            </button>
          </div>
          {waitingQueue.length === 0 ? (
            <div className="flex items-center gap-2 py-2">
              <CheckCircle2 size={16} className="text-emerald-500" />
              <p className="text-sm text-neutral-500">No customers waiting</p>
            </div>
          ) : (
            <div className="space-y-2">
              {waitingQueue.slice(0, 3).map((q: any, i: number) => {
                const est = estimateWaitForPosition(i + 1);
                const isNow = est === 'Now';
                return (
                  <div key={q.id} className="flex items-center gap-2.5 text-sm">
                    <span className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center text-[10px] font-bold text-neutral-400 flex-none">{i + 1}</span>
                    <span className="text-neutral-300 font-medium flex-1 truncate">{q.customerName}</span>
                    <span className="text-xs text-neutral-500 flex-none">{q.partySize} pax</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-none ${isNow ? 'bg-emerald-500/15 text-emerald-400' : 'bg-neutral-800 text-neutral-500'}`}>
                      {isNow ? '✓ Now' : est}
                    </span>
                  </div>
                );
              })}
              {waitingQueue.length > 3 && (
                <p className="text-xs text-neutral-600 pl-7">+{waitingQueue.length - 3} more</p>
              )}
              <div className="flex items-center justify-between pt-2 mt-1 border-t border-neutral-800/60">
                <span className="text-[10px] text-neutral-600 flex items-center gap-1">
                  <Clock size={10} /> Est. max wait
                </span>
                <span className={`text-[10px] font-semibold ${overallWait === 'Now' ? 'text-emerald-400' : overallWait === 'TBD' ? 'text-neutral-500' : 'text-amber-400'}`}>
                  {overallWait}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Watchlist Snapshot */}
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-neutral-300 flex items-center gap-2">
              <ShieldAlert size={15} className="text-rose-500" /> Security Watchlist
              {activeWatchlist.length > 0 && <span className="bg-rose-500 text-white text-[10px] font-black rounded-full px-2 py-0.5 flex items-center justify-center">{activeWatchlist.length}</span>}
            </h2>
            <button onClick={() => navigate('/staff/watchlist')} className="text-xs text-rose-500 hover:text-rose-400 flex items-center gap-1 font-semibold">
              Manage <ChevronRight size={12} />
            </button>
          </div>
          {activeWatchlist.length === 0 ? (
            <div className="flex items-center gap-2 py-2">
              <CheckCircle2 size={16} className="text-emerald-500" />
              <p className="text-sm text-neutral-500">No active security alerts</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {activeWatchlist.slice(0, 4).map((w: any) => (
                <div key={w.id} className="flex flex-col gap-1 bg-rose-950/20 rounded-lg px-3 py-2.5 border border-rose-900/30">
                  <div className="flex justify-between items-center">
                    <p className="text-sm font-bold text-rose-400 truncate pr-2">{w.name}</p>
                    <span className="text-[9px] uppercase tracking-wider font-bold bg-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded flex-shrink-0">{w.reason}</span>
                  </div>
                  <p className="text-xs text-neutral-400 line-clamp-1">{w.description}</p>
                </div>
              ))}
              {activeWatchlist.length > 4 && (
                <p className="text-xs text-rose-500/70 pl-2">+{activeWatchlist.length - 4} more flagged</p>
              )}
            </div>
          )}
        </div>

      </div>



    </div>
  );
}
