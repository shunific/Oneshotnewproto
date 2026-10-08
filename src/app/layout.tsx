import { useState, useEffect, useMemo, useRef } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router';
import {
  CheckCircle, Clock, Calendar, UserPlus,
  Tag,
  Menu, X, Bell, ChevronRight,
  LogOut, Settings, Search,
  Monitor, ShieldCheck, Lock, ShieldAlert, Package, History,
  AlertTriangle, Sparkles, MessageSquare
} from 'lucide-react';
import { addMinutes, differenceInSeconds, format } from 'date-fns';
import { useAppContext } from './context/AppContext';
import { LockScreen } from './components/LockScreen';
import logoImg from 'figma:asset/40eb82831843e17a3c48a360fd80f0aaaa58ddc8.png';
import { FirstTimeLoginModal } from './components/FirstTimeLoginModal';
import { AnimatePresence, motion } from 'motion/react';

const navItems = [
  { to: '/staff',                     icon: CheckCircle,   label: 'Overview',            exact: true },
  { to: '/staff/tables',              icon: Clock,         label: 'Table Monitor' },
  { to: '/staff/reservations',        icon: Calendar,      label: 'Reservations' },
  { to: '/staff/queue',               icon: UserPlus,      label: 'Queue' },
  { to: '/staff/promo-codes',         icon: Tag,           label: 'Promo Codes' },
  { to: '/staff/history',             icon: History,       label: 'Session History' }, 
  { to: '/staff/lost-found',          icon: Package,       label: 'Lost & Found' },
  { to: '/staff/watchlist',           icon: ShieldAlert,   label: 'Security Watchlist' },
  { to: '/staff/feedback',            icon: MessageSquare, label: 'Feedback' },
  { to: '/staff/settings',            icon: Settings,      label: 'Settings' },
];

const pageTitles: Record<string, string> = {
  '/staff': 'Overview',
  '/staff/tables': 'Table Monitor',
  '/staff/reservations': 'Reservations',
  '/staff/queue': 'Queue Management',
  '/staff/lost-found': 'Lost & Found',       
  '/staff/watchlist': 'Security Watchlist',
  '/staff/promo-codes': 'Promo Codes',
  '/staff/history': 'Session History',
  '/staff/feedback': 'Customer Feedback',
  '/staff/settings': 'Settings',
};

// ── SIDEBAR SMART AUTO-SWITCHING LIVE COUNTDOWN TIMER ──
function SidebarSmartTimer({ tables, onNavigate }: { tables: any[]; onNavigate: (path: string) => void }) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatDuration = (totalSeconds: number) => {
    const absSecs = Math.abs(totalSeconds);
    const hrs = Math.floor(absSecs / 3600);
    const mins = Math.floor((absSecs % 3600) / 60);
    const secs = absSecs % 60;
    const parts = [
      hrs > 0 ? `${hrs}h` : '',
      `${mins.toString().padStart(2, '0')}m`,
      `${secs.toString().padStart(2, '0')}s`
    ].filter(Boolean).join(' ');
    return totalSeconds < 0 ? `+${parts}` : parts;
  };

  const occupiedTables = tables.filter((t: any) => t.isActive && t.status === 'occupied' && t.session);

  if (occupiedTables.length === 0) {
    return (
      <div className="px-4 py-3">
        <button
          onClick={() => onNavigate('/staff/tables')}
          className="w-full bg-neutral-900 border border-neutral-800 hover:border-neutral-700 rounded-xl p-3.5 text-left transition-all group"
        >
          <div className="flex items-center gap-1.5 text-emerald-400 text-[10px] font-bold uppercase tracking-wider mb-1">
            <Sparkles size={13} /> ✨ ALL TABLES CLEAR
          </div>
          <p className="text-sm font-black text-neutral-100 group-hover:text-emerald-400 transition-colors">
            Ready for Walk-ins
          </p>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            No tables are currently occupied.
          </p>
        </button>
      </div>
    );
  }

  const tableStatuses = occupiedTables.map((t: any) => {
    const start = new Date(t.session.startTime);
    const isOpen = t.session.isOpenTime || t.session.durationMinutes === null;
    if (isOpen) {
      const elapsedSecs = differenceInSeconds(now, start);
      return { table: t, type: 'open' as const, secs: elapsedSecs };
    }
    const end = addMinutes(start, t.session.durationMinutes);
    const remainingSecs = differenceInSeconds(end, now);
    if (remainingSecs <= 0) {
      return { table: t, type: 'overtime' as const, secs: remainingSecs };
    }
    if (remainingSecs <= 900) {
      return { table: t, type: 'warning' as const, secs: remainingSecs };
    }
    return { table: t, type: 'active' as const, secs: remainingSecs };
  });

  tableStatuses.sort((a, b) => {
    const score = (type: string) => {
      if (type === 'overtime') return 1;
      if (type === 'warning') return 2;
      if (type === 'active') return 3;
      return 4;
    };
    if (score(a.type) !== score(b.type)) return score(a.type) - score(b.type);
    return a.secs - b.secs;
  });

  const primary = tableStatuses[0];
  const isOt = primary.type === 'overtime';
  const isWarn = primary.type === 'warning';
  const isOpen = primary.type === 'open';

  const cardStyle = isOt
    ? 'bg-rose-950/30 border-rose-500/60 text-rose-400'
    : isWarn
    ? 'bg-amber-950/30 border-amber-500/60 text-amber-400'
    : 'bg-neutral-900 border-neutral-800 text-blue-400';

  return (
    <div className="px-4 py-3">
      <button
        onClick={() => onNavigate('/staff/tables')}
        className={`w-full border rounded-xl p-3.5 text-left transition-all group ${cardStyle}`}
      >
        <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider mb-1">
          <span className="flex items-center gap-1.5 truncate">
            {isOt ? <AlertTriangle size={13} className="animate-bounce" /> : <Clock size={13} />}
            <span>{isOt ? '⚠️ OVERTIME' : isWarn ? '⏳ ENDS SOON' : '⏱️ NEXT UP'} · {primary.table.name}</span>
          </span>
          <span className="text-neutral-500 font-normal">#{occupiedTables.length} active</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <p className={`text-xl font-black ${isOt ? 'text-rose-400 animate-pulse' : 'text-neutral-100'}`}>
            {formatDuration(primary.secs)}
          </p>
          <span className="text-[10px] text-neutral-400 font-semibold">
            {isOt ? 'unpaid' : isOpen ? 'elapsed' : 'left'}
          </span>
        </div>
        <p className="text-[11px] text-neutral-400 mt-1 truncate">
          Player: <span className="font-semibold text-neutral-200">{primary.table.session?.customerName}</span>
        </p>
      </button>
    </div>
  );
}
// ────────────────────────────────────────────────────────────────

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  
  // 🟢 Global Search & Recent Searches State
  const [globalSearch, setGlobalSearch] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('oneshot_recent_searches');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  // 🟢 Notification Read/Clear States
  const [clearedTime, setClearedTime] = useState<number>(() => parseInt(localStorage.getItem('oneshot_staff_cleared_time') || '0'));
  const [readTime, setReadTime] = useState<number>(() => parseInt(localStorage.getItem('oneshot_staff_read_time') || '0'));

  const [isLocked, setIsLocked] = useState(() => sessionStorage.getItem('oneshot_is_locked') === 'true');
  
  const { queue, tables, reservations, promoCodes, watchlist, activities, staffLoggedIn, staffLogout, staffProfile } = useAppContext() as any;
  const location = useLocation();
  const navigate = useNavigate();
  const [showSetup, setShowSetup] = useState(staffProfile?.isFirstLogin === 1);

  // Sync recent searches to local storage whenever they change
  useEffect(() => {
    localStorage.setItem('oneshot_recent_searches', JSON.stringify(recentSearches));
  }, [recentSearches]);

  const handleAddRecentSearch = (term: string) => {
    if (!term.trim()) return;
    setRecentSearches(prev => {
      const cleanTerm = term.trim();
      return [cleanTerm, ...prev.filter(t => t.toLowerCase() !== cleanTerm.toLowerCase())].slice(0, 4); // Limit to 4 recent items
    });
  };

  const handleLockTerminal = () => {
    sessionStorage.setItem('oneshot_is_locked', 'true');
    setIsLocked(true);
  };

  const handleUnlockTerminal = () => {
    sessionStorage.removeItem('oneshot_is_locked');
    setIsLocked(false);
  };
  
  useEffect(() => {
    if (!staffLoggedIn) navigate('/', { replace: true });
  }, [staffLoggedIn, navigate]);

  useEffect(() => {
    if (!staffLoggedIn || isLocked) return;
    let timeoutId: NodeJS.Timeout;
    const resetIdleTimer = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        console.log("⏳ System idle detected. Auto-locking terminal.");
        handleLockTerminal();
      }, 900000); 
    };

    window.addEventListener('mousemove', resetIdleTimer);
    window.addEventListener('keydown', resetIdleTimer);
    window.addEventListener('click', resetIdleTimer);
    window.addEventListener('scroll', resetIdleTimer);
    resetIdleTimer();

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('mousemove', resetIdleTimer);
      window.removeEventListener('keydown', resetIdleTimer);
      window.removeEventListener('click', resetIdleTimer);
      window.removeEventListener('scroll', resetIdleTimer);
    };
  }, [staffLoggedIn, isLocked]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setIsSearchFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const searchResults = useMemo(() => {
    if (!globalSearch.trim()) return [];
    const query = globalSearch.toLowerCase();
    const results: { type: string, label: string, link: string }[] = [];
    
    (tables || []).forEach((t: any) => {
      if (t.name.toLowerCase().includes(query) || t.session?.customerName?.toLowerCase().includes(query)) {
        results.push({ type: 'Table', label: `${t.name} ${t.session ? `(${t.session.customerName})` : ''}`, link: '/staff/tables' });
      }
    });
    
    (reservations || []).forEach((r: any) => {
      if (r.customerName.toLowerCase().includes(query) || r.id.toLowerCase().includes(query)) {
         results.push({ type: 'Reservation', label: `${r.customerName} - ${r.id}`, link: '/staff/reservations' });
      }
    });
    
    (watchlist || []).forEach((w: any) => {
      if (w.name.toLowerCase().includes(query) && !w.isArchived) {
         results.push({ type: 'Watchlist', label: w.name, link: '/staff/watchlist' });
      }
    });
    
    (promoCodes || []).forEach((p: any) => {
       if (p.code.toLowerCase().includes(query)) {
          results.push({ type: 'Promo Code', label: p.code, link: '/staff/promo-codes' });
       }
    });
    
    // 🟢 Restrict autocomplete suggestions to less than 5 items (Max 4 items)
    return results.slice(0, 4);
  }, [globalSearch, tables, reservations, promoCodes, watchlist]);

  if (!staffLoggedIn) return null;

  const waitingCount = queue.filter((q: any) => q.status === 'waiting').length;
  const overtimeCount = tables.filter((t: any) => {
    if (t.status !== 'occupied' || !t.session) return false;
    const end = new Date(t.session.startTime).getTime() + (t.session.durationMinutes || 0) * 60000;
    return Date.now() > end;
  }).length;

  // 🟢 Notifications Computed Variables
  const visibleActivities = (activities || [])
    .filter((a: any) => new Date(a.timestamp).getTime() > clearedTime)
    .slice(0, 10); // Show max 10 recent

  const unreadCount = visibleActivities.filter((a: any) => new Date(a.timestamp).getTime() > readTime).length;

  // 🟢 Notifications Action Handlers
  const handleClearNotifications = (e: React.MouseEvent) => {
    e.stopPropagation();
    const now = Date.now();
    setClearedTime(now);
    setReadTime(now);
    localStorage.setItem('oneshot_staff_cleared_time', now.toString());
    localStorage.setItem('oneshot_staff_read_time', now.toString());
  };

  const handleMarkAsRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    const now = Date.now();
    setReadTime(now);
    localStorage.setItem('oneshot_staff_read_time', now.toString());
  };

  const pageTitle = pageTitles[location.pathname] || 'One Shot Bar';

  const handleLogout = () => {
    setShowUserMenu(false);
    staffLogout();
    navigate('/');
  };

  const openLiveMonitor = () => {
    window.open('/monitor', '_blank', 'noopener,noreferrer');
  };

  return (
    <>
      {showSetup && <FirstTimeLoginModal onComplete={() => setShowSetup(false)} />}
      
      {isLocked && <LockScreen onUnlock={handleUnlockTerminal} />}
        
      <div className={`flex h-screen bg-neutral-900 text-neutral-100 overflow-hidden transition-all duration-300 ${isLocked ? 'pointer-events-none blur-md select-none opacity-50' : ''}`}>
        
        {/* Mobile Overlay */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Sidebar */}
        <aside className={`
          fixed inset-y-0 left-0 z-40 w-64 bg-neutral-950 border-r border-neutral-800 flex flex-col transition-transform duration-300
          lg:relative lg:translate-x-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}>
          {/* Logo */}
          <div className="p-5 flex items-center justify-between border-b border-neutral-800/60">
            <button onClick={() => navigate('/staff')} className="flex items-center gap-3 text-left hover:opacity-80 transition-opacity cursor-pointer">
              <img src={logoImg} alt="One Shot Bar" className="w-10 h-10 object-contain rounded-xl flex-shrink-0" />
              <div>
                <p className="text-sm font-bold text-neutral-100 leading-tight">One Shot Bar</p>
                <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-medium">& Billiards</p>
              </div>
            </button>
            <button className="lg:hidden text-neutral-500 hover:text-neutral-200" onClick={() => setSidebarOpen(false)}>
              <X size={18} />
            </button>
          </div>

          <SidebarSmartTimer tables={tables} onNavigate={navigate} />

          {/* Navigation */}
          <nav className="flex-1 px-3 py-2 space-y-0.5 overflow-y-auto">
            <p className="text-[10px] text-neutral-600 uppercase tracking-widest font-semibold px-3 py-2">Navigation</p>
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.exact}
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm group ${
                    isActive
                      ? 'bg-emerald-600/15 text-emerald-400 font-semibold border border-emerald-600/20'
                      : 'text-neutral-400 hover:bg-neutral-800/70 hover:text-neutral-200'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon size={17} className={isActive ? 'text-emerald-400' : ''} />
                    <span className="flex-1">{item.label}</span>
                    {item.to === '/staff/queue' && waitingCount > 0 && (
                      <span className="bg-amber-500 text-black text-[10px] font-black rounded-full w-4 h-4 flex items-center justify-center">
                        {waitingCount}
                      </span>
                    )}
                    {isActive && <ChevronRight size={14} className="text-emerald-500/60" />}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          {/* Switch to Admin */}
          {staffProfile?.isAdmin && (
            <div className="px-4 pb-4">
              <button
                onClick={() => {
                  sessionStorage.setItem('oneshot_admin_auth', 'true');
                   window.location.href = '/admin';
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 hover:border-neutral-700 text-neutral-400 hover:text-neutral-200 transition-all text-xs font-semibold"
              >
                <ShieldCheck size={13} />
                <span className="flex-1 text-left">Switch to Admin Portal</span>
                <span className="text-[9px] text-neutral-600 font-black">→</span>
              </button>
            </div>
          )}
        </aside>

        {/* Main Content */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Header */}
          <header className="relative z-20 h-16 flex-none bg-neutral-950/80 border-b border-neutral-800 flex items-center justify-between px-5 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <button className="lg:hidden text-neutral-400 hover:text-neutral-200 p-1" onClick={() => setSidebarOpen(true)}>
                <Menu size={20} />
              </button>
              <h1 className="text-base font-semibold text-neutral-200 hidden sm:block">{pageTitle}</h1>
            </div>
            
            <div className="flex items-center gap-3">
              
              <button onClick={openLiveMonitor} className="hidden lg:flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-600/10 hover:bg-emerald-600/20 border border-emerald-600/25 px-3 py-2 rounded-lg transition-all font-semibold">
                <Monitor size={14} /> Live Monitor
              </button>

              {/* 🟢 GLOBAL SEARCH BAR WITH RECENT SEARCHES */}
              <div className="relative" ref={searchContainerRef}>
                <div className="flex items-center bg-neutral-900 border border-neutral-700/50 rounded-lg px-3 py-2 w-40 sm:w-64 focus-within:border-emerald-500/50 transition-colors">
                  <Search size={14} className="text-neutral-500 mr-2" />
                  <input 
                    ref={searchInputRef}
                    type="text" 
                    placeholder="Search anything..." 
                    value={globalSearch}
                    onChange={e => setGlobalSearch(e.target.value)}
                    onFocus={() => setIsSearchFocused(true)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && globalSearch.trim().length > 0) {
                        handleAddRecentSearch(globalSearch);
                      }
                    }}
                    className="bg-transparent border-none outline-none text-xs text-neutral-200 w-full placeholder-neutral-600"
                  />
                  {globalSearch && (
                    <button onClick={() => { setGlobalSearch(''); searchInputRef.current?.focus(); }} className="text-neutral-500 hover:text-neutral-300 ml-1">
                      <X size={12} />
                    </button>
                  )}
                </div>
                
                <AnimatePresence>
                  {isSearchFocused && (
                    <motion.div 
                      initial={{ opacity: 0, y: 5 }} 
                      animate={{ opacity: 1, y: 0 }} 
                      exit={{ opacity: 0, y: 5 }} 
                      className="absolute top-full mt-2 right-0 sm:left-0 w-64 sm:w-80 bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl z-50 overflow-hidden flex flex-col py-1"
                    >
                       {globalSearch.trim().length > 0 ? (
                          searchResults.length > 0 ? (
                            <div className="max-h-80 overflow-y-auto hide-scrollbar">
                              <p className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest px-4 py-2 border-b border-neutral-800/50">Suggestions</p>
                              {searchResults.map((res, i) => (
                                <button 
                                  key={i} 
                                  onClick={() => { 
                                    handleAddRecentSearch(globalSearch);
                                    navigate(res.link); 
                                    setGlobalSearch(''); 
                                    setIsSearchFocused(false); 
                                  }} 
                                  className="w-full text-left px-4 py-3 hover:bg-neutral-800 border-b border-neutral-800/50 last:border-0 transition-colors flex flex-col gap-1"
                                >
                                  <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-500">{res.type}</span>
                                  <span className="text-sm font-semibold text-neutral-200 truncate">{res.label}</span>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div className="p-4 text-center text-xs text-neutral-500">No results found.</div>
                          )
                       ) : (
                          // Recent Searches View
                          recentSearches.length > 0 ? (
                            <div className="py-1">
                              <div className="flex justify-between items-center px-4 pb-2 pt-1 border-b border-neutral-800/50">
                                <p className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Recent Searches</p>
                                <button onClick={(e) => { e.stopPropagation(); setRecentSearches([]); }} className="text-[10px] text-neutral-500 hover:text-rose-400 font-semibold transition-colors">Clear</button>
                              </div>
                              {recentSearches.map((term, i) => (
                                <button 
                                  key={i}
                                  onClick={() => {
                                    setGlobalSearch(term);
                                    searchInputRef.current?.focus();
                                  }}
                                  className="w-full text-left px-4 py-2.5 hover:bg-neutral-800 transition-colors flex items-center gap-3"
                                >
                                  <Clock size={14} className="text-neutral-500" />
                                  <span className="text-xs font-semibold text-neutral-300 truncate">{term}</span>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div className="p-4 text-center text-xs text-neutral-500">Type to search across the system...</div>
                          )
                       )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* 🟢 Notifications Panel with Read/Clear Actions */}
              <div className="relative">
                <button onClick={() => setShowNotifications(!showNotifications)} className="relative p-2 text-neutral-400 hover:text-neutral-200 transition-colors rounded-lg hover:bg-neutral-800">
                  <Bell size={18} />
                  {unreadCount > 0 && (
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-rose-500 rounded-full border-2 border-neutral-950" />
                  )}
                </button>
                {showNotifications && (
                  <div className="absolute right-0 top-full mt-3 w-80 bg-neutral-950 border border-neutral-800 rounded-xl shadow-2xl z-50 overflow-hidden flex flex-col">
                    <div className="px-4 py-3 border-b border-neutral-800 flex justify-between items-center bg-neutral-900/80">
                      <p className="text-sm font-bold text-neutral-200">System Activity</p>
                      <div className="flex items-center gap-3">
                        <button 
                          onClick={handleMarkAsRead} 
                          disabled={unreadCount === 0} 
                          className={`text-[10px] font-bold uppercase tracking-wider transition-colors ${unreadCount > 0 ? 'text-emerald-400 hover:text-emerald-300' : 'text-neutral-700 cursor-not-allowed'}`}
                        >
                          Read
                        </button>
                        <button 
                          onClick={handleClearNotifications} 
                          disabled={visibleActivities.length === 0} 
                          className={`text-[10px] font-bold uppercase tracking-wider transition-colors ${visibleActivities.length > 0 ? 'text-rose-400 hover:text-rose-300' : 'text-neutral-700 cursor-not-allowed'}`}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                    <div className="max-h-96 overflow-y-auto hide-scrollbar">
                      {visibleActivities.length === 0 ? (
                        <div className="p-6 text-center">
                          <Bell size={24} className="mx-auto text-neutral-700 mb-2" />
                          <p className="text-xs text-neutral-500 font-medium">No new notifications</p>
                        </div>
                      ) : (
                        visibleActivities.map((activity: any) => {
                          const isUnread = new Date(activity.timestamp).getTime() > readTime;
                          return (
                            <div key={activity.id} className={`px-4 py-3 border-b border-neutral-800/50 transition-colors relative ${isUnread ? 'bg-emerald-950/10 hover:bg-emerald-900/20' : 'hover:bg-neutral-900/40'}`}>
                              {isUnread && <span className="absolute left-2.5 top-4 w-1.5 h-1.5 bg-emerald-500 rounded-full shadow-[0_0_8px_rgba(16,185,129,0.6)]" />}
                              <p className={`text-xs pl-3 ${isUnread ? 'text-neutral-200 font-medium' : 'text-neutral-400'}`}>{activity.description}</p>
                              <p className="text-[10px] text-neutral-600 mt-1.5 pl-3">{new Date(activity.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* User Menu */}
              <div className="relative">
                <button onClick={() => setShowUserMenu(!showUserMenu)} className="flex items-center gap-2 bg-neutral-800/60 rounded-full pl-1 pr-3 py-1 border border-neutral-700/50 hover:bg-neutral-800 transition-colors max-w-[140px] sm:max-w-[200px]">
                  <div className="w-8 h-8 bg-emerald-600/30 rounded-full border border-emerald-600/50 flex items-center justify-center text-emerald-400 text-xs font-bold overflow-hidden flex-shrink-0">
                    {staffProfile?.avatarImg ? (
                      <img 
                        src={staffProfile.avatarImg.startsWith('http') ? staffProfile.avatarImg : `http://localhost:3001${staffProfile.avatarImg}`} 
                        alt="Profile" 
                        className="w-full h-full object-cover" 
                      />
                    ) : (
                      staffProfile?.fullName?.charAt(0) || 'S'
                    )}
                  </div>
                  <span className="text-xs text-neutral-300 font-medium truncate hidden sm:block">
                    {staffProfile?.fullName || 'Staff User'}
                  </span>
                </button>
                
                {showUserMenu && (
                  <div className="absolute right-0 top-full mt-3 w-56 bg-neutral-950 border border-neutral-800 rounded-xl shadow-2xl z-50 overflow-hidden">
                    <div className="px-4 py-3 border-b border-neutral-800 flex items-center gap-3">
                      <div className="w-10 h-10 bg-emerald-600/30 rounded-full border border-emerald-600/50 flex items-center justify-center text-emerald-400 text-sm font-bold overflow-hidden flex-shrink-0">
                        {staffProfile?.avatarImg ? (
                          <img 
                            src={staffProfile.avatarImg.startsWith('http') ? staffProfile.avatarImg : `http://localhost:3001${staffProfile.avatarImg}`} 
                            alt="Profile" 
                            className="w-full h-full object-cover" 
                          />
                        ) : (
                          staffProfile?.fullName?.charAt(0) || 'S'
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-neutral-200 truncate">{staffProfile?.fullName || 'Staff User'}</p>
                        <p className="text-[10px] text-neutral-500 truncate">{staffProfile?.role || 'Staff'}</p>
                      </div>
                    </div>
                    <NavLink to="/staff/settings" onClick={() => setShowUserMenu(false)} className="w-full px-4 py-2.5 text-left text-sm text-neutral-300 hover:bg-neutral-900/60 transition-colors flex items-center gap-2">
                      <Settings size={14} /> Settings
                    </NavLink>
                    <button onClick={() => { handleLockTerminal(); setShowUserMenu(false); }} className="w-full px-4 py-2.5 text-left text-sm text-amber-400 hover:bg-neutral-900/60 transition-colors flex items-center gap-2 border-t border-neutral-800">
                      <Lock size={14} /> Lock Device
                    </button>
                    <button onClick={handleLogout} className="w-full px-4 py-2.5 text-left text-sm text-rose-400 hover:bg-neutral-900/60 transition-colors flex items-center gap-2 border-t border-neutral-800">
                      <LogOut size={14} /> Logout
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>

          {/* Page Content */}
          <main className="flex-1 overflow-auto bg-neutral-900">
            <div className="p-6 max-w-screen-xl mx-auto">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </>
  );
}