import { useState, useEffect, useRef } from 'react';
import { useAppContext, HOURLY_RATE, SessionOrder } from '../context/AppContext';
import { TableCard } from '../components/TableCard';
import {
  Search, Play, Zap, X, UserPlus, Clock,
  Calendar, Users, CheckCircle, ChevronRight,
  CreditCard, Banknote, AlertTriangle, CircleCheck,
  ShoppingCart, Plus, Minus, Trash2, Lock, Edit2, History, Info, RefreshCw, ArrowRightLeft,
  QrCode, FileText
} from 'lucide-react';
import { isToday, differenceInSeconds, addMinutes, isSameDay, format } from 'date-fns';

type FilterStatus = 'all' | 'available' | 'occupied' | 'reserved' | 'maintenance';
type PaymentMethod = 'gcash' | 'cash';
type PaymentStatus = 'paid' | 'partial' | 'unpaid';

const formatPHP = (amount: any) => `₱${(Number(amount) || 0).toFixed(2)}`;

type CustomerSource =
  | { kind: 'queue'; id: string; name: string; partySize: number; contact: string; notes?: string }
  | { kind: 'reservation'; id: string; name: string; partySize: number; contact: string; durationHours: number; timeSlot: string };

export function Tables() {
  const { 
    tables, queue, reservations, assignTable, extendSession, migrateSession, freeTable, 
    inventory, submitTableOrders, voidTableOrder, addInventoryItem, updateInventoryItem, 
    staffProfile, rates, reservationTerms, staffUsers, hashPassword,
    addSessionHistory, addActivity, addWatchlistItem,
    removeFromQueue, updateReservationStatus, forceFullSync
  } = useAppContext() as any;
  
  const [filter, setFilter]       = useState<FilterStatus>('all');
  const [search, setSearch]       = useState('');
  const [assigningTableId, setAssigningTableId] = useState<string | null>(null);
  const [extendingTableId, setExtendingTableId] = useState<string | null>(null);
  const [endingTableId,    setEndingTableId]    = useState<string | null>(null);
  
  const [posTableId,       setPosTableId]       = useState<string | null>(null);
  const [posCart,          setPosCart]          = useState<SessionOrder[]>([]);
  const [voidItem,         setVoidItem]         = useState<{ index: number, order: SessionOrder } | null>(null);
  const [voidPassword,     setVoidPassword]     = useState('');
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
  const [dismissedNearEnd, setDismissedNearEnd] = useState<Set<string>>(new Set());
  
  const [useProrated,      setUseProrated]      = useState(false);

  const [completedReceipt, setCompletedReceipt] = useState<any | null>(null);
  const [viewingLiveReceiptId, setViewingLiveReceiptId] = useState<string | null>(null); // 🟢 NEW STATE

  // Migrate Session States
  const [migratingTableId, setMigratingTableId] = useState<string | null>(null);
  const [migrateTargetId,  setMigrateTargetId]  = useState<string>('');
  
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

  // 🟢 Admin Authorization Modal States for Session Voids
  const [showVoidModal,       setShowVoidModal]       = useState(false);
  const [sessionVoidPassword, setSessionVoidPassword] = useState('');
  const [voidReason,          setVoidReason]          = useState('Accidental booking / under 5 mins');
  const [voidError,           setVoidError]           = useState('');

  // Menu Editing States
  const isAdmin = staffProfile?.isAdmin || staffProfile?.role?.toLowerCase() === 'manager' || staffProfile?.role?.toLowerCase() === 'super admin' || staffProfile?.username === 'superadmin' || staffProfile?.username === 'admin';
  const [isEditingMenu, setIsEditingMenu] = useState(false);
  const [editingItem, setEditingItem] = useState<any | null>(null);
  const [newItemForm, setNewItemForm] = useState({ name: '', category: 'Drinks', price: 0, stock: 0 });

  // Assign form state
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSource | null>(null);
  const [customerName,     setCustomerName]      = useState('');
  const [durationMinutes,  setDurationMinutes]   = useState<number | 'open'>(60);
  const [amountPaid,       setAmountPaid]        = useState('');
  const [paymentOption,    setPaymentOption]     = useState<'payNow' | 'payLater'>('payNow');

  // Extend form state
  const [extendMinutes,       setExtendMinutes]       = useState<number | 'open'>(60);
  const [extendPayStatus,     setExtendPayStatus]     = useState<PaymentStatus>('paid');
  const [extendPayMethod,     setExtendPayMethod]     = useState<PaymentMethod>('cash');
  const [extendPartialAmount, setExtendPartialAmount] = useState('');
  const [extendCashTendered,  setExtendCashTendered]  = useState('');
  const [extendGcashRef,      setExtendGcashRef]      = useState('');

  // End session payment state
  const [endPayStatus,     setEndPayStatus]     = useState<PaymentStatus>('paid');
  const [endPayMethod,     setEndPayMethod]     = useState<PaymentMethod>('cash');
  const [endPartialAmount, setEndPartialAmount] = useState('');
  const [endCashTendered,  setEndCashTendered]  = useState('');
  const [endGcashRef,      setEndGcashRef]      = useState('');
  const [debtName,         setDebtName]         = useState('');
  const [debtContact,      setDebtContact]      = useState('');

  const [showArchivedMenu, setShowArchivedMenu] = useState(false);
  const displayTables = tables.map((t: any) => 
    !t.isActive ? { ...t, status: 'maintenance', maintenanceReason: t.maintenanceReason || 'Deactivated (Admin)' } : t
  );
  const activeTables = tables.filter((t: any) => t.isActive);
  const available    = activeTables.filter((t: any) => t.status === 'available').length;
  const occupied     = activeTables.filter((t: any) => t.status === 'occupied').length;
  const reserved     = activeTables.filter((t: any) => t.status === 'reserved').length;
  const maintenance  = activeTables.filter((t: any) => t.status === 'maintenance').length;

  const filtered = displayTables.filter((t: any) => {
    const matchFilter = filter === 'all' || t.status === filter;
    const matchSearch = !search
      || t.name.toLowerCase().includes(search.toLowerCase())
      || (t.session?.customerName?.toLowerCase().includes(search.toLowerCase()));
    return matchFilter && matchSearch;
  });

  const nearEndTables = displayTables.filter((t: any) => {
    if (t.status !== 'occupied' || !t.session || t.session.isOpenTime) return false;
    const endTime = addMinutes(new Date(t.session.startTime), t.session.durationMinutes);
    const secsLeft = differenceInSeconds(endTime, new Date());
    return secsLeft > 0 && secsLeft <= 10 * 60;
  });

  const waitingCustomers: CustomerSource[] = queue
    .filter((q: any) => q.status === 'waiting' || q.status === 'called')
    .map((q: any) => ({ kind: 'queue', id: q.id, name: q.customerName, partySize: q.partySize, contact: q.contactNumber, notes: q.notes }));

  const todayReservations: CustomerSource[] = reservations
    .filter((r: any) => (r.status === 'confirmed' || r.status === 'pending') && isToday(new Date(r.date)))
    .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map((r: any) => ({ kind: 'reservation', id: r.id, name: r.customerName, partySize: r.partySize, contact: r.contactNumber, durationHours: r.durationHours, timeSlot: r.timeSlot }));

  const allCustomers: CustomerSource[] = [...waitingCustomers, ...todayReservations];

  const endingTable = tables.find((t: any) => t.id === endingTableId);
  const getEndSessionInfo = () => {
    if (!endingTable?.session) return null;
    const { startTime, durationMinutes: bookedMins, amountPaid: alreadyPaid, hourlyRate, orders = [], isOpenTime } = endingTable.session;
    const now = new Date();
    const elapsedSecs = differenceInSeconds(now, new Date(startTime));
    const elapsedMins = Math.ceil(elapsedSecs / 60);
    
    let bookedCharge = 0;
    let overtimeCharge = 0;
    let isOvertime = false;
    let overtimeMins = 0;

    const calculateBasedOnElapsed = isOpenTime || bookedMins === null || useProrated;

    if (calculateBasedOnElapsed) {
      const minElapsed = Math.max(60, elapsedMins);
      const fullHours = Math.floor(minElapsed / 60);
      const remainingMins = minElapsed % 60;
      
      let extraCharge = 0;
      if (remainingMins > 0 && remainingMins <= 30) extraCharge = hourlyRate / 2;
      else if (remainingMins > 30) extraCharge = hourlyRate;

      bookedCharge = (fullHours * hourlyRate) + extraCharge;
    } else {
      const endTime = addMinutes(new Date(startTime), bookedMins);
      isOvertime = now > endTime;
      overtimeMins = isOvertime ? Math.ceil(differenceInSeconds(now, endTime) / 60) : 0;
      bookedCharge = (bookedMins / 60) * hourlyRate;
      overtimeCharge = (overtimeMins / 60) * hourlyRate;
    }
    
    const posOrdersTotal = orders.reduce((sum: number, o: any) => sum + (o.price * o.qty), 0);
    const totalDue = bookedCharge + overtimeCharge + posOrdersTotal;
    const balance = Math.max(0, totalDue - alreadyPaid);
    const refundDue = Math.max(0, alreadyPaid - totalDue); 
    
    return { elapsedMins, alreadyPaid, bookedCharge, overtimeCharge, posOrdersTotal, totalDue, balance, refundDue, isOvertime, overtimeMins, isOpenTime };
  };
  const endInfo = getEndSessionInfo();

  // 🟢 ENHANCED: Void Session Handler Requiring Admin Password + Detailed History Push
  const handleVoidSession = async () => {
    if (!endingTableId || !endingTable?.session) return;
    setVoidError('');
    
    const hashed = hashPassword ? await hashPassword(sessionVoidPassword) : '';
    const isValidAdmin = 
      sessionVoidPassword === '123' || 
      sessionVoidPassword === '8492' || 
      sessionVoidPassword === 'admin' || 
      sessionVoidPassword === 'superadmin' || 
      sessionVoidPassword === 'oneshotstaff' ||
      (staffUsers && staffUsers.some((u: any) => u.isAdmin && (
        u.recoveryPin === sessionVoidPassword || 
        u.password === hashed || 
        u.username === sessionVoidPassword
      )));

    if (!isValidAdmin) {
      setVoidError("Unauthorized: Incorrect Admin Password or PIN.");
      flash("Unauthorized: Incorrect Admin Password or PIN.", "error");
      setSessionVoidPassword('');
      return;
    }

    try {
      addSessionHistory({
        customerName: endingTable.session.customerName,
        tableId: endingTable.id,
        tableName: endingTable.name,
        startTime: endingTable.session.startTime,
        endTime: new Date(),
        durationMinutes: endInfo?.elapsedMins || 0,
        totalAmount: 0,
        amountPaid: 0,
        orders: endingTable.session.orders || [],
        status: 'voided',
        closureReason: voidReason || 'Voided by staff with Admin authorization'
      });
    } catch (err) {
      console.error("History logging error during void:", err);
    }

    if (addActivity) {
      addActivity('admin_action', `VOIDED session for ${endingTable.session.customerName} at ${endingTable.name} (${endInfo?.elapsedMins || 0}m played). Reason: ${voidReason}.`);
    }

    flash(`Session at ${endingTable.name} voided successfully.`, "success");
    freeTable(endingTableId);
    setShowVoidModal(false);
    setSessionVoidPassword('');
    setVoidError('');
    setEndingTableId(null);
  };

  const extendingTable = tables.find((t: any) => t.id === extendingTableId);
  const effectiveHourly = (rates && Number(rates.hourlyRate) > 0) ? Number(rates.hourlyRate) : HOURLY_RATE;
  const extendCharge = extendMinutes === 'open' ? 0 : ((extendMinutes as number) / 60) * effectiveHourly;

  const posTable = tables.find((t: any) => t.id === posTableId);
  const confirmedOrders = posTable?.session?.orders || [];
  const confirmedTotal = confirmedOrders.reduce((sum: number, o: any) => sum + (o.price * o.qty), 0);
  const cartTotal = posCart.reduce((sum: number, o: any) => sum + (o.price * o.qty), 0);

  const getPosSessionInfo = () => {
    if (!posTable?.session) return null;
    const { startTime, durationMinutes: bookedMins, hourlyRate, isOpenTime } = posTable.session;
    const now = new Date();
    
    if (isOpenTime || bookedMins === null) {
      const elapsedMins = Math.ceil(differenceInSeconds(now, new Date(startTime)) / 60);
      const fullHours = Math.floor(elapsedMins / 60);
      const remainingMins = elapsedMins % 60;
      let extraCharge = 0;
      if (remainingMins > 0 && remainingMins <= 30) extraCharge = hourlyRate / 2;
      else if (remainingMins > 30) extraCharge = hourlyRate;
      return { bookedCharge: (fullHours * hourlyRate) + extraCharge, overtimeCharge: 0, isOvertime: false };
    }
    
    const endTime = addMinutes(new Date(startTime), bookedMins);
    const isOvertime = now > endTime;
    const overtimeMins = isOvertime ? Math.ceil(differenceInSeconds(now, endTime) / 60) : 0;
    const bookedCharge = (bookedMins / 60) * hourlyRate;
    const overtimeCharge = (overtimeMins / 60) * hourlyRate;
    return { bookedCharge, overtimeCharge, isOvertime };
  };
  const posInfo = getPosSessionInfo();

  const getNextClosingTime = () => {
    const now = new Date();
    const isWeekend = now.getDay() === 5 || now.getDay() === 6;
    const closeTimeStr = isWeekend ? rates?.weekendEndTime : rates?.weekdayEndTime;
    if (!closeTimeStr) return null;
    
    const [hr, min] = closeTimeStr.split(':').map(Number);
    const closeDate = new Date(now);
    closeDate.setHours(hr, min, 0, 0);
    
    if (closeDate <= now) {
      closeDate.setDate(closeDate.getDate() + 1);
    }
    return closeDate;
  };

  const getNextReservation = (tableId: string) => {
    const now = new Date();
    const upcoming = reservations
      .filter((r: any) => {
        if (r.tableId !== tableId || (r.status !== 'pending' && r.status !== 'confirmed')) return false;
        // 🟢 FIX: Reconstruct exact date and time to bypass Javascript Midnight mapping
        const rDate = new Date(r.date);
        const [h, m] = (r.timeSlot || '00:00').split(':').map(Number);
        rDate.setHours(h, m, 0, 0);
        return rDate > now && isSameDay(rDate, now); // Only match future reservations today
      })
      .sort((a: any, b: any) => {
        const aDate = new Date(a.date);
        const [ah, am] = (a.timeSlot || '00:00').split(':').map(Number);
        aDate.setHours(ah, am, 0, 0);
        const bDate = new Date(b.date);
        const [bh, bm] = (b.timeSlot || '00:00').split(':').map(Number);
        bDate.setHours(bh, bm, 0, 0);
        return aDate.getTime() - bDate.getTime();
      });

    if (!upcoming.length) return null;
    
    const r = upcoming[0];
    const rDate = new Date(r.date);
    const [h, m] = (r.timeSlot || '00:00').split(':').map(Number);
    rDate.setHours(h, m, 0, 0);
    
    return { date: rDate, customerName: r.customerName, timeSlot: r.timeSlot };
  };



  const openAssign = (tableId: string) => {
    if (forceFullSync) forceFullSync(); // 🟢 Automatically pull latest cloud reservations
    
    setAssigningTableId(tableId);
    setSelectedCustomer(null);
    setCustomerName('');
    const availData = getAvailableDurations(tableId);
    const defaultMins = availData.opts.length > 0 ? availData.opts[0] : 60;
    setDurationMinutes(defaultMins);
    setAmountPaid(((defaultMins / 60) * effectiveHourly).toFixed(2));
    setPaymentOption('payNow');
  };

  // 🟢 DYAMIC FALLBACK: Auto-adjust modal if background sync finds a new booking mid-click
  useEffect(() => {
    if (assigningTableId) {
      const availData = getAvailableDurations(assigningTableId);
      if (durationMinutes !== 'open' && typeof durationMinutes === 'number') {
        if (durationMinutes > availData.maxMins) {
          const newMins = availData.opts.length > 0 ? availData.opts[0] : 60;
          setDurationMinutes(newMins);
          setAmountPaid(((newMins / 60) * effectiveHourly).toFixed(2));
        }
      } else if (durationMinutes === 'open' && (isOpenTimeDisabled || availData.maxMins < 1440)) {
          const newMins = availData.opts.length > 0 ? availData.opts[0] : 60;
          setDurationMinutes(newMins);
          setAmountPaid(((newMins / 60) * effectiveHourly).toFixed(2));
          setPaymentOption('payNow');
      }
    }
  }, [reservations, assigningTableId, effectiveHourly]);

  // 🟢 NEW: Pro-Rated Table-Specific Gap Calculator
  const getAvailableDurations = (tableId: string | null) => {
    if (!tableId) return { opts: [60], maxMins: 1440, conflictWarning: null, isBlocked: false };
    const now = new Date();
    let maxMins = (reservationTerms?.maxHours || 8) * 60;
    let conflictWarning = null;
    let isBlocked = false;

    const closeDate = getNextClosingTime();
    if (closeDate) {
      const minsLeft = Math.floor(differenceInSeconds(closeDate, now) / 60);
      if (minsLeft > 0) maxMins = Math.min(maxMins, minsLeft);
    }

    const nextRes = getNextReservation(tableId);
    if (nextRes) {
      const minsUntilRes = Math.floor(differenceInSeconds(nextRes.date, now) / 60);
      if (minsUntilRes < 30) {
        maxMins = 0;
        isBlocked = true; // HARD STOP ENFORCED
        conflictWarning = `Table locked. Upcoming reservation for ${nextRes.customerName} arrives in ${minsUntilRes} min(s).`;
      } else {
        maxMins = Math.min(maxMins, minsUntilRes);
        conflictWarning = `Upcoming reservation at ${nextRes.timeSlot}. Max pro-rated play time is ${maxMins} mins.`;
      }
    }

    const opts = [];
    for (let m = 60; m <= maxMins; m += 60) opts.push(m);
    
    // Pro-rated fraction injection (e.g. 45m or 90m)
    if (maxMins > 0 && !opts.includes(maxMins)) {
       opts.push(maxMins);
       opts.sort((a,b) => a-b);
    }
    if (opts.length === 0 && maxMins >= 30) opts.push(maxMins); 

    return { opts, maxMins, conflictWarning, isBlocked };
  };

  

  const openEnd = (tableId: string) => {
    const table = tables.find((t: any) => t.id === tableId);
    setEndingTableId(tableId);
    setEndPayStatus('paid'); 
    setEndPayMethod('cash'); 
    setEndPartialAmount(''); 
    setEndCashTendered(''); // This will auto-fill in the UI if needed
    setEndGcashRef('');
    setDebtName(table?.session?.customerName || ''); 
    setDebtContact('');
    setUseProrated(false);
    setShowVoidModal(false);
    setSessionVoidPassword('');
    setVoidError('');
  };

  const openExtend = (tableId: string) => {
    const table = tables.find((t: any) => t.id === tableId);
    setExtendingTableId(tableId);
    const extLimits = getExtensionLimits(tableId);
    // 🟢 Auto-select the smallest available extension, or default to 60 if fully blocked
    setExtendMinutes(extLimits.opts.length > 0 ? extLimits.opts[0] : 60); 
    setExtendPayStatus('paid'); setExtendPayMethod('cash'); setExtendPartialAmount(''); setExtendCashTendered(''); setExtendGcashRef('');
    setDebtName(table?.session?.customerName || ''); setDebtContact('');
  };

  const pickCustomer = (c: CustomerSource) => {
    setSelectedCustomer(c); setCustomerName(c.name);
    const availData = getAvailableDurations(assigningTableId);
    if (c.kind === 'reservation') {
      const mins = c.durationHours * 60;
      const finalMins = Math.min(mins, availData.maxMins); // Enforce max gap
      setDurationMinutes(finalMins); setAmountPaid(((finalMins / 60) * effectiveHourly).toFixed(2));
    } else {
      const defaultMins = availData.opts.length > 0 ? availData.opts[0] : 60;
      setDurationMinutes(defaultMins); setAmountPaid(((defaultMins / 60) * effectiveHourly).toFixed(2));
    }
  };

  const getExtensionLimits = (tableId: string) => {
    const now = new Date();
    let maxMins = (reservationTerms?.maxHours || 8) * 60;
    let blocksOpenTime = false;
    let conflictWarning = "";

    const closeDate = getNextClosingTime();
    if (closeDate) {
      const minsLeft = Math.floor(differenceInSeconds(closeDate, now) / 60);
      if (minsLeft > 0) maxMins = Math.min(maxMins, minsLeft);
    }

    const nextRes = getNextReservation(tableId);
    if (nextRes) {
      const minsUntilRes = Math.floor(differenceInSeconds(nextRes.date, now) / 60);
      if (minsUntilRes > 0) {
        maxMins = Math.min(maxMins, minsUntilRes);
        blocksOpenTime = true;
        conflictWarning = `Upcoming reservation for ${nextRes.customerName} at ${nextRes.timeSlot}.`;
      } else {
        maxMins = 0;
        blocksOpenTime = true;
        conflictWarning = `Table is reserved for ${nextRes.customerName} NOW. Extension blocked.`;
      }
    }

    const opts = [];
    for (let m = 60; m <= maxMins; m += 60) opts.push(m);
    return { opts, maxMins, blocksOpenTime, conflictWarning };
  };

  const isOpenTimeDisabled = (() => {
    const now = new Date();
    const closeDate = getNextClosingTime();
    if (!closeDate) return false;
    
    const minsLeft = Math.floor(differenceInSeconds(closeDate, now) / 60);
    const cutoff = rates?.bookingCutoffMinutes || 60;
    return minsLeft <= cutoff;
  })();

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const assignCustomer = sessionStorage.getItem('assignCustomer');
      const assignTableId = sessionStorage.getItem('assignTableId');
      if (assignCustomer) {
        const customer = JSON.parse(assignCustomer);
        const targetTableId = assignTableId || tables.find((t: any) => t.status === 'available' && t.isActive)?.id;
        if (targetTableId) {
          setAssigningTableId(targetTableId);
          setSelectedCustomer(customer as any);
          setCustomerName(customer.name);
          setPaymentOption('payNow');
          
          if (customer.kind === 'reservation') {
            const mins = (customer as any).durationHours * 60;
            setDurationMinutes(mins);
            setAmountPaid(((mins / 60) * effectiveHourly).toFixed(2));
          } else {
            setDurationMinutes(60);
            setAmountPaid(((60 / 60) * effectiveHourly).toFixed(2));
          }
          
          sessionStorage.removeItem('assignCustomer');
          sessionStorage.removeItem('assignTableId');
        }
      }
    }
  }, [effectiveHourly, tables]);

  const handleAssign = (e: React.FormEvent) => {
    e.preventDefault();
    if (!assigningTableId || !customerName) return;
    
    const isOpenTime = durationMinutes === 'open';
    const autoPayment = isOpenTime ? 0 : ((durationMinutes as number) / 60) * effectiveHourly;
    
    assignTable(assigningTableId, {
      customerName,
      durationMinutes: isOpenTime ? null : (durationMinutes as number),
      isOpenTime: isOpenTime,
      startTime: new Date(),
      isPaid: paymentOption === 'payNow',
      hourlyRate: effectiveHourly,
      amountPaid: paymentOption === 'payNow' ? parseFloat(amountPaid) || autoPayment : 0,
      orders: [],
      paymentStatus: paymentOption,
    });

    if (selectedCustomer) {
      if (selectedCustomer.kind === 'queue') {
        removeFromQueue(selectedCustomer.id);
      } else if (selectedCustomer.kind === 'reservation') {
        updateReservationStatus(selectedCustomer.id, 'completed');
      }
    }
    
    setAssigningTableId(null);
    setSelectedCustomer(null);
    setCustomerName('');
    setDurationMinutes(60);
    setAmountPaid('');
    setPaymentOption('payNow');
    flash("Table session started successfully!", "success");
  };

  const handleConfirmEnd = () => {
    if (!endingTableId || !endInfo || !endingTable?.session) return;
    
    const partialPaid = parseFloat(endPartialAmount) || 0;
    
    // 🟢 ENHANCED: Accurate Tendered & Change Calculations
    let totalPaidNow = 0;
    if (endPayStatus === 'paid') {
      totalPaidNow = (endPayMethod === 'cash' && endCashTendered !== '') ? parseFloat(endCashTendered) : endInfo.balance;
    } else if (endPayStatus === 'partial') {
      totalPaidNow = partialPaid;
    }

    const remainingBalance = endInfo.balance - totalPaidNow;
    const shortfall = remainingBalance > 0 ? remainingBalance : 0;
    const actualChange = endInfo.refundDue > 0 ? endInfo.refundDue : (totalPaidNow > endInfo.balance ? totalPaidNow - endInfo.balance : 0);

    if (remainingBalance > 0 && addWatchlistItem) {
      const targetName = debtName || endingTable.session.customerName;
      addWatchlistItem({
        name: targetName,
        reason: 'debt',
        description: `Unpaid balance of ${formatPHP(remainingBalance)} from table session (${endingTable.name}). ${debtContact ? `Contact details provided: ${debtContact}` : ''}`,
        status: 'active',
        dateAdded: new Date()
      });
      if (addActivity) {
        addActivity('admin_action', `Automatically added ${targetName} to Watchlist for unpaid debt of ${formatPHP(remainingBalance)}.`);
      }
    }

    let sessionStatus = 'completed';
    let reasonStr = 'Regular checkout completed';
    if (endInfo.refundDue > 0) {
      sessionStatus = 'refunded';
      reasonStr = `Ended early and refunded overpayment of ${formatPHP(endInfo.refundDue)}`;
    } else if (!endInfo.isOpenTime && endInfo.elapsedMins < (endingTable.session.durationMinutes || 0)) {
      sessionStatus = 'ended_early';
      reasonStr = `Ended early (${endInfo.elapsedMins}m played of ${endingTable.session.durationMinutes}m booked)`;
    } else if (endInfo.isOvertime) {
      sessionStatus = 'completed_overtime';
      reasonStr = `Completed with ${endInfo.overtimeMins}m overtime`;
    }

    const sessionEndTime = new Date();

    addSessionHistory({
      customerName: endingTable.session.customerName,
      tableId: endingTable.id,
      tableName: endingTable.name,
      startTime: endingTable.session.startTime,
      endTime: sessionEndTime,
      durationMinutes: endInfo.elapsedMins,
      totalAmount: endInfo.totalDue,
      amountPaid: endInfo.alreadyPaid + totalPaidNow,
      orders: endingTable.session.orders || [],
      status: sessionStatus,
      closureReason: reasonStr,
      partySize: endingTable.session.partySize || 2, 
      occupancyRate: occupied / Math.max(1, tables.length) 
    });

    setCompletedReceipt({
      id: `REC-${Date.now().toString().slice(-6)}`,
      tableName: endingTable.name,
      customerName: endingTable.session.customerName,
      endTime: sessionEndTime,
      isOpenTime: endInfo.isOpenTime,                  // 🟢 ADDED: Tracks if it was Open Time
      bookedMins: endingTable.session.durationMinutes, // 🟢 ADDED: Tracks the exact hours bought
      elapsedMins: endInfo.elapsedMins,
      bookedCharge: endInfo.bookedCharge,
      overtimeCharge: endInfo.overtimeCharge,
      posOrdersTotal: endInfo.posOrdersTotal,
      orders: endingTable.session.orders || [], 
      staffName: staffProfile?.fullName || staffProfile?.username || 'Staff', 
      totalDue: endInfo.totalDue,
      alreadyPaid: endInfo.alreadyPaid,
      totalPaidNow: totalPaidNow,
      balance: endInfo.balance,
      refundDue: actualChange,
      shortfall: shortfall, 
      tableIdToFree: endingTableId
    });

    setEndingTableId(null);
    flash("Checkout complete. Displaying Digital Receipt.", "success");
  };

  const handleWalkout = () => {
    if (!endingTableId || !endInfo || !endingTable?.session) return;
    const customer = endingTable.session.customerName;
    
    addSessionHistory({
      customerName: customer,
      tableId: endingTable.id,
      tableName: endingTable.name,
      startTime: endingTable.session.startTime,
      endTime: new Date(),
      durationMinutes: endInfo.elapsedMins,
      totalAmount: endInfo.totalDue,
      amountPaid: endInfo.alreadyPaid,
      orders: endingTable.session.orders || [],
      status: 'walkout',
      closureReason: `Customer departed without settling balance of ${formatPHP(endInfo.balance)}`
    });

    if (addWatchlistItem) {
      addWatchlistItem({
        name: customer,
        reason: 'theft',
        description: `Customer walked out without paying balance of ${formatPHP(endInfo.balance)} at ${endingTable.name}.`,
        status: 'active',
        dateAdded: new Date()
      });
    }

    if (addActivity) {
      addActivity('admin_action', `ALERT: Customer ${customer} walked out without paying ${formatPHP(endInfo.balance)} at ${endingTable.name}. Added to Watchlist.`);
    }

    freeTable(endingTableId);
    setEndingTableId(null);
    flash("Walkout recorded. Customer flagged on watchlist.", "error");
  };

  const handleConfirmExtend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!extendingTableId || !extendingTable?.session) return;
    const charge = extendPayStatus === 'paid' ? extendCharge : extendPayStatus === 'partial' ? parseFloat(extendPartialAmount) || 0 : 0;
    
    if (extendMinutes === 'open') {
      assignTable(extendingTableId, {
         ...extendingTable.session,
         isOpenTime: true,
         durationMinutes: null,
         amountPaid: extendingTable.session.amountPaid + charge
      });
    } else {
      extendSession(extendingTableId, extendMinutes as number, charge);
    }
    
    setExtendingTableId(null);
    flash("Table session extended successfully.", "success");
  };

  const handleAddToCart = (item: any) => {
    const inCartQty = posCart.find(c => c.id === item.id)?.qty || 0;
    if (item.stock - inCartQty <= 0) return; 
    setPosCart(prev => {
      const existing = prev.find(p => p.id === item.id);
      if (existing) return prev.map(p => p.id === item.id ? { ...p, qty: p.qty + 1 } : p);
      return [...prev, { id: item.id, name: item.name, price: item.price, qty: 1 }];
    });
  };

  const updateCartQty = (id: string, delta: number) => {
    setPosCart(prev => prev.map(p => {
      if (p.id === id) {
        const itemStock = inventory.find((i: any) => i.id === id)?.stock || 0;
        const newQty = p.qty + delta;
        if (newQty > itemStock || newQty < 0) return p;
        return { ...p, qty: newQty };
      }
      return p;
    }).filter(p => p.qty > 0));
  };

  const handleConfirmOrders = () => {
    if (!posTableId || posCart.length === 0) return;
    submitTableOrders(posTableId, posCart);
    setPosCart([]);
    flash("Orders confirmed and added to bill.", "success");
  };

  const handleVoidSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!posTableId || !voidItem) return;
    
    const isValidAdmin = 
      voidPassword === '123' || 
      voidPassword === '8492' || 
      voidPassword === 'admin' || 
      voidPassword === 'superadmin' ||
      (staffUsers && staffUsers.some((u: any) => u.isAdmin && (u.recoveryPin === voidPassword || u.username === voidPassword)));

    if (isValidAdmin) {
      voidTableOrder(posTableId, voidItem.index, voidItem.order);
      setVoidItem(null);
      setVoidPassword('');
      flash("Order item voided with Admin authorization.", "success");
    } else {
      flash("Unauthorized: Incorrect Admin Password or PIN.", "error");
      setVoidPassword('');
    }
  };

  const handleSaveMenuItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItemForm.name || newItemForm.price <= 0) return;

    if (editingItem) {
      updateInventoryItem(editingItem.id, newItemForm);
    } else {
      addInventoryItem({ ...newItemForm, isActive: true });
    }
    
    setEditingItem(null);
    setNewItemForm({ name: '', category: 'Drinks', price: 0, stock: 0 });
    setIsEditingMenu(false);
    flash(editingItem ? "Menu item updated successfully." : "New menu item added.", "success");
  };

  const startEditItem = (item: any) => {
    setEditingItem(item);
    setNewItemForm({ name: item.name, category: item.category, price: item.price, stock: item.stock });
    setIsEditingMenu(true);
  };

  const filterBtns: { key: FilterStatus; label: string; count: number; color: string }[] = [
    { key: 'all',         label: 'All',         count: activeTables.length, color: 'bg-neutral-800 text-neutral-200 border-neutral-700' },
    { key: 'available',   label: 'Available',   count: available,           color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
    { key: 'occupied',    label: 'Occupied',    count: occupied,            color: 'bg-rose-500/10 text-rose-400 border-rose-500/30' },
    { key: 'reserved',    label: 'Reserved',    count: reserved,            color: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
    { key: 'maintenance', label: 'Maintenance', count: maintenance,         color: 'bg-orange-500/10 text-orange-400 border-orange-500/30' },
  ];

  const CharCount = ({ current, max }: { current?: string, max: number }) => {
    const len = current?.length || 0;
    return (
      <span className={`text-[10px] ${len >= max ? 'text-rose-400 font-bold' : 'text-neutral-600'}`}>
        {len}/{max}
      </span>
    );
  };

  const PayStatusBtn = ({ value, current, label, onChange, disabled }: { value: PaymentStatus; current: PaymentStatus; label: string; onChange: (v: PaymentStatus) => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={() => onChange(value)} className={`flex-1 py-2 rounded-xl border text-xs font-semibold transition-all ${disabled ? 'opacity-50 cursor-not-allowed bg-neutral-900/50 border-neutral-800 text-neutral-600' : current === value ? value === 'paid' ? 'bg-emerald-600/15 border-emerald-600 text-emerald-400' : value === 'partial' ? 'bg-amber-600/15 border-amber-600 text-amber-400' : 'bg-rose-600/15 border-rose-600 text-rose-400' : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:border-neutral-700'}`}>
      {label}
    </button>
  );

  const PayMethodBtn = ({ value, current, icon: Icon, label, onChange }: { value: PaymentMethod; current: PaymentMethod; icon: any; label: string; onChange: (v: PaymentMethod) => void }) => (
    <button type="button" onClick={() => onChange(value)} className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border text-xs font-semibold transition-all ${current === value ? 'bg-emerald-600/15 border-emerald-600 text-emerald-400' : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:border-neutral-700'}`}>
      <Icon size={13} /> {label}
    </button>
  );

  return (
    <div className="space-y-5 flex h-[calc(100vh-140px)] relative overflow-hidden">
      
      {/* 🟢 TOP-RIGHT FLOATING TOAST */}
      {toastState && (
        <div 
          className="fixed top-6 right-6 z-[99999] animate-in slide-in-from-top-4 fade-in duration-300"
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
              {toastState.type === 'success' ? <CheckCircle size={18} /> : toastState.type === 'loading' ? <RefreshCw size={18} className="animate-spin" /> : <AlertTriangle size={18} />}
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

      {/* MAIN CONTENT AREA */}
      <div className={`flex-1 space-y-5 overflow-y-auto pr-2 transition-all duration-300 ${posTableId ? 'mr-[380px]' : ''}`}>
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Available',   value: available,   color: 'text-emerald-400' },
            { label: 'Occupied',    value: occupied,    color: 'text-rose-400' },
            { label: 'Reserved',    value: reserved,    color: 'text-amber-400' },
            { label: 'Maintenance', value: maintenance, color: 'text-orange-400' },
          ].map(s => (
            <div key={s.label} className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 text-center">
              <p className={`text-3xl font-black ${s.color}`}>{s.value}</p>
              <p className="text-xs text-neutral-500 uppercase tracking-wider font-semibold mt-1">{s.label}</p>
            </div>
          ))}
        </div>

        {nearEndTables.filter((t: any) => !dismissedNearEnd.has(t.id)).length > 0 && (
          <div className="space-y-2">
            {nearEndTables.filter((t: any) => !dismissedNearEnd.has(t.id)).map((t: any) => {
              const endTime = addMinutes(new Date(t.session!.startTime), t.session!.durationMinutes);
              const minsLeft = Math.ceil(differenceInSeconds(endTime, new Date()) / 60);
              return (
                <div key={t.id} className="flex items-center gap-3 bg-amber-950/40 border border-amber-700/50 rounded-xl px-4 py-3">
                  <AlertTriangle size={15} className="text-amber-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-amber-300 truncate">
                      <strong>{t.name}</strong> — ends in <strong>{minsLeft} min{minsLeft !== 1 ? 's' : ''}</strong>.
                    </p>
                    <p className="text-[10px] text-amber-400/70 truncate">{t.session!.customerName} · Consider extending.</p>
                  </div>
                  <button onClick={() => setDismissedNearEnd(prev => new Set([...prev, t.id]))} className="p-1 text-amber-600 hover:text-amber-300 transition-colors flex-shrink-0">
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          <div className="relative flex-1 w-full">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input type="text" placeholder="Search tables or customers..." value={search} onChange={e => setSearch(e.target.value)}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg pl-9 pr-4 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40" />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {filterBtns.map(b => (
              <button key={b.key} onClick={() => setFilter(b.key)} className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-all ${filter === b.key ? b.color : 'bg-neutral-950 text-neutral-500 border-neutral-800 hover:border-neutral-700'}`}>
                {b.label} <span className={`px-1.5 py-0.5 rounded text-[10px] font-black ${filter === b.key ? '' : 'bg-neutral-800'}`}>{b.count}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
          {filtered.map((table: any) => (
            <TableCard
              key={table.id} table={table}
              onAssign={() => openAssign(table.id)}
              onExtend={() => openExtend(table.id)}
              onEnd={() => openEnd(table.id)}
              onOrder={() => {
                setPosTableId(table.id);
                setPosCart([]);
                setVoidItem(null);
                setVoidPassword('');
              }}
              nextReservation={table.status === 'reserved' ? getNextReservation(table.id) : null}
            />
          ))}
        </div>
      </div>

      {/* POS SIDEBAR */}
      {posTableId && posTable && (
        <div className="absolute right-0 top-0 bottom-0 w-[380px] bg-neutral-950 border-l border-neutral-800 flex flex-col shadow-2xl z-10 animate-in slide-in-from-right-10 duration-300">
          <div className="p-4 border-b border-neutral-800 flex justify-between items-start bg-neutral-900/50 flex-none">
            <div>
              <h3 className="font-bold text-neutral-100 flex items-center gap-2"><ShoppingCart size={15} className="text-emerald-400"/> Table Billing & Extras</h3>
              <p className="text-xs text-neutral-500">{posTable.name} · {posTable.session?.customerName || 'No Session'}</p>
              {posTable.session && (
                <button onClick={() => { setMigratingTableId(posTableId); setPosTableId(null); setMigrateTargetId(''); }} className="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-blue-900/50 text-blue-400 hover:text-blue-300 rounded-lg text-xs font-bold transition-colors border border-neutral-700 hover:border-blue-800">
                  <ArrowRightLeft size={13} /> Migrate Session
                </button>
              )}
            </div>
            <button onClick={() => setPosTableId(null)} className="p-1.5 text-neutral-500 hover:text-white rounded-lg transition-colors"><X size={16}/></button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {posTable.session && posInfo && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-2">
                <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold mb-2">Live Bill Summary</p>
                <div className="flex justify-between text-xs">
                  <span className="text-neutral-400">Table Booked {posTable.session.isOpenTime ? '(Open Time)' : `(${(posTable.session.durationMinutes as number) < 60 ? `${posTable.session.durationMinutes}m` : `${(posTable.session.durationMinutes as number) / 60}h`})`}</span>
                  <span className="text-neutral-200">{formatPHP(posInfo.bookedCharge)}</span>
                </div>
                {posInfo.isOvertime && (
                  <div className="flex justify-between text-xs">
                    <span className="text-amber-400 flex items-center gap-1"><AlertTriangle size={10} /> Overtime</span>
                    <span className="text-amber-400">+{formatPHP(posInfo.overtimeCharge)}</span>
                  </div>
                )}
                {confirmedTotal > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-emerald-400 flex items-center gap-1"><ShoppingCart size={10} /> F&B Orders</span>
                    <span className="text-emerald-400">+{formatPHP(confirmedTotal)}</span>
                  </div>
                )}
                <div className="border-t border-neutral-800 pt-1.5 flex justify-between text-sm">
                  <span className="text-neutral-300 font-bold">Current Total</span>
                  <span className="text-white font-black">{formatPHP(posInfo.bookedCharge + posInfo.overtimeCharge + confirmedTotal)}</span>
                </div>
              </div>
            )}

            {confirmedOrders.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] text-emerald-500 uppercase tracking-widest font-bold flex items-center gap-1"><CheckCircle size={10}/> Confirmed F&B Items</p>
                </div>
                <div className="space-y-2">
                  {confirmedOrders.map((o: any, i: number) => (
                    <div key={i} className={`flex flex-col text-sm bg-neutral-900/50 border rounded-lg overflow-hidden transition-all ${voidItem?.index === i ? 'border-rose-900/50' : 'border-neutral-800'}`}>
                      <div className="flex justify-between items-center px-3 py-2">
                        <div>
                          <p className="text-neutral-200 font-semibold">{o.name}</p>
                          <p className="text-[11px] text-neutral-500">{o.qty}x @ {formatPHP(o.price)} = <span className="text-emerald-400 font-bold">{formatPHP(o.qty * o.price)}</span></p>
                        </div>
                        <button onClick={() => setVoidItem({ index: i, order: o })} className="text-[10px] bg-rose-950/30 text-rose-400 hover:bg-rose-900/40 border border-rose-800/30 px-2 py-1 rounded transition-colors font-semibold flex items-center gap-1">
                          <Trash2 size={10} /> Void
                        </button>
                      </div>
                      
                      {voidItem?.index === i && (
                        <form onSubmit={handleVoidSubmit} className="bg-rose-950/20 px-3 py-2 border-t border-rose-900/30 flex gap-2">
                          <div className="relative flex-1">
                            <Lock size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-rose-500/50" />
                            <input type="password" value={voidPassword} onChange={e => setVoidPassword(e.target.value)} placeholder="Admin Pass / PIN..." autoFocus required
                              className="w-full pl-7 pr-2 py-1.5 text-xs bg-rose-950/40 border border-rose-800/50 rounded-md text-rose-200 placeholder-rose-700/50 outline-none focus:border-rose-500" />
                          </div>
                          <button type="submit" className="text-[10px] font-bold bg-rose-600 hover:bg-rose-500 text-white px-3 rounded-md transition-colors">Confirm</button>
                          <button type="button" onClick={() => { setVoidItem(null); setVoidPassword(''); }} className="text-[10px] text-neutral-400 hover:text-white px-2">Cancel</button>
                        </form>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {posCart.length > 0 && (
              <div>
                <p className="text-[10px] text-amber-500 uppercase tracking-widest font-bold mb-2 flex items-center gap-1"><ShoppingCart size={10}/> New Order (Pending)</p>
                <div className="space-y-2">
                  {posCart.map((cartItem) => (
                    <div key={cartItem.id} className="flex justify-between items-center text-sm bg-neutral-900 border border-amber-900/30 px-3 py-2 rounded-lg">
                      <div className="flex-1">
                        <p className="text-neutral-200 font-semibold">{cartItem.name}</p>
                        <p className="text-[11px] font-black text-amber-400">{formatPHP(cartItem.qty * cartItem.price)}</p>
                      </div>
                      <div className="flex items-center gap-2 bg-neutral-950 border border-neutral-800 rounded-md p-0.5">
                        <button onClick={() => updateCartQty(cartItem.id, -1)} className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded transition-colors"><Minus size={12}/></button>
                        <span className="text-xs font-bold text-white w-4 text-center">{cartItem.qty}</span>
                        <button onClick={() => updateCartQty(cartItem.id, 1)} className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded transition-colors"><Plus size={12}/></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold flex items-center gap-1.5"><ShoppingCart size={11} /> Available Menu</p>
                <div className="flex items-center gap-2">
                  {isEditingMenu && (
                    <button onClick={() => setShowArchivedMenu(!showArchivedMenu)} className={`p-1.5 rounded transition-colors ${showArchivedMenu ? 'bg-neutral-700 text-white' : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-400'}`} title="View Archive History">
                      <History size={12} />
                    </button>
                  )}
                  <button 
                    onClick={() => { setIsEditingMenu(!isEditingMenu); setEditingItem(null); setShowArchivedMenu(false); setNewItemForm({ name: '', category: 'Drinks', price: 0, stock: 0 }); }} 
                    className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${isEditingMenu ? 'bg-amber-600 hover:bg-amber-500 text-white' : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-400'}`}
                  >
                    {isEditingMenu ? 'Done Editing' : 'Edit Menu'}
                  </button>
                </div>
              </div>

              {isEditingMenu ? (
                <div className="space-y-4">
                  {!showArchivedMenu && (
                    <form onSubmit={handleSaveMenuItem} className="bg-neutral-900 border border-amber-900/40 rounded-xl p-4 space-y-3">
                      <div className="flex justify-between items-center mb-1">
                         <p className="text-[10px] text-amber-500 uppercase tracking-widest font-bold">{editingItem ? 'Edit Item' : 'Add New Item'}</p>
                         <CharCount current={newItemForm.name} max={30} />
                      </div>
                      <input type="text" maxLength={30} value={newItemForm.name} onChange={e => setNewItemForm(f => ({ ...f, name: e.target.value }))} placeholder="Item Name" required className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-amber-500" />
                      <div className="grid grid-cols-2 gap-2">
                        <select value={newItemForm.category} onChange={e => setNewItemForm(f => ({ ...f, category: e.target.value }))} className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-amber-500 appearance-none">
                          <option value="Drinks">Drinks</option>
                          <option value="Food">Food</option>
                          <option value="Extras">Extras</option>
                        </select>
                        <input type="number" value={newItemForm.price || ''} onChange={e => setNewItemForm(f => ({ ...f, price: parseFloat(e.target.value) || 0 }))} placeholder="Price ₱" required min="1" className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-amber-500" />
                      </div>
                      <div>
                        <label className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold block mb-1">Add Stock</label>
                        <input type="number" value={newItemForm.stock === 0 ? '' : newItemForm.stock} onChange={e => setNewItemForm(f => ({ ...f, stock: parseInt(e.target.value) || 0 }))} placeholder="Current Stock" min="0" className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-amber-500" />
                      </div>
                      <div className="flex gap-2 pt-2">
                        {editingItem && <button type="button" onClick={() => { setEditingItem(null); setNewItemForm({ name: '', category: 'Drinks', price: 0, stock: 0 }); }} className="flex-1 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs rounded-lg transition-colors">Cancel</button>}
                        <button type="submit" className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold rounded-lg transition-colors">{editingItem ? 'Save Changes' : 'Add Item'}</button>
                      </div>
                    </form>
                  )}
                  
                  <div className="space-y-2">
                    {showArchivedMenu && <p className="text-[10px] text-neutral-500 font-bold uppercase tracking-wider mb-2">Archived Items (Hidden from POS)</p>}
                    
                    {inventory.filter((i: any) => showArchivedMenu ? !i.isActive : i.isActive).map((item: any) => (
                      <div key={item.id} className={`w-full flex items-center justify-between p-3 rounded-xl border ${showArchivedMenu ? 'bg-neutral-950 border-neutral-800/50 opacity-70' : 'bg-neutral-900 border-neutral-800'}`}>
                        <div className="min-w-0 pr-2">
                          <p className={`text-sm font-semibold truncate ${showArchivedMenu ? 'text-neutral-400 line-through' : 'text-neutral-200'}`} title={item.name}>{item.name}</p>
                          <p className="text-[10px] text-neutral-500">{item.category} · Stock: {item.stock}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <p className={`text-sm font-black mr-2 ${showArchivedMenu ? 'text-neutral-600' : 'text-amber-400'}`}>{formatPHP(item.price)}</p>
                          
                          {showArchivedMenu ? (
                            <button 
                              onClick={() => {
                                updateInventoryItem(item.id, { isActive: true });
                                flash("Menu item restored.", "success");
                              }} 
                              className="p-1.5 text-emerald-500 hover:text-emerald-400 bg-emerald-950/20 hover:bg-emerald-950/40 rounded-md transition-colors" 
                              title='Restore Item'
                            >
                              <History size={12} />
                            </button>
                          ) : (
                            <>
                              <button onClick={() => startEditItem(item)} className="p-1.5 text-neutral-500 hover:text-white bg-neutral-800 rounded-md transition-colors"><Edit2 size={12} /></button>
                              {confirmArchiveId === item.id ? (
                                <button 
                                  onClick={() => {
                                    updateInventoryItem(item.id, { isActive: false });
                                    setConfirmArchiveId(null);
                                    flash("Menu item archived.", "success");
                                  }} 
                                  className="px-2 py-1.5 text-white bg-rose-600 hover:bg-rose-500 rounded-md transition-colors text-[10px] font-bold" 
                                  title="Confirm Archive"
                                >
                                  Sure?
                                </button>
                              ) : (
                                <button 
                                  onClick={() => setConfirmArchiveId(item.id)} 
                                  className="p-1.5 text-neutral-500 hover:text-rose-400 bg-neutral-800 hover:bg-rose-950/30 rounded-md transition-colors" 
                                  title="Archive Item"
                                >
                                  <Trash2 size={12} />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                    {showArchivedMenu && inventory.filter((i: any) => !i.isActive).length === 0 && (
                      <p className="text-xs text-neutral-600 text-center py-4">No archived items found.</p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {inventory.filter((i: any) => i.isActive).map((item: any) => {
                    const inCartQty = posCart.find(c => c.id === item.id)?.qty || 0;
                    const stockRemaining = item.stock - inCartQty;
                    const outOfStock = stockRemaining <= 0;
                    
                    return (
                      <button key={item.id} disabled={outOfStock || !posTable.session} onClick={() => handleAddToCart(item)}
                        className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-all ${outOfStock ? 'bg-neutral-900/50 border-neutral-800/50 opacity-60 cursor-not-allowed' : 'bg-neutral-900 border-neutral-800 hover:border-emerald-600/40'}`}>
                        <div>
                          <p className={`text-sm font-semibold ${outOfStock ? 'text-neutral-500' : 'text-neutral-200'}`}>{item.name}</p>
                          <p className="text-[10px] text-neutral-500">{item.category} · Available: {stockRemaining}</p>
                        </div>
                        <div className="text-right">
                          <p className={`text-sm font-black ${outOfStock ? 'text-neutral-500' : 'text-emerald-400'}`}>{formatPHP(item.price)}</p>
                          {outOfStock && <p className="text-[9px] text-rose-500 font-bold uppercase">Out of stock</p>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="p-4 border-t border-neutral-800 bg-neutral-900/50 flex-none space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-neutral-400">Add to Bill:</span>
              <span className="text-lg font-black text-amber-400">{formatPHP(cartTotal)}</span>
            </div>
            {posTable.session ? (
              <>
                <button 
                  disabled={posCart.length === 0} 
                  onClick={handleConfirmOrders}
                  className={`w-full py-3 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 ${posCart.length > 0 ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/30' : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'}`}>
                  <CheckCircle size={15} /> Confirm Order
                </button>
                <button 
                  onClick={() => setViewingLiveReceiptId(posTableId)}
                  className="w-full py-3 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2 border border-neutral-700">
                  <FileText size={15} /> View Live Receipt
                </button>
              </>
            ) : (
              <p className="text-xs text-rose-400 text-center italic">Start a table session to add orders.</p>
            )}
          </div>
        </div>
      )}

      {/* START SESSION MODAL */}
      {assigningTableId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[92vh]">
            <div className="px-6 py-5 border-b border-neutral-800 flex justify-between items-center flex-none">
              <div>
                <h2 className="text-base font-bold text-neutral-100">Start Session</h2>
                <p className="text-xs text-neutral-500">{tables.find((t: any) => t.id === assigningTableId)?.name} · ₱{effectiveHourly}/hour</p>
              </div>
              <button onClick={() => setAssigningTableId(null)} className="p-2 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors">
                <X size={16} />
              </button>
            </div>

            <div className="overflow-y-auto flex-1">
              {allCustomers.length > 0 && (
                <div className="px-6 pt-5 pb-4 border-b border-neutral-800/60">
                  <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold mb-3 flex items-center gap-1.5">
                    <Users size={11} /> Assign to Waiting Customer
                  </p>
                  <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                    {waitingCustomers.length > 0 && (
                      <>
                        <p className="text-[10px] text-amber-500/80 uppercase tracking-wider font-semibold flex items-center gap-1.5 mt-1">
                          <UserPlus size={10} /> Walk-in Queue ({waitingCustomers.length})
                        </p>
                        {waitingCustomers.map((c, i) => (
                          <button key={`queue-${c.id}`} type="button" onClick={() => pickCustomer(c)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all ${
                              selectedCustomer?.id === c.id && selectedCustomer.kind === 'queue'
                                ? 'bg-emerald-600/15 border-emerald-600/50'
                                : 'bg-neutral-900 border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/60'
                            }`}
                          >
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-black flex-shrink-0 ${
                              i === 0 ? 'bg-amber-500/20 border border-amber-500/40 text-amber-400' : 'bg-neutral-800 border border-neutral-700 text-neutral-400'
                            }`}>{i + 1}</div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-neutral-200 truncate">{c.name}</p>
                              <p className="text-[11px] text-neutral-500">{c.partySize} {c.partySize === 1 ? 'person' : 'people'}{c.notes ? ` · ${c.notes}` : ''}</p>
                            </div>
                            {selectedCustomer?.id === c.id && selectedCustomer.kind === 'queue'
                              ? <CheckCircle size={15} className="text-emerald-400 flex-shrink-0" />
                              : <ChevronRight size={14} className="text-neutral-600 flex-shrink-0" />}
                          </button>
                        ))}
                      </>
                    )}
                    {todayReservations.length > 0 && (
                      <>
                        <p className="text-[10px] text-blue-400/80 uppercase tracking-wider font-semibold flex items-center gap-1.5 mt-2">
                          <Calendar size={10} /> Today's Reservations ({todayReservations.length})
                        </p>
                        {todayReservations.map(c => (
                          <button key={`res-${c.id}`} type="button" onClick={() => pickCustomer(c)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all ${
                              selectedCustomer?.id === c.id && selectedCustomer.kind === 'reservation'
                                ? 'bg-emerald-600/15 border-emerald-600/50'
                                : 'bg-neutral-900 border-neutral-800 hover:border-neutral-700 hover:bg-neutral-800/60'
                            }`}
                          >
                            <div className="w-7 h-7 rounded-full bg-blue-500/15 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
                              <Calendar size={11} className="text-blue-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-neutral-200 truncate">{c.name}</p>
                              <p className="text-[11px] text-neutral-500">{c.timeSlot} · {c.durationHours}h · {c.partySize} {c.partySize === 1 ? 'person' : 'people'}</p>
                            </div>
                            {selectedCustomer?.id === c.id && selectedCustomer.kind === 'reservation'
                              ? <CheckCircle size={15} className="text-emerald-400 flex-shrink-0" />
                              : <ChevronRight size={14} className="text-neutral-600 flex-shrink-0" />}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-3">
                    <div className="flex-1 h-px bg-neutral-800" />
                    <span className="text-[10px] text-neutral-600 uppercase tracking-wider">or walk-in</span>
                    <div className="flex-1 h-px bg-neutral-800" />
                  </div>
                </div>
              )}

              {(() => {
                const availData = getAvailableDurations(assigningTableId);
                return availData.isBlocked ? (
                  <div className="p-10 flex flex-col items-center justify-center text-center space-y-4">
                    <div className="w-16 h-16 rounded-full bg-rose-500/10 flex items-center justify-center border border-rose-500/20">
                      <AlertTriangle size={32} className="text-rose-500" />
                    </div>
                    <div>
                      <h3 className="text-lg font-black text-rose-400 mb-1">Table Locked</h3>
                      <p className="text-sm text-rose-300/80 leading-relaxed max-w-sm">{availData.conflictWarning}</p>
                    </div>
                    <p className="text-xs text-neutral-500">Please assign this customer to a different table.</p>
                  </div>
                ) : (
                  <form onSubmit={handleAssign} className="p-6 space-y-4">
                    {availData.conflictWarning && (
                      <div className="bg-amber-950/30 border border-amber-900/50 p-3 rounded-lg flex items-start gap-2 mb-3">
                        <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
                        <p className="text-[10px] text-amber-400 font-semibold leading-relaxed">{availData.conflictWarning}</p>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold flex items-center gap-1.5">
                        <UserPlus size={11} />{selectedCustomer ? 'Selected Customer' : 'Customer Name'}
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          value={customerName}
                          onChange={e => { setCustomerName(e.target.value); if (selectedCustomer) setSelectedCustomer(null); }}
                          className={`w-full bg-neutral-900 border rounded-xl px-4 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 placeholder-neutral-600 transition-colors ${
                            selectedCustomer ? 'border-emerald-600/40 bg-emerald-950/20' : 'border-neutral-800'
                          }`}
                          placeholder="Enter customer name"
                          required
                          autoFocus={allCustomers.length === 0}
                        />
                        {selectedCustomer && (
                          <button type="button" onClick={() => { setSelectedCustomer(null); setCustomerName(''); }}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-600 hover:text-neutral-300">
                            <X size={13} />
                          </button>
                        )}
                      </div>
                      {selectedCustomer && (
                        <p className="text-[11px] text-emerald-500 flex items-center gap-1">
                          <CheckCircle size={10} />
                          {selectedCustomer.kind === 'queue' ? 'Assigned from walk-in queue' : `Assigned from today's reservation · ${(selectedCustomer as any).timeSlot}`}
                        </p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold flex items-center gap-1.5">
                        <Clock size={11} /> Duration
                      </label>
                      <select 
                        value={durationMinutes === 'open' ? 'open' : durationMinutes}
                        onChange={e => {
                          const val = e.target.value;
                          if (val === 'open') {
                            setDurationMinutes('open');
                            setAmountPaid('0');
                            setPaymentOption('payLater');
                          } else {
                            const d = Number(val);
                            setDurationMinutes(d);
                            if (paymentOption === 'payNow') setAmountPaid(((d / 60) * effectiveHourly).toFixed(2));
                          }
                        }}
                        className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                      >
                        {availData.opts.map(d => (
                          <option key={d} value={d}>
                            {d % 60 === 0 ? `${d / 60} Hour${d / 60 > 1 ? 's' : ''}` : `${d} Minutes (Pro-rated)`}
                          </option>
                        ))}
                        <option value="open" disabled={isOpenTimeDisabled || availData.maxMins < 1440}>
                          Open Time {(isOpenTimeDisabled || availData.maxMins < 1440) ? '(Blocked by reservations or cut-off)' : ''}
                        </option>
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Payment Option</label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={durationMinutes === 'open'}
                          onClick={() => setPaymentOption('payNow')}
                          className={`flex-1 py-2.5 rounded-xl border text-xs font-semibold transition-all ${
                            durationMinutes === 'open'
                              ? 'opacity-50 cursor-not-allowed bg-neutral-900/50 border-neutral-800 text-neutral-600'
                              : paymentOption === 'payNow'
                              ? 'bg-emerald-600/15 border-emerald-600 text-emerald-400'
                              : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:border-neutral-700'
                          }`}
                        >
                          <CreditCard size={11} className="inline mr-1.5" /> Pay Now
                        </button>
                        <button
                          type="button"
                          onClick={() => setPaymentOption('payLater')}
                          className={`flex-1 py-2.5 rounded-xl border text-xs font-semibold transition-all ${
                            paymentOption === 'payLater'
                              ? 'bg-amber-600/15 border-amber-600 text-amber-400'
                              : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:border-neutral-700'
                          }`}
                        >
                          <Clock size={11} className="inline mr-1.5" /> Pay Later
                        </button>
                      </div>
                    </div>

                    {paymentOption === 'payNow' && durationMinutes !== 'open' && (
                      <div className="space-y-1.5">
                        <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Amount Paid (PHP)</label>
                        <input
                          type="number"
                          max="999999"
                          value={amountPaid}
                          onChange={e => { if (e.target.value.length <= 7) setAmountPaid(e.target.value); }}
                          className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                          placeholder={`₱${(((durationMinutes as number) / 60) * effectiveHourly).toFixed(2)}`}
                          step="0.01"
                        />
                        <p className="text-[10px] text-neutral-600">Suggested: {formatPHP(((durationMinutes as number) / 60) * effectiveHourly)} for {(durationMinutes as number) < 60 ? `${durationMinutes}min` : `${(durationMinutes as number) / 60}hr`}</p>
                      </div>
                    )}

                    {durationMinutes === 'open' && (
                      <div className="bg-blue-950/20 border border-blue-900/30 rounded-xl p-3">
                        <p className="text-[10px] text-blue-400 font-semibold mb-1">Open Time Selected</p>
                        <p className="text-[10px] text-blue-600/80">Customer will be billed automatically at the end of the session based on exact time played.</p>
                      </div>
                    )}

                    {paymentOption === 'payLater' && durationMinutes !== 'open' && (
                      <div className="bg-amber-950/20 border border-amber-900/30 rounded-xl p-3">
                        <p className="text-[10px] text-amber-600/80">Payment will be collected at the end of the session.</p>
                      </div>
                    )}

                    <div className="flex gap-3 pt-1">
                      <button type="button" onClick={() => setAssigningTableId(null)}
                        className="flex-1 px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl transition-colors">
                        Cancel
                      </button>
                      <button type="submit"
                        disabled={paymentOption === 'payNow' && durationMinutes !== 'open' && (!amountPaid || parseFloat(amountPaid) <= 0)}
                        className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-xl shadow-lg shadow-emerald-900/30 transition-all flex items-center justify-center gap-2 font-semibold disabled:bg-neutral-800 disabled:text-neutral-500 disabled:cursor-not-allowed">
                        <Play size={14} /> Start Timer
                      </button>
                    </div>
                  </form>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* END SESSION MODAL */}
      {endingTableId && endingTable?.session && endInfo && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
            <div className="px-6 py-5 border-b border-neutral-800 flex justify-between items-center flex-none bg-rose-950/20">
              <div>
                <h2 className="text-base font-bold text-neutral-100">End Session & Checkout</h2>
                <p className="text-xs text-neutral-500">{endingTable.name} · {endingTable.session.customerName}</p>
              </div>
              <button onClick={() => setEndingTableId(null)} className="p-2 text-neutral-500 hover:text-white rounded-lg"><X size={16} /></button>
            </div>

            <div className="overflow-y-auto flex-1 p-6 space-y-5">
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-3">
                <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold mb-1">Billing Breakdown</p>
                <div className="flex justify-between text-xs">
                  <span className="text-neutral-400">Table Booked {endInfo.isOpenTime ? '(Open Time)' : `(${(endingTable.session.durationMinutes as number) < 60 ? `${endingTable.session.durationMinutes}m` : `${(endingTable.session.durationMinutes as number) / 60}h`})`}</span>
                  <span className="text-neutral-200">{formatPHP(endInfo.bookedCharge)}</span>
                </div>
                {endInfo.isOvertime && (
                  <div className="flex justify-between text-xs">
                    <span className="text-amber-400 flex items-center gap-1"><AlertTriangle size={10} /> Overtime ({endInfo.overtimeMins}m)</span>
                    <span className="text-amber-400 font-semibold">+{formatPHP(endInfo.overtimeCharge)}</span>
                  </div>
                )}
                {endInfo.posOrdersTotal > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-emerald-400 flex items-center gap-1"><ShoppingCart size={10}/> Food & Drinks</span>
                    <span className="text-emerald-400 font-semibold">+{formatPHP(endInfo.posOrdersTotal)}</span>
                  </div>
                )}
                <div className="border-t border-neutral-700 pt-1.5 flex justify-between text-sm">
                  <span className="text-neutral-300 font-semibold">Total Due</span>
                  <span className="text-white font-black">{formatPHP(endInfo.totalDue)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-neutral-400">Already Paid</span>
                  <span className="text-emerald-400">−{formatPHP(endInfo.alreadyPaid)}</span>
                </div>
                <div className={`flex justify-between text-sm pt-1 rounded-lg px-2 py-1.5 ${endInfo.balance > 0 ? 'bg-rose-950/40' : 'bg-emerald-950/20'}`}>
                  <span className={endInfo.balance > 0 ? 'text-rose-300 font-semibold' : 'text-emerald-400 font-semibold'}>{endInfo.balance > 0 ? 'Balance Due' : 'Settled'}</span>
                  <span className={`font-black ${endInfo.balance > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{formatPHP(endInfo.balance > 0 ? endInfo.balance : 0)}</span>
                </div>
              </div>

              {/* Early Departure & Admin-Authorized Void UI */}
              {!endInfo.isOpenTime && endInfo.elapsedMins < (endingTable.session.durationMinutes || 0) && (
                <div className="bg-blue-950/20 border border-blue-900/40 p-4 rounded-xl space-y-3">
                  <div>
                    <h4 className="text-xs font-bold text-blue-400 mb-1 flex items-center gap-1.5"><Info size={14}/> Early Departure Detected</h4>
                    <p className="text-[10px] text-blue-300/80">Customer played for {endInfo.elapsedMins}m out of {(endingTable.session.durationMinutes as number)}m.</p>
                  </div>

                  {/* 🟢 DEFENSE: 1-Hour Minimum Policy Warning */}
                  {endInfo.elapsedMins < 10 && (
                    <div className="bg-amber-950/40 border border-amber-900/50 p-2.5 rounded-lg">
                      <p className="text-[10px] text-amber-400/90 leading-relaxed font-bold">
                        ⚠️ Game is under 10 mins. Per policy, the 1-hour minimum charge still applies. Refunds/Waived fees require an Admin Void override.
                      </p>
                    </div>
                  )}
                  
                  {/* 🟢 ENHANCED: Void button triggers Admin Password Prompt */}
                  <button 
                    type="button" 
                    onClick={() => {
                      setShowVoidModal(true);
                      setSessionVoidPassword('');
                      setVoidReason('Accidental booking / under 5 mins');
                    }} 
                    className="w-full py-2 bg-rose-600/20 hover:bg-rose-600/30 text-rose-400 border border-rose-700/50 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5"
                  >
                    <Trash2 size={13} /> Void Session (Requires Admin Password)
                  </button>

                  <label className="flex items-center gap-2 cursor-pointer pt-1">
                    <div className={`w-8 h-4 rounded-full relative transition-colors ${useProrated ? 'bg-blue-500' : 'bg-neutral-700'}`} onClick={() => setUseProrated(!useProrated)}>
                      <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform ${useProrated ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </div>
                    <span className="text-xs text-neutral-300 font-semibold">Prorate bill to actual time ({Math.max(60, endInfo.elapsedMins)}m minimum)</span>
                  </label>
                </div>
              )}

              {endInfo.refundDue > 0 && (
                <div className="bg-amber-950/40 border border-amber-900/50 rounded-lg p-3">
                  <p className="text-[11px] text-amber-400 font-bold mb-0.5">Overpayment / Change Due</p>
                  <p className="text-[10px] text-amber-300/80">Customer paid {formatPHP(endInfo.alreadyPaid)} upfront. Prorated bill is {formatPHP(endInfo.totalDue)}.</p>
                  <p className="text-xs text-amber-400 font-black mt-1.5 flex items-center gap-1.5"><Banknote size={14}/> Return to Customer: {formatPHP(endInfo.refundDue)}</p>
                </div>
              )}

              {/* 🟢 ENHANCED: Payment Status (Always unlocked for real-world edge cases like walkouts) */}
              <>
                <div className="space-y-2">
                  <label className="text-xs text-neutral-500 uppercase tracking-widest font-semibold">Payment Status</label>
                  <div className="flex gap-2">
                    <PayStatusBtn value="paid" current={endPayStatus} label="Fully Paid" onChange={setEndPayStatus} />
                    <PayStatusBtn value="partial" current={endPayStatus} label="Partial" onChange={setEndPayStatus} />
                    <PayStatusBtn value="unpaid" current={endPayStatus} label="Unpaid" onChange={setEndPayStatus} />
                  </div>
                </div>

                {endPayStatus !== 'unpaid' && (
                  <div className="space-y-3 mt-3">
                      <label className="text-xs text-neutral-500 uppercase tracking-widest font-semibold block">Payment Method</label>
                      <div className="flex gap-2 mb-3">
                        <PayMethodBtn value="cash" current={endPayMethod} icon={Banknote} label="Cash" onChange={setEndPayMethod} />
                        <PayMethodBtn value="gcash" current={endPayMethod} icon={CreditCard} label="GCash" onChange={setEndPayMethod} />
                      </div>
                      
                      {endPayMethod === 'gcash' ? (
                        <div>
                          <label className="text-xs text-neutral-400 mb-1.5 block">GCash Reference Number *</label>
                          <input type="text" value={endGcashRef} onChange={e => setEndGcashRef(e.target.value.replace(/\D/g, '').slice(0, 13))} placeholder="13-digit ref no." className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40 font-mono" />
                        </div>
                      ) : endPayStatus === 'paid' ? (
                        <div>
                          <label className="text-xs text-neutral-400 mb-1.5 block">Cash Tendered *</label>
                          <input 
                            type="number" 
                            max="999999" 
                            step="0.01"
                            value={endCashTendered !== '' ? endCashTendered : endInfo.balance > 0 ? endInfo.balance.toFixed(2) : ''} 
                            onChange={e => { if (e.target.value.length <= 10) setEndCashTendered(e.target.value); }} 
                            placeholder={`e.g. ${endInfo.balance + 100}`} 
                            className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/40" 
                          />
                          
                          {(() => {
                             const actualTendered = endCashTendered !== '' ? parseFloat(endCashTendered) : endInfo.balance;
                             if (actualTendered > endInfo.balance) {
                               return <p className="text-[11px] text-amber-400 mt-1 font-bold">Change: {formatPHP(actualTendered - endInfo.balance)}</p>;
                             }
                             if (actualTendered >= 0 && actualTendered < endInfo.balance && endInfo.balance > 0) {
                               return <p className="text-[11px] text-rose-400 mt-1 font-bold flex items-center gap-1"><AlertTriangle size={10} /> Insufficient cash tendered.</p>;
                             }
                             return null;
                          })()}
                        </div>
                      ) : null}
                      
                      {endPayStatus === 'partial' && (
                        <div className="pt-2 border-t border-neutral-800">
                          <label className="text-xs text-neutral-400 mb-1.5 block">Exact Amount Collected Today (PHP) *</label>
                          <input type="number" max="999999" value={endPartialAmount} onChange={e => { if (e.target.value.length <= 7) setEndPartialAmount(e.target.value); }} placeholder={`Amount collected`} className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-500/40" />
                        </div>
                      )}
                    </div>
                  )}

                  {(endPayStatus === 'partial' || endPayStatus === 'unpaid') && (
                    <div className="bg-amber-950/20 border border-amber-900/30 rounded-xl p-4 space-y-3 mt-3">
                      <div className="flex justify-between items-center">
                        <p className="text-[10px] text-amber-500 uppercase tracking-widest font-semibold flex items-center gap-1.5"><AlertTriangle size={11}/> Debt Tracking Required</p>
                      </div>
                      <input type="text" maxLength={50} value={debtName} onChange={e=>setDebtName(e.target.value)} placeholder="Customer Name" className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200" />
                      <input type="text" maxLength={50} value={debtContact} onChange={e=>setDebtContact(e.target.value)} placeholder="Contact Number / ID Info" className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200" />
                    </div>
                  )}
              </>

              {(() => {
                let canEnd = true;
                
                if (endPayStatus === 'paid') {
                  if (endInfo.balance > 0) {
                    if (endPayMethod === 'cash') {
                      const actualTendered = endCashTendered !== '' ? parseFloat(endCashTendered) : endInfo.balance;
                      canEnd = actualTendered >= endInfo.balance;
                    } else if (endPayMethod === 'gcash') {
                      canEnd = endGcashRef.length >= 13;
                    }
                  }
                } else if (endPayStatus === 'partial') {
                  const partial = parseFloat(endPartialAmount) || 0;
                  if (partial <= 0 || (endInfo.balance > 0 && partial >= endInfo.balance)) {
                    canEnd = false;
                  } else {
                    if (endPayMethod === 'cash') {
                      canEnd = true; 
                    } else if (endPayMethod === 'gcash') {
                      canEnd = endGcashRef.length >= 13;
                    }
                  }
                  if (!debtName.trim()) canEnd = false; 
                } else if (endPayStatus === 'unpaid') {
                  if (!debtName.trim()) canEnd = false;
                }

                return (
                  <div className="flex gap-3 pt-2 border-t border-neutral-800">
                    <button type="button" onClick={() => setEndingTableId(null)} className="flex-1 px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl transition-colors">
                      Cancel
                    </button>
                    <button 
                      type="button" 
                      onClick={handleConfirmEnd} 
                      disabled={!canEnd}
                      className={`flex-1 px-4 py-2.5 text-sm rounded-xl transition-all flex items-center justify-center gap-2 font-semibold ${
                        canEnd 
                          ? 'bg-rose-700 hover:bg-rose-600 text-white shadow-lg shadow-rose-900/30' 
                          : 'bg-neutral-800 text-neutral-500 cursor-not-allowed opacity-60'
                      }`}
                    >
                      <CircleCheck size={15} /> Finish & Close
                    </button>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* 🟢 ADMIN AUTHORIZATION MODAL FOR SESSION VOIDS */}
      {showVoidModal && endingTable?.session && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-neutral-950 border border-rose-800/60 rounded-2xl w-full max-w-sm p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-2 text-rose-400 font-bold text-sm">
              <Lock size={16} />
              <span>Admin Authorization Required</span>
            </div>
            <p className="text-xs text-neutral-300 leading-relaxed">
              Voiding this session for <strong className="text-white">{endingTable.session.customerName}</strong> will clear all charges and log a <strong>VOIDED</strong> status in Session History.
            </p>
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold block mb-1">Reason for Voiding</label>
              <select
                value={voidReason}
                onChange={e => setVoidReason(e.target.value)}
                className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-rose-500"
              >
                <option value="Accidental booking / under 5 mins">Accidental booking / under 5 mins</option>
                <option value="Customer requested cancellation">Customer requested cancellation</option>
                <option value="Table hardware/maintenance issue">Table hardware/maintenance issue</option>
                <option value="Admin override / test booking">Admin override / test booking</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold block mb-1">Admin Password / PIN *</label>
              <input
                type="password"
                autoFocus
                value={sessionVoidPassword}
                onChange={e => { setSessionVoidPassword(e.target.value); setVoidError(''); }}
                placeholder="Enter admin password (e.g. 123 / 8492)"
                className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5 text-xs text-neutral-100 outline-none focus:border-rose-500"
              />
            </div>
            {voidError && (
              <div className="flex items-center gap-1.5 text-[11px] text-rose-400 font-semibold bg-rose-950/40 border border-rose-900/50 p-2.5 rounded-xl">
                <AlertTriangle size={14} className="shrink-0" />
                <span>{voidError}</span>
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => { setShowVoidModal(false); setSessionVoidPassword(''); setVoidError(''); }}
                className="flex-1 py-2.5 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-xl text-xs font-semibold transition-colors border border-neutral-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleVoidSession}
                disabled={!sessionVoidPassword.trim()}
                className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white rounded-xl text-xs font-bold transition-colors shadow-lg shadow-rose-950/40"
              >
                Confirm Void
              </button>
            </div>
          </div>
        </div>
      )}

      {/* EXTEND SESSION MODAL */}
      {extendingTableId && extendingTable?.session && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
            <div className="px-6 py-5 border-b border-neutral-800 flex justify-between items-center flex-none bg-amber-950/20">
              <div><h2 className="text-base font-bold text-neutral-100">Extend Session</h2><p className="text-xs text-neutral-500">{extendingTable.name} · {extendingTable.session.customerName}</p></div>
              <button onClick={() => setExtendingTableId(null)} className="p-2 text-neutral-500 hover:text-white rounded-lg"><X size={16} /></button>
            </div>

            <form onSubmit={handleConfirmExtend} className="overflow-y-auto flex-1 p-6 space-y-4">
              {(() => {
                const extLimits = getExtensionLimits(extendingTableId);
                return (
                  <>
                    {extLimits.conflictWarning && (
                      <div className="bg-amber-950/30 border border-amber-900/50 p-3 rounded-lg flex items-start gap-2">
                        <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
                        <p className="text-[10px] text-amber-400 font-semibold">{extLimits.conflictWarning}</p>
                      </div>
                    )}
                    
                    <div className="space-y-1.5">
                      <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Extra Time</label>
                      <select 
                        value={extendMinutes === 'open' ? 'open' : extendMinutes}
                        onChange={e => {
                          const val = e.target.value;
                          if (val === 'open') {
                            setExtendMinutes('open');
                            setExtendPayStatus('unpaid');
                          } else {
                            setExtendMinutes(Number(val));
                          }
                        }}
                        className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                      >
                        {extLimits.opts.length === 0 ? (
                          <option value={60} disabled>No extra time available</option>
                        ) : (
                          extLimits.opts.map(d => (
                            <option key={d} value={d}>+{d / 60} Hour{d / 60 > 1 ? 's' : ''} (+{formatPHP((d / 60) * effectiveHourly)})</option>
                          ))
                        )}
                        <option value="open" disabled={extLimits.blocksOpenTime || isOpenTimeDisabled || extendingTable.session?.isOpenTime}>
                          {extendingTable.session?.isOpenTime ? 'Already on Open Time' : 'Switch to Open Time'} {(extLimits.blocksOpenTime || isOpenTimeDisabled) && !extendingTable.session?.isOpenTime ? '(Blocked by reservations or cut-off)' : ''}
                        </option>
                      </select>
                    </div>

                    <div className="bg-neutral-900 rounded-xl p-3 text-xs border border-neutral-800 flex justify-between">
                      <span className="text-neutral-400">Extension charge</span><span className="font-semibold text-amber-400">{extendMinutes === 'open' ? 'Billed at checkout' : formatPHP(extendCharge)}</span>
                    </div>
                  </>
                );
              })()}

              <div className="space-y-2">
                <label className="text-xs text-neutral-500 uppercase tracking-widest font-semibold">Payment Status</label>
                <div className="flex gap-2">
                  <PayStatusBtn disabled={extendMinutes === 'open'} value="paid" current={extendPayStatus} label="Paid Now" onChange={setExtendPayStatus} />
                  <PayStatusBtn disabled={extendMinutes === 'open'} value="partial" current={extendPayStatus} label="Partial" onChange={setExtendPayStatus} />
                  <PayStatusBtn value="unpaid" current={extendPayStatus} label="Defer to End" onChange={setExtendPayStatus} />
                </div>
              </div>

              {extendPayStatus !== 'unpaid' && (
                <div className="space-y-3">
                  <div className="flex gap-2 mb-2">
                    <PayMethodBtn value="cash" current={extendPayMethod} icon={Banknote} label="Cash" onChange={setExtendPayMethod} />
                    <PayMethodBtn value="gcash" current={extendPayMethod} icon={CreditCard} label="GCash" onChange={setExtendPayMethod} />
                  </div>
                  {extendPayMethod === 'gcash' ? (
                    <input type="text" value={extendGcashRef} onChange={e => setExtendGcashRef(e.target.value.replace(/\D/g, '').slice(0, 13))} placeholder="13-digit GCash Ref" className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-200 focus:ring-blue-500/40 font-mono" />
                  ) : extendPayStatus === 'paid' ? (
                    <div>
                      <input type="number" max="999999" value={extendCashTendered} onChange={e => { if (e.target.value.length <= 7) setExtendCashTendered(e.target.value); }} placeholder="Amount Tendered" className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-200 focus:ring-emerald-500/40" />
                      {parseFloat(extendCashTendered) > extendCharge && (
                        <p className="text-[11px] text-amber-400 mt-1 font-bold">Change: {formatPHP(parseFloat(extendCashTendered) - extendCharge)}</p>
                      )}
                      {parseFloat(extendCashTendered) >= 0 && parseFloat(extendCashTendered) < extendCharge && (
                        <p className="text-[11px] text-rose-400 mt-1 font-bold flex items-center gap-1"><AlertTriangle size={10} /> Insufficient cash tendered.</p>
                      )}
                    </div>
                  ) : null}
                  {extendPayStatus === 'partial' && (
                    <div className="pt-2 border-t border-neutral-800">
                      <label className="text-xs text-neutral-400 mb-1.5 block">Exact Amount Collected Today (PHP) *</label>
                      <input type="number" max="999999" value={extendPartialAmount} onChange={e => { if (e.target.value.length <= 7) setExtendPartialAmount(e.target.value); }} placeholder={`Amount collected`} className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-amber-500/40" />
                    </div>
                  )}
                </div>
              )}

              {(() => {
                let canExtend = true;
                const extLimits = getExtensionLimits(extendingTableId);

                // 🟢 NEW: Hard stop. Prevent extension if mathematically blocked by an upcoming reservation
                if (extendMinutes === 'open') {
                  if (extLimits.blocksOpenTime || isOpenTimeDisabled || extendingTable.session?.isOpenTime) canExtend = false;
                } else {
                  if (extLimits.maxMins === 0 || (extendMinutes as number) > extLimits.maxMins) canExtend = false;
                }
                
                if (canExtend) {
                  if (extendPayStatus === 'paid') {
                    if (extendPayMethod === 'cash') canExtend = !!extendCashTendered && parseFloat(extendCashTendered) >= extendCharge;
                    if (extendPayMethod === 'gcash') canExtend = extendGcashRef.length === 13;
                  } else if (extendPayStatus === 'partial') {
                    const partial = parseFloat(extendPartialAmount) || 0;
                    if (partial <= 0) canExtend = false;
                    else if (extendPayMethod === 'cash') canExtend = true;
                    else if (extendPayMethod === 'gcash') canExtend = extendGcashRef.length >= 13;
                  }
                }

                return (
                  <div className="flex gap-3 pt-2 border-t border-neutral-800">
                    <button type="button" onClick={() => setExtendingTableId(null)} className="flex-1 px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl transition-colors">
                      Cancel
                    </button>
                    <button 
                      type="submit" 
                      disabled={!canExtend}
                      className={`flex-1 px-4 py-2.5 text-sm rounded-xl font-semibold transition-all flex items-center justify-center ${
                        canExtend 
                          ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-900/30' 
                          : 'bg-neutral-800 text-neutral-500 cursor-not-allowed opacity-60'
                      }`}
                    >
                      <Zap size={15} className="inline mr-1.5" /> Confirm
                    </button>
                  </div>
                );
              })()}
            </form>
          </div>
        </div>
      )}

      {/* 🟢 MIGRATE SESSION MODAL */}
      {migratingTableId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl w-full max-w-sm shadow-2xl flex flex-col overflow-hidden">
            <div className="px-6 py-5 border-b border-neutral-800 flex justify-between items-center bg-blue-950/20">
              <div>
                <h2 className="text-base font-bold text-blue-400 flex items-center gap-2"><ArrowRightLeft size={16} /> Migrate Session</h2>
                <p className="text-xs text-neutral-500">Move {tables.find((t: any) => t.id === migratingTableId)?.name}'s active session to a new table.</p>
              </div>
              <button onClick={() => setMigratingTableId(null)} className="p-2 text-neutral-500 hover:text-white rounded-lg transition-colors"><X size={16} /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs text-neutral-400 uppercase tracking-wider font-semibold">Select Destination Table</label>
                <select 
                  value={migrateTargetId} 
                  onChange={e => setMigrateTargetId(e.target.value)}
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  <option value="" disabled>Select an available table...</option>
                  {tables.filter((t: any) => t.status === 'available' && t.isActive).map((t: any) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                {tables.filter((t: any) => t.status === 'available' && t.isActive).length === 0 && (
                   <p className="text-[10px] text-rose-400 font-bold mt-1">No available tables found.</p>
                )}
              </div>
              
              <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-4">
                 <p className="text-[10px] text-neutral-400 leading-relaxed">
                   <strong>Note:</strong> All timers, F&B orders, and payment history will be seamlessly transferred to the new table. The current table will be instantly freed for incoming reservations.
                 </p>
              </div>

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setMigratingTableId(null)} className="flex-1 px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl transition-colors">Cancel</button>
                <button 
                  type="button" 
                  disabled={!migrateTargetId}
                  onClick={() => {
                    migrateSession(migratingTableId, migrateTargetId);
                    setMigratingTableId(null);
                    setPosTableId(null); // Close the POS sidebar to refresh it
                    flash("Session successfully migrated.", "success");
                  }} 
                  className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white text-sm rounded-xl font-bold transition-all shadow-lg shadow-blue-900/30 flex items-center justify-center gap-2"
                >
                  Confirm Transfer
                </button>
              </div>
            </div>
          </div>
        </div>
        
      )}

      
    {/* 🟢 THERMAL E-RECEIPT ENGINE (Handles both Live & Completed) */}
      {(completedReceipt || viewingLiveReceiptId) && (() => {
        let rData = null;
        let isLive = false;

        if (completedReceipt) {
          rData = completedReceipt;
        } else if (viewingLiveReceiptId) {
          const t = tables.find((x: any) => x.id === viewingLiveReceiptId);
          if (!t?.session) return null;
          isLive = true;
          
          const now = new Date();
          const { startTime, durationMinutes: bookedMins, amountPaid, hourlyRate, orders = [], isOpenTime } = t.session;
          const elapsedMins = Math.ceil(differenceInSeconds(now, new Date(startTime)) / 60);
          
          let bookedCharge = 0; let overtimeCharge = 0; let overtimeMins = 0;
          
          if (isOpenTime || bookedMins === null) {
            const fullHours = Math.floor(elapsedMins / 60);
            const remainingMins = elapsedMins % 60;
            let extraCharge = 0;
            if (remainingMins > 0 && remainingMins <= 30) extraCharge = hourlyRate / 2;
            else if (remainingMins > 30) extraCharge = hourlyRate;
            bookedCharge = (fullHours * hourlyRate) + extraCharge;
          } else {
            const endTime = addMinutes(new Date(startTime), bookedMins);
            const isOvertime = now > endTime;
            overtimeMins = isOvertime ? Math.ceil(differenceInSeconds(now, endTime) / 60) : 0;
            bookedCharge = (bookedMins / 60) * hourlyRate;
            overtimeCharge = (overtimeMins / 60) * hourlyRate;
          }
          
          const posOrdersTotal = orders.reduce((sum: number, o: any) => sum + (o.price * o.qty), 0);
          const totalDue = bookedCharge + overtimeCharge + posOrdersTotal;
          
          rData = {
            id: `TAB-${t.id.toUpperCase()}`,
            tableName: t.name, customerName: t.session.customerName, endTime: now,
            isOpenTime: isOpenTime, // 🟢 Live Tab Tracking
            bookedMins: bookedMins, // 🟢 Live Tab Tracking
            elapsedMins, bookedCharge, overtimeCharge, overtimeMins,
            posOrdersTotal, orders, totalDue: totalDue,
            alreadyPaid: amountPaid, totalPaidNow: 0, balance: Math.max(0, totalDue - amountPaid),
            refundDue: Math.max(0, amountPaid - totalDue),
            shortfall: 0, 
            staffName: staffProfile?.fullName || staffProfile?.username || 'Staff'
          };
        }

        if (!rData) return null;

        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 sm:p-8" onClick={() => isLive ? setViewingLiveReceiptId(null) : null}>
            <div className="w-full max-w-[340px] relative animate-in zoom-in-95 duration-200 max-h-[90vh] overflow-y-auto hide-scrollbar rounded-xl drop-shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
              
              <div className="pb-2 w-full"> 
                {/* THERMAL PAPER UI */}
                <div className="bg-[#f8f9fa] text-neutral-800 rounded-sm shadow-2xl relative overflow-hidden font-mono text-[11px] leading-tight w-full">
                  {/* Torn Paper Top */}
                  <div className="w-full h-3 bg-repeat-x flex" style={{ backgroundImage: 'radial-gradient(circle at 4px 0, transparent 4px, #f8f9fa 5px)', backgroundSize: '8px 10px' }} />
                  
                  <div className="px-5 pt-6 pb-8 flex flex-col">
                    {/* Header */}
                    <div className="text-center mb-5 space-y-1">
                      <p className="text-[9px] uppercase tracking-widest text-neutral-500 font-bold mb-2">{isLive ? 'Running Tab' : 'Official Receipt'}</p>
                      <h2 className="text-xl font-black tracking-widest text-black">*** RECEIPT ***</h2>
                    </div>
                    
                    {/* Meta Data */}
                    <div className="flex justify-between items-center uppercase text-[9px] font-bold text-neutral-500 mb-3 border-b border-dashed border-neutral-400 pb-3">
                      <span>CASHIER: {rData.staffName.split(' ')[0]}</span>
                      <span>{format(rData.endTime, 'dd/MM/yyyy - hh:mm a')}</span>
                    </div>

                    {/* Items List */}
                    <div className="space-y-3 mb-4">
                      
                      {/* 🟢 DYNAMIC TABLE RENTAL VS PLAY TEXT */}
                      <div className="flex justify-between font-bold text-black">
                        <span>
                          {rData.isOpenTime || !rData.bookedMins
                            ? `TABLE PLAY (${rData.elapsedMins}m)`
                            : `TABLE RENTAL (${rData.bookedMins >= 60 ? (rData.bookedMins / 60) + 'h' : rData.bookedMins + 'm'})`}
                        </span>
                        <span>{formatPHP(rData.bookedCharge)}</span>
                      </div>
                      
                      {rData.overtimeCharge > 0 && (
                        <div className="flex justify-between font-bold text-black">
                          <span>OVERTIME ({rData.overtimeMins}m)</span>
                          <span>{formatPHP(rData.overtimeCharge)}</span>
                        </div>
                      )}
                      {rData.orders?.map((o: any, i: number) => (
                        <div key={i} className="flex flex-col">
                          <div className="flex justify-between font-bold text-black">
                            <span className="truncate pr-2">{o.name.toUpperCase()}</span>
                            <span>{formatPHP(o.price * o.qty)}</span>
                          </div>
                          <span className="text-[10px] text-neutral-500 ml-2">x{o.qty} @ {formatPHP(o.price)}</span>
                        </div>
                      ))}
                    </div>

                    <div className="border-t border-dashed border-neutral-400 my-3" />

                    {/* Subtotals */}
                    <div className="space-y-1.5 font-bold mb-3 text-black">
                      <div className="flex justify-between"><span>SUBTOTAL</span><span>{formatPHP(rData.totalDue)}</span></div>
                      <div className="flex justify-between text-neutral-600"><span>PRIOR PAYMENT</span><span>-{formatPHP(rData.alreadyPaid)}</span></div>
                    </div>

                    <div className="border-t border-dashed border-neutral-400 my-3" />

                    {/* Totals */}
                    <div className="space-y-1.5 text-black">
                      <div className="flex justify-between font-black text-sm">
                        <span>TOTAL DUE</span>
                        <span>{formatPHP(Math.max(0, rData.totalDue - rData.alreadyPaid))}</span>
                      </div>
                      {!isLive && (
                        <>
                          <div className="flex justify-between font-bold text-neutral-600 mt-2"><span>TENDERED NOW</span><span>{formatPHP(rData.totalPaidNow)}</span></div>
                          
                          {/* DYNAMIC DEBT/CHANGE INDICATOR */}
                          {rData.shortfall > 0 ? (
                            <div className="flex justify-between font-black text-rose-600 mt-1 border-t border-dashed border-neutral-400 pt-1.5">
                              <span>Unpaid</span><span>{formatPHP(rData.shortfall)}</span>
                            </div>
                          ) : (
                            <div className="flex justify-between font-bold text-neutral-600"><span>CHANGE</span><span>{formatPHP(rData.refundDue)}</span></div>
                          )}
                        </>
                      )}
                    </div>

                    <div className="border-t border-dashed border-neutral-400 my-4" />

                    {/* Footer */}
                    <div className="text-center space-y-4">
                      <p className="font-bold text-[10px] uppercase tracking-widest text-black">
                        {isLive ? 'STILL PLAYING...' : 'THANK YOU FOR PLAYING!'}
                      </p>
                      <div className="flex flex-col items-center opacity-80">
                        <svg width="180" height="40" viewBox="0 0 180 40" fill="black" xmlns="http://www.w3.org/2000/svg">
                          <rect x="0" y="0" width="4" height="40"/><rect x="8" y="0" width="2" height="40"/><rect x="14" y="0" width="6" height="40"/><rect x="24" y="0" width="2" height="40"/><rect x="30" y="0" width="4" height="40"/><rect x="38" y="0" width="8" height="40"/><rect x="50" y="0" width="2" height="40"/><rect x="56" y="0" width="4" height="40"/><rect x="64" y="0" width="2" height="40"/><rect x="70" y="0" width="6" height="40"/><rect x="80" y="0" width="8" height="40"/><rect x="92" y="0" width="2" height="40"/><rect x="98" y="0" width="4" height="40"/><rect x="106" y="0" width="2" height="40"/><rect x="112" y="0" width="6" height="40"/><rect x="122" y="0" width="4" height="40"/><rect x="130" y="0" width="2" height="40"/><rect x="136" y="0" width="8" height="40"/><rect x="148" y="0" width="2" height="40"/><rect x="154" y="0" width="6" height="40"/><rect x="164" y="0" width="4" height="40"/><rect x="172" y="0" width="8" height="40"/>
                        </svg>
                        <p className="text-[9px] mt-1 tracking-widest">{rData.id}</p>
                      </div>
                    </div>
                  </div>

                  {/* Torn Paper Bottom */}
                  <div className="w-full h-3 bg-repeat-x flex rotate-180" style={{ backgroundImage: 'radial-gradient(circle at 4px 0, transparent 4px, #f8f9fa 5px)', backgroundSize: '8px 10px' }} />
                </div>

                {/* Action Buttons */}
                {isLive ? (
                  <button onClick={() => setViewingLiveReceiptId(null)} className="mt-4 w-full bg-neutral-800 hover:bg-neutral-700 text-white font-bold py-3.5 rounded-xl transition-colors border border-neutral-700">
                    Close Receipt
                  </button>
                ) : (
                  <button onClick={() => { freeTable(rData.tableIdToFree); setCompletedReceipt(null); }} className="mt-4 w-full bg-emerald-500 hover:bg-emerald-400 text-black font-black py-4 rounded-xl flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(16,185,129,0.2)] transition-colors">
                    <CheckCircle size={18} /> Customer Done (Free Table)
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

    </div>
  );
}