import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { supabase, publicSupabase } from "../utils/supabase";

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
  addReservation: (i: Omit<Reservation, 'id'|'createdAt'>) => Promise<string>; 
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

  // 🟢 FIXED: Proper mapping of sessionData to avoid Ghost Sessions using publicSupabase
  const refreshLiveMonitor = async () => {
    try {
      const [ { data: newTables }, { data: newQueue } ] = await Promise.all([
        publicSupabase.from('tables').select('*'),
        publicSupabase.from('queue').select('*')
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
      const { data } = await publicSupabase
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
          publicSupabase.from('tables').select('*'),
          publicSupabase.from('reservations').select('*'),
          publicSupabase.from('queue').select('*'),
          publicSupabase.from('announcements').select('*'),
          publicSupabase.from('cms').select('*'),
          publicSupabase.from('system_settings').select('*'), 
          publicSupabase.from('closed_dates').select('*'),
          publicSupabase.from('promo_codes').select('*'),
          publicSupabase.from('events').select('*')
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
          setPromoCodes(promoData.map((p: any) => {
            const codeUpper = (p.code || '').trim().toUpperCase();
            const usedInReservations = (resData || []).filter((r: any) => r.promoCode && r.promoCode.trim().toUpperCase() === codeUpper).length;
            const currentUsage = Math.max(Number(p.usage_count ?? p.usagecount ?? p.usageCount ?? 0), usedInReservations);
            const rawActive = p.is_active ?? p.isActive ?? p.isactive;
            const isPromoActive = rawActive === 1 || rawActive === true || rawActive === 'true' || rawActive === undefined;
            const rawLimited = p.is_limited_uses ?? p.isLimitedUses ?? p.islimiteduses;
            const isLimited = rawLimited === 1 || rawLimited === true || rawLimited === 'true';

            return {
              ...p,
              id: p.id,
              code: codeUpper,
              discountPercent: Number(p.discount_percent ?? p.discountpercent ?? p.discountPercent ?? 0),
              description: p.description || '',
              isActive: isPromoActive,
              isLimitedUses: isLimited,
              maxUsage: Number(p.max_usage ?? p.maxusage ?? p.maxUsage ?? 100),
              usageCount: currentUsage,
              startDate: p.start_date || p.startdate || p.startDate ? new Date(p.start_date || p.startdate || p.startDate) : undefined,
              expiresAt: p.expires_at || p.expiresat || p.expiresAt ? new Date(p.expires_at || p.expiresat || p.expiresAt) : undefined,
              createdAt: p.created_at || p.createdat || p.createdAt ? new Date(p.created_at || p.createdat || p.createdAt) : new Date()
            };
          }) as PromoCode[]);
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
            const rawKey = curr.keyname || curr.key_name || curr.keyName;
            if (!rawKey) return acc;
            let val = curr.settingvalue !== undefined ? curr.settingvalue : (curr.setting_value !== undefined ? curr.setting_value : (curr.content_value !== undefined ? curr.content_value : curr.settingValue));
            if (val === 'true' || val === true || val === '1' || val === 1) val = true;
            else if (val === 'false' || val === false || val === '0' || val === 0) val = false;
            else if (val !== null && val !== undefined && !isNaN(val) && String(val).trim() !== '' && !String(val).includes(':')) val = Number(val);
            
            acc[rawKey] = val;
            const camelKey = rawKey.replace(/_([a-z])/g, (_: string, letter: string) => letter.toUpperCase());
            acc[camelKey] = val;

            const lower = rawKey.toLowerCase();
            if (lower === 'isweekdayhappyhouractive') acc.isWeekdayHappyHourActive = Boolean(val);
            if (lower === 'weekdayhappyhourrate') acc.weekdayHappyHourRate = Number(val) || 0;
            if (lower === 'weekdayhappyhourstart') acc.weekdayHappyHourStart = String(val);
            if (lower === 'weekdayhappyhourend') acc.weekdayHappyHourEnd = String(val);
            if (lower === 'isweekendhappyhouractive') acc.isWeekendHappyHourActive = Boolean(val);
            if (lower === 'weekendhappyhourrate') acc.weekendHappyHourRate = Number(val) || 0;
            if (lower === 'weekendhappyhourstart') acc.weekendHappyHourStart = String(val);
            if (lower === 'weekendhappyhourend') acc.weekendHappyHourEnd = String(val);

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

    // 🟢 Realtime sync for system_settings (reflects local machine changes instantly)
    const channelName = `settings_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const settingsChannel = supabase.channel(channelName);

    settingsChannel
      .on('postgres_changes', { event: '*', schema: 'public', table: 'system_settings' }, (payload: any) => {
        if (payload.new) {
          const row = payload.new;
          const rawKey = row.key_name || row.keyname || row.keyName;
          if (!rawKey) return;
          let val = row.setting_value !== undefined ? row.setting_value : row.settingvalue;
          if (val === 'true' || val === true || val === '1' || val === 1) val = true;
          else if (val === 'false' || val === false || val === '0' || val === 0) val = false;
          else if (val !== null && val !== undefined && !isNaN(val) && String(val).trim() !== '' && !String(val).includes(':')) val = Number(val);

          const updates: Record<string, any> = { [rawKey]: val };
          const camelKey = rawKey.replace(/_([a-z])/g, (_: string, letter: string) => letter.toUpperCase());
          updates[camelKey] = val;

          const lower = rawKey.toLowerCase();
          if (lower === 'isweekdayhappyhouractive') updates.isWeekdayHappyHourActive = Boolean(val);
          if (lower === 'weekdayhappyhourrate') updates.weekdayHappyHourRate = Number(val) || 0;
          if (lower === 'weekdayhappyhourstart') updates.weekdayHappyHourStart = String(val);
          if (lower === 'weekdayhappyhourend') updates.weekdayHappyHourEnd = String(val);
          if (lower === 'isweekendhappyhouractive') updates.isWeekendHappyHourActive = Boolean(val);
          if (lower === 'weekendhappyhourrate') updates.weekendHappyHourRate = Number(val) || 0;
          if (lower === 'weekendhappyhourstart') updates.weekendHappyHourStart = String(val);
          if (lower === 'weekendhappyhourend') updates.weekendHappyHourEnd = String(val);

          setRates(prev => ({ ...prev, ...updates }));
          setReservationTerms(prev => ({ ...prev, ...updates }));
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(settingsChannel);
    };
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

  const addReservation = async (i: Omit<Reservation, 'id'|'createdAt'>): Promise<string> => {
    const id = Math.random().toString(36).substring(2, 8).toUpperCase();
    const newRes = { ...i, id, createdAt: new Date() };
    
    setReservations(prev => [...prev, newRes as Reservation]);
    
    const dateFormatted = typeof newRes.date === 'string'
      ? newRes.date.split('T')[0]
      : `${newRes.date.getFullYear()}-${String(newRes.date.getMonth() + 1).padStart(2, '0')}-${String(newRes.date.getDate()).padStart(2, '0')}`;

    // 🟢 Map payload to match the Supabase schema using publicSupabase to bypass user-token RLS
    const supabasePayload = {
      id: newRes.id,
      customerName: newRes.customerName,
      contactNumber: newRes.contactNumber,
      email: newRes.email ? newRes.email.trim() : null,
      date: dateFormatted,
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
      discountAmount: newRes.discountAmount || 0,
      createdAt: newRes.createdAt.toISOString()
    };
    
    try {
      const { error } = await publicSupabase.from('reservations').insert([supabasePayload]);
      if (error) {
        console.warn("Primary Supabase reservation insert note:", error.message);
        // Fallback with minimal columns if an optional column constraint failed
        await publicSupabase.from('reservations').insert([{
          id: newRes.id,
          customerName: newRes.customerName,
          contactNumber: newRes.contactNumber,
          email: newRes.email ? newRes.email.trim() : null,
          date: dateFormatted,
          timeSlot: newRes.timeSlot,
          durationHours: newRes.durationHours,
          partySize: newRes.partySize,
          status: newRes.status,
          totalAmount: newRes.totalAmount,
          downPaymentAmount: newRes.downPaymentAmount,
          downPaymentPaid: newRes.downPaymentPaid ? 1 : 0,
          balancePaid: 0,
          createdAt: new Date().toISOString()
        }]);
      }
    } catch (insertErr) {
      console.error("Supabase insert exception:", insertErr);
    }

    // 🟢 Increment promo code redemption usage count
    if (newRes.promoCode) {
      const pCode = newRes.promoCode.trim().toUpperCase();
      const targetPromo = promoCodes.find(p => p.code.trim().toUpperCase() === pCode);
      if (targetPromo) {
        const nextCount = (targetPromo.usageCount || 0) + 1;
        setPromoCodes(prev => prev.map(p => p.id === targetPromo.id ? { ...p, usageCount: nextCount } : p));
        publicSupabase
          .from('promo_codes')
          .update({ usage_count: nextCount })
          .eq('id', targetPromo.id)
          .then(({ error }) => {
            if (error) {
              publicSupabase.from('promo_codes').update({ usageCount: nextCount }).eq('id', targetPromo.id);
            }
          });
      }
    }
    
    return id;
  };

  const addFeedback = (i: Omit<Feedback, 'id'|'date'>) => {
    const newFeedback = { ...i, id: `f${Date.now()}`, date: new Date() };
    setFeedback(prev => [newFeedback as Feedback, ...prev]);
    
    try {
      const stored = JSON.parse(localStorage.getItem('oneshot_local_feedback') || '[]');
      stored.unshift(newFeedback);
      localStorage.setItem('oneshot_local_feedback', JSON.stringify(stored.slice(0, 50)));
    } catch (e) {}

    const supabasePayload = {
      customerName: newFeedback.customerName,
      contactInfo: newFeedback.contactInfo,
      feedbackType: newFeedback.feedbackType,
      comment: newFeedback.comment,
      reservationId: newFeedback.reservationId || null,
      tags: Array.isArray(newFeedback.tags) ? newFeedback.tags : [],
      status: 'pending',
      date: new Date().toISOString()
    };

    publicSupabase.from('feedback').insert([supabasePayload]).then(({ error }) => {
      if (error) console.warn("Feedback sync info:", error.message);
    }).catch(e => console.warn("Feedback network note:", e));
  };

  const applyPromoCode = (code: string) => {
    const cleanCode = (code || '').trim().toUpperCase();
    const now = new Date().getTime();
    return promoCodes.find(p => {
      if (!p.code || p.code.trim().toUpperCase() !== cleanCode) return false;
      if (!p.isActive) return false;
      if (p.startDate && new Date(p.startDate).getTime() > now + 86400000) return false; 
      if (p.expiresAt && new Date(p.expiresAt).getTime() < now) return false; 
      if (p.isLimitedUses && p.usageCount >= p.maxUsage) return false; 
      return true;
    }) || null;
  };

  const acknowledgeRefund = (id: string) => {
    setReservations(prev => prev.map(r => r.id === id ? { ...r, refundStatus: 'acknowledged' } as Reservation : r));
    publicSupabase.from('reservations').update({ refundStatus: 'acknowledged' }).eq('id', id).then(({ error }) => {
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