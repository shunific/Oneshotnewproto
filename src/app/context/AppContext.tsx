import { pendingVenueCreates as readVenueCreates, saveVenueCreate } from '../utils/venueContentPersistence.js';
import { pendingCmsSave as readPendingCmsSave, saveCmsConfig } from '../utils/cmsPersistence.js';
import { validateCmsSnapshot } from '../../../cms-contract.mjs';
import { venueCanonical, venueExact, normalizeVenuePayload, validateVenueRecord } from '../../../venue-content-contract.mjs';
import { pendingContentCreates as readContentCreates, saveContentCreate } from '../utils/contentCreatePersistence';
import { pendingQueueOperations as readPendingQueueOperations, saveQueueOperation, retryQueueOperation, queueSnapshot } from '../utils/queuePersistence.js';
import { clearRefundReturnDrafts } from '../utils/refundReturnPersistence';
import { clearCloudPaymentDrafts } from '../utils/cloudStaffPersistence';
import { pendingSessionChanges, saveSessionChange, readPendingReservationMoveList, recoverReservationMove as recoverSavedReservationMove } from '../utils/sessionPersistence.js';
import { authRequest, localFetch } from '../utils/localApi';
import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef, useMemo } from 'react';
import { readTableAvailability } from '../utils/tableAvailability.js';
import { localRequestError } from '../utils/localRequestError.js';
import { toast } from 'sonner';
import { supabase } from '../utils/supabase';
import { getPendingCheckout, saveCheckoutOperation } from '../utils/checkoutPersistence.js';
import { syncCheckoutCompletion } from '../utils/checkoutCloudSync.js';
import { getPendingOrder, saveOrderOperation } from '../utils/orderPersistence.js';
import { motion, AnimatePresence } from 'motion/react';
import { KeyRound, CheckCircle2, Copy, Download } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────
export type TableStatus = 'available' | 'occupied' | 'reserved' | 'maintenance' | 'event';

export type SessionOrder = {
  id: string;
  name: string;
  price: number;
  qty: number;
};
export type SessionHistoryItem = {
  id: string; customerName: string; tableId: string; tableName: string; startTime: Date; endTime: Date; durationMinutes: number; totalAmount: number; amountPaid: number; orders: SessionOrder[];
};

export type ExtensionPayment = {method: 'cash' | 'gcash'; reference?: string};

export type Session = {
  customerName: string;
  startTime: Date;
  durationMinutes: number | null;
  isOpenTime: boolean;
  latestEndTime?: string;
  isPaid: boolean;
  hourlyRate: number | null;
  overtimeRate?: number;
  pricingVersion?: 1 | 2;
  reservationId?: string;
  customerEmail?: string | null;
  customerPhone?: string;
  partySize?: number;
  reservationPricing?: { claimId: string; reservationId: string; ownerUserId: string; sourceRevision: number; claimRevision: number; durationMinutes: number; grossCents: number; discountCents: number; netCents: number; verifiedPaidCents: number };
  amountPaid: number;
  orders?: SessionOrder[];
  processedOrderOperations?: { key: string; requestFingerprint?: string; inventoryIds: string[] }[];
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
export type LostItem = {
  id: string; itemName: string; description: string; foundDate: Date; status: 'found' | 'claimed'; image?: string; claimedBy?: string; claimedDate?: Date; isArchived?: boolean;
};
export type WatchlistItem = {
  id: string; name: string; reason: 'debt' | 'theft' | 'banned' | 'other'; description: string; status: 'active' | 'resolved'; evidenceLink?: string; dateAdded: Date; resolvedDate?: Date; isArchived?: boolean;
};

export type InventoryItem = {
  id: string; name: string; category: string; price: number; stock: number; isActive: boolean;
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
  status?: 'pending' | 'resolved'; notes?: string;
};

export type ActivityType =
  | 'table_assigned' | 'table_freed' | 'table_reserved' | 'session_extended'
  | 'queue_added' | 'queue_removed' | 'queue_called'
  | 'reservation_created' | 'reservation_updated' | 'payment_received' | 'reservation_cancelled'
  | 'feedback_received' | 'promo_created'
  | 'admin_action' | 'tako_action' | 'pos_order';

export type Activity = {
  id: string; type: ActivityType; description: string; timestamp: Date; metadata?: Record<string, any>;
};

export type PromoCode = {
  id: string; code: string; discountPercent: number; description: string; isActive: boolean; isLimitedUses: boolean; maxUsage: number; usageCount: number; startDate?: Date | string | null; expiresAt?: Date | string | null; createdAt: Date;
};

export type Event = {
  id: string; title: string; date: string; type: string; description: string; registrationLink?: string; maxParticipants?: number; slotsFull?: boolean; attachments?: string[]; promoCodeId?: string;
  allowReservations?: boolean;
  caterWalkIns?: boolean;
  walkInTableCount?: number;
};

export type StaffProfile = {
  id?: string;
  username: string; password?: string; fullName: string; role: string; phone: string; joinedDate: string; avatarImg?: string;
  isAdmin?: boolean;
  isFirstLogin?: number;
  email?: string;
};

export type StaffUser = {
  id: string; username: string; password?: string; fullName: string; role: 'manager' | 'cashier'; isAdmin: boolean; phone: string; isActive: boolean; createdAt: Date;
  isFirstLogin?: number;
  recoveryPin?: string;
  avatarImg?: string;
  email?: string;
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
  id: string; title: string; content: string; type: AnnouncementType; isActive: boolean; createdAt: Date; expiresAt?: Date | string | null;
  startDate?: Date | string | null;
};
export type ClosedDate = {
  id: string; date: string; reason: string; isFullDay: boolean; openTime?: string; closeTime?: string; type?: 'specific' | 'weekly'; dayOfWeek?: number;
};

export type WeatherData = {
  temp: number; condition: string; isRaining: boolean; code: number; locationName: string;
};

export const HOURLY_RATE = 0;
export const DOWN_PAYMENT_RATE = 0;

export const generateRandomPromoCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

export type PendingReservationMove={requestId:string;moveId:string;sourceId:string;targetId:string;phase:'prepared'|'aborting'|'local-committed'};

type AppContextType = {
  pendingReservationMoves:PendingReservationMove[]; reservationMoveError:string; heldTableIds:Set<string>; availableTables:Table[]; recoverReservationTransfer:(record:PendingReservationMove,action:'continue'|'abort')=>Promise<any>; refreshReservationTransfers:()=>Promise<void>;
  tables: Table[]; queue: QueueItem[]; reservations: Reservation[]; feedback: Feedback[]; activities: Activity[]; promoCodes: PromoCode[]; staffUsers: StaffUser[]; inventory: InventoryItem[]; rates: RatesConfig; reservationTerms: ReservationTerms; announcements: Announcement[]; closedDates: ClosedDate[]; weather: WeatherData | null; updateWeatherLocation: (lat: string, lon: string, name: string) => void;
  activeAnnouncement: string; updateActiveAnnouncement: (msg: string) => void;
  staffLoggedIn: boolean; adminLoggedIn: boolean; staffProfile: StaffProfile;
  signIn: (u: string, p: string) => Promise<any>; changeOwnCredentials: (p: any) => Promise<any>; verifyPassword: (p: string) => Promise<boolean>;
  staffLogin: (u: string, p: string) => Promise<boolean>; staffLogout: () => void; adminLogin: (u: string, p: string) => Promise<boolean>; adminLogout: () => void; updateStaffProfile: (profile: Partial<StaffProfile>) => void;
  checkoutTable: (tableId: string, payload: any) => Promise<any>;
  assignTable: (id: string, s: Session) => Promise<void>; freeTable: (id: string) => Promise<void>; reserveTable: (id: string) => Promise<void>; extendSession: (id: string, mins: number | 'open', pay: number, expectedLatestEndTime?: string, payment?: ExtensionPayment) => Promise<void>; migrateSession: (fromTableId: string, toTableId: string) => Promise<void>; updateTableState: (id: string, patch: Partial<Omit<Table, 'id' | 'session' | 'maintenanceReason'>> & { session?: Session | null; maintenanceReason?: string | null }) => Promise<void>; setTableMaintenance: (id: string, reason: string) => Promise<void>; setTableEvent: (id: string, eventName: string) => Promise<void>; addTable: (n: string) => Promise<void>; updateTable: (id: string, n: string) => Promise<void>; toggleTableActive: (id: string) => Promise<void>; deleteTable: (id: string) => Promise<void>;
  retryPendingOrder: (tableId: string, expectedSessionStartTime: string) => Promise<void>;
  addInventoryItem: (i: Omit<InventoryItem, 'id'>) => Promise<void>; updateInventoryItem: (id: string, i: Partial<InventoryItem>, expectedStock?: number) => Promise<void>; deleteInventoryItem: (id: string) => Promise<void>; submitTableOrders: (tableId: string, cart: SessionOrder[], expectedSessionStartTime: string) => Promise<void>; voidTableOrder: (tableId: string, orderIndex: number, order: SessionOrder, expectedSessionStartTime: string) => Promise<void>;
  addToQueue: (i: Omit<QueueItem, 'id'|'arrivalTime'|'status'|'queueNumber'>) => Promise<any>; removeFromQueue: (id: string) => Promise<any>; callQueueItem: (id: string) => Promise<any>;
  seatQueueCustomer: (queueId: string, tableId: string, session: any) => Promise<any>;
  pendingQueueOperations: any[]; queueOperationError: string; retryPendingQueueOperation: (requestId: string) => Promise<any>;
  addReservation: (i: Omit<Reservation, 'id'|'createdAt'>) => string; updateReservationStatus: (id: string, s: ReservationStatus) => void; updateReservation: (id: string, u: Partial<Reservation>) => void; cancelReservation: (id: string, r: string) => void; updateDownPayment: (id: string, p: boolean) => void; updateBalance: (id: string, p: boolean) => void;
  addFeedback: (i: Omit<Feedback, 'id'|'date'>) => void; resolveFeedback: (id: string, notes: string) => Promise<void>; addActivity: (t: ActivityType, d: string, m?: Record<string, any>) => void;
  pendingContentCreates: any[]; contentCreateError: string; retryContentCreate: (kind: string) => Promise<any>; addPromoCode: (i: Omit<PromoCode, 'id'|'createdAt'|'usageCount'>) => Promise<string>; updatePromoCode: (id: string, u: Partial<Omit<PromoCode, 'id'|'createdAt'|'usageCount'>>) => Promise<void>; togglePromoCode: (id: string) => Promise<void>; deletePromoCode: (id: string) => Promise<void>; applyPromoCode: (c: string) => PromoCode | null;
  events: Event[]; addEvent: (e: Omit<Event, 'id'>) => Promise<string>; updateEvent: (id: string, updates: Partial<Omit<Event, 'id'>>, expectedRecord?: any) => Promise<void>; deleteEvent: (id: string, expectedRecord?: any) => Promise<void>; pendingVenueCreates: any[]; venueCreateError: string; retryVenueCreate: (kind: string) => Promise<any>;
  addStaffUser: (u: Omit<StaffUser, 'id'|'createdAt'>) => Promise<StaffUser>; updateStaffUser: (id: string, u: Partial<StaffUser>) => Promise<void>; resetStaffUserPassword: (id: string) => Promise<void>; toggleStaffUserActive: (id: string) => void;
  savePolicySettings: (r: Partial<RatesConfig>, t: Partial<ReservationTerms>, revision: string) => Promise<any>; addAnnouncement: (a: Omit<Announcement, 'id'|'createdAt'>) => Promise<void>; updateAnnouncement: (id: string, u: Partial<Announcement>) => Promise<void>; deleteAnnouncement: (id: string) => Promise<void>; toggleAnnouncement: (id: string) => Promise<void>; addClosedDate: (c: Omit<ClosedDate, 'id'>) => Promise<string>; removeClosedDate: (id: string, expectedRecord?: any) => Promise<void>; updateClosedDate: (id: string, u: Partial<ClosedDate>, expectedRecord?: any) => Promise<void>;
  siteConfig: any; updateSiteConfig: (config: any) => Promise<any>; pendingCmsSave: any; cmsSaveError: string; retryCmsSave: () => Promise<any>; refreshCmsConfig: () => Promise<any>; refreshLiveMonitor: () => void;
  lostItems: LostItem[];
  addLostItem: (i: Omit<LostItem, 'id'>) => Promise<void>;
  updateLostItem: (id: string, u: Partial<LostItem>) => void;
  deleteLostItem: (id: string) => void;
  watchlist: WatchlistItem[];
  addWatchlistItem: (i: Omit<WatchlistItem, 'id'>) => Promise<void>;
  updateWatchlistItem: (id: string, u: Partial<WatchlistItem>) => Promise<void>;
  deleteWatchlistItem: (id: string) => Promise<void>;
  sessionHistory: SessionHistoryItem[];
  addSessionHistory: (i: Omit<SessionHistoryItem, 'id'>) => void;
  resetPasswordWithPin: (username: string, pin: string, newPassword: string) => Promise<{ success: boolean; message: string }>;
  isSystemOffline: boolean;
  hashPassword: (p: string) => Promise<string>;
  theme: 'dark' | 'light';
  primaryColor: string;
  updateTheme: (theme: 'dark' | 'light') => void;
  updatePrimaryColor: (color: string) => void;
  updateRefundStatus: (id: string, refundStatus: string, method?: string, notes?: string) => void;
  acknowledgeRefund: (id: string) => void;
  isLoggingOut: boolean;
  logoutStep: string;
  lastSynced: Date | null;
  forceFullSync: () => Promise<void>;
};

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const recoveryStorage = useRef<Storage | null>(null);
  const identityRef = useRef<string | null>(null);
  const authAccountRef = useRef<string | null>(null);
  const identityGeneration = useRef(0);
  const floorRefreshGeneration = useRef(0);
  const authMutationInFlight = useRef<symbol | null>(null);
  const cmsSnapshotRef = useRef<any>(null);
  const cmsGeneration = useRef(0);
  const cmsInFlight = useRef(false);
  if (!recoveryStorage.current) { try { recoveryStorage.current = sessionStorage; } catch { /* Authentication remains unavailable without recovery storage. */ } }
  const [isInitializing, setIsInitializing] = useState(true);

  // States
  const [tables, setTables] = useState<Table[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [pendingQueueOperations,setPendingQueueOperations]=useState<any[]>([]);
  const [queueOperationError,setQueueOperationError]=useState('');
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [promoCodes, setPromoCodes] = useState<PromoCode[]>([]);
  const [staffUsers, setStaffUsers] = useState<StaffUser[]>([]);
  const [rates, setRates] = useState<RatesConfig>({ hourlyRate: 0, overtimeRate: 0, downPaymentPercent: 0, weekdayStartTime: '', weekdayEndTime: '', isWeekdayHappyHourActive: false, weekdayHappyHourRate: 0, weekdayHappyHourStart: '', weekdayHappyHourEnd: '', weekdayOnlineCapacityLimit: 0, weekendStartTime: '', weekendEndTime: '', isWeekendHappyHourActive: false, weekendHappyHourRate: 0, weekendHappyHourStart: '', weekendHappyHourEnd: '', weekendOnlineCapacityLimit: 0, bookingCutoffMinutes: 60 });
  const [reservationTerms, setReservationTerms] = useState<ReservationTerms>({ minHours: 0, maxHours: 0, cancellationHours: 0, advanceBookingHours: 1, cancellationPolicy: '', termsAndConditions: '', weekdayMinPartySize: 0, weekdayMaxPartySize: 0, weekendMinPartySize: 0, weekendMaxPartySize: 0 });
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [closedDates, setClosedDates] = useState<ClosedDate[]>([]);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherConfig, setWeatherConfig] = useState({ lat: '', lon: '', name: '' });
  const [activeAnnouncement, setActiveAnnouncement] = useState("");
  const updateActiveAnnouncement = (msg: string) => setActiveAnnouncement(msg);

  const [staffLoggedIn, setStaffLoggedIn] = useState(false);
  const [adminLoggedIn, setAdminLoggedIn] = useState(false);

  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutStep, setLogoutStep] = useState('');
  const [pendingReservationMoves,setPendingReservationMoves]=useState<PendingReservationMove[]>([]);
  const [reservationMoveError,setReservationMoveError]=useState('Checking transfer recovery before assigning tables.');
  const {heldTableIds,availableTables}=useMemo(()=>readTableAvailability(tables,pendingReservationMoves,reservationMoveError),[tables,pendingReservationMoves,reservationMoveError]);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  // 🎨 Global Theme State
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('oneshot_theme') as 'dark' | 'light') || 'dark');
  const [primaryColor, setPrimaryColor] = useState(() => localStorage.getItem('oneshot_color') || 'emerald');

  const [staffProfile, setStaffProfile] = useState<StaffProfile>({ id: '', username: '', fullName: '', role: '', phone: '', joinedDate: '', isAdmin: false });

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-color', primaryColor);
  }, [theme, primaryColor]);

  const updateTheme = (newTheme: 'dark' | 'light') => {
    setTheme(newTheme);
    localStorage.setItem('oneshot_theme', newTheme);
  };

  const updatePrimaryColor = (color: string) => {
    setPrimaryColor(color);
    localStorage.setItem('oneshot_color', color);
  };

  const [siteConfig, setSiteConfig] = useState<any>(null);
  const [pendingCmsSave, setPendingCmsSave] = useState<any>(null);
  const [cmsSaveError, setCmsSaveError] = useState('');
  const updateWeatherLocation = useCallback((lat: string, lon: string, name: string) => { setWeatherConfig({ lat, lon, name }); }, []);
  const [lostItems, setLostItems] = useState<LostItem[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [sessionHistory, setSessionHistory] = useState<SessionHistoryItem[]>([]);
  const [isSystemOffline, setIsSystemOffline] = useState(false);

  const applyPendingReservationMoves=(data:any)=>{
    try{setPendingReservationMoves(readPendingReservationMoveList(data));setReservationMoveError('');}
    catch{setReservationMoveError('Transfer recovery status could not be loaded. Refresh before using held tables.');}
  };
  const refreshReservationTransfers=async()=>{
    const owner=identityRef.current,epoch=identityGeneration.current,refresh=++floorRefreshGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch&&floorRefreshGeneration.current===refresh;
    if(!isCurrent())return;
    try{const response=await localFetch('http://localhost:3001/api/native/reservation-moves');const data=response.ok?await response.json():null;if(isCurrent())applyPendingReservationMoves(data);}
    catch{if(isCurrent())setReservationMoveError('Transfer recovery status could not be loaded. Refresh before using held tables.');}
  };
  const refreshLiveMonitor = async () => {
    const owner = identityRef.current, epoch = identityGeneration.current, refresh=++floorRefreshGeneration.current;
    const isCurrent = () => !!owner && !authMutationInFlight.current && identityRef.current === owner && identityGeneration.current === epoch && floorRefreshGeneration.current===refresh;
    if (!isCurrent()) return;
    try {
      const results = await Promise.all(['tables', 'queue', 'reservations', 'inventory', 'native/reservation-moves', 'session-history'].map(async endpoint => {
        try { const response = await localFetch(`http://localhost:3001/api/${endpoint}`); return response.ok ? await response.json() : null; }
        catch { return null; }
      }));
      if (!isCurrent()) return;
      const [tableRows, queueRows, reservationRows, inventoryRows,moveRows,historyRows] = results;
      applyPendingReservationMoves(moveRows);
      if (Array.isArray(historyRows)) setSessionHistory(prev => isCurrent() && JSON.stringify(prev)!==JSON.stringify(historyRows) ? historyRows : prev);
      if (inventoryRows) setInventory(inventoryRows);
      if (tableRows) setTables(prev => isCurrent() && JSON.stringify(prev) !== JSON.stringify(tableRows) ? tableRows : prev);
      if (queueRows) setQueue(prev => isCurrent() && JSON.stringify(prev) !== JSON.stringify(queueRows) ? queueRows : prev);
      if (reservationRows) setReservations(prev => isCurrent() && JSON.stringify(prev) !== JSON.stringify(reservationRows) ? reservationRows : prev);
    } catch { /* A failed or obsolete refresh must not replace the current floor. */ }
  };

  useEffect(() => {
    if (!staffLoggedIn) return;
    const refresh = () => { void refreshLiveMonitor(); };
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [staffLoggedIn]);

  const forceFullSync = async () => {
    const owner = identityRef.current, epoch = identityGeneration.current, refresh=++floorRefreshGeneration.current;
    const isCurrent = () => !!owner && !authMutationInFlight.current && identityRef.current === owner && identityGeneration.current === epoch;
    const isFloorCurrent=()=>isCurrent()&&floorRefreshGeneration.current===refresh;
    if (!isCurrent()) return;
    const readLocal = async (endpoint: string) => {
      try { const response = await localFetch(`http://localhost:3001/api/${endpoint}`); return response.ok ? await response.json() : null; }
      catch { return null; }
    };
    try {
      // Parse the entire private batch before applying any rows: response headers
      // may arrive under one account while response.json() finishes under another.
      const floor = await Promise.all(['tables', 'inventory', 'queue', 'staff', 'session-history', 'activities', 'feedback', 'lost-and-found', 'watchlist', 'native/reservation-moves'].map(readLocal));
      if (!isCurrent()) return;
      const [tableRows, inventoryRows, queueRows, staffRows, historyRows, activityRows, feedbackRows, lostRows, watchRows, moveRows] = floor;
      if(isFloorCurrent()){
        applyPendingReservationMoves(moveRows);
        if (tableRows) setTables(tableRows);
        if (inventoryRows) setInventory(inventoryRows);
        if (queueRows) setQueue(queueRows);
      }
      if (staffRows) setStaffUsers(staffRows);
      if (Array.isArray(historyRows) && isFloorCurrent()) setSessionHistory(prev => isFloorCurrent() ? historyRows : prev);
      if (activityRows) setActivities(activityRows);
      if (feedbackRows) setFeedback(feedbackRows);
      if (lostRows) setLostItems(lostRows);
      if (watchRows) setWatchlist(watchRows);
      if (!isCurrent()) return;
      const cmsEpoch = cmsGeneration.current;
      const results = await Promise.all(['reservations', 'settings/rates', 'settings/terms', 'announcements', 'cms', 'closed-dates', 'promo-codes', 'events'].map(readLocal));
      if (!isCurrent()) return;
      const [resData, ratesData, termsData, annData, cmsData, closedData, promosData, eventsData] = results;
      if (resData&&isFloorCurrent()) setReservations(resData);
      if (ratesData) setRates(prev => isCurrent() ? ({ ...prev, ...ratesData }) : prev);
      if (termsData) setReservationTerms(prev => isCurrent() ? ({ ...prev, ...termsData }) : prev);
      if (annData) setAnnouncements(annData);
      if (cmsData && !cmsInFlight.current && cmsGeneration.current === cmsEpoch) {
        try { const saved = validateCmsSnapshot(cmsData); cmsSnapshotRef.current = saved; setSiteConfig((prev: any) => isCurrent() && !cmsInFlight.current && cmsGeneration.current === cmsEpoch ? saved.record : prev); }
        catch { setCmsSaveError('Saved local images could not be verified. Reload before editing.'); }
      }
      if (closedData) setClosedDates(closedData);
      if (promosData) setPromoCodes(promosData);
      if (eventsData) setEvents(eventsData);
      setIsSystemOffline(true);
      setLastSynced(new Date());
      remindPendingSessions();
      refreshPendingQueueOperations();
    } catch (err) {
      if (isCurrent()) console.warn('Local refresh failed', err);
    } finally {
      if (isCurrent()) setIsInitializing(false);
    }
  };

  useEffect(() => {
    let stopped = false;
    const attempt = ++identityGeneration.current;
    let completion = attempt;
    void (async () => {
      try {
        const result = await authRequest('me');
        if (stopped || identityGeneration.current !== attempt) return;
        completion = applyIdentity(result.user, result.requiresPasswordChange);
        if (!result.requiresPasswordChange) await forceFullSync();
      } catch {
        if (!stopped && identityGeneration.current === completion) clearIdentity();
      } finally {
        if (!stopped && identityGeneration.current === completion) setIsInitializing(false);
      }
    })();
    return () => { stopped = true; identityGeneration.current++; };
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

  const cloudSyncTimeout = useRef<NodeJS.Timeout | null>(null);

  const runCloudBackup = () => {
    if (cloudSyncTimeout.current) clearTimeout(cloudSyncTimeout.current);
    cloudSyncTimeout.current = setTimeout(() => {
      localFetch('http://localhost:3001/api/sync-to-cloud', { method: 'POST' }).then(r => { if (!r.ok) toast.warning('Saved locally. Secure cloud backup is not configured.', { id: 'cloud-backup-unavailable' }); }).catch(() => toast.warning('Saved locally; cloud backup unavailable.', { id: 'cloud-backup-unavailable' }));
    }, 1500);
  };

  const syncToDB = async (endpoint: string, method: 'POST' | 'PUT' | 'DELETE', payload: any, successMsg: string) => {
      let res:Response,text:string;
      try { res = await localFetch(`http://localhost:3001${endpoint}`, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); text = await res.text(); }
      catch { throw localRequestError(0,null); }
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = text; }
      if (res.ok) return json;
      throw localRequestError(res.status,json);
  };

  const addActivity = (type: ActivityType, description: string, metadata?: Record<string, any>) => {
    const actor = staffProfile?.fullName || 'System / Customer';
    const actorId = staffProfile?.id || 'system';
    const detailedDescription = `${description} (Action by: ${actor})`;
    const newActivity = {
      id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      type,
      description: detailedDescription,
      timestamp: new Date(),
      metadata: { ...metadata, actorId }
    };
    setActivities(prev => [newActivity, ...prev]);
    syncToDB('/api/activities', 'POST', newActivity, "Activity logged").then(runCloudBackup).catch(()=>{});
  };

  const updateTableState = async (tableId: string, updates: any) => {
    if (pendingSessionChanges(localStorage).some(r => r.tableId === tableId || r.payload.targetId === tableId)) throw new Error('Resolve the pending session change first.');
    const table = tables.find(t => t.id === tableId);
    if (!table) throw new Error('Table was not found.');
    if (table.session && getPendingCheckout(localStorage, tableId, new Date(table.session.startTime).toISOString())) throw new Error('Resolve the pending checkout first.');
    const saved = await syncToDB(`/api/tables/${encodeURIComponent(tableId)}`, 'PUT', { ...updates, expectedStatus: table.status, expectedSession: table.session || null }, 'Table saved');
    if (saved?.id !== tableId) throw new Error('Table save was not confirmed. Refresh before retrying.');
    await forceFullSync(); runCloudBackup();
  };
  const assignTable = async (tableId: string, session: Session) => {
    if(!availableTables.some(table=>table.id===tableId))throw new Error('Refresh Table Monitor and choose a verified available table before starting play.');
    await updateTableState(tableId, { status: 'occupied', session: { ...session, orders: session.orders || [] } });
    addActivity('table_assigned', `Assigned table to ${session.customerName}`);
  };
  const freeTable = async (tableId: string) => {
    await updateTableState(tableId, { status: 'available', session: null, maintenanceReason: null });
    addActivity('table_freed', `Released table ${tableId}`);
  };
  const persistSessionChange = async (tableId: string, kind: string, payload: any) => {
    const saved = await saveSessionChange({ storage: localStorage, tableId, kind, payload, request: (endpoint: string, body: any) => syncToDB(endpoint, 'POST', body, 'Session saved') });
    await forceFullSync();
    return saved;
  };
  const remindPendingSessions = () => {
    try {
      for (const record of pendingSessionChanges(localStorage)) toast.warning(`Unconfirmed ${record.kind} for table ${record.tableId}`, {
        id: `pending-session-${record.tableId}`, duration: Infinity,
        action: { label: 'Retry', onClick: () => { void persistSessionChange(record.tableId, record.kind, record.payload).then(() => toast.dismiss(`pending-session-${record.tableId}`)).catch(e => toast.error(e.message)); } },
      });
    } catch (e: any) { toast.error(e.message); }
  };
  const extendSession = async (tableId: string, mins: number | 'open', pay: number, expectedLatestEndTime?: string, payment: ExtensionPayment = {method:'cash'}) => {
    const table = tables.find(t => t.id === tableId);
    if (!table?.session) throw new Error('Session was not found.');
    try { await persistSessionChange(tableId, 'extend', { expectedSession: table.session, minutes: mins, tendered: pay, paymentMethod: payment.method, ...(payment.method === 'gcash' && pay > 0 ? {paymentReference:payment.reference} : {}), ...(mins === 'open' ? {expectedLatestEndTime} : {}) }); }
    catch (error) { remindPendingSessions(); throw error; }
    addActivity('session_extended', `Extended table ${tableId}`);
  };
  const migrateSession = async (fromTableId: string, toTableId: string) => {
    const source = tables.find(t => t.id === fromTableId), target = tables.find(t => t.id === toTableId);
    if (!source?.session || !target) throw new Error('Refresh tables before moving the session.');
    if(heldTableIds.has(fromTableId)||!availableTables.some(table=>table.id===toTableId))throw new Error('Resolve pending transfers and choose a verified available destination.');
    if (getPendingCheckout(localStorage, fromTableId, new Date(source.session.startTime).toISOString()) || getPendingOrder(localStorage, fromTableId, new Date(source.session.startTime).toISOString())) throw new Error('Resolve pending saves before moving this session.');
    try { const saved=await persistSessionChange(fromTableId, 'move', { targetId: toTableId, expectedSession: source.session, expectedTargetStatus: target.status, expectedTargetSession: target.session || null });if(saved.phase==='aborted')throw new Error('This transfer was cancelled. Choose a new destination when ready.'); }
    catch (error) { await forceFullSync(); remindPendingSessions(); throw error; }
  };
  const recoverReservationTransfer=async(record:PendingReservationMove,action:'continue'|'abort')=>{
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch;
    try{return await recoverSavedReservationMove({storage:localStorage,record,action,isCurrent,request:(endpoint:string,body:any)=>syncToDB(endpoint,'POST',body,'Transfer recovery saved')});}
    finally{if(isCurrent())await forceFullSync();}
  };
  const reserveTable = async (tableId: string) => { await updateTableState(tableId, { status: 'reserved' }); };
  const setTableMaintenance = async (tableId: string, reason: string) => { await updateTableState(tableId, { status: 'maintenance', maintenanceReason: reason }); };
  const setTableEvent = async (tableId: string, eventName: string) => { await updateTableState(tableId, { status: 'event', maintenanceReason: eventName }); };
  const checkoutTable = async (tableId: string, payload: any) => {
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch;
    if (pendingSessionChanges(localStorage).some(r => r.tableId === tableId || r.payload.targetId === tableId)) throw new Error('Resolve the pending session change before checkout.');
    const start = payload.expectedSessionStartTime;
    if (getPendingOrder(localStorage, tableId, start)) throw new Error('Resolve the unconfirmed order before checkout.');
    const result = await saveCheckoutOperation({ storage: localStorage, tableId, payload, request: (endpoint: string, body: any) => syncToDB(endpoint, 'POST', body, 'Checkout saved') });
    const cloudSync = await syncCheckoutCompletion(result, { isCurrent, request: async (endpoint: string, body: unknown) => {
      const response = await localFetch(`http://localhost:3001${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('Online receipt synchronization is pending.');
      return response.json();
    } });
    if (cloudSync && isCurrent() && !cloudSync.cloudAcknowledged) toast.warning('Checkout saved locally. Online receipt is pending; open Settings → Cloud staff to retry sync.');
    // Read current tables: a replayed old receipt must never clear a newer session.
    await forceFullSync(); runCloudBackup();
    return result;
  };

  const persistOrderOperation = async (tableId: string, operation: string, payload: Record<string, unknown>) => {
    if (pendingSessionChanges(localStorage).some(r => r.tableId === tableId || r.payload.targetId === tableId)) throw new Error('Resolve the pending session change first.');
    if (getPendingCheckout(localStorage, tableId, payload.expectedSessionStartTime)) throw new Error('Resolve the unconfirmed checkout before changing this bill.');
    const saved = await saveOrderOperation({ storage: localStorage, tableId, operation, payload,
      request: (endpoint: string, body: unknown) => syncToDB(endpoint, 'POST', body, 'Orders saved') });
    setTables(prev => prev.map(table => table.id === tableId ? { ...table, session: { ...saved.session, startTime: new Date(saved.session.startTime) } } : table));
    setInventory(prev => prev.map(item => saved.inventory.find((updated: InventoryItem) => updated.id === item.id) || item));
    runCloudBackup();
  };

  const retryPendingOrder = async (tableId: string, expectedSessionStartTime: string) => {
    const pending = getPendingOrder(localStorage, tableId, expectedSessionStartTime);
    if (!pending) return;
    await persistOrderOperation(tableId, pending.operation, pending.payload);
    addActivity('pos_order', `Confirmed pending order operation for ${tableId}`);
  };

  const submitTableOrders = async (tableId: string, cart: SessionOrder[], expectedSessionStartTime: string) => {
    await persistOrderOperation(tableId, 'orders', { expectedSessionStartTime, cart: cart.map(({ id, qty }) => ({ id, qty })) });
    addActivity('pos_order', `Confirmed ${cart.length} order lines for ${tables.find(table => table.id === tableId)?.name}`);
  };

  const voidTableOrder = async (tableId: string, orderIndex: number, order: SessionOrder, expectedSessionStartTime: string) => {
    await persistOrderOperation(tableId, `orders/${orderIndex}/void`, { expectedSessionStartTime, expectedOrder: { id: order.id, qty: order.qty, price: order.price } });
    addActivity('admin_action', `Voided ${order.name} (x${order.qty}) from ${tables.find(table => table.id === tableId)?.name}`);
  };

  const refreshPendingQueueOperations = () => {
    const owner=identityRef.current;
    if (!owner) {setPendingQueueOperations([]);setQueueOperationError('');return;}
    try {setPendingQueueOperations(readPendingQueueOperations(localStorage,owner));setQueueOperationError('');}
    catch {setQueueOperationError('Queue recovery records could not be read. Reconcile the saved action before making another queue change.');}
  };
  const persistQueueOperation = async (kind: string, payload: any, retryId?: string) => {
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch;
    if(!isCurrent()) throw new Error('Sign in again before changing the queue.');
    const options={storage:localStorage,staffId:owner,request:(endpoint:string,body:any)=>syncToDB(endpoint,'POST',body,'Queue action saved'),isCurrent};
    try {
      const result=retryId?await retryQueueOperation({...options,requestId:retryId}):await saveQueueOperation({...options,kind,payload});
      return result;
    } finally {
      if(isCurrent()){refreshPendingQueueOperations();await forceFullSync();}
    }
  };
  const originalQueue = (id:string) => queueSnapshot(queue.find(row=>row.id===id));
  const addToQueue = (item: Omit<QueueItem,'id'|'arrivalTime'|'status'|'queueNumber'>) => persistQueueOperation('add',item);
  const removeFromQueue = (id:string) => persistQueueOperation('remove',{queueId:id,expectedQueue:originalQueue(id)});
  const callQueueItem = (id:string) => persistQueueOperation('call',{queueId:id,expectedQueue:originalQueue(id)});
  const seatQueueCustomer = (queueId:string,tableId:string,session:any) => persistQueueOperation('seat',{queueId,expectedQueue:originalQueue(queueId),tableId,session});
  const retryPendingQueueOperation = (requestId:string) => persistQueueOperation('',null,requestId);

  const addLostItem = async (i: Omit<LostItem, 'id'>) => {
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch;
    if(!isCurrent()) throw new Error('Sign in before saving a lost item.');
    const newItem = { ...i, id: `lf_${crypto.randomUUID()}` };
    await syncToDB('/api/lost-and-found', 'POST', newItem, `Added lost item`);
    if(!isCurrent()) throw new Error('Account changed. Refresh lost and found to check the saved item.');
    setLostItems(prev => [newItem, ...prev]);
    addActivity('admin_action', `Added lost item: ${i.itemName}`);
    runCloudBackup();
  };
  const updateLostItem = (id: string, u: Partial<LostItem>) => {
    setLostItems(prev => prev.map(i => i.id === id ? { ...i, ...u } : i));
    syncToDB(`/api/lost-and-found/${id}`, 'PUT', u, `Updated lost item`).then(runCloudBackup).catch(()=>{});
  };
  const deleteLostItem = (id: string) => {
    setLostItems(prev => prev.map(i => i.id === id ? { ...i, isArchived: true } : i));
    syncToDB(`/api/lost-and-found/${id}`, 'DELETE', {}, `Archived lost item`).then(runCloudBackup).catch(()=>{});
  };

  const addWatchlistItem = async (i: Omit<WatchlistItem, 'id'>) => {
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch;
    if(!isCurrent()) throw new Error('Sign in before saving a watchlist entry.');
    const newItem = { ...i, id: `wl_${crypto.randomUUID()}` };
    await syncToDB('/api/watchlist', 'POST', newItem, `Added to watchlist`);
    if(!isCurrent()) throw new Error('Account changed. Refresh the watchlist to check the saved entry.');
    setWatchlist(prev => [newItem, ...prev]);
    addActivity('admin_action', `Added ${i.name} to Watchlist`);
    runCloudBackup();
  };
  const updateWatchlistItem = async (id: string, u: Partial<WatchlistItem>) => {
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch;
    if(!isCurrent()) throw new Error('Sign in before saving a watchlist entry.');
    await syncToDB(`/api/watchlist/${encodeURIComponent(id)}`, 'PUT', u, `Updated watchlist item`);
    if(!isCurrent()) throw new Error('Account changed. Refresh the watchlist to check the saved entry.');
    setWatchlist(prev => prev.map(i => i.id === id ? { ...i, ...u } : i));
    runCloudBackup();
  };
  const deleteWatchlistItem = async (id: string) => {
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch;
    if(!isCurrent()) throw new Error('Sign in before archiving a watchlist entry.');
    await syncToDB(`/api/watchlist/${encodeURIComponent(id)}`, 'DELETE', {}, `Archived watchlist item`);
    if(!isCurrent()) throw new Error('Account changed. Refresh the watchlist to check the saved entry.');
    setWatchlist(prev => prev.map(i => i.id === id ? { ...i, isArchived: true } : i));
    runCloudBackup();
  };

  const addSessionHistory = (i: Omit<SessionHistoryItem, 'id'>) => {
    const newItem = { ...i, id: `sh${Date.now()}` };
    setSessionHistory(prev => [newItem, ...prev]);
    syncToDB('/api/session-history', 'POST', newItem, `Logged session history`).then(runCloudBackup).catch(()=>{});

    const startTimeStr = newItem.startTime ? new Date(newItem.startTime).toISOString() : new Date().toISOString();
    const endTimeStr = newItem.endTime ? new Date(newItem.endTime).toISOString() : new Date().toISOString();

    supabase.from('session_history').insert([{
      ...newItem,
      startTime: startTimeStr,
      endTime: endTimeStr,
      orders: JSON.stringify(newItem.orders || [])
    }]).then();
  };

  const hashPassword = async (password: string) => {
    const msgBuffer = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const clearIdentity = () => {
    identityGeneration.current++;
    identityRef.current = null; authAccountRef.current = null;
    cmsGeneration.current++; cmsSnapshotRef.current = null;
    setSiteConfig(null); setPendingCmsSave(null); setCmsSaveError('');
    setIsInitializing(false); setIsLoggingOut(false); setLastSynced(null);
    setStaffLoggedIn(false); setAdminLoggedIn(false);
    setStaffProfile({ id: '', username: '', fullName: '', role: '', phone: '', joinedDate: '', isAdmin: false });
    setPendingReservationMoves([]);setReservationMoveError('Checking transfer recovery before assigning tables.');
    setPendingQueueOperations([]);setQueueOperationError('');
    setStaffUsers([]); setTables([]); setInventory([]); setReservations([]); setQueue([]); setSessionHistory([]); setActivities([]); setWatchlist([]); setLostItems([]); setFeedback([]);
    try {
      // Invalidate refund work before another cleanup can fail on blocked storage.
      clearRefundReturnDrafts(recoveryStorage.current);
      clearCloudPaymentDrafts(recoveryStorage.current);
      for (const key of ['oneshot_staff_auth', 'oneshot_admin_auth', 'oneshot_staff_profile', 'oneshot_auth_expiry', 'oneshot_is_locked']) recoveryStorage.current?.removeItem(key);
    } catch { /* Private UI is already cleared; blocked storage cannot retain authorization. */ }
  };
  useEffect(() => {
    const expired = () => { clearIdentity(); window.location.assign('/'); };
    window.addEventListener('oneshot-session-ended', expired);
    return () => window.removeEventListener('oneshot-session-ended', expired);
  }, []);
  const applyIdentity = (user: any, requiresPasswordChange = false) => {
    identityGeneration.current++;
    if (!user || typeof user.id !== 'string' || !user.id) { clearIdentity(); throw new Error('The signed-in account could not be verified.'); }
    const safeUser = { ...user }; delete safeUser.password; delete safeUser.recoveryPin;
    const fullAccess = !!user && !requiresPasswordChange;
    const next = fullAccess && typeof user.id === 'string' ? user.id : null;
    if (identityRef.current && identityRef.current !== next) clearIdentity();
    try {
      clearRefundReturnDrafts(recoveryStorage.current, next);
      if (!recoveryStorage.current) throw new Error('Recovery storage is unavailable.');
      recoveryStorage.current.setItem('oneshot_staff_auth', String(fullAccess));
      recoveryStorage.current.setItem('oneshot_admin_auth', String(fullAccess && !!user.isAdmin));
      recoveryStorage.current.setItem('oneshot_staff_profile', JSON.stringify(safeUser));
      recoveryStorage.current.setItem('oneshot_auth_expiry', String(Date.now() + 8 * 60 * 60 * 1000));
    } catch {
      clearIdentity();
      throw new Error('Keep this tab open and restore session storage before signing in. Ask an administrator to check any unconfirmed operation.');
    }
    identityRef.current = next; authAccountRef.current = user.id;
    setStaffProfile(safeUser);
    setStaffLoggedIn(fullAccess); setAdminLoggedIn(fullAccess && !!user.isAdmin);
    return identityGeneration.current;
  };
  const signIn = async (username: string, password: string) => {
    if (authMutationInFlight.current) throw new Error('An account change is already in progress. Wait for it to finish before signing in.');
    const mutation = Symbol('auth-mutation');
    authMutationInFlight.current = mutation;
    let epoch = ++identityGeneration.current;
    try {
      const result = await authRequest('login', { username, password });
      if (identityGeneration.current !== epoch) throw new Error('Sign-in was superseded. Review the current account before continuing.');
      epoch = applyIdentity(result.user, result.requiresPasswordChange);
      if (authMutationInFlight.current === mutation) authMutationInFlight.current = null;
      if (!result.requiresPasswordChange) await forceFullSync();
      if (identityGeneration.current !== epoch || authAccountRef.current !== result.user.id) throw new Error('The account changed during sign-in. Sign in again.');
      return result;
    } finally {
      if (authMutationInFlight.current === mutation) authMutationInFlight.current = null;
      if (identityGeneration.current === epoch) setIsInitializing(false);
    }
  };

  const staffLogin = async (u: string, p: string) => { try { const r = await signIn(u, p); return !r.requiresPasswordChange; } catch { return false; } };
  const adminLogin = async (u: string, p: string) => { try { const r = await signIn(u, p); return !r.requiresPasswordChange && !!r.user.isAdmin; } catch { return false; } };
  const changeOwnCredentials = async (payload: any) => {
    if (authMutationInFlight.current) throw new Error('An account change is already in progress. Wait for it to finish.');
    const owner = authAccountRef.current;
    if (!owner) throw new Error('Sign in before changing account credentials.');
    const mutation = Symbol('auth-mutation');
    authMutationInFlight.current = mutation;
    let epoch = ++identityGeneration.current;
    const isCurrent = () => identityGeneration.current === epoch && authAccountRef.current === owner;
    try {
      const result = await authRequest('change-password', payload);
      if (!isCurrent()) throw new Error('The account changed while saving credentials. Sign in again.');
      const identity = await authRequest('me');
      if (!isCurrent()) throw new Error('The account changed while saving credentials. Sign in again.');
      if (identity.user?.id !== owner) { clearIdentity(); throw new Error('The server account changed. Sign in again.'); }
      epoch = applyIdentity(identity.user, identity.requiresPasswordChange);
      if (authMutationInFlight.current === mutation) authMutationInFlight.current = null;
      if (!identity.requiresPasswordChange) await forceFullSync();
      if (!isCurrent()) throw new Error('The account changed while saving credentials. Sign in again.');
      return result;
    } finally {
      if (authMutationInFlight.current === mutation) authMutationInFlight.current = null;
      if (identityGeneration.current === epoch) setIsInitializing(false);
    }
  };

  const verifyPassword = async (password: string) => { try { await authRequest('verify', { password }); return true; } catch { return false; } };
  const staffLogout = async () => {
    if (authMutationInFlight.current) { toast.warning('An account change is already in progress. Wait for it to finish before signing out.'); return; }
    const mutation = Symbol('auth-mutation');
    authMutationInFlight.current = mutation;
    clearIdentity();
    const epoch = identityGeneration.current;
    setIsLoggingOut(true); setLogoutStep('Signing out...');
    try {
      await authRequest('logout', {});
      if (identityGeneration.current === epoch) window.location.assign('/');
    } catch {
      if (identityGeneration.current === epoch) toast.error('Sign-out could not reach the local server. Please retry before signing in on a shared device.');
    } finally {
      if (authMutationInFlight.current === mutation) authMutationInFlight.current = null;
      if (identityGeneration.current === epoch) setIsLoggingOut(false);
    }
  };

  const adminLogout = staffLogout;
  const resetStaffUserPassword = async (id: string) => {
    const password = window.prompt('Enter a unique temporary password (at least 8 characters). The user must change it at next login.');
    if (!password) throw new Error('Password reset cancelled.');
    await syncToDB(`/api/staff/${encodeURIComponent(id)}/reset-password`, 'POST', { newPassword: password }, 'Password reset');
    await forceFullSync();
  };
  const resetPasswordWithPin = async (username: string, pin: string, newPassword: string) => {
    try { await authRequest('recover', { username, recoveryPin: pin, newPassword }); return { success: true, message: 'Password saved. Sign in again.' }; }
    catch (error: any) { return { success: false, message: error.message }; }
  };

  const updateStaffProfile = (p: Partial<StaffProfile>) => {
    setStaffProfile(prev => {
      const updated = { ...prev, ...p };
      sessionStorage.setItem('oneshot_staff_profile', JSON.stringify(updated));
      return updated;
    });

  };

  const addTable = async (name: string) => {
    const newTable = { id: `t_${crypto.randomUUID()}`, name: name.trim(), status: 'available' as TableStatus, isActive: true };
    const saved = await syncToDB('/api/tables', 'POST', newTable, 'New table added');
    if (saved?.id !== newTable.id) throw new Error('Table creation was not confirmed. Refresh before retrying.');
    setTables(prev => [...prev.filter(table => table.id !== newTable.id), newTable]);
    addActivity('admin_action', `Added new table: ${newTable.name}`);
  };

  const updateTable = async (id: string, name: string) => {
    await updateTableState(id, { name: name.trim() });
    addActivity('admin_action', `Renamed table ID: ${id} to ${name.trim()}`);
  };

  const toggleTableActive = async (id: string) => {
    const table = tables.find(table => table.id === id);
    if (!table) throw new Error('Table was not found.');
    if (table.session || table.status === 'occupied') throw new Error('End the active session in the Staff Table Monitor before disabling this table.');
    await updateTableState(id, { isActive: !table.isActive });
    addActivity('admin_action', `Toggled active status for table ID: ${id}`);
  };

  const deleteTable = async (id: string) => {
    const table = tables.find(table => table.id === id);
    if (!table) throw new Error('Table was not found.');
    if (table.session || table.status === 'occupied') throw new Error('End the active session in the Staff Table Monitor before deleting this table.');
    if (pendingSessionChanges(localStorage).some(record => record.tableId === id || record.payload.targetId === id)) throw new Error('Resolve the pending session change first.');
    const saved = await syncToDB(`/api/tables/${encodeURIComponent(id)}`, 'DELETE', { expectedStatus: table.status, expectedSession: null }, 'Table deleted');
    if (saved?.id !== id) throw new Error('Table deletion was not confirmed. Refresh before retrying.');
    setTables(prev => prev.filter(table => table.id !== id));
    addActivity('admin_action', `Deleted table ID: ${id}`);
  };

  const addInventoryItem = async (i: Omit<InventoryItem, 'id'>) => {
    const id = `inv_${crypto.randomUUID()}`;
    const saved = await syncToDB('/api/inventory', 'POST', { ...i, id }, 'Inventory saved');
    if (saved?.id !== id) throw new Error('Inventory save was not confirmed.');
    setInventory(prev => [...prev, saved]);
    runCloudBackup();
    addActivity('admin_action', `Added new menu item: ${i.name}`);
  };

  const updateInventoryItem = async (id: string, updates: Partial<InventoryItem>, expectedStock?: number) => {
    const payload = updates.stock === undefined ? updates : { ...updates, expectedStock: expectedStock ?? inventory.find(item => item.id === id)?.stock };
    const saved = await syncToDB(`/api/inventory/${encodeURIComponent(id)}`, 'PUT', payload, 'Inventory saved');
    if (saved?.id !== id) throw new Error('Inventory update was not confirmed.');
    setInventory(prev => prev.map(item => item.id === id ? saved : item));
    runCloudBackup();
    addActivity('admin_action', `Updated menu item ID: ${id}`);
  };

  const deleteInventoryItem = async (id: string) => {
    const saved = await syncToDB(`/api/inventory/${encodeURIComponent(id)}`, 'DELETE', {}, 'Inventory deleted');
    if (saved?.id !== id) throw new Error('Inventory deletion was not confirmed.');
    setInventory(prev => prev.filter(item => item.id !== id));
    runCloudBackup();
    addActivity('admin_action', `Deleted menu item ID: ${id}`);
  };

  const addReservation = (i: Omit<Reservation, 'id'|'createdAt'>): string => {
    const id = Math.random().toString(36).substring(2, 8).toUpperCase();
    const newRes = { ...i, id, createdAt: new Date() };

    setReservations(prev => [...prev, newRes as Reservation]);
    addActivity('reservation_created', `New reservation created for ${i.customerName} (${id})`);

    syncToDB('/api/reservations', 'POST', newRes, `Reservation ${id} added`).then(runCloudBackup).catch(() => {});

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

  const updateReservationStatus = (id: string, status: ReservationStatus) => {
    setReservations(prev => prev.map(r => r.id === id ? { ...r, status } : r));
    syncToDB(`/api/reservations/${id}`, 'PUT', { status }, `Reservation status updated`).then(runCloudBackup).catch(()=>{});
    supabase.from('reservations').update({ status }).eq('id', id).then();
    addActivity('reservation_updated', `Reservation ${id} status updated to ${status}`);
  };

  const cancelReservation = (id: string, reason: string) => {
    setReservations(prev => prev.map(r => r.id === id ? { ...r, status: 'cancelled', cancellationReason: reason } : r));
    syncToDB(`/api/reservations/${id}`, 'PUT', { status: 'cancelled', cancellationReason: reason }, `Reservation cancelled`).then(runCloudBackup).catch(()=>{});
    supabase.from('reservations').update({
      status: 'cancelled',
      cancellation_reason: reason,
      cancellationreason: reason
    }).eq('id', id).then(({ error }) => {
      if (error) console.error("Supabase cancel error:", error);
    });
    addActivity('reservation_cancelled', `Reservation ${id} was cancelled. Reason: ${reason}`);
  };

  const updateDownPayment = (id: string, paid: boolean) => {
    setReservations(prev => prev.map(r => r.id === id ? { ...r, downPaymentPaid: paid } : r));
    syncToDB(`/api/reservations/${id}`, 'PUT', { downPaymentPaid: paid }, `Down payment updated`).then(runCloudBackup).catch(()=>{});
    supabase.from('reservations').update({ downPaymentPaid: paid ? 1 : 0 }).eq('id', id).then();
    if (paid) addActivity('payment_received', `Down payment recorded for reservation ${id}`);
  };

  const updateBalance = (id: string, paid: boolean) => {
    setReservations(prev => prev.map(r => r.id === id ? { ...r, balancePaid: paid } : r));
    syncToDB(`/api/reservations/${id}`, 'PUT', { balancePaid: paid }, `Balance updated`).then(runCloudBackup).catch(()=>{});
    supabase.from('reservations').update({ balancePaid: paid ? 1 : 0 }).eq('id', id).then();
    if (paid) addActivity('payment_received', `Remaining balance settled for reservation ${id}`);
  };

  const updateRefundStatus = (id: string, refundStatus: string, method?: string, notes?: string) => {
    setReservations(prev => prev.map(r => r.id === id ? { ...r, refundStatus: refundStatus as any, refundMethod: method as any, refundNotes: notes } as Reservation : r));
    const payload = { refundStatus, refundMethod: method, refundNotes: notes };
    syncToDB(`/api/reservations/${id}`, 'PUT', payload, `Refund status updated`).then(runCloudBackup).catch(()=>{});
    supabase.from('reservations').update({ refundStatus: refundStatus, refundMethod: method, refundNotes: notes }).eq('id', id).then();
    addActivity('reservation_updated', `Refund for ${id} marked as ${refundStatus}`);
  };

  const acknowledgeRefund = (id: string) => {
    setReservations(prev => prev.map(r => r.id === id ? { ...r, refundStatus: 'acknowledged' } as Reservation : r));
    syncToDB(`/api/reservations/${id}`, 'PUT', { refundStatus: 'acknowledged' }, `Refund acknowledged`).then(runCloudBackup).catch(()=>{});
    supabase.from('reservations').update({ refundStatus: 'acknowledged' }).eq('id', id).then();
  };

  const updateReservation = (id: string, u: Partial<Reservation>) => {
    setReservations(prev => prev.map(r => r.id === id ? { ...r, ...u } : r));
    syncToDB(`/api/reservations/${id}`, 'PUT', u, `Reservation updated`).then(runCloudBackup).catch(()=>{});

    const dbUpdates: any = {};
    if (u.date) dbUpdates.date = new Date(u.date).toISOString();
    if (u.timeSlot) dbUpdates.timeSlot = u.timeSlot;
    if (u.durationHours) dbUpdates.durationHours = u.durationHours;
    if (u.partySize) dbUpdates.partySize = u.partySize;
    if (u.status) dbUpdates.status = u.status;
    if (u.tableId !== undefined) dbUpdates.tableId = u.tableId;
    if (u.cancellationReason !== undefined) {
      dbUpdates.cancellation_reason = u.cancellationReason;
      dbUpdates.cancellationreason = u.cancellationReason;
    }
    if (u.downPaymentPaid !== undefined) dbUpdates.downPaymentPaid = u.downPaymentPaid ? 1 : 0;
    if (u.balancePaid !== undefined) dbUpdates.balancePaid = u.balancePaid ? 1 : 0;

    supabase.from('reservations').update(dbUpdates).eq('id', id).then(({error}) => {
      if (error) console.error("Supabase Reschedule/Void Error:", error);
    });
    addActivity('reservation_updated', `Reservation ${id} details were updated`);
  };

  const addFeedback = (i: Omit<Feedback, 'id'|'date'>) => {
    const newFeedback = { ...i, id: `f${Date.now()}`, date: new Date() };
    setFeedback(prev => [newFeedback as Feedback, ...prev]);
    syncToDB('/api/feedback', 'POST', newFeedback, "New customer feedback").then(runCloudBackup).catch(()=>{});
    const { rating, ...supabasePayload } = newFeedback;
    supabase.from('feedback').insert([supabasePayload]).then();
  };
  const [pendingContentCreates,setPendingContentCreates]=useState<any[]>([]);
  const [contentCreateError,setContentCreateError]=useState('');
  const refreshContentCreates=()=>{
    const owner=identityRef.current;
    if(!owner||owner!==staffProfile.id||!staffProfile.isAdmin){setPendingContentCreates([]);setContentCreateError('');return;}
    try{setPendingContentCreates(readContentCreates(localStorage,owner));setContentCreateError('');}
    catch{setPendingContentCreates([]);setContentCreateError('Saved create recovery is unavailable. Restore local storage before creating content.');}
  };
  useEffect(refreshContentCreates,[staffProfile.id,staffProfile.isAdmin]);
  const persistContentCreate=async(kind:string,payload:any,retry=false)=>{
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch&&owner===staffProfile.id&&staffProfile.isAdmin===true;
    if(!isCurrent())throw new Error('Administrator sign-in is required.');
    let recoveryPending=false;
    try{
      const result=await saveContentCreate({storage:localStorage,ownerId:owner,kind,payload,retry,isCurrent,request:(endpoint:string,command:any)=>syncToDB(endpoint,'POST',command,'Created content locally')});
      if(!isCurrent())throw new Error('Account changed. Reload saved records.');
      recoveryPending=result.recoveryPending;
      if(kind==='promo')setPromoCodes(prev=>isCurrent()?[...prev.filter(p=>p.id!==result.record.id),result.record]:prev);
      else setAnnouncements(prev=>isCurrent()?[result.record,...prev.filter(a=>a.id!==result.record.id)]:prev);
      addActivity('admin_action',`Confirmed local ${kind} create: ${result.record.id}`);
      runCloudBackup();return result.record;
    }catch(error){
      if((error as any)?.code==='CONTENT_CREATE_RECONCILE'&&isCurrent()){
        try{const response=await localFetch(`http://localhost:3001/api/${kind==='promo'?'promo-codes':'announcements'}`);const rows=response.ok?await response.json():null;
          if(Array.isArray(rows)&&isCurrent()){if(kind==='promo')setPromoCodes(prev=>isCurrent()?rows:prev);else setAnnouncements(prev=>isCurrent()?rows:prev);}
        }catch{/* Keep existing records if the reconciliation refresh is unavailable. */}
      }
      throw error;
    }finally{if(isCurrent()){refreshContentCreates();if(recoveryPending)setContentCreateError('Saved record confirmed. Recovery cleanup or a replacement pending request still needs review. Retry only its saved original.');}}
  };
  const retryContentCreate=(kind:string)=>persistContentCreate(kind,null,true);
  const resolveFeedback = async (id: string, notes: string) => {
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch&&owner===staffProfile.id&&staffProfile.isAdmin===true;
    if(!isCurrent()) throw new Error('Administrator sign-in is required to resolve feedback.');
    const savedNotes=notes.trim();
    if(!savedNotes || savedNotes.length>2000) throw new Error('Resolution notes must contain 1–2000 characters.');
    const saved=await syncToDB(`/api/feedback/${encodeURIComponent(id)}`, 'PUT', { status: 'resolved', notes: savedNotes, expectedActorId: owner }, 'Feedback resolved locally');
    if(!isCurrent()) throw new Error('Account changed. Reload saved feedback before continuing.');
    if(!saved || typeof saved!=='object' || Array.isArray(saved) || Object.keys(saved).length!==3 || saved.id!==id || saved.status!=='resolved' || saved.notes!==savedNotes) throw new Error('Feedback save could not be confirmed. Reload before retrying.');
    setFeedback(prev => isCurrent() ? prev.map(f => f.id === id ? { ...f, status: 'resolved', notes: savedNotes } : f) : prev);
    addActivity('admin_action', `Resolved local feedback message ID: ${id}`);
    runCloudBackup();
  };

  const addPromoCode = async (i:Omit<PromoCode,'id'|'createdAt'|'usageCount'>):Promise<string> => (await persistContentCreate('promo',i)).id;

  const updatePromoCode = async (id: string, u: Partial<Omit<PromoCode, 'id'|'createdAt'|'usageCount'>>) => {
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch;
    if(!isCurrent()) throw new Error('Sign in before saving local content.');
    const update = { ...u, ...(u.code !== undefined ? { code: u.code.trim().toUpperCase() } : {}) };
    await syncToDB(`/api/promo-codes/${encodeURIComponent(id)}`, 'PUT', update, 'Updated promo locally');
    if(!isCurrent()) throw new Error('Account changed. Reload the saved records before continuing.');
    setPromoCodes(prev => isCurrent() ? prev.map(p => p.id === id ? { ...p, ...update } : p) : prev);
    addActivity('admin_action', `Updated local promo code ID: ${id}`);
    runCloudBackup();
  };

  const togglePromoCode = async (id: string) => {
    const target = promoCodes.find(p => p.id === id);
    if (!target) throw new Error('Promo no longer exists. Reload saved records.');
    await updatePromoCode(id, { isActive: !target.isActive });
  };

  const deletePromoCode = async (id: string) => {
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch;
    if(!isCurrent()) throw new Error('Sign in before saving local content.');
    await syncToDB(`/api/promo-codes/${encodeURIComponent(id)}`, 'DELETE', {}, 'Deleted promo locally');
    if(!isCurrent()) throw new Error('Account changed. Reload the saved records before continuing.');
    setPromoCodes(prev => isCurrent() ? prev.filter(p => p.id !== id) : prev);
    addActivity('admin_action', `Deleted local promo code ID: ${id}`);
    runCloudBackup();
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

  const addStaffUser = async (u: Omit<StaffUser, 'id'|'createdAt'>) => {
    const id = `su_${crypto.randomUUID()}`;
    const newUser = { ...u, username: u.username.trim(), fullName: u.fullName.trim(), id, createdAt: new Date() };
    const { createdAt, ...accountPayload } = newUser;
    const saved = await syncToDB('/api/staff', 'POST', accountPayload, 'Added staff user');
    if (saved?.id !== id) throw new Error('Staff account save was not confirmed.');
    const publicUser = saved.user;
    if (!publicUser || publicUser.password || publicUser.recoveryPin) throw new Error('Invalid staff acknowledgement.');
    setStaffUsers(prev => [...prev.filter(user => user.id !== id), publicUser]);
    addActivity('admin_action', `Created new staff user: ${newUser.username}`);
    return publicUser;
  };

  const updateStaffUser = async (id: string, u: Partial<StaffUser>) => {
    const targetUser = staffUsers.find(user => user.id === id);
    const saved = await syncToDB(`/api/staff/${encodeURIComponent(id)}`, 'PUT', u, 'Updated staff user');
    if (saved?.id !== id) throw new Error('Staff account update was not confirmed.');
    const publicUser = saved.user;
    setStaffUsers(prev => prev.map(user => user.id === id ? publicUser : user));
    if (staffProfile.id === id) {
      setStaffProfile(prev => {
        const updated = { ...prev, ...publicUser };
        sessionStorage.setItem('oneshot_staff_profile', JSON.stringify(updated));
        return updated;
      });
    }
    addActivity('admin_action', `Updated details for: ${targetUser?.fullName || id}`);
  };

  const toggleStaffUserActive = (id: string) => {
    const target = staffUsers.find(user => user.id === id);
    if (target) void updateStaffUser(id, { isActive: !target.isActive }).catch(() => toast.error('Could not change staff status.'));
  };

  const savePolicySettings = async (r: Partial<RatesConfig>, t: Partial<ReservationTerms>, revision: string) => {
    const owner = identityRef.current, epoch = identityGeneration.current;
    const isCurrent = () => !!owner && identityRef.current === owner && identityGeneration.current === epoch;
    if (!owner || owner !== staffProfile.id || !staffProfile.isAdmin) throw new Error('Administrator sign-in is required.');
    const response = await localFetch('http://localhost:3001/api/settings/policy', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedActorId: owner, expectedRevision: revision, rates: r, terms: t }),
    });
    const saved = await response.json();
    if (!isCurrent()) throw new Error('The account changed. Reload saved settings before continuing.');
    if (!response.ok) throw new Error(saved.error || 'Policy save was not confirmed. Reload saved settings before retrying.');
    const matches = (expected: any, actual: any) => actual && Object.entries(expected).every(([key, value]) => actual[key] === value);
    if (saved.actorId !== owner || !/^[a-f0-9]{64}$/.test(saved.revision || '') || !matches(r, saved.settings?.rates) || !matches(t, saved.settings?.terms)) {
      throw new Error('The saved policy acknowledgement did not match. Reload saved settings before retrying.');
    }
    setRates(prev => isCurrent() ? ({ ...prev, ...saved.settings.rates }) : prev);
    setReservationTerms(prev => isCurrent() ? ({ ...prev, ...saved.settings.terms }) : prev);
    addActivity('admin_action', 'System rates and reservation terms saved together locally');
    return saved;
  };

  const addAnnouncement = async (a:Omit<Announcement,'id'|'createdAt'>)=>{await persistContentCreate('announcement',a);};

  const updateAnnouncement = async (id: string, u: Partial<Announcement>) => {
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch;
    if(!isCurrent()) throw new Error('Sign in before saving local content.');
    await syncToDB(`/api/announcements/${encodeURIComponent(id)}`, 'PUT', u, 'Updated announcement locally');
    if(!isCurrent()) throw new Error('Account changed. Reload the saved records before continuing.');
    setAnnouncements(prev => isCurrent() ? prev.map(a => a.id === id ? { ...a, ...u } : a) : prev);
    addActivity('admin_action', `Updated local announcement ID: ${id}`);
    runCloudBackup();
  };

  const deleteAnnouncement = async (id: string) => {
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch;
    if(!isCurrent()) throw new Error('Sign in before saving local content.');
    await syncToDB(`/api/announcements/${encodeURIComponent(id)}`, 'DELETE', {}, 'Deleted announcement locally');
    if(!isCurrent()) throw new Error('Account changed. Reload the saved records before continuing.');
    setAnnouncements(prev => isCurrent() ? prev.filter(a => a.id !== id) : prev);
    addActivity('admin_action', `Deleted local announcement ID: ${id}`);
    runCloudBackup();
  };

  const toggleAnnouncement = async (id: string) => {
    const target = announcements.find(a => a.id === id);
    if (!target) throw new Error('Announcement no longer exists. Reload saved records.');
    await updateAnnouncement(id, { isActive: !target.isActive });
  };

  const [pendingVenueCreates,setPendingVenueCreates]=useState<any[]>([]);
  const [venueCreateError,setVenueCreateError]=useState('');
  const refreshVenueCreates=()=>{
    const owner=identityRef.current;
    if(!owner||owner!==staffProfile.id||!staffProfile.isAdmin){setPendingVenueCreates([]);setVenueCreateError('');return;}
    try{setPendingVenueCreates(readVenueCreates(localStorage,owner));setVenueCreateError('');}
    catch{setPendingVenueCreates([]);setVenueCreateError('Saved calendar recovery is unavailable. Restore local storage before creating a calendar record.');}
  };
  useEffect(refreshVenueCreates,[staffProfile.id,staffProfile.isAdmin]);
  const refreshVenueRecords=async(kind:string,isCurrent:()=>boolean)=>{
    const response=await localFetch(`http://localhost:3001/api/${kind==='closure'?'closed-dates':'events'}`);
    if(!response.ok)throw new Error('The saved local calendar could not be refreshed.');
    const rows=await response.json();if(!Array.isArray(rows))throw new Error('The saved local calendar could not be verified.');
    const records=rows.map(row=>validateVenueRecord(kind,row));
    if(!isCurrent())throw new Error('Administrator account changed. Reload the saved calendar.');
    if(kind==='closure')setClosedDates(prev=>isCurrent()?records:prev);else setEvents(prev=>isCurrent()?records:prev);
  };
  const persistVenueCreate=async(kind:string,payload:any,retry=false)=>{
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch&&owner===staffProfile.id&&staffProfile.isAdmin===true;
    if(!isCurrent())throw new Error('Administrator sign-in is required.');
    let recoveryPending=false;
    try{
      const result=await saveVenueCreate({storage:localStorage,ownerId:owner,kind,payload,retry,isCurrent,request:(endpoint:string,command:any)=>syncToDB(endpoint,'POST',command,'Calendar record saved locally')});
      if(!isCurrent())throw new Error('Account changed. Reload the saved calendar.');
      recoveryPending=result.recoveryPending;
      if(kind==='closure')setClosedDates(prev=>isCurrent()?[...prev.filter(row=>row.id!==result.record.id),result.record]:prev);
      else setEvents(prev=>isCurrent()?[...prev.filter(row=>row.id!==result.record.id),result.record]:prev);
      addActivity('admin_action',`Confirmed local ${kind} create: ${result.record.id}`);
      return result.record;
    }catch(error){
      if((error as any)?.code==='VENUE_CREATE_RECONCILE'&&isCurrent())try{await refreshVenueRecords(kind,isCurrent);}catch{/* Keep previous saved state when refresh cannot be confirmed. */}
      throw error;
    }finally{if(isCurrent()){refreshVenueCreates();if(recoveryPending)setVenueCreateError('Calendar save confirmed. Recovery cleanup or a replacement pending request still needs review. Retry only its saved original.');}}
  };
  const retryVenueCreate=(kind:string)=>persistVenueCreate(kind,null,true);
  const mutateVenueRecord=async(kind:string,id:string,patch:any,original:any,remove=false)=>{
    const owner=identityRef.current,epoch=identityGeneration.current;
    const isCurrent=()=>!!owner&&!authMutationInFlight.current&&identityRef.current===owner&&identityGeneration.current===epoch&&owner===staffProfile.id&&staffProfile.isAdmin===true;
    if(!isCurrent())throw new Error('Administrator sign-in is required.');
    const expectedRecord=validateVenueRecord(kind,original);if(expectedRecord.id!==id)throw new Error('Reopen the saved calendar record before editing.');
    const normalized=remove?null:normalizeVenuePayload(kind,Object.fromEntries(Object.entries({...expectedRecord,...patch}).filter(([key])=>key!=='id'&&key!=='createdAt')));
    try{
      const saved=await syncToDB(`/api/${kind==='closure'?'closed-dates':'events'}/${encodeURIComponent(id)}`,remove?'DELETE':'PUT',{expectedActorId:owner,expectedRecord,...(remove?{}:{patch})},'Calendar change saved locally');
      if(!isCurrent())throw new Error('Administrator account changed. Reload the saved calendar.');
      if(remove){if(!venueExact(saved,['id','deleted'])||saved.id!==id||saved.deleted!==true)throw new Error('Calendar deletion was not confirmed.');}
      else{if(!venueExact(saved,['id','record'])||saved.id!==id)throw new Error('Calendar edit was not confirmed.');const record=validateVenueRecord(kind,saved.record);if(record.id!==id||Object.keys(normalized).some(key=>venueCanonical(record[key])!==venueCanonical(normalized[key]))||(kind==='event'&&record.createdAt!==expectedRecord.createdAt))throw new Error('Saved calendar record did not match the reviewed change.');}
      const apply=(rows:any[])=>!isCurrent()?rows:remove?rows.filter(row=>row.id!==id):rows.map(row=>row.id===id?saved.record:row);
      if(kind==='closure')setClosedDates(apply);else setEvents(apply);
      addActivity('admin_action',`Confirmed local ${kind} ${remove?'deletion':'edit'}: ${id}`);
    }catch(error){
      if(isCurrent())try{await refreshVenueRecords(kind,isCurrent);}catch{/* Preserve prior state when a failed write cannot be reconciled. */}
      throw new Error((error instanceof Error?error.message:'Calendar change is unconfirmed.')+' Reopen the saved record to reconcile before making another change.');
    }
  };
  const addClosedDate = async(c:Omit<ClosedDate,'id'>)=>(await persistVenueCreate('closure',c)).id;
  const removeClosedDate=async(id:string,expectedRecord?:any)=>mutateVenueRecord('closure',id,null,expectedRecord||closedDates.find(row=>row.id===id),true);
  const updateClosedDate=async(id:string,u:Partial<ClosedDate>,expectedRecord?:any)=>mutateVenueRecord('closure',id,u,expectedRecord||closedDates.find(row=>row.id===id));
  const addEvent=async(e:Omit<Event,'id'>)=>(await persistVenueCreate('event',e)).id;
  const updateEvent=async(id:string,u:Partial<Omit<Event,'id'>>,expectedRecord?:any)=>mutateVenueRecord('event',id,u,expectedRecord||events.find(row=>row.id===id));
  const deleteEvent=async(id:string,expectedRecord?:any)=>mutateVenueRecord('event',id,null,expectedRecord||events.find(row=>row.id===id),true);

  // CMS saves retain the original request until both its commit and current images are verified.
  const refreshCmsRecovery = () => {
    const owner = identityRef.current;
    if (!owner || owner !== staffProfile.id || !staffProfile.isAdmin) { setPendingCmsSave(null); setCmsSaveError(''); return; }
    try { setPendingCmsSave(readPendingCmsSave(localStorage, owner)); setCmsSaveError(''); }
    catch { setPendingCmsSave(null); setCmsSaveError('CMS recovery storage is unavailable. Restore it before saving images.'); }
  };
  useEffect(refreshCmsRecovery, [staffProfile.id, staffProfile.isAdmin]);
  const refreshCmsConfig = async () => {
    const owner = identityRef.current, epoch = identityGeneration.current;
    const isCurrent = () => !!owner && !authMutationInFlight.current && identityRef.current === owner && identityGeneration.current === epoch && owner === staffProfile.id && staffProfile.isAdmin === true;
    if (!isCurrent()) throw new Error('Administrator sign-in is required.');
    if (cmsInFlight.current) throw new Error('Wait for the current image save to finish before reloading.');
    const refresh = ++cmsGeneration.current;
    const response = await localFetch('http://localhost:3001/api/cms');
    if (!response.ok) throw new Error('Saved local images could not be reloaded. Your draft is kept.');
    const snapshot = validateCmsSnapshot(await response.json());
    const canApply = () => isCurrent() && cmsGeneration.current === refresh && !cmsInFlight.current;
    if (!canApply()) throw new Error('Image reload was superseded. Reload the current saved section.');
    cmsSnapshotRef.current = snapshot;
    setSiteConfig((prev: any) => canApply() ? snapshot.record : prev);
    refreshCmsRecovery();
    return snapshot;
  };
  const persistCmsConfig = async (patch: any, retry = false) => {
    const owner = identityRef.current, epoch = identityGeneration.current;
    const isCurrent = () => !!owner && !authMutationInFlight.current && identityRef.current === owner && identityGeneration.current === epoch && owner === staffProfile.id && staffProfile.isAdmin === true;
    if (!isCurrent()) throw new Error('Administrator sign-in is required.');
    if (cmsInFlight.current) throw new Error('A CMS save is already being checked. Wait before retrying.');
    cmsInFlight.current = true; cmsGeneration.current++;
    let recoveryPending = false;
    const applySnapshot = (snapshot: any) => { if (!isCurrent()) throw new Error('Administrator account changed. Reload saved images.'); cmsSnapshotRef.current = snapshot; setSiteConfig((prev: any) => isCurrent() ? snapshot.record : prev); };
    try {
      const result = await saveCmsConfig({storage: localStorage, ownerId: owner, revision: cmsSnapshotRef.current?.revision, patch, retry, isCurrent,
        request: (command: any) => syncToDB('/api/cms', 'PUT', command, 'Image settings saved locally'),
        read: async () => { const response = await localFetch('http://localhost:3001/api/cms'); if (!response.ok) throw new Error('Saved images could not be refreshed. Recover the original save before editing.'); return await response.json(); }
      });
      applySnapshot({record: result.record, revision: result.revision});
      recoveryPending = result.recoveryPending;
      return result;
    } catch (error) {
      if ((error as any)?.code === 'CMS_REVIEW_REQUIRED' && isCurrent()) applySnapshot((error as any).snapshot);
      throw error;
    } finally {
      cmsGeneration.current++; cmsInFlight.current = false;
      if (isCurrent()) { refreshCmsRecovery(); if (recoveryPending) setCmsSaveError('Image save confirmed, but recovery cleanup needs review. Retry only its saved original.'); }
    }
  };
 const updateSiteConfig = (patch: any) => persistCmsConfig(patch);
  const retryCmsSave = () => persistCmsConfig(null, true);

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
      tables, queue, reservations, feedback, activities, promoCodes, staffUsers, inventory, rates, reservationTerms, announcements, closedDates, weather, updateWeatherLocation,
      activeAnnouncement, updateActiveAnnouncement,
      signIn, changeOwnCredentials, verifyPassword, staffLoggedIn, adminLoggedIn, staffProfile,
      staffLogin, staffLogout, adminLogin, adminLogout, updateStaffProfile,
      pendingReservationMoves,reservationMoveError,heldTableIds,availableTables,recoverReservationTransfer,refreshReservationTransfers,
      checkoutTable, updateTableState, assignTable, freeTable, reserveTable, extendSession, migrateSession, setTableMaintenance, setTableEvent, addTable, updateTable, toggleTableActive, deleteTable,
      addInventoryItem, updateInventoryItem, deleteInventoryItem, submitTableOrders, voidTableOrder, retryPendingOrder,
      addToQueue, removeFromQueue, callQueueItem, seatQueueCustomer, pendingQueueOperations, queueOperationError, retryPendingQueueOperation,
      addReservation, updateReservationStatus, updateReservation, cancelReservation, updateDownPayment, updateBalance,
      pendingContentCreates: pendingContentCreates.filter(item=>item.ownerId===staffProfile.id), contentCreateError, retryContentCreate,
      addFeedback, resolveFeedback, addActivity, addPromoCode, updatePromoCode, togglePromoCode, deletePromoCode, applyPromoCode,
      events, addEvent, updateEvent, deleteEvent,
      addStaffUser, updateStaffUser, resetStaffUserPassword, toggleStaffUserActive,
      savePolicySettings, addAnnouncement, updateAnnouncement, deleteAnnouncement, toggleAnnouncement, pendingVenueCreates, venueCreateError, retryVenueCreate, addClosedDate, removeClosedDate, updateClosedDate, siteConfig, updateSiteConfig, pendingCmsSave, cmsSaveError, retryCmsSave, refreshCmsConfig, refreshLiveMonitor,
      lostItems, addLostItem, updateLostItem, deleteLostItem,
      watchlist, addWatchlistItem, updateWatchlistItem, deleteWatchlistItem, sessionHistory, addSessionHistory, resetPasswordWithPin, isSystemOffline,
      hashPassword,
      theme, primaryColor, updateTheme, updatePrimaryColor,
      updateRefundStatus, acknowledgeRefund,
      isLoggingOut, logoutStep,
      lastSynced, forceFullSync
    }}>
      {/* 🟢 Global Fullscreen Logout Overlay with Thread Loader */}
      {isLoggingOut && (
        <div className="fixed inset-0 z-[99999] bg-neutral-950/90 backdrop-blur-md flex flex-col items-center justify-center animate-fade-in">
          <div className="relative w-16 h-16 mb-5">
            <div className="absolute inset-0 border-4 border-neutral-800 rounded-full"></div>
            <div className="absolute inset-0 border-4 border-emerald-500 rounded-full border-t-transparent animate-spin"></div>
          </div>
          <h2 className="text-lg font-black text-white uppercase tracking-widest mb-1">
            Safeguarding Venue Records
          </h2>
          <p className="text-xs text-emerald-400 font-semibold uppercase tracking-wider animate-pulse">
            {logoutStep}
          </p>
        </div>
      )}

      {children}

    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (context === undefined) throw new Error('useAppContext must be used within an AppProvider');
  return context;
}
