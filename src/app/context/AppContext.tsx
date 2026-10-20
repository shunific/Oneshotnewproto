import { createContext, useContext, useState, useEffect, ReactNode, Fragment, useCallback, useRef } from 'react';
import { supabase, publicSupabase } from "../utils/supabase";
import { createOwnedReservationLoader, clearPendingBookings, readPendingBooking, submitTrustedBooking } from '../utils/trustedBookings';
import { parseSystemSettings, hasBookingSettings } from '../utils/systemSettings';
import { submitFeedback, clearPendingFeedback, readPendingFeedback } from '../utils/feedbackSubmission';
import { clearPendingReceiptUploads } from '../utils/privateReceipts';

// ── Types (Pruned for Customer App) ────────────────────────────
export type TableStatus = 'available' | 'occupied' | 'reserved' | 'maintenance' | 'event';

export type SessionOrder = {
  id: string;
  name: string;
  price: number;
  qty: number;
};

export type Session = {
  customerName: string;
  startTime: Date;
  durationMinutes: number | null; 
  isOpenTime: boolean; 
  isPaid: boolean;
  hourlyRate: number;
  amountPaid: number;
  orders?: SessionOrder[];
  paymentStatus?: 'paid' | 'payLater';
  gcashReceiptImg?: string;
};

export type Table = {
  id: string;
  name: string;
  status: TableStatus;
  session?: Session;
  isActive: boolean;
  maintenanceReason?: string;
};

export type QueueItem = {
  id: string; customerName: string; contactNumber: string; partySize: number; arrivalTime: Date; notes?: string; status: 'waiting' | 'called' | 'seated'; queueNumber: number; prioritySource?: 'reservation';
};

export type ReservationStatus = 'pending' | 'confirmed' | 'checked-in' | 'completed' | 'cancelled';

export type Reservation = {
  id: string; customer_user_id: string; revision: number; customerName: string; contactNumber: string; email?: string; date: Date; timeSlot: string; durationHours: number; partySize: number; tableId?: string; status: ReservationStatus; totalAmount: number; downPaymentAmount: number; downPaymentPaid: boolean; balancePaid: boolean; createdAt: Date; cancellationReason?: string; promoCode?: string; discountAmount?: number; paymentRef?: string; receiptImg?: string;
  refundStatus?: 'pending' | 'processing' | 'sent' | 'in_person' | 'remediated' | 'acknowledged' | 'expired';
  refundMethod?: 'gcash' | 'cash' | 'session_credit';
  refundNotes?: string;
};

export type Feedback = {
  id: string; customerName: string; contactInfo?: string; rating: number; feedbackType?: 'suggestion' | 'complaint' | 'lost_item' | 'compliment' | 'other'; comment: string; date: Date; reservationId?: string; tags: string[];
};

export type PromoCode = {
  id: string; code: string; discountPercent: number; description: string; isActive: boolean; maxUsage: number; usageCount: number; startDate?: Date; expiresAt?: Date; createdAt: Date;
};

export type Event = {
  id: string; title: string; date: string; type: string; description: string; registrationLink?: string; maxParticipants?: number; slotsFull?: boolean; attachments?: string[]; promoCodeId?: string;
  allowReservations?: boolean;
  caterWalkIns?: boolean;
  walkInTableCount?: number;
};

export type RatesConfig = {
  bookingCapacityMode?: 'tables';
  hourlyRate: number; overtimeRate: number; downPaymentPercent: number;
  bookingCutoffMinutes: number; weekdayStartTime: string; weekdayEndTime: string; isWeekdayHappyHourActive: boolean; weekdayHappyHourRate: number; weekdayHappyHourStart: string; weekdayHappyHourEnd: string; weekdayOnlineCapacityLimit: number;
  weekendStartTime: string; weekendEndTime: string; isWeekendHappyHourActive: boolean; weekendHappyHourRate: number; weekendHappyHourStart: string; weekendHappyHourEnd: string; weekendOnlineCapacityLimit: number;
};

export type ReservationTerms = {
  minHours: number; maxHours: number; cancellationHours: number; advanceBookingHours: number; cancellationPolicy: string; termsAndConditions: string;
  weekdayMinPartySize: number; weekdayMaxPartySize: number;
  weekendMinPartySize: number; weekendMaxPartySize: number;
};

export type AnnouncementType = 'info' | 'warning' | 'promo' | 'event';
export type Announcement = {
  id: string; title: string; content: string; type: AnnouncementType; isActive: boolean; createdAt: Date; expiresAt?: Date;
};

export type ClosedDate = {
  id: string; date: string; reason: string; isFullDay: boolean; openTime?: string; closeTime?: string; type?: 'specific' | 'weekly'; dayOfWeek?: number; 
};

export type WeatherData = {
  temp: number; condition: string; isRaining: boolean; code: number; locationName: string;
};

export const HOURLY_RATE = 150;
export const DOWN_PAYMENT_RATE = 0.25;

export const generateRandomPromoCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

type AppContextType = {
  tables: Table[];
  bookingBusy: any[];
  customerUser: { id: string; name: string; email: string } | null;
  pendingBooking: any;
  pendingFeedback: any;
  retryPendingFeedback: () => Promise<{ id: string }>;
  ownedBookingsError: string;
  refreshOwnedBookings: () => Promise<void>;
  retryPendingBooking: () => Promise<Reservation>;
  changeBooking: (kind: 'reschedule' | 'cancel', input: any) => Promise<Reservation>;
  bookingDataReady: boolean;
  queueWaitingCount: number;
  queue: QueueItem[]; 
  reservations: Reservation[]; 
  promoCodes: PromoCode[]; 
  rates: RatesConfig; 
  reservationTerms: ReservationTerms; 
  announcements: Announcement[]; 
  closedDates: ClosedDate[]; 
  weather: WeatherData | null; 
  events: Event[];
  siteConfig: any;
  activeAnnouncement: string; 
  
  updateWeatherLocation: (lat: string, lon: string, name: string) => void;
  updateActiveAnnouncement: (msg: string) => void;
  addReservation: (input: any) => Promise<Reservation>;
  applySavedReservation: (saved: Pick<Reservation, 'id'> & Partial<Reservation>) => void;
  addFeedback: (input: { customerName: string; contactInfo: string; feedbackType: string; comment: string; reservationId?: string }, options?: { allowEmail?: boolean }) => Promise<{ id: string }>;
  applyPromoCode: (c: string) => PromoCode | null;
  refreshLiveMonitor: () => Promise<void>;
};

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [isInitializing, setIsInitializing] = useState(true);
  const [bookingDataReady, setBookingDataReady] = useState(false);
  const [bookingBusy, setBookingBusy] = useState<any[]>([]);
  const [customerUser, setCustomerUser] = useState<{id: string; name: string; email: string} | null>(null);
  const ownerRef = useRef<string | null>(null);
  const authEpoch = useRef(0);
  const [pendingBooking, setPendingBooking] = useState<any>(null);
  const [pendingFeedback, setPendingFeedback] = useState<any>(null);
  const [ownedBookingsError, setOwnedBookingsError] = useState('');

  const [tables, setTables] = useState<Table[]>([]);
  const [queueWaitingCount, setQueueWaitingCount] = useState(0);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [serverEvents, setServerEvents] = useState<Event[]>([]);
  const [holidays, setHolidays] = useState<Event[]>([]);
  const events = [...serverEvents, ...holidays];
  const [promoCodes, setPromoCodes] = useState<PromoCode[]>([]);
  const [rates, setRates] = useState<RatesConfig>({
    hourlyRate: 150,
    overtimeRate: 100,
    downPaymentPercent: 25,
    weekdayStartTime: '12:00',
    weekdayEndTime: '00:00',
    isWeekdayHappyHourActive: true,
    weekdayHappyHourRate: 100,
    weekdayHappyHourStart: '15:00',
    weekdayHappyHourEnd: '18:00',
    weekdayOnlineCapacityLimit: 90,
    weekendStartTime: '12:00',
    weekendEndTime: '00:00',
    isWeekendHappyHourActive: false,
    weekendHappyHourRate: 100,
    weekendHappyHourStart: '15:00',
    weekendHappyHourEnd: '18:00',
    weekendOnlineCapacityLimit: 40,
    bookingCutoffMinutes: 60
  });
  const [reservationTerms, setReservationTerms] = useState<ReservationTerms>({
    minHours: 1,
    maxHours: 8,
    cancellationHours: 23,
    advanceBookingHours: 1,
    cancellationPolicy: 'Booking Policy',
    termsAndConditions: 'Terms & Conditions',
    weekdayMinPartySize: 1,
    weekdayMaxPartySize: 10,
    weekendMinPartySize: 1,
    weekendMaxPartySize: 10
  });
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [closedDates, setClosedDates] = useState<ClosedDate[]>([]);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherConfig, setWeatherConfig] = useState({ lat: '', lon: '', name: '' });
  const [activeAnnouncement, setActiveAnnouncement] = useState("");
  const updateActiveAnnouncement = (msg: string) => setActiveAnnouncement(msg);
  const [siteConfig, setSiteConfig] = useState<any>(null);
  const updateWeatherLocation = useCallback((lat: string, lon: string, name: string) => { setWeatherConfig({ lat, lon, name }); }, []);

  const ownerLoader = useRef(createOwnedReservationLoader(supabase, setReservations));
  const refreshOwnedBookings = async () => {
    try { await ownerLoader.current.refresh(); setOwnedBookingsError(''); }
    catch (error: any) { setOwnedBookingsError(error.message || 'Your bookings could not be loaded.'); }
  };

  const availabilitySequence = useRef(0);
  const refreshLiveMonitor = async () => {
    const sequence = ++availabilitySequence.current;
    try {
      const from = new Date();
      const to = new Date(from); to.setDate(to.getDate() + 31);
      const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const { data, error } = await publicSupabase.rpc('oneshot_booking_availability', { p_from: localDate(from), p_to: localDate(to) });
      if (sequence !== availabilitySequence.current) return;
      if (error) throw error;
      if (!data || !Array.isArray(data.tables) || !Array.isArray(data.busy) || !Array.isArray(data.settings) || !Array.isArray(data.closedDates)) throw new Error('Booking availability is unavailable.');
      const settings = parseSystemSettings(data.settings);
      setTables(data.tables.map((table: any) => ({
        id: table.id, name: table.name, status: table.status, isActive: table.isActive === true,
        session: table.session ? { startTime: table.session.startTime, durationMinutes: table.session.durationMinutes, isOpenTime: table.session.isOpenTime } : undefined,
      })));
      setBookingBusy(data.busy.map((busy: any, index: number) => ({ id: `busy-${index}`, tableId: busy.tableId, date: busy.date, timeSlot: busy.timeSlot, durationHours: busy.durationHours, status: 'confirmed' })));
      if (!Number.isSafeInteger(data.queueSummary?.waitingCount) || data.queueSummary.waitingCount < 0) throw new Error('Queue availability could not be verified.');
      setQueueWaitingCount(data.queueSummary.waitingCount);
      setQueue([]);
      setClosedDates(data.closedDates);
      setPromoCodes((data.promos || []).map((promo: any) => ({
        id: promo.id || promo.code, code: promo.code, discountPercent: Number(promo.discountPercent), description: promo.description || '',
        isActive: promo.isActive === true && promo.exhausted !== true, isLimitedUses: false,
        maxUsage: 0, usageCount: 0, startDate: promo.startDate ? new Date(promo.startDate) : undefined,
        expiresAt: promo.expiresAt ? new Date(promo.expiresAt) : undefined, createdAt: new Date(),
      })));
      setServerEvents(data.events || []);
      setAnnouncements((data.announcements || []).map((announcement: any) => ({
        id: announcement.id, title: announcement.title, content: announcement.content,
        type: announcement.type || 'info', isActive: announcement.isActive === true,
        createdAt: new Date(announcement.createdAt), expiresAt: announcement.expiresAt ? new Date(announcement.expiresAt) : undefined,
      })));
      setSiteConfig({ heroImages: data.cms?.heroImages, aboutImage: data.cms?.aboutImage });
      setRates(prev => ({ ...prev, ...settings }));
      setReservationTerms(prev => ({ ...prev, ...settings }));
      setBookingDataReady(data.bookingReady === true && hasBookingSettings(settings));
    } catch {
      if (sequence === availabilitySequence.current) setBookingDataReady(false);
    }
  };

  useEffect(() => {
    let stopped = false;
    let observedAuth = false;
    let recoveryStorage: Storage | undefined;
    try { recoveryStorage = sessionStorage; } catch { /* Adoption below remains signed out without recovery storage. */ }
    const adopt = (user: any) => {
      const next = user && !user.is_anonymous && user.email_confirmed_at ? user.id : null;
      if (ownerRef.current !== next) {
        const previousOwner = ownerRef.current;
        authEpoch.current++;
        // Invalidate private in-memory state before fallible browser storage access.
        ownerRef.current = null;
        ownerLoader.current.changeOwner(null);
        setCustomerUser(null);
        setPendingBooking(null);
        setPendingFeedback(null);
        setOwnedBookingsError('');
        try {
          clearPendingReceiptUploads(recoveryStorage, previousOwner === null ? next : null);
          clearPendingBookings(recoveryStorage, previousOwner === null ? next : null);
          clearPendingFeedback(recoveryStorage, previousOwner === null ? next : null);
        } catch {
          setOwnedBookingsError('Private recovery storage is unavailable. Keep this tab open and restore browser session storage before signing in again. Contact staff to check any unconfirmed request.');
          return;
        }
        ownerRef.current = next;
        ownerLoader.current.changeOwner(next);
      }
      setCustomerUser(next ? { id: next, name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Customer', email: user.email || '' } : null);
      if (next) {
        try { setPendingBooking(readPendingBooking(sessionStorage, next)); setPendingFeedback(readPendingFeedback(sessionStorage, next)); }
        catch (error: any) {
          ownerRef.current = null;
          ownerLoader.current.changeOwner(null);
          setCustomerUser(null); setPendingBooking(null); setPendingFeedback(null);
          setOwnedBookingsError(error.message);
          return;
        }
        setTimeout(() => { if (!stopped && ownerRef.current === next) void refreshOwnedBookings(); }, 0);
      }
    };
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      observedAuth = true;
      if (!stopped) adopt(session?.user);
    });
    supabase.auth.getUser().then(({ data, error }) => { if (!stopped && !observedAuth) adopt(error ? null : data.user); });
    void refreshLiveMonitor().finally(() => { if (!stopped) setIsInitializing(false); });
    const refresh = () => { if (document.visibilityState === 'visible') { void refreshLiveMonitor(); void refreshOwnedBookings(); } };
    const interval = setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => { stopped = true; availabilitySequence.current++; ownerLoader.current.changeOwner(null); clearInterval(interval); document.removeEventListener('visibilitychange', refresh); listener.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    const fetchWeather = async () => {
      if (!weatherConfig.lat || !weatherConfig.lon) return;
      try {
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${weatherConfig.lat}&longitude=${weatherConfig.lon}&current=temperature_2m,weather_code&timezone=Asia%2FManila`);
        if (!res.ok) return;
        const data = await res.json();
        const code = data.current.weather_code;
        const temp = data.current.temperature_2m;
        const isRaining = code >= 50; 
        let condition = "Clear";
        if (code >= 1 && code <= 3) condition = "Cloudy";
        if (code >= 50 && code <= 69) condition = "Raining";
        if (code >= 80 && code <= 82) condition = "Heavy Rain";
        if (code >= 95) condition = "Thunderstorm";
        setWeather({ temp, condition, isRaining, code, locationName: weatherConfig.name });
      } catch (err) { }
    };
    fetchWeather();
  }, [weatherConfig]);

  useEffect(() => {
    const fetchHolidays = async () => {
      try {
        const currentYear = new Date().getFullYear();
        const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${currentYear}/PH`);
        if (!res.ok) return;
        const data = await res.json();
        const fetchedHolidays: Event[] = data.map((item: any) => ({
          id: `hol_${item.date}`, title: item.name, date: item.date, type: 'Holiday', description: `Nationwide Public Holiday. ML predicts high walk-in traffic and extended play duration.`,
        }));
        setHolidays(fetchedHolidays);
      } catch (err) {}
    };
    fetchHolidays();
  }, []);

  const applySavedReservation = (saved: Pick<Reservation, 'id'> & Partial<Reservation>) => {
    setReservations(prev => prev.map(r => r.id === saved.id ? { ...r, ...saved } : r));
  };

  const executeBooking = async (kind: 'create' | 'reschedule' | 'cancel', input: any, retry = false): Promise<Reservation> => {
    const expectedOwner = ownerRef.current;
    const expectedEpoch = authEpoch.current;
    if (!expectedOwner) throw new Error('Sign in with a verified customer account before booking.');
    try {
      const saved = await submitTrustedBooking(supabase, kind, input, sessionStorage, { retry, expectedOwnerId: expectedOwner, isCurrentOwner: () => ownerRef.current === expectedOwner && authEpoch.current === expectedEpoch });
      if (ownerRef.current !== expectedOwner || authEpoch.current !== expectedEpoch) throw new Error('Your account changed. Sign in again to review the booking result.');
      setReservations(prev => [saved, ...prev.filter(row => row.id !== saved.id)]);
      await refreshLiveMonitor();
      return saved;
    } finally {
      if (ownerRef.current === expectedOwner && authEpoch.current === expectedEpoch) setPendingBooking(readPendingBooking(sessionStorage, expectedOwner));
    }
  };
  const addReservation = (input: any) => executeBooking('create', input);
  const changeBooking = (kind: 'reschedule' | 'cancel', input: any) => executeBooking(kind, input);
  const retryPendingBooking = async () => {
    const pending = readPendingBooking(sessionStorage, ownerRef.current);
    if (!pending) throw new Error('No pending booking request.');
    return executeBooking(pending.kind, pending.input, true);
  };

  const addFeedback = async (input: any, options: { allowEmail?: boolean; retry?: boolean } = {}) => {
    const expectedOwner = ownerRef.current;
    const expectedEpoch = authEpoch.current;
    if (!expectedOwner) throw new Error('Sign in with a verified customer account to send feedback.');
    try {
      return await submitFeedback(supabase, input, { ...options, storage: sessionStorage, expectedOwnerId: expectedOwner, isCurrentOwner: () => ownerRef.current === expectedOwner && authEpoch.current === expectedEpoch });
    } finally {
      if (ownerRef.current === expectedOwner && authEpoch.current === expectedEpoch) setPendingFeedback(readPendingFeedback(sessionStorage, expectedOwner));
    }
  };
  const retryPendingFeedback = async () => {
    const pending = readPendingFeedback(sessionStorage, ownerRef.current);
    if (!pending) throw new Error('No pending feedback request.');
    return addFeedback(pending.input, { allowEmail: true, retry: true });
  };

  const applyPromoCode = (code: string) => {
    const cleanCode = (code || '').trim().toUpperCase();
    const now = new Date().getTime();
    return promoCodes.find(p => {
      if (!p.code || p.code.trim().toUpperCase() !== cleanCode) return false;
      if (!p.isActive || !Number.isFinite(p.discountPercent) || p.discountPercent < 0 || p.discountPercent > 100) return false;
      if (p.startDate && new Date(p.startDate).getTime() > now) return false;
      if (p.expiresAt && new Date(p.expiresAt).getTime() < now) return false; 
      if (p.isLimitedUses && p.usageCount >= p.maxUsage) return false; 
      return true;
    }) || null;
  };

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center">
        <div className="relative w-16 h-16 mb-6">
          <div className="absolute inset-0 border-4 border-neutral-800 rounded-full"></div>
          <div className="absolute inset-0 border-4 border-emerald-500 rounded-full border-t-transparent animate-spin"></div>
        </div>
        <h1 className="text-2xl font-black text-white tracking-widest">ONE SHOT</h1>
        <p className="text-[10px] text-emerald-500 font-bold uppercase tracking-[0.2em] mt-2 animate-pulse">Loading Application...</p>
      </div>
    );
  }

  return (
    <AppContext.Provider value={{
      tables, bookingBusy, customerUser, pendingBooking, pendingFeedback, retryPendingFeedback, ownedBookingsError, refreshOwnedBookings, retryPendingBooking, changeBooking, bookingDataReady, queueWaitingCount, queue, reservations, promoCodes, rates, reservationTerms, announcements, closedDates, weather, updateWeatherLocation,
      activeAnnouncement, updateActiveAnnouncement, siteConfig, events,
      addReservation, applySavedReservation, addFeedback, applyPromoCode, refreshLiveMonitor
    }}>
      <Fragment key={customerUser?.id || 'guest'}>{children}</Fragment>
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (context === undefined) throw new Error('useAppContext must be used within an AppProvider');
  return context;
}
