import { LoadingRing } from '../components/LoadingRing';
import { bookingDay, bookingDayKey } from '../utils/bookingSchedule.js';
import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { publicSupabase } from '../utils/supabase';

// ── Types (Customer Website Only) ──────────────────────────────
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
  id: string;
  customerName: string;
  contactNumber: string;
  partySize: number;
  arrivalTime: Date;
  notes?: string;
  status: 'waiting' | 'called' | 'seated';
  queueNumber: number;
  prioritySource?: 'reservation';
};

export type ReservationStatus = 'pending' | 'confirmed' | 'checked-in' | 'completed' | 'cancelled' | 'pending-refund' | 'pending-reschedule';

export type Reservation = {
  id: string;
  customerName: string;
  contactNumber: string;
  email?: string;
  date: Date;
  timeSlot: string;
  durationHours: number;
  partySize: number;
  tableId?: string;
  status: ReservationStatus;
  totalAmount: number;
  downPaymentAmount: number;
  downPaymentPaid: boolean;
  balancePaid: boolean;
  createdAt: Date;
  cancellationReason?: string;
  promoCode?: string;
  discountAmount?: number;
  paymentRef?: string;
  receiptImg?: string;
  refundStatus?: 'declined' | 'settled' | 'pending' | 'processing' | 'sent' | 'in_person' | 'remediated' | 'acknowledged' | 'expired';
  refundMethod?: 'gcash' | 'cash' | 'session_credit';
  refundNotes?: string;
  rescheduleCount?: number;
};

export type Feedback = {
  id: string;
  customerName: string;
  contactInfo?: string;
  rating: number;
  feedbackType?: 'suggestion' | 'complaint' | 'lost_item' | 'compliment' | 'other' | 'report';
  comment: string;
  date: Date;
  reservationId?: string;
  tags: string[];
  status?: 'pending' | 'resolved';
  notes?: string;
};

export type PromoCode = {
  id: string;
  code: string;
  discountPercent: number;
  description: string;
  isActive: boolean;
  isLimitedUses: boolean;
  maxUsage: number;
  usageCount: number;
  startDate?: Date;
  expiresAt?: Date;
  createdAt: Date;
};

export type Event = {
  id: string;
  title: string;
  date: string;
  type: string;
  description: string;
  registrationLink?: string;
  maxParticipants?: number;
  slotsFull?: boolean;
  attachments?: string[];
  promoCodeId?: string;
  allowReservations?: boolean;
  caterWalkIns?: boolean;
  walkInTableCount?: number;
  bracketLink?: string;
  minParticipants?: number;
  reservationTableCount?: number;
  eventTableIds?: string[];
  dates?: string[];
  duration?: string;
  isCancelled?: boolean;
  cancelReason?: string;
  cancelledAt?: string;
};

export type RatesConfig = {
  hourlyRate: number;
  overtimeRate: number;
  downPaymentPercent: number;
  bookingCutoffMinutes: number;
  weekdayStartTime: string;
  weekdayEndTime: string;
  isWeekdayHappyHourActive: boolean;
  weekdayHappyHourRate: number;
  weekdayHappyHourStart: string;
  weekdayHappyHourEnd: string;
  weekdayOnlineCapacityLimit: number;
  weekendStartTime: string;
  weekendEndTime: string;
  isWeekendHappyHourActive: boolean;
  weekendHappyHourRate: number;
  weekendHappyHourStart: string;
  weekendHappyHourEnd: string;
  weekendOnlineCapacityLimit: number;
};

export type ReservationTerms = {
  minHours: number;
  maxHours: number;
  cancellationHours: number;
  advanceBookingHours: number;
  cancellationPolicy: string;
  termsAndConditions: string;
  weekdayMinPartySize: number;
  weekdayMaxPartySize: number;
  weekendMinPartySize: number;
  weekendMaxPartySize: number;
};

export type AnnouncementType = 'info' | 'warning' | 'promo' | 'event';
export type Announcement = {
  id: string;
  title: string;
  content: string;
  type: AnnouncementType;
  isActive: boolean;
  createdAt: Date;
  expiresAt?: Date;
  startDate?: Date | string;
};

export type ClosedDate = {
  id: string;
  date: string;
  reason: string;
  isFullDay: boolean;
  openTime?: string;
  closeTime?: string;
  type?: 'specific' | 'weekly';
  dayOfWeek?: number;
};

export const HOURLY_RATE = 0;
export const DOWN_PAYMENT_RATE = 0;

export type AppContextType = {
  tables: Table[];
  queue: QueueItem[];
  reservations: Reservation[];
  promoCodes: PromoCode[];
  rates: RatesConfig;
  reservationTerms: ReservationTerms;
  announcements: Announcement[];
  closedDates: ClosedDate[];
  events: Event[];
  siteConfig: any;
  lastSynced: Date | null;
  addReservation: (i: Omit<Reservation, 'id' | 'createdAt'>) => Promise<string>;
  cancelReservation: (id: string, reason: string) => void;
  addFeedback: (i: Omit<Feedback, 'id' | 'date'>) => void;
  applyPromoCode: (code: string) => PromoCode | null;
  refreshLiveMonitor: () => Promise<void>;
  forceFullSync: () => Promise<void>;
};

const AppContext = createContext<AppContextType | undefined>(undefined);

export function isServedFromLocalMachine(): boolean {
  if (typeof window === 'undefined') return false;
  const { hostname, protocol } = window.location;
  return protocol === 'file:' || hostname === '' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function cloudFloorTables(rows: any[]): Table[] {
  return rows.map(t => {
    let session: any = undefined;
    const rawSession = t.sessionData || t.sessiondata || t.session;
    if (rawSession) {
      try {
        session = typeof rawSession === 'string' ? JSON.parse(rawSession) : rawSession;
      } catch {
        session = undefined;
      }
    }
    const rawActive = t.isActive ?? t.isactive ?? t.is_active;
    const isActive = rawActive !== undefined
      ? (rawActive === 1 || rawActive === true || rawActive === 'true' || rawActive === '1')
      : true;

    return {
      id: String(t.id),
      name: t.name || `Table ${t.id}`,
      status: (t.status as TableStatus) || 'available',
      isActive,
      maintenanceReason: t.maintenanceReason || t.maintenancereason || undefined,
      session
    };
  });
}

async function loadPublicQueue(): Promise<QueueItem[] | null> {
  const { data } = await publicSupabase
    .from('queue')
    .select('id,status,partySize,partysize,queueNumber,queuenumber,arrivalTime,arrivaltime')
    .in('status', ['waiting', 'called']);

  return data && data
    .map(row => {
      const queueNumber = row.queueNumber ?? row.queuenumber;
      return {
        id: row.id,
        status: row.status,
        queueNumber,
        partySize: row.partySize ?? row.partysize,
        arrivalTime: new Date(row.arrivalTime ?? row.arrivaltime),
        customerName: 'Party #' + queueNumber,
        contactNumber: ''
      };
    })
    .sort((a, b) => a.queueNumber - b.queueNumber);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [isInitializing, setIsInitializing] = useState(true);

  const [tables, setTables] = useState<Table[]>(() => {
    try {
      const cached = localStorage.getItem('oneshot_floor_records_v2');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) return cloudFloorTables(parsed);
      }
    } catch {}
    return [];
  });

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [promoCodes, setPromoCodes] = useState<PromoCode[]>([]);
  const [rates, setRates] = useState<RatesConfig>({
    hourlyRate: 0, overtimeRate: 0, downPaymentPercent: 0, bookingCutoffMinutes: 60,
    weekdayStartTime: '', weekdayEndTime: '', isWeekdayHappyHourActive: false, weekdayHappyHourRate: 0, weekdayHappyHourStart: '', weekdayHappyHourEnd: '', weekdayOnlineCapacityLimit: 0,
    weekendStartTime: '', weekendEndTime: '', isWeekendHappyHourActive: false, weekendHappyHourRate: 0, weekendHappyHourStart: '', weekendHappyHourEnd: '', weekendOnlineCapacityLimit: 0
  });
  const [reservationTerms, setReservationTerms] = useState<ReservationTerms>({
    minHours: 0, maxHours: 0, cancellationHours: 0, advanceBookingHours: 1,
    cancellationPolicy: '', termsAndConditions: '',
    weekdayMinPartySize: 0, weekdayMaxPartySize: 0, weekendMinPartySize: 0, weekendMaxPartySize: 0
  });
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [closedDates, setClosedDates] = useState<ClosedDate[]>([]);
  const [siteConfig, setSiteConfig] = useState<any>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  useEffect(() => {
    if (tables) {
      try {
        localStorage.setItem('oneshot_floor_records_v2', JSON.stringify(tables));
      } catch {}
    }
  }, [tables]);

  const readJsonResponse = async (response: Response | null) => {
    if (!response || !response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('json')) return null;
    try { return await response.json(); } catch { return null; }
  };

  const fetchLocalJson = async (path: string) => {
    if (!isServedFromLocalMachine()) return null;
    let servedStaticHtml = false;
    try {
      const res = await fetch(path);
      if (res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('json')) {
          try { return await res.json(); } catch { return null; }
        }
        servedStaticHtml = true;
      }
    } catch {}
    if (servedStaticHtml) return null;
    try {
      return await readJsonResponse(await fetch(`http://localhost:3001${path}`));
    } catch { return null; }
  };

  const refreshLiveMonitor = useCallback(async () => {
    if (!isServedFromLocalMachine()) {
      const [floor, waiting] = await Promise.all([
        publicSupabase.from('tables').select('*'),
        loadPublicQueue()
      ]);
      if (floor.data) setTables(cloudFloorTables(floor.data));
      if (waiting) setQueue(waiting);
      return;
    }

    try {
      const [tablesRes, queueRes, resRes] = await Promise.all([
        fetch('http://localhost:3001/api/tables').catch(() => null),
        fetch('http://localhost:3001/api/queue').catch(() => null),
        fetch('http://localhost:3001/api/reservations').catch(() => null)
      ]);
      if (tablesRes && tablesRes.ok) {
        const newTables = await tablesRes.json();
        if (Array.isArray(newTables)) {
          const sanitized = cloudFloorTables(newTables);
          setTables(prev => JSON.stringify(prev) !== JSON.stringify(sanitized) ? sanitized : prev);
        }
      }
      if (queueRes && queueRes.ok) {
        const newQueue = await queueRes.json();
        setQueue(prev => JSON.stringify(prev) !== JSON.stringify(newQueue) ? newQueue : prev);
      }
      if (resRes && resRes.ok) {
        const newRes = await resRes.json();
        setReservations(prev => JSON.stringify(prev) !== JSON.stringify(newRes) ? newRes : prev);
      }
    } catch {}
  }, []);

  const forceFullSync = async () => {
    try {
      const [rawTables, localQueue] = await Promise.all([
        fetchLocalJson('/api/tables'),
        fetchLocalJson('/api/queue')
      ]);

      if (Array.isArray(rawTables)) setTables(cloudFloorTables(rawTables));
      if (Array.isArray(localQueue)) setQueue(localQueue);

      // 🟢 Only load reservations from today up to 9 days ahead to save egress
      const startDay = new Date();
      const endDay = new Date();
      endDay.setDate(endDay.getDate() + 9);

      const [
        { data: resData, error: resErr },
        { data: annData },
        { data: cmsData },
        { data: settingsData },
        { data: closedDatesData },
        { data: promoData },
        { data: eventsData },
        { data: cloudTablesData },
        cloudWaiting
      ] = await Promise.all([
        publicSupabase.from('reservations').select('*').gte('date', bookingDayKey(startDay)).lte('date', bookingDayKey(endDay)),
        publicSupabase.from('announcements').select('*'),
        publicSupabase.from('cms').select('*'),
        publicSupabase.from('system_settings').select('*'),
        publicSupabase.from('closed_dates').select('*'),
        publicSupabase.from('promo_codes').select('*'),
        publicSupabase.from('events').select('*'),
        publicSupabase.from('tables').select('*'),
        Array.isArray(localQueue) ? null : loadPublicQueue()
      ]);

      if (cloudWaiting) setQueue(cloudWaiting);
      if (resErr) console.warn('Supabase reservations notice:', resErr.message || resErr);
      if (Array.isArray(cloudTablesData) && !Array.isArray(rawTables)) {
        setTables(cloudFloorTables(cloudTablesData));
      }

      if (annData && (annData as any[]).length > 0) {
        setAnnouncements((annData as any[]).map(a => {
          const rawActive = a.is_active ?? a.isactive ?? a.isActive;
          const isActive = rawActive !== undefined ? (rawActive === 1 || rawActive === true || rawActive === 'true') : true;
          return {
            id: a.id,
            title: a.title,
            content: a.content,
            type: a.type || 'info',
            isActive,
            expiresAt: a.expires_at || a.expiresat || a.expiresAt || null,
            createdAt: a.created_at || a.createdat || a.createdAt || new Date().toISOString(),
            startDate: a.start_date || a.startdate || a.startDate || null
          };
        }) as Announcement[]);
      } else {
        const localAnn = await fetchLocalJson('/api/announcements');
        if (Array.isArray(localAnn) && localAnn.length > 0) setAnnouncements(localAnn);
      }

      if (closedDatesData && (closedDatesData as any[]).length > 0) {
        setClosedDates(closedDatesData as ClosedDate[]);
      } else {
        const localCd = await fetchLocalJson('/api/closed-dates');
        if (Array.isArray(localCd) && localCd.length > 0) setClosedDates(localCd);
      }

      if (promoData) {
        setPromoCodes((promoData as any[]).map(r => ({
          id: r.id,
          code: r.code,
          discountPercent: r.discount_percent ?? r.discountPercent ?? 0,
          description: r.description,
          isActive: r.is_active === 1 || r.is_active === true || r.isActive === true || r.isActive === 1,
          isLimitedUses: r.is_limited_uses === 1 || r.is_limited_uses === true || r.isLimitedUses === true,
          maxUsage: r.max_usage ?? r.maxUsage ?? 0,
          usageCount: Number(r.usage_count ?? r.usageCount) || 0,
          startDate: r.start_date || r.startDate || null,
          expiresAt: r.expires_at || r.expiresAt || null
        })) as PromoCode[]);
      }

      let eventTableMap: Record<string, string[]> = {};
      const rawEventMapRow = ((cmsData as any[]) || []).find((r: any) =>
        (r.keyname || r.key_name || r.keyName) === 'eventTableAssignments'
      );
      if (rawEventMapRow) {
        const rawMapValue = rawEventMapRow.settingvalue ?? rawEventMapRow.setting_value ?? rawEventMapRow.settingValue;
        try {
          const parsedMap = typeof rawMapValue === 'string' ? JSON.parse(rawMapValue) : rawMapValue;
          if (parsedMap && typeof parsedMap === 'object' && !Array.isArray(parsedMap)) {
            Object.entries(parsedMap).forEach(([eventId, value]) => {
              if (Array.isArray(value)) eventTableMap[String(eventId)] = value.map(String);
            });
          }
        } catch {}
      }

      if (eventsData && (eventsData as any[]).length > 0) {
        setEvents((eventsData as any[]).map(e => {
          let parsedDates: string[] = [];
          if (Array.isArray(e.dates)) parsedDates = e.dates;
          else if (typeof e.dates === 'string') {
            try { parsedDates = JSON.parse(e.dates); } catch { parsedDates = [e.dates]; }
          }
          if (e.date && !parsedDates.includes(e.date)) parsedDates.push(e.date);

          let parsedTableIds: string[] = [];
          const rawTIds = e.eventTableIds || e.selectedTableIds || e.event_table_ids || e.tableIds;
          if (Array.isArray(rawTIds)) parsedTableIds = rawTIds;
          else if (typeof rawTIds === 'string') {
            try { parsedTableIds = JSON.parse(rawTIds); } catch { parsedTableIds = [rawTIds]; }
          }
          if (parsedTableIds.length === 0) {
            const mappedIds = eventTableMap[String(e.id)];
            if (mappedIds && mappedIds.length > 0) parsedTableIds = mappedIds;
          }

          const rawCancelled = e.iscancelled ?? e.is_cancelled ?? e.isCancelled;
          const isCancelled = rawCancelled === true || rawCancelled === 1 || rawCancelled === '1' || rawCancelled === 'true' || String(e.status || '').toLowerCase() === 'cancelled';
          const rawAllowRes = e.allowreservations ?? e.allow_reservations ?? e.allowReservations;
          const rawSlotsFull = e.slotsfull ?? e.slots_full ?? e.slotsFull;
          const rawCater = e.caterwalkins ?? e.cater_walkins ?? e.caterWalkIns;
          const rawWalkIns = e.walkintablecount ?? e.walk_in_table_count ?? e.walkInTableCount;
          let attachments: any[] = [];
          if (Array.isArray(e.attachments)) attachments = e.attachments;
          else if (typeof e.attachments === 'string' && e.attachments.trim()) {
            try {
              const parsed = JSON.parse(e.attachments);
              attachments = Array.isArray(parsed) ? parsed : [e.attachments];
            } catch { attachments = [e.attachments]; }
          }

          return {
            ...e,
            dates: parsedDates,
            eventTableIds: parsedTableIds,
            isCancelled,
            cancelReason: e.cancelReason ?? e.cancelreason ?? '',
            cancelledAt: e.cancelledAt ?? e.cancelled_at ?? null,
            registrationLink: e.registrationLink ?? e.registrationlink ?? '',
            bracketLink: e.bracketLink ?? e.bracketlink ?? '',
            slotsFull: rawSlotsFull === true || rawSlotsFull === 1 || rawSlotsFull === '1' || rawSlotsFull === 'true',
            allowReservations: !(rawAllowRes === false || rawAllowRes === 0 || rawAllowRes === '0' || rawAllowRes === 'false'),
            caterWalkIns: !(rawCater === false || rawCater === 0 || rawCater === '0' || rawCater === 'false'),
            walkInTableCount: Number(rawWalkIns ?? 10) || 10,
            reservationTableCount: e.reservationTableCount ?? e.reservationtablecount ?? 4,
            minParticipants: e.minParticipants ?? e.minparticipants ?? 0,
            maxParticipants: e.maxParticipants ?? e.maxparticipants ?? 0,
            duration: e.duration ?? '',
            createdAt: e.createdAt ?? e.createdat ?? null,
            attachments
          };
        }) as Event[]);
      } else {
        const localEv = await fetchLocalJson('/api/events');
        if (Array.isArray(localEv) && localEv.length > 0) setEvents(localEv);
      }

      const configObj: any = {};
      if (settingsData) {
        const settingsObj = (settingsData as any[]).reduce((acc: any, curr: any) => {
          const k = curr.key_name || curr.keyName || curr.keyname;
          let val = curr.setting_value ?? curr.settingValue ?? curr.settingvalue ?? curr.content_value;
          if (val === 'true') val = true;
          else if (val === 'false') val = false;
          else if (!isNaN(val) && typeof val === 'string' && val.trim() !== '' && !val.includes(':') && !val.includes('.')) val = Number(val);
          if (k) {
            acc[k] = val;
            configObj[k] = val;
          }
          return acc;
        }, {});
        setRates(prev => ({ ...prev, ...settingsObj }));
        setReservationTerms(prev => ({ ...prev, ...settingsObj }));
      }

      if (cmsData) {
        (cmsData as any[]).forEach((curr: any) => {
          const k = curr.key_name || curr.keyName || curr.keyname;
          const v = curr.settingvalue ?? curr.settingValue ?? curr.setting_value ?? curr.content_value;
          if (k) configObj[k] = v;
        });
      }
      setSiteConfig((prev: any) => ({ ...(prev || {}), ...configObj }));

      if (resData && (resData as any[]).length > 0) {
        const mappedRes = (resData as any[]).map(r => ({
          id: r.id,
          customerName: r.customerName || r.customer_name,
          contactNumber: r.contactNumber || r.contact_number,
          email: r.email,
          date: bookingDay(r.date),
          timeSlot: r.timeSlot || r.time_slot,
          durationHours: r.durationHours || r.duration_hours,
          partySize: r.partySize || r.party_size,
          tableId: r.tableId || r.table_id,
          status: r.status,
          totalAmount: r.totalAmount || r.total_amount,
          downPaymentAmount: r.downPaymentAmount || r.down_payment_amount,
          downPaymentPaid: !!r.downPaymentPaid || !!r.down_payment_paid,
          balancePaid: !!r.balancePaid || !!r.balance_paid,
          createdAt: new Date(r.createdAt || r.created_at),
          cancellationReason: r.cancellationReason || r.cancellation_reason,
          refundStatus: r.refundStatus || r.refund_status,
          refundMethod: r.refundMethod || r.refund_method,
          refundNotes: r.refundNotes || r.refund_notes,
          paymentRef: r.paymentRef || r.payment_ref,
          receiptImg: r.receiptImg || r.receipt_img_url,
          promoCode: r.promoCode || r.promocode || r.promo_code || null,
          discountAmount: r.discountAmount || r.discountamount || r.discount_amount || 0,
          rescheduleCount: Number(r.rescheduleCount ?? r.reschedule_count ?? 0) || 0
        }));
        setReservations(mappedRes);
      } else {
        const localRes = await fetchLocalJson('/api/reservations');
        if (Array.isArray(localRes) && localRes.length > 0) {
          setReservations(localRes.map((r: any) => ({ ...r, date: bookingDay(r.date), createdAt: new Date(r.createdAt || Date.now()) })));
        }
      }

      setLastSynced(new Date());
    } catch (err) {
      console.warn('⚠️ Cloud sync skipped. Loading from local cache...', err);
      const [localRes, localRates, localAnn, localCms, localClosedDates, localPromo, localEvents] = await Promise.all([
        fetchLocalJson('/api/reservations'),
        fetchLocalJson('/api/settings/rates'),
        fetchLocalJson('/api/announcements'),
        fetchLocalJson('/api/cms'),
        fetchLocalJson('/api/closed-dates'),
        fetchLocalJson('/api/promo-codes'),
        fetchLocalJson('/api/events')
      ]);

      if (Array.isArray(localRes)) setReservations(localRes);
      if (Array.isArray(localAnn)) setAnnouncements(localAnn);
      if (localCms) setSiteConfig(localCms);
      if (Array.isArray(localClosedDates)) setClosedDates(localClosedDates);
      if (Array.isArray(localPromo)) setPromoCodes(localPromo);
      if (Array.isArray(localEvents)) setEvents(localEvents);
      if (localRates) {
        setRates(prev => ({ ...prev, ...localRates }));
        setReservationTerms(prev => ({ ...prev, ...localRates }));
      }
    } finally {
      setIsInitializing(false);
    }
  };

  useEffect(() => {
    forceFullSync();
  }, []);

  const addReservation = async (i: Omit<Reservation, 'id' | 'createdAt'>): Promise<string> => {
    const id = Math.random().toString(36).substring(2, 8).toUpperCase();
    const newRes = { ...i, id, createdAt: new Date() };

    const supabasePayload = {
      id: newRes.id,
      customerName: newRes.customerName,
      contactNumber: newRes.contactNumber,
      email: newRes.email || null,
      date: bookingDayKey(newRes.date),
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

    const { error } = await publicSupabase.from('reservations').insert([supabasePayload]);
    if (error) throw new Error(error.message);

    setReservations(prev => [...prev, newRes as Reservation]);

    if (i.promoCode) {
      const promo = promoCodes.find(p => p.code === i.promoCode);
      if (promo) {
        void publicSupabase.from('promo_codes').select('usage_count').eq('id', promo.id).maybeSingle().then(({ data }) => {
          if (data) {
            setPromoCodes(prev => prev.map(p => p.id === promo.id
              ? { ...p, usageCount: Math.max(p.usageCount, Number(data.usage_count) || 0) }
              : p
            ));
          }
        });
      }
    }

    if (isServedFromLocalMachine()) {
      fetch('http://localhost:3001/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newRes)
      }).catch(() => {});
    }

    return id;
  };

  const cancelReservation = (id: string, reason: string) => {
    setReservations(prev => prev.map(r => r.id === id ? { ...r, status: 'cancelled', cancellationReason: reason } : r));
    publicSupabase.from('reservations').update({
      status: 'cancelled',
      cancellation_reason: reason,
      cancellationreason: reason
    }).eq('id', id).then(({ error }) => {
      if (error) console.error('Supabase cancel error:', error);
    });
  };

  const addFeedback = (i: Omit<Feedback, 'id' | 'date'>) => {
    const newFeedback = { ...i, id: `f${Date.now()}`, date: new Date() };
    const { rating, ...supabasePayload } = newFeedback;
    publicSupabase.from('feedback').insert([supabasePayload]).then(({ error }) => {
      if (error) console.error('Error inserting feedback to Supabase:', error);
    });
    if (isServedFromLocalMachine()) {
      fetch('http://localhost:3001/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newFeedback)
      }).catch(() => {});
    }
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

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center">
        <LoadingRing className="h-16 w-16 mb-6" />
        <h1 className="text-2xl font-black text-white tracking-widest">ONE SHOT</h1>
      </div>
    );
  }

  return (
    <AppContext.Provider value={{
      tables,
      queue,
      reservations,
      promoCodes,
      rates,
      reservationTerms,
      announcements,
      closedDates,
      events,
      siteConfig,
      lastSynced,
      addReservation,
      cancelReservation,
      addFeedback,
      applyPromoCode,
      refreshLiveMonitor,
      forceFullSync
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