import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Calendar as CalendarIcon, Plus, Trash2, Edit2, Tag, Paperclip, X, Link,
  Users, ToggleLeft, ToggleRight, ChevronDown, ChevronUp,
  Wand2, Copy, CheckCircle, AlertTriangle, ChevronLeft, ChevronRight,
  RefreshCw, CalendarX2, List, Network, Clock, Mail, SlidersHorizontal,
  MoreVertical, Power, PowerOff, Phone
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useAppContext, generateRandomPromoCode } from '../context/AppContext';
import type { Event, PromoCode, ClosedDate, Reservation } from '../context/AppContext';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isBefore, startOfDay, addMonths, subMonths } from 'date-fns';
import { supabase } from '../utils/supabase';

const EVENT_TYPES = ['Tournament', 'League', 'Other']; 
const todayStart = startOfDay(new Date());

type FormState = {
  title: string; dates: string[]; type: string; description: string;
  isWholeDay: boolean; startTime: string; endTime: string;
  registrationLink: string; bracketLink: string;
  minParticipants: string; maxParticipants: string;
  slotsFull: boolean;
  attachments: string[];
  selectedTableIds: string[];
};

type PromoForm = {
  code: string; discountPercent: number; description: string;
  isLimitedUses: boolean; maxUsage: number; deleteWhenDepleted: boolean;
  isActive: boolean; hasExpiry: boolean; expiresAt: string;
  hasStart: boolean; startDate: string;
};

type ClosureForm = { 
  reason: string; isFullDay: boolean; openTime: string; closeTime: string; 
  type: 'specific' | 'weekly'; dayOfWeek: number; 
};

type ActionModalData = {
  type: 'receipt' | 'refund' | 'reschedule';
  reservation: any;
};

const emptyClosureForm: ClosureForm = { reason: '', isFullDay: true, openTime: '12:00', closeTime: '22:00', type: 'specific', dayOfWeek: 0 };

const emptyEventForm: FormState = { 
  title: '', dates: [], type: 'Tournament', description: '', isWholeDay: false, 
  startTime: '18:00', endTime: '22:00', registrationLink: '', bracketLink: '', 
  minParticipants: '8', maxParticipants: '32',
  slotsFull: false, attachments: [],
  selectedTableIds: []
};

const emptyPromoForm: PromoForm = { code: '', discountPercent: 10, description: '', isLimitedUses: true, maxUsage: 100, deleteWhenDepleted: false, isActive: true, hasExpiry: false, expiresAt: '', hasStart: false, startDate: '' };

export function AdminEvents() {
  const { 
    events, addEvent, updateEvent, deleteEvent, 
    promoCodes, addPromoCode, updatePromoCode, togglePromoCode, deletePromoCode,
    closedDates, addClosedDate, removeClosedDate, updateClosedDate,
    reservations, updateReservation, updateReservationStatus, tables,
    rates 
  } = useAppContext() as any;

  const [activeTab, setActiveTab] = useState<'calendar' | 'events' | 'promos'>('calendar');
  const [viewMonth, setViewMonth] = useState(new Date());
  const [dayActionDate, setDayActionDate] = useState<Date | null>(null);
  const [toast, setToast] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  const toastTimeout = useRef<NodeJS.Timeout | null>(null);
  
  // Event Form State
  const [showEventModal, setShowEventModal] = useState(false);
  const [cancelEventModal, setCancelEventModal] = useState<{ id: string; title: string; date: string } | null>(null);
  const [eventCancelReason, setEventCancelReason] = useState('Schedule conflict / unforeseen circumstances');
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [eventForm, setEventForm] = useState<FormState>(emptyEventForm);
  const [modalMonth, setModalMonth] = useState(new Date()); 
  const [expandedAttachments, setExpandedAttachments] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Promo Form State
  const [showPromoModal, setShowPromoModal] = useState(false);
  const [showPromoConfirm, setShowPromoConfirm] = useState(false);
  const [editingPromoId, setEditingPromoId] = useState<string | null>(null);
  const [promoForm, setPromoForm] = useState<PromoForm>(emptyPromoForm);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [openPromoDropdownId, setOpenPromoDropdownId] = useState<string | null>(null);
  const promoDropdownRef = useRef<HTMLDivElement | null>(null);

  // Closure Form State
  const [showClosureModal, setShowClosureModal] = useState(false);
  const [editingClosureId, setEditingClosureId] = useState<string | null>(null);
  const [closureForm, setClosureForm] = useState<ClosureForm>(emptyClosureForm);
  const [closureDateStr, setClosureDateStr] = useState('');

  // Action/Contact Modal State
  const [actionModal, setActionModal] = useState<ActionModalData | null>(null);
  const [callSummary, setCallSummary] = useState('');
  const [showDenyInput, setShowDenyInput] = useState(false);

  // 🟢 HOLIDAY FETCHER
  const [fetchedHolidays, setFetchedHolidays] = useState<any[]>([]);

  useEffect(() => {
    let isMounted = true;
    const fetchHolidays = async () => {
      try {
        const year = new Date().getFullYear();
        const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/PH`);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data) && isMounted) {
          const mapped = data.map((h: any) => ({
            id: `hol-${h.date}`,
            title: h.name,
            date: h.date,
            type: 'Holiday',
            description: 'Official Public Holiday in the Philippines',
            isWholeDay: true,
            duration: 'Whole Day'
          }));
          setFetchedHolidays(mapped);
        }
      } catch (e) {
        console.error("Failed to fetch holidays", e);
      }
    };
    fetchHolidays();
    return () => { isMounted = false; };
  }, []);

  const allEvents = useMemo(() => {
    const existingIds = new Set(events.map((e: any) => e.id));
    const hols = fetchedHolidays.filter(h => !existingIds.has(h.id));
    return [...events, ...hols];
  }, [events, fetchedHolidays]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (promoDropdownRef.current && !promoDropdownRef.current.contains(event.target as Node)) {
        setOpenPromoDropdownId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const flash = (msg: string, type: 'success' | 'error' = 'success') => {
      if (toastTimeout.current) clearTimeout(toastTimeout.current);
      setToast({ msg, type });
      toastTimeout.current = setTimeout(() => setToast(null), 5000);
    };
  const dateKey = (d: Date) => format(d, 'yyyy-MM-dd');
  
  const closedMap = new Map(
    closedDates
      .filter((c: any) => c.type !== 'weekly' && c.date && !isNaN(new Date(c.date).getTime()))
      .map((c: any) => [c.date, c])
  );
  const weeklyClosures = closedDates.filter((c: any) => c.type === 'weekly');

  const resMap = reservations.reduce((acc: any, r: any) => {
    if (r.status !== 'cancelled') {
      const d = dateKey(new Date(r.date));
      if (!acc[d]) acc[d] = [];
      acc[d].push(r);
    }
    return acc;
  }, {} as Record<string, Reservation[]>);

  const eventsMap = allEvents.reduce((acc: any, e: any) => {
    if (!e.date) return acc;
    const datesArray = e.date.split(',');
    datesArray.forEach((d: any) => {
      const key = d.trim();
      if (!acc[key]) acc[key] = [];
      acc[key].push(e);
    });
    return acc;
  }, {} as Record<string, Event[]>);
  
  const promosMap = promoCodes.reduce((acc: any, p: any) => {
    if(p.expiresAt) {
      const d = format(new Date(p.expiresAt), 'yyyy-MM-dd');
      if (!acc[d]) acc[d] = [];
      acc[d].push(p);
    }
    return acc;
  }, {} as Record<string, PromoCode[]>);

  const getPromoStatus = (p: any) => {
    if (!p.isActive) return { label: 'Inactive', color: 'bg-neutral-700/40 text-neutral-500 border-neutral-700' };
    if (p.isLimitedUses && p.usageCount >= p.maxUsage) return { label: 'Exhausted', color: 'bg-rose-500/10 text-rose-400 border-rose-500/20' };
    if (p.expiresAt && new Date() > new Date(p.expiresAt)) return { label: 'Expired', color: 'bg-rose-500/10 text-rose-400 border-rose-500/20' };
    return { label: 'Active', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' };
  };

  const openEventCreate = (prefillDate?: Date) => {
    setEditingEventId(null);
    const initialDates = prefillDate ? [dateKey(prefillDate)] : [];
    
    setEventForm({
      ...emptyEventForm,
      dates: initialDates,
      selectedTableIds: []
    });
    setModalMonth(prefillDate || new Date());
    setDayActionDate(null);
    setShowEventModal(true);
  };

  const openEventEdit = (ev: any) => {
    const eventDates = ev.date ? ev.date.split(',').map((d: string) => d.trim()) : [];
    const lastDate = [...eventDates].sort((a, b) => new Date(a).getTime() - new Date(b).getTime()).pop();
    const isPastEvent = lastDate ? isBefore(new Date(lastDate), todayStart) : false;
    const isOngoingEvent = eventDates.some((d: string) => isSameDay(new Date(d), new Date()));

    if (ev.isCancelled) { flash("Editing is disabled: This event has already been cancelled.", "error"); return; }
    if (isPastEvent) { flash("Editing is disabled: This event is already completed.", "error"); return; }
    if (isOngoingEvent) { flash("Editing is disabled: This event is currently ongoing.", "error"); return; }

    setEditingEventId(ev.id);
    const durationParts = ev.duration ? ev.duration.split(' - ') : [];
    const savedDates = ev.date ? ev.date.split(',') : [];
    const isWholeDay = ev.duration === 'Whole Day';
    
    setEventForm({
      title: ev.title, 
      dates: savedDates, 
      type: ev.type, 
      description: ev.description,
      isWholeDay: isWholeDay,
      startTime: isWholeDay ? '12:00' : (durationParts[0] || '18:00'),
      endTime: isWholeDay ? '22:00' : (durationParts[1] || '22:00'),
      registrationLink: ev.registrationLink ?? '', 
      bracketLink: ev.bracketLink ?? '', 
      minParticipants: ev.minParticipants?.toString() ?? '8',
      maxParticipants: ev.maxParticipants?.toString() ?? '32',
      slotsFull: ev.slotsFull ?? false, 
      attachments: ev.attachments ?? [],
      selectedTableIds: ev.eventTableIds ?? []
    });
    
    if (savedDates.length > 0) setModalMonth(new Date(savedDates[0]));
    setDayActionDate(null); 
    setShowEventModal(true);
  };

  const openClosureCreate = (d: Date) => {
    setEditingClosureId(null); 
    const isActionToday = isSameDay(d, new Date());
    setClosureForm({ 
      ...emptyClosureForm, 
      dayOfWeek: d.getDay(),
      isFullDay: isActionToday ? true : emptyClosureForm.isFullDay,
      type: isActionToday ? 'specific' : emptyClosureForm.type
    });
    setClosureDateStr(dateKey(d)); 
    setDayActionDate(null); 
    setShowClosureModal(true);
  };
  
  const openClosureEdit = (c: ClosedDate) => {
    setEditingClosureId(c.id); 
    setClosureForm({ 
      reason: c.reason, isFullDay: c.isFullDay, openTime: c.openTime || '12:00', closeTime: c.closeTime || '22:00',
      type: c.type || 'specific', dayOfWeek: c.dayOfWeek ?? 0
    });
    setClosureDateStr(c.date || dateKey(new Date())); setDayActionDate(null); setShowClosureModal(true);
  };

  const openPromoCreate = (prefillDate?: Date) => {
    setEditingPromoId(null);
    setPromoForm({ ...emptyPromoForm, hasStart: !!prefillDate, startDate: prefillDate ? `${dateKey(prefillDate)}T00:00` : '' });
    setDayActionDate(null); setShowPromoModal(true);
  };
  
  const openPromoEdit = (p: any) => {
    setEditingPromoId(p.id);
    setPromoForm({ 
      code: p.code, 
      discountPercent: p.discountPercent ?? p.discount_percent ?? 10, 
      description: p.description || '', 
      isLimitedUses: p.isLimitedUses !== false && p.is_limited_uses !== 0, 
      maxUsage: p.maxUsage ?? p.max_usage ?? 100, 
      deleteWhenDepleted: p.deleteWhenDepleted || false,
      isActive: p.isActive !== false && p.is_active !== 0, 
      hasExpiry: !!(p.expiresAt || p.expires_at), 
      expiresAt: (p.expiresAt || p.expires_at) ? format(new Date(p.expiresAt || p.expires_at), "yyyy-MM-dd'T'HH:mm") : '',
      hasStart: !!(p.startDate || p.start_date), 
      startDate: (p.startDate || p.start_date) ? format(new Date(p.startDate || p.start_date), "yyyy-MM-dd'T'HH:mm") : '' 
    });
    setDayActionDate(null); setShowPromoModal(true);
  };

  const saveEvent = async () => {
    if (!eventForm.title || eventForm.dates.length === 0) { 
      flash("Please provide a title and select at least one date.", "error"); return; 
    }

    if (!eventForm.description || !eventForm.description.trim()) {
      flash("Please provide an event description. It is required.", "error");
      return;
    }

    if (!eventForm.isWholeDay) {
      if (eventForm.startTime === eventForm.endTime) {
        alert("Start time and End time cannot be exactly the same.");
        return;
      }
    }

    if (eventForm.type === 'Tournament') {
      if (!eventForm.registrationLink || !eventForm.bracketLink) {
        flash("Registration and Bracket links are strictly mandatory for Tournaments.", "error");
        return;
      }
    }

    if (eventForm.type === 'Tournament' || eventForm.type === 'League') {
      const minP = parseInt(eventForm.minParticipants) || 0;
      const maxP = parseInt(eventForm.maxParticipants) || 0;

      if (!eventForm.minParticipants || !eventForm.maxParticipants) {
        alert("Both Min Participants and Max Participants are required for Tournaments and Leagues.");
        return;
      }
      if (minP <= 0 || maxP <= 0) {
        alert("Min and Max participants must be greater than 0.");
        return;
      }
      if (minP >= 100 || maxP >= 100) {
        alert("Participants must be less than 100 (maximum establishment capacity is 99).");
        return;
      }
      if (minP > maxP) {
        alert(`Minimum participants (${minP}) cannot be greater than Maximum participants (${maxP}).`);
        return;
      }
    }

    const highwayClosed = eventForm.dates.some(d => closedMap.has(d));
    if (highwayClosed) {
      alert("You cannot schedule an event on a date that is marked as Closed.");
      return;
    }

    const parseTime = (timeStr: string) => {
      const [h = 0, m = 0] = timeStr.split(':').map(Number);
      return h * 60 + m;
    };

    for (const d of eventForm.dates) {
      const conflictingEvent = allEvents.find((ev: any) => {
        if (editingEventId && ev.id === editingEventId) return false;
        if (ev.type?.toLowerCase() === 'holiday' || eventForm.type?.toLowerCase() === 'holiday') return false;

        const evDates = ev.date ? ev.date.split(',').map((str: string) => str.trim()) : [];
        if (!evDates.includes(d)) return false;

        const isEvWholeDay = ev.duration === 'Whole Day' || !ev.duration;
        if (eventForm.isWholeDay || isEvWholeDay) {
          return true;
        }

        const [evStartStr = '18:00', evEndStr = '22:00'] = ev.duration.split('-').map((s: string) => s.trim());
        
        const newStart = parseTime(eventForm.startTime);
        let newEnd = parseTime(eventForm.endTime);
        if (newEnd <= newStart) newEnd += 24 * 60; 

        const evStart = parseTime(evStartStr);
        let evEnd = parseTime(evEndStr);
        if (evEnd <= evStart) evEnd += 24 * 60; 

        return newStart < evEnd && newEnd > evStart;
      });

     if (conflictingEvent) { 
      flash(`Schedule Conflict!\n\n"${conflictingEvent.title}" is already scheduled on ${d} (${conflictingEvent.duration || 'Whole Day'}). Please pick a different date or time.`, "error"); return; 
     }
    }

    if (!editingEventId) {
      const hasInvalidDate = eventForm.dates.some(d => {
        const eventDate = new Date(d);
        return isSameDay(eventDate, todayStart) || isBefore(eventDate, todayStart);
      });

      if (hasInvalidDate && eventForm.type !== 'Holiday') {
        alert("New events must be scheduled at least 24 hours in advance (tomorrow or later).");
        return;
      }
    }

    const isConfirmed = window.confirm(
      editingEventId 
        ? `Are you sure you want to update "${eventForm.title}"?` 
        : `Are you sure you want to create the event "${eventForm.title}"?`
    );
    
    if (!isConfirmed) return;

    const payload: any = {
      title: eventForm.title, 
      date: eventForm.dates.join(','), 
      type: eventForm.type, 
      description: eventForm.description,
      duration: eventForm.isWholeDay ? 'Whole Day' : `${eventForm.startTime} - ${eventForm.endTime}`,
      registrationLink: eventForm.registrationLink || undefined,
      bracketLink: eventForm.bracketLink || undefined,
      minParticipants: eventForm.minParticipants ? parseInt(eventForm.minParticipants) : undefined,
      maxParticipants: eventForm.maxParticipants ? parseInt(eventForm.maxParticipants) : undefined,
      slotsFull: eventForm.slotsFull, 
      attachments: eventForm.attachments.length ? eventForm.attachments : undefined,
      eventTableIds: eventForm.selectedTableIds
    };

    if (editingEventId) {
      updateEvent(editingEventId, payload);
    } else {
      addEvent(payload);
      
      // 🟢 Tag event as verified booking in the database for each selected table
      if (eventForm.selectedTableIds.length > 0) {
        const reservationsToCreate: any[] = [];
        for (const d of eventForm.dates) {
          for (const tId of eventForm.selectedTableIds) {
            const resId = `EVT-${Date.now().toString().slice(-6)}-${Math.floor(Math.random()*1000)}`;
            
            let durationHours = 10;
            if (!eventForm.isWholeDay) {
              const startMins = parseTime(eventForm.startTime);
              let endMins = parseTime(eventForm.endTime);
              if (endMins <= startMins) endMins += 24 * 60;
              durationHours = Math.max(1, Math.round((endMins - startMins) / 60));
            }

            reservationsToCreate.push({
              id: resId,
              customerName: `EVENT: ${eventForm.title}`,
              contactNumber: 'ADMIN',
              email: 'admin@oneshot.com',
              date: new Date(d).toISOString(),
              timeSlot: eventForm.isWholeDay ? '12:00' : eventForm.startTime,
              durationHours: durationHours,
              partySize: parseInt(eventForm.maxParticipants) || 10,
              tableId: tId,
              status: 'confirmed',
              totalAmount: 0,
              downPaymentAmount: 0,
              downPaymentPaid: 1,
              balancePaid: 1,
              paymentRef: 'EVENT',
              rescheduleCount: 0,
              createdAt: new Date().toISOString()
            });
          }
        }

        if (reservationsToCreate.length > 0) {
          const { error } = await supabase.from('reservations').insert(reservationsToCreate);
          if (error) {
            console.error("Failed to tag event reservations:", error);
          } else {
            flash("Event created and automatically tagged as confirmed bookings on selected tables.", "success");
          }
        }
      }
    }
    
    setShowEventModal(false);
    flash('Event saved successfully!');
  };

  const saveClosure = (e: React.FormEvent) => {
    e.preventDefault();
    if (!closureForm.isFullDay && closureForm.openTime === closureForm.closeTime) { 
  flash("Open time and Close time cannot be the same for partial closures.", "error"); return; 
}

    const payload = {
      ...closureForm,
      date: closureForm.type === 'weekly' ? '' : closureDateStr
    };
    if (editingClosureId) updateClosedDate(editingClosureId, payload);
    else addClosedDate({ ...payload, date: payload.date || '' });
    setShowClosureModal(false); flash('Closure saved successfully!');
  };

  const preparePromoSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!promoForm.code || !promoForm.description) return;
    
    if (promoForm.hasExpiry && promoForm.expiresAt) {
       if (new Date(promoForm.expiresAt) <= new Date()) { flash("Expiry date must be set in the future.", "error"); return; }
    }

    if (promoForm.hasStart && promoForm.hasExpiry && promoForm.startDate && promoForm.expiresAt) {
      if (new Date(promoForm.expiresAt) <= new Date(promoForm.startDate)) { flash("Expiry date must be after the start date.", "error"); return; }
    }
    setShowPromoConfirm(true); 
  };

  const executePromoSave = () => {
    const payload: any = {
      code: promoForm.code.toUpperCase(), discountPercent: promoForm.discountPercent, description: promoForm.description, 
      isActive: promoForm.isActive, isLimitedUses: promoForm.isLimitedUses,
      maxUsage: promoForm.isLimitedUses ? promoForm.maxUsage : 999999,
      deleteWhenDepleted: promoForm.isLimitedUses ? promoForm.deleteWhenDepleted : false,
      startDate: promoForm.hasStart && promoForm.startDate ? new Date(promoForm.startDate) : undefined,
      expiresAt: promoForm.hasExpiry && promoForm.expiresAt ? new Date(promoForm.expiresAt) : undefined,
    };
    if (editingPromoId) updatePromoCode(editingPromoId, payload);
    else addPromoCode(payload);
    
    setEditingPromoId(null);
    setPromoForm(emptyPromoForm);
    setShowPromoConfirm(false);
    setShowPromoModal(false); 
    flash('Promo code saved successfully!');
  };

  const isImage = (dataUrl: string) => dataUrl.startsWith('data:image/');
  const getFileName = (dataUrl: string, index: number) => {
    const match = dataUrl.match(/^data:([^;]+);/);
    return `attachment-${index + 1}.${match?.[1]?.split('/')[1] ?? 'bin'}`;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    files.forEach(file => {
      if (!file.type.startsWith('image/')) { flash(`File "${file.name}" is not a valid image format. Please upload JPG, PNG, WEBP, or GIF only.`, "error"); return; }
      if (file.size > 50 * 1024 * 1024) { flash(`File "${file.name}" exceeds the maximum 50MB limit.`, "error"); return; }

      const reader = new FileReader();
      reader.onload = () => {
        setEventForm(prev => ({ ...prev, attachments: [...prev.attachments, reader.result as string] }));
      };
      reader.readAsDataURL(file);
    });
   if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachment = (index: number) => {
    setEventForm(prev => ({ ...prev, attachments: prev.attachments.filter((_, i) => i !== index) }));
  };

  const CharCount = ({ current, max }: { current?: string, max: number }) => {
    const len = current?.length || 0;
    return (
      <span className={`text-[10px] ${len >= max ? 'text-rose-400 font-bold' : 'text-neutral-600'}`}>
        {len}/{max}
      </span>
    );
  };

  const renderCalendar = () => {
    const monthStart = startOfMonth(viewMonth);
    const monthEnd   = endOfMonth(viewMonth);
    const days       = eachDayOfInterval({ start: monthStart, end: monthEnd });
    const startPad   = monthStart.getDay();

    return (
      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
          <button onClick={() => setViewMonth(m => subMonths(m, 1))} className="p-2 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors">
            <ChevronLeft size={16} />
          </button>
          <h2 className="text-sm font-bold text-neutral-200">{format(viewMonth, 'MMMM yyyy')}</h2>
          <button onClick={() => setViewMonth(m => addMonths(m, 1))} className="p-2 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors">
            <ChevronRight size={16} />
          </button>
        </div>

        <div className="p-4">
          <div className="grid grid-cols-7 mb-2">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <div key={d} className="text-center text-[10px] text-neutral-600 uppercase tracking-wider font-semibold py-1">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {Array.from({ length: startPad }).map((_, i) => <div key={`pad-${i}`} />)}
            {days.map(day => {
              const key = dateKey(day);
              const isPast = isBefore(day, todayStart);
              const isToday = isSameDay(day, new Date());
              
              const dayCls = closedMap.get(key) || weeklyClosures.find((c: any) => c.dayOfWeek === day.getDay());
              const dayEvs = eventsMap[key] || [];
              const dayPrs = promosMap[key] || [];
              const dayRes = resMap[key] || [];

              return (
                <button
                  key={key}
                  disabled={isPast} 
                  onClick={() => setDayActionDate(day)}
                  className={`relative aspect-square rounded-xl p-1.5 flex flex-col items-start transition-all border
                    ${isPast ? 'bg-neutral-950 border-neutral-900/40 text-neutral-700 cursor-not-allowed opacity-40' : 'bg-neutral-900 border-neutral-800 hover:border-neutral-600 cursor-pointer'}
                    ${isToday ? 'ring-1 ring-amber-500/50' : ''}
                    ${dayCls ? 'bg-rose-950/20 border-rose-900/30' : ''}
                  `}
                >
                  <span className={`font-semibold text-xs ${isToday ? 'text-amber-400' : isPast ? 'text-neutral-600' : 'text-neutral-300'}`}>
                    {format(day, 'd')}
                  </span>
                  
                  <div className="mt-auto w-full space-y-0.5 overflow-hidden">
                    {dayCls && <div className="w-full text-[8px] bg-rose-500/20 text-rose-400 rounded px-1 truncate font-semibold">Closed</div>}
                    
                    {!dayCls && dayRes.length > 0 && (
                      <div className="w-full text-[8px] bg-blue-500/20 text-blue-400 rounded px-1 truncate font-semibold border border-blue-500/30">
                        {dayRes.length} Rsv
                      </div>
                    )}
                    
                    {!dayCls && dayEvs.map((e: any) => (
                      <div key={e.id} className={`w-full text-[8px] rounded px-1 truncate font-semibold ${e.type === 'Holiday' ? 'bg-sky-500/20 text-sky-400' : 'bg-amber-500/20 text-amber-400'}`}>
                        {e.title}
                      </div>
                    ))}
                    {!dayCls && dayPrs.map((p: any) => (
                      <div key={p.id} className="w-full text-[8px] bg-violet-500/20 text-violet-400 rounded px-1 truncate font-semibold">{p.code} exp</div>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const renderModalCalendar = () => {
    const monthStart = startOfMonth(modalMonth);
    const monthEnd   = endOfMonth(modalMonth);
    const days       = eachDayOfInterval({ start: monthStart, end: monthEnd });
    const startPad   = monthStart.getDay();

    return (
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-3 select-none">
        <div className="flex items-center justify-between mb-3">
          <button type="button" onClick={() => setModalMonth(m => subMonths(m, 1))} className="p-1 text-neutral-400 hover:text-white"><ChevronLeft size={14}/></button>
          <span className="text-xs font-bold text-neutral-200">{format(modalMonth, 'MMMM yyyy')}</span>
          <button type="button" onClick={() => setModalMonth(m => addMonths(m, 1))} className="p-1 text-neutral-400 hover:text-white"><ChevronRight size={14}/></button>
        </div>
        <div className="grid grid-cols-7 mb-1">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="text-center text-[9px] text-neutral-500 font-bold">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: startPad }).map((_, i) => <div key={`pad-${i}`} />)}
          {days.map(day => {
            const key = dateKey(day);
            const isSelected = eventForm.dates.includes(key);
            const isPastOrToday = isBefore(day, todayStart) || isSameDay(day, todayStart);
            const isDisabled = isPastOrToday && !isSelected;
            
            return (
              <button
                type="button"
                key={key}
                disabled={isDisabled}
                onClick={() => {
                  setEventForm(prev => {
                    const dates = prev.dates.includes(key) ? prev.dates.filter(d => d !== key) : [...prev.dates, key];
                    return { ...prev, dates };
                  });
                }}
                className={`aspect-square rounded-md text-[10px] font-semibold flex items-center justify-center transition-colors ${
                  isSelected ? 'bg-amber-500 text-neutral-950' : isDisabled ? 'text-neutral-700 cursor-not-allowed border border-neutral-800' : 'bg-neutral-950 border border-neutral-800 text-neutral-300 hover:bg-neutral-800'
                }`}
              >
                {format(day, 'd')}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const renderEventsGrid = () => {
    const customEvents = allEvents
      .filter((e: any) => e.type !== 'Holiday')
      .sort((a: any, b: any) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (timeA !== timeB) return timeB - timeA;
        return String(b.id || '').localeCompare(String(a.id || ''));
      });
    const holidays = allEvents.filter((e: any) => e.type === 'Holiday');

    return (
      <div className="space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {customEvents.map((ev: any) => {
            const isExpanded = expandedAttachments.has(ev.id);
            const attachments = ev.attachments ?? [];
            const imageAttachments = attachments.filter(isImage);
            const fileAttachments = attachments.filter((a: any) => !isImage(a));
            
            const eventDates = ev.date ? ev.date.split(',') : [];
            const sortedDates = [...eventDates].sort((a,b) => new Date(a).getTime() - new Date(b).getTime());
            const lastDate = sortedDates[sortedDates.length - 1];
            
            const isPastEvent = lastDate ? isBefore(new Date(lastDate), todayStart) : false;

            const dateDisplay = eventDates.length > 1 
              ? `${new Date(eventDates[0]).toLocaleDateString()} (+${eventDates.length - 1} days)` 
              : eventDates.length === 1 ? new Date(eventDates[0]).toLocaleDateString() : 'No date';

            return (
              <Card key={ev.id} className={`bg-neutral-900 border-neutral-800 overflow-hidden flex flex-col ${isPastEvent ? 'opacity-70' : ''}`}>
                {imageAttachments.length > 0 && (
                  <div className="h-32 w-full overflow-hidden bg-neutral-950">
                    <img src={imageAttachments[0]} alt={ev.title} className={`w-full h-full object-cover opacity-80 ${isPastEvent ? 'grayscale' : ''}`} />
                  </div>
                )}
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start gap-2">
                    <CardTitle className={`text-base ${isPastEvent || ev.isCancelled ? 'text-neutral-400 line-through' : 'text-neutral-200'}`}>{ev.title}</CardTitle>
                    <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap justify-end">
                      <span className="text-[10px] px-2 py-1 rounded-full whitespace-nowrap bg-neutral-800 text-neutral-400">{ev.type}</span>
                      {ev.isCancelled && <span className="text-[10px] bg-rose-950 text-rose-400 border border-rose-700/50 px-2 py-1 rounded-full font-bold whitespace-nowrap">CANCELLED</span>}
                      {!ev.isCancelled && ev.slotsFull && <span className="text-[10px] bg-rose-900/50 text-rose-400 border border-rose-800/40 px-2 py-1 rounded-full font-bold whitespace-nowrap">FULL</span>}
                    </div>
                  </div>
                  <CardDescription className={`text-xs font-medium flex items-center gap-2 ${isPastEvent ? 'text-neutral-600' : 'text-amber-500'}`}>
                    <CalendarIcon size={12}/> {dateDisplay}
                    {ev.duration && <><span className="text-neutral-600">·</span><Clock size={12}/> {ev.duration}</>}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col justify-between">
                  <p className="text-sm text-neutral-400 mb-3 line-clamp-3">{ev.description}</p>

                  <div className="bg-neutral-950 p-2.5 rounded-lg border border-neutral-800/60 mb-3 space-y-1.5 text-xs text-neutral-400">
                    <div className="flex justify-between">
                      <span>Venue Allocation:</span>
                      <span className="text-amber-400 font-bold">
                        {ev.eventTableIds?.length > 0 ? `${ev.eventTableIds.length} Tables Reserved` : 'None specified'}
                      </span>
                    </div>
                  </div>

                  {ev.maxParticipants && (
                    <div className="flex items-center gap-1.5 text-xs text-neutral-500 mb-2 font-medium">
                      <Users size={11} />
                      <span>Min {ev.minParticipants || 8} – Max {ev.maxParticipants} participants</span>
                    </div>
                  )}

                  {ev.registrationLink && (
                    <a href={ev.registrationLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 mb-2 truncate">
                      <Link size={11} className="flex-shrink-0" /><span className="truncate">Registration Form</span>
                    </a>
                  )}
                  
                  {ev.bracketLink && (
                    <a href={ev.bracketLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 mb-3 truncate">
                      <Network size={11} className="flex-shrink-0" /><span className="truncate">View Brackets</span>
                    </a>
                  )}

                  {attachments.length > 0 && (
                    <div className="mb-3">
                      <button onClick={() => setExpandedAttachments(s => { const ns = new Set(s); if(ns.has(ev.id)) ns.delete(ev.id); else ns.add(ev.id); return ns; })}
                        className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-300 transition-colors">
                        <Paperclip size={11} /><span>{attachments.length} attachment{attachments.length > 1 ? 's' : ''}</span>
                        {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                      </button>
                      {isExpanded && (
                        <div className="mt-2 space-y-1.5">
                          {imageAttachments.slice(1).map((att: any, i: number) => <img key={i} src={att} alt="" className="w-full h-20 object-cover rounded-lg opacity-80" />)}
                          {fileAttachments.map((att: any, i: number) => (
                            <a key={i} href={att} download={getFileName(att, i)} className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200 bg-neutral-800 rounded-lg px-2.5 py-1.5 truncate">
                              <Paperclip size={10} className="flex-shrink-0" />{getFileName(att, i)}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex justify-end gap-2 mt-auto pt-4">
                    {ev.isCancelled ? (
                      <span className="text-[10px] text-rose-400 uppercase tracking-widest font-bold bg-rose-950/30 border border-rose-900/50 px-3 py-1.5 rounded-lg w-full text-center">
                        Event Cancelled
                      </span>
                    ) : isPastEvent ? (
                      <span className="text-[10px] text-neutral-500 uppercase tracking-widest font-bold bg-neutral-950 border border-neutral-800 px-3 py-1.5 rounded-lg w-full text-center">
                        Event Completed
                      </span>
                    ) : (
                      <>
                        {(() => {
                          const eventDates = ev.date ? ev.date.split(',').map((d: string) => d.trim()) : [];
                          const isOngoingEvent = eventDates.some((d: string) => isSameDay(new Date(d), new Date()));

                          return !isOngoingEvent ? (
                            <Button variant="ghost" size="sm" className="h-8 text-neutral-500 hover:text-blue-400 hover:bg-blue-950/30" onClick={() => openEventEdit(ev)} title="Edit Event">
                              <Edit2 size={14} />
                            </Button>
                          ) : (
                            <span className="text-[10px] text-amber-400 uppercase tracking-wider font-bold bg-amber-950/30 border border-amber-900/50 px-2.5 py-1 rounded-lg flex items-center gap-1">
                              Ongoing (Edit Locked)
                            </span>
                          );
                        })()}

                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="h-8 px-2.5 text-rose-500 hover:text-rose-400 hover:bg-rose-950/30 font-semibold text-xs flex items-center gap-1" 
                          onClick={() => {
                            setCancelEventModal({ id: ev.id, title: ev.title, date: dateDisplay });
                            setEventCancelReason('Schedule conflict / unforeseen circumstances');
                          }}
                        >
                          <AlertTriangle size={13} /> Cancel Event
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {customEvents.length === 0 && (
            <div className="col-span-full py-12 text-center border-2 border-dashed border-neutral-800 rounded-xl">
              <CalendarIcon size={32} className="mx-auto text-neutral-600 mb-3" />
              <p className="text-neutral-400 font-medium">No custom events yet</p>
            </div>
          )}
        </div>

        {holidays.length > 0 && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
            <h3 className="text-sm font-bold text-sky-400 mb-4 flex items-center gap-2">
              <CalendarIcon size={16} /> Official Holidays <span className="text-[10px] bg-neutral-800 text-neutral-500 px-2 py-0.5 rounded font-medium ml-2">System Generated</span>
            </h3>
            <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
              {holidays.map((h: any) => (
                <div key={h.id} className="flex justify-between items-center bg-neutral-950 border border-neutral-800 rounded-lg p-4">
                   <div>
                     <p className="text-sm font-bold text-neutral-200">{h.title}</p>
                     <p className="text-xs text-neutral-500 mt-1">{h.description}</p>
                   </div>
                   <div className="text-right flex flex-col items-end gap-1.5">
                     <p className="text-sm font-semibold text-sky-400">{format(new Date(h.date.split(',')[0]), 'MMM d, yyyy')}</p>
                     <span className="text-[9px] bg-sky-900/30 text-sky-400 border border-sky-800 px-2 py-0.5 rounded-full uppercase tracking-wider font-bold">Holiday</span>
                   </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderPromosList = () => (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => openPromoCreate()}
          className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-xl font-semibold transition-all shadow-lg shadow-violet-900/30"
        >
          <Plus size={15} /> Add Promo Code
        </button>
      </div>

      <div className="space-y-3">
        {promoCodes.length === 0 ? (
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-12 text-center">
            <Tag size={32} className="mx-auto text-neutral-700 mb-3" />
            <p className="text-neutral-500">No promo codes yet.</p>
          </div>
        ) : promoCodes.map((pc: any) => {
          const status = getPromoStatus(pc);
          return (
            <div key={pc.id} className="bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3 flex items-center gap-4 hover:border-neutral-700 transition-colors">
              <div className="w-12 h-12 rounded-xl bg-violet-600/15 border border-violet-600/25 flex flex-col items-center justify-center flex-shrink-0">
                <span className="text-sm font-black text-violet-400">{pc.discountPercent}%</span>
                <span className="text-[9px] text-violet-600 font-semibold">OFF</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <div className="flex items-center gap-1.5 bg-neutral-800 rounded-lg px-2.5 py-1">
                    <Tag size={10} className="text-neutral-400" />
                    <span className="text-xs font-black text-white tracking-wider">{pc.code}</span>
                  </div>
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${status.color}`}>{status.label}</span>
                </div>
                <p className="text-xs text-neutral-400 mb-1">{pc.description}</p>
                <div className="flex items-center gap-3 text-[10px] text-neutral-600">
                  {pc.isLimitedUses !== false ? (
                    <span>Uses: <strong className="text-neutral-400">{pc.usageCount}</strong>/{pc.maxUsage} {pc.deleteWhenDepleted && '(Auto-delete)'}</span>
                  ) : (
                    <span>Uses: <strong className="text-neutral-400">{pc.usageCount}</strong> / Unlimited</span>
                  )}
                  {pc.startDate && <span>Starts: <strong className="text-neutral-400">{format(new Date(pc.startDate), 'MMM d, yyyy')}</strong></span>}
                  {pc.expiresAt && <span>Expires: <strong className="text-neutral-400">{format(new Date(pc.expiresAt), 'MMM d, yyyy')}</strong></span>}
                </div>
              </div>

              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => { navigator.clipboard.writeText(pc.code); setCopiedCode(pc.code); setTimeout(()=>setCopiedCode(null),2000); }}
                  title="Copy code"
                  className="p-2 rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
                >
                  {copiedCode === pc.code ? <CheckCircle size={15} className="text-emerald-400" /> : <Copy size={15} />}
                </button>

                <div className="relative" ref={openPromoDropdownId === pc.id ? promoDropdownRef : null}>
                  <button
                    onClick={() => setOpenPromoDropdownId(openPromoDropdownId === pc.id ? null : pc.id)}
                    className="p-2 rounded-lg bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-700 transition-colors"
                    title="Promo Actions"
                  >
                    <MoreVertical size={16} />
                  </button>

                  {openPromoDropdownId === pc.id && (
                    <div className="absolute right-0 top-full mt-2 w-44 bg-neutral-950 border border-neutral-800 rounded-xl shadow-2xl z-50 overflow-hidden py-1">
                      <button
                        onClick={() => { setOpenPromoDropdownId(null); openPromoEdit(pc); }}
                        className="w-full px-4 py-2.5 text-left text-xs text-neutral-300 hover:bg-neutral-900 transition-colors flex items-center gap-2"
                      >
                        <Edit2 size={13} className="text-blue-400" />
                        <span>Edit Promo</span>
                      </button>

                      <button
                        onClick={() => { setOpenPromoDropdownId(null); togglePromoCode(pc.id); }}
                        className="w-full px-4 py-2.5 text-left text-xs text-neutral-300 hover:bg-neutral-900 transition-colors flex items-center gap-2 border-t border-neutral-800/60"
                      >
                        {pc.isActive ? <PowerOff size={13} className="text-amber-400" /> : <Power size={13} className="text-emerald-400" />}
                        <span>{pc.isActive ? 'Deactivate' : 'Activate'}</span>
                      </button>

                      <button
                        onClick={() => { setOpenPromoDropdownId(null); deletePromoCode(pc.id); }}
                        className="w-full px-4 py-2.5 text-left text-xs text-rose-400 hover:bg-rose-950/20 transition-colors flex items-center gap-2 border-t border-neutral-800/60"
                      >
                        <Trash2 size={13} />
                        <span>Delete Promo</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header & Tabs */}
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div>
          <h2 className="text-xl font-bold text-neutral-100 flex items-center gap-2">
            <CalendarX2 className="text-amber-500" size={24} />
            Events & Calendar
          </h2>
          <p className="text-xs text-neutral-400 mt-1">Manage schedules, tournaments, holidays, and promo codes.</p>
        </div>
        <div className="flex items-center gap-2 bg-neutral-950 border border-neutral-800 rounded-xl p-1">
          {[
            { id: 'calendar', label: 'Calendar', icon: CalendarX2 },
            { id: 'events', label: 'Events List', icon: List },
            { id: 'promos', label: 'Promo Codes', icon: Tag },
          ].map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id as any)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${
                activeTab === t.id ? 'bg-amber-500/15 text-amber-400 border border-amber-500/20' : 'text-neutral-500 hover:text-neutral-300'
              }`}>
              <t.icon size={14} /> {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 🟢 NEW TOP-RIGHT FLOATING TOAST WITH 5S TIMER */}
      {toast && (
        <div className="fixed top-6 right-6 z-[9999] animate-in slide-in-from-top-4 fade-in duration-300">
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
          `}</style>
        </div>
      )}

      {/* Main Content Area */}
      {activeTab === 'calendar' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            {renderCalendar()}
          </div>
          <div className="space-y-4">
            
            {/* Action Required Carousel for Staff */}
            {(() => {
              const pendingActions = reservations.filter((r: any) => 
                r.status === 'pending' || 
                r.status === 'pending-refund' ||
                r.status === 'pending-reschedule'
              ).sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

              if (pendingActions.length === 0) return null;

              return (
                <div className="bg-rose-950/20 border border-rose-900/50 rounded-xl p-5 shadow-lg shadow-rose-950/20">
                  <h3 className="text-sm font-bold text-rose-400 mb-3 flex items-center gap-2"><AlertTriangle size={16} /> Action Required</h3>
                  <div className="space-y-3 max-h-64 overflow-y-auto pr-2">
                    {pendingActions.map((r: any) => (
                      <div key={r.id} className="bg-neutral-950 border border-neutral-800 rounded-lg p-3">
                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <p className="text-xs font-bold text-white">{r.customerName}</p>
                            <p className="text-[10px] text-neutral-500 font-mono">{r.id}</p>
                          </div>
                          <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                            r.status === 'pending-refund' ? 'bg-rose-900/30 text-rose-400 border-rose-800' : 
                            r.status === 'pending-reschedule' ? 'bg-violet-900/30 text-violet-400 border-violet-800' :
                            'bg-amber-900/30 text-amber-400 border-amber-800'
                          }`}>
                            {r.status === 'pending-refund' ? 'Refund Req.' : r.status === 'pending-reschedule' ? 'Resched. Req.' : 'Verify Receipt'}
                          </span>
                        </div>
                        
                        {r.status === 'pending-refund' ? (
                          <>
                            <p className="text-[10px] text-neutral-400 mb-2 leading-relaxed">
                              Needs ₱{r.downPaymentAmount?.toFixed(2) || '0.00'} GCash refund.<br/>
                              Contact: <strong className="text-amber-400 bg-amber-500/10 px-1 rounded">{r.contactNumber}</strong>
                            </p>
                            <button onClick={() => { setActionModal({ type: 'refund', reservation: r }); setCallSummary(''); setShowDenyInput(false); }} 
                              className="w-full bg-rose-600/20 hover:bg-rose-600/40 text-rose-400 border border-rose-700/50 text-[10px] font-bold py-1.5 rounded transition-colors"
                            >
                              Process Refund
                            </button>
                          </>
                        ) : r.status === 'pending-reschedule' ? (
                          <>
                            <p className="text-[10px] text-neutral-400 mb-2 leading-relaxed">
                              Requested manual reschedule.<br/>
                              Contact: <strong className="text-amber-400 bg-amber-500/10 px-1 rounded">{r.contactNumber}</strong>
                            </p>
                            <button onClick={() => { setActionModal({ type: 'reschedule', reservation: r }); setCallSummary(''); setShowDenyInput(false); }} 
                              className="w-full bg-violet-600/20 hover:bg-violet-600/40 text-violet-400 border border-violet-700/50 text-[10px] font-bold py-1.5 rounded transition-colors"
                            >
                              Process Reschedule
                            </button>
                          </>
                        ) : (
                          <>
                            <p className="text-[10px] text-neutral-400 mb-2 leading-relaxed">
                              Action: Verify GCash Payment<br/>
                              Contact: <strong className="text-amber-400 bg-amber-500/10 px-1 rounded">{r.contactNumber}</strong>
                            </p>
                            <button onClick={() => { setActionModal({ type: 'receipt', reservation: r }); setCallSummary(''); setShowDenyInput(false); }}
                              className="w-full bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border border-emerald-700/50 text-[10px] font-bold py-1.5 rounded transition-colors"
                            >
                              Review Receipt
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Upcoming Agenda */}
            <div className="bg-neutral-950 border border-neutral-800 rounded-xl overflow-hidden flex flex-col max-h-[400px]">
              <div className="px-5 py-3 border-b border-neutral-800 bg-neutral-900/50">
                <h3 className="text-xs font-bold text-neutral-300 uppercase tracking-widest">Upcoming Agenda</h3>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {allEvents.filter((e: any) => e.date && !isBefore(new Date(e.date.split(',')[0]), todayStart)).sort((a: any,b: any)=>a.date.localeCompare(b.date)).slice(0,5).map((e: any) => (
                  <div key={e.id} className="flex gap-3">
                    <div className={`w-1 rounded-full ${e.type === 'Holiday' ? 'bg-sky-500' : 'bg-amber-500'}`} />
                    <div>
                      <p className="text-xs font-semibold text-neutral-200">{format(new Date(e.date.split(',')[0]), 'MMM d, yyyy')}</p>
                      <p className={`text-[11px] font-medium ${e.type === 'Holiday' ? 'text-sky-400' : 'text-amber-400'}`}>{e.title}</p>
                    </div>
                  </div>
                ))}
                {closedDates
                  .filter((c: any) => c.type !== 'weekly' && c.date && !isNaN(new Date(c.date).getTime()) && !isBefore(new Date(c.date), todayStart))
                  .sort((a: any,b: any)=>a.date.localeCompare(b.date))
                  .slice(0,5)
                  .map((c: any) => (
                  <div key={c.id} className="flex gap-3">
                    <div className="w-1 bg-rose-500 rounded-full" />
                    <div className="flex-1 flex justify-between items-start">
                      <div>
                        <p className="text-xs font-semibold text-neutral-200">{format(new Date(c.date), 'MMM d, yyyy')}</p>
                        <p className="text-[11px] text-rose-400 font-medium">Closed: {c.reason}</p>
                      </div>
                      <button onClick={() => openClosureEdit(c)} className="text-neutral-500 hover:text-white"><Edit2 size={12}/></button>
                    </div>
                  </div>
                ))}
                {weeklyClosures.map((c: any) => {
                  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][c.dayOfWeek || 0];
                  return (
                  <div key={c.id} className="flex gap-3">
                    <div className="w-1 bg-rose-500 rounded-full" />
                    <div className="flex-1 flex justify-between items-start">
                      <div>
                        <p className="text-xs font-semibold text-neutral-200">Every {dayName}</p>
                        <p className="text-[11px] text-rose-400 font-medium">Closed: {c.reason}</p>
                      </div>
                      <button onClick={() => openClosureEdit(c)} className="text-neutral-500 hover:text-white"><Edit2 size={12}/></button>
                    </div>
                  </div>
                )})}
                {promoCodes.filter((p: any) => p.expiresAt && !isBefore(new Date(p.expiresAt), todayStart)).sort((a:any,b:any)=>a.expiresAt!.localeCompare(b.expiresAt!)).slice(0,3).map((p: any) => (
                  <div key={p.id} className="flex gap-3">
                    <div className="w-1 bg-violet-500 rounded-full" />
                    <div>
                      <p className="text-xs font-semibold text-neutral-200">{format(new Date(p.expiresAt!), 'MMM d, yyyy')}</p>
                      <p className="text-[11px] text-violet-400 font-medium">Promo Expiring: {p.code}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 🟢 UNIFIED ACTION MODAL (RECEIPTS, REFUNDS, RESCHEDULES) */}
      {actionModal && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-4 border-b border-neutral-800 flex justify-between items-center bg-neutral-900/50">
              <h3 className="font-bold text-neutral-200">
                {actionModal.type === 'receipt' ? 'Verify Receipt' : actionModal.type === 'refund' ? 'Process Refund Request' : 'Process Reschedule Request'}
              </h3>
              <button onClick={() => setActionModal(null)} className="p-1.5 text-neutral-500 hover:text-white rounded-lg transition-colors"><X size={15}/></button>
            </div>
            
            <div className="p-5 flex-1 overflow-y-auto space-y-4">
              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 text-xs text-neutral-300">
                <p><strong>Customer:</strong> {actionModal.reservation.customerName}</p>
                <p className="mt-1">
                  <strong>Contact:</strong> 
                  <span className="bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded font-bold ml-1 tracking-wider inline-flex items-center gap-1">
                    <Phone size={10}/> {actionModal.reservation.contactNumber}
                  </span>
                </p>
                {actionModal.reservation.email && <p className="mt-1"><strong>Email:</strong> {actionModal.reservation.email}</p>}
              </div>

              {actionModal.type === 'receipt' && (
                <>
                  {actionModal.reservation.receiptImg ? (
                    <div className="w-full bg-neutral-900 rounded-xl border border-neutral-800 overflow-hidden flex items-center justify-center">
                      <img src={actionModal.reservation.receiptImg} alt="Uploaded Receipt" className="max-w-full object-contain" />
                    </div>
                  ) : (
                    <div className="w-full h-32 bg-neutral-900 rounded-xl border border-neutral-800 flex items-center justify-center text-neutral-500 text-xs italic">
                      No image found.
                    </div>
                  )}
                  {showDenyInput && (
                    <div className="bg-rose-950/20 border border-rose-900/40 p-4 rounded-xl space-y-3 mt-4 animate-in slide-in-from-top-2">
                      <label className="text-xs text-rose-400 font-bold uppercase tracking-wider block">Reason for Cancellation</label>
                      <Input 
                        autoFocus
                        value={callSummary} 
                        onChange={e => setCallSummary(e.target.value)} 
                        placeholder="e.g. Invalid receipt, amount mismatch" 
                        className="bg-neutral-950 border-rose-800 text-neutral-200 text-xs h-10" 
                      />
                      <div className="flex gap-2">
                        <button onClick={() => setShowDenyInput(false)} className="flex-1 py-2 bg-neutral-900 text-neutral-400 rounded-lg text-xs font-semibold hover:bg-neutral-800 transition-colors">Back</button>
                        <button onClick={() => {
                            if (!callSummary.trim()) { flash("Cancellation reason is required.", "error"); return; }
                            updateReservation(actionModal.reservation.id, { status: 'cancelled', cancellationReason: callSummary });
                            flash("Reservation has been cancelled.");
                            setActionModal(null);
                            setShowDenyInput(false);
                            setCallSummary('');
                          }} 
                          className="flex-1 py-2 bg-rose-600 text-white rounded-lg text-xs font-bold shadow-lg hover:bg-rose-500 transition-colors"
                        >
                          Confirm Deny
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {(actionModal.type === 'refund' || actionModal.type === 'reschedule') && (
                <div className="space-y-3">
                  <div className={`p-3 rounded-lg border text-xs leading-relaxed ${actionModal.type === 'refund' ? 'bg-rose-950/20 border-rose-900/40 text-rose-300' : 'bg-violet-950/20 border-violet-900/40 text-violet-300'}`}>
                    {actionModal.type === 'refund' ? (
                       <p>Please contact the customer to manually settle the GCash refund of <strong>₱{actionModal.reservation.downPaymentAmount?.toFixed(2) || '0.00'}</strong>.</p>
                    ) : (
                       <p>Please contact the customer to manually reschedule their booking from <strong>{format(new Date(actionModal.reservation.date), 'MMM d, yyyy')}</strong> at <strong>{actionModal.reservation.timeSlot}</strong>.</p>
                    )}
                  </div>
                  <div>
                    <label className="text-xs text-neutral-400 font-bold uppercase tracking-wider block mb-2">Call Summary / Admin Notes <span className="text-rose-500">*</span></label>
                    <textarea 
                      autoFocus
                      value={callSummary} 
                      onChange={e => setCallSummary(e.target.value)} 
                      placeholder={actionModal.type === 'refund' ? "e.g. Customer requested refund via GCash. Sent ₱500 to 09123456789." : "e.g. Customer requested reschedule to Friday 8PM."} 
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-xl p-3 text-xs text-neutral-200 focus:border-amber-500 outline-none resize-none h-24" 
                    />
                  </div>
                </div>
              )}
            </div>

            {!showDenyInput && (
              <div className="p-4 border-t border-neutral-800 bg-neutral-900/50 flex gap-3">
                {actionModal.type === 'receipt' ? (
                  <>
                    <button onClick={() => setShowDenyInput(true)} className="flex-1 py-2.5 bg-neutral-800 hover:bg-rose-950/40 border border-neutral-700 hover:border-rose-800 text-rose-400 rounded-xl text-xs font-bold transition-colors">
                      Deny & Cancel
                    </button>
                    <button onClick={() => {
                        updateReservationStatus(actionModal.reservation.id, 'confirmed');
                        flash("Receipt verified and booking confirmed.");
                        setActionModal(null);
                      }} 
                      className="flex-[2] py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-emerald-900/30 transition-colors flex items-center justify-center gap-2"
                    >
                      <CheckCircle size={14}/> Verify & Approve
                    </button>
                  </>
                ) : (
                  <button onClick={() => {
                      if (!callSummary.trim()) { flash("Call summary is required to proceed.", "error"); return; }
                      if (actionModal.type === 'refund') {
                         updateReservation(actionModal.reservation.id, { status: 'cancelled', cancellationReason: `Refund Settled: ${callSummary}` });
                      } else {
                         updateReservation(actionModal.reservation.id, { status: 'confirmed', cancellationReason: `Rescheduled: ${callSummary}` });
                      }
                      flash("Marked as contacted and reservation updated successfully.");
                      setActionModal(null);
                    }} 
                    className="w-full py-2.5 bg-amber-600 hover:bg-amber-500 text-white rounded-xl text-xs font-bold shadow-lg transition-colors flex justify-center items-center gap-2"
                  >
                    <CheckCircle size={14} /> Mark as Contacted & Resolved
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'events' && renderEventsGrid()}
      {activeTab === 'promos' && renderPromosList()}

      {/* ════ MODALS ════ */}

      {/* 1. Day Action Modal */}
      {dayActionDate && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl w-full max-w-sm overflow-hidden shadow-2xl">
            <div className="p-4 border-b border-neutral-800 flex justify-between items-center bg-neutral-900/50">
              <h3 className="font-bold text-neutral-200">{format(dayActionDate, 'MMMM d, yyyy')}</h3>
              <button onClick={() => setDayActionDate(null)} className="p-1.5 text-neutral-500 hover:text-white rounded-lg transition-colors"><X size={15}/></button>
            </div>
            
            <div className="p-5 space-y-4">
              {(() => {
                const key = dateKey(dayActionDate);
                const dayEvs = eventsMap[key] || [];
                const dayPrs = promosMap[key] || [];
                const dayCls = closedMap.get(key) || weeklyClosures.find((c: any) => c.dayOfWeek === dayActionDate.getDay());
                const dayRes = resMap[key] || []; 
                const hasItems = dayEvs.length || dayPrs.length || dayCls;

                return (
                  <>
                    {hasItems ? (
                      <div className="space-y-2 mb-4 bg-neutral-900/50 rounded-lg p-3 border border-neutral-800">
                        <p className="text-[10px] uppercase tracking-widest text-neutral-500 font-semibold mb-2">Existing Agenda</p>
                        {dayCls && (
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-rose-400 font-semibold truncate pr-2">Closed: {dayCls.reason}</span>
                            <button onClick={() => openClosureEdit(dayCls)} className="text-neutral-500 hover:text-white flex-shrink-0"><Edit2 size={12}/></button>
                          </div>
                        )}
                        {dayEvs.map((e: any) => {
                          const evDates = e.date ? e.date.split(',').map((d: string) => d.trim()) : [];
                          const lastDate = [...evDates].sort((a, b) => new Date(a).getTime() - new Date(b).getTime()).pop();
                          const isPastEv = lastDate ? isBefore(new Date(lastDate), todayStart) : false;
                          const isOngoingEv = evDates.some((d: string) => isSameDay(new Date(d), new Date()));
                          const isLockedEv = e.isCancelled || isPastEv || isOngoingEv;

                          return (
                            <div key={e.id} className="flex items-center justify-between text-xs mt-2">
                              <span className={`font-semibold truncate pr-2 ${
                                e.type === 'Holiday' ? 'text-sky-400' : e.isCancelled ? 'text-neutral-500 line-through' : 'text-amber-400'
                              }`}>
                                {e.type === 'Holiday' ? '🏛️ Holiday: ' : 'Event: '} {e.title}
                              </span>
                              {e.type !== 'Holiday' && (
                                isLockedEv ? (
                                  <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-neutral-900 text-neutral-500 border border-neutral-800">
                                    {e.isCancelled ? 'Cancelled' : isPastEv ? 'Completed' : 'Ongoing'}
                                  </span>
                                ) : (
                                  <button onClick={() => openEventEdit(e)} className="text-neutral-500 hover:text-white flex-shrink-0" title="Edit Event">
                                    <Edit2 size={12}/>
                                  </button>
                                )
                              )}
                            </div>
                          );
                        })}
                        {dayPrs.map((p: any) => (
                          <div key={p.id} className="flex items-center justify-between text-xs mt-2">
                            <span className="text-violet-400 font-semibold truncate pr-2">Promo Expiry: {p.code}</span>
                            <button onClick={() => openPromoEdit(p)} className="text-neutral-500 hover:text-white flex-shrink-0"><Edit2 size={12}/></button>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {dayRes.length > 0 && (
                      <div className="space-y-2 mb-4 bg-neutral-900/50 rounded-lg p-3 border border-neutral-800">
                        <p className="text-[10px] uppercase tracking-widest text-neutral-500 font-semibold mb-2">Customer Reservations ({dayRes.length})</p>
                        <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
                          {dayRes.map((r: any) => (
                            <div key={r.id} className="bg-neutral-950 border border-neutral-800 rounded-md p-2.5 flex flex-col gap-1.5">
                              <div className="flex justify-between items-start">
                                <span className="text-xs font-semibold text-neutral-200 truncate">{r.customerName}</span>
                                <span className={`text-[8px] px-1.5 py-0.5 rounded border uppercase font-bold whitespace-nowrap ${
                                  r.status === 'confirmed' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 
                                  r.status === 'pending' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 
                                  'bg-neutral-800 text-neutral-400 border-neutral-700'
                                }`}>
                                  {r.status}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 text-[10px] text-neutral-500">
                                <span className="flex items-center gap-1"><Clock size={10}/> {r.timeSlot} ({r.durationHours}h)</span>
                                <span>·</span>
                                <span className="font-bold text-amber-400">{r.contactNumber}</span>
                                <span>·</span>
                                <span className="text-emerald-500/80 font-medium truncate">
                                  {r.tableId ? `Table ${r.tableId.replace('t', '')}` : 'Any Table'}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}

              <p className="text-[10px] uppercase tracking-widest text-neutral-500 font-semibold border-t border-neutral-800 pt-4 mt-2">Add New</p>
              
              {(() => {
                const isActionToday = isSameDay(dayActionDate, new Date());
                const isWeekend = dayActionDate.getDay() === 0 || dayActionDate.getDay() === 5 || dayActionDate.getDay() === 6;
                const openTimeStr = isWeekend ? rates?.weekendStartTime || '12:00' : rates?.weekdayStartTime || '12:00';
                const [openH, openM] = openTimeStr.split(':').map(Number);
                const openTimeDate = new Date(dayActionDate);
                openTimeDate.setHours(openH, openM, 0, 0);
                const isPastOpenTime = new Date() >= openTimeDate;

                return (
                  <div className="grid grid-cols-1 gap-2">
                    {!isActionToday && (
                      <button onClick={() => openEventCreate(dayActionDate)} className="flex items-center gap-3 p-3 rounded-lg bg-neutral-900 hover:bg-amber-500/10 border border-neutral-800 hover:border-amber-500/30 text-left transition-colors group">
                        <div className="w-8 h-8 rounded-full bg-amber-500/10 flex items-center justify-center text-amber-500 group-hover:bg-amber-500/20"><CalendarIcon size={14}/></div>
                        <div><p className="text-xs font-bold text-neutral-200">Event</p><p className="text-[10px] text-neutral-500">Tournament, league, etc.</p></div>
                      </button>
                    )}

                    {!isActionToday ? (
                      <button onClick={() => openClosureCreate(dayActionDate)} className="flex items-center gap-3 p-3 rounded-lg bg-neutral-900 hover:bg-rose-500/10 border border-neutral-800 hover:border-rose-500/30 text-left transition-colors group">
                        <div className="w-8 h-8 rounded-full bg-rose-500/10 flex items-center justify-center text-rose-500 group-hover:bg-rose-500/20"><AlertTriangle size={14}/></div>
                        <div><p className="text-xs font-bold text-neutral-200">Mark Closed</p><p className="text-[10px] text-neutral-500">Stop reservations.</p></div>
                      </button>
                    ) : (
                      <button onClick={() => openClosureCreate(dayActionDate)} className="flex items-center gap-3 p-3 rounded-lg bg-rose-950/30 hover:bg-rose-900/40 border border-rose-900/50 hover:border-rose-500/50 text-left transition-colors group">
                        <div className="w-8 h-8 rounded-full bg-rose-500/20 flex items-center justify-center text-rose-500 group-hover:bg-rose-500/30"><AlertTriangle size={14}/></div>
                        <div>
                          <p className="text-xs font-bold text-rose-400">Emergency Closure</p>
                          <p className="text-[10px] text-rose-500/80">For unforeseen forecasts {isPastOpenTime ? '(Active)' : '(Pre-open)'}</p>
                        </div>
                      </button>
                    )}

                    <button onClick={() => openPromoCreate(dayActionDate)} className="flex items-center gap-3 p-3 rounded-lg bg-neutral-900 hover:bg-violet-500/10 border border-neutral-800 hover:border-violet-500/30 text-left transition-colors group">
                      <div className="w-8 h-8 rounded-full bg-violet-500/10 flex items-center justify-center text-violet-500 group-hover:bg-violet-500/20"><Tag size={14}/></div>
                      <div><p className="text-xs font-bold text-neutral-200">Promo Code</p><p className="text-[10px] text-neutral-500">Set start/expiry for this day.</p></div>
                    </button>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* 2. Event Modal */}
      {showEventModal && (
        <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl w-full max-w-3xl overflow-hidden flex flex-col max-h-[92vh]">
            <div className="p-4 border-b border-neutral-800 flex justify-between items-center bg-neutral-950/50 flex-none">
              <h3 className="font-bold text-neutral-200">{editingEventId ? 'Edit Event' : 'Create Event'}</h3>
              <button onClick={() => setShowEventModal(false)} className="p-1.5 text-neutral-500 hover:text-white"><X size={15}/></button>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1">
              {(() => {
                const conflicts = eventForm.dates.reduce((acc, d) => acc + (resMap[d] || []).length, 0);
                if (conflicts > 0) {
                  return (
                    <div className="bg-amber-950/40 border border-amber-800/50 rounded-xl p-3 mb-4 flex items-start gap-2">
                       <AlertTriangle size={14} className="text-amber-500 mt-0.5 flex-shrink-0" />
                       <div>
                         <p className="text-[10px] font-bold text-amber-400 uppercase tracking-wider">Reservations Detected</p>
                         <p className="text-[10px] text-amber-300/80 leading-relaxed">
                           There are {conflicts} reservation(s) on the selected date(s). Creating this event won't block them automatically, but you may need to manually contact customers to reschedule or refund if tables conflict.
                         </p>
                       </div>
                    </div>
                  );
                }
                return null;
              })()}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                
                {/* Left Column: Calendar & Times */}
                <div className="space-y-5">
                  <div>
                    <label className="text-xs font-semibold text-neutral-400 block mb-2">Select Event Date(s) *</label>
                    {renderModalCalendar()}
                    {eventForm.dates.length > 0 && (
                      <p className="text-[10px] text-amber-500 mt-2 text-center font-semibold">
                        {eventForm.dates.length} day{eventForm.dates.length > 1 && 's'} selected
                      </p>
                    )}
                  </div>

                  <div className="bg-neutral-950 p-4 rounded-xl border border-neutral-800 space-y-4">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <div className={`w-9 h-5 rounded-full relative transition-colors ${eventForm.isWholeDay ? 'bg-amber-500' : 'bg-neutral-700'}`} onClick={() => setEventForm(f=>({...f, isWholeDay: !f.isWholeDay}))}>
                        <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${eventForm.isWholeDay ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </div>
                      <span className="text-xs text-neutral-300 font-medium">Whole Day Event</span>
                    </label>

                    {!eventForm.isWholeDay && (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="text-[10px] font-semibold text-neutral-400 block mb-1.5 uppercase tracking-wider flex items-center gap-1.5"><Clock size={11}/> Start Time</label>
                          <input type="time" value={eventForm.startTime} onChange={e => setEventForm({...eventForm, startTime: e.target.value})} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-amber-600/50" />
                        </div>
                        <div>
                          <label className="text-[10px] font-semibold text-neutral-400 block mb-1.5 uppercase tracking-wider flex items-center gap-1.5"><Clock size={11}/> End Time</label>
                          <input type="time" value={eventForm.endTime} onChange={e => setEventForm({...eventForm, endTime: e.target.value})} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-amber-600/50" />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 🟢 NEW TABLE SELECTOR FOR EVENT VENUE ALLOCATION WITH RESERVATIONS DISPLAY */}
                  {(eventForm.type === 'Tournament' || eventForm.type === 'League') && (
                    <div className="bg-neutral-950 p-4 rounded-xl border border-amber-900/30 space-y-4">
                      <div className="flex justify-between items-center">
                        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest flex items-center gap-1.5">
                          <SlidersHorizontal size={12}/> Select Tables for Event
                        </p>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {tables.filter((t:any) => t.isActive).map((table:any) => {
                          const isSelected = eventForm.selectedTableIds.includes(table.id);
                          return (
                            <button
                              type="button"
                              key={table.id}
                              onClick={() => {
                                setEventForm(prev => {
                                  const s = new Set(prev.selectedTableIds);
                                  if (s.has(table.id)) s.delete(table.id);
                                  else s.add(table.id);
                                  return { ...prev, selectedTableIds: Array.from(s) };
                                })
                              }}
                              className={`p-2 rounded-lg text-xs font-bold border transition-colors ${isSelected ? 'bg-amber-500 text-neutral-950 border-amber-500' : 'bg-neutral-900 text-neutral-400 border-neutral-800'}`}
                            >
                              {table.name}
                            </button>
                          )
                        })}
                      </div>

                      {/* Show Reservations for Selected Tables */}
                      {eventForm.selectedTableIds.length > 0 && eventForm.dates.length > 0 && (
                        <div className="mt-4 bg-neutral-900 border border-neutral-800 rounded-xl p-3 max-h-40 overflow-y-auto">
                           <p className="text-[10px] font-bold text-neutral-400 uppercase mb-2">Existing Reservations on Selected Tables</p>
                           {eventForm.selectedTableIds.map(tId => {
                              const tableReservations = eventForm.dates.flatMap(d => (resMap[d] || []).filter((r:any) => r.tableId === tId && r.status !== 'cancelled'));
                              if (tableReservations.length === 0) return null;
                              return (
                                 <div key={tId} className="mb-2 last:mb-0">
                                    <p className="text-xs text-amber-500 font-semibold mb-1">Table {tId.replace('t','')}</p>
                                    {tableReservations.map((r:any) => (
                                       <div key={r.id} className="text-[10px] text-neutral-300 flex justify-between bg-neutral-950 p-1.5 rounded border border-neutral-800 mb-1">
                                          <span>{format(new Date(r.date), 'MMM d')} - {r.timeSlot} ({r.durationHours}h)</span>
                                          <span className="text-neutral-500">{r.customerName}</span>
                                       </div>
                                    ))}
                                 </div>
                              );
                           })}
                           {eventForm.selectedTableIds.every(tId => eventForm.dates.flatMap(d => (resMap[d] || []).filter((r:any) => r.tableId === tId && r.status !== 'cancelled')).length === 0) && (
                              <p className="text-xs text-neutral-500 italic">No conflicting reservations on selected dates.</p>
                           )}
                        </div>
                      )}

                      <p className="text-[9px] text-neutral-500 italic">
                        Selected tables will be automatically locked and reserved in the database for the event's duration upon saving.
                      </p>
                    </div>
                  )}

                </div>

                {/* Right Column: Event Details */}
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between items-center mb-1.5">
                      <label className="text-xs font-semibold text-neutral-400">Event Title *</label>
                      <CharCount current={eventForm.title} max={50} />
                    </div>
                    <Input maxLength={50} value={eventForm.title} onChange={e => setEventForm({...eventForm, title: e.target.value})} placeholder="e.g. 8-Ball Championship" className="bg-neutral-950 border-neutral-800" />
                  </div>
                  
                  <div>
                    <label className="text-xs font-semibold text-neutral-400 block mb-1.5">Event Type</label>
                    <select className="w-full h-10 px-3 bg-neutral-950 border border-neutral-800 rounded-md text-sm text-neutral-200 focus:outline-none focus:border-amber-500" value={eventForm.type} onChange={e => setEventForm({...eventForm, type: e.target.value})}>
                      {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>

                  <div>
                    <div className="flex justify-between items-center mb-1.5">
                      <label className="text-xs font-semibold text-neutral-400">Description <span className="text-rose-500">*</span></label>
                      <CharCount current={eventForm.description} max={400} />
                    </div>
                    <textarea maxLength={400} value={eventForm.description} onChange={e => setEventForm({...eventForm, description: e.target.value})} className="w-full bg-neutral-950 border border-neutral-800 rounded-md p-3 text-sm text-neutral-200 h-24 resize-none focus:outline-none focus:border-amber-500" placeholder="Event details..." />
                  </div>

                  {eventForm.type === 'Tournament' && (
                    <div className="p-4 rounded-xl border border-emerald-900/30 bg-emerald-950/10 space-y-3">
                      <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">Tournament Links</p>
                      <div>
                        <label className="text-[10px] font-semibold text-neutral-400 block mb-1.5 flex items-center gap-1.5"><Link size={10} /> Registration / Form Link <span className="text-rose-500">*</span></label>
                        <Input value={eventForm.registrationLink} onChange={e => setEventForm({...eventForm, registrationLink: e.target.value})} placeholder="https://forms.google.com/..." className="bg-neutral-950 border-neutral-800 h-8 text-xs" />
                      </div>
                      <div>
                        <label className="text-[10px] font-semibold text-neutral-400 block mb-1.5 flex items-center gap-1.5"><Network size={10} /> Live Bracket Link <span className="text-rose-500">*</span></label>
                        <Input value={eventForm.bracketLink} onChange={e => setEventForm({...eventForm, bracketLink: e.target.value})} placeholder="https://challonge.com/..." className="bg-neutral-950 border-neutral-800 h-8 text-xs" />
                      </div>
                    </div>
                  )}

                  <div className={`grid ${editingEventId ? 'grid-cols-2' : 'grid-cols-1'} gap-4`}>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs font-semibold text-neutral-400 block mb-1.5 flex items-center gap-1.5">
                          <Users size={11} /> Min Pax {(eventForm.type === 'Tournament' || eventForm.type === 'League') && <span className="text-rose-500">*</span>}
                        </label>
                        <Input
                          type="text"
                          inputMode="numeric"
                          maxLength={2}
                          value={eventForm.minParticipants}
                          onChange={e => {
                            const cleanDigits = e.target.value.replace(/\D/g, '').slice(0, 2);
                            const num = parseInt(cleanDigits, 10);
                            const val = !isNaN(num) && num >= 100 ? '99' : cleanDigits;
                            setEventForm({ ...eventForm, minParticipants: val });
                          }}
                          placeholder="8"
                          className="bg-neutral-950 border-neutral-800"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-neutral-400 block mb-1.5 flex items-center gap-1.5">
                          <Users size={11} /> Max Pax {(eventForm.type === 'Tournament' || eventForm.type === 'League') && <span className="text-rose-500">*</span>}
                        </label>
                        <Input
                          type="text"
                          inputMode="numeric"
                          maxLength={2}
                          value={eventForm.maxParticipants}
                          onChange={e => {
                            const cleanDigits = e.target.value.replace(/\D/g, '').slice(0, 2);
                            const num = parseInt(cleanDigits, 10);
                            const val = !isNaN(num) && num >= 100 ? '99' : cleanDigits;
                            setEventForm({ ...eventForm, maxParticipants: val });
                          }}
                          placeholder="32"
                          className="bg-neutral-950 border-neutral-800"
                        />
                      </div>
                    </div>
                    {editingEventId && (
                      <div>
                        <label className="text-xs font-semibold text-neutral-400 block mb-1.5">Slots Status</label>
                        <button type="button" onClick={() => setEventForm(prev => ({ ...prev, slotsFull: !prev.slotsFull }))} className={`flex items-center gap-2 w-full h-10 px-3 rounded-md border text-sm font-semibold transition-all ${eventForm.slotsFull ? 'bg-rose-950/40 border-rose-700/50 text-rose-400' : 'bg-neutral-950 border-neutral-800 text-neutral-500'}`}>
                          {eventForm.slotsFull ? <ToggleRight size={18} className="text-rose-400" /> : <ToggleLeft size={18} />} {eventForm.slotsFull ? 'Slots Full' : 'Open'}
                        </button>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-neutral-400 block mb-2 flex items-center gap-1.5">
                      <Paperclip size={11} /> Attachments / Images
                    </label>
                    <div className="space-y-2">
                      {eventForm.attachments.length > 0 && (
                        <div className="space-y-1.5">
                          {eventForm.attachments.map((att, i) => (
                            <div key={i} className="flex items-center gap-2 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2">
                              {isImage(att) ? <img src={att} alt="" className="w-8 h-8 object-cover rounded flex-shrink-0" /> : <Paperclip size={14} className="text-neutral-500 flex-shrink-0" />}
                              <span className="text-xs text-neutral-400 truncate flex-1">{getFileName(att, i)}</span>
                              <button type="button" onClick={() => removeAttachment(i)} className="p-1 text-neutral-600 hover:text-rose-400"><X size={12} /></button>
                            </div>
                          ))}
                        </div>
                      )}
                      <button type="button" onClick={() => fileInputRef.current?.click()} className="w-full flex items-center justify-center gap-2 py-2.5 border border-dashed border-neutral-700 rounded-lg text-xs text-neutral-500 hover:border-amber-600/50 hover:text-amber-500 transition-colors">
                        <Paperclip size={13} /> Upload File
                      </button>
                      <input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,.doc,.docx" onChange={handleFileChange} className="hidden" />
                    </div>
                  </div>

                </div>
              </div>
            </div>
            <div className="p-4 border-t border-neutral-800 flex justify-end gap-3 bg-neutral-950/50 flex-none">
              <Button variant="ghost" onClick={() => setShowEventModal(false)}>Cancel</Button>
              <Button className="bg-amber-600 hover:bg-amber-500 text-white" onClick={saveEvent}>{editingEventId ? 'Save Changes' : 'Create Event'}</Button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Closure Modal */}
      {showClosureModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-rose-900/30 rounded-2xl w-full max-w-sm shadow-2xl">
            {(() => {
              const isActionToday = isSameDay(new Date(closureDateStr), new Date());
              return (
                <>
                  <div className="px-6 py-4 border-b border-neutral-800 flex justify-between items-center">
                    <div>
                      <h2 className="text-base font-bold text-neutral-100">{editingClosureId ? 'Edit Closure' : isActionToday ? 'Emergency Closure' : 'Mark as Closed'}</h2>
                      <p className="text-xs text-neutral-500">
                        {closureForm.type === 'weekly' 
                          ? `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][closureForm.dayOfWeek]}`
                          : (closureDateStr && !isNaN(new Date(closureDateStr).getTime()) ? format(new Date(closureDateStr), 'EEEE, MMMM d, yyyy') : '')}
                      </p>
                    </div>
                    <button onClick={() => setShowClosureModal(false)} className="p-2 text-neutral-500 hover:text-white"><X size={16} /></button>
                  </div>
                  <form onSubmit={saveClosure} className="p-6 space-y-4">
                    
                    {(() => {
                      const conflicts = resMap[closureDateStr] || [];
                      if (conflicts.length > 0) {
                        return (
                          <div className="bg-rose-950/40 border border-rose-800/50 rounded-xl p-4 space-y-3 mb-2">
                            <div className="flex items-center gap-2 text-rose-400 font-bold text-sm">
                              <AlertTriangle size={16} />
                              <span>{conflicts.length} Reservation{conflicts.length > 1 ? 's' : ''} Affected</span>
                            </div>
                            <p className="text-xs text-rose-300/80 leading-relaxed mb-3">
                              Closing this date conflicts with active customer reservations. Please contact them below to initiate manual rescheduling or refunds.
                            </p>
                            <div className="space-y-2 max-h-32 overflow-y-auto pr-1">
                               {conflicts.map((r: any) => (
                                 <div key={r.id} className="bg-rose-950/50 border border-rose-900/50 p-2.5 rounded-lg">
                                   <p className="text-xs font-bold text-white mb-0.5">{r.customerName}</p>
                                   <div className="flex flex-col text-[10px] text-rose-300/80 gap-0.5">
                                      <a href={`tel:${r.contactNumber}`} className="hover:text-white flex items-center gap-1"><span className="text-rose-500">📞</span> {r.contactNumber}</a>
                                      {r.email && <a href={`mailto:${r.email}`} className="hover:text-white flex items-center gap-1"><span className="text-rose-500">✉️</span> {r.email}</a>}
                                      <span className="text-neutral-500 mt-1">{r.timeSlot} ({r.durationHours}h) - Table {r.tableId?.replace('t','')}</span>
                                   </div>
                                 </div>
                               ))}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })()}

                    {!isActionToday && (
                      <div className="bg-neutral-900 p-1 rounded-lg flex mb-4 border border-neutral-800">
                        <button type="button" onClick={() => setClosureForm(f => ({ ...f, type: 'specific' }))} className={`flex-1 text-xs py-1.5 rounded-md font-semibold transition-colors ${closureForm.type === 'specific' ? 'bg-rose-600 text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}>Specific Date</button>
                        <button type="button" onClick={() => setClosureForm(f => ({ ...f, type: 'weekly' }))} className={`flex-1 text-xs py-1.5 rounded-md font-semibold transition-colors ${closureForm.type === 'weekly' ? 'bg-rose-600 text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}>Every {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(closureDateStr).getDay()]}</button>
                      </div>
                    )}

                    <div>
                      <div className="flex justify-between items-center mb-1.5">
                        <label className="text-xs text-neutral-400 font-medium">Reason *</label>
                        <CharCount current={closureForm.reason} max={50} />
                      </div>
                      <input type="text" maxLength={50} value={closureForm.reason} onChange={e => setClosureForm(f=>({...f,reason:e.target.value}))} required autoFocus className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:border-rose-500" placeholder={isActionToday ? "e.g. Bad Weather, Power Outage" : "e.g. Holiday, Private Event"} />
                    </div>
                    
                    {!isActionToday && (
                      <>
                        <label className="flex items-center gap-3 cursor-pointer">
                          <div className={`w-10 h-5 rounded-full relative transition-colors ${closureForm.isFullDay ? 'bg-rose-700' : 'bg-neutral-700'}`} onClick={() => setClosureForm(f=>({...f, isFullDay: !f.isFullDay}))}>
                            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${closureForm.isFullDay ? 'translate-x-5' : 'translate-x-0.5'}`} />
                          </div>
                          <span className="text-xs text-neutral-300 font-medium">Full day closure</span>
                        </label>
                        {!closureForm.isFullDay && (
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold block mb-1">Open Time</label>
                              <input type="time" value={closureForm.openTime} onChange={e => setClosureForm(f=>({...f,openTime:e.target.value}))} className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:border-rose-500" />
                            </div>
                            <div>
                              <label className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold block mb-1">Close Time</label>
                              <input type="time" value={closureForm.closeTime} onChange={e => setClosureForm(f=>({...f,closeTime:e.target.value}))} className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:border-rose-500" />
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {isActionToday && (
                       <div className="bg-rose-950/20 border border-rose-900/40 p-3 rounded-lg flex items-start gap-2">
                          <AlertTriangle size={14} className="text-rose-500 flex-shrink-0 mt-0.5" />
                          <p className="text-[10px] text-rose-400 leading-relaxed">This emergency closure will instantly block all online reservations for the remainder of the day.</p>
                       </div>
                    )}

                    <div className="flex gap-2 pt-2">
                      {editingClosureId && (
                        <button type="button" onClick={() => { removeClosedDate(editingClosureId); setShowClosureModal(false); flash('Closure deleted.'); }} className="px-3 py-2.5 bg-rose-950/40 hover:bg-rose-900/50 text-rose-400 border border-rose-800/50 text-sm rounded-xl transition-colors"><Trash2 size={16} /></button>
                      )}
                      <button type="button" onClick={() => setShowClosureModal(false)} className="flex-1 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl transition-colors">Cancel</button>
                      <button type="submit" className="flex-[2] bg-rose-600 hover:bg-rose-500 text-white text-sm rounded-xl font-semibold py-2.5 transition-colors">Save</button>
                    </div>
                  </form>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* 4. Promo Code Modal */}
      {showPromoModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-violet-900/30 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-neutral-800 flex justify-between items-center bg-neutral-950">
              <div>
                <h2 className="text-base font-bold text-neutral-100">{editingPromoId ? 'Edit Promo' : 'Create Promo Code'}</h2>
                <p className="text-xs text-neutral-500">Standalone discount code</p>
              </div>
              <button onClick={() => setShowPromoModal(false)} className="p-2 text-neutral-500 hover:text-white"><X size={16} /></button>
            </div>
            <form onSubmit={preparePromoSave} className="p-6 space-y-5">
              
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs text-neutral-400 font-medium">Promo Code *</label>
                  <CharCount current={promoForm.code} max={15} />
                </div>
                <div className="flex gap-2">
                  <input required maxLength={15} value={promoForm.code} onChange={e => setPromoForm(f=>({...f, code: e.target.value.toUpperCase().replace(/\s/g, '')}))} placeholder="CODE (e.g. SUMMER20)" className="flex-1 bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 font-mono tracking-wider focus:outline-none focus:border-violet-500" />
                  <button type="button" onClick={() => setPromoForm(f=>({...f, code: generateRandomPromoCode()}))} className="px-3 bg-violet-600/20 text-violet-400 rounded-lg hover:bg-violet-600/30"><Wand2 size={15} /></button>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-neutral-400 block mb-1.5 flex justify-between">
                  <span>Discount Percentage *</span>
                  {promoForm.discountPercent > 50 && <span className="text-[10px] text-rose-500 font-bold bg-rose-500/10 px-1.5 py-0.5 rounded">High Discount Warning</span>}
                </label>
                <div className="flex items-center gap-3">
                  <input type="range" min={5} max={100} step={5} value={promoForm.discountPercent} onChange={e => setPromoForm(f=>({...f, discountPercent: parseInt(e.target.value)}))} 
                    className={`flex-1 ${promoForm.discountPercent > 50 ? 'accent-rose-500' : 'accent-violet-500'}`} />
                  <span className={`text-xl font-black w-14 text-right ${promoForm.discountPercent > 50 ? 'text-rose-500' : 'text-violet-400'}`}>{promoForm.discountPercent}%</span>
                </div>
              </div>

              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs text-neutral-400 font-medium">Description *</label>
                  <CharCount current={promoForm.description} max={60} />
                </div>
                <input required maxLength={60} value={promoForm.description} onChange={e => setPromoForm(f=>({...f, description: e.target.value}))} placeholder="e.g. 20% off weekend nights" className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-violet-500" />
              </div>

              <div className="p-4 rounded-xl border border-violet-900/30 bg-violet-950/10 space-y-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <div className={`w-9 h-5 rounded-full relative transition-colors ${promoForm.isLimitedUses ? 'bg-violet-600' : 'bg-neutral-700'}`} onClick={() => setPromoForm(f=>({...f, isLimitedUses: !f.isLimitedUses}))}>
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${promoForm.isLimitedUses ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </div>
                  <span className="text-xs text-neutral-300 font-medium">Limit number of uses</span>
                </label>
                
                {promoForm.isLimitedUses && (
                  <div className="pl-12 space-y-3">
                    <div>
                      <label className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold block mb-1">Max Uses</label>
                      <input type="number" min={1} value={promoForm.maxUsage} onChange={e => setPromoForm(f=>({...f, maxUsage: parseInt(e.target.value)||1}))} className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-1.5 text-sm text-neutral-200 focus:outline-none focus:border-violet-500" />
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${promoForm.deleteWhenDepleted ? 'bg-rose-600 border-rose-500' : 'bg-neutral-900 border-neutral-700'}`} onClick={() => setPromoForm(f=>({...f, deleteWhenDepleted: !f.deleteWhenDepleted}))}>
                        {promoForm.deleteWhenDepleted && <CheckCircle size={10} className="text-white" />}
                      </div>
                      <span className="text-[11px] text-neutral-400 font-medium">Auto-delete when depleted</span>
                    </label>
                  </div>
                )}
              </div>

              <div className="space-y-4 p-4 rounded-xl border border-neutral-800 bg-neutral-900/50">
                <div>
                  <label className="flex items-center gap-3 cursor-pointer mb-2">
                    <div className={`w-9 h-5 rounded-full relative transition-colors ${promoForm.hasStart ? 'bg-violet-600' : 'bg-neutral-700'}`} onClick={() => setPromoForm(f=>({...f, hasStart: !f.hasStart}))}>
                      <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${promoForm.hasStart ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </div>
                    <span className="text-xs text-neutral-300 font-medium">Set Start Date</span>
                  </label>
                  {promoForm.hasStart && (
                    <input type="datetime-local" value={promoForm.startDate} onChange={e => setPromoForm(f=>({...f, startDate: e.target.value}))} className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-violet-500" />
                  )}
                </div>

                <div>
                  <label className="flex items-center gap-3 cursor-pointer mb-2">
                    <div className={`w-9 h-5 rounded-full relative transition-colors ${promoForm.hasExpiry ? 'bg-violet-600' : 'bg-neutral-700'}`} onClick={() => setPromoForm(f=>({...f, hasExpiry: !f.hasExpiry}))}>
                      <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${promoForm.hasExpiry ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </div>
                    <span className="text-xs text-neutral-300 font-medium">Set Expiry Date</span>
                  </label>
                  {promoForm.hasExpiry && (
                    <input type="datetime-local" min={promoForm.hasStart && promoForm.startDate ? promoForm.startDate : undefined} value={promoForm.expiresAt} onChange={e => setPromoForm(f=>({...f, expiresAt: e.target.value}))} className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-violet-500" />
                  )}
                </div>
              </div>

              <div className="flex gap-3 pt-2 border-t border-neutral-800">
                <button type="button" onClick={() => setShowPromoModal(false)} className="px-4 py-2.5 bg-neutral-800 text-neutral-300 text-sm rounded-xl transition-colors">Cancel</button>
                <button type="submit" className="flex-1 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-xl font-semibold py-2.5 shadow-lg shadow-violet-900/30 transition-colors">Review & Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 5. Promo Confirmation Modal */}
      {showPromoConfirm && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-violet-900/50 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-neutral-900/80 border-b border-neutral-800 px-6 py-4 flex items-center justify-between">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Tag size={16} className="text-violet-400" /> Confirm Promo Details
              </h3>
            </div>
            <div className="p-6 space-y-4">
              <div className="space-y-3 text-sm text-neutral-300">
                 <div className="flex justify-between border-b border-neutral-800/60 pb-2">
                   <span className="text-neutral-500">Code</span>
                   <span className="font-mono font-bold text-white tracking-widest">{promoForm.code.toUpperCase()}</span>
                 </div>
                 <div className="flex justify-between border-b border-neutral-800/60 pb-2">
                   <span className="text-neutral-500">Discount</span>
                   <span className={`font-bold ${promoForm.discountPercent > 50 ? 'text-rose-400' : 'text-violet-400'}`}>{promoForm.discountPercent}% OFF</span>
                 </div>
                 <div className="flex justify-between border-b border-neutral-800/60 pb-2">
                   <span className="text-neutral-500">Usage Limit</span>
                   <span>{promoForm.isLimitedUses ? `${promoForm.maxUsage} uses` : 'Unlimited'}</span>
                 </div>
                 {promoForm.hasStart && (
                   <div className="flex justify-between border-b border-neutral-800/60 pb-2">
                     <span className="text-neutral-500">Starts</span>
                     <span>{format(new Date(promoForm.startDate), 'MMM d, yyyy h:mm a')}</span>
                   </div>
                 )}
                 {promoForm.hasExpiry && (
                   <div className="flex justify-between border-b border-neutral-800/60 pb-2">
                     <span className="text-neutral-500">Expires</span>
                     <span>{format(new Date(promoForm.expiresAt), 'MMM d, yyyy h:mm a')}</span>
                   </div>
                 )}
              </div>
              
              {promoForm.discountPercent > 50 && (
                <div className="bg-rose-950/30 border border-rose-900/50 rounded-lg p-3 flex gap-2">
                  <AlertTriangle size={14} className="text-rose-500 flex-shrink-0 mt-0.5" />
                  <p className="text-[10px] text-rose-300">You are about to issue a highly discounted promo code ({promoForm.discountPercent}%). Please ensure this is intended.</p>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowPromoConfirm(false)} className="px-4 py-2.5 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 text-sm rounded-xl transition-colors border border-neutral-800">Back to Edit</button>
                <button type="button" onClick={executePromoSave} className="flex-1 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-xl font-semibold py-2.5 shadow-lg shadow-violet-900/30 transition-colors">Confirm & Publish</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* 🟢 NEW: Cancel Event Confirmation Modal */}
      {cancelEventModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-neutral-950 border border-rose-900/50 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-2 text-rose-400 font-bold text-sm border-b border-neutral-800 pb-3">
              <AlertTriangle size={18} className="text-rose-500" />
              <span>Confirm Event Cancellation</span>
            </div>
            
            <p className="text-xs text-neutral-300 leading-relaxed">
              You are about to cancel <strong className="text-white">"{cancelEventModal.title}"</strong> scheduled for <strong className="text-amber-400">{cancelEventModal.date}</strong>.
            </p>

            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-3.5 space-y-1 text-xs text-neutral-400">
              <p className="font-bold text-neutral-200">What happens when an event is canceled?</p>
              <ul className="list-disc list-inside space-y-1 text-[11px] text-neutral-400 pl-1 pt-1">
                <li>Allocated tournament tables will be instantly released back into the public inventory.</li>
                <li>Online bookings and walk-ins will be re-enabled for those tables.</li>
                <li>External participant notifications must be handled via your registration platform.</li>
              </ul>
            </div>

            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold block mb-1">Reason for Cancellation</label>
              <select
                value={eventCancelReason}
                onChange={e => setEventCancelReason(e.target.value)}
                className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2 text-xs text-neutral-200 outline-none focus:border-rose-500"
              >
                <option value="Schedule conflict / unforeseen circumstances">Schedule conflict / unforeseen circumstances</option>
                <option value="Insufficient participant registrations">Insufficient participant registrations</option>
                <option value="Venue maintenance / hardware issue">Venue maintenance / hardware issue</option>
                <option value="Emergency closure / bad weather">Emergency closure / bad weather</option>
              </select>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setCancelEventModal(null)}
                className="flex-1 py-2.5 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-xl text-xs font-semibold transition-colors border border-neutral-800"
              >
                Keep Event
              </button>
              <button
                type="button"
                onClick={async () => {
                  updateEvent(cancelEventModal.id, { 
                    isCancelled: true, 
                    cancelReason: eventCancelReason,
                    eventTableIds: []
                  });
                  // Also cancel associated reservations tag
                  const { error } = await supabase.from('reservations').update({ status: 'cancelled', cancellationReason: `Event Cancelled: ${eventCancelReason}` }).eq('paymentRef', 'EVENT').like('id', `%EVT-%`);
                  if(error) console.error("Failed to cancel event tags", error);

                  setCancelEventModal(null);
                  flash(`Event "${cancelEventModal.title}" marked as cancelled and tables released.`);
                }}
                className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold transition-colors shadow-lg shadow-rose-950/40"
              >
                Confirm Cancellation
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}