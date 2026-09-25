import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { supabase } from '../utils/supabase';
import { 
  addMinutes, format, isToday, isBefore, startOfDay, isSameDay, differenceInDays, differenceInMinutes 
} from 'date-fns';
import {
  ChevronLeft, ChevronRight, X, Phone, MapPin,
  Clock, LogIn, Eye, EyeOff,
  Calendar, CheckCircle, ArrowRight, Users, ChevronDown,
  Info, Shield, Award, Mail, Tag, BookOpen,
  Sparkles, Upload, Search, ExternalLink, AlertTriangle, XCircle, Bell, RefreshCw, Lock,
  Table2, LogOut, FileText, QrCode
} from 'lucide-react';
import { useAppContext, HOURLY_RATE, DOWN_PAYMENT_RATE } from '../context/AppContext';
import { ImageWithFallback } from '../components/figma/ImageWithFallback';

import logoImg from 'figma:asset/40eb82831843e17a3c48a360fd80f0aaaa58ddc8.png';
import heroImg1 from 'figma:asset/15fb8dcab89448c8f2ad20fb9946631b1c246968.png';

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const todayStart = startOfDay(new Date());

type Section = 'home' | 'reservations' | 'events' | 'rates';

function MiniCalendar({ selectedDate, onSelect, reservedDates, closedDates, onClosedClick, minDate = new Date() }: { selectedDate: Date | null; onSelect: (d: Date) => void; reservedDates: Date[]; closedDates: any[]; onClosedClick?: (d: Date, reason: string) => void; minDate?: Date }) {
  const today = minDate;
  today.setHours(0, 0, 0, 0);
  
  const maxDate = new Date(today);
  maxDate.setDate(today.getDate() + 30);

  const [viewDate, setViewDate] = useState(() => { const d = new Date(today); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells: Array<{ day: number; currentMonth: boolean; date: Date }> = [];
  for (let i = firstDayOfMonth - 1; i >= 0; i--) { const d = new Date(year, month - 1, daysInPrevMonth - i); cells.push({ day: daysInPrevMonth - i, currentMonth: false, date: d }); }
  for (let d = 1; d <= daysInMonth; d++) { cells.push({ day: d, currentMonth: true, date: new Date(year, month, d) }); }
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++) { cells.push({ day: d, currentMonth: false, date: new Date(year, month + 1, d) }); }

  const isReserved = (date: Date) => reservedDates.some(rd => { const d = new Date(rd); d.setHours(0, 0, 0, 0); return d.getTime() === date.getTime(); });
  
  // 🟢 Fixed: Properly compares closed dates using isSameDay for reliable matching
  // 🟢 Fixed: Parses "YYYY-MM-DD" strictly into local time to prevent UTC timezone shifting bugs
  const getClosedData = (date: Date) => (closedDates || []).find((cd: any) => { 
    if (cd.type === 'weekly') return date.getDay() === cd.dayOfWeek;
    
    // Safety fallback to support different database column names
    const targetStr = cd.date || cd.closedDate || cd.closed_date;
    if (!targetStr) return false;
    
    // Extract exact local YYYY-MM-DD without UTC conversion
    const [y, m, d] = targetStr.split('T')[0].split('-').map(Number);
    return date.getFullYear() === y && date.getMonth() === (m - 1) && date.getDate() === d; 
  });

  const isPast = (date: Date) => date < today;
  const isSelected = (date: Date) => selectedDate ? date.getTime() === (() => { const s = new Date(selectedDate); s.setHours(0,0,0,0); return s.getTime(); })() : false;
  const isTodayDate = (date: Date) => date.getTime() === today.getTime();

  return (
    <div className="bg-transparent rounded-2xl select-none">
      <div className="flex items-center justify-between mb-4 px-1">
        <button type="button" onClick={() => setViewDate(d => new Date(d.getFullYear(), d.getMonth() - 1))} className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"><ChevronLeft size={16} /></button>
        <span className="text-xs font-bold text-white">{MONTHS[month]} {year}</span>
        <button type="button" onClick={() => setViewDate(d => new Date(d.getFullYear(), d.getMonth() + 1))} className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"><ChevronRight size={16} /></button>
      </div>
      <div className="grid grid-cols-7 mb-2">
        {DAYS_OF_WEEK.map(d => <div key={d} className="text-center text-[8px] text-neutral-500 font-bold uppercase tracking-widest">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-y-1">
        {cells.map(({ day, currentMonth, date }, idx) => {
          const past = isPast(date); 
          const tooFar = date > maxDate; 
          const selected = isSelected(date); 
          const today_ = isTodayDate(date);
          const closedData = getClosedData(date);
          const closed = !!closedData && currentMonth;
          const reserved = isReserved(date) && currentMonth; 
          
          const disabled = !currentMonth || (past && !closed) || tooFar;

          const handleCellClick = () => {
            if (disabled) return;
            if (closed) {
              onClosedClick?.(date, closedData.reason || 'Closed for maintenance or private event.');
            } else if (!past && currentMonth) {
              onSelect(date);
            }
          };

          return (
            <div key={idx} className="flex justify-center">
              <div 
                onClick={handleCellClick} 
                className={`relative flex flex-col items-center justify-center w-8 h-8 rounded-full text-xs transition-all 
                  ${!currentMonth || tooFar ? 'opacity-20 cursor-default' : ''} 
                  ${past && currentMonth && !closed ? 'opacity-30 cursor-default text-neutral-600' : ''} 
                  ${closed && !tooFar ? 'bg-rose-500/10 text-rose-500 border border-rose-500/30 hover:bg-rose-500/20 cursor-pointer' : ''} 
                  ${selected && !closed ? 'bg-emerald-500 text-white shadow-md cursor-pointer' : ''} 
                  ${!selected && today_ && !closed ? 'border border-emerald-500 text-emerald-400 cursor-pointer' : ''} 
                  ${!selected && !disabled && !closed && !today_ ? 'text-neutral-300 hover:bg-neutral-800 cursor-pointer' : ''}`}
                title={tooFar ? "Advance booking limit reached (30 Days Max)" : closed ? "Venue Closed" : ""}
              >
                <span className={`pointer-events-none ${selected ? 'font-bold' : 'font-medium'}`}>{day}</span>
                {reserved && !selected && !closed && !tooFar && <span className="absolute bottom-0.5 w-1 h-1 rounded-full bg-amber-400 pointer-events-none" />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const { 
    siteConfig, announcements, tables, reservations, events, 
    closedDates, reservationTerms, rates, addReservation, cancelReservation, 
    updateReservation, updateReservationStatus, addFeedback, applyPromoCode,
    sessionHistory, queue
  } = useAppContext() as any;

  const [activeUser, setActiveUser] = useState<{ name: string; email: string; } | null>(null);

  const [dynamicWaitTime, setDynamicWaitTime] = useState<string>('Calculating...');

  useEffect(() => {
    const activeTables = (tables || []).filter((t: any) => t.status === 'occupied' && t.session);
    const freeTables = (tables || []).filter((t: any) => t.status === 'available').length;
    const waitingCount = (queue || []).filter((q: any) => q.status === 'waiting').length;

    if (freeTables > waitingCount) {
      setDynamicWaitTime("0 mins (Available Now)");
      return;
    }

    if (activeTables.length === 0) {
      setDynamicWaitTime("0 mins (Available Now)");
      return;
    }

    const now = new Date();
    const remainingTimes = activeTables.map((t: any) => {
      if (t.session.isOpenTime || !t.session.durationMinutes) return 45; 
      const end = addMinutes(new Date(t.session.startTime), t.session.durationMinutes);
      return Math.max(0, differenceInMinutes(end, now));
    }).sort((a: any, b: any) => a - b);

    const baseWait = remainingTimes[0] || 15;
    const unseatedQueue = Math.max(0, waitingCount - freeTables);
    const totalWait = baseWait + (unseatedQueue * 15); 

    if (totalWait < 60) {
      setDynamicWaitTime(`~${Math.round(totalWait)} mins`);
    } else {
      setDynamicWaitTime(`~${Math.floor(totalWait / 60)}h ${Math.round(totalWait % 60)}m`);
    }
  }, [tables, queue]);

  const [rateLimits, setRateLimits] = useState<Record<string, number[]>>({});
  const checkRateLimit = useCallback((action: string, maxAttempts: number, windowMinutes: number) => {
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    setRateLimits(prev => {
      const attempts = (prev[action] || []).filter(t => now - t < windowMs);
      if (attempts.length >= maxAttempts) return prev;
      return { ...prev, [action]: [...attempts, now] };
    });
    const currentAttempts = (rateLimits[action] || []).filter(t => now - t < windowMs);
    return currentAttempts.length < maxAttempts;
  }, [rateLimits]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setActiveUser({ 
          name: session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'User', 
          email: session.user.email || '' 
        });
      }
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setActiveUser({ 
          name: session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || 'User', 
          email: session.user.email || '' 
        });
      } else {
        setActiveUser(null);
      }
    });

    return () => authListener.subscription.unsubscribe();
  }, []);

  const currentUser = activeUser;

  const [readAnnouncements, setReadAnnouncements] = useState<string[]>([]);
  const [showAnnouncements, setShowAnnouncements] = useState(false);
  const [isFirstTime, setIsFirstTime] = useState(false);
  const [closureAlert, setClosureAlert] = useState<{ date: Date, reason: string } | null>(null);
  
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'options' | 'login' | 'register' | 'forgot'>('options');
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [viewingReceipt, setViewingReceipt] = useState<any | null>(null);

  const [heroSlideIdx, setHeroSlideIdx] = useState(0);
  const [heroSlideDir, setHeroSlideDir] = useState<1 | -1>(1);
  const [_now, setNow] = useState(new Date());
  
  const [activeSection, setActiveSection] = useState<Section>('home');

  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [isCalendarExpanded, setIsCalendarExpanded] = useState(true);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [isTableSelectorExpanded, setIsTableSelectorExpanded] = useState(true);
  
  const [resForm, setResForm] = useState({ 
    name: '', email: '', phone: '', pax: 2, timeSlot: '', duration: 2,
    paymentMethod: 'gcash' as 'gcash' | 'cash', paymentRef: ''
  });

  const [reservationStep, setReservationStep] = useState<0 | 1 | 2 | 3>(0);
  const [resTab, setResTab] = useState<'new' | 'track'>('new');
  const [trackForm, setTrackForm] = useState({ reservationId: '' });
  const [trackedReservations, setTrackedReservations] = useState<any[] | null>(null);
  const [generatedResId, setGeneratedResId] = useState('');
  
  const [confirmingPayment, setConfirmingPayment] = useState(false);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [promoCodeInput, setPromoCodeInput] = useState('');
  const [appliedPromo, setAppliedPromo] = useState<{ code: string; discountPercent: number } | null>(null);
  const [promoError, setPromoError] = useState('');
  
  const [feedbackForm, setFeedbackForm] = useState({ name: '', contact: '', type: '', customType: '', message: '', reservationId: '' });
  const [feedbackSent, setFeedbackSent] = useState(false);

  const [rescheduleData, setRescheduleData] = useState<{ show: boolean, reservation: any, newDate: Date | null, timeSlot: string } | null>(null);

  const [reportModalResId, setReportModalResId] = useState<string | null>(null);
  const [reportMessage, setReportMessage] = useState('');
  const [isReporting, setIsReporting] = useState(false);
  
  const [openActionRowId, setOpenActionRowId] = useState<string | null>(null);
  
  const [toastMsg, setToastMsg] = useState<{title: string, desc: string, type: 'success'|'error'} | null>(null);
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [receiptImg, setReceiptImg] = useState<string | null>(null);


  useEffect(() => {
    if (toastMsg) {
      const timer = setTimeout(() => setToastMsg(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toastMsg]);

  useEffect(() => {
    if (activeSection === 'home' && pendingScroll) {
      const timer = setTimeout(() => {
        const el = document.getElementById(`home-${pendingScroll}-section`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setPendingScroll(null);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [activeSection, pendingScroll]);

  useEffect(() => {
    const handleClickOutside = () => setOpenActionRowId(null);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const [loginForm, setLoginForm] = useState({ email: '', password: '', showPw: false, error: '', loading: false });
  const [registerForm, setRegisterForm] = useState({ name: '', email: '', phone: '', password: '', confirm: '', showPw: false, error: '', loading: false });
  const [forgotForm, setForgotForm] = useState({ email: '', error: '', success: false, loading: false });

  // 🟢 DYNAMIC IMAGE HANDLING (Kept intact per your instructions)
  // 🟢 DYNAMIC IMAGE HANDLING (Kept intact per your instructions)
  let heroSlides = [{ src: heroImg1, alt: 'One Shot Facility' }];
  try {
    const parsedImages = typeof siteConfig?.heroImages === 'string' ? JSON.parse(siteConfig.heroImages) : siteConfig?.heroImages;
    if (Array.isArray(parsedImages) && parsedImages.length > 0) {
      heroSlides = parsedImages.map((url: string) => ({ 
        src: url.startsWith('http') ? url : `http://localhost:3001${url}`, 
        alt: 'One Shot Facility View' 
      }));
    }
  } catch (e) {}

  const cmsAboutImage = siteConfig?.aboutImage 
    ? (siteConfig.aboutImage.startsWith('http') ? siteConfig.aboutImage : `http://localhost:3001${siteConfig.aboutImage}`)
    : "https://images.unsplash.com/photo-1761335633357-04fab36b333f?q=80";

  // 🟢 HARDCODED TEXT (Replaces dynamic admin text)
  const cms = {
    heroTitle: 'ONE SHOT',
    heroSubtitle: 'Bar & Billiards',
    heroDescription: 'Your premier billiard destination at Autobase OAX, Cainta, Rizal.',
    aboutTitle: 'A Passion for the Game',
    aboutP1: 'One Shot Bar & Billiards was founded with a simple mission: to create the ultimate billiard experience in Cainta, Rizal.',
    aboutP2: 'Our tournament-grade tables are maintained with precision, and our staff are passionate players themselves.',
    aboutP3: 'Whether you are a seasoned champion or picking up a cue for the first time, One Shot welcomes you.',
    aboutImage: cmsAboutImage,
    address: 'Autobase OAX, San Juan, Cainta, Rizal 1900',
    phone: '0917-123-4567 | 0998-765-4321',
    email: 'oneshot.billiards@gmail.com',
  };

  useEffect(() => {
    if (heroSlides.length > 0) {
      const interval = setInterval(() => {
        setHeroSlideDir(1);
        setHeroSlideIdx(prev => (prev + 1) % heroSlides.length);
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [heroSlides.length]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const prevHeroSlide = () => { setHeroSlideDir(-1); setHeroSlideIdx(p => (p - 1 + heroSlides.length) % heroSlides.length); };
  const nextHeroSlide = () => { setHeroSlideDir(1); setHeroSlideIdx(p => (p + 1) % heroSlides.length); };

  useEffect(() => {
    const stored = localStorage.getItem('oneshot_read_announcements');
    if (stored) {
      try { setReadAnnouncements(JSON.parse(stored)); } catch(e) {}
    }
    const visited = localStorage.getItem('oneshot_visited');
    if (!visited) {
      setIsFirstTime(true);
      localStorage.setItem('oneshot_visited', 'true');
    }
  }, []);

  const activeAnnouncements = announcements?.filter((a: any) => a.isActive && (!a.expiresAt || new Date(a.expiresAt) > new Date())) || [];
  const userReservations = currentUser 
    ? reservations.filter((r: any) => r.email && r.email.toLowerCase() === currentUser.email.toLowerCase()) 
    : [];

  const resNotifications = userReservations.map((r: any) => ({
    id: `notif_${r.id}_${r.status}`,
    type: 'Reservation Update',
    title: `Booking ${r.status.toUpperCase()}`,
    content: `Your reservation for ${format(new Date(r.date), 'MMM d, yyyy')} is currently marked as ${r.status}.`,
    createdAt: r.createdAt
  }));

  const refundNotifications = userReservations.filter((r: any) => r.status === 'pending-refund').map((r: any) => ({
    id: `refund_${r.id}`,
    type: 'Refund Status',
    title: 'Pending Refund',
    content: `Refund on Booking ID ${r.id} and its details is pending refund...`,
    createdAt: r.createdAt
  }));

  const allNotifications = [...activeAnnouncements, ...resNotifications, ...refundNotifications].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  
  const unreadNotifications = allNotifications.filter((n: any) => !readAnnouncements.includes(n.id));
  const hasUnread = isFirstTime || unreadNotifications.length > 0;

  const markAllAsRead = () => {
    const ids = allNotifications.map((n: any) => n.id);
    setReadAnnouncements(ids);
    localStorage.setItem('oneshot_read_announcements', JSON.stringify(ids));
    setIsFirstTime(false);
  };

  const completedBookings = userReservations.filter((r: any) => r.status === 'completed').length;
  const missedBookings = userReservations.filter((r: any) => r.status === 'walkout' || r.status === 'cancelled').length;
  const netTrustScore = completedBookings - missedBookings;
  const isTrustedCustomer = netTrustScore >= 3;
  const totalHoursPlayed = userReservations
    .filter((r: any) => r.status === 'completed')
    .reduce((sum: number, r: any) => sum + (r.durationHours || 0), 0);
  const isDownPaymentWaived = isTrustedCustomer && resForm.duration <= 3;

  const effectiveHourly = (rates && Number(rates.hourlyRate) > 0) ? Number(rates.hourlyRate) : HOURLY_RATE;
  const baseAmount = Number(resForm.duration) * effectiveHourly;
  const discountAmount = appliedPromo ? Math.floor(baseAmount * appliedPromo.discountPercent / 100) : 0;
  const totalAmount = baseAmount - discountAmount;
  const downPaymentPercentVal = rates && Number(rates.downPaymentPercent) >= 0 ? Number(rates.downPaymentPercent) : DOWN_PAYMENT_RATE * 100;
  const downPayment = Math.ceil(totalAmount * (downPaymentPercentVal ? downPaymentPercentVal / 100 : DOWN_PAYMENT_RATE));

  useEffect(() => {
    if (currentUser) {
      setResForm(f => ({ ...f, name: currentUser.name, email: currentUser.email }));
    }
  }, [currentUser]);

  const handleOAuthLogin = async (provider: 'google' | 'facebook' | 'apple') => {
    const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: window.location.origin } });
    if (error) alert(`${provider} login error: ` + error.message);
  };

  const handleLoginSubmit = async () => {
    if (!checkRateLimit('login', 5, 5)) return setToastMsg({title:"Rate Limit Exceeded", desc:"Please wait 5 minutes before trying again.", type:"error"});
    if (!loginForm.email || !loginForm.password) return setLoginForm(f => ({ ...f, error: 'Please fill all fields.' }));
    setLoginForm(f => ({ ...f, loading: true, error: '' }));
    const { error } = await supabase.auth.signInWithPassword({ email: loginForm.email, password: loginForm.password });
    if (error) {
      setLoginForm(f => ({ ...f, error: error.message, loading: false }));
    } else {
      setShowAuthModal(false);
      setLoginForm({ email: '', password: '', showPw: false, error: '', loading: false });
    }
  };

  const handleRegisterSubmit = async () => {
    if (!checkRateLimit('register', 3, 10)) return setToastMsg({title:"Rate Limit Exceeded", desc:"Please wait before trying again.", type:"error"});
    if (!registerForm.name || !registerForm.email || !registerForm.phone || !registerForm.password) return setRegisterForm(f => ({ ...f, error: 'Please fill all required fields.' }));
    if (registerForm.password !== registerForm.confirm) return setRegisterForm(f => ({ ...f, error: 'Passwords do not match.' }));
    if (registerForm.password.length < 8) return setRegisterForm(f => ({ ...f, error: 'Password must be at least 8 characters long.' }));
    
    setRegisterForm(f => ({ ...f, loading: true, error: '' }));
    const { error } = await supabase.auth.signUp({
      email: registerForm.email,
      password: registerForm.password,
      options: { data: { full_name: registerForm.name, phone: registerForm.phone } }
    });
    
    if (error) {
      setRegisterForm(f => ({ ...f, error: error.message, loading: false }));
    } else {
      setShowAuthModal(false);
      setRegisterForm({ name: '', email: '', phone: '', password: '', confirm: '', showPw: false, error: '', loading: false });
      alert("Registration successful! You are now logged in.");
    }
  };

  const handleForgotSubmit = async () => {
    if (!checkRateLimit('forgot', 2, 10)) return setToastMsg({title:"Rate Limit Exceeded", desc:"Please wait before trying again.", type:"error"});
    if (!forgotForm.email) return setForgotForm(f => ({ ...f, error: 'Please enter your email.' }));
    setForgotForm(f => ({ ...f, loading: true, error: '' }));
    const { error } = await supabase.auth.resetPasswordForEmail(forgotForm.email, { redirectTo: `${window.location.origin}/reset-password` });
    if (error) {
      setForgotForm(f => ({ ...f, error: error.message, loading: false }));
    } else {
      setForgotForm(f => ({ ...f, success: true, loading: false }));
    }
  };

  const handleChangePassword = async () => {
    if (!currentUser?.email) return;
    if (window.confirm('Send a secure password reset link to your email? You will be logged out to securely reset your password.')) {
      await supabase.auth.resetPasswordForEmail(currentUser.email, { redirectTo: `${window.location.origin}/reset-password` });
      await supabase.auth.signOut();
      setShowProfileModal(false);
      alert('Password reset link sent! Please check your email inbox.');
    }
  };

  const handleDeleteAccount = async () => {
    if (!checkRateLimit('delete', 1, 60)) return setToastMsg({title:"Rate Limit Exceeded", desc:"Please wait before trying again.", type:"error"});
    if (window.confirm('WARNING: Are you sure you want to delete your account?\n\nTo maintain strict financial records, your historical transactions will be retained but your personal data will be anonymized (Soft Delete Protocol). This action cannot be undone.')) {
      
      const { error } = await supabase.auth.updateUser({
        data: { deleted: true, full_name: 'Anonymized User', phone: '00000000000' }
      });
      
      if (!error) {
        await supabase.auth.signOut();
        setShowProfileModal(false);
        alert('Account successfully marked for deletion. Your personal data has been securely anonymized.');
      } else {
        alert('Failed to delete account: ' + error.message);
      }
    }
  };

  const handleNavClick = (sectionId: string) => {
    if (sectionId === 'about' || sectionId === 'feedback') {
      setActiveSection('home');
      setPendingScroll(sectionId);
    } else {
      setActiveSection(sectionId as Section | 'rates');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleReportProblem = (reservationId: string) => {
    setFeedbackForm(f => ({ ...f, reservationId, type: 'complaint' }));
    handleNavClick('feedback');
  };

  const fmt12 = (tOrMins: string | number) => {
    try {
      let mins: number;
      if (typeof tOrMins === 'number') mins = tOrMins;
      else {
        const [hh = '0', mm = '0'] = (tOrMins || '').split(':');
        mins = Number(hh) * 60 + Number(mm || 0);
      }
      const m = ((mins % (24 * 60)) + (24 * 60)) % (24 * 60);
      let hh = Math.floor(m / 60);
      const mm = m % 60;
      const period = hh >= 12 ? 'PM' : 'AM';
      hh = hh % 12;
      if (hh === 0) hh = 12;
      return `${hh}:${String(mm).padStart(2, '0')} ${period}`;
    } catch (e) { return String(tOrMins); }
  };

  const getOpenHoursDisplay = () => {
    try {
      const currentDay = new Date().getDay();
      const isWeekend = currentDay === 0 || currentDay === 5 || currentDay === 6; 
      const openTime = isWeekend ? (rates?.weekendStartTime || '12:00') : (rates?.weekdayStartTime || '12:00');
      const closeTime = isWeekend ? (rates?.weekendEndTime || '02:00') : (rates?.weekdayEndTime || '02:00');
      const parseMins = (t: string) => { const [h, m] = (t || '0').split(':').map(Number); return h * 60 + (m || 0); };
      const start = parseMins(openTime);
      let end = parseMins(closeTime);
      if (end <= start) end += 24 * 60;
      return `${Math.floor((end - start) / 60)}+`;
    } catch (e) {
      return '15+';
    }
  };

  const bookingHoursDisplay = (() => {
    try {
      const start = rates?.reservationStartTime || '12:00';
      const end = rates?.reservationEndTime || '02:00';
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      let startMins = sh * 60 + (sm || 0);
      let endMins = eh * 60 + (em || 0);
      if (endMins <= startMins) endMins += 24 * 60;
      const cutoffMins = endMins - 60; 
      if (cutoffMins <= startMins) return 'No online bookings';
      return `${fmt12(start)} to ${fmt12(cutoffMins)}`;
    } catch (e) {
      return `${rates?.reservationStartTime || '12:00'} to ${rates?.reservationEndTime || '02:00'}`;
    }
  })();

  const maxAllowedPartySize = (() => {
    const wDayMax = Number(reservationTerms?.weekdayMaxPartySize) || 20;
    const wEndMax = Number(reservationTerms?.weekendMaxPartySize) || 20;
    if (!selectedDate) return Math.max(wDayMax, wEndMax);
    const d = new Date(selectedDate);
    const isWeekend = d.getDay() === 0 || d.getDay() === 5 || d.getDay() === 6;
    return isWeekend ? wEndMax : wDayMax;
  })();

  const getMaxDuration = () => {
    if (!resForm.timeSlot) return reservationTerms?.maxHours || 6;
    const parseToMins = (t: string) => {
      const [hh = '0', mm = '0'] = (t || '').split(':');
      return Number(hh) * 60 + Number(mm || 0);
    };
    const slotMins = parseToMins(resForm.timeSlot);
    const startMins = parseToMins(rates?.reservationStartTime || '12:00');
    let endMins = parseToMins(rates?.reservationEndTime || '02:00');
    if (endMins <= startMins) endMins += 24 * 60;
    let normalizedSlotMins = slotMins;
    if (slotMins < startMins) normalizedSlotMins += 24 * 60;
    const minsUntilClose = endMins - normalizedSlotMins;
    return Math.max(1, Math.min(Math.floor(minsUntilClose / 60), reservationTerms?.maxHours || 6));
  };

  const maxAllowedDuration = getMaxDuration();

const validateTimeSlotHelper = (time: string, duration: number, dateObj: Date | null, tableId: string | null): string => {    if (!time || !dateObj) return 'invalid';
    if (!tableId) return 'no_table';
    const parseToMins = (t: string) => {
      const [hh = '0', mm = '0'] = (t || '').split(':');
      return Number(hh) * 60 + Number(mm || 0);
    };
    const slotMins = parseToMins(time);
    const requestedStart = new Date(dateObj);
    const [h, m] = time.split(':').map(Number);
    requestedStart.setHours(h, m, 0, 0);
    const requestedEnd = addMinutes(requestedStart, duration * 60);

    if (isToday(requestedStart)) {
      const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
      if (slotMins <= nowMins) return 'past'; 
      if (slotMins < nowMins + 60) return 'advance';
    }

    const startReserveMins = parseToMins(rates?.reservationStartTime || '12:00');
    let endReserveMins = parseToMins(rates?.reservationEndTime || '02:00');
    if (endReserveMins <= startReserveMins) endReserveMins += 24 * 60;

    let normalizedSlot = slotMins;
    if (slotMins < startReserveMins) normalizedSlot += 24 * 60;
    if (normalizedSlot < startReserveMins || normalizedSlot >= endReserveMins) return 'closed';

    const sameTableRes = reservations.filter((r: any) => 
      r.tableId === tableId && 
      r.status !== 'cancelled' && 
      r.status !== 'completed' && 
      isSameDay(new Date(r.date), requestedStart)
    );

    for (const r of sameTableRes) {
      const rStart = new Date(r.date);
      const [rH, rM] = r.timeSlot.split(':').map(Number);
      rStart.setHours(rH, rM, 0, 0);
      const rEnd = addMinutes(rStart, r.durationHours * 60);
      if (requestedStart < rEnd && requestedEnd > rStart) return 'table_conflict';
    }

    if (isToday(requestedStart)) {
      const targetTable = tables.find((t: any) => t.id === tableId);
      if (targetTable?.status === 'occupied' && targetTable.session?.startTime && targetTable.session?.durationMinutes) {
         const sessionEnd = addMinutes(new Date(targetTable.session.startTime), targetTable.session.durationMinutes);
         if (requestedStart < sessionEnd) return 'active_conflict';
      }
    }

    return 'valid';
  };

  const validateTimeSlot = (time: string, duration: number) => validateTimeSlotHelper(time, duration, selectedDate, selectedTableId);
  const timeValidation = validateTimeSlot(resForm.timeSlot, resForm.duration);
  const [isVerifying, setIsVerifying] = useState(false);

  const handleReservationSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!resForm.name || !resForm.phone || !selectedDate || !selectedTableId || !resForm.timeSlot || timeValidation !== 'valid') return;
    
    if (!isDownPaymentWaived && resForm.paymentMethod === 'gcash') {
      const hasRef = resForm.paymentRef.trim().length > 0;
      const hasImg = receiptFile !== null;
      if (!hasRef && !hasImg) {
        alert("Please provide either a GCash Reference Number OR upload a Receipt Image.");
        return;
      }
    }
    setShowTermsModal(true);
  };

  const executeReservation = async () => {
    setShowTermsModal(false);
    setIsVerifying(true);
    setConfirmingPayment(true);
    
    try {
      let finalReceiptUrl = null;
      if (receiptFile) {
        const fileExt = receiptFile.name.split('.').pop();
        const fileName = `receipt_${Date.now()}_${Math.floor(Math.random() * 1000)}.${fileExt}`;
        const { error: uploadError } = await supabase.storage.from('oneshot-assets').upload(fileName, receiptFile);
        if (uploadError) throw uploadError;
        const { data: publicUrlData } = supabase.storage.from('oneshot-assets').getPublicUrl(fileName);
        finalReceiptUrl = publicUrlData.publicUrl;
      }

      const reservationDate = new Date(selectedDate!);
      const [hours, minutes] = resForm.timeSlot.split(':').map(Number);
      reservationDate.setHours(hours, minutes, 0, 0);

      const newId = addReservation({
        customerName: resForm.name,
        contactNumber: resForm.phone,
        email: resForm.email,
        date: reservationDate,
        timeSlot: resForm.timeSlot,
        durationHours: resForm.duration,
        partySize: resForm.pax,
        tableId: selectedTableId,
        status: isDownPaymentWaived ? 'confirmed' : 'pending',
        totalAmount,
        downPaymentAmount: isDownPaymentWaived ? 0 : downPayment,
        downPaymentPaid: isDownPaymentWaived ? true : !!finalReceiptUrl || !!resForm.paymentRef.trim(),
        balancePaid: false,
        paymentRef: isDownPaymentWaived ? 'TRUSTED_WAIVER' : (resForm.paymentMethod === 'cash' ? 'CASH' : resForm.paymentRef),
        promoCode: appliedPromo?.code,
        discountAmount: discountAmount > 0 ? discountAmount : undefined,
        receiptImg: finalReceiptUrl || undefined,
        rescheduleCount: 0
      });

      await supabase.from('reservations').upsert([{
        id: newId,
        customerName: resForm.name,
        contactNumber: resForm.phone,
        email: resForm.email || null,
        date: reservationDate.toISOString(),
        timeSlot: resForm.timeSlot,
        durationHours: resForm.duration,
        partySize: resForm.pax,
        tableId: selectedTableId,
        status: isDownPaymentWaived ? 'confirmed' : 'pending',
        totalAmount: totalAmount,
        downPaymentAmount: isDownPaymentWaived ? 0 : downPayment,
        downPaymentPaid: (isDownPaymentWaived || !!finalReceiptUrl || !!resForm.paymentRef.trim()) ? 1 : 0,
        balancePaid: 0,
        paymentRef: isDownPaymentWaived ? 'TRUSTED_WAIVER' : (resForm.paymentMethod === 'cash' ? 'CASH' : (resForm.paymentRef || null)),
        receiptImg: finalReceiptUrl || null,
        rescheduleCount: 0,
        createdAt: new Date().toISOString()
      }]);

      setGeneratedResId(newId || Math.random().toString(36).substring(2, 8).toUpperCase());
      setReservationStep(3);
      setToastMsg({ title: "Booking Successful", desc: `Reservation ${newId} confirmed!`, type: 'success' });
    } catch (error) {
      console.error("Payment Confirmation Error:", error);
      setToastMsg({ title: "Error", desc: "Failed to confirm reservation. Please try again.", type: 'error' });
    } finally {
      setIsVerifying(false);
      setConfirmingPayment(false);
    }
  };

  const closeReservation = () => {
    setReservationStep(0);
    setAgreedToTerms(false);
    setGeneratedResId('');
    setReceiptImg(null); 
    setReceiptPreview(null);
    setReceiptFile(null);
    setClosureAlert(null); // Reset closure alert
    if (currentUser) setResTab('track');
  };

  const handleCancelBooking = async (id: string, dateString: string, timeSlot: string) => {
    const resDate = new Date(dateString);
    const [hours, minutes] = timeSlot.split(':').map(Number);
    resDate.setHours(hours, minutes, 0, 0);

    const minsUntilRes = (resDate.getTime() - new Date().getTime()) / 60000;

    if (minsUntilRes < 60 && minsUntilRes > 0) {
      setToastMsg({ title: "Action Denied", desc: "Cancellations within 1 hour are non-refundable. Please use 'Report Issue'.", type: 'error' });
      return;
    } else if (minsUntilRes <= 0) {
      setToastMsg({ title: "Action Denied", desc: "This reservation has already started or passed.", type: 'error' });
      return;
    }

    if(window.confirm(`Are you sure you want to cancel this booking?\n\nREFUND NOTICE: Your booking will be marked as "Pending Refund". To process your GCash refund, you must contact our staff at ${cms.phone.split('|')[0].trim()} with your Reservation ID and GCash Number.`)) {
       
       const { error } = await supabase.from('reservations').update({ 
         status: 'pending-refund'
       }).eq('id', id);

       if (error) {
         setToastMsg({ title: "Error", desc: "Failed to cancel booking. Please check connection.", type: 'error' });
         return;
       }
       
       if (trackForm.reservationId || currentUser) {
         setTrackedReservations(prev => prev ? prev.map(r => r.id === id ? { ...r, status: 'pending-refund' } : r) : null);
       }
       
       setToastMsg({ title: "Booking Cancelled", desc: "Marked as Pending Refund. Please contact staff.", type: 'success' });
    }
  };

  const handleRequestReschedule = async (id: string, r: any) => {
    if (r.rescheduleCount >= 1) {
      setToastMsg({ title: "Limit Reached", desc: "Only 1 reschedule allowed per booking.", type: "error" });
      return;
    }
    setRescheduleData({ show: true, reservation: r, newDate: null, timeSlot: r.timeSlot });
  };

  const executeReschedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rescheduleData?.newDate || !rescheduleData?.timeSlot || !rescheduleData.reservation) return;

    const validation = validateTimeSlotHelper(rescheduleData.timeSlot, rescheduleData.reservation.durationHours, rescheduleData.newDate, rescheduleData.reservation.tableId);
    if (validation !== 'valid') {
      setToastMsg({ title: "Invalid Schedule", desc: "Please pick a valid available time slot.", type: "error" });
      return;
    }

    setIsReporting(true);
    const newDateStr = rescheduleData.newDate.toISOString();
    
    try {
      const { error } = await supabase.from('reservations').update({ 
        date: newDateStr, 
        timeSlot: rescheduleData.timeSlot, 
        rescheduleCount: (rescheduleData.reservation.rescheduleCount || 0) + 1 
      }).eq('id', rescheduleData.reservation.id);

      if (error) throw error;

      if (trackForm.reservationId || currentUser) {
        setTrackedReservations(prev => prev ? prev.map(r => r.id === rescheduleData.reservation.id ? { 
          ...r, 
          date: newDateStr, 
          timeSlot: rescheduleData.timeSlot, 
          rescheduleCount: (r.rescheduleCount || 0) + 1 
        } : r) : null);
      }
      setToastMsg({ title: "Rescheduled", desc: "Booking successfully rescheduled.", type: 'success' });
      setRescheduleData(null);
    } catch (error) {
      setToastMsg({ title: "Error", desc: "Failed to reschedule booking.", type: 'error' });
    } finally {
      setIsReporting(false);
    }
  };

  const handleApplyPromo = () => {
    if (!promoCodeInput.trim()) return;
    const promo = applyPromoCode(promoCodeInput.trim());
    if (promo) {
      setAppliedPromo({ code: promo.code, discountPercent: promo.discountPercent });
      setPromoError('');
    } else {
      setPromoError('Invalid or expired promo code.');
      setAppliedPromo(null);
    }
  };

  const handleFeedbackSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!feedbackForm.name || !feedbackForm.contact || !feedbackForm.type || !feedbackForm.message) return;
    addFeedback({ 
      customerName: feedbackForm.name, 
      contactInfo: feedbackForm.contact, 
      rating: 0, 
      feedbackType: feedbackForm.type as any, 
      comment: feedbackForm.type === 'other' ? `[Type: ${feedbackForm.customType}]\n${feedbackForm.message}` : feedbackForm.message, 
      tags: feedbackForm.type === 'other' ? [feedbackForm.customType] : [],
      reservationId: feedbackForm.reservationId || undefined
    });
    setFeedbackSent(true);
    setTimeout(() => { setFeedbackSent(false); setFeedbackForm({ name: '', contact: '', type: '', customType: '', message: '', reservationId: '' }); }, 3000);
  };

  const handleMiniReportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportModalResId || !reportMessage.trim()) return;
    setIsReporting(true);
    
    addFeedback({ 
      customerName: currentUser?.name || 'Guest', 
      contactInfo: currentUser?.email || 'N/A', 
      rating: 0, 
      feedbackType: 'complaint', 
      comment: reportMessage, 
      tags: ['Priority Resolution'],
      reservationId: reportModalResId
    });

    setTimeout(() => {
      setIsReporting(false);
      setReportModalResId(null);
      setReportMessage('');
      alert("Issue reported successfully. The management team has been notified in real-time.");
    }, 800);
  };

  const getEventImage = (attachments: any) => {
    if (!attachments) return null;
    try {
      const parsed = typeof attachments === 'string' ? JSON.parse(attachments) : attachments;
      return Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : null;
    } catch {
      return typeof attachments === 'string' ? attachments : null;
    }
  };

  const publicEvents = events?.filter((e: any) => e.type !== 'Holiday') || [];
  const upcomingEvents = publicEvents.filter((e: any) => {
    const dates = e.date ? e.date.split(',') : [];
    const sortedDates = [...dates].sort((a,b) => new Date(a).getTime() - new Date(b).getTime());
    const lastDate = sortedDates[sortedDates.length - 1];
    return lastDate ? !isBefore(new Date(lastDate), todayStart) : true;
  });

  const pastEvents = publicEvents.filter((e: any) => {
    const dates = e.date ? e.date.split(',') : [];
    const sortedDates = [...dates].sort((a,b) => new Date(a).getTime() - new Date(b).getTime());
    const lastDate = sortedDates[sortedDates.length - 1];
    return lastDate ? isBefore(new Date(lastDate), todayStart) : false;
  });

  const isEventOver7DaysOld = (dateStr: string) => {
    try {
      const dates = dateStr ? dateStr.split(',') : [];
      const sortedDates = [...dates].sort((a,b) => new Date(a).getTime() - new Date(b).getTime());
      const lastDate = sortedDates[sortedDates.length - 1];
      if (!lastDate) return false;
      return differenceInDays(todayStart, startOfDay(new Date(lastDate))) >= 7;
    } catch {
      return false;
    }
  };

  const reservedDates = reservations?.filter((r: any) => r.status !== 'cancelled').map((r: any) => new Date(r.date)) || [];

  const allNavSections: { id: string; label: string }[] = [
    { id: 'home', label: 'Home' },
    { id: 'reservations', label: 'Reservations' },
    { id: 'rates', label: 'Rates' },
    { id: 'events', label: 'Events' },
    { id: 'about', label: 'About Us' },
    { id: 'feedback', label: 'Feedback' },
  ];

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col">

      {/* ── Top Header ── */}
      <header className="fixed top-0 left-0 right-0 z-50 h-[72px] bg-neutral-950/95 backdrop-blur-md border-b border-neutral-800/60 flex items-center overflow-visible">
        <button
          onClick={() => handleNavClick('home')}
          className="h-full flex items-center px-5 pr-12 bg-emerald-700 hover:bg-emerald-600 transition-colors flex-shrink-0 relative z-10 cursor-pointer text-left"
          style={{ clipPath: 'polygon(0 0, 100% 0, 82% 100%, 0 100%)', minWidth: 220 }}
        >
          <div className="flex items-center gap-2.5">
            <img src={logoImg} alt="One Shot Bar & Billiards" className="h-9 w-9 object-contain rounded-lg flex-shrink-0" />
            <div>
              <p className="text-white text-[17px] font-black tracking-tight leading-tight">ONE SHOT</p>
              <p className="text-emerald-200 text-[10px] uppercase tracking-[0.2em] font-semibold">Bar & Billiards</p>
            </div>
          </div>
        </button>

        <div className="flex-1" />

        <div className="flex items-center gap-4 pr-5 flex-shrink-0 relative">
          
          {/* Notifications */}
          <div className="relative">
            <button
              onClick={() => setShowAnnouncements(!showAnnouncements)}
              className="relative p-2 text-neutral-400 hover:text-white transition-colors rounded-full hover:bg-neutral-800"
            >
              <Bell size={20} />
              {hasUnread && (
                <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 bg-rose-500 rounded-full border-2 border-neutral-950 animate-pulse" />
              )}
            </button>

            <AnimatePresence>
              {showAnnouncements && (
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  className="absolute top-full mt-2 right-0 w-80 sm:w-96 bg-neutral-950 border border-neutral-800 rounded-2xl shadow-2xl overflow-hidden z-50"
                >
                  <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 bg-neutral-900/50">
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      <Bell size={14} className="text-emerald-500" /> Notifications
                    </h3>
                    {hasUnread && (
                      <button onClick={markAllAsRead} className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300 bg-emerald-950/30 px-2 py-1 rounded transition-colors">
                        Mark all as read
                      </button>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto p-2">
                    {unreadNotifications.length === 0 ? (
                      <p className="text-xs text-neutral-500 text-center py-6">No recent notifications</p>
                    ) : (
                      unreadNotifications.map((n: any) => (
                        <div key={n.id} className="p-3.5 rounded-xl mb-1 bg-neutral-900/40 border border-neutral-800/80">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">{n.type}</span>
                            <span className="text-[10px] text-neutral-500">{format(new Date(n.createdAt), 'MMM d')}</span>
                          </div>
                          <p className="text-xs font-bold text-white mb-0.5">{n.title}</p>
                          <p className="text-xs text-neutral-400 line-clamp-2">{n.content}</p>
                        </div>
                      ))
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="w-px h-6 bg-neutral-800" />

          {/* User Account / Sign In */}
          {currentUser ? (
            <div className="flex items-center gap-2">
              <button onClick={() => setShowProfileModal(true)} className="flex items-center gap-2 bg-emerald-600/10 border border-emerald-600/25 rounded-full px-3 py-1.5 hover:bg-emerald-600/20 transition-colors max-w-[150px]">
                <div className="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center text-[9px] font-black text-white flex-shrink-0">{currentUser.name[0]}</div>
                <span className="text-xs text-emerald-300 font-medium hidden sm:block truncate">{currentUser.name}</span>
              </button>
              <button 
                onClick={() => setShowLogoutConfirm(true)} 
                className="p-2 text-neutral-500 hover:text-rose-400 hover:bg-neutral-800 rounded-full transition-colors"
                title="Log Out"
              >
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <button onClick={() => { setAuthMode('options'); setShowAuthModal(true); }} className="flex items-center gap-1.5 text-xs text-white bg-emerald-600 hover:bg-emerald-500 px-5 py-2 rounded-full transition-all font-bold shadow-lg shadow-emerald-900/30">
              <LogIn size={14} /> <span className="hidden sm:inline">Sign In</span>
            </button>
          )}
        </div>
      </header>

      {/* ── Section Navigation ── */}
      <nav className="fixed top-[72px] left-0 right-0 z-40 bg-neutral-900/95 backdrop-blur-sm border-b border-neutral-800/60 flex items-center justify-center gap-1 px-4 overflow-x-auto h-[54px] hide-scrollbar">
        {allNavSections.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => handleNavClick(id)}
            className={`relative px-4 py-3 text-xs font-semibold whitespace-nowrap transition-all ${
              activeSection === id ? 'text-emerald-400' : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {label}
            {activeSection === id && (
              <motion.span layoutId="navUnderline" className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-full" />
            )}
          </button>
        ))}
      </nav>

      {/* ── Main Content ── */}
      <main className="flex-1 pt-[126px]">
        <AnimatePresence mode="wait">
          
          {/* ════ HOME SECTION ════ */}
          {activeSection === 'home' && (
            <motion.div key="home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
              
              <div className="relative h-[70vh] min-h-[500px] overflow-hidden group bg-neutral-950">
                <AnimatePresence mode="wait" custom={heroSlideDir}>
                  <motion.div
                    key={heroSlideIdx}
                    custom={heroSlideDir}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5 }}
                    className="absolute inset-0 w-full h-full"
                  >
                    <ImageWithFallback 
                      src={(heroSlides[heroSlideIdx] || heroSlides[0]).src} 
                      alt={(heroSlides[heroSlideIdx] || heroSlides[0]).alt} 
                      className="w-full h-full object-cover" 
                    />
                  </motion.div>
                </AnimatePresence>
                <div className="absolute inset-0 bg-gradient-to-t from-neutral-950 via-neutral-950/40 to-transparent pointer-events-none" />

                <button onClick={prevHeroSlide} className="absolute left-4 sm:left-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/50 backdrop-blur-md border border-white/10 flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-all hover:bg-emerald-600 z-20 cursor-pointer shadow-xl"><ChevronLeft size={24} /></button>
                <button onClick={nextHeroSlide} className="absolute right-4 sm:right-8 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/50 backdrop-blur-md border border-white/10 flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-all hover:bg-emerald-600 z-20 cursor-pointer shadow-xl"><ChevronRight size={24} /></button>

                <div className="absolute inset-0 flex flex-col items-center justify-end pb-6 px-6 text-center z-10 pointer-events-none">
                  <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.5 }} className="flex flex-col items-center pointer-events-auto">
                    <p className="text-emerald-400 text-xs uppercase tracking-[0.3em] font-semibold mb-3">{cms.heroTitle}</p>
                    <h1 className="text-5xl md:text-6xl font-black text-white mb-2 tracking-tight">{cms.heroTitle}</h1>
                    <p className="text-emerald-300 text-xl font-light mb-5">{cms.heroSubtitle}</p>
                    <p className="text-neutral-400 text-sm max-w-md mx-auto mb-7 leading-relaxed">{cms.heroDescription}</p>
                    
                    <div className="flex flex-wrap justify-center gap-3 mb-6">
                      <button onClick={() => handleNavClick('reservations')} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-3 rounded-full text-sm font-semibold transition-all shadow-lg shadow-emerald-900/40">
                        <Calendar size={15} /> Book a Table
                      </button>
                      <button onClick={() => handleNavClick('about')} className="flex items-center gap-2 bg-neutral-900/80 backdrop-blur-sm hover:bg-neutral-800 text-neutral-100 px-6 py-3 rounded-full text-sm font-semibold transition-all border border-neutral-700/50">
                        <Info size={15} /> Learn More
                      </button>
                    </div>
                  </motion.div>
                </div>
              </div>

              <div className="bg-neutral-900 border-y border-neutral-800">
                <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-4 divide-x divide-neutral-800">
                  {[
                    { value: String(tables?.length || 0), label: 'Billiard Tables', color: 'text-emerald-400' },
                    { value: `₱${effectiveHourly}`, label: 'Per Hour', color: 'text-amber-400' },
                    { value: getOpenHoursDisplay(), label: 'Hours Open Daily', color: 'text-sky-400' },
                    { value: 'A+', label: 'Facility Grade', color: 'text-rose-400' },
                  ].map(({ value, label, color }) => (
                    <div key={label} className="p-6 text-center">
                      <p className={`text-3xl font-black ${color} mb-1`}>{value}</p>
                      <p className="text-xs text-neutral-500 font-medium uppercase tracking-wider">{label}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* About & Location */}
              <div id="home-about-section" className="max-w-5xl mx-auto px-6 py-16 border-t border-neutral-800">
                <div className="text-center mb-10"><h2 className="text-3xl font-black text-white mb-2">{cms.aboutTitle}</h2><p className="text-neutral-400 text-sm">The story behind Cainta's favorite billiards destination</p></div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center mb-12">
                  <div>
                    <p className="text-emerald-400 text-xs uppercase tracking-widest font-semibold mb-3">Our Mission</p>
                    <p className="text-neutral-400 text-sm leading-relaxed mb-4">{cms.aboutP1}</p>
                    <p className="text-neutral-400 text-sm leading-relaxed mb-4">{cms.aboutP2}</p>
                    <p className="text-neutral-400 text-sm leading-relaxed mb-6">{cms.aboutP3}</p>
                    
                    {/* 🟢 Live Queue Dynamic Wait Time Status & AI Metrics */}
                    {(() => {
                      // Calculate historical metrics securely
                      const totalHistoricalSessions = sessionHistory?.length || 0;
                      const avgDuration = totalHistoricalSessions > 0 
                        ? Math.round(sessionHistory.reduce((acc: number, curr: any) => acc + (curr.durationMinutes || 0), 0) / totalHistoricalSessions) 
                        : 0;

                      return (
                        <div className="bg-gradient-to-r from-emerald-950/60 to-emerald-900/20 border border-emerald-800/50 rounded-2xl p-5 mb-6 shadow-inner relative overflow-hidden group">
                          <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl transition-all group-hover:bg-emerald-500/20" />
                          <div className="relative z-10 flex items-start gap-4">
                            <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center flex-shrink-0 mt-1 shadow-inner">
                              <Sparkles size={18} className="text-emerald-400 animate-pulse" />
                            </div>
                            <div className="flex-1">
                              <h4 className="text-sm font-black text-emerald-400 mb-1">Smart Queue Neural Network</h4>
                              <p className="text-xs text-emerald-100/70 leading-relaxed mb-3 pr-2">
                                Our system tracks live table occupancy and analyzes historical data to give you real-time estimates before you walk in.
                              </p>
                              
                              <div className="grid grid-cols-2 gap-2 mb-3">
                                <div className="bg-emerald-950/80 border border-emerald-800/60 rounded-xl p-3 shadow-lg">
                                  <span className="text-[9px] text-neutral-400 uppercase tracking-wider font-bold block mb-1">Live Wait Estimate</span>
                                  <span className="text-sm font-black text-emerald-400 tracking-wide flex items-center gap-1.5"><Clock size={12}/> {dynamicWaitTime}</span>
                                </div>
                                <div className="bg-neutral-950/80 border border-neutral-800/60 rounded-xl p-3 shadow-lg">
                                  <span className="text-[9px] text-neutral-400 uppercase tracking-wider font-bold block mb-1">Historical Avg Play</span>
                                  <span className="text-sm font-black text-white tracking-wide">{avgDuration > 0 ? `${avgDuration} mins` : 'Gathering Data...'}</span>
                                </div>
                              </div>
                              
                              {totalHistoricalSessions > 0 && (
                                <p className="text-[9px] text-emerald-500/50 font-mono uppercase tracking-widest text-right">
                                  AI Trained on {totalHistoricalSessions} sessions
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5 space-y-3 shadow-inner">
                      <p className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-2">Get in Touch</p>
                      <div className="flex items-center gap-3 text-sm text-neutral-300">
                        <div className="w-8 h-8 rounded-full bg-emerald-950/50 flex items-center justify-center border border-emerald-900/50"><Phone size={14} className="text-emerald-500" /></div>
                        <span>{cms.phone}</span>
                      </div>
                      <div className="flex items-center gap-3 text-sm text-neutral-300">
                        <div className="w-8 h-8 rounded-full bg-emerald-950/50 flex items-center justify-center border border-emerald-900/50"><Mail size={14} className="text-emerald-500" /></div>
                        <span>{cms.email}</span>
                      </div>
                      <div className="flex items-center gap-3 text-sm text-neutral-300">
                        <div className="w-8 h-8 rounded-full bg-emerald-950/50 flex items-center justify-center border border-emerald-900/50"><MapPin size={14} className="text-emerald-500" /></div>
                        <span className="leading-tight">{cms.address}</span>
                      </div>
                    </div>
                  </div>
                  <div className="rounded-2xl overflow-hidden h-full min-h-[300px] border border-neutral-800">
                     <ImageWithFallback src={cms.aboutImage} alt="One Shot Facility" className="w-full h-full object-cover" />
                  </div>
                </div>
                
                <div className="mb-12">
                  <h3 className="text-center text-xl font-bold text-white mb-6">Autobase OAX, Cainta</h3>
                  <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden h-96 relative group">
                    <iframe 
                      src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3861.6425983794347!2d121.12493947585098!3d14.581333485888201!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x3397c70049cd2efb%3A0x4b8fd5634abcd6cc!2sOne%20Shot%20Bar%20and%20Billiards!5e0!3m2!1sen!2sph!4v1700000000000!5m2!1sen!2sph" 
                      className="absolute inset-0 w-full h-full border-0 grayscale hover:grayscale-0 transition-all duration-700"
                      allowFullScreen={false} 
                      loading="lazy" 
                    />
                  </div>
                </div>
              </div>

              {/* FEEDBACK SECTION */}
              <div id="home-feedback-section" className="max-w-2xl mx-auto px-6 py-16 border-t border-neutral-800">
                <div className="text-center mb-8">
                  <h2 className="text-3xl font-black text-white mb-2">Send us Feedback</h2>
                  <p className="text-neutral-400 text-sm">We value your experience. Let us know how we can improve!</p>
                </div>
                {feedbackSent ? (
                  <div className="bg-sky-600/10 border border-sky-600/30 rounded-2xl p-10 text-center">
                    <CheckCircle size={40} className="text-sky-400 mx-auto mb-3" />
                    <p className="text-sky-300 font-semibold text-lg mb-1">Message Sent!</p>
                    <p className="text-neutral-500 text-sm">Our management team will review your message shortly.</p>
                  </div>
                ) : (
                  <form onSubmit={handleFeedbackSubmit} className="bg-neutral-900 border border-neutral-800 rounded-2xl p-8 space-y-5">
                    <div className="flex items-center gap-2 mb-1"><Mail className="text-sky-400" size={18} /><p className="text-sm font-semibold text-white">Direct Message to Management</p></div>
                    <div>
                      <label className="block text-xs text-neutral-400 mb-1.5">Your Name <span className="text-rose-500">*</span></label>
                      <input type="text" value={feedbackForm.name} onChange={e => setFeedbackForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Juan dela Cruz" required className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5 text-sm text-neutral-100 focus:border-sky-500 outline-none" />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs text-neutral-400 mb-1.5">Contact Number <span className="text-rose-500">*</span></label>
                        <input type="tel" inputMode="numeric" value={feedbackForm.contact} onChange={e => setFeedbackForm(f => ({ ...f, contact: e.target.value.replace(/\D/g, '').slice(0, 13) }))} placeholder="09XX-XXX-XXXX" required className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5 text-sm text-neutral-100 focus:border-sky-500 outline-none" />
                      </div>
                      <div>
                        <label className="block text-xs text-neutral-400 mb-1.5">Reservation ID <span className="text-neutral-600">(Optional)</span></label>
                        <input type="text" value={feedbackForm.reservationId} onChange={e => setFeedbackForm(f => ({ ...f, reservationId: e.target.value.toUpperCase() }))} placeholder="e.g. X7B9QA" className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5 text-sm text-neutral-100 focus:border-sky-500 font-mono tracking-widest uppercase outline-none" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-neutral-400 mb-1.5">Type of Feedback <span className="text-rose-500">*</span></label>
                      <div className="relative">
                        <select value={feedbackForm.type} onChange={e => setFeedbackForm(f => ({ ...f, type: e.target.value }))} required className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5 text-sm text-neutral-100 focus:border-sky-500 appearance-none outline-none">
                          <option value="" disabled>Select a category...</option>
                          <option value="compliment">Compliment</option>
                          <option value="suggestion">Suggestion</option>
                          <option value="complaint">Concern / Complaint</option>
                          <option value="lost_item">Lost Item</option>
                          <option value="other">Other</option>
                        </select>
                        <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none" />
                      </div>
                    </div>
                    {feedbackForm.type === 'other' && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="overflow-hidden">
                        <label className="block text-xs text-neutral-400 mb-1.5">Please Specify <span className="text-rose-500">*</span></label>
                        <input type="text" value={feedbackForm.customType} onChange={e => setFeedbackForm(f => ({ ...f, customType: e.target.value }))} placeholder="e.g. Partnership Inquiry" required className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5 text-sm text-neutral-100 focus:border-sky-500 outline-none" />
                      </motion.div>
                    )}
                    <div>
                      <label className="block text-xs text-neutral-400 mb-1.5">Message <span className="text-rose-500">*</span></label>
                      <textarea value={feedbackForm.message} onChange={e => setFeedbackForm(f => ({ ...f, message: e.target.value }))} placeholder="Please provide details..." rows={4} required className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5 text-sm text-neutral-100 focus:border-sky-500 resize-none outline-none" />
                    </div>
                    <button type="submit" disabled={!feedbackForm.name || !feedbackForm.contact || !feedbackForm.type || (feedbackForm.type === 'other' && !feedbackForm.customType) || !feedbackForm.message} className="w-full bg-sky-600 hover:bg-sky-500 disabled:bg-neutral-800 text-white py-3 rounded-xl text-sm font-semibold">Submit Feedback</button>
                  </form>
                )}
              </div>
            </motion.div>
          )}

          {/* ════ RESERVATIONS SECTION (MERGED WITH RATES) ════ */}
          {activeSection === 'reservations' && (
            <motion.div key="reservations" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
              
              <div className="max-w-6xl mx-auto px-4 py-10">
                <div className="text-center mb-8">
                  <h2 className="text-3xl font-black text-white mb-2">{currentUser ? `Welcome back, ${currentUser.name.split(' ')[0]}!` : 'Table Reservations'}</h2>
                  <p className="text-neutral-400 text-sm">Pick your preferred table, secure a slot, or view your digital receipt history.</p>
                </div>

                <div className="flex gap-1 bg-neutral-900 border border-neutral-800 rounded-xl p-1 mb-8 max-w-sm mx-auto">
                  <button onClick={() => setResTab('new')} className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-semibold transition-all ${resTab === 'new' ? 'bg-neutral-800 text-neutral-200' : 'text-neutral-500 hover:text-neutral-300'}`}>
                    <Calendar size={14} /> New Booking
                  </button>
                  <button onClick={() => {
                    setResTab('track');
                    if (currentUser) {
                      setTrackedReservations(reservations.filter((r: any) => r.email?.toLowerCase() === currentUser.email?.toLowerCase()).sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
                    }
                  }} className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-semibold transition-all ${resTab === 'track' ? 'bg-neutral-800 text-neutral-200' : 'text-neutral-500 hover:text-neutral-300'}`}>
                    {currentUser ? <BookOpen size={14} /> : <Search size={14} />} 
                    {currentUser ? 'My Bookings' : 'Track Booking'}
                  </button>
                </div>

                {resTab === 'new' && (
                  <div className="pb-20">
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start relative">
                      
                      {/* LEFT COLUMN: Collapsible Date & All-In-One Collapsible Table Status Board */}
                      <div className="lg:col-span-6 flex flex-col gap-4 h-full">
                      
                      {/* STEP 1: DATE PICKER COLLAPSIBLE ACCORDION */}
                      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden shadow-xl shrink-0">
                        <div 
                          onClick={() => setIsCalendarExpanded(!isCalendarExpanded)}
                          className="bg-neutral-950 px-5 py-4 flex items-center justify-between cursor-pointer hover:bg-neutral-900/80 transition-colors border-b border-neutral-800/80"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-7 h-7 rounded-full bg-emerald-600/20 text-emerald-400 flex items-center justify-center font-bold text-xs">1</div>
                            <div>
                              <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-bold">Step 1 — Booking Date</p>
                              <p className="text-sm font-bold text-white">{selectedDate ? format(selectedDate, 'MMMM d, yyyy') : 'Choose a date...'}</p>
                            </div>
                          </div>
                          <ChevronDown size={18} className={`text-neutral-400 transition-transform duration-300 ${isCalendarExpanded ? 'rotate-180' : ''}`} />
                        </div>

                        <AnimatePresence>
                          {isCalendarExpanded && (
                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="p-4 border-t border-neutral-800/60 bg-neutral-950/40">
                              <MiniCalendar
                                selectedDate={selectedDate}
                                onSelect={(d) => {
                                  setSelectedDate(d);
                                  setClosureAlert(null); // Clear any closure alert when a valid date is picked
                                  setIsCalendarExpanded(false);
                                  setIsTableSelectorExpanded(true);
                                }}
                                reservedDates={reservedDates}
                                closedDates={closedDates || []}
                                onClosedClick={(d, reason) => {
                                  setClosureAlert({ date: d, reason });
                                  setSelectedDate(null); // Clear invalid date
                                  setSelectedTableId(null);
                                }}
                              />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                      {/* STEP 2: ALL-IN-ONE TABLE BOARD */}
                      <div className={`bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden shadow-xl flex flex-col ${isTableSelectorExpanded && selectedDate ? 'flex-1' : 'shrink-0'}`}>
                        <div 
                          onClick={() => selectedDate && setIsTableSelectorExpanded(!isTableSelectorExpanded)}
                          className={`bg-neutral-950 px-5 py-4 flex items-center justify-between border-b border-neutral-800/80 shrink-0 ${selectedDate ? 'cursor-pointer hover:bg-neutral-900/80' : 'opacity-50 cursor-not-allowed'}`}
                        >
                          <div className="flex items-center gap-3">
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs ${selectedTableId ? 'bg-emerald-500 text-white' : 'bg-neutral-800 text-neutral-400'}`}>2</div>
                            <div>
                              <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-bold">Step 2 — Table Selector</p>
                              <p className="text-sm font-bold text-white">
                                {selectedTableId ? `${tables.find((t: any) => t.id === selectedTableId)?.name} Selected` : selectedDate ? 'Select an available table below' : 'Select a date first'}
                              </p>
                            </div>
                          </div>
                          <ChevronDown size={18} className={`text-neutral-400 transition-transform duration-300 ${isTableSelectorExpanded ? 'rotate-180' : ''}`} />
                        </div>

                        <AnimatePresence>
                          {isTableSelectorExpanded && selectedDate && (
                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="p-5 bg-neutral-950/30 flex-1 overflow-y-auto hide-scrollbar">
                              
                              <div className="flex items-center justify-between mb-3 text-xs text-neutral-400">
                                <span className="font-semibold text-[11px] uppercase tracking-wider">Venue Layout Status</span>
                                <div className="flex items-center gap-3 text-[10px]">
                                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Free</span>
                                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Active</span>
                                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500" /> Maint.</span>
                                </div>
                              </div>

                              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                                {tables.filter((t: any) => t.isActive).map((table: any) => {
                                  const isSel = selectedTableId === table.id;
                                  const isOcc = table.status === 'occupied';
                                  const isMaint = table.status === 'maintenance';
                                  
                                  return (
                                    <button
                                      key={table.id}
                                      type="button"
                                      disabled={isMaint}
                                      onClick={() => setSelectedTableId(table.id)}
                                      className={`relative p-3 rounded-xl border text-left flex flex-col justify-between transition-all ${
                                        isMaint 
                                          ? 'bg-neutral-900/30 border-neutral-800/40 opacity-40 cursor-not-allowed'
                                          : isSel 
                                          ? 'bg-emerald-950/40 border-emerald-500 shadow-lg shadow-emerald-900/30 scale-[1.02]' 
                                          : 'bg-neutral-900/80 border-neutral-800 hover:border-neutral-600'
                                      }`}
                                    >
                                      <div className="flex justify-between items-center mb-1">
                                        <span className={`text-xs font-bold ${isSel ? 'text-emerald-400' : 'text-neutral-200'}`}>{table.name}</span>
                                        <span className={`w-2 h-2 rounded-full ${isMaint ? 'bg-rose-500' : isOcc && isToday(selectedDate) ? 'bg-amber-400 animate-pulse' : 'bg-emerald-500'}`} />
                                      </div>
                                      <p className="text-[10px] text-neutral-400 truncate">
                                        {isMaint ? 'Unavailable' : isOcc && isToday(selectedDate) ? 'Playing Now' : 'Available Slot'}
                                      </p>
                                    </button>
                                  );
                                })}
                              </div>

                              {/* SELECTED TABLE SCHEDULE */}
                              {selectedTableId && (
                                <div className="mt-5 bg-neutral-950 rounded-xl p-4 border border-neutral-800 animate-in fade-in zoom-in-95">
                                  <p className="text-[10px] text-emerald-500 uppercase tracking-widest font-bold mb-3 flex items-center gap-1.5">
                                    <Calendar size={12} /> {tables.find((t: any) => t.id === selectedTableId)?.name} — Schedule for {format(selectedDate, 'MMM d')}
                                  </p>
                                  {(() => {
                                    const targetTable = tables.find((t: any) => t.id === selectedTableId);
                                    const isActiveWalkIn = isToday(selectedDate) && targetTable?.status === 'occupied' && targetTable.session?.startTime;
                                    
                                    const tableRes = reservations.filter((r: any) => 
                                      r.tableId === selectedTableId && 
                                      isSameDay(new Date(r.date), selectedDate) && 
                                      r.status !== 'cancelled' && 
                                      r.status !== 'completed'
                                    ).sort((a: any, b: any) => {
                                      const timeA = a.timeSlot.split(':').map(Number);
                                      const timeB = b.timeSlot.split(':').map(Number);
                                      return (timeA[0]*60 + timeA[1]) - (timeB[0]*60 + timeB[1]);
                                    });

                                    if (tableRes.length === 0 && !isActiveWalkIn) return <p className="text-xs text-neutral-500 italic">No bookings on this date.</p>;

                                    return (
                                      <div className="space-y-2">
                                        {isActiveWalkIn && targetTable.session && (
                                          <div className="flex items-center gap-3 bg-amber-950/20 p-2.5 rounded-lg border border-amber-900/30">
                                            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                                            <span className="text-amber-200 text-xs font-semibold">Walk-in Playing</span>
                                            <span className="text-amber-500/70 text-[10px] font-medium ml-auto">
                                              {targetTable.session.isOpenTime 
                                                ? 'Open Time (No set end)' 
                                                : `Until ${format(addMinutes(new Date(targetTable.session.startTime), targetTable.session.durationMinutes || 60), 'h:mm a')}`
                                              }
                                            </span>
                                          </div>
                                        )}
                                        {tableRes.map((r: any) => {
                                          const rStart = new Date(r.date);
                                          const [rH, rM] = r.timeSlot.split(':').map(Number);
                                          rStart.setHours(rH, rM, 0, 0);
                                          const rEnd = addMinutes(rStart, r.durationHours * 60);
                                          return (
                                            <div key={r.id} className="flex items-center gap-3 bg-neutral-900 p-2.5 rounded-lg border border-neutral-800">
                                              <div className="w-2 h-2 rounded-full bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.5)]" />
                                              <span className="text-neutral-200 text-xs font-semibold">{format(rStart, 'h:mm a')} - {format(rEnd, 'h:mm a')}</span>
                                              <span className="text-neutral-500 text-[10px] font-medium ml-auto">{r.durationHours}h reserved</span>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    );
                                  })()}
                                </div>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                    </div>

                    {/* RIGHT COLUMN: Reservation Schedule & Customer Details */}
                    <div className="lg:col-span-6 flex flex-col h-full">
                      {/* 🟢 NEW: Date Closed Notice takes over Step 3 if a closed date was clicked */}
                      {closureAlert ? (
                        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-10 text-center flex flex-col items-center justify-center gap-3 flex-1 min-h-[400px] shadow-xl animate-in fade-in zoom-in-95">
                          <XCircle size={64} className="text-rose-500 mb-2" />
                          <h2 className="text-2xl font-black text-white mb-1">Date Unavailable</h2>
                          <p className="text-neutral-400 text-sm mb-4">We are closed on {format(closureAlert.date, 'MMMM d, yyyy')}</p>
                          <div className="bg-rose-950/20 border border-rose-900/50 px-8 py-4 rounded-xl mb-6 shadow-inner w-full max-w-sm">
                            <span className="text-sm font-semibold text-rose-400">{closureAlert.reason}</span>
                          </div>
                          <button onClick={() => setClosureAlert(null)} className="px-10 py-3.5 bg-neutral-800 hover:bg-neutral-700 text-white font-bold rounded-xl transition-colors border border-neutral-700">
                            Choose Another Date
                          </button>
                        </div>
                      ) : reservationStep === 3 ? (
                        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-10 text-center flex flex-col items-center justify-center gap-3 flex-1 min-h-[400px] shadow-xl">
                          <CheckCircle size={64} className="text-emerald-500 mb-2" />
                          <h2 className="text-2xl font-black text-white mb-1">Booking Submitted!</h2>
                          <p className="text-neutral-400 text-sm mb-4">Your Reservation ID is:</p>
                          <div className="bg-neutral-950 border border-neutral-800 px-8 py-4 rounded-xl mb-6 shadow-inner">
                            <span className="text-3xl font-mono tracking-widest text-emerald-400 font-black">{generatedResId}</span>
                          </div>
                          <p className="text-xs text-neutral-500 mb-6 max-w-sm">Please screenshot or save this ID. You can track your booking status and manage your schedule in the "My Bookings" tab.</p>
                          <button onClick={closeReservation} className="px-10 py-3.5 bg-neutral-800 hover:bg-neutral-700 text-white font-bold rounded-xl transition-colors border border-neutral-700">Done</button>
                        </div>
                      ) : (
                        <div className="relative flex-1 flex flex-col">
                          {!selectedDate || !selectedTableId ? (
                            <div className="absolute inset-0 z-10 bg-neutral-950/40 backdrop-blur-[2px] rounded-2xl flex items-center justify-center pointer-events-none">
                              <div className="bg-neutral-900/90 border border-neutral-700 px-5 py-3 rounded-xl shadow-2xl flex items-center gap-2">
                                <Table2 size={16} className="text-neutral-400" />
                                <p className="text-sm font-semibold text-neutral-200">Complete Steps 1 & 2 to unlock</p>
                              </div>
                            </div>
                          ) : null}
                          
                          <form onSubmit={handleReservationSubmit} className={`bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-5 shadow-xl flex-1 flex flex-col transition-all duration-300 ${(!selectedDate || !selectedTableId) ? 'opacity-40 grayscale pointer-events-none' : ''}`}>
                            <div className="flex justify-between items-center pb-2 border-b border-neutral-800 shrink-0">
                              <p className="text-xs font-bold uppercase tracking-widest text-emerald-400">Step 3 — Schedule & Details</p>
                              <span className="text-xs font-bold text-white bg-neutral-800 px-3 py-1 rounded-lg">
                                {tables.find((t: any) => t.id === selectedTableId)?.name || 'Table'}
                              </span>
                            </div>

                            <div className="shrink-0 space-y-4">
                              <div>
                                <label className="block text-xs text-neutral-400 mb-1">Full Name *</label>
                                <input type="text" value={resForm.name} onChange={e => setResForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Juan dela Cruz" className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-100 outline-none focus:border-emerald-500" />
                              </div>

                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-xs text-neutral-400 mb-1">Email Address</label>
                                  <input type="email" value={resForm.email} onChange={e => setResForm(f => ({ ...f, email: e.target.value }))} placeholder="juan@email.com" className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-100 outline-none focus:border-emerald-500" />
                                </div>
                                <div>
                                  <label className="block text-xs text-neutral-400 mb-1">Phone Number *</label>
                                  <input type="tel" inputMode="numeric" value={resForm.phone} onChange={e => setResForm(f => ({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 13) }))} placeholder="09XX-XXX-XXXX" className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-100 outline-none focus:border-emerald-500" />
                                </div>
                              </div>

                              <div className="grid grid-cols-3 gap-3">
                                <div className="col-span-1">
                                  <label className="block text-xs text-neutral-400 mb-1.5 flex justify-between items-end">
                                    <span>Pax</span>
                                    <span className="text-[9px] text-emerald-500 font-bold ml-1">Max {maxAllowedPartySize}</span>
                                  </label>
                                  <input type="number" min={1} max={maxAllowedPartySize} value={resForm.pax} onChange={e => setResForm(f => ({ ...f, pax: parseInt(e.target.value) || 1 }))} className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-100 text-center outline-none focus:border-emerald-500" />
                                </div>
                                <div className="col-span-1">
                                  <label className="block text-xs text-neutral-400 mb-1.5">Start Time *</label>
                                  <input type="time" style={{ colorScheme: 'dark' }} value={resForm.timeSlot} onChange={e => setResForm(f => ({ ...f, timeSlot: e.target.value }))} className={`w-full bg-neutral-950 border rounded-xl px-3 py-2.5 text-sm text-neutral-100 text-center outline-none ${['closed', 'happyhour', 'full', 'table_conflict', 'active_conflict'].includes(timeValidation) ? 'border-rose-500/50 text-rose-200' : 'border-neutral-800 focus:border-emerald-500'}`} />
                                </div>
                                <div className="col-span-1">
                                  <label className="block text-xs text-neutral-400 mb-1.5 flex justify-between items-end flex-shrink-0">
                                    <span>Duration</span>
                                    {resForm.timeSlot && <span className="text-[9px] text-amber-500 text-right leading-tight max-w-[80px]">Max ~{maxAllowedDuration}h</span>}
                                  </label>
                                  <select value={resForm.duration} onChange={e => setResForm(f => ({ ...f, duration: parseInt(e.target.value) }))} className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-3 py-2.5 text-sm text-neutral-100 outline-none focus:border-emerald-500 text-center appearance-none">
                                    {Array.from({ length: maxAllowedDuration }, (_, i) => i + 1).map(h => (
                                      <option key={h} value={h}>{h}h</option>
                                    ))}
                                  </select>
                                </div>
                              </div>

                              <div className="mt-2 space-y-1">
                                {timeValidation === 'past' && <p className="text-[10px] text-rose-400 font-semibold flex items-center gap-1"><XCircle size={10} /> This time slot has already passed.</p>}
                                {timeValidation === 'advance' && <p className="text-[10px] text-amber-500 font-semibold flex items-center gap-1"><AlertTriangle size={10} /> Requires at least 1 hour advance notice.</p>}
                                {timeValidation === 'closed' && <p className="text-[10px] text-rose-400 font-semibold flex items-center gap-1"><XCircle size={10} /> Outside operating hours.</p>}
                                {timeValidation === 'happyhour' && <p className="text-[10px] text-amber-500 font-semibold flex items-center gap-1"><AlertTriangle size={10} /> Happy Hour is strictly walk-in only.</p>}
                                {timeValidation === 'full' && <p className="text-[10px] text-rose-400 font-bold flex items-center gap-1"><Users size={10} /> Venue online capacity limit reached.</p>}
                                {timeValidation === 'event_blocked' && <p className="text-[10px] text-rose-400 font-bold flex items-center gap-1"><AlertTriangle size={10} /> Overlaps with a special event.</p>}
                                
                                {timeValidation === 'table_conflict' && (
                                  <div className="text-[10px] text-rose-400 font-bold flex items-start gap-1.5 bg-rose-950/30 p-2.5 rounded border border-rose-900/50 mt-2">
                                    <XCircle size={14} className="flex-shrink-0 mt-0.5" /> 
                                    <span>Time slot overlaps with another reservation. Check the table schedule in Step 2.</span>
                                  </div>
                                )}
                                {timeValidation === 'active_conflict' && (
                                  <div className="text-[10px] text-amber-400 font-bold flex items-start gap-1.5 bg-amber-950/20 p-2.5 rounded border border-amber-900/30 mt-2">
                                    <Clock size={14} className="flex-shrink-0 mt-0.5" /> 
                                    <span>A walk-in customer is currently playing on this table. Please allow buffer time.</span>
                                  </div>
                                )}
                                {timeValidation === 'valid' && (
                                  <p className="text-[10px] text-emerald-400 font-semibold flex items-center gap-1 mt-2">
                                    <CheckCircle size={10} /> Schedule looks good!
                                  </p>
                                )}
                              </div>
                            </div>

{/* Promo Code */}
<div className="border-t border-neutral-800 pt-4">
  <p className="text-xs text-neutral-500 uppercase tracking-wider font-bold mb-2">Promo Code</p>
  {appliedPromo ? (
    <div className="flex items-center justify-between bg-emerald-950/30 border border-emerald-800/50 rounded-lg px-3 py-2">
      <span className="text-xs text-emerald-400 font-bold flex items-center gap-1.5">
        <Tag size={12} /> {appliedPromo.code} applied ({appliedPromo.discountPercent}% off)
      </span>
      <button 
        type="button" 
        onClick={() => { setAppliedPromo(null); setPromoCodeInput(''); setPromoError(''); }} 
        className="text-neutral-500 hover:text-white"
      >
        <X size={14} />
      </button>
    </div>
  ) : (
    <div className="flex gap-2">
      <input 
        type="text" 
        value={promoCodeInput} 
        onChange={e => { setPromoCodeInput(e.target.value.toUpperCase()); setPromoError(''); }} 
        placeholder="Enter promo code" 
        className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-100 uppercase tracking-widest outline-none focus:border-emerald-500" 
      />
      <button 
        type="button" 
        onClick={handleApplyPromo} 
        className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white text-xs font-bold rounded-lg transition-colors"
      >
        Apply
      </button>
    </div>
  )}
  {promoError && <p className="text-[10px] text-rose-400 mt-1.5">{promoError}</p>}
</div>

                            {/* Payment Block */}
                            <div className="space-y-3 border-t border-neutral-800 pt-4">
                              <div className="flex justify-between items-center">
                                <p className="text-xs text-amber-500 uppercase tracking-wider font-bold">Down Payment Info</p>
                                <div className="flex bg-neutral-950 border border-neutral-800 rounded-lg p-1">
                                  <span className={`px-3 py-1 text-xs font-semibold rounded-md ${isDownPaymentWaived ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-sky-500/20 text-sky-400 border border-sky-500/30'}`}>
                                    {isDownPaymentWaived ? 'Waived (Trusted)' : 'GCash'}
                                  </span>
                                </div>
                              </div>
                              </div>
{!isDownPaymentWaived && resForm.paymentMethod === 'gcash' && (
  <div className="flex flex-col items-center gap-2 mb-3">
    <img 
      src="https://olywhyaozjlkjrnsdydg.supabase.co/storage/v1/object/public/oneshot-assets/GCASH%20QR%20OPTIMIZED.jpg" 
      alt="GCash QR Code" 
      className="w-40 h-40 object-contain rounded-lg border border-neutral-700 bg-white p-1" 
    />
    <p className="text-[10px] text-neutral-500 text-center max-w-xs">
      Scan to pay via GCash, then enter your reference number or upload your receipt below.
    </p>
  </div>
)}

{!isDownPaymentWaived ? (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
    <div>
      <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Ref No.</label>
      <input type="text" value={resForm.paymentRef} onChange={e => setResForm(f => ({ ...f, paymentRef: e.target.value.replace(/\D/g, '').slice(0, 13) }))} className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm text-neutral-200 focus:border-amber-500 font-mono tracking-widest mt-1.5 outline-none" />
    </div>
    <div>
      <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Receipt Image</label>
      <div className="flex items-center gap-3 mt-1.5">
        <label className="flex-1 cursor-pointer bg-neutral-950 border border-dashed border-neutral-700 rounded-lg px-3 py-2 text-center h-[42px] flex items-center justify-center hover:border-neutral-500 transition-colors">
          <input type="file" accept="image/jpeg, image/png" className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) { setReceiptPreview(URL.createObjectURL(file)); setReceiptFile(file); } }} />
          <span className="text-[10px] text-neutral-400 font-semibold">{receiptPreview ? 'Change Image' : 'Upload JPG/PNG'}</span>
        </label>
      </div>
    </div>
  </div>
) : (
  <div className="bg-emerald-950/20 border border-emerald-900/30 rounded-xl p-3 flex items-center gap-3">
    <CheckCircle size={16} className="text-emerald-400 flex-shrink-0" />
    <p className="text-xs text-emerald-400 font-bold">Down payment is waived for Trusted Customers. Your booking will be instantly confirmed.</p>
  </div>
)}

                            <div className="mt-auto pt-4 space-y-4">
                              <div className="bg-neutral-950 rounded-xl p-4 border border-neutral-800/80 text-xs space-y-1.5">
                                <div className="flex justify-between"><span className="text-neutral-400">Total Rate ({resForm.duration}h)</span><span className="text-white font-semibold">₱{totalAmount}.00</span></div>
                                <div className="flex justify-between font-bold text-amber-400">
                                  <span>{isDownPaymentWaived ? 'Down Payment (Waived for Trusted User)' : `Down Payment (${rates?.downPaymentPercent || 25}%)`}</span>
                                  <span>₱{isDownPaymentWaived ? 0 : downPayment}.00</span>
                                </div>
                              </div>

                              <button
                                type="submit"
                                disabled={!resForm.name || !resForm.phone || !resForm.timeSlot || timeValidation !== 'valid' || isVerifying || confirmingPayment}
                                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white py-3.5 rounded-xl font-bold text-sm shadow-lg shadow-emerald-900/30 transition-all flex items-center justify-center gap-2"
                              >
                                {(isVerifying || confirmingPayment) ? <><RefreshCw size={14} className="animate-spin" /> Processing...</> : <>Confirm & Reserve <CheckCircle size={16} /></>}
                              </button>
                            </div>

                          </form>
                        </div>
                      )}
                    </div>

                  </div>
                  
                  <div className="relative overflow-hidden mt-8 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-inner flex flex-col sm:flex-row gap-6 justify-between items-start sm:items-center">
                    
                    <div className="absolute -left-6 md:-left-12 top-1/2 -translate-y-1/2 opacity-[0.15] pointer-events-none mix-blend-plus-lighter">
                      <img 
                        src={logoImg} 
                        alt="One Shot Watermark" 
                        className="w-40 h-40 md:w-56 md:h-56 object-contain"
                        style={{ 
                          WebkitMaskImage: 'linear-gradient(105deg, rgba(0,0,0,1) 30%, rgba(0,0,0,0) 75%)',
                          maskImage: 'linear-gradient(105deg, rgba(0,0,0,1) 30%, rgba(0,0,0,0) 75%)' 
                        }}
                      />
                    </div>

                    <div className="relative z-10">
                      <p className="text-lg font-black text-white flex items-center gap-2 mb-1">
                        <Info size={18} className="text-emerald-500" /> Have a question?
                      </p>
                      <p className="text-xs text-neutral-400 max-w-sm leading-relaxed">
                        Need help with a large party, private event, or special arrangement? Contact us directly.
                      </p>
                    </div>
                    
                    <div className="relative z-10 space-y-3 min-w-[200px]">
                      <a href={`tel:${cms.phone.split('|')[0].trim()}`} className="flex items-center gap-3 text-sm text-neutral-300 hover:text-white transition-colors group">
                        <div className="w-8 h-8 rounded-full bg-emerald-950/50 flex items-center justify-center border border-emerald-900/50 group-hover:bg-emerald-900/80 transition-colors"><Phone size={14} className="text-emerald-500" /></div>
                        <span>{cms.phone.split('|')[0].trim()}</span>
                      </a>
                      <a href={`mailto:${cms.email}`} className="flex items-center gap-3 text-sm text-neutral-300 hover:text-white transition-colors group">
                        <div className="w-8 h-8 rounded-full bg-emerald-950/50 flex items-center justify-center border border-emerald-900/50 group-hover:bg-emerald-900/80 transition-colors"><Mail size={14} className="text-emerald-500" /></div>
                        <span>{cms.email}</span>
                      </a>
                      <a href="https://www.facebook.com/oneshotcainta" target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 text-sm text-neutral-300 hover:text-white transition-colors group">
                        <div className="w-8 h-8 rounded-full bg-emerald-950/50 flex items-center justify-center border border-emerald-900/50 group-hover:bg-emerald-900/80 transition-colors">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-emerald-500" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.477 2 2 6.145 2 11.25c0 2.91 1.506 5.503 3.868 7.158V22l3.522-1.94c1.558.423 3.228.647 4.966.647 5.523 0 10-4.145 10-9.25S17.523 2 12 2zm1.093 12.35l-2.82-3.008-5.495 3.008 6.04-6.42 2.906 3.007 5.41-3.007-6.041 6.42z"/></svg>
                        </div>
                        <span>Messenger</span>
                      </a>
                    </div>
                  </div>
                </div>
                )}

              {/* Guest & User Bookings View with e-Receipt Access */}
              {resTab === 'track' && (
                <div className="max-w-3xl mx-auto">
                  {!currentUser && !trackedReservations ? (
                    <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-8 max-w-lg mx-auto text-center">
                      <Search size={32} className="text-emerald-500 mx-auto mb-3" />
                      <h3 className="text-lg font-bold text-white mb-1">Track Your Booking</h3>
                      <p className="text-xs text-neutral-400 mb-5">Enter your Reservation ID to view session details or open digital receipts.</p>
                      <form onSubmit={(e) => {
                        e.preventDefault();
                        const found = reservations.filter((r: any) => 
                          r.id.toUpperCase() === trackForm.reservationId.toUpperCase()
                        );
                        setTrackedReservations(found);
                      }} className="space-y-4">
                        <input type="text" required value={trackForm.reservationId} onChange={e => setTrackForm(f => ({ ...f, reservationId: e.target.value.toUpperCase() }))} placeholder="Reservation ID (e.g. X7B9QA)" className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-4 py-3 text-center text-sm font-mono tracking-widest text-white uppercase outline-none" />
                        <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl text-sm transition-all shadow-lg shadow-emerald-900/30">Locate Booking</button>
                      </form>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {(() => {
                        const displayRes = currentUser ? userReservations : (trackedReservations || []);
                        if (displayRes.length === 0) {
                          return (
                            <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-12 text-center max-w-lg mx-auto shadow-inner">
                              <BookOpen size={48} className="text-neutral-700 mx-auto mb-4" />
                              <h3 className="text-xl font-bold text-white mb-2">No Bookings Found</h3>
                              <p className="text-sm text-neutral-400 mb-6">We couldn't find any reservations matching those details.</p>
                              <div className="flex flex-wrap items-center justify-center gap-3">
                                {!currentUser && (
                                  <button onClick={() => setTrackedReservations(null)} className="px-6 py-3 bg-neutral-800 hover:bg-neutral-700 text-white text-sm font-bold rounded-xl transition-colors">
                                    Search Again
                                  </button>
                                )}
                                <button onClick={() => setResTab('new')} className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold rounded-xl transition-colors shadow-lg shadow-emerald-900/20">
                                  Make a Reservation
                                </button>
                              </div>
                            </div>
                          );
                        }
                        return (
                          <>
                            {displayRes.map((r: any) => (
                              <div key={r.id} className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                                <div>
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="text-xs font-black text-white font-mono">{r.id}</span>
                                    <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider border ${
                                      r.status === 'pending-reschedule' 
                                        ? 'bg-violet-900/40 text-violet-400 border-violet-700/50' 
                                        : r.status === 'pending-refund'
                                        ? 'bg-rose-900/40 text-rose-400 border-rose-700/50'
                                        : 'bg-neutral-800 text-emerald-400 border-neutral-700'
                                    }`}>
                                      {r.status === 'pending-reschedule' ? 'PENDING RESCHEDULE' : r.status === 'pending-refund' ? 'PENDING REFUND' : r.status}
                                    </span>
                                  </div>
                                  <p className="text-sm font-semibold text-neutral-200">{format(new Date(r.date), 'MMM d, yyyy')} · {r.timeSlot} ({r.durationHours}h)</p>
                                  <p className="text-xs text-neutral-500">
                                    {tables.find((t: any) => t.id === r.tableId)?.name || 'Billiard Table'}
                                  </p>
                                </div>
                                
                                <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto relative">
                                  <button
                                    onClick={() => setViewingReceipt(r)}
                                    className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-bold rounded-xl transition-colors border border-neutral-700"
                                  >
                                    <FileText size={14} className="text-emerald-400" /> View e-Receipt
                                  </button>
                                  
                                  {/* 🟢 Actions Dropdown Menu */}
                                  <div className="relative">
                                    <button 
                                      onClick={(e) => { e.stopPropagation(); setOpenActionRowId(openActionRowId === r.id ? null : r.id); }}
                                      className="px-4 py-2 text-xs font-bold text-neutral-300 bg-neutral-800 hover:bg-neutral-700 rounded-xl transition-colors border border-neutral-700 flex items-center gap-1.5"
                                    >
                                      Actions <ChevronDown size={14} />
                                    </button>
                                    
                                    <AnimatePresence>
                                      {openActionRowId === r.id && (
                                        <motion.div 
                                          initial={{ opacity: 0, y: 5, scale: 0.95 }} 
                                          animate={{ opacity: 1, y: 0, scale: 1 }} 
                                          exit={{ opacity: 0, y: 5, scale: 0.95 }} 
                                          className="absolute right-0 top-full mt-2 w-48 bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl overflow-hidden z-50 flex flex-col py-1"
                                        >
                                          {/* Only logged-in users can cancel */}
                                          {(r.status === 'pending' || r.status === 'pending-reschedule' || r.status === 'confirmed') && currentUser && (
                                             <button onClick={(e) => { e.stopPropagation(); handleCancelBooking(r.id, r.date, r.timeSlot); setOpenActionRowId(null); }} className="px-4 py-3 text-left text-xs font-bold text-rose-400 hover:bg-neutral-800 transition-colors border-b border-neutral-800/50">
                                               Cancel Booking
                                             </button>
                                          )}
                                          
                                          {/* Request Reschedule */}
                                          {(r.status === 'pending' || r.status === 'confirmed') && currentUser && (
                                             <button onClick={(e) => { e.stopPropagation(); handleRequestReschedule(r.id, r); setOpenActionRowId(null); }} className="px-4 py-3 text-left text-xs font-bold text-violet-400 hover:bg-neutral-800 transition-colors border-b border-neutral-800/50">
                                               Request Reschedule
                                             </button>
                                          )}
                                          
                                          {/* Report Issue (Available to Guests too) */}
                                          <button onClick={(e) => { e.stopPropagation(); setReportModalResId(r.id); setReportMessage(''); setOpenActionRowId(null); }} className="px-4 py-3 text-left text-xs font-bold text-amber-400 hover:bg-neutral-800 transition-colors">
                                            Report Issue
                                          </button>
                                        </motion.div>
                                      )}
                                    </AnimatePresence>
                                  </div>
                                </div>
                              </div>
                            ))}

                            {/* 🟢 Dynamic Support Banner */}
                            <div className="relative overflow-hidden mt-8 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-inner flex flex-col sm:flex-row gap-6 justify-between items-start sm:items-center">
                              
                              <div className="absolute -left-6 md:-left-12 top-1/2 -translate-y-1/2 opacity-[0.07] pointer-events-none mix-blend-plus-lighter">
                                <img 
                                  src={logoImg} 
                                  alt="One Shot Watermark" 
                                  className="w-40 h-40 md:w-56 md:h-56 object-contain"
                                  style={{ 
                                    WebkitMaskImage: 'linear-gradient(105deg, rgba(0,0,0,1) 30%, rgba(0,0,0,0) 75%)',
                                    maskImage: 'linear-gradient(105deg, rgba(0,0,0,1) 30%, rgba(0,0,0,0) 75%)' 
                                  }}
                                />
                              </div>

                              <div className="relative z-10">
                                <p className="text-lg font-black text-white flex items-center gap-2 mb-1">
                                  <Info size={18} className="text-emerald-500" /> Have a problem?
                                </p>
                                <p className="text-xs text-neutral-400 max-w-sm leading-relaxed">
                                  Contact us directly regarding refunds, manual rescheduling, or emergency cancellations.
                                </p>
                              </div>
                              
                              <div className="relative z-10 space-y-3 min-w-[200px]">
                                <a href={`tel:${cms.phone.split('|')[0].trim()}`} className="flex items-center gap-3 text-sm text-neutral-300 hover:text-white transition-colors group">
                                  <div className="w-8 h-8 rounded-full bg-emerald-950/50 flex items-center justify-center border border-emerald-900/50 group-hover:bg-emerald-900/80 transition-colors"><Phone size={14} className="text-emerald-500" /></div>
                                  <span>{cms.phone.split('|')[0].trim()}</span>
                                </a>
                                <a href={`mailto:${cms.email}`} className="flex items-center gap-3 text-sm text-neutral-300 hover:text-white transition-colors group">
                                  <div className="w-8 h-8 rounded-full bg-emerald-950/50 flex items-center justify-center border border-emerald-900/50 group-hover:bg-emerald-900/80 transition-colors"><Mail size={14} className="text-emerald-500" /></div>
                                  <span>{cms.email}</span>
                                </a>
                                <a href="https://www.facebook.com/oneshotcainta" target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 text-sm text-neutral-300 hover:text-white transition-colors group">
                                  <div className="w-8 h-8 rounded-full bg-emerald-950/50 flex items-center justify-center border border-emerald-900/50 group-hover:bg-emerald-900/80 transition-colors">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-emerald-500" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.477 2 2 6.145 2 11.25c0 2.91 1.506 5.503 3.868 7.158V22l3.522-1.94c1.558.423 3.228.647 4.966.647 5.523 0 10-4.145 10-9.25S17.523 2 12 2zm1.093 12.35l-2.82-3.008-5.495 3.008 6.04-6.42 2.906 3.007 5.41-3.007-6.041 6.42z"/></svg>
                                  </div>
                                  <span>Messenger</span>
                                </a>
                              </div>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
              </div>
            </motion.div>
          )}

          {/* ════ EVENTS SECTION ════ */}
          {activeSection === 'events' && (
            <motion.div key="events" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className="max-w-screen-md mx-auto px-5 pb-20">
              <div className="text-center mb-10 mt-6">
                <h2 className="text-3xl font-black text-white tracking-tight uppercase mb-2">Events & Tournaments</h2>
                <p className="text-neutral-400 max-w-sm mx-auto text-sm">Official competitions, exhibitions, and venue schedules.</p>
              </div>

              {upcomingEvents.length > 0 && (
                <div className="mb-10 space-y-4">
                  <h3 className="text-xs font-bold text-emerald-400 uppercase tracking-widest flex items-center gap-2"><Calendar size={14} /> Upcoming Events</h3>
                  {upcomingEvents.map((event: any) => (
                    <div key={event.id} className="bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden p-6">
                      {getEventImage(event.attachments) && (
                        <div className="w-full h-48 sm:h-64 bg-neutral-800 overflow-hidden relative mb-4 rounded-xl">
                          <ImageWithFallback src={getEventImage(event.attachments)} alt={event.title} className="w-full h-full object-cover" />
                        </div>
                      )}
                      <div className="flex justify-between items-start mb-2">
                        <span className="text-[10px] bg-emerald-500/20 text-emerald-400 font-bold px-2 py-0.5 rounded">{event.type}</span>
                        <span className="text-xs font-bold text-neutral-400">{event.date}</span>
                      </div>
                      <h4 className="text-lg font-bold text-white mb-2">{event.title}</h4>
                      <p className="text-xs text-neutral-400 leading-relaxed">{event.description}</p>
                    </div>
                  ))}
                </div>
              )}

              {pastEvents.length > 0 && (
                <div className="space-y-4">
                  <h3 className="text-xs font-bold text-neutral-500 uppercase tracking-widest flex items-center gap-2"><Clock size={14} /> Event Archive</h3>
                  {pastEvents.map((event: any) => {
                    const isOver7Days = isEventOver7DaysOld(event.date);
                    return (
                      <div 
                        key={event.id} 
                        className={`rounded-2xl border p-5 transition-all ${
                          isOver7Days 
                            ? 'bg-neutral-950/40 border-neutral-900 text-neutral-600 grayscale opacity-40 select-none' 
                            : 'bg-neutral-900/50 border-neutral-800/80 text-neutral-400'
                        }`}
                      >
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-[9px] bg-neutral-800 text-neutral-400 px-2 py-0.5 rounded font-bold uppercase">{event.type}</span>
                          <span className="text-[10px] font-semibold">{isOver7Days ? 'Archived (>7d ago)' : event.date}</span>
                        </div>
                        <h4 className={`text-sm font-bold mb-1 ${isOver7Days ? 'text-neutral-500 line-through' : 'text-neutral-200'}`}>{event.title}</h4>
                        <p className="text-xs line-clamp-2">{event.description}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </motion.div>
          )}
          {/* ════ RATES SECTION ════ */}
          {activeSection === 'rates' && (
            <motion.div key="rates" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
              <div id="rates-section" className="max-w-4xl mx-auto px-6 py-16">
                <div className="text-center mb-10">
                  <h2 className="text-3xl font-black text-white mb-2">Facility Rates</h2>
                  <p className="text-neutral-400 text-sm">Competitive table fees and advance booking packages.</p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
                  {(() => {
                    const currentDay = new Date().getDay();
                    const isWeekend = currentDay === 0 || currentDay === 5 || currentDay === 6;
                    const isHappyHourActive = isWeekend ? rates?.isWeekendHappyHourActive : rates?.isWeekdayHappyHourActive;
                    const happyHourRate = isWeekend ? rates?.weekendHappyHourRate : rates?.weekdayHappyHourRate;
                    const happyHourStart = isWeekend ? rates?.weekendHappyHourStart : rates?.weekdayHappyHourStart;
                    const happyHourEnd = isWeekend ? rates?.weekendHappyHourEnd : rates?.weekdayHappyHourEnd;
                    const dayTypeLabel = isWeekend ? 'Weekends (Fri-Sun)' : 'Weekdays (Mon-Thu)';

                    return [
                      { name: 'Standard Play', rate: `₱${effectiveHourly}`, unit: '/ hour', desc: 'Walk-in regular play on any available table.', features: ['First-Come First-Served', 'Any available table', 'Cue sticks included', 'Timer monitored'], badge: null, color: 'neutral' },
                      { name: 'Reserved Table', rate: `₱${effectiveHourly}`, unit: '/ hour', desc: 'Book a specific time slot and table in advance.', features: ['Guaranteed table slot', `${rates?.downPaymentPercent ?? 25}% down payment`, 'Priority seating', 'Advance booking'], badge: 'Popular', color: 'emerald' },
                      { 
                        name: 'Happy Hour', 
                        rate: `₱${happyHourRate || 200}`, 
                        unit: '/ hour', 
                        desc: `Discounted walk-in rate today (${dayTypeLabel}) from ${fmt12(happyHourStart || '18:00')}–${fmt12(happyHourEnd || '19:00')}.`, 
                        features: ['Valid today only', 'Walk-in ONLY - No reservations', 'Discounted standard rate', 'Subject to availability'], 
                        badge: 'Limited', 
                        color: 'amber' 
                      },
                    ]
                    .filter(card => card.name !== 'Happy Hour' || isHappyHourActive)
                    .map(({ name, rate, unit, desc, features, badge, color }) => (
                      <div key={name} className={`relative bg-neutral-900 border rounded-2xl p-6 flex flex-col ${color === 'emerald' ? 'border-emerald-600/50 shadow-lg shadow-emerald-950/50' : color === 'amber' ? 'border-amber-600/30' : 'border-neutral-800'}`}>
                        {badge && <span className={`absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full ${color === 'emerald' ? 'bg-emerald-600 text-white' : color === 'amber' ? 'bg-amber-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}>{badge}</span>}
                        <p className={`text-xs uppercase tracking-widest font-semibold mb-2 ${color === 'emerald' ? 'text-emerald-400' : color === 'amber' ? 'text-amber-400' : 'text-neutral-500'}`}>{name}</p>
                        <div className="flex items-end gap-1 mb-3"><span className={`text-4xl font-black ${color === 'emerald' ? 'text-emerald-400' : color === 'amber' ? 'text-amber-400' : 'text-white'}`}>{rate}</span><span className="text-neutral-500 text-sm mb-1">{unit}</span></div>
                        <p className="text-neutral-500 text-xs mb-5 leading-relaxed">{desc}</p>
                        <ul className="space-y-2 flex-1">
                          {features.map(f => <li key={f} className="flex items-center gap-2 text-xs text-neutral-400"><CheckCircle size={12} className={color === 'emerald' ? 'text-emerald-500' : color === 'amber' ? 'text-amber-500' : 'text-neutral-600'} />{f}</li>)}
                        </ul>
                      </div>
                    ));
                  })()}
                </div>

                <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 max-w-4xl mx-auto">
                  <h3 className="text-white font-semibold mb-4">Reservation Policies & Terms</h3>
                  <div className="flex gap-3 bg-emerald-950/40 border border-emerald-700/30 rounded-xl p-4 mb-5">
                    <div className="flex-shrink-0 w-7 h-7 rounded-full bg-emerald-600/20 flex items-center justify-center mt-0.5"><Info size={13} className="text-emerald-400" /></div>
                    <div>
                      <p className="text-emerald-300 text-xs font-semibold mb-1">Reservation Redemption Policy</p>
                      <p className="text-neutral-400 text-xs leading-relaxed">After completing your reservation and {rates?.downPaymentPercent ?? 25}% down payment, the <span className="text-white font-medium">remaining balance must be settled before or after your game</span> — payable via <span className="text-white font-medium">Cash or GCash</span>.</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    {[
                      { label: 'Reservation Rule', value: `Requires at least ${reservationTerms.advanceBookingHours || 1} hour(s) advance notice.` },
                      { label: 'Online Booking Hours', value: bookingHoursDisplay },
                      { label: 'Minimum Booking', value: `${reservationTerms.minHours || 1} hour(s)` },
                      { label: 'Maximum Booking', value: 'Depending on closing cut-off' },
                      { label: 'Grace Period', value: '15 minutes' },
                      { label: 'Cancellation Policy', value: reservationTerms.cancellationPolicy },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex justify-between py-2 border-b border-neutral-800/60"><span className="text-neutral-500">{label}</span><span className="text-neutral-200 font-medium text-right ml-2">{value}</span></div>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          )}

        </AnimatePresence>

        {/* 🟢 FOOTER WITH LEGAL LINKS */}
        <footer className="bg-neutral-900 border-t border-neutral-800 mt-16 py-8 px-6 text-center text-xs text-neutral-600 w-full relative">
          <div className="max-w-4xl mx-auto space-y-4">
            <div className="flex items-center justify-center gap-2.5 mb-3">
              <img src={logoImg} alt="One Shot Bar & Billiards" className="h-8 w-8 object-contain" />
              <span className="text-white font-bold text-sm">One Shot Bar & Billiards</span>
            </div>
            
            <p className="text-neutral-600 text-xs">
              {cms.address} · Mon–Thu {fmt12(rates?.weekdayStartTime || '12:00')}–{fmt12(rates?.weekdayEndTime || '02:00')} · Fri–Sun {fmt12(rates?.weekendStartTime || '12:00')}–{fmt12(rates?.weekendEndTime || '02:00')}
            </p>
            <p className="text-neutral-600 text-xs mt-1">{cms.phone}</p>
            
            <div className="flex items-center justify-center gap-4 mt-6 text-[11px] font-semibold">
              <button onClick={() => navigate('/legal?tab=terms')} className="hover:text-emerald-400 transition-colors">Terms of Service</button>
              <span className="text-neutral-700">|</span>
              <button onClick={() => navigate('/legal?tab=privacy')} className="hover:text-emerald-400 transition-colors">Privacy Policy</button>
            </div>

            <p className="mt-6 text-[10px] text-neutral-700">© 2026 One Shot Bar & Billiards. All rights reserved.</p>
          </div>
        </footer>
      </main>

      {/* ════ MODALS & POPUPS ════ */}
      <AnimatePresence>
        
        {showLogoutConfirm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-neutral-950 border border-neutral-800 rounded-3xl p-6 w-full max-w-sm shadow-2xl space-y-4 text-center">
              <div className="w-12 h-12 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center mx-auto">
                <LogOut size={22} />
              </div>
              <h3 className="text-lg font-black text-white">Log Out Confirmation</h3>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Are you sure you want to end your current session? You will need to sign in again to track your loyalty status and bookings.
              </p>
              <div className="flex gap-2 pt-2">
                <button onClick={() => setShowLogoutConfirm(false)} className="flex-1 py-3 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 font-bold rounded-xl text-xs transition-colors border border-neutral-800">Cancel</button>
                <button onClick={async () => { 
                  if (!checkRateLimit('logout', 5, 5)) return setToastMsg({title:"Rate Limit Exceeded", desc:"Please wait.", type:"error"});
                  await supabase.auth.signOut(); 
                  setShowLogoutConfirm(false); 
                  setShowProfileModal(false); 
                }} className="flex-1 py-3 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-xl text-xs transition-colors">Yes, Log Out</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {viewingReceipt && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.9, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 10 }} className="w-full max-w-sm relative">
              <div className="bg-neutral-100 text-neutral-900 rounded-2xl shadow-2xl p-6 font-mono text-xs space-y-4">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-2xl font-black tracking-tighter">ONE SHOT</h3>
                    <p className="text-[10px] uppercase font-bold text-neutral-500">Official e-Receipt</p>
                  </div>
                  <button onClick={() => setViewingReceipt(null)} className="p-1 text-neutral-500 hover:text-black"><X size={18} /></button>
                </div>

                <div className="border-y border-dashed border-neutral-300 py-3 space-y-1.5 text-[11px]">
                  <div className="flex justify-between"><span>Booking ID:</span><span className="font-bold">{viewingReceipt.id}</span></div>
                  <div className="flex justify-between"><span>Customer:</span><span>{viewingReceipt.customerName}</span></div>
                  <div className="flex justify-between"><span>Date:</span><span>{format(new Date(viewingReceipt.date), 'MM/dd/yyyy')}</span></div>
                  <div className="flex justify-between"><span>Time Slot:</span><span>{viewingReceipt.timeSlot} ({viewingReceipt.durationHours}h)</span></div>
                </div>

                <div className="space-y-1 text-xs font-semibold">
                  <div className="flex justify-between"><span>Table Play Total</span><span>₱{viewingReceipt.totalAmount}.00</span></div>
                  <div className="flex justify-between text-neutral-500"><span>Down Payment Paid</span><span>-₱{viewingReceipt.downPaymentAmount}.00</span></div>
                </div>

                <div className="border-t-2 border-neutral-900 pt-2 flex justify-between font-black text-base">
                  <span>REMAINING AT VENUE</span>
                  <span>₱{Math.max(0, viewingReceipt.totalAmount - viewingReceipt.downPaymentAmount)}.00</span>
                </div>

                <div className="flex flex-col items-center justify-center pt-2">
                  <div className="p-2 border border-neutral-400 rounded-lg mb-1">
                    <QrCode size={56} className="text-neutral-800" />
                  </div>
                  <p className="text-[9px] text-neutral-500 uppercase tracking-widest font-bold">Screenshot for entry</p>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}

        {showProfileModal && currentUser && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowProfileModal(false)}>
            <motion.div initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 10 }} onClick={e => e.stopPropagation()} className="bg-neutral-950 border border-neutral-800 rounded-3xl w-full max-w-sm shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-32 bg-gradient-to-b from-emerald-900/20 to-transparent pointer-events-none" />
              <div className="p-7 relative z-10">
                <div className="flex justify-between items-start mb-8">
                  <div className="flex items-center gap-4">
                    <div className="relative">
                      <div className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center text-2xl font-black text-white shadow-[0_0_20px_rgba(16,185,129,0.3)] ring-4 ring-neutral-950">
                        {currentUser.name[0]}
                      </div>
                      {isTrustedCustomer && (
                        <div className="absolute -bottom-1 -right-1 bg-neutral-950 rounded-full p-1 border border-emerald-900/50">
                          <Shield size={12} className="text-emerald-400 fill-emerald-400/20" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-xl font-black text-white leading-tight truncate">{currentUser.name}</h3>
                      <p className="text-xs text-emerald-400/70 font-medium truncate mt-0.5">{currentUser.email}</p>
                    </div>
                  </div>
                  <button onClick={() => setShowProfileModal(false)} className="text-neutral-500 hover:text-white transition-colors bg-neutral-900/50 p-1.5 rounded-full hover:bg-neutral-800 border border-neutral-800"><X size={16} /></button>
                </div>

                <div className="space-y-4">
                  {isTrustedCustomer ? (
                    <div className="bg-emerald-950/30 border border-emerald-500/50 rounded-2xl p-5 flex items-start gap-4 shadow-lg shadow-emerald-900/10 relative overflow-hidden">
                      <div className="absolute -right-4 -top-4 w-20 h-20 bg-emerald-500/10 rounded-full blur-2xl" />
                      <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0 border border-emerald-500/30">
                        <Shield size={20} className="text-emerald-400" />
                      </div>
                      <div className="relative z-10">
                        <h4 className="text-sm font-black text-emerald-400 mb-1">Trusted Customer</h4>
                        <p className="text-[10px] text-emerald-200/70 leading-relaxed">
                          Zero-downpayment bookings unlocked! Your stellar track record (Score: {netTrustScore}) keeps this perk active.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-neutral-900/80 border border-neutral-800 rounded-2xl p-5 relative overflow-hidden">
                      <div className="flex items-start gap-3 relative z-10">
                        <div className="w-8 h-8 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center shrink-0">
                          <Lock size={14} className="text-neutral-400" />
                        </div>
                        <div className="flex-1">
                          <h4 className="text-sm font-bold text-neutral-200 flex items-center justify-between">
                            Standard Tier
                            <span className="text-[10px] text-emerald-500 font-black">{Math.max(0, netTrustScore)} / 3</span>
                          </h4>
                          <p className="text-[10px] text-neutral-500 leading-relaxed mt-1">
                            Complete {Math.max(0, 3 - netTrustScore)} more bookings without missing to unlock zero-downpayment Trusted Status.
                          </p>
                          <div className="w-full bg-neutral-950 rounded-full h-1.5 mt-3 overflow-hidden border border-neutral-800/50">
                            <motion.div 
                              initial={{ width: 0 }}
                              animate={{ width: `${(Math.max(0, netTrustScore) / 3) * 100}%` }}
                              transition={{ duration: 1, ease: "easeOut" }}
                              className="bg-gradient-to-r from-emerald-600 to-emerald-400 h-full rounded-full" 
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-neutral-900/50 border border-neutral-800/80 p-3 rounded-2xl flex flex-col items-center justify-center relative overflow-hidden group hover:bg-neutral-900 transition-colors">
                      <div className="absolute top-0 right-0 w-16 h-16 bg-emerald-500/5 rounded-full blur-xl transition-all group-hover:bg-emerald-500/10" />
                      <CheckCircle size={14} className="text-emerald-500/40 mb-1" />
                      <p className="text-2xl font-black text-white">{completedBookings}</p>
                      <p className="text-[8px] text-neutral-500 uppercase tracking-widest font-bold mt-1">Completed</p>
                    </div>
                    <div className="bg-neutral-900/50 border border-neutral-800/80 p-3 rounded-2xl flex flex-col items-center justify-center relative overflow-hidden group hover:bg-neutral-900 transition-colors">
                      <div className="absolute top-0 right-0 w-16 h-16 bg-sky-500/5 rounded-full blur-xl transition-all group-hover:bg-sky-500/10" />
                      <Clock size={14} className="text-sky-500/40 mb-1" />
                      <p className="text-2xl font-black text-sky-400">{totalHoursPlayed}</p>
                      <p className="text-[8px] text-neutral-500 uppercase tracking-widest font-bold mt-1">Hours Played</p>
                    </div>
                    <div className="bg-neutral-900/50 border border-neutral-800/80 p-3 rounded-2xl flex flex-col items-center justify-center relative overflow-hidden group hover:bg-neutral-900 transition-colors">
                      <div className="absolute top-0 right-0 w-16 h-16 bg-rose-500/5 rounded-full blur-xl transition-all group-hover:bg-rose-500/10" />
                      <XCircle size={14} className="text-rose-500/40 mb-1" />
                      <p className="text-2xl font-black text-rose-400">{missedBookings}</p>
                      <p className="text-[8px] text-neutral-500 uppercase tracking-widest font-bold mt-1">Missed</p>
                    </div>
                  </div>

                  {userReservations.filter((r: any) => r.status === 'pending-refund').length > 0 && (
                    <div className="p-4 bg-rose-950/30 border border-rose-900/50 rounded-xl mt-4">
                        <p className="text-[10px] font-bold text-rose-400 mb-2 uppercase tracking-wider">Pending Refunds</p>
                        {userReservations.filter((r: any) => r.status === 'pending-refund').map((r: any) => (
                            <div key={r.id} className="text-[10px] text-neutral-300 mb-1.5 flex items-start gap-2">
                                <Clock size={12} className="text-rose-400 shrink-0 mt-0.5" />
                                <span>Refund on Booking ID <span className="font-mono text-white font-bold">{r.id}</span> ({format(new Date(r.date), 'MMM d')}) is pending refund...</span>
                            </div>
                        ))}
                    </div>
                  )}
                </div>
                
                <div className="mt-6 pt-6 border-t border-neutral-800/60 flex flex-col gap-3">
                  <button onClick={() => { setShowProfileModal(false); setActiveSection('reservations'); setResTab('track'); }} className="w-full flex items-center justify-center gap-2 bg-neutral-800/50 hover:bg-neutral-800 border border-neutral-700 text-neutral-200 font-bold py-3.5 rounded-xl transition-colors text-sm shadow-sm">
                    <BookOpen size={16} className="text-emerald-500" /> View My Bookings
                  </button>
                  
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={handleChangePassword} className="w-full flex items-center justify-center gap-2 bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-300 font-semibold py-3 rounded-xl transition-colors text-xs">
                      <Lock size={14} /> Change Password
                    </button>
                    <button onClick={handleDeleteAccount} className="w-full flex items-center justify-center gap-2 bg-neutral-900 hover:bg-rose-950/30 border border-neutral-800 hover:border-rose-900/50 text-rose-400/80 hover:text-rose-400 font-semibold py-3 rounded-xl transition-colors text-xs">
                      <AlertTriangle size={14} /> Delete Account
                    </button>
                  </div>

                  <button onClick={() => setShowLogoutConfirm(true)} className="w-full flex items-center justify-center gap-2 bg-transparent hover:bg-rose-950/30 text-rose-400/80 hover:text-rose-400 font-semibold py-3 rounded-xl transition-colors text-xs mt-2">
                    Sign Out
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}

        {/* 🟢 RESCHEDULE MODAL */}
        {rescheduleData?.show && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-neutral-950 border border-neutral-800 rounded-3xl p-6 w-full max-w-sm shadow-2xl space-y-4">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <h3 className="text-lg font-black text-violet-400 flex items-center gap-2"><Calendar size={18} /> Reschedule Booking</h3>
                  <p className="text-xs text-neutral-500 mt-1">Reservation #{rescheduleData.reservation.id.toUpperCase()}</p>
                </div>
                <button onClick={() => setRescheduleData(null)} className="text-neutral-500 hover:text-white transition-colors"><X size={18} /></button>
              </div>
              
              <form onSubmit={executeReschedule} className="space-y-4">
                <div className="bg-neutral-900/50 p-3 rounded-xl border border-neutral-800">
                  <MiniCalendar
                    selectedDate={rescheduleData.newDate}
                    minDate={new Date()}
                    onSelect={(d) => setRescheduleData(prev => prev ? ({ ...prev, newDate: d }) : null)}
                    reservedDates={reservedDates}
                    closedDates={closedDates || []}
                    onClosedClick={(d, r) => setToastMsg({ title: "Closed", desc: r, type: 'error' })}
                  />
                </div>
                
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">New Time Slot (Duration: {rescheduleData.reservation.durationHours}h) *</label>
                  <input type="time" style={{ colorScheme: 'dark' }} required value={rescheduleData.timeSlot} onChange={e => setRescheduleData(prev => prev ? ({ ...prev, timeSlot: e.target.value }) : null)} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-sm text-neutral-100 focus:border-violet-500 outline-none text-center transition-colors" />
                </div>
                
                <div className="flex gap-2 pt-2">
                  <button type="button" onClick={() => setRescheduleData(null)} className="flex-1 py-3 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 font-bold rounded-xl text-xs transition-colors border border-neutral-800">Cancel</button>
                  <button type="submit" disabled={!rescheduleData.newDate || !rescheduleData.timeSlot || isReporting} className="flex-1 py-3 bg-violet-600 hover:bg-violet-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white font-bold rounded-xl text-xs transition-colors flex items-center justify-center gap-2">
                    {isReporting ? <><RefreshCw size={14} className="animate-spin" /> Verifying...</> : 'Confirm Reschedule'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}

        {showAuthModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowAuthModal(false)}>
            <motion.div initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 10 }} onClick={e => e.stopPropagation()} className="bg-neutral-950 border border-neutral-800 rounded-3xl p-7 w-full max-w-sm shadow-2xl overflow-hidden relative max-h-[90vh] overflow-y-auto hide-scrollbar">
              
              {authMode === 'options' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-2xl font-black text-white">Sign In</h3>
                    <button onClick={() => setShowAuthModal(false)} className="text-neutral-500 hover:text-white transition-colors"><X size={20} /></button>
                  </div>
                  <p className="text-xs text-neutral-400 mb-5">Enter your email to sign in or create a new account.</p>
                  
                  <div className="space-y-3">
                    <input 
                      type="email" 
                      placeholder="Email Address" 
                      value={loginForm.email} 
                      onChange={e => {
                        setLoginForm(f => ({ ...f, email: e.target.value, error: '' }));
                        setRegisterForm(f => ({ ...f, email: e.target.value, error: '' }));
                        setForgotForm(f => ({ ...f, email: e.target.value, error: '' }));
                      }} 
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3.5 text-sm text-neutral-100 focus:border-emerald-500 outline-none transition-colors" 
                    />
                    <button 
                      onClick={() => setAuthMode('login')} 
                      disabled={!loginForm.email.includes('@')}
                      className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white py-3.5 rounded-xl text-sm font-bold shadow-lg shadow-emerald-900/30 transition-colors"
                    >
                      Continue with Email
                    </button>
                  </div>

                  <div className="flex items-center gap-3 py-3 mt-2">
                    <div className="flex-1 h-px bg-neutral-800" />
                    <span className="text-[10px] text-neutral-500 uppercase font-semibold tracking-wider">or continue with</span>
                    <div className="flex-1 h-px bg-neutral-800" />
                  </div>

                  <div className="space-y-3">
                    <button onClick={() => handleOAuthLogin('google')} className="w-full bg-white hover:bg-neutral-200 text-black font-bold py-3 px-4 rounded-xl flex items-center justify-center gap-3 transition-colors shadow-sm">
                      <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                      Continue with Google
                    </button>
                    <button onClick={() => handleOAuthLogin('facebook')} className="w-full bg-[#1877F2] hover:bg-[#166FE5] text-white font-bold py-3 px-4 rounded-xl flex items-center justify-center gap-3 transition-colors shadow-sm">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="#ffffff" xmlns="http://www.w3.org/2000/svg"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.469h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.469h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                      Continue with Facebook
                    </button>
                  </div>

                  <p className="text-center text-xs text-neutral-500 mt-6">
                    Don't have an account? <button onClick={() => setAuthMode('register')} className="text-emerald-400 hover:underline font-bold">Register</button>
                  </p>
                </div>
              )}

              {authMode === 'login' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-2 border-b border-neutral-800/60 pb-4">
                    <button onClick={() => setAuthMode('options')} className="text-neutral-500 hover:text-white transition-colors"><ChevronLeft size={20} /></button>
                    <h3 className="text-lg font-bold text-white flex-1">Enter Password</h3>
                    <button onClick={() => setShowAuthModal(false)} className="text-neutral-600 hover:text-white"><X size={18} /></button>
                  </div>
                  {loginForm.error && <div className="bg-rose-950/40 border border-rose-800/50 text-rose-400 text-xs px-3 py-2 rounded-lg">{loginForm.error}</div>}
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-neutral-400 mb-1.5">Email Address</label>
                      <input type="email" disabled value={loginForm.email} className="w-full bg-neutral-900/50 border border-neutral-800 rounded-xl px-4 py-3 text-sm text-neutral-500 outline-none cursor-not-allowed" />
                    </div>
                    <div>
                      <label className="block text-xs text-neutral-400 mb-1.5">Password</label>
                      <div className="relative">
                        <input type={loginForm.showPw ? 'text' : 'password'} autoFocus placeholder="Enter your password" value={loginForm.password} onChange={e => setLoginForm(f => ({ ...f, password: e.target.value, error: '' }))} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 pr-10 text-sm text-neutral-100 focus:border-emerald-500 outline-none transition-colors" />
                        <button onClick={() => setLoginForm(f => ({ ...f, showPw: !f.showPw }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300">{loginForm.showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                      </div>
                    </div>
                  </div>
                  <button onClick={handleLoginSubmit} disabled={loginForm.loading} className="w-full mt-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white py-3 rounded-xl text-sm font-bold shadow-lg shadow-emerald-900/30 transition-colors">
                    {loginForm.loading ? 'Signing in...' : 'Sign In securely'}
                  </button>
                  <p className="text-center text-xs text-neutral-500 mt-4">
                    Forgot your password? <button onClick={() => setAuthMode('forgot')} className="text-emerald-400 hover:underline font-bold">Reset it</button>
                  </p>
                </div>
              )}

              {authMode === 'register' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-2 border-b border-neutral-800/60 pb-4">
                    <button onClick={() => setAuthMode('options')} className="text-neutral-500 hover:text-white transition-colors"><ChevronLeft size={20} /></button>
                    <h3 className="text-lg font-bold text-white flex-1">Create Account</h3>
                    <button onClick={() => setShowAuthModal(false)} className="text-neutral-600 hover:text-white"><X size={18} /></button>
                  </div>
                  {registerForm.error && <div className="bg-rose-950/40 border border-rose-800/50 text-rose-400 text-xs px-3 py-2 rounded-lg">{registerForm.error}</div>}
                  <div className="space-y-3">
                    {[ { key: 'name', label: 'Full Name', type: 'text' }, { key: 'email', label: 'Email Address', type: 'email' }, { key: 'phone', label: 'Contact Number', type: 'tel' }].map(({ key, label, type }) => (
                      <div key={key}><label className="block text-xs text-neutral-400 mb-1.5">{label}</label><input type={type} inputMode={key === 'phone' ? 'numeric' : undefined} value={(registerForm as any)[key]} onChange={e => setRegisterForm(f => ({ ...f, [key]: key === 'phone' ? e.target.value.replace(/\D/g, '').slice(0, 13) : e.target.value, error: '' }))} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-sm text-neutral-100 focus:border-emerald-500 outline-none transition-colors" /></div>
                    ))}
                    <div><label className="block text-xs text-neutral-400 mb-1.5">Password</label><div className="relative"><input type={registerForm.showPw ? 'text' : 'password'} value={registerForm.password} onChange={e => setRegisterForm(f => ({ ...f, password: e.target.value, error: '' }))} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 pr-10 text-sm text-neutral-100 focus:border-emerald-500 outline-none transition-colors" /><button onClick={() => setRegisterForm(f => ({ ...f, showPw: !f.showPw }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300">{registerForm.showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></div>
                    <div><label className="block text-xs text-neutral-400 mb-1.5">Confirm Password</label><input type="password" value={registerForm.confirm} onChange={e => setRegisterForm(f => ({ ...f, confirm: e.target.value, error: '' }))} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-sm text-neutral-100 focus:border-emerald-500 outline-none transition-colors" /></div>
                  </div>
                  <button onClick={handleRegisterSubmit} disabled={registerForm.loading} className="w-full mt-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white py-3 rounded-xl text-sm font-bold shadow-lg shadow-emerald-900/30 transition-colors">
                    {registerForm.loading ? 'Creating Account...' : 'Register Account'}
                  </button>
                </div>
              )}

              {authMode === 'forgot' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-2 border-b border-neutral-800/60 pb-4">
                    <button onClick={() => setAuthMode('login')} className="text-neutral-500 hover:text-white transition-colors"><ChevronLeft size={20} /></button>
                    <h3 className="text-lg font-bold text-white flex-1">Reset Password</h3>
                    <button onClick={() => setShowAuthModal(false)} className="text-neutral-600 hover:text-white"><X size={18} /></button>
                  </div>
                  
                  {forgotForm.success ? (
                    <div className="bg-emerald-950/20 border border-emerald-900/40 p-5 rounded-xl text-center">
                      <CheckCircle size={32} className="text-emerald-500 mx-auto mb-3" />
                      <p className="text-emerald-400 font-bold mb-1">Recovery Link Sent!</p>
                      <p className="text-xs text-neutral-400">Check your email ({forgotForm.email}) for the secure reset link.</p>
                      <button onClick={() => setAuthMode('options')} className="mt-4 w-full py-2 bg-neutral-800 hover:bg-neutral-700 rounded-lg text-xs font-semibold transition-colors">Back to Sign In</button>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-neutral-400 mb-2">Enter your email address and we'll send you a secure link to reset your password.</p>
                      {forgotForm.error && <div className="bg-rose-950/40 border border-rose-800/50 text-rose-400 text-xs px-3 py-2 rounded-lg">{forgotForm.error}</div>}
                      <div>
                        <label className="block text-xs text-neutral-400 mb-1.5">Email Address</label>
                        <input type="email" autoFocus value={forgotForm.email} onChange={e => setForgotForm(f => ({ ...f, email: e.target.value, error: '' }))} placeholder="juan@email.com" className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-sm text-neutral-100 focus:border-emerald-500 outline-none transition-colors" />
                      </div>
                      <button onClick={handleForgotSubmit} disabled={forgotForm.loading || !forgotForm.email.includes('@')} className="w-full mt-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white py-3 rounded-xl text-sm font-bold shadow-lg shadow-emerald-900/30 transition-colors">
                        {forgotForm.loading ? 'Sending...' : 'Send Recovery Link'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}

        {/* 🟢 INSTANT MINI REPORT MODAL */}
        {reportModalResId && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-neutral-950 border border-neutral-800 rounded-3xl p-6 w-full max-w-sm shadow-2xl space-y-4">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <h3 className="text-lg font-black text-amber-400 flex items-center gap-2"><AlertTriangle size={18} /> Report an Issue</h3>
                  <p className="text-xs text-neutral-500 mt-1">Reservation #{reportModalResId.toUpperCase()}</p>
                </div>
                <button onClick={() => setReportModalResId(null)} className="text-neutral-500 hover:text-white transition-colors"><X size={18} /></button>
              </div>
              
              <form onSubmit={handleMiniReportSubmit} className="space-y-4">
                <div className="bg-amber-950/20 border border-amber-900/30 rounded-xl p-3">
                  <p className="text-[10px] text-amber-500 leading-relaxed font-semibold">
                    Did your booking get cancelled unexpectedly or skipped in the queue? Describe the issue below and our staff will verify and resolve it immediately.
                  </p>
                </div>
                
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">What happened? *</label>
                  <textarea 
                    value={reportMessage} 
                    onChange={e => setReportMessage(e.target.value)} 
                    placeholder="e.g. My booking was cancelled but I already paid the GCash downpayment..." 
                    rows={4} 
                    required 
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-sm text-neutral-100 focus:border-amber-500 outline-none resize-none transition-colors" 
                  />
                </div>
                
                <div className="flex gap-2 pt-2">
                  <button type="button" onClick={() => setReportModalResId(null)} className="flex-1 py-3 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 font-bold rounded-xl text-xs transition-colors border border-neutral-800">Cancel</button>
                  <button type="submit" disabled={!reportMessage.trim() || isReporting} className="flex-1 py-3 bg-amber-600 hover:bg-amber-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white font-bold rounded-xl text-xs transition-colors flex items-center justify-center gap-2">
                    {isReporting ? <><RefreshCw size={14} className="animate-spin" /> Sending...</> : 'Send Report'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
        {/* 🟢 TERMS AND CONDITIONS MODAL */}
        {showTermsModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-neutral-950 border border-neutral-800 rounded-3xl p-6 w-full max-w-md shadow-2xl space-y-4">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <h3 className="text-lg font-black text-white flex items-center gap-2"><CheckCircle size={18} className="text-emerald-500"/> Payment Terms & Conditions</h3>
                </div>
                <button onClick={() => setShowTermsModal(false)} className="text-neutral-500 hover:text-white transition-colors"><X size={18} /></button>
              </div>
              
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 max-h-60 overflow-y-auto">
                <p className="text-xs text-neutral-300 leading-relaxed">
                  By proceeding with this payment, you acknowledge and agree that all payments and down payments made for reservations are final and non-refundable. Once your payment has been confirmed, it cannot be canceled, refunded, or exchanged for cash, except in cases where the reservation cannot be fulfilled.
                  <br /><br />
                  <strong className="text-white">Cancellation Policy:</strong> You may request a refund for your reservation as long as the cancellation is made <strong>at least 1 hour prior</strong> to your scheduled start time. Cancellations made less than 1 hour before the reservation are strictly non-refundable.
                </p>
              </div>
              
              <label className="flex items-start gap-3 cursor-pointer mt-4">
                <div className="pt-0.5">
                  <input type="checkbox" checked={agreedToTerms} onChange={e => setAgreedToTerms(e.target.checked)} className="w-4 h-4 rounded border-neutral-700 bg-neutral-900 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-neutral-950" />
                </div>
                <span className="text-xs text-neutral-400 select-none">I have read and agree to the Payment Terms & Conditions.</span>
              </label>
              
              <div className="flex gap-2 pt-4 border-t border-neutral-800/80">
                <button onClick={() => setShowTermsModal(false)} className="flex-1 py-3 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 font-bold rounded-xl text-xs transition-colors border border-neutral-800">Cancel</button>
                <button onClick={executeReservation} disabled={!agreedToTerms || isVerifying} className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white font-bold rounded-xl text-xs transition-colors flex items-center justify-center gap-2">
                  {isVerifying ? <><RefreshCw size={14} className="animate-spin" /> Processing...</> : 'I Agree & Reserve'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 🟢 FLOATING TOAST NOTIFICATION */}
      <AnimatePresence>
        {toastMsg && (
          <motion.div 
            initial={{ opacity: 0, x: 50 }} 
            animate={{ opacity: 1, x: 0 }} 
            exit={{ opacity: 0, x: 50 }} 
            className={`fixed top-24 right-5 z-[200] p-4 rounded-xl shadow-2xl border flex items-start gap-3 max-w-sm ${toastMsg.type === 'success' ? 'bg-emerald-950/90 border-emerald-900/50' : 'bg-rose-950/90 border-rose-900/50'}`}
          >
            {toastMsg.type === 'success' ? <CheckCircle size={20} className="text-emerald-400 mt-0.5 flex-shrink-0" /> : <XCircle size={20} className="text-rose-400 mt-0.5 flex-shrink-0" />}
            <div>
              <p className={`text-sm font-bold ${toastMsg.type === 'success' ? 'text-emerald-400' : 'text-rose-400'}`}>{toastMsg.title}</p>
              <p className="text-xs text-neutral-300 mt-0.5 leading-relaxed">{toastMsg.desc}</p>
            </div>
            <button onClick={() => setToastMsg(null)} className="text-neutral-400 hover:text-white ml-2 flex-shrink-0"><X size={14} /></button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}