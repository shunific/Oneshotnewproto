import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { supabase } from "../utils/supabase";

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
  id: string; customerName: string; contactNumber: string; email?: string; date: Date; timeSlot: string; durationHours: number; partySize: number; tableId?: string; status: ReservationStatus; totalAmount: number; downPaymentAmount: number; downPaymentPaid: boolean; balancePaid: boolean; createdAt: Date; cancellationReason?: string; promoCode?: string; discountAmount?: number; paymentRef?: string; receiptImg?: string;
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
  addReservation: (i: Omit<Reservation, 'id'|'createdAt'>) => string; 
  addFeedback: (i: Omit<Feedback, 'id'|'date'>) => void; 
  applyPromoCode: (c: string) => PromoCode | null;
  refreshLiveMonitor: () => Promise<void>;
  acknowledgeRefund: (id: string) => void;
  validateBookingPreflight: (date: Date, timeSlot: string, durationHours: number) => Promise<boolean>;
};

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [isInitializing, setIsInitializing] = useState(true);

  const [tables, setTables] = useState<Table[]>([
    { id: 't1', name: 'Table 1', status: 'available', isActive: true },
    { id: 't2', name: 'Table 2', status: 'available', isActive: true },
    { id: 't3', name: 'Table 3', status: 'available', isActive: true },
    { id: 't4', name: 'Table 4', status: 'available', isActive: true },
    { id: 't5', name: 'Table 5', status: 'available', isActive: true },
    { id: 't6', name: 'Table 6', status: 'available', isActive: true },
    { id: 't7', name: 'Table 7', status: 'available', isActive: true },
    { id: 't8', name: 'Table 8', status: 'available', isActive: true },
    { id: 't9', name: 'Table 9', status: 'available', isActive: true },
    { id: 't10', name: 'Table 10', status: 'available', isActive: true },
  ]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
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
  const [feedback, setFeedback] = useState<Feedback[]>([]);

  // 🟢 FIXED: Proper mapping of sessionData to avoid Ghost Sessions
  const refreshLiveMonitor = async () => {
    try {
      const [ { data: newTables }, { data: newQueue } ] = await Promise.all([
        supabase.from('tables').select('*'),
        supabase.from('queue').select('*')
      ]);
      
      if (newTables) {
        const mappedTables = newTables.map((t: any) => ({
          ...t,
          session: t.sessionData ? (typeof t.sessionData === 'string' ? JSON.parse(t.sessionData) : t.sessionData) : undefined,
          isActive: t.isActive === 1 || t.isActive === true
        }));
        setTables(prev => JSON.stringify(prev) !== JSON.stringify(mappedTables) ? mappedTables as Table[] : prev);
      }
      if (newQueue) {
        const mappedQueue = newQueue.map((q: any) => ({
          ...q,
          customerName: q.customerName || q.customer_name,
          partySize: q.partySize || q.party_size,
          arrivalTime: q.arrivalTime || q.arrival_time,
          queueNumber: q.queueNumber || q.queue_number,
        }));
        setQueue(prev => JSON.stringify(prev) !== JSON.stringify(mappedQueue) ? mappedQueue as QueueItem[] : prev);
      }
    } catch (error) {
      console.error("Live Monitor Refresh Error:", error);
    }
  };

  // 🟢 NEW: Auto-refresh loop so the customer website stays in sync
  // 🟢 SMART POLLING: Checks Supabase only when tab is active, every 45s (Saves massive bandwidth)
  useEffect(() => {
    if (isInitializing) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshLiveMonitor();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') refreshLiveMonitor();
    }, 45000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(interval);
    };
  }, [isInitializing]);

  // 🟢 PRE-FLIGHT CHECK: Prevents simultaneous double-booking deadlocks
  const validateBookingPreflight = async (date: Date, timeSlot: string, durationHours: number): Promise<boolean> => {
    const requestedStart = new Date(date);
    const [h, m] = timeSlot.split(':').map(Number);
    requestedStart.setHours(h, m, 0, 0);
    const requestedEnd = addMinutes(requestedStart, durationHours * 60);

    try {
      const { data } = await supabase
        .from('reservations')
        .select('date, durationHours')
        .in('status', ['pending', 'confirmed', 'checked-in']);

      if (!data) return true; 

      let overlapCount = 0;
      data.forEach((r: any) => {
        if (isSameDay(new Date(r.date), requestedStart)) {
           const rStart = new Date(r.date);
           const rEnd = addMinutes(rStart, r.durationHours * 60);
           if (requestedStart < rEnd && requestedEnd > rStart) overlapCount++;
        }
      });

      const capacityLimit = Number(rates?.onlineCapacityLimit ?? 70);
      const maxOnlineCapacity = Math.max(1, Math.floor((tables.length || 10) * (capacityLimit / 100)));

      return overlapCount < maxOnlineCapacity;
    } catch (err) {
      return true; // Failsafe fallback
    }
  };

  useEffect(() => {
    const fetchSupabaseData = async () => {
      try {
        const [
          { data: tablesData },
          { data: resData },
          { data: queueData },
          { data: annData },
          { data: cmsData },
          { data: settingsData }, 
          { data: closedDatesData },
          { data: promoData },
          { data: eventsData }
        ] = await Promise.all([
          supabase.from('tables').select('*'),
          supabase.from('reservations').select('*'),
          supabase.from('queue').select('*'),
          supabase.from('announcements').select('*'),
          supabase.from('cms').select('*'),
          supabase.from('system_settings').select('*'), 
          supabase.from('closed_dates').select('*'),
          supabase.from('promo_codes').select('*'),
          supabase.from('events').select('*')
        ]);
        
        if (tablesData) {
          setTables(tablesData.map((t: any) => ({
            ...t,
            session: t.sessionData ? (typeof t.sessionData === 'string' ? JSON.parse(t.sessionData) : t.sessionData) : undefined,
            isActive: t.isActive === 1 || t.isActive === true
          })) as Table[]);
        }
        if (resData) setReservations(resData as Reservation[]);
        if (queueData) {
          setQueue(queueData.map((q: any) => ({
            ...q,
            customerName: q.customerName || q.customer_name,
            partySize: q.partySize || q.party_size,
            arrivalTime: q.arrivalTime || q.arrival_time,
            queueNumber: q.queueNumber || q.queue_number,
          })) as QueueItem[]);
        }
        if (annData && annData.length > 0) {
          setAnnouncements(annData.map((a: any) => ({
            ...a,
            id: a.id,
            title: a.title,
            content: a.content,
            type: a.type || 'info',
            isActive: a.isactive !== undefined ? (a.isactive === 1 || a.isactive === true || a.isactive === 'true') : (a.isActive === 1 || a.isActive === true || a.isActive === 'true'),
            createdAt: a.createdat ? new Date(a.createdat) : (a.createdAt ? new Date(a.createdAt) : new Date()),
            expiresAt: a.expiresat ? new Date(a.expiresat) : (a.expiresAt ? new Date(a.expiresAt) : undefined)
          })) as Announcement[]);
        }
        if (closedDatesData && closedDatesData.length > 0) {
          setClosedDates(closedDatesData.map((cd: any) => ({
            ...cd,
            id: cd.id,
            date: cd.date,
            reason: cd.reason,
            isFullDay: cd.isfullday !== undefined ? (cd.isfullday === 1 || cd.isfullday === true) : (cd.is_full_day !== undefined ? (cd.is_full_day === 1 || cd.is_full_day === true) : cd.isFullDay),
            openTime: cd.opentime || cd.open_time || cd.openTime,
            closeTime: cd.closetime || cd.close_time || cd.closeTime,
            dayOfWeek: cd.dayofweek ?? cd.day_of_week ?? cd.dayOfWeek,
            type: cd.type || 'specific'
          })) as ClosedDate[]);
        }
        if (promoData && promoData.length > 0) {
          setPromoCodes(promoData.map((p: any) => ({
            ...p,
            id: p.id,
            code: p.code,
            discountPercent: Number(p.discountpercent ?? p.discount_percent ?? p.discountPercent ?? 0),
            description: p.description || '',
            isActive: p.isactive !== undefined ? (p.isactive === 1 || p.isactive === true || p.isactive === 'true') : (p.isActive === 1 || p.isActive === true || p.isActive === 'true'),
            maxUsage: Number(p.maxusage ?? p.max_usage ?? p.maxUsage ?? 100),
            usageCount: Number(p.usagecount ?? p.usage_count ?? p.usageCount ?? 0),
            startDate: p.startdate || p.start_date || p.startDate ? new Date(p.startdate || p.start_date || p.startDate) : undefined,
            expiresAt: p.expiresat || p.expires_at || p.expiresAt ? new Date(p.expiresat || p.expires_at || p.expiresAt) : undefined,
            createdAt: p.createdat || p.created_at || p.createdAt ? new Date(p.createdat || p.created_at || p.createdAt) : new Date()
          })) as PromoCode[]);
        }
        
        if (eventsData && eventsData.length > 0) {
          const mappedEvents = eventsData.map((e: any) => ({
            ...e,
            id: e.id,
            title: e.title,
            date: e.date,
            type: e.type,
            description: e.description,
            registrationLink: e.registrationlink || e.registration_link || e.registrationLink,
            maxParticipants: e.maxparticipants ?? e.max_participants ?? e.maxParticipants,
            slotsFull: e.slotsfull !== undefined ? (e.slotsfull === 1 || e.slotsfull === true) : e.slotsFull,
            allowReservations: e.allowreservations !== undefined ? (e.allowreservations === 1 || e.allowreservations === true) : e.allowReservations,
            caterWalkIns: e.caterwalkins !== undefined ? (e.caterwalkins === 1 || e.caterwalkins === true) : e.caterWalkIns,
            walkInTableCount: e.walkintablecount ?? e.walk_in_table_count ?? e.walkInTableCount,
            promoCodeId: e.promocodeid || e.promo_code_id || e.promoCodeId
          }));
          setEvents(prev => {
            const existingIds = new Set(prev.map(ev => ev.id));
            const newEvents = mappedEvents.filter((ev: any) => !existingIds.has(ev.id));
            return [...prev, ...newEvents];
          });
        }

        if (cmsData && cmsData.length > 0) {
          const configObj = cmsData.reduce((acc: any, curr: any) => {
            const key = curr.keyname || curr.key_name || curr.keyName;
            const val = curr.settingvalue !== undefined ? curr.settingvalue : (curr.setting_value !== undefined ? curr.setting_value : (curr.content_value !== undefined ? curr.content_value : curr.settingValue));
            if (key) acc[key] = val;
            return acc;
          }, {});
          setSiteConfig((prev: any) => ({ ...prev, ...configObj }));
        }

        if (settingsData && settingsData.length > 0) {
          const settingsObj = settingsData.reduce((acc: any, curr: any) => { 
            const key = curr.keyname || curr.key_name || curr.keyName;
            let val = curr.settingvalue !== undefined ? curr.settingvalue : (curr.setting_value !== undefined ? curr.setting_value : (curr.content_value !== undefined ? curr.content_value : curr.settingValue));
            if (val === 'true' || val === true) val = true;
            else if (val === 'false' || val === false) val = false;
            else if (val !== null && val !== undefined && !isNaN(val) && String(val).trim() !== '' && !String(val).includes(':')) val = Number(val);
            if (key) acc[key] = val; 
            return acc; 
          }, {});
          
          setRates(prev => ({ ...prev, ...settingsObj }));
          setReservationTerms(prev => ({ ...prev, ...settingsObj }));
        }

      } catch (err) {
        console.error("Failed to sync with Supabase:", err);
      } finally { 
        setTimeout(() => setIsInitializing(false), 800); 
      }
    };
    fetchSupabaseData();
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
        setEvents(prev => {
          const existingIds = new Set(prev.map(e => e.id));
          const newHolidays = fetchedHolidays.filter(h => !existingIds.has(h.id));
          return [...prev, ...newHolidays];
        });
      } catch (err) {}
    };
    fetchHolidays();
  }, []);

  const addReservation = (i: Omit<Reservation, 'id'|'createdAt'>): string => {
    const id = Math.random().toString(36).substring(2, 8).toUpperCase();
    const newRes = { ...i, id, createdAt: new Date() };
    
    setReservations(prev => [...prev, newRes as Reservation]);
    
    // 🟢 Map payload to match the Supabase camelCase schema exactly
    const supabasePayload = {
      id: newRes.id,
      customerName: newRes.customerName,
      contactNumber: newRes.contactNumber,
      email: newRes.email || null,
      date: newRes.date.toISOString(),
      timeSlot: newRes.timeSlot,
      durationHours: newRes.durationHours,
      partySize: newRes.partySize,
      tableId: newRes.tableId || null,
      status: newRes.status,
      totalAmount: newRes.totalAmount,
      downPaymentAmount: newRes.downPaymentAmount,
      downPaymentPaid: newRes.downPaymentPaid ? 1 : 0,
      balancePaid: newRes.balancePaid ? 1 : 0,
      paymentRef: newRes.paymentRef || null,
      receiptImg: newRes.receiptImg || null,
      promoCode: newRes.promoCode || null,
      discountAmount: newRes.discountAmount || null,
      createdAt: newRes.createdAt.toISOString()
    };
    
    supabase.from('reservations').insert([supabasePayload]).then(({ error }) => {
      if (error) console.error("Supabase insert error:", error);
    });
    
    return id;
  };

  const addFeedback = (i: Omit<Feedback, 'id'|'date'>) => {
    const newFeedback = { ...i, id: `f${Date.now()}`, date: new Date() };
    setFeedback(prev => [newFeedback as Feedback, ...prev]);
    
    const { rating, ...supabasePayload } = newFeedback;

    supabase.from('feedback').insert([supabasePayload]).then(({ error }) => {
      if (error) console.error("Error inserting feedback to Supabase:", error);
    });
  };

  const applyPromoCode = (code: string) => {
    const now = new Date();
    return promoCodes.find(p => {
      if (p.code.toUpperCase() !== code.toUpperCase() || !p.isActive) return false;
      if (p.startDate && new Date(p.startDate) > now) return false; 
      if (p.expiresAt && new Date(p.expiresAt) < now) return false; 
      if (p.isLimitedUses !== false && p.usageCount >= p.maxUsage) return false; 
      return true;
    }) || null;
  };

  const acknowledgeRefund = (id: string) => {
    setReservations(prev => prev.map(r => r.id === id ? { ...r, refundStatus: 'acknowledged' } as Reservation : r));
    supabase.from('reservations').update({ refundStatus: 'acknowledged' }).eq('id', id).then(({ error }) => {
      if (error) console.error("Error updating refund status:", error);
    });
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
      tables, queue, reservations, promoCodes, rates, reservationTerms, announcements, closedDates, weather, updateWeatherLocation,
      activeAnnouncement, updateActiveAnnouncement, siteConfig, events,
      addReservation, addFeedback, applyPromoCode, refreshLiveMonitor,
      acknowledgeRefund, validateBookingPreflight
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (context === undefined) throw new Error('useAppContext must be used within an AppProvider');
  return context;
}