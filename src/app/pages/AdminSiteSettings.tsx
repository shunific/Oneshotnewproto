import React, { useState, useEffect, useRef } from "react";
import { useAppContext } from "../context/AppContext";
import { 
  Save, CheckCircle, X, LayoutTemplate, Clock, MapPin, 
  Upload, Trash2, Image as ImageIcon, AlertTriangle, Users, 
  Info, Globe, Sliders, Navigation, ChevronLeft, ChevronRight, Eye
} from "lucide-react";
import { supabase } from "../utils/supabase"; 

export function AdminSiteSettings() {
  const { 
    siteConfig, updateSiteConfig, 
    rates, updateRates, 
    reservationTerms, updateReservationTerms, 
    theme 
  } = useAppContext() as any;

  const [form, setForm] = useState<any>({
    venueName: "",
    tagline: "",
    description: "",
    contactNumber: "",
    contactEmail: "",
    heroImages: [],
    aboutImage: ""
  });

  const [hoursForm, setHoursForm] = useState({
    weekdayStartTime: "12:00",
    weekdayEndTime: "00:00",
    weekendStartTime: "12:00",
    weekendEndTime: "02:00",
  });

  const [occupancyForm, setOccupancyForm] = useState({
    weekdayMinPartySize: 1,
    weekdayMaxPartySize: 8,
    weekendMinPartySize: 1,
    weekendMaxPartySize: 10,
    advanceBookingHours: 1,
    cancellationHours: 24,
  });

  const [locationForm, setLocationForm] = useState({
    address: "One Shot Bar & Billiards, Manila, Philippines",
    latitude: "14.5995",
    longitude: "120.9842",
    googleMapsEmbedUrl: "",
  });

  const [uploading, setUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeSlideIdx, setActiveSlideIdx] = useState(0);

  const heroInputRef = useRef<HTMLInputElement>(null);
  const aboutInputRef = useRef<HTMLInputElement>(null);

  // Toast notification
  const [toast, setToast] = useState<{msg: string, type: "success" | "error"} | null>(null);
  const toastTimeout = useRef<NodeJS.Timeout | null>(null);

  const flash = (msg: string, type: "success" | "error" = "success") => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToast({ msg, type });
    toastTimeout.current = setTimeout(() => setToast(null), 5000);
  };

  // Sync from siteConfig (handles initial load and async Supabase cloud updates)
  useEffect(() => {
    if (siteConfig && Object.keys(siteConfig).length > 0) {
      let parsedHero: string[] = [];
      try {
        if (typeof siteConfig.heroImages === "string") {
          parsedHero = JSON.parse(siteConfig.heroImages);
        } else if (Array.isArray(siteConfig.heroImages)) {
          parsedHero = siteConfig.heroImages;
        }
      } catch (e) {
        parsedHero = [];
      }

      setForm((prev: any) => ({
        ...prev,
        venueName: siteConfig.venueName !== undefined ? siteConfig.venueName : prev.venueName,
        tagline: siteConfig.tagline !== undefined ? siteConfig.tagline : prev.tagline,
        description: siteConfig.description !== undefined ? siteConfig.description : prev.description,
        contactNumber: siteConfig.contactNumber !== undefined ? siteConfig.contactNumber : prev.contactNumber,
        contactEmail: siteConfig.contactEmail !== undefined ? siteConfig.contactEmail : prev.contactEmail,
        heroImages: parsedHero.length > 0 ? parsedHero : prev.heroImages,
        aboutImage: siteConfig.aboutImage || prev.aboutImage,
      }));

      setLocationForm((prev) => ({
        ...prev,
        address: siteConfig.address || prev.address,
        latitude: siteConfig.latitude || prev.latitude,
        longitude: siteConfig.longitude || prev.longitude,
        googleMapsEmbedUrl: siteConfig.googleMapsEmbedUrl || prev.googleMapsEmbedUrl,
      }));
    }
  }, [siteConfig]);

  // Sync from rates
  useEffect(() => {
    if (rates) {
      setHoursForm({
        weekdayStartTime: rates.weekdayStartTime || "12:00",
        weekdayEndTime: rates.weekdayEndTime || "00:00",
        weekendStartTime: rates.weekendStartTime || "12:00",
        weekendEndTime: rates.weekendEndTime || "02:00",
      });
    }
  }, [rates]);

  // Sync from reservationTerms (clamped to safe boundaries: max 30 pax, max 24 hrs notice)
  useEffect(() => {
    if (reservationTerms) {
      setOccupancyForm({
        weekdayMinPartySize: Math.max(1, Math.min(30, Number(reservationTerms.weekdayMinPartySize) || 1)),
        weekdayMaxPartySize: Math.max(1, Math.min(30, Number(reservationTerms.weekdayMaxPartySize) || 8)),
        weekendMinPartySize: Math.max(1, Math.min(30, Number(reservationTerms.weekendMinPartySize) || 1)),
        weekendMaxPartySize: Math.max(1, Math.min(30, Number(reservationTerms.weekendMaxPartySize) || 10)),
        advanceBookingHours: Math.min(24, Math.max(0, Number(reservationTerms.advanceBookingHours) || 1)),
        cancellationHours: Math.min(24, Math.max(0, Number(reservationTerms.cancellationHours) || 24)),
      });
    }
  }, [reservationTerms]);

  // Live Auto-Slider for Hero Images Preview
  useEffect(() => {
    const heroList = Array.isArray(form.heroImages) ? form.heroImages : [];
    if (heroList.length <= 1) return;
    const interval = setInterval(() => {
      setActiveSlideIdx(prev => (prev + 1) % heroList.length);
    }, 4000);
    return () => clearInterval(interval);
  }, [form.heroImages]);

  // Save General Info & Description
  const saveGeneralInfo = async () => {
    setIsProcessing(true);
    try {
      await updateSiteConfig({
        venueName: (form.venueName || "").trim().slice(0, 60),
        tagline: (form.tagline || "").trim().slice(0, 120),
        description: (form.description || "").trim().slice(0, 600),
        contactNumber: (form.contactNumber || "").trim().slice(0, 25),
        contactEmail: (form.contactEmail || "").trim().slice(0, 60),
      });
      flash("General information saved and synchronized to Cloud & Local!", "success");
    } catch (err: any) {
      flash(err.message || "Failed to update general information.", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  // Save Location & Pin
  const saveLocationPin = async () => {
    setIsProcessing(true);
    try {
      let embed = (locationForm.googleMapsEmbedUrl || "").trim();
      const iframeMatch = embed.match(/src=["']([^"']+)["']/i);
      if (iframeMatch) {
        embed = iframeMatch[1];
      }
      await updateSiteConfig({
        address: (locationForm.address || "").trim().slice(0, 200),
        latitude: String(locationForm.latitude || "").trim(),
        longitude: String(locationForm.longitude || "").trim(),
        googleMapsEmbedUrl: embed,
      });
      flash("Location pin and address saved and synchronized!", "success");
    } catch (err: any) {
      flash(err.message || "Failed to update location pin.", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  // Save Operating Hours
  const saveOperatingHours = async () => {
    if (hoursForm.weekdayStartTime === hoursForm.weekdayEndTime) {
      flash("Weekday opening and closing times cannot be identical.", "error");
      return;
    }
    if (hoursForm.weekendStartTime === hoursForm.weekendEndTime) {
      flash("Weekend opening and closing times cannot be identical.", "error");
      return;
    }

    setIsProcessing(true);
    try {
      await updateRates({
        weekdayStartTime: hoursForm.weekdayStartTime,
        weekdayEndTime: hoursForm.weekdayEndTime,
        weekendStartTime: hoursForm.weekendStartTime,
        weekendEndTime: hoursForm.weekendEndTime,
      });
      flash("Operating hours saved and synchronized to Cloud & Local!", "success");
    } catch (err: any) {
      flash(err.message || "Failed to update operating hours.", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  // Save Max Occupancies & Global Adjustments (Clamped: Max 30 Pax, Max 24 Hours)
  const saveOccupancyAndAdjustments = async () => {
    const minWkDay = Math.max(1, Math.min(30, Number(occupancyForm.weekdayMinPartySize) || 1));
    const maxWkDay = Math.max(1, Math.min(30, Number(occupancyForm.weekdayMaxPartySize) || 8));
    const minWkEnd = Math.max(1, Math.min(30, Number(occupancyForm.weekendMinPartySize) || 1));
    const maxWkEnd = Math.max(1, Math.min(30, Number(occupancyForm.weekendMaxPartySize) || 10));
    const advHours = Math.max(0, Math.min(24, Number(occupancyForm.advanceBookingHours) || 0));
    const cancelHours = Math.max(0, Math.min(24, Number(occupancyForm.cancellationHours) || 24));

    if (minWkDay > maxWkDay) {
      flash(`Weekday Min (${minWkDay}) cannot exceed Max (${maxWkDay}).`, "error");
      return;
    }
    if (minWkEnd > maxWkEnd) {
      flash(`Weekend Min (${minWkEnd}) cannot exceed Max (${maxWkEnd}).`, "error");
      return;
    }

    setIsProcessing(true);
    try {
      await updateReservationTerms({
        weekdayMinPartySize: minWkDay,
        weekdayMaxPartySize: maxWkDay,
        weekendMinPartySize: minWkEnd,
        weekendMaxPartySize: maxWkEnd,
        advanceBookingHours: advHours,
        cancellationHours: cancelHours,
      });
      flash("Occupancy limits & notices saved and synchronized to Cloud & Local!", "success");
    } catch (err: any) {
      flash(err.message || "Failed to update occupancy limits.", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  // Image Upload / Removal
  const saveHeroImages = async () => {
    setIsProcessing(true);
    try {
      await updateSiteConfig({ heroImages: form.heroImages });
      flash("Hero gallery saved and synchronized to Cloud & Local!", "success");
    } catch (err: any) {
      flash("Failed to update hero gallery.", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  const saveAboutImage = async () => {
    setIsProcessing(true);
    try {
      await updateSiteConfig({ aboutImage: form.aboutImage });
      flash("Featured image saved and synchronized to Cloud & Local!", "success");
    } catch (err: any) {
      flash("Failed to update featured image.", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>, target: "hero" | "about") => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const MAX_SIZE_MB = 15;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        flash(`File "${file.name}" is not a valid image.`, "error");
        e.target.value = "";
        return;
      }
      if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        flash(`Image "${file.name}" exceeds the ${MAX_SIZE_MB}MB limit.`, "error");
        e.target.value = "";
        return;
      }
    }

    setUploading(true);
    flash("Uploading image to Cloud...", "success");
    try {
      for (const file of files) {
        const fileExt = file.name.split(".").pop();
        const fileName = `${target}_${Date.now()}_${Math.floor(Math.random() * 1000)}.${fileExt}`;
        
        const { error: uploadError } = await supabase.storage
          .from("oneshot-assets")
          .upload(fileName, file);
          
        if (uploadError) throw uploadError;
        
        const { data: publicUrlData } = supabase.storage
          .from("oneshot-assets")
          .getPublicUrl(fileName);
          
        const url = publicUrlData.publicUrl;
        
        if (target === "hero") {
          setForm((prev: any) => {
            const current = Array.isArray(prev.heroImages) ? prev.heroImages : [];
            if (current.length >= 5) return prev; 
            return { ...prev, heroImages: [...current, url] };
          });
        } else {
          setForm((prev: any) => ({ ...prev, aboutImage: url }));
        }
      }
      flash("Image uploaded to Cloud. Click Save to persist.", "success");
    } catch (error: any) {
      console.error("Supabase Upload Error:", error);
      flash(`Upload failed: ${error.message || "Ensure Storage bucket is public."}`, "error");
    } finally {
      setUploading(false);
      e.target.value = ""; 
    }
  };

  const removeHeroImage = (indexToRemove: number) => {
    if (!window.confirm("Remove this image from the live Hero Gallery?")) return;
    setForm((prev: any) => {
      const updated = (Array.isArray(prev.heroImages) ? prev.heroImages : []).filter((_: string, idx: number) => idx !== indexToRemove);
      return { ...prev, heroImages: updated };
    });
    if (activeSlideIdx >= indexToRemove && activeSlideIdx > 0) {
      setActiveSlideIdx(p => p - 1);
    }
  };

  const mapsQuery = encodeURIComponent(locationForm.address || `${locationForm.latitude},${locationForm.longitude}`);
  const heroList = Array.isArray(form.heroImages) ? form.heroImages : [];

  return (
    <div className="space-y-8 max-w-5xl relative pb-20 animate-in fade-in duration-300">
      {/* Loading Overlay */}
      {isProcessing && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-4 bg-neutral-950 p-8 rounded-2xl border border-neutral-800 shadow-2xl">
            <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
            <p className="text-xs font-bold text-emerald-400 uppercase tracking-widest animate-pulse">Synchronizing Settings...</p>
          </div>
        </div>
      )}
      
      {/* Floating Toast */}
      {toast && (
        <div className="fixed top-6 right-6 z-[9999] animate-in slide-in-from-top-4 fade-in duration-300">
          <div className={`relative overflow-hidden flex items-start gap-3 px-5 py-4 rounded-xl border shadow-2xl backdrop-blur-md min-w-[320px] max-w-md ${
            toast.type === "success" 
              ? "bg-emerald-950/90 border-emerald-900/50 text-emerald-400" 
              : "bg-rose-950/90 border-rose-900/50 text-rose-400"
          }`}>
            <div className="mt-0.5 flex-shrink-0">
              {toast.type === "success" ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
            </div>
            <span className="text-sm font-semibold leading-snug whitespace-pre-wrap pr-4">{toast.msg}</span>
            <button 
              onClick={() => { setToast(null); if (toastTimeout.current) clearTimeout(toastTimeout.current); }} 
              className="absolute top-4 right-4 text-neutral-500 hover:text-white transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-white tracking-tight">Site & Venue Settings</h1>
        <p className="text-xs text-neutral-500 mt-1">Configure operating hours, location pin, capacity limits, description, and website imagery.</p>
      </div>

      {/* ── 1. OPERATING HOURS ── */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-6 space-y-5">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-xl">
              <Clock size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">Opening & Closing Hours</h2>
              <p className="text-[11px] text-neutral-500">Define daily operating windows for walk-ins and reservation slots.</p>
            </div>
          </div>
          <button 
            type="button" 
            onClick={saveOperatingHours}
            disabled={isProcessing}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors shadow-lg shadow-emerald-950 cursor-pointer"
          >
            <Save size={14} /> Save Hours
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Weekdays */}
          <div className="bg-neutral-900/50 border border-neutral-800/80 rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-bold text-emerald-400 uppercase tracking-widest border-b border-neutral-800 pb-2">
              Weekdays (Mon – Thu)
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Store Opens</label>
                <input 
                  type="time" 
                  value={hoursForm.weekdayStartTime} 
                  onChange={e => setHoursForm(h => ({ ...h, weekdayStartTime: e.target.value }))}
                  style={{ colorScheme: theme === "light" ? "light" : "dark" }}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Store Closes</label>
                <input 
                  type="time" 
                  value={hoursForm.weekdayEndTime} 
                  onChange={e => setHoursForm(h => ({ ...h, weekdayEndTime: e.target.value }))}
                  style={{ colorScheme: theme === "light" ? "light" : "dark" }}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-emerald-500"
                />
              </div>
            </div>
          </div>

          {/* Weekends */}
          <div className="bg-neutral-900/50 border border-neutral-800/80 rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-bold text-purple-400 uppercase tracking-widest border-b border-neutral-800 pb-2">
              Weekends (Fri – Sun)
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Store Opens</label>
                <input 
                  type="time" 
                  value={hoursForm.weekendStartTime} 
                  onChange={e => setHoursForm(h => ({ ...h, weekendStartTime: e.target.value }))}
                  style={{ colorScheme: theme === "light" ? "light" : "dark" }}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-purple-500"
                />
              </div>
              <div>
                <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Store Closes</label>
                <input 
                  type="time" 
                  value={hoursForm.weekendEndTime} 
                  onChange={e => setHoursForm(h => ({ ...h, weekendEndTime: e.target.value }))}
                  style={{ colorScheme: theme === "light" ? "light" : "dark" }}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-purple-500"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── 2. GLOBAL ADJUSTMENTS & MAX TABLE OCCUPANCIES (MAX 30 PAX, MAX 24 HRS) ── */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-6 space-y-5">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-blue-500/10 text-blue-400 rounded-xl">
              <Sliders size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">Global Adjustments & Table Occupancies</h2>
              <p className="text-[11px] text-neutral-500">Party size limits (max 30 people/table), advance booking notice, and cancellation rules (max 24 hours).</p>
            </div>
          </div>
          <button 
            type="button" 
            onClick={saveOccupancyAndAdjustments}
            disabled={isProcessing}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors shadow-lg shadow-blue-950 cursor-pointer"
          >
            <Save size={14} /> Save Adjustments
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-neutral-900/50 border border-neutral-800 p-3.5 rounded-xl">
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Weekday Min Pax / Table</label>
              <span className="text-[9px] text-neutral-500 font-mono">1 - 30</span>
            </div>
            <input 
              type="number" 
              min={1} 
              max={30} 
              value={occupancyForm.weekdayMinPartySize} 
              onChange={e => {
                const val = Math.min(30, Math.max(1, Number(e.target.value) || 1));
                setOccupancyForm(o => ({ ...o, weekdayMinPartySize: val }));
              }}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2 text-xs text-neutral-100 outline-none focus:border-blue-500 font-mono text-center"
            />
          </div>

          <div className="bg-neutral-900/50 border border-neutral-800 p-3.5 rounded-xl">
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Weekday Max Pax / Table</label>
              <span className="text-[9px] text-blue-400 font-bold font-mono">Max 30</span>
            </div>
            <input 
              type="number" 
              min={1} 
              max={30} 
              value={occupancyForm.weekdayMaxPartySize} 
              onChange={e => {
                const val = Math.min(30, Math.max(1, Number(e.target.value) || 1));
                setOccupancyForm(o => ({ ...o, weekdayMaxPartySize: val }));
              }}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2 text-xs text-neutral-100 outline-none focus:border-blue-500 font-mono text-center font-bold"
            />
          </div>

          <div className="bg-neutral-900/50 border border-neutral-800 p-3.5 rounded-xl">
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Weekend Min Pax / Table</label>
              <span className="text-[9px] text-neutral-500 font-mono">1 - 30</span>
            </div>
            <input 
              type="number" 
              min={1} 
              max={30} 
              value={occupancyForm.weekendMinPartySize} 
              onChange={e => {
                const val = Math.min(30, Math.max(1, Number(e.target.value) || 1));
                setOccupancyForm(o => ({ ...o, weekendMinPartySize: val }));
              }}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2 text-xs text-neutral-100 outline-none focus:border-blue-500 font-mono text-center"
            />
          </div>

          <div className="bg-neutral-900/50 border border-neutral-800 p-3.5 rounded-xl">
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Weekend Max Pax / Table</label>
              <span className="text-[9px] text-purple-400 font-bold font-mono">Max 30</span>
            </div>
            <input 
              type="number" 
              min={1} 
              max={30} 
              value={occupancyForm.weekendMaxPartySize} 
              onChange={e => {
                const val = Math.min(30, Math.max(1, Number(e.target.value) || 1));
                setOccupancyForm(o => ({ ...o, weekendMaxPartySize: val }));
              }}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2 text-xs text-neutral-100 outline-none focus:border-blue-500 font-mono text-center font-bold"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <div className="bg-neutral-900/40 border border-neutral-800 p-3.5 rounded-xl">
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Advance Booking Notice (Hours)</label>
              <span className="text-[10px] text-amber-400 font-bold font-mono">Up to 24 hrs</span>
            </div>
            <input 
              type="number" 
              min={0} 
              max={24} 
              value={occupancyForm.advanceBookingHours} 
              onChange={e => {
                const val = Math.min(24, Math.max(0, Number(e.target.value) || 0));
                setOccupancyForm(o => ({ ...o, advanceBookingHours: val }));
              }}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2 text-xs text-neutral-100 outline-none focus:border-blue-500 font-mono text-center font-bold"
            />
            <p className="text-[10px] text-neutral-500 mt-1">Requires guests to book at least this many hours in advance (0 - 24 hrs max).</p>
          </div>

          <div className="bg-neutral-900/40 border border-neutral-800 p-3.5 rounded-xl">
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Cancellation Notice (Hours)</label>
              <span className="text-[10px] text-amber-400 font-bold font-mono">Up to 24 hrs</span>
            </div>
            <input 
              type="number" 
              min={0} 
              max={24} 
              value={occupancyForm.cancellationHours} 
              onChange={e => {
                const val = Math.min(24, Math.max(0, Number(e.target.value) || 0));
                setOccupancyForm(o => ({ ...o, cancellationHours: val }));
              }}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2 text-xs text-neutral-100 outline-none focus:border-blue-500 font-mono text-center font-bold"
            />
            <p className="text-[10px] text-neutral-500 mt-1">Grace period allowed for guests to cancel or reschedule (0 - 24 hrs max).</p>
          </div>
        </div>
      </div>

      {/* ── 3. GENERAL INFORMATION & DESCRIPTION (WITH TEXT LIMITS) ── */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-6 space-y-5">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-amber-500/10 text-amber-400 rounded-xl">
              <Info size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">Venue Description & General Info</h2>
              <p className="text-[11px] text-neutral-500">Store branding, customer about story, and contact touchpoints with length bounds.</p>
            </div>
          </div>
          <button 
            type="button" 
            onClick={saveGeneralInfo}
            disabled={isProcessing}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors shadow-lg shadow-amber-950 cursor-pointer"
          >
            <Save size={14} /> Save Info
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Venue Name</label>
              <span className={`text-[10px] ${(form.venueName || "").length >= 60 ? "text-rose-400 font-bold" : "text-neutral-500 font-mono"}`}>
                {(form.venueName || "").length}/60
              </span>
            </div>
            <input 
              type="text" 
              maxLength={60}
              value={form.venueName || ""} 
              onChange={e => setForm((f: any) => ({ ...f, venueName: e.target.value }))}
              placeholder="e.g. One Shot Bar & Billiards"
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-amber-500"
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Tagline / Slogan</label>
              <span className={`text-[10px] ${(form.tagline || "").length >= 120 ? "text-rose-400 font-bold" : "text-neutral-500 font-mono"}`}>
                {(form.tagline || "").length}/120
              </span>
            </div>
            <input 
              type="text" 
              maxLength={120}
              value={form.tagline || ""} 
              onChange={e => setForm((f: any) => ({ ...f, tagline: e.target.value }))}
              placeholder="e.g. Your premier destination for billiards and cocktails"
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-amber-500"
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Contact Phone</label>
              <span className="text-[10px] text-neutral-500 font-mono">{(form.contactNumber || "").length}/25</span>
            </div>
            <input 
              type="text" 
              maxLength={25}
              value={form.contactNumber || ""} 
              onChange={e => setForm((f: any) => ({ ...f, contactNumber: e.target.value }))}
              placeholder="e.g. 0917-123-4567"
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-amber-500 font-mono"
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Contact Email</label>
              <span className="text-[10px] text-neutral-500 font-mono">{(form.contactEmail || "").length}/60</span>
            </div>
            <input 
              type="email" 
              maxLength={60}
              value={form.contactEmail || ""} 
              onChange={e => setForm((f: any) => ({ ...f, contactEmail: e.target.value }))}
              placeholder="e.g. info@oneshotbilliards.ph"
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-amber-500"
            />
          </div>
        </div>

        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[11px] text-neutral-400 font-medium">Venue Description (About Us)</label>
            <span className={`text-[10px] ${(form.description || "").length >= 600 ? "text-rose-400 font-bold" : "text-neutral-500 font-mono"}`}>
              {(form.description || "").length}/600
            </span>
          </div>
          <textarea 
            rows={4} 
            maxLength={600}
            value={form.description || ""} 
            onChange={e => setForm((f: any) => ({ ...f, description: e.target.value }))}
            placeholder="Tell customers about your venue, tables, ambience, food, and tournaments..."
            className="w-full bg-neutral-900 border border-neutral-800 rounded-xl p-3 text-xs text-neutral-100 outline-none focus:border-amber-500 resize-none leading-relaxed"
          />
        </div>
      </div>

      {/* ── 4. LOCATION PIN & MAP PIN ── */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-6 space-y-5">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-rose-500/10 text-rose-400 rounded-xl">
              <MapPin size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">Location Pin & Map Integration</h2>
              <p className="text-[11px] text-neutral-500">Set venue address and geolocation coordinates to pin your venue on the customer map.</p>
            </div>
          </div>
          <button 
            type="button" 
            onClick={saveLocationPin}
            disabled={isProcessing}
            className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors shadow-lg shadow-rose-950 cursor-pointer"
          >
            <Save size={14} /> Save Location
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-3">
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Venue Address</label>
              <span className="text-[10px] text-neutral-500 font-mono">{(locationForm.address || "").length}/200</span>
            </div>
            <input 
              type="text" 
              maxLength={200}
              value={locationForm.address} 
              onChange={e => setLocationForm(l => ({ ...l, address: e.target.value }))}
              placeholder="e.g. 123 Quezon Ave, Quezon City, Metro Manila"
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-rose-500"
            />
          </div>
          <div>
            <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Latitude</label>
            <input 
              type="text" 
              value={locationForm.latitude} 
              onChange={e => setLocationForm(l => ({ ...l, latitude: e.target.value }))}
              placeholder="14.6324"
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-rose-500 font-mono"
            />
          </div>
          <div>
            <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Longitude</label>
            <input 
              type="text" 
              value={locationForm.longitude} 
              onChange={e => setLocationForm(l => ({ ...l, longitude: e.target.value }))}
              placeholder="121.0336"
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-rose-500 font-mono"
            />
          </div>
          <div className="flex items-end">
            <a 
              href={`https://www.google.com/maps/search/?api=1&query=${mapsQuery}`} 
              target="_blank" 
              rel="noopener noreferrer"
              className="w-full py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors border border-neutral-700"
            >
              <Navigation size={13} /> View on Google Maps &rarr;
            </a>
          </div>
        </div>

        <div>
          <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Google Maps Embed URL / Share Link (Optional)</label>
          <input 
            type="text" 
            value={locationForm.googleMapsEmbedUrl || ""} 
            onChange={e => setLocationForm(l => ({ ...l, googleMapsEmbedUrl: e.target.value }))}
            placeholder='Paste Google Maps embed link or <iframe src="..."> code'
            className="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-rose-500 font-mono"
          />
          <p className="text-[10px] text-neutral-500 mt-1">If empty, the live map automatically generates an embedded pin from your Venue Address and Latitude/Longitude coordinates.</p>
        </div>

        {/* Live Interactive Map Pin Preview */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-neutral-400 mb-2">
            <span className="font-semibold flex items-center gap-1.5">
              <MapPin size={14} className="text-rose-500 animate-bounce" /> Live Map Pin Preview
            </span>
            <span className="text-[10px] text-neutral-500">Coordinates: {locationForm.latitude}, {locationForm.longitude}</span>
          </div>
          <div className="h-64 rounded-xl overflow-hidden border border-neutral-800 relative bg-neutral-950">
            <iframe 
              title="Location Pin Map"
              width="100%" 
              height="100%" 
              style={{ border: 0, filter: "invert(90%) hue-rotate(180deg)" }} 
              loading="lazy" 
              src={`https://maps.google.com/maps?q=${mapsQuery}&t=&z=15&ie=UTF8&iwloc=&output=embed`}
            />
          </div>
        </div>
      </div>

      {/* ── 5. MEDIA & HERO IMAGE SLIDER (WITH LIVE SLIDER PREVIEW) ── */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-6 space-y-6">
        <div className="border-b border-neutral-800 pb-3 flex justify-between items-center">
          <div>
            <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
              <LayoutTemplate size={18} className="text-sky-400" /> Website Imagery & Hero Slider
            </h2>
            <p className="text-[11px] text-neutral-500">Currently saved images in your hero carousel and featured story banner.</p>
          </div>
          <span className="text-xs bg-sky-500/10 text-sky-400 border border-sky-500/20 px-2.5 py-1 rounded-lg font-bold">
            {heroList.length}/5 Saved Slides
          </span>
        </div>

        {/* 🟢 Live Hero Slider Carousel Preview */}
        {heroList.length > 0 ? (
          <div className="bg-neutral-900/80 border border-neutral-800 rounded-2xl p-4 space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider flex items-center gap-1.5">
                <Eye size={14} className="text-sky-400" /> Live Hero Slider Preview (Slide {activeSlideIdx + 1} of {heroList.length})
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setActiveSlideIdx(prev => (prev - 1 + heroList.length) % heroList.length)}
                  className="p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-lg transition-colors cursor-pointer"
                  title="Previous Slide"
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSlideIdx(prev => (prev + 1) % heroList.length)}
                  className="p-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-lg transition-colors cursor-pointer"
                  title="Next Slide"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>

            <div className="relative h-60 w-full rounded-xl overflow-hidden border border-neutral-700 shadow-2xl bg-black">
              <img 
                src={heroList[activeSlideIdx].startsWith("http") ? heroList[activeSlideIdx] : `http://localhost:3001${heroList[activeSlideIdx]}`} 
                alt={`Hero Slide ${activeSlideIdx + 1}`} 
                className="w-full h-full object-cover transition-all duration-500" 
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent flex items-end p-4">
                <div className="text-white">
                  <span className="text-[10px] bg-sky-600 px-2 py-0.5 rounded font-bold uppercase tracking-wider">Slide {activeSlideIdx + 1}</span>
                  <p className="text-xs font-semibold mt-1 text-neutral-300 truncate max-w-lg">{heroList[activeSlideIdx]}</p>
                </div>
              </div>

              {/* Indicator Dots */}
              <div className="absolute bottom-4 right-4 flex gap-1.5">
                {heroList.map((_: any, dotIdx: number) => (
                  <button 
                    key={dotIdx} 
                    type="button" 
                    onClick={() => setActiveSlideIdx(dotIdx)}
                    className={`h-2 rounded-full transition-all ${dotIdx === activeSlideIdx ? "w-6 bg-sky-400" : "w-2 bg-white/40 hover:bg-white/70"}`}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-neutral-900/40 border border-neutral-800 border-dashed rounded-xl p-8 text-center">
            <ImageIcon size={32} className="mx-auto text-neutral-600 mb-2" />
            <p className="text-xs text-neutral-400 font-semibold">No images currently saved in Hero Slider.</p>
            <p className="text-[10px] text-neutral-600 mt-1">Upload up to 5 slides below and click "Save Gallery" to persist.</p>
          </div>
        )}

        {/* Hero Gallery Manage List */}
        <div className="space-y-3 pt-2">
          <div className="flex justify-between items-center">
            <h3 className="text-xs text-neutral-400 font-semibold uppercase tracking-wider">Manage Slider Images</h3>
            <button 
              type="button" 
              onClick={saveHeroImages} 
              disabled={isProcessing}
              className="bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-lg shadow-sky-950 cursor-pointer"
            >
              <Save size={14} /> Save Gallery
            </button>
          </div>

          <div className="flex overflow-x-auto gap-3 pb-2 hide-scrollbar">
            {heroList.map((imgUrl: string, idx: number) => (
              <div 
                key={idx} 
                onClick={() => setActiveSlideIdx(idx)}
                className={`relative h-32 w-48 flex-shrink-0 rounded-xl overflow-hidden border transition-all group bg-neutral-900 cursor-pointer ${
                  idx === activeSlideIdx ? "border-sky-500 ring-2 ring-sky-500/30" : "border-neutral-700 hover:border-neutral-500"
                }`}
              >
                <img 
                  src={imgUrl.startsWith("http") ? imgUrl : `http://localhost:3001${imgUrl}`} 
                  alt={`Hero ${idx + 1}`} 
                  className="w-full h-full object-cover" 
                />
                <span className="absolute top-2 left-2 text-[9px] bg-black/70 text-white font-bold px-1.5 py-0.5 rounded backdrop-blur-sm">
                  #{idx + 1}
                </span>
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <button 
                    type="button" 
                    onClick={(e) => { e.stopPropagation(); removeHeroImage(idx); }} 
                    className="p-2 bg-rose-600 hover:bg-rose-500 text-white rounded-full transition-colors shadow-lg cursor-pointer"
                    title="Delete Image"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
            
            {heroList.length < 5 && (
              <button 
                type="button" 
                disabled={uploading} 
                onClick={() => heroInputRef.current?.click()} 
                className="h-32 w-48 flex-shrink-0 rounded-xl border-2 border-dashed border-neutral-700 hover:border-sky-500 bg-neutral-900/40 flex flex-col items-center justify-center gap-1.5 transition-colors text-neutral-400 hover:text-sky-400 disabled:opacity-50 cursor-pointer"
              >
                <Upload size={18} />
                <span className="text-[10px] font-bold">{uploading ? "Uploading..." : "Upload Slide"}</span>
                <span className="text-[9px] text-neutral-600 font-mono">Max 15MB</span>
              </button>
            )}
          </div>
          <input type="file" ref={heroInputRef} accept="image/*" multiple className="hidden" onChange={(e) => handleImageUpload(e, "hero")} />
        </div>

        {/* About Feature Image */}
        <div className="border-t border-neutral-800/80 pt-4 space-y-3">
          <div className="flex justify-between items-center">
            <h3 className="text-xs text-neutral-400 font-semibold uppercase tracking-wider">About Us Feature Photo</h3>
            <button 
              type="button" 
              onClick={saveAboutImage} 
              disabled={isProcessing}
              className="bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-lg shadow-sky-950 cursor-pointer"
            >
              <Save size={14} /> Save Feature Photo
            </button>
          </div>
          <div className="relative h-48 rounded-xl overflow-hidden border border-neutral-700 group bg-neutral-900 flex items-center justify-center max-w-md">
            {form.aboutImage ? (
              <>
                <img src={form.aboutImage.startsWith("http") ? form.aboutImage : `http://localhost:3001${form.aboutImage}`} alt="About Us Feature" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <button type="button" disabled={uploading} onClick={() => aboutInputRef.current?.click()} className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg text-xs font-bold flex items-center gap-2 transition-colors cursor-pointer">
                    <ImageIcon size={14} /> Change Photo
                  </button>
                </div>
              </>
            ) : (
              <button type="button" disabled={uploading} onClick={() => aboutInputRef.current?.click()} className="flex flex-col items-center justify-center gap-2 text-neutral-500 hover:text-sky-400 transition-colors w-full h-full cursor-pointer">
                <Upload size={24} />
                <span className="text-xs font-bold">{uploading ? "Uploading..." : "Upload Photo"}</span>
              </button>
            )}
          </div>
          <input type="file" ref={aboutInputRef} accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, "about")} />
        </div>
      </div>
    </div>
  );
}
