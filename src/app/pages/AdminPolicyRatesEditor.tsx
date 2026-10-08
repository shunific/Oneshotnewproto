import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { PesoSign } from '../components/PesoSign';
import { 
  Save, Clock, DollarSign, AlertCircle, ShieldCheck, 
  FileText, ToggleLeft, ToggleRight, X,
  ShieldAlert, AlertTriangle, CheckCircle, Lock
} from 'lucide-react';
import { supabase } from '../utils/supabase';

export default function AdminPolicyRatesEditor() {
  const { rates, reservationTerms, updateRates, updateReservationTerms, theme, isSystemOffline, tables } = useAppContext() as any;

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const activeTablesCount = useMemo(() => {
    if (!tables || !Array.isArray(tables)) return 0;
    return tables.filter((t: any) => t.isActive && t.status !== 'maintenance').length;
  }, [tables]);

  const [ratesForm, setRatesForm] = useState({ 
    ...rates,
    downPaymentPercent: rates.downPaymentPercent ?? 50,
    overtimeRate: rates.overtimeRate ?? rates.hourlyRate ?? 0,
  });
  
  const [termsForm, setTermsForm] = useState({
    ...reservationTerms,
    weekdayMinPartySize: reservationTerms.weekdayMinPartySize ?? 1,
    weekdayMaxPartySize: reservationTerms.weekdayMaxPartySize ?? 8,
    weekendMinPartySize: reservationTerms.weekendMinPartySize ?? 1,
    weekendMaxPartySize: reservationTerms.weekendMaxPartySize ?? 8,
    cancellationHours: reservationTerms.cancellationHours ?? 24
  });
  
  const [showSummaryModal, setShowSummaryModal] = useState(false);

  const [toast, setToast] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  const toastTimeout = useRef<NodeJS.Timeout | null>(null);

  const flash = (msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToast({ msg, type });
    toastTimeout.current = setTimeout(() => setToast(null), 5000);
  };

  const [gracePeriodMins, setGracePeriodMins] = useState(15);

  // INITIAL DUAL-FETCH ON MOUNT WITH WATCHDOG
  useEffect(() => {
    let isMounted = true;
    const fetchPoliciesAndRates = async () => {
      setIsLoading(true);

      const timeoutId = setTimeout(() => {
        if (isMounted && (!navigator.onLine || isSystemOffline)) {
          flash("Cloud unreachable: Running on local SQLite database snapshot.", "error");
        }
      }, 5000);

      try {
        const [localRes, cloudRes] = await Promise.allSettled([
          fetch('http://localhost:3001/api/settings/rates').then(r => r.ok ? r.json() : null),
          supabase.from('system_settings').select('*').then(res => res.data || null)
        ]);

        let mergedSettings: any = {};

        if (cloudRes.status === 'fulfilled' && cloudRes.value) {
          const cloudObj = cloudRes.value.reduce((acc: any, curr: any) => {
            let val = curr.setting_value || curr.settingValue;
            if (val === 'true') val = true;
            else if (val === 'false') val = false;
            else if (!isNaN(val) && val.trim() !== '' && !val.includes(':')) val = Number(val);
            acc[curr.key_name || curr.keyName] = val;
            return acc;
          }, {});
          mergedSettings = { ...mergedSettings, ...cloudObj };
        }

        if (localRes.status === 'fulfilled' && localRes.value) {
          mergedSettings = { ...mergedSettings, ...localRes.value };
        }

        if (isMounted && Object.keys(mergedSettings).length > 0) {
          setRatesForm(prev => ({ 
            ...prev, 
            ...mergedSettings,
            downPaymentPercent: mergedSettings.downPaymentPercent ?? 50,
            overtimeRate: mergedSettings.overtimeRate ?? mergedSettings.hourlyRate ?? 0
          }));
          setTermsForm(prev => ({ ...prev, ...mergedSettings }));
        }
      } catch (err) {
        if (isMounted) {
          flash("Configured from local database.", "error");
        }
      } finally {
        clearTimeout(timeoutId);
        if (isMounted) {
          setTimeout(() => setIsLoading(false), 300);
        }
      }
    };

    fetchPoliciesAndRates();
    return () => { isMounted = false; };
  }, [isSystemOffline]);

  const parseToMins = (t: string) => {
    if (!t || !t.includes(':')) return 0;
    const [hh = '0', mm = '0'] = t.split(':');
    return Number(hh) * 60 + Number(mm || 0);
  };

  const fmt12 = (tOrMins: string | number) => {
    try {
      let mins: number;
      if (typeof tOrMins === 'number') mins = tOrMins;
      else {
        if (!tOrMins || typeof tOrMins !== 'string') return '—';
        const [hh = '0', mm = '0'] = tOrMins.split(':');
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

  const bookingWindowDisplay = (start: string, end: string) => {
    try {
      const s = parseToMins(start || '12:00');
      let e = parseToMins(end || '02:00');
      if (e <= s) e += 24 * 60;
      const cutoff = e - 60; 
      if (cutoff <= s) return 'No online bookings';
      return `${fmt12(start || '12:00')} to ${fmt12(cutoff)}`;
    } catch (e) {
      return `${start || '12:00'} to ${end || '02:00'}`;
    }
  };

  const handleRatesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type } = e.target;
    setRatesForm(prev => ({ ...prev, [name]: type === 'range' ? Number(value) : value }));
  };

  const handleRateInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    const cleanDigits = value.replace(/\D/g, '').slice(0, 4);
    const numericValue = cleanDigits === '' ? 0 : Number(cleanDigits);
    
    setRatesForm(prev => {
      const next = { ...prev, [name]: numericValue };
      if (name === 'hourlyRate') {
        next.overtimeRate = numericValue;
      }
      return next;
    });
  };

  const handleHourInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    const cleanDigits = value.replace(/\D/g, '').slice(0, 3);
    const numericValue = cleanDigits === '' ? 0 : Number(cleanDigits);
    setTermsForm(prev => ({ ...prev, [name]: numericValue }));
  };

  const handlePartySizeInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    const cleanDigits = value.replace(/\D/g, '').slice(0, 2);
    setTermsForm(prev => ({ ...prev, [name]: cleanDigits === '' ? 0 : Number(cleanDigits) }));
  };

  const handleDownPaymentInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    const cleanDigits = value.replace(/\D/g, '').slice(0, 3);
    let num = cleanDigits === '' ? 0 : Number(cleanDigits);
    if (num > 100) num = 100;
    setRatesForm(prev => ({ ...prev, [name]: num }));
  };

  const handleTermsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setTermsForm(prev => ({ ...prev, [name]: value }));
  };

  const handleReviewChanges = () => {
    const hr = Number(ratesForm.hourlyRate) || 0;
    const ov = Number(ratesForm.overtimeRate) || 0;
    const dp = Number(ratesForm.downPaymentPercent) || 0;
    const minWkDay = Number(termsForm.weekdayMinPartySize) || 0;
    const maxWkDay = Number(termsForm.weekdayMaxPartySize) || 0;
    const minWkEnd = Number(termsForm.weekendMinPartySize) || 0;
    const maxWkEnd = Number(termsForm.weekendMaxPartySize) || 0;
    const cancelHrs = Number(termsForm.cancellationHours) || 0;

    if (hr <= 0) { flash('Standard Hourly Rate must be greater than ₱0.', 'error'); return; }
    if (ov <= 0) { flash('Overtime Rate must be greater than ₱0.', 'error'); return; }
    if (hr > 5000) { flash('Standard Hourly Rate cannot exceed ₱5,000/hr.', 'error'); return; }
    if (ov > 5000) { flash('Overtime Rate cannot exceed ₱5,000/hr.', 'error'); return; }

    if (dp < 0 || dp > 100) { flash('Down payment percentage must be between 0% and 100%.', 'error'); return; }

    if (ratesForm.weekdayStartTime === ratesForm.weekdayEndTime) {
      flash('Weekday opening and closing times cannot be identical.', 'error'); return;
    }
    if (ratesForm.weekendStartTime === ratesForm.weekendEndTime) {
      flash('Weekend opening and closing times cannot be identical.', 'error'); return;
    }

    if (ratesForm.isWeekdayHappyHourActive) {
      const wkHHRate = Number(ratesForm.weekdayHappyHourRate) || 0;
      if (wkHHRate <= 0) { flash('Weekday Happy Hour Rate must be greater than ₱0.', 'error'); return; }
      if (ratesForm.weekdayHappyHourStart === ratesForm.weekdayHappyHourEnd) {
        flash('Weekday Happy Hour start and end times cannot be identical.', 'error'); return;
      }
    }
    if (ratesForm.isWeekendHappyHourActive) {
      const weHHRate = Number(ratesForm.weekendHappyHourRate) || 0;
      if (weHHRate <= 0) { flash('Weekend Happy Hour Rate must be greater than ₱0.', 'error'); return; }
      if (ratesForm.weekendHappyHourStart === ratesForm.weekendHappyHourEnd) {
        flash('Weekend Happy Hour start and end times cannot be identical.', 'error'); return;
      }
    }

    if (minWkDay <= 0 || maxWkDay <= 0) { flash('Weekday party sizes must be at least 1 person.', 'error'); return; }
    if (minWkDay > maxWkDay) { flash(`Weekday Min party size (${minWkDay}) cannot exceed Max (${maxWkDay}).`, 'error'); return; }
    if (minWkEnd <= 0 || maxWkEnd <= 0) { flash('Weekend party sizes must be at least 1 person.', 'error'); return; }
    if (minWkEnd > maxWkEnd) { flash(`Weekend Min party size (${minWkEnd}) cannot exceed Max (${maxWkEnd}).`, 'error'); return; }

    if (cancelHrs > 168) { flash('Cancellation grace period cannot exceed 7 days (168 hours).', 'error'); return; }

    setShowSummaryModal(true);
  };

  const executeSave = async () => {
    setShowSummaryModal(false);
    setIsSaving(true);
    try {
      const ratesPayload = {
        hourlyRate: Number(ratesForm.hourlyRate) || 0,
        overtimeRate: Number(ratesForm.overtimeRate) || 0,
        downPaymentPercent: Number(ratesForm.downPaymentPercent) || 50,
        weekdayStartTime: ratesForm.weekdayStartTime || '12:00',
        weekdayEndTime: ratesForm.weekdayEndTime || '00:00',
        isWeekdayHappyHourActive: !!ratesForm.isWeekdayHappyHourActive,
        weekdayHappyHourRate: Number(ratesForm.weekdayHappyHourRate) || 0,
        weekdayHappyHourStart: ratesForm.weekdayHappyHourStart || '15:00',
        weekdayHappyHourEnd: ratesForm.weekdayHappyHourEnd || '18:00',
        weekdayOnlineCapacityLimit: activeTablesCount,
        weekendStartTime: ratesForm.weekendStartTime || '12:00',
        weekendEndTime: ratesForm.weekendEndTime || '02:00',
        isWeekendHappyHourActive: !!ratesForm.isWeekendHappyHourActive,
        weekendHappyHourRate: Number(ratesForm.weekendHappyHourRate) || 0,
        weekendHappyHourStart: ratesForm.weekendHappyHourStart || '15:00',
        weekendHappyHourEnd: ratesForm.weekendHappyHourEnd || '18:00',
        weekendOnlineCapacityLimit: activeTablesCount,
      };

      const termsPayload = {
        minHours: 1, // Standard hardcoded minimum
        maxHours: 24, // Handled dynamically by cutoff
        advanceBookingHours: 1, // Default fallback
        cancellationHours: Number(termsForm.cancellationHours) || 24,
        cancellationPolicy: termsForm.cancellationPolicy || '',
        termsAndConditions: termsForm.termsAndConditions || '',
        weekdayMinPartySize: Number(termsForm.weekdayMinPartySize) || 1,
        weekdayMaxPartySize: Number(termsForm.weekdayMaxPartySize) || 10,
        weekendMinPartySize: Number(termsForm.weekendMinPartySize) || 1,
        weekendMaxPartySize: Number(termsForm.weekendMaxPartySize) || 10,
      };
      
      await updateRates(ratesPayload);
      await updateReservationTerms(termsPayload);

      flash("Policies & Rates successfully updated locally and synced to cloud!", "success");
    } catch (e) { 
      flash('Failed to save settings to local database.', 'error'); 
    } finally { 
      setTimeout(() => setIsSaving(false), 400); 
    }
  };

  const truncate = (str: string) => str && str.length > 30 ? str.substring(0, 30) + '...' : str;
  const renderChangeRow = (label: string, oldVal: any, newVal: any, isCurrency: boolean = false) => {
    const format = (v: any) => {
      if (typeof v === 'boolean') return v ? 'Active' : 'Disabled';
      if (isCurrency && v !== undefined && v !== '') return `₱${v}`;
      return String(v ?? 'None');
    };
    const o = format(oldVal);
    const n = format(newVal);
    const changed = o !== n;
    return (
      <div className="flex justify-between border-b border-neutral-800/60 py-2.5 items-center">
        <span className="text-neutral-400 text-xs font-medium">{label}</span>
        <div className="text-right max-w-[220px]">
          {!changed ? (
            <span className="text-neutral-500 text-xs italic">
              {n} <span className="text-neutral-600 text-[10px] ml-1">(unchanged)</span>
            </span>
          ) : (
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-neutral-500 line-through text-[10px]">{o}</span>
              <span className="text-emerald-400 font-bold text-xs bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">{n}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  const CharCount = ({ current, max }: { current?: string, max: number }) => {
    const len = current?.length || 0;
    return (
      <span className={`text-[10px] ${len >= max ? 'text-rose-400 font-bold' : 'text-neutral-600'}`}>
        {len}/{max}
      </span>
    );
  };

  if (isLoading || isSaving) {
    return (
      <div className="min-h-[75vh] w-full flex flex-col items-center justify-center bg-neutral-950">
        <div className="flex flex-col items-center gap-4 bg-neutral-950 p-8 rounded-2xl border border-neutral-800 shadow-2xl">
          <div className="w-12 h-12 border-4 border-sky-500/20 border-t-sky-500 rounded-full animate-spin"></div>
          <p className="text-xs font-bold text-sky-400 uppercase tracking-widest animate-pulse">
            {isSaving ? "Saving Configuration..." : "Loading Policies & Rates..."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8 pb-20 animate-in fade-in duration-300">
      
      {/* 🟢 TOP-RIGHT FLOATING TOAST WITH 5S TIMER & FADE OUT */}
      {toast && (
        <div 
          className="fixed top-6 right-6 z-[9999] animate-in slide-in-from-top-4 fade-in duration-300"
          style={{ animation: 'toast-fade-out 5s forwards' }}
        >
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
            @keyframes toast-fade-out {
              0%, 90% { opacity: 1; transform: translateY(0); }
              100% { opacity: 0; transform: translateY(-10px); }
            }
          `}</style>
        </div>
      )}

      {/* Header */}
      <div className="flex justify-between items-end border-b border-neutral-800 pb-4">
        <div>
          <h1 className="text-3xl font-black text-neutral-100 tracking-widest">POLICY & RATES</h1>
          <p className="text-sm text-neutral-400 mt-1">Manage operational pricing, business hours, and strictly enforced rules.</p>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={handleReviewChanges} className="bg-emerald-600 hover:bg-emerald-500 text-neutral-100 px-6 py-3 rounded-lg font-bold flex items-center gap-2 transition-colors shadow-lg shadow-emerald-950/40">
            <Save size={18} /> Save Changes
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        
        {/* LEFT COLUMN: RATES & HAPPY HOUR */}
        <div className="space-y-8">
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-sm">
            <h2 className="text-xl font-bold text-neutral-100 flex items-center gap-2 mb-6">
              <PesoSign className="text-emerald-500" size={20} /> Base Rates & Store Hours
            </h2>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <label className="block text-xs text-neutral-400 mb-1 uppercase tracking-wider flex justify-between">
                  <span>Standard Hourly Rate (₱)</span>
                  {Number(ratesForm.hourlyRate) > 1000 && <span className="text-amber-400 text-[10px] font-bold">⚠️ &gt;1000</span>}
                </label>
                <input 
                  type="text" 
                  inputMode="numeric" 
                  name="hourlyRate" 
                  value={ratesForm.hourlyRate} 
                  onChange={handleRateInput} 
                  placeholder="0"
                  className="w-full bg-neutral-950 border border-neutral-800 rounded p-3 text-neutral-100 focus:border-emerald-500 outline-none font-mono" 
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1 uppercase tracking-wider flex justify-between">
                  <span>Overtime Rate (₱)</span>
                  {Number(ratesForm.overtimeRate) > 1000 && <span className="text-amber-400 text-[10px] font-bold">⚠️ &gt;1000</span>}
                </label>
                <input 
                  type="text" 
                  inputMode="numeric" 
                  name="overtimeRate" 
                  value={ratesForm.overtimeRate} 
                  onChange={handleRateInput} 
                  placeholder="0"
                  className="w-full bg-neutral-950 border border-neutral-800 rounded p-3 text-neutral-100 focus:border-emerald-500 outline-none font-mono" 
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6 p-4 bg-neutral-950 rounded-lg border border-neutral-800/50 mb-4">
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-emerald-500 border-b border-neutral-800 pb-2">WEEKDAYS (Mon-Thu)</h3>
                <div>
                  <label className="block text-xs text-neutral-400 mb-1 uppercase tracking-wider">Store Opens</label>
                  <input type="time" style={{ colorScheme: theme === 'light' ? 'light' : 'dark' }} name="weekdayStartTime" value={ratesForm.weekdayStartTime} onChange={handleRatesChange} className="w-full bg-neutral-900 border border-neutral-800 rounded p-3 text-neutral-100 focus:border-emerald-500 outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-neutral-400 mb-1 uppercase tracking-wider">Store Closes</label>
                  <input type="time" style={{ colorScheme: theme === 'light' ? 'light' : 'dark' }} name="weekdayEndTime" value={ratesForm.weekdayEndTime} onChange={handleRatesChange} className="w-full bg-neutral-900 border border-neutral-800 rounded p-3 text-neutral-100 focus:border-emerald-500 outline-none" />
                </div>
              </div>
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-emerald-500 border-b border-neutral-800 pb-2">WEEKENDS (Fri-Sun)</h3>
                <div>
                  <label className="block text-xs text-neutral-400 mb-1 uppercase tracking-wider">Store Opens</label>
                  <input type="time" style={{ colorScheme: theme === 'light' ? 'light' : 'dark' }} name="weekendStartTime" value={ratesForm.weekendStartTime} onChange={handleRatesChange} className="w-full bg-neutral-900 border border-neutral-800 rounded p-3 text-neutral-100 focus:border-emerald-500 outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-neutral-400 mb-1 uppercase tracking-wider">Store Closes</label>
                  <input type="time" style={{ colorScheme: theme === 'light' ? 'light' : 'dark' }} name="weekendEndTime" value={ratesForm.weekendEndTime} onChange={handleRatesChange} className="w-full bg-neutral-900 border border-neutral-800 rounded p-3 text-neutral-100 focus:border-emerald-500 outline-none" />
                </div>
              </div>
            </div>

            <div className="mt-4">
              <label className="block text-xs text-neutral-400 mb-1 uppercase tracking-wider">Down Payment % Required (All Days)</label>
              <input type="text" inputMode="numeric" name="downPaymentPercent" value={ratesForm.downPaymentPercent} onChange={handleDownPaymentInput} className="w-full bg-neutral-950 border border-neutral-800 rounded p-3 text-neutral-100 focus:border-emerald-500 outline-none font-mono" />
            </div>
          </div>

          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-sm">
            <h2 className="text-xl font-bold text-neutral-100 flex items-center gap-2 mb-6"><Clock className="text-emerald-500" /> Happy Hour Promotions</h2>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div className={`p-4 rounded-lg border transition-colors ${ratesForm.isWeekdayHappyHourActive ? 'bg-neutral-950 border-emerald-900/50' : 'bg-neutral-950 border-neutral-800 opacity-70'}`}>
                <div className="flex justify-between items-center mb-4">
                  <span className="text-sm font-bold text-emerald-500">WEEKDAYS</span>
                  <button type="button" onClick={() => setRatesForm(prev => ({ ...prev, isWeekdayHappyHourActive: !prev.isWeekdayHappyHourActive }))}>
                    {ratesForm.isWeekdayHappyHourActive ? <ToggleRight size={28} className="text-emerald-500" /> : <ToggleLeft size={28} className="text-neutral-600" />}
                  </button>
                </div>
                <div className={`space-y-4 ${!ratesForm.isWeekdayHappyHourActive && 'pointer-events-none'}`}>
                  <div>
                    <label className="block text-[10px] text-neutral-400 mb-1 uppercase flex justify-between">
                      <span>Promo Rate (₱)</span>
                      {Number(ratesForm.weekdayHappyHourRate) > 1000 && <span className="text-amber-400 font-bold">⚠️ &gt;1000</span>}
                    </label>
                    <input type="text" inputMode="numeric" name="weekdayHappyHourRate" value={ratesForm.weekdayHappyHourRate} onChange={handleRateInput} className="w-full bg-neutral-900 border border-neutral-800 rounded p-2 text-neutral-100 focus:border-emerald-500 outline-none font-mono" />
                  </div>
                  <div className="flex flex-col gap-3">
                    <div className="flex-1"><label className="block text-[10px] text-neutral-400 mb-1 uppercase">Start</label><input type="time" style={{ colorScheme: theme === 'light' ? 'light' : 'dark' }} name="weekdayHappyHourStart" value={ratesForm.weekdayHappyHourStart} onChange={handleRatesChange} className="w-full bg-neutral-900 border border-neutral-800 rounded p-2 text-neutral-100 outline-none" /></div>
                    <div className="flex-1"><label className="block text-[10px] text-neutral-400 mb-1 uppercase">End</label><input type="time" style={{ colorScheme: theme === 'light' ? 'light' : 'dark' }} name="weekdayHappyHourEnd" value={ratesForm.weekdayHappyHourEnd} onChange={handleRatesChange} className="w-full bg-neutral-900 border border-neutral-800 rounded p-2 text-neutral-100 outline-none" /></div>
                  </div>
                </div>
              </div>

              <div className={`p-4 rounded-lg border transition-colors ${ratesForm.isWeekendHappyHourActive ? 'bg-neutral-950 border-emerald-900/50' : 'bg-neutral-950 border-neutral-800 opacity-70'}`}>
                <div className="flex justify-between items-center mb-4">
                  <span className="text-sm font-bold text-emerald-500">WEEKENDS</span>
                  <button type="button" onClick={() => setRatesForm(prev => ({ ...prev, isWeekendHappyHourActive: !prev.isWeekendHappyHourActive }))}>
                    {ratesForm.isWeekendHappyHourActive ? <ToggleRight size={28} className="text-emerald-500" /> : <ToggleLeft size={28} className="text-neutral-600" />}
                  </button>
                </div>
                <div className={`space-y-4 ${!ratesForm.isWeekendHappyHourActive && 'pointer-events-none'}`}>
                  <div>
                    <label className="block text-[10px] text-neutral-400 mb-1 uppercase flex justify-between">
                      <span>Promo Rate (₱)</span>
                      {Number(ratesForm.weekendHappyHourRate) > 1000 && <span className="text-amber-400 font-bold">⚠️ &gt;1000</span>}
                    </label>
                    <input type="text" inputMode="numeric" name="weekendHappyHourRate" value={ratesForm.weekendHappyHourRate} onChange={handleRateInput} className="w-full bg-neutral-900 border border-neutral-800 rounded p-2 text-neutral-100 focus:border-emerald-500 outline-none font-mono" />
                  </div>
                  <div className="flex flex-col gap-3">
                    <div className="flex-1"><label className="block text-[10px] text-neutral-400 mb-1 uppercase">Start</label><input type="time" style={{ colorScheme: theme === 'light' ? 'light' : 'dark' }} name="weekendHappyHourStart" value={ratesForm.weekendHappyHourStart} onChange={handleRatesChange} className="w-full bg-neutral-900 border border-neutral-800 rounded p-2 text-neutral-100 outline-none" /></div>
                    <div className="flex-1"><label className="block text-[10px] text-neutral-400 mb-1 uppercase">End</label><input type="time" style={{ colorScheme: theme === 'light' ? 'light' : 'dark' }} name="weekendHappyHourEnd" value={ratesForm.weekendHappyHourEnd} onChange={handleRatesChange} className="w-full bg-neutral-900 border border-neutral-800 rounded p-2 text-neutral-100 outline-none" /></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: CONTENT EDITOR & RULES */}
        <div className="space-y-6">
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-sm">
            <h2 className="text-xl font-bold text-neutral-100 flex items-center gap-2 mb-6">
              <FileText className="text-emerald-500" /> Booking Rules & Limits
            </h2>
            <div className="space-y-4">
              
              <div className="grid grid-cols-2 gap-4 bg-neutral-950 p-4 border border-neutral-800/80 rounded-xl mb-4">
                <div className="space-y-3">
                    <h3 className="text-[10px] uppercase font-bold text-emerald-500 border-b border-neutral-800 pb-1">Weekday Limits</h3>
                    <div className="flex gap-2">
                        <div className="flex-1"><label className="block text-[9px] text-neutral-400 mb-1 uppercase">Min Pax</label><input type="text" inputMode="numeric" name="weekdayMinPartySize" value={termsForm.weekdayMinPartySize} onChange={handlePartySizeInput} className="w-full bg-neutral-900 border border-neutral-800 rounded p-2 text-neutral-100 outline-none text-center font-mono" /></div>
                        <div className="flex-1"><label className="block text-[9px] text-neutral-400 mb-1 uppercase">Max Pax</label><input type="text" inputMode="numeric" name="weekdayMaxPartySize" value={termsForm.weekdayMaxPartySize} onChange={handlePartySizeInput} className="w-full bg-neutral-900 border border-neutral-800 rounded p-2 text-neutral-100 outline-none text-center font-mono" /></div>
                    </div>
                </div>
                <div className="space-y-3 border-l border-neutral-800 pl-4">
                    <h3 className="text-[10px] uppercase font-bold text-emerald-500 border-b border-neutral-800 pb-1">Weekend Limits</h3>
                    <div className="flex gap-2">
                        <div className="flex-1"><label className="block text-[9px] text-neutral-400 mb-1 uppercase">Min Pax</label><input type="text" inputMode="numeric" name="weekendMinPartySize" value={termsForm.weekendMinPartySize} onChange={handlePartySizeInput} className="w-full bg-neutral-900 border border-neutral-800 rounded p-2 text-neutral-100 outline-none text-center font-mono" /></div>
                        <div className="flex-1"><label className="block text-[9px] text-neutral-400 mb-1 uppercase">Max Pax</label><input type="text" inputMode="numeric" name="weekendMaxPartySize" value={termsForm.weekendMaxPartySize} onChange={handlePartySizeInput} className="w-full bg-neutral-900 border border-neutral-800 rounded p-2 text-neutral-100 outline-none text-center font-mono" /></div>
                    </div>
                </div>
              </div>

              <div>
                <label className="block text-xs text-neutral-400 mb-1 uppercase tracking-wider">Cancel Window (Hrs)</label>
                <input type="text" inputMode="numeric" name="cancellationHours" value={termsForm.cancellationHours} onChange={handleHourInput} placeholder="24" className="w-full bg-neutral-950 border border-neutral-800 rounded p-3 text-neutral-100 focus:border-emerald-500 outline-none font-mono" />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1 mt-2">
                  <label className="block text-xs text-neutral-400 uppercase tracking-wider">Booking Policies (Displayed to Users)</label>
                  <CharCount current={termsForm.cancellationPolicy} max={400} />
                </div>
                <textarea 
                  maxLength={400} 
                  name="cancellationPolicy" 
                  value={termsForm.cancellationPolicy} 
                  onChange={(e) => {
                    handleTermsChange(e);
                    e.currentTarget.style.height = 'auto';
                    e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px';
                  }} 
                  rows={2} 
                  className="w-full bg-neutral-950 border border-neutral-800 rounded p-3 text-sm text-neutral-100 focus:border-emerald-500 outline-none resize-none overflow-hidden" 
                  placeholder="E.g. No refunds on same-day cancellations..." 
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="block text-xs text-neutral-400 uppercase tracking-wider">General Terms & Conditions</label>
                  <CharCount current={termsForm.termsAndConditions} max={600} />
                </div>
                <textarea 
                  maxLength={600} 
                  name="termsAndConditions" 
                  value={termsForm.termsAndConditions} 
                  onChange={(e) => {
                    handleTermsChange(e);
                    e.currentTarget.style.height = 'auto';
                    e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px';
                  }} 
                  rows={2} 
                  className="w-full bg-neutral-950 border border-neutral-800 rounded p-3 text-sm text-neutral-100 focus:border-emerald-500 outline-none resize-none overflow-hidden" 
                  placeholder="General establishment rules..." 
                />
              </div>
              
            </div>
          </div>
        </div>
      </div>

     

      {/* ALL-INCLUSIVE CONFIRMATION MODAL */}
      {showSummaryModal && (
        <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-neutral-900/80 border-b border-neutral-800 px-6 py-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-neutral-100 flex items-center gap-2">
                <ShieldCheck size={18} className="text-emerald-500" /> Review Policy & Rate Summary
              </h3>
              <button type="button" onClick={() => setShowSummaryModal(false)} className="text-neutral-500 hover:text-neutral-100 transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <p className="text-sm text-neutral-400">
                Please review all policies and rates. Items highlighted have been modified:
              </p>
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 text-sm space-y-1 text-neutral-300 max-h-[50vh] overflow-y-auto">
                {renderChangeRow('Base Hourly Rate', rates.hourlyRate, ratesForm.hourlyRate, true)}
                {renderChangeRow('Overtime Rate', rates.overtimeRate, ratesForm.overtimeRate, true)}
                {renderChangeRow('Down Payment Required', `${rates.downPaymentPercent}%`, `${ratesForm.downPaymentPercent}%`)}
                
                <div className="pt-3 pb-1 mt-2 border-t border-neutral-800/60 font-bold text-emerald-500 text-[10px] uppercase tracking-widest">Weekday Setup</div>
                {renderChangeRow('Store Hours', `${fmt12(rates.weekdayStartTime)} - ${fmt12(rates.weekdayEndTime)}`, `${fmt12(ratesForm.weekdayStartTime)} - ${fmt12(ratesForm.weekdayEndTime)}`)}
                {renderChangeRow('Happy Hour Status', rates.isWeekdayHappyHourActive, ratesForm.isWeekdayHappyHourActive)}
                {renderChangeRow('Happy Hour Window', `${fmt12(rates.weekdayHappyHourStart)} - ${fmt12(rates.weekdayHappyHourEnd)}`, `${fmt12(ratesForm.weekdayHappyHourStart)} - ${fmt12(ratesForm.weekdayHappyHourEnd)}`)}
                {renderChangeRow('Happy Hour Rate', rates.weekdayHappyHourRate, ratesForm.weekdayHappyHourRate, true)}
                {renderChangeRow('Min/Max Party Size', `${reservationTerms.weekdayMinPartySize}-${reservationTerms.weekdayMaxPartySize}`, `${termsForm.weekdayMinPartySize}-${termsForm.weekdayMaxPartySize}`)}
                
                <div className="pt-3 pb-1 mt-2 border-t border-neutral-800/60 font-bold text-emerald-500 text-[10px] uppercase tracking-widest">Weekend Setup</div>
                {renderChangeRow('Store Hours', `${fmt12(rates.weekendStartTime)} - ${fmt12(rates.weekendEndTime)}`, `${fmt12(ratesForm.weekendStartTime)} - ${fmt12(ratesForm.weekendEndTime)}`)}
                {renderChangeRow('Happy Hour Status', rates.isWeekendHappyHourActive, ratesForm.isWeekendHappyHourActive)}
                {renderChangeRow('Happy Hour Window', `${fmt12(rates.weekendHappyHourStart)} - ${fmt12(rates.weekendHappyHourEnd)}`, `${fmt12(ratesForm.weekendHappyHourStart)} - ${fmt12(ratesForm.weekendHappyHourEnd)}`)}
                {renderChangeRow('Happy Hour Rate', rates.weekendHappyHourRate, ratesForm.weekendHappyHourRate, true)}
                {renderChangeRow('Min/Max Party Size', `${reservationTerms.weekendMinPartySize}-${reservationTerms.weekendMaxPartySize}`, `${termsForm.weekendMinPartySize}-${termsForm.weekendMaxPartySize}`)}
                
                <div className="pt-3 pb-1 mt-2 border-t border-neutral-800/60 font-bold text-emerald-500 text-[10px] uppercase tracking-widest">Policies</div>
                {renderChangeRow('Cancellation Grace', `${reservationTerms.cancellationHours} Hrs`, `${termsForm.cancellationHours} Hrs`)}
                {renderChangeRow('Cancellation Policy', truncate(reservationTerms.cancellationPolicy), truncate(termsForm.cancellationPolicy))}
                {renderChangeRow('General T&C Text', truncate(reservationTerms.termsAndConditions), truncate(termsForm.termsAndConditions))}
                
                <div className="pt-3 pb-1 mt-2 border-t border-neutral-800/60 font-bold text-emerald-500 text-[10px] uppercase tracking-widest">Anti-Ghosting & Fraud Defense</div>
                {renderChangeRow('No-Show Grace Period', `${gracePeriodMins}m Late`, `${gracePeriodMins}m Late`)}
                {renderChangeRow('Staff Receipt Verification', "System Enforced", "System Enforced")}
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowSummaryModal(false)} className="flex-1 px-4 py-3 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-xl text-sm font-semibold transition-colors border border-neutral-800">
                  Cancel
                </button>
                <button type="button" onClick={executeSave} disabled={isSaving} className="flex-1 px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-neutral-100 rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2 shadow-lg shadow-emerald-900/30">
                  <Save size={16} /> Confirm & Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}