import { useState, useEffect, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { 
  Users, Table2, Tag, Megaphone, CalendarX2, DollarSign, 
  TrendingUp, Bell, CloudRain, Sun, Cloud, MapPin, 
  Database, RefreshCw, CalendarDays, ArrowRight, ShieldCheck,
  Wifi, WifiOff, Download, CheckCircle2, CheckCircle, AlertTriangle, X
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { format, isToday, isTomorrow } from 'date-fns';
import { ReservationStatusBadge } from '../components/ReservationStatusBadge';
import { PesoSign } from '../components/PesoSign';

export function AdminDashboard() {
  const { 
    staffUsers, tables, promoCodes, announcements, closedDates, 
    rates, reservations, feedback, weather, updateWeatherLocation, 
    activities, sessionHistory, refreshLiveMonitor, isSystemOffline,
    queue, watchlist
  } = useAppContext() as any;
  
  const navigate = useNavigate();

  const [isEditingWeather, setIsEditingWeather] = useState(false);
  const [locationQuery, setLocationQuery] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date>(new Date());

  // 🟢 TOAST STATE WITH 5S TIMER & FADE OUT
  const [toast, setToast] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  const toastTimeout = useRef<NodeJS.Timeout | null>(null);

  const flash = (msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToast({ msg, type });
    toastTimeout.current = setTimeout(() => setToast(null), 5000); // 5 seconds
  };

  // ── Connectivity & Local Backup State ─────────────────────────
  const [isBrowserOffline, setIsBrowserOffline] = useState(!navigator.onLine);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [backupSuccess, setBackupSuccess] = useState(false);
  const [offlineSince, setOfflineSince] = useState<Date | null>(null);

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

  const isFullyOffline = isBrowserOffline || isSystemOffline;

  useEffect(() => {
    if (isFullyOffline && !offlineSince) {
      setOfflineSince(new Date());
    } else if (!isFullyOffline && offlineSince) {
      setOfflineSince(null);
    }
  }, [isFullyOffline, offlineSince]);

  const handleRunLocalBackup = () => {
    setIsBackingUp(true);
    setBackupSuccess(false);

    try {
      const backupPayload = {
        timestamp: new Date().toISOString(),
        tables,
        queue,
        reservations,
        watchlist,
        staffUsers,
        promoCodes,
        announcements,
        closedDates,
        rates,
      };

      const blob = new Blob([JSON.stringify(backupPayload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `oneshot-admin-backup-${format(new Date(), 'yyyy-MM-dd_HHmm')}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setBackupSuccess(true);
      setTimeout(() => setBackupSuccess(false), 3000);
    } catch (err) {
      console.error('Backup failed:', err);
    } finally {
      setIsBackingUp(false);
    }
  };

  // ── Dashboard Calculations ────────────────────────────────────
  const activeUsers     = staffUsers.filter((u: any) => u.isActive).length;
  const activePromos    = promoCodes.filter((p: any) => p.isActive).length;
  const activeAnn       = announcements.filter((a: any) => a.isActive).length;
  const upcomingClosed  = closedDates.filter((c: any) => new Date(c.date) >= new Date()).length;
  
 const totalRevenue = 
    reservations.filter((r: any) => r.status === 'completed').reduce((s: number, r: any) => s + r.totalAmount, 0) +
    (sessionHistory || []).reduce((s: number, sh: any) => s + (sh.totalAmount || 0), 0);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const pendingReservations = reservations
    .filter((r: any) => {
      if (r.status !== 'pending' && r.status !== 'confirmed') return false;
      const resDate = new Date(r.date);
      resDate.setHours(0, 0, 0, 0);
      return resDate.getTime() >= todayStart.getTime();
    })
    .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const handleManualSync = async () => {
    if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
      flash("Action Denied: Cloud Backup must be run from the physical computer at the bar, not from the public Vercel website.", "error");
      return;
    }

    setIsSyncing(true);
    try {
      const res = await fetch('http://localhost:3001/api/sync-to-cloud', { method: 'POST' });
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.details || 'Supabase rejected the sync payload.');
      }

      if (refreshLiveMonitor) await refreshLiveMonitor();
      setLastSync(new Date());
      flash("Database successfully backed up to Cloud.", "success");
      
    } catch (e: any) {
      console.error(e);
      flash(`Sync Failed: ${e.message}`, "error");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleWeatherSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (locationQuery.trim()) {
      // Basic coordinates for the search query (simplified for demo)
      updateWeatherLocation('14.5995', '120.9842', locationQuery.trim());
      setIsEditingWeather(false);
    }
  };

  const getDynamicAlerts = () => {
    const alerts = [];
    const timeSinceSync = (new Date().getTime() - lastSync.getTime()) / (1000 * 60 * 60);
    
    if (timeSinceSync > 24) {
       alerts.push({
         id: 'alert_sync', title: 'Cloud Sync Overdue',
         desc: 'Local data has not been backed up to Cloud in over 24 hours. Run a manual sync to ensure data safety.',
         style: { box: 'bg-rose-950/20 border-rose-900/30', dot: 'bg-rose-500', title: 'text-rose-400', btn: 'bg-rose-600/20 text-rose-400 hover:bg-rose-600/30 border-rose-500/20' },
         action: { label: 'Sync Now', onClick: handleManualSync }
       });
    }

    const todayRes = pendingReservations.filter((r: any) => isToday(new Date(r.date)));
    if (tables.length > 0 && todayRes.length > (tables.length * 2)) {
      alerts.push({
         id: 'alert_res', title: 'High Booking Volume',
         desc: `There are ${todayRes.length} reservations scheduled for today. Consider limiting walk-ins.`,
         style: { box: 'bg-emerald-950/20 border-emerald-900/30', dot: 'bg-emerald-500', title: 'text-emerald-400', btn: 'bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 border-emerald-500/20' },
         action: { label: 'Adjust Limits', onClick: () => navigate('/admin/policy-rates') }
       });
    }

    const recentVoids = activities.filter((a: any) => a.type === 'admin_action' && a.description.includes('Voided') && new Date(a.timestamp).getTime() > Date.now() - 86400000);
    if (recentVoids.length > 5) {
       alerts.push({
         id: 'alert_voids', title: 'Unusual POS Activity',
         desc: `Detected ${recentVoids.length} voided transactions in the last 24 hours. Please review the system logs.`,
         style: { box: 'bg-rose-950/20 border-rose-900/30', dot: 'bg-rose-500', title: 'text-rose-400', btn: 'bg-rose-600/20 text-rose-400 hover:bg-rose-600/30 border-rose-500/20' },
         action: { label: 'View Logs', onClick: () => navigate('/admin/activity') }
       });
    }

    if (weather?.isRaining) {
      alerts.push({
         id: 'alert_weather', title: 'Inclement Weather Detected',
         desc: 'Rain is forecasted. Predictive models suggest a 30% increase in indoor walk-in traffic.',
         style: { box: 'bg-blue-950/20 border-blue-900/30', dot: 'bg-blue-500', title: 'text-blue-400', btn: '' },
       });
    }
    return alerts;
  };

  const dynamicAlerts = getDynamicAlerts();

  return (
    <div className="space-y-6 relative">
      
      {/* 🟢 TOP-RIGHT FLOATING TOAST WITH 5S TIMER & FADE OUT */}
      {toast && (
        <div 
          className="fixed top-6 right-6 z-[9999] animate-in slide-in-from-top-4 fade-in duration-300"
          style={{ animation: 'toast-fade-out 5s forwards' }}
        >
          <div className={`relative overflow-hidden flex items-start gap-3 px-5 py-4 rounded-xl border shadow-2xl backdrop-blur-md min-w-[320px] max-w-md ${
            toast.type === 'success' 
              ? 'bg-emerald-950/90 border-emerald-900/50 text-emerald-400' 
              : 'bg-rose-950/90 border-rose-900/50 text-rose-400'
          }`}>
            <div className="mt-0.5 flex-shrink-0">
              {toast.type === 'success' ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
            </div>
            <span className="text-sm font-semibold leading-snug whitespace-pre-wrap pr-4">{toast.msg}</span>
            <button 
              onClick={() => { setToast(null); if (toastTimeout.current) clearTimeout(toastTimeout.current); }} 
              className="absolute top-4 right-4 text-neutral-500 hover:text-white transition-colors"
            >
              <X size={14} />
            </button>
            <div 
              className={`absolute bottom-0 left-0 h-1 ${toast.type === 'success' ? 'bg-emerald-500' : 'bg-rose-500'}`}
              style={{ animation: 'toast-shrink 5s linear forwards' }}
            />
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

      {/* ── MERGED: System Connectivity & Database Backup Operator Banner ── */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-start sm:items-center gap-3">
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
          
          {/* Cloud Sync Button */}
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

          {/* Local JSON Backup Button */}
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
            <span>Run Local Backup</span>
          </button>
        </div>
      </div>

      {/* ── Dashboard Welcome & Weather Grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-6 items-stretch">
        
        {/* Main Welcome */}
        <div className={`flex flex-col justify-between h-full bg-neutral-950 border border-neutral-800 rounded-2xl p-6 md:col-span-2 ${weather ? 'lg:col-span-8' : 'lg:col-span-12'}`}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-black text-neutral-100 mb-1">Admin Dashboard</h1>
              <p className="text-sm text-neutral-500">Full control over One Shot Bar & Billiards operations.</p>
            </div>
            <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 rounded-xl flex-shrink-0">
              <PesoSign size={15} className="text-emerald-500" />
              <div>
                <p className="text-xs font-black text-emerald-500">₱{totalRevenue.toLocaleString()}</p>
                <p className="text-[10px] text-emerald-600/80 font-bold uppercase tracking-wider">Total Revenue</p>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-5">
            {[
              { label: 'Hourly Rate', value: `₱${rates.hourlyRate}/hr` },
              { label: 'Happy Hour', value: `₱${rates.weekdayHappyHourRate}/hr` },
              { label: 'Down Payment', value: `${rates.downPaymentPercent}%` },
            ].map(r => (
              <button key={r.label} onClick={() => navigate('/admin/policy-rates')}
                className="bg-emerald-500/5 border border-emerald-500/10 hover:bg-emerald-500/10 rounded-xl p-3 text-left transition-colors h-full flex flex-col justify-between">
                <p className="text-sm font-black text-emerald-500">{r.value}</p>
                <p className="text-[10px] text-emerald-600/80 uppercase tracking-wider mt-1 font-bold">{r.label}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Weather API Display */}
        {weather && (
          <div className={`flex flex-col justify-center h-full border rounded-2xl p-5 relative overflow-hidden md:col-span-2 lg:col-span-4 ${weather.isRaining ? 'bg-blue-950/20 border-blue-900/30' : 'bg-neutral-950 border-neutral-800'}`}>
            {weather.isRaining && <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none" />}
            <div className="flex items-center justify-between mb-3 relative z-10">
              <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold">Live Weather</p>
              <div className="flex items-center gap-2">
                {isEditingWeather ? (
                  <form onSubmit={handleWeatherSubmit} className="flex items-center gap-1">
                    <input type="text" value={locationQuery} onChange={e => setLocationQuery(e.target.value)} className="bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[10px] text-neutral-100 outline-none focus:border-emerald-500 w-24" placeholder={weather.locationName} autoFocus />
                  </form>
                ) : (
                  <button onClick={() => setIsEditingWeather(true)} className="flex items-center gap-1 text-[9px] text-neutral-400 hover:text-neutral-100 transition-colors bg-neutral-900 px-2 py-1 rounded border border-neutral-800 truncate max-w-[120px]">
                    <MapPin size={10} className="flex-shrink-0" /> <span className="truncate">{weather.locationName}</span>
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-4 relative z-10">
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${weather.isRaining ? 'bg-blue-500/20 text-blue-400' : weather.condition === 'Clear' ? 'bg-amber-500/20 text-amber-400' : 'bg-neutral-800 text-neutral-400'}`}>
                {weather.isRaining ? <CloudRain size={24} /> : weather.condition === 'Clear' ? <Sun size={24} /> : <Cloud size={24} />}
              </div>
              <div className="min-w-0">
                <p className="text-3xl font-black text-neutral-100 truncate">{Math.round(weather.temp)}°C</p>
                <p className="text-xs font-semibold text-neutral-400 truncate">{weather.condition}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {[
          { label: 'Staff Users',       value: activeUsers,       total: staffUsers.length,       color: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/20',    icon: Users,        link: '/admin/users' },
          { label: 'Tables',            value: (tables || []).filter((t: any)=> (t.isActive === true || t.isActive === 1 || t.isactive === 1 || t.isactive === true) && t.status==='available').length, total: (tables || []).filter((t: any)=> (t.isActive === true || t.isActive === 1 || t.isactive === 1 || t.isactive === true)).length, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: Table2, link: '/admin/tables' },
          { label: 'Active Promos',     value: activePromos,      total: promoCodes.length,       color: 'text-violet-400',  bg: 'bg-violet-500/10',  border: 'border-violet-500/20',  icon: Tag,          link: '/admin/events' },
          { label: 'Live Announcements',value: activeAnn,         total: announcements.length,    color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: Megaphone,    link: '/admin/announcements' },
          { label: 'Upcoming Closures', value: upcomingClosed,    total: closedDates.length,      color: 'text-rose-400',    bg: 'bg-rose-500/10',    border: 'border-rose-500/20',    icon: CalendarX2,   link: '/admin/events' },
        ].map(c => (
          <button key={c.label} onClick={() => navigate(c.link)} className={`bg-neutral-950 border rounded-xl p-4 text-left hover:scale-[1.02] transition-all group ${c.border}`}>
            <div className="flex items-start justify-between mb-3"><div className={`p-2 rounded-lg ${c.bg}`}><c.icon size={16} className={c.color} /></div></div>
            <p className={`text-2xl font-black ${c.color}`}>{c.value}</p>
            <p className="text-[11px] text-neutral-500 mt-1 font-medium">{c.label}{c.total !== undefined && <span className="text-neutral-700"> · {c.total} total</span>}</p>
          </button>
        ))}
      </div>

      {/* ── Dynamic Layout Bottom Half ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-5 flex flex-col h-[400px]">
          <h3 className="text-sm font-bold text-neutral-200 mb-4 flex items-center gap-2"><Bell size={15} className="text-sky-400" /> System Intelligence Alerts</h3>
          <div className="space-y-3 overflow-y-auto pr-2 flex-1">
            {dynamicAlerts.length === 0 ? (
              <div className="text-center py-10 opacity-50">
                <ShieldCheck size={32} className="mx-auto mb-3 text-emerald-500" />
                <p className="text-xs text-neutral-400">All systems operational.</p>
              </div>
            ) : (
              dynamicAlerts.map(alert => (
                <div key={alert.id} className={`p-3.5 rounded-xl border flex flex-col ${alert.style.box}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className={`w-2 h-2 rounded-full ${alert.style.dot} flex-shrink-0`} />
                    <p className={`text-xs font-bold ${alert.style.title}`}>{alert.title}</p>
                  </div>
                  <p className="text-[11px] text-neutral-400 leading-relaxed mb-3">{alert.desc}</p>
                  {alert.action && (
                    <button onClick={alert.action.onClick} className={`align-self-start self-start text-[10px] font-bold px-3 py-1.5 rounded-lg transition-colors border ${alert.style.btn}`}>
                      {alert.action.label}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-5 flex flex-col h-[400px]">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-neutral-200 flex items-center gap-2"><CalendarDays size={15} className="text-purple-400" /> Incoming Bookings</h3>
            <span className="text-[10px] bg-neutral-800 px-2 py-0.5 rounded font-bold text-neutral-400">{pendingReservations.length} Active</span>
          </div>
          <div className="space-y-2 overflow-y-auto pr-2 flex-1">
            {pendingReservations.length === 0 ? <p className="text-xs text-neutral-500 italic text-center py-6">No upcoming reservations</p> : (
              pendingReservations.slice(0, 10).map((r: any) => {
                const isTodayRes = isToday(new Date(r.date));
                const isTomorrowRes = isTomorrow(new Date(r.date));
                const dateLabel = isTodayRes ? 'Today' : isTomorrowRes ? 'Tomorrow' : format(new Date(r.date), 'MMM d');
                return (
                  <div key={r.id} className="p-3 bg-neutral-900/50 border border-neutral-800/60 rounded-lg hover:bg-neutral-900 transition-colors flex items-center justify-between group">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-[10px] font-black text-neutral-100 truncate">{r.customerName}</span>
                        <ReservationStatusBadge status={r.status} />
                        {isTodayRes && <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 text-[8px] font-bold uppercase tracking-wider">Today</span>}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-neutral-500">
                        <span>{dateLabel}, {r.timeSlot}</span><span>·</span><span>{r.partySize} pax</span>
                      </div>
                    </div>
                    <button onClick={() => navigate('/admin/reservations')} className="opacity-0 group-hover:opacity-100 p-1.5 text-neutral-500 hover:text-emerald-400 transition-all"><ArrowRight size={14} /></button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-5 flex flex-col h-[400px]">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-neutral-200 flex items-center gap-2"><TrendingUp size={15} className="text-emerald-400" /> Recent Feedback</h3>
            <button onClick={() => navigate('/admin/feedback')} className="text-[10px] text-neutral-500 hover:text-emerald-400 transition-colors font-medium">View All</button>
          </div>
          <div className="space-y-2 overflow-y-auto pr-2 flex-1">
            {feedback.length === 0 ? <p className="text-xs text-neutral-500 italic text-center py-6">No recent feedback</p> : feedback.slice(0, 6).map((f: any) => (
              <div key={f.id} className="flex items-start gap-3 py-3 border-b border-neutral-800/50 last:border-0">
                <div className="w-8 h-8 rounded-full bg-neutral-900 border border-neutral-800 flex items-center justify-center text-xs font-bold text-neutral-400 flex-shrink-0">{f.customerName.charAt(0)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-start mb-0.5">
                    <p className="text-xs font-bold text-neutral-300 truncate pr-2">{f.customerName}</p>
                    {f.feedbackType && (
                      <span className={`text-[8px] px-1.5 py-0.5 rounded uppercase tracking-wider font-bold flex-shrink-0 ${
                        f.feedbackType === 'compliment' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                        f.feedbackType === 'complaint' ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                      }`}>{f.feedbackType.replace('_', ' ')}</span>
                    )}
                  </div>
                  <p className="text-[11px] text-neutral-500 line-clamp-2 leading-relaxed">"{f.comment}"</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Floating Offline Alert Toast (Bottom Right) ── */}
      {isFullyOffline && (
        <div className="fixed bottom-6 right-6 z-50 max-w-sm w-full bg-neutral-900/95 border border-amber-800/80 rounded-xl p-4 shadow-2xl backdrop-blur-md animate-slide-up">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-amber-500/10 text-amber-400 rounded-lg flex-none mt-0.5">
              <RefreshCw size={18} className="animate-spin" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                  Connection Lost
                </h4>
                <span className="text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded uppercase font-bold animate-pulse">
                  Reconnecting...
                </span>
              </div>
              <p className="text-xs text-neutral-300 mt-1.5 leading-relaxed">
                Cloud sync is temporarily unavailable. The system is actively trying to reconnect. Save a local database snapshot to protect recent venue transactions.
              </p>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  onClick={handleRunLocalBackup}
                  disabled={isBackingUp}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-neutral-950 text-xs font-bold rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
                >
                  <Download size={13} />
                  <span>Run Local Backup</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      

    </div>
  );
}