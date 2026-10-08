import { useState, useEffect, useMemo, useRef } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router';
import {
  LayoutDashboard, Users, Table2, Tag, BarChart3,
  DollarSign, FileText, Megaphone, CalendarX2,
  Menu, X, LogOut, ChevronRight, Search, Bell, Clock,
  ShieldCheck, Shield, Settings, Lock, AlertTriangle
} from 'lucide-react';
import { useAppContext } from './context/AppContext';
import { LockScreen } from './components/LockScreen';
import { PesoSign } from './components/PesoSign';
import logoImg from 'figma:asset/40eb82831843e17a3c48a360fd80f0aaaa58ddc8.png';
import { AnimatePresence, motion } from 'motion/react';

const navItems = [
  { to: '/admin',                   icon: LayoutDashboard, label: 'Dashboard',           exact: true },
  { to: '/admin/users',             icon: Users,           label: 'User Management' },
  { to: '/admin/tables',            icon: Table2,          label: 'Table Management' },
  { to: '/admin/events',            icon: CalendarX2,      label: 'Events & Calendar' },
  { to: '/admin/policy-rates',      icon: PesoSign,        label: 'Policy & Rates' }, 
  { to: '/admin/announcements',     icon: Megaphone,       label: 'Announcements' },
  { to: '/admin/analytics',         icon: BarChart3,       label: 'Analytics' },
  { to: '/admin/activity',          icon: Shield,          label: 'Activity Log' },
  { to: '/admin/feedback',          icon: Tag,             label: 'Feedback' },
  { to: '/admin/site-settings',     icon: FileText,        label: 'Site Settings' },
  { to: '/admin/settings',          icon: Settings,        label: 'Settings' },
];

const pageTitles: Record<string, string> = {
  '/admin': 'Dashboard',
  '/admin/users': 'User Management',
  '/admin/tables': 'Table Management',
  '/admin/events': 'Events & Calendar', 
  '/admin/policy-rates': 'Policy & Rates',
  '/admin/announcements': 'Announcements',
  '/admin/analytics': 'Analytics',
  '/admin/activity': 'Activity Log',
  '/admin/feedback': 'Feedback',
  '/admin/site-settings': 'Site Settings',
  '/admin/settings': 'Settings',
};

export function AdminLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [isLocked, setIsLocked] = useState(() => sessionStorage.getItem('oneshot_is_locked') === 'true');

  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [pendingNav, setPendingNav] = useState<string | null>(null);

  // 🟢 Global Search & Recent Searches State
  const [globalSearch, setGlobalSearch] = useState('');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('oneshot_admin_recent_searches');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  // 🟢 Notification Read/Clear States
  const [clearedTime, setClearedTime] = useState<number>(() => parseInt(localStorage.getItem('oneshot_admin_cleared_time') || '0'));
  const [readTime, setReadTime] = useState<number>(() => parseInt(localStorage.getItem('oneshot_admin_read_time') || '0'));

  const { 
    adminLoggedIn, adminLogout, staffProfile, activities, queue, tables,
    reservations, promoCodes, watchlist, staffUsers 
  } = useAppContext();
  
  const location = useLocation();
  const navigate = useNavigate();

  // Sync recent searches to local storage
  useEffect(() => {
    localStorage.setItem('oneshot_admin_recent_searches', JSON.stringify(recentSearches));
  }, [recentSearches]);

  const handleAddRecentSearch = (term: string) => {
    if (!term.trim()) return;
    setRecentSearches(prev => {
      const cleanTerm = term.trim();
      return [cleanTerm, ...prev.filter(t => t.toLowerCase() !== cleanTerm.toLowerCase())].slice(0, 4); // Limit to 4
    });
  };

  useEffect(() => {
    if (!adminLoggedIn) navigate('/', { replace: true });
  }, [adminLoggedIn, navigate]);

  useEffect(() => {
    if (!adminLoggedIn || isLocked) return;

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
  }, [adminLoggedIn, isLocked]);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

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
        results.push({ type: 'Table', label: `${t.name} ${t.session ? `(${t.session.customerName})` : ''}`, link: '/admin/tables' });
      }
    });
    
    (reservations || []).forEach((r: any) => {
      if (r.customerName.toLowerCase().includes(query) || r.id.toLowerCase().includes(query)) {
         results.push({ type: 'Reservation', label: `${r.customerName} - ${r.id}`, link: '/admin' }); // Routing to dashboard since admin has no specific reservation page
      }
    });
    
    (watchlist || []).forEach((w: any) => {
      if (w.name.toLowerCase().includes(query) && !w.isArchived) {
         results.push({ type: 'Watchlist', label: w.name, link: '/admin' });
      }
    });
    
    (promoCodes || []).forEach((p: any) => {
       if (p.code.toLowerCase().includes(query)) {
          results.push({ type: 'Promo Code', label: p.code, link: '/admin/policy-rates' });
       }
    });

    (staffUsers || []).forEach((u: any) => {
       if (u.fullName.toLowerCase().includes(query) || u.username.toLowerCase().includes(query)) {
          results.push({ type: 'Staff User', label: u.fullName, link: '/admin/users' });
       }
    });
    
    return results.slice(0, 4);
  }, [globalSearch, tables, reservations, promoCodes, watchlist, staffUsers]);

  if (!adminLoggedIn) return null;

  const pageTitle = pageTitles[location.pathname] || 'Admin';

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
    localStorage.setItem('oneshot_admin_cleared_time', now.toString());
    localStorage.setItem('oneshot_admin_read_time', now.toString());
  };

  const handleMarkAsRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    const now = Date.now();
    setReadTime(now);
    localStorage.setItem('oneshot_admin_read_time', now.toString());
  };

  const handleLockTerminal = () => {
    sessionStorage.setItem('oneshot_is_locked', 'true');
    setIsLocked(true);
  };

  const handleUnlockTerminal = () => {
    sessionStorage.removeItem('oneshot_is_locked');
    setIsLocked(false);
  };

  const handleLogout = () => {
    if (hasUnsavedChanges) {
      setPendingNav('LOGOUT');
      return;
    }
    adminLogout();
    navigate('/');
  };

  const handleSwitchToStaff = () => {
    if (hasUnsavedChanges) {
      setPendingNav('STAFF_PORTAL');
      return;
    }
    sessionStorage.setItem('oneshot_staff_auth', 'true');
    window.location.href = '/staff';
  };

  const confirmNavigation = () => {
    setHasUnsavedChanges(false);
    if (pendingNav === 'LOGOUT') {
      adminLogout();
      navigate('/');
    } else if (pendingNav === 'STAFF_PORTAL') {
      sessionStorage.setItem('oneshot_staff_auth', 'true');
      window.location.href = '/staff';
    } else if (pendingNav) {
      navigate(pendingNav);
    }
    setPendingNav(null);
    setSidebarOpen(false);
  };

  return (
    <>
      {isLocked && <LockScreen onUnlock={handleUnlockTerminal} />}
      
      <div className={`flex h-screen w-full bg-neutral-950 text-neutral-100 overflow-hidden transition-all duration-300 ${isLocked ? 'pointer-events-none blur-md select-none opacity-50' : ''}`}>
        
        {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setSidebarOpen(false)} />}

        <aside className={`
          fixed inset-y-0 left-0 z-40 w-64 bg-neutral-950 border-r border-neutral-800 flex flex-col transition-transform duration-300
          lg:relative lg:translate-x-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}>
          <div className="p-5 flex items-center justify-between border-b border-neutral-800/60">
            <button onClick={() => navigate('/admin')} className="flex items-center gap-3 text-left hover:opacity-80 transition-opacity">
              <img src={logoImg} alt="One Shot Bar" className="w-10 h-10 object-contain rounded-xl flex-shrink-0" />
              <div>
                <p className="text-sm font-bold text-neutral-100 leading-tight">One Shot Bar</p>
                <p className="text-[10px] text-emerald-500 uppercase tracking-widest font-semibold">Admin Portal</p>
              </div>
            </button>
            <button className="lg:hidden text-neutral-500 hover:text-neutral-200" onClick={() => setSidebarOpen(false)}>
              <X size={18} />
            </button>
          </div>

          <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
            <p className="text-[10px] text-neutral-600 uppercase tracking-widest font-semibold px-3 py-2">Admin Navigation</p>
            {navItems.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.exact}
                onClick={(e) => {
                  if (hasUnsavedChanges) {
                    e.preventDefault();
                    setPendingNav(item.to);
                  } else {
                    setSidebarOpen(false);
                  }
                }}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm group ${
                    isActive
                      ? 'bg-emerald-500/15 text-emerald-400 font-semibold border border-emerald-500/20'
                      : 'text-neutral-400 hover:bg-neutral-800/70 hover:text-neutral-200'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon size={16} className={isActive ? 'text-emerald-400' : ''} />
                    <span className="flex-1">{item.label}</span>
                    {isActive && <ChevronRight size={13} className="text-emerald-500/60" />}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="px-4 pb-4 border-t border-neutral-800/60 pt-4">
            <button
              onClick={handleSwitchToStaff}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl bg-neutral-950 border border-neutral-800 hover:border-neutral-700 text-neutral-400 hover:text-neutral-200 transition-all text-xs font-semibold"
            >
              <ShieldCheck size={13} />
              <span className="flex-1 text-left">Switch to Staff Portal</span>
              <span className="text-[9px] text-neutral-600 font-black">→</span>
            </button>
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="relative z-20 h-14 flex-none bg-neutral-950/80 border-b border-neutral-800 flex items-center justify-between px-5 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <button className="lg:hidden text-neutral-400 hover:text-neutral-200 p-1" onClick={() => setSidebarOpen(true)}>
                <Menu size={20} />
              </button>
              <div className="flex items-center gap-2 hidden sm:flex">
                <ShieldCheck size={15} className="text-emerald-500" />
                <h1 className="text-base font-semibold text-neutral-200">{pageTitle}</h1>
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              
              {/* 🟢 GLOBAL SEARCH BAR WITH RECENT SEARCHES */}
              <div className="relative" ref={searchContainerRef}>
                <div className="flex items-center bg-neutral-900 border border-neutral-700/50 rounded-lg px-3 py-2 w-40 sm:w-64 focus-within:border-emerald-500/50 transition-colors">
                  <Search size={14} className="text-neutral-500 mr-2" />
                  <input 
                    ref={searchInputRef}
                    type="text" 
                    placeholder="Search admin modules..." 
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
                                  onClick={(e) => { 
                                    if (hasUnsavedChanges) {
                                      e.preventDefault();
                                      setPendingNav(res.link);
                                    } else {
                                      handleAddRecentSearch(globalSearch);
                                      navigate(res.link); 
                                    }
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
                            <div className="p-4 text-center text-xs text-neutral-500">Type to search the admin database...</div>
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

              <div className="relative">
                <button onClick={() => setShowUserMenu(!showUserMenu)} className="flex items-center gap-2 bg-neutral-800/60 rounded-full pl-1 pr-3 py-1 border border-neutral-700/50 hover:bg-neutral-800 transition-colors mr-2">
                  <div className="w-7 h-7 bg-emerald-600/30 rounded-full border border-emerald-600/50 flex items-center justify-center text-emerald-400 text-xs font-bold overflow-hidden">
                    {staffProfile?.avatarImg ? (
                      <img 
                        src={staffProfile.avatarImg.startsWith('http') ? staffProfile.avatarImg : `http://localhost:3001${staffProfile.avatarImg}`} 
                        alt="Profile" 
                        className="w-full h-full object-cover" 
                      />
                    ) : (
                      staffProfile?.fullName?.charAt(0) || 'A'
                    )}
                  </div>
                  <span className="text-xs text-neutral-400 font-medium hidden sm:block">{staffProfile?.fullName || 'Admin'}</span>
                </button>
                
                {showUserMenu && (
                  <div className="absolute right-0 top-full mt-2 w-56 bg-neutral-950 border border-neutral-800 rounded-xl shadow-2xl z-50 overflow-hidden">
                    <div className="px-4 py-3 border-b border-neutral-800 flex items-center gap-3">
                      <div className="w-10 h-10 bg-emerald-600/30 rounded-full border border-emerald-600/50 flex items-center justify-center text-emerald-400 text-sm font-bold overflow-hidden flex-shrink-0">
                        {staffProfile?.avatarImg ? (
                          <img 
                            src={staffProfile.avatarImg.startsWith('http') ? staffProfile.avatarImg : `http://localhost:3001${staffProfile.avatarImg}`} 
                            alt="Profile" 
                            className="w-full h-full object-cover" 
                          />
                        ) : (
                          staffProfile?.fullName?.charAt(0) || 'A'
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-neutral-200 truncate">{staffProfile?.fullName || 'Admin User'}</p>
                        <p className="text-[10px] text-neutral-500 truncate">{staffProfile?.role || 'Administrator'}</p>
                      </div>
                    </div>
                    <button onClick={() => { setShowUserMenu(false); if (hasUnsavedChanges) { setPendingNav('/admin/settings'); } else { navigate('/admin/settings'); } }} className="w-full px-4 py-2.5 text-left text-sm text-neutral-300 hover:bg-neutral-900/60 transition-colors flex items-center gap-2">
                      <Settings size={14} /> Settings
                    </button>
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

          <main className="flex-1 overflow-auto bg-neutral-900 relative">
            <div className="p-6 max-w-screen-xl mx-auto h-full">
              <Outlet context={{ setHasUnsavedChanges }} />
            </div>
          </main>
        </div>
      </div>

      {pendingNav && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-emerald-900/40 rounded-2xl w-full max-w-sm shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-4 text-emerald-500">
                <AlertTriangle size={20} />
              </div>
              <h2 className="text-lg font-bold text-neutral-100 mb-2">Unsaved Changes</h2>
              <p className="text-sm text-neutral-400 leading-relaxed">
                You have unsaved modifications on this page. If you leave now, all your pending changes will be permanently discarded.
              </p>
            </div>
            <div className="px-6 py-4 border-t border-neutral-800 flex gap-3 bg-neutral-900/50">
              <button 
                onClick={() => setPendingNav(null)} 
                className="flex-1 px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm font-semibold rounded-xl transition-colors"
              >
                Keep Editing
              </button>
              <button 
                onClick={confirmNavigation} 
                className="flex-1 px-4 py-2.5 bg-rose-600 hover:bg-rose-500 text-neutral-100 text-sm font-semibold rounded-xl transition-colors shadow-lg shadow-rose-900/20"
              >
                Discard & Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}