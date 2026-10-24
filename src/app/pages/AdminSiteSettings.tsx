import React, { useState, useEffect, useRef } from "react";
import { useAppContext } from "../context/AppContext";
import { 
  Save, CheckCircle, X, LayoutTemplate, Clock, MapPin, 
  Upload, Trash2, Image as ImageIcon, AlertTriangle, Users, 
  Info, Globe, Sliders, Navigation
} from "lucide-react";
import { supabase } from "../utils/supabase"; 

export function AdminSiteSettings() {
  const { 
    siteConfig, updateSiteConfig, 
    rates, updateRates, 
    reservationTerms, updateReservationTerms, 
    theme 
  } = useAppContext() as any;

  const [form, setForm] = useState<any>({});
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

  const [isLoaded, setIsLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [replaceIdx, setReplaceIdx] = useState<number | null>(null);

  const heroInputRef = useRef<HTMLInputElement>(null);
  const aboutInputRef = useRef<HTMLInputElement>(null);

  // Toast notification
  const [toast, setToast] = useState<{msg: string, type: "success" | "error"} | null>(null);
  const toastTimeout = useRef<any | null>(null);

  const flash = (msg: string, type: "success" | "error" = "success") => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToast({ msg, type });
    toastTimeout.current = setTimeout(() => setToast(null), 5000);
  };

  useEffect(() => {
    if (siteConfig && !isLoaded) {
      let parsedHero = [];
      try {
        parsedHero = typeof siteConfig.heroImages === "string" ? JSON.parse(siteConfig.heroImages) : (siteConfig.heroImages || []);
      } catch (e) {}
      setForm({
        ...siteConfig,
        venueName: siteConfig.venueName || "One Shot Bar & Billiards",
        tagline: siteConfig.tagline || "Your premier destination for billiards, cocktails, and good times.",
        description: siteConfig.description || "Experience the best pool tables, delicious bar chow, and chill ambience in the metro. Perfect for casual games, tournaments, and private events.",
        contactNumber: siteConfig.contactNumber || "0917-123-4567",
        contactEmail: siteConfig.contactEmail || "info@oneshotbilliards.ph",
        heroImages: parsedHero
      });
      setLocationForm({
        address: siteConfig.address || "One Shot Bar and Billiards Cainta",
        latitude: siteConfig.latitude || "14.5813",
        longitude: siteConfig.longitude || "121.1249",
        googleMapsEmbedUrl: siteConfig.googleMapsEmbedUrl || "",
      });
      setIsLoaded(true);
    }
  }, [siteConfig, isLoaded]);

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

  useEffect(() => {
    if (reservationTerms) {
      setOccupancyForm({
        weekdayMinPartySize: Number(reservationTerms.weekdayMinPartySize) || 1,
        weekdayMaxPartySize: Number(reservationTerms.weekdayMaxPartySize) || 8,
        weekendMinPartySize: Number(reservationTerms.weekendMinPartySize) || 1,
        weekendMaxPartySize: Number(reservationTerms.weekendMaxPartySize) || 10,
        advanceBookingHours: Number(reservationTerms.advanceBookingHours) || 1,
        cancellationHours: Number(reservationTerms.cancellationHours) || 24,
      });
    }
  }, [reservationTerms]);

  // Save General Info & Description
  const saveGeneralInfo = async () => {
    // Phone validation: numbers only
    const cleanPhone = (form.contactNumber || "").trim();
    if (cleanPhone && !/^\d+$/.test(cleanPhone)) {
      flash("Contact phone must contain only numbers (no letters or special characters).", "error");
      return;
    }
    if (cleanPhone && (cleanPhone.length < 11 || cleanPhone.length > 13)) {
      flash("Contact phone number must be between 11 and 13 digits (e.g. 09171234567).", "error");
      return;
    }

    // Email validation: strict email regex format
    const cleanEmail = (form.contactEmail || "").trim();
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (cleanEmail && !emailRegex.test(cleanEmail)) {
      flash("Please enter a valid email address format (e.g. contact@oneshot.com).", "error");
      return;
    }

    setIsProcessing(true);
    try {
      await updateSiteConfig({
        venueName: form.venueName,
        tagline: form.tagline,
        description: form.description,
        contactNumber: cleanPhone,
        contactEmail: cleanEmail,
      });
      flash("General information updated successfully!", "success");
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
      const trimmedAddress = (locationForm.address || "").trim().slice(0, 200);
      const trimmedLat = String(locationForm.latitude || "").trim();
      const trimmedLng = String(locationForm.longitude || "").trim();
      let trimmedEmbed = (locationForm.googleMapsEmbedUrl || "").trim();
      const iframeMatch = trimmedEmbed.match(/src=["']([^"']+)["']/i);
      if (iframeMatch) {
        trimmedEmbed = iframeMatch[1];
      }

      await updateSiteConfig({
        address: trimmedAddress,
        latitude: trimmedLat,
        longitude: trimmedLng,
        googleMapsEmbedUrl: trimmedEmbed,
      });
      flash("Location pin and address updated successfully!", "success");
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
      flash("Operating hours updated successfully!", "success");
    } catch (err: any) {
      flash(err.message || "Failed to update operating hours.", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  // Save Max Occupancies & Global Adjustments
  const saveOccupancyAndAdjustments = async () => {
    if (occupancyForm.weekdayMinPartySize <= 0 || occupancyForm.weekdayMaxPartySize <= 0) {
      flash("Party sizes must be at least 1 person.", "error");
      return;
    }
    if (occupancyForm.weekdayMinPartySize > occupancyForm.weekdayMaxPartySize) {
      flash("Weekday min party size cannot exceed max party size.", "error");
      return;
    }
    if (occupancyForm.weekendMinPartySize > occupancyForm.weekendMaxPartySize) {
      flash("Weekend min party size cannot exceed max party size.", "error");
      return;
    }

    setIsProcessing(true);
    try {
      await updateReservationTerms({
        weekdayMinPartySize: Number(occupancyForm.weekdayMinPartySize),
        weekdayMaxPartySize: Number(occupancyForm.weekdayMaxPartySize),
        weekendMinPartySize: Number(occupancyForm.weekendMinPartySize),
        weekendMaxPartySize: Number(occupancyForm.weekendMaxPartySize),
        advanceBookingHours: Number(occupancyForm.advanceBookingHours),
        cancellationHours: Number(occupancyForm.cancellationHours),
      });
      flash("Occupancy and global adjustments updated successfully!", "success");
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
      flash("Hero gallery updated successfully!", "success");
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
      flash("Featured image updated successfully!", "success");
    } catch (err: any) {
      flash("Failed to update featured image.", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>, target: "hero" | "about") => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const MAX_SIZE_MB = 20;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        flash(`File "${file.name}" is not a valid image.`, "error");
        e.target.value = "";
        return;
      }
      if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        flash(`Image "${file.name}" exceeds the ${MAX_SIZE_MB}MB maximum limit.`, "error");
        e.target.value = "";
        return;
      }
    }

    setUploading(true);
    flash("Uploading to Cloud...", "success");
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
          if (replaceIdx !== null) {
            setForm((prev: any) => {
              const current = Array.isArray(prev.heroImages) ? [...prev.heroImages] : [];
              current[replaceIdx] = url;
              return { ...prev, heroImages: current };
            });
            setReplaceIdx(null);
          } else {
            setForm((prev: any) => {
              const current = Array.isArray(prev.heroImages) ? prev.heroImages : [];
              if (current.length >= 5) return prev; 
              return { ...prev, heroImages: [...current, url] };
            });
          }
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
    setForm((prev: any) => ({
      ...prev,
      heroImages: (Array.isArray(prev.heroImages) ? prev.heroImages : []).filter((_: string, idx: number) => idx !== indexToRemove)
    }));
  };

  const mapsQuery = encodeURIComponent(locationForm.address || `${locationForm.latitude},${locationForm.longitude}`);

  return (
    <div className="space-y-8 max-w-5xl relative pb-20 animate-in fade-in duration-300">
      {/* Loading Overlay */}
      {isProcessing && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-4 bg-neutral-950 p-8 rounded-2xl border border-neutral-800 shadow-2xl">
            <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
            <p className="text-xs font-bold text-emerald-400 uppercase tracking-widest animate-pulse">Saving Settings...</p>
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
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors shadow-lg shadow-emerald-950"
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

      {/* ── 2. GLOBAL ADJUSTMENTS & MAX TABLE OCCUPANCIES ── */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-6 space-y-5">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-blue-500/10 text-blue-400 rounded-xl">
              <Sliders size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">Global Adjustments & Table Occupancies</h2>
              <p className="text-[11px] text-neutral-500">Party size limits per table, advance booking notice, and booking cancellation rules.</p>
            </div>
          </div>
          <button 
            type="button" 
            onClick={saveOccupancyAndAdjustments}
            disabled={isProcessing}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors shadow-lg shadow-blue-950"
          >
            <Save size={14} /> Save Adjustments
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-neutral-900/50 border border-neutral-800 p-3.5 rounded-xl">
            <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Weekday Min Pax / Table</label>
            <input 
              type="number" 
              min={1} 
              max={20} 
              value={occupancyForm.weekdayMinPartySize} 
              onChange={e => setOccupancyForm(o => ({ ...o, weekdayMinPartySize: Number(e.target.value) }))}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2 text-xs text-neutral-100 outline-none focus:border-blue-500"
            />
          </div>
          <div className="bg-neutral-900/50 border border-neutral-800 p-3.5 rounded-xl">
            <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Weekday Max Pax / Table</label>
            <input 
              type="number" 
              min={1} 
              max={30} 
              value={occupancyForm.weekdayMaxPartySize} 
              onChange={e => setOccupancyForm(o => ({ ...o, weekdayMaxPartySize: Number(e.target.value) }))}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2 text-xs text-neutral-100 outline-none focus:border-blue-500"
            />
          </div>
          <div className="bg-neutral-900/50 border border-neutral-800 p-3.5 rounded-xl">
            <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Weekend Min Pax / Table</label>
            <input 
              type="number" 
              min={1} 
              max={20} 
              value={occupancyForm.weekendMinPartySize} 
              onChange={e => setOccupancyForm(o => ({ ...o, weekendMinPartySize: Number(e.target.value) }))}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2 text-xs text-neutral-100 outline-none focus:border-blue-500"
            />
          </div>
          <div className="bg-neutral-900/50 border border-neutral-800 p-3.5 rounded-xl">
            <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Weekend Max Pax / Table</label>
            <input 
              type="number" 
              min={1} 
              max={30} 
              value={occupancyForm.weekendMaxPartySize} 
              onChange={e => setOccupancyForm(o => ({ ...o, weekendMaxPartySize: Number(e.target.value) }))}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2 text-xs text-neutral-100 outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <div className="bg-neutral-900/40 border border-neutral-800 p-3.5 rounded-xl">
            <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Advance Booking Notice (Hours)</label>
            <input 
              type="number" 
              min={0} 
              max={72} 
              value={occupancyForm.advanceBookingHours} 
              onChange={e => setOccupancyForm(o => ({ ...o, advanceBookingHours: Number(e.target.value) }))}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2 text-xs text-neutral-100 outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-neutral-500 mt-1">Requires guests to book at least this many hours in advance.</p>
          </div>
          <div className="bg-neutral-900/40 border border-neutral-800 p-3.5 rounded-xl">
            <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Cancellation Notice (Hours)</label>
            <input 
              type="number" 
              min={0} 
              max={168} 
              value={occupancyForm.cancellationHours} 
              onChange={e => setOccupancyForm(o => ({ ...o, cancellationHours: Number(e.target.value) }))}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2 text-xs text-neutral-100 outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-neutral-500 mt-1">Grace period allowed for guests to cancel or reschedule.</p>
          </div>
        </div>
      </div>

      {/* ── 3. GENERAL INFORMATION & DESCRIPTION ── */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-6 space-y-5">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-amber-500/10 text-amber-400 rounded-xl">
              <Info size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">Venue Description & General Info</h2>
              <p className="text-[11px] text-neutral-500">Store branding, customer about story, and contact touchpoints.</p>
            </div>
          </div>
          <button 
            type="button" 
            onClick={saveGeneralInfo}
            disabled={isProcessing}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors shadow-lg shadow-amber-950"
          >
            <Save size={14} /> Save Info
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Venue Name</label>
            <input 
              type="text" 
              value={form.venueName || ""} 
              onChange={e => setForm((f: any) => ({ ...f, venueName: e.target.value }))}
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-amber-500"
            />
          </div>
          <div>
            <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Tagline / Slogan</label>
            <input 
              type="text" 
              value={form.tagline || ""} 
              onChange={e => setForm((f: any) => ({ ...f, tagline: e.target.value }))}
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-amber-500"
            />
          </div>
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Contact Phone</label>
              <span className={`text-[10px] ${(form.contactNumber || "").length > 13 || ((form.contactNumber || "").length > 0 && (form.contactNumber || "").length < 11) ? "text-amber-400 font-bold" : "text-neutral-500 font-mono"}`}>
                {(form.contactNumber || "").length}/13
              </span>
            </div>
            <input 
              type="tel" 
              inputMode="numeric"
              maxLength={13}
              value={form.contactNumber || ""} 
              onChange={e => {
                const numericOnly = e.target.value.replace(/[^0-9]/g, '').slice(0, 13);
                setForm((f: any) => ({ ...f, contactNumber: numericOnly }));
              }}
              placeholder="e.g. 09171234567"
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-amber-500 font-mono"
            />
            <p className="text-[10px] text-neutral-500 mt-1">11 to 13 digits only (e.g. 09171234567).</p>
          </div>
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Contact Email</label>
              {form.contactEmail && !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(form.contactEmail.trim()) && (
                <span className="text-[10px] text-rose-400 font-semibold">Invalid email format</span>
              )}
            </div>
            <input 
              type="email" 
              value={form.contactEmail || ""} 
              onChange={e => setForm((f: any) => ({ ...f, contactEmail: e.target.value.trim() }))}
              placeholder="e.g. contact@oneshot.com"
              className={`w-full bg-neutral-900 border rounded-lg p-2.5 text-xs text-neutral-100 outline-none font-mono ${
                form.contactEmail && !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(form.contactEmail.trim())
                  ? 'border-rose-500/80 focus:border-rose-500'
                  : 'border-neutral-800 focus:border-amber-500'
              }`}
            />
            <p className="text-[10px] text-neutral-500 mt-1">Must be a valid email format (e.g. name@domain.com).</p>
          </div>
        </div>

        <div>
          <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Venue Description (About Us)</label>
          <textarea 
            rows={4} 
            value={form.description || ""} 
            onChange={e => setForm((f: any) => ({ ...f, description: e.target.value }))}
            className="w-full bg-neutral-900 border border-neutral-800 rounded-xl p-3 text-xs text-neutral-100 outline-none focus:border-amber-500 resize-none"
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
            className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors shadow-lg shadow-rose-950"
          >
            <Save size={14} /> Save Location
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-3">
            <label className="block text-[11px] text-neutral-400 mb-1 font-medium">Venue Address</label>
            <input 
              type="text" 
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
          <div className="md:col-span-3">
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-neutral-400 font-medium">Google Maps Embed URL / Share Link (Optional)</label>
              {locationForm.googleMapsEmbedUrl && (
                <button
                  type="button"
                  onClick={() => setLocationForm(l => ({ ...l, googleMapsEmbedUrl: "" }))}
                  className="text-[10px] text-rose-400 hover:text-rose-300 font-medium"
                >
                  Clear Custom Embed Link
                </button>
              )}
            </div>
            <input 
              type="text" 
              value={locationForm.googleMapsEmbedUrl || ""} 
              onChange={e => setLocationForm(l => ({ ...l, googleMapsEmbedUrl: e.target.value }))}
              placeholder='Paste Google Maps embed URL or <iframe src="..."> code, or leave blank to auto-pin from address/coordinates'
              className="w-full bg-neutral-900 border border-neutral-800 rounded-lg p-2.5 text-xs text-neutral-100 outline-none focus:border-rose-500 font-mono"
            />
            <p className="text-[10px] text-neutral-500 mt-1">If blank, the customer map will automatically center and pin using your Venue Address and Latitude/Longitude coordinates.</p>
          </div>
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

      {/* ── 5. MEDIA & GALLERY ── */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-6 space-y-6">
        <div className="border-b border-neutral-800 pb-3">
          <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
            <LayoutTemplate size={18} className="text-sky-400" /> Website Imagery & Banners
          </h2>
          <p className="text-[11px] text-neutral-500">Manage the hero carousel photos and the featured About Us picture.</p>
        </div>

        {/* Hero Gallery */}
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <h3 className="text-xs text-neutral-400 font-semibold uppercase tracking-wider">Hero Slider Gallery</h3>
            <div className="flex items-center gap-3">
              <span className="text-[10px] bg-neutral-800 text-neutral-400 px-2 py-0.5 rounded-md">
                {(Array.isArray(form.heroImages) ? form.heroImages : []).length}/5 Uploaded
              </span>
              <button 
                type="button" 
                onClick={saveHeroImages} 
                disabled={isProcessing}
                className="bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-lg shadow-sky-950"
              >
                <Save size={14} /> Save Gallery
              </button>
            </div>
          </div>

          <div className="flex overflow-x-auto gap-3 pb-2 hide-scrollbar">
            {(Array.isArray(form.heroImages) ? form.heroImages : []).map((imgUrl: string, idx: number) => (
              <div key={idx} className="relative h-32 w-48 flex-shrink-0 rounded-xl overflow-hidden border border-neutral-700 group bg-neutral-900">
                <img src={imgUrl.startsWith("http") ? imgUrl : `http://localhost:3001${imgUrl}`} alt={`Hero ${idx + 1}`} className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <button type="button" onClick={() => removeHeroImage(idx)} className="p-2 bg-rose-600 hover:bg-rose-500 text-white rounded-full transition-colors shadow-lg">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
            
            {(Array.isArray(form.heroImages) ? form.heroImages : []).length < 5 && (
              <button type="button" disabled={uploading} onClick={() => heroInputRef.current?.click()} className="h-32 w-48 flex-shrink-0 rounded-xl border-2 border-dashed border-neutral-700 hover:border-sky-500 bg-neutral-900/40 flex flex-col items-center justify-center gap-1.5 transition-colors text-neutral-400 hover:text-sky-400 disabled:opacity-50">
                <Upload size={18} />
                <span className="text-[10px] font-bold">{uploading ? "Uploading..." : "Upload Slide"}</span>
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
              className="bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-lg shadow-sky-950"
            >
              <Save size={14} /> Save Feature Photo
            </button>
          </div>
          <div className="relative h-48 rounded-xl overflow-hidden border border-neutral-700 group bg-neutral-900 flex items-center justify-center max-w-md">
            {form.aboutImage ? (
              <>
                <img src={form.aboutImage.startsWith("http") ? form.aboutImage : `http://localhost:3001${form.aboutImage}`} alt="About Us Feature" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <button type="button" disabled={uploading} onClick={() => aboutInputRef.current?.click()} className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg text-xs font-bold flex items-center gap-2 transition-colors">
                    <ImageIcon size={14} /> Change Photo
                  </button>
                </div>
              </>
            ) : (
              <button type="button" disabled={uploading} onClick={() => aboutInputRef.current?.click()} className="flex flex-col items-center justify-center gap-2 text-neutral-500 hover:text-sky-400 transition-colors w-full h-full">
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
