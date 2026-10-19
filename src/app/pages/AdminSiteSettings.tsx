import { localFetch } from '../utils/localApi';
import { useState, useEffect, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { 
  Save, CheckCircle, X, LayoutTemplate, 
  Upload, Trash2, Image as ImageIcon, AlertTriangle 
} from 'lucide-react';
import { supabase } from '../utils/supabase'; 

export function AdminSiteSettings() {
  const { siteConfig, updateSiteConfig } = useAppContext() as any;
  const [form, setForm] = useState<any>({});
 const [isLoaded, setIsLoaded] = useState(false);
  
  const [uploading, setUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [replaceIdx, setReplaceIdx] = useState<number | null>(null);

  const heroInputRef = useRef<HTMLInputElement>(null);
  const heroReplaceInputRef = useRef<HTMLInputElement>(null);
  const aboutInputRef = useRef<HTMLInputElement>(null);

  // 🟢 TOAST STATE WITH 5S TIMER & FADE OUT
  const [toast, setToast] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  const toastTimeout = useRef<NodeJS.Timeout | null>(null);

  const flash = (msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToast({ msg, type });
    toastTimeout.current = setTimeout(() => setToast(null), 5000);
  };

  useEffect(() => {
    if (siteConfig && Object.keys(siteConfig).length > 0 && !isLoaded) {
      let parsedHero = [];
      try {
        parsedHero = typeof siteConfig.heroImages === 'string' ? JSON.parse(siteConfig.heroImages) : (siteConfig.heroImages || []);
      } catch (e) {}
      setForm({ ...siteConfig, heroImages: parsedHero });
      setIsLoaded(true);
    }
  }, [siteConfig, isLoaded]);

  let initialHero = [];
  try {
    initialHero = typeof siteConfig?.heroImages === 'string' ? JSON.parse(siteConfig?.heroImages) : (siteConfig?.heroImages || []);
  } catch(e) {}

  const hasHeroChanges = JSON.stringify(Array.isArray(form.heroImages) ? form.heroImages : []) !== JSON.stringify(Array.isArray(initialHero) ? initialHero : []);
  const hasAboutImageChange = form.aboutImage !== siteConfig?.aboutImage;

  // 🟢 ISOLATED SAVE HANDLERS FOR IMAGES
  const saveHeroImages = async () => {
    setIsProcessing(true);
    updateSiteConfig({ heroImages: form.heroImages });
    await new Promise(resolve => setTimeout(resolve, 1500)); 
    setIsProcessing(false);
    flash("Hero gallery updated successfully!", "success");
  };

  const saveAboutImage = async () => {
    setIsProcessing(true);
    updateSiteConfig({ aboutImage: form.aboutImage });
    await new Promise(resolve => setTimeout(resolve, 1500)); 
    setIsProcessing(false);
    flash("Featured image updated successfully!", "success");
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>, target: 'hero' | 'about') => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    // 🟢 Validator for images and size limit
    const MAX_SIZE_MB = 20;
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        flash(`File "${file.name}" is not a valid image.`, "error");
        e.target.value = '';
        return;
      }
      if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        flash(`Image "${file.name}" exceeds the ${MAX_SIZE_MB}MB maximum size limit.`, "error");
        e.target.value = '';
        return;
      }
    }

    if (target === 'about' && form.aboutImage) {
      const confirmReplace = window.confirm("Are you sure you want to replace the existing About Us featured image on the live website?");
      if (!confirmReplace) {
        e.target.value = '';
        return;
      }
    }

    setUploading(true);
    flash("Uploading to Cloud...", "success");
    try {
      for (const file of files) {
        const fileExt = file.name.split('.').pop();
        const fileName = `${target}_${Date.now()}_${Math.floor(Math.random() * 1000)}.${fileExt}`;
        
        const { error: uploadError } = await supabase.storage
          .from('oneshot-assets')
          .upload(fileName, file);
          
        if (uploadError) throw uploadError;
        
        const { data: publicUrlData } = supabase.storage
          .from('oneshot-assets')
          .getPublicUrl(fileName);
          
        const url = publicUrlData.publicUrl;
        
        if (target === 'hero') {
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
      flash("Image successfully uploaded to Cloud. Click update to save changes.", "success");
    } catch (error: any) {
      console.error('Supabase Upload Error:', error);
      flash(`Upload failed: ${error.message || 'Ensure Storage bucket is public.'}`, "error");
    } finally {
      setUploading(false);
      e.target.value = ''; 
    }
  };

  const removeHeroImage = (indexToRemove: number) => {
    const isConfirmed = window.confirm(
      "Are you sure you want to remove this image from the live Hero Gallery?"
    );
    if (!isConfirmed) return;

    setForm((prev: any) => ({
      ...prev,
      heroImages: (Array.isArray(prev.heroImages) ? prev.heroImages : []).filter((_: string, idx: number) => idx !== indexToRemove)
    }));
  };

 if (!isLoaded) return null;

  return (
    <div className="space-y-6 max-w-4xl relative pb-10">
      {/* 🟢 FULL SCREEN SPINNER TO BLOCK INPUTS */}
      {isProcessing && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-4 bg-neutral-950 p-8 rounded-2xl border border-neutral-800 shadow-2xl">
            <div className="w-12 h-12 border-4 border-sky-500/20 border-t-sky-500 rounded-full animate-spin"></div>
            <p className="text-xs font-bold text-sky-400 uppercase tracking-widest animate-pulse">Syncing Changes...</p>
          </div>
        </div>
      )}
      
      {/* 🟢 TOP-RIGHT FLOATING TOAST WITH 5S TIMER & FADE OUT */}
      {toast && (
        <div 
          className="fixed top-6 right-6 z-[9999] animate-in slide-in-from-top-4 fade-in duration-300"
          style={{ animation: 'toast-fade-out 5s forwards' }}
        >
          <div className={`relative overflow-hidden flex items-start gap-3 px-5 py-4 rounded-xl border shadow-2xl backdrop-blur-md min-w-[320px] max-w-md ${
            toast.type === 'success' 
              ? 'bg-sky-950/90 border-sky-900/50 text-sky-400' 
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
              className={`absolute bottom-0 left-0 h-1 ${toast.type === 'success' ? 'bg-sky-500' : 'bg-rose-500'}`}
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

      <div className="bg-sky-950/20 border border-sky-900/30 rounded-xl p-4 flex items-start gap-3">
        <LayoutTemplate size={15} className="text-sky-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-sky-400/80 leading-relaxed">
          <strong>Image Management:</strong> Homepage text content is now hardcoded. Use this section strictly to manage the live Hero Gallery and About Us images.
        </p>
      </div>

      <div className="space-y-6 animate-in fade-in duration-300">
        
        {/* HERO GALLERY SECTION */}
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-5 flex flex-col">
          <div className="flex justify-between items-center border-b border-neutral-800 pb-3 mb-4">
            <h3 className="text-xs text-neutral-500 uppercase tracking-widest font-semibold">Slider Gallery</h3>
            <div className="flex items-center gap-3">
              <span className="text-[10px] bg-neutral-800 text-neutral-400 px-2 py-0.5 rounded-md">{(Array.isArray(form.heroImages) ? form.heroImages : []).length}/5 Uploaded</span>
              <button 
                type="button" 
                onClick={saveHeroImages} 
                disabled={!hasHeroChanges || isProcessing}
                className="bg-sky-600 hover:bg-sky-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-semibold flex items-center gap-1.5 transition-colors shadow-lg shadow-sky-900/20"
              >
                <Save size={14} /> Update Gallery
              </button>
            </div>
          </div>
          
          <div className="flex overflow-x-auto gap-3 pb-2 mb-4 flex-1 hide-scrollbar">
            {(Array.isArray(form.heroImages) ? form.heroImages : []).map((imgUrl: string, idx: number) => (
              <div key={idx} className="relative h-32 w-48 flex-shrink-0 rounded-lg overflow-hidden border border-neutral-700 group bg-neutral-900">
                <img src={imgUrl.startsWith('http') ? imgUrl : `http://localhost:3001${imgUrl}`} alt={`Hero ${idx + 1}`} className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <button type="button" onClick={() => removeHeroImage(idx)} className="p-2 bg-rose-600 hover:bg-rose-500 text-white rounded-full transition-colors shadow-lg">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
            
            {(Array.isArray(form.heroImages) ? form.heroImages : []).length < 5 && (
              <button type="button" disabled={uploading} onClick={() => heroInputRef.current?.click()} className="h-32 w-48 flex-shrink-0 rounded-lg border-2 border-dashed border-neutral-700 hover:border-sky-500/50 bg-neutral-900/50 flex flex-col items-center justify-center gap-1.5 transition-colors text-neutral-500 hover:text-sky-400 disabled:opacity-50 cursor-pointer">
                <Upload size={16} />
                <span className="text-[10px] font-semibold">{uploading ? 'Uploading...' : 'Upload Image'}</span>
              </button>
            )}
          </div>

          <input type="file" ref={heroInputRef} accept="image/*" multiple className="hidden" onChange={(e) => handleImageUpload(e, 'hero')} />
        </div>

        {/* ABOUT US IMAGE SECTION */}
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-5">
          <div className="flex justify-between items-center border-b border-neutral-800 pb-3 mb-4">
            <h3 className="text-xs text-neutral-500 uppercase tracking-widest font-semibold">About Featured Image</h3>
            <button 
              type="button" 
              onClick={saveAboutImage} 
              disabled={!hasAboutImageChange || isProcessing}
              className="bg-sky-600 hover:bg-sky-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-semibold flex items-center gap-1.5 transition-colors shadow-lg shadow-sky-900/20"
            >
              <Save size={14} /> Update Image
            </button>
          </div>
          <p className="text-[10px] text-neutral-500 mb-4">Upload the feature image shown next to the hardcoded "About Us" text.</p>
          
          <div className="relative h-64 rounded-xl overflow-hidden border border-neutral-700 group bg-neutral-900 flex items-center justify-center max-w-2xl">
            {form.aboutImage ? (
              <>
                <img src={form.aboutImage.startsWith('http') ? form.aboutImage : `http://localhost:3001${form.aboutImage}`} alt="About Us Feature" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-3">
                  <button type="button" disabled={uploading} onClick={() => aboutInputRef.current?.click()} className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors disabled:opacity-50">
                    <ImageIcon size={14} /> {uploading ? 'Uploading...' : 'Change Image'}
                  </button>
                </div>
              </>
            ) : (
              <button type="button" disabled={uploading} onClick={() => aboutInputRef.current?.click()} className="flex flex-col items-center justify-center gap-2 text-neutral-500 hover:text-sky-400 transition-colors w-full h-full disabled:opacity-50">
                <Upload size={24} />
                <span className="text-xs font-semibold">{uploading ? 'Uploading...' : 'Upload Feature Image'}</span>
              </button>
            )}
          </div>
          <input type="file" ref={aboutInputRef} accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, 'about')} />
        </div>

      </div>
    </div>
  );
}