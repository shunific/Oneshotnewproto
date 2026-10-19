import { localFetch } from '../utils/localApi';
import { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { Package, Search, Plus, UploadCloud, Archive, CheckCircle, Clock, Check, X, AlertTriangle, RefreshCw, History } from 'lucide-react';
import { format } from 'date-fns';

export function lostPhotoUrl(image: string) {
  if (!image?.startsWith('/api/images/')) return image;
  const origin = ['localhost', '127.0.0.1'].includes(window.location.hostname) && window.location.port !== '5173' ? window.location.origin : 'http://localhost:3001';
  return origin + image;
}

export function LostAndFound() {
  const { lostItems, addLostItem, updateLostItem, deleteLostItem } = useAppContext() as any;
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'found' | 'claimed' | 'archived' | 'all'>('found');
  
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ itemName: '', description: '', image: '' });
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => () => { if (form.image.startsWith('blob:')) URL.revokeObjectURL(form.image); }, [form.image]);

  const [claimModalId, setClaimModalId] = useState<string | null>(null);
  const [claimName, setClaimName] = useState('');

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

  const CharCount = ({ current, max }: { current?: string, max: number }) => {
    const len = current?.length || 0;
    return (
      <span className={`text-[10px] ${len >= max ? 'text-rose-400 font-bold' : 'text-neutral-600'}`}>
        {len}/{max}
      </span>
    );
  };

  const filtered = lostItems.filter((item: any) => {
    const matchSearch = item.itemName.toLowerCase().includes(search.toLowerCase()) || item.description.toLowerCase().includes(search.toLowerCase());
    if (!matchSearch) return false;

    if (filter === 'all') return true;
    if (filter === 'found') return item.status === 'found' && !item.isArchived;
    if (filter === 'claimed') return item.status === 'claimed'; // Show claimed regardless of isArchived flag
    if (filter === 'archived') return item.isArchived && item.status !== 'claimed'; // Manually archived records
    return true;
  });

  const handleImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { flash('Choose a PNG, JPEG or WebP photo, 5 MiB or smaller.', 'error'); e.target.value = ''; return; }
      setForm({ ...form, image: URL.createObjectURL(file) });
      setImageFile(file);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!form.itemName.trim() || !form.description.trim()) {
      flash("Item name and description are required.", "error");
      return;
    }

    setIsSubmitting(true);
    let finalImageUrl = form.image.startsWith('/api/images/') ? form.image : '';

    try {
      if (imageFile) {
        const formData = new FormData();
        formData.append('image', imageFile);
        const res = await localFetch('http://localhost:3001/api/images', { method: 'POST', body: formData });
        if (!res.ok) throw new Error('Photo could not be saved. Please retry.');
        const data = await res.json();
        if (typeof data.url !== 'string' || !/^\/api\/images\/[0-9a-f-]{36}$/.test(data.url)) throw new Error('Photo upload could not be confirmed. Please retry.');
        if (!mounted.current) return;
        finalImageUrl = data.url;
        setForm(previous => ({ ...previous, image: finalImageUrl }));
        setImageFile(null);
      }

      if (!mounted.current) return;
      await addLostItem({
        itemName: form.itemName.trim(), 
        description: form.description.trim(), 
        image: finalImageUrl, 
        foundDate: new Date(), 
        status: 'found' 
      });
      
      if (!mounted.current) return;
      flash("Lost item successfully recorded.", "success");
      setShowModal(false);
      setForm({ itemName: '', description: '', image: '' });
      setImageFile(null);
    } catch (error) {
      if (mounted.current) flash(error instanceof Error ? error.message : "An error occurred while saving. Please retry.", "error");
    } finally {
      if (mounted.current) setIsSubmitting(false);
    }
  };

  const handleClaim = (e: React.FormEvent) => {
    e.preventDefault();
    if (!claimName.trim() || !claimModalId) {
      flash("Claimant name or ID is required.", "error");
      return;
    }
    // 🟢 Automatically archive when claimed
    updateLostItem(claimModalId, { status: 'claimed', claimedBy: claimName.trim(), claimedDate: new Date(), isArchived: true });
    flash(`Item successfully marked as claimed by ${claimName.trim()}.`, "success");
    setClaimModalId(null);
    setClaimName('');
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto relative">
      
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

      {/* 🟢 NEW: Detailed Segmented Header */}
      <div className="flex flex-col gap-5 bg-neutral-950 p-6 rounded-2xl border border-neutral-800 relative overflow-hidden">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 relative z-10">
          <div>
            <h2 className="text-2xl font-black text-white flex items-center gap-2"><Package className="text-emerald-500" /> Lost & Found</h2>
            <p className="text-sm text-neutral-500 mt-1">Manage items left behind by customers.</p>
          </div>
          <button onClick={() => setShowModal(true)} className="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded-xl font-semibold flex items-center gap-2 transition-colors flex-shrink-0 w-full md:w-auto justify-center">
            <Plus size={16} /> Log Item
          </button>
        </div>
        
        <div className="flex flex-col lg:flex-row justify-between items-stretch lg:items-center gap-3 relative z-10">
          <div className="flex bg-neutral-900 border border-neutral-800 rounded-xl p-1 overflow-x-auto w-full lg:w-auto hide-scrollbar">
            {[
              { id: 'found', label: 'Unclaimed Items' },
              { id: 'claimed', label: 'Claimed Items' },
              { id: 'archived', label: 'Archived / Misc' },
              { id: 'all', label: 'All Records' },
            ].map(f => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id as any)}
                className={`flex-1 lg:flex-none px-4 py-2 text-xs font-semibold rounded-lg whitespace-nowrap transition-all ${filter === f.id ? 'bg-neutral-800 text-emerald-400 shadow-sm' : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800/50'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          
          <div className="relative w-full lg:w-72 flex-shrink-0">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input type="text" placeholder="Search items..." value={search} onChange={e => setSearch(e.target.value)} className="w-full bg-neutral-900 border border-neutral-800 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white focus:border-emerald-500 outline-none transition-colors" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.length === 0 ? (
          <div className="col-span-full py-16 text-center border-2 border-dashed border-neutral-800 rounded-2xl">
            <Package size={32} className="mx-auto text-neutral-600 mb-3" />
            <p className="text-neutral-400 font-medium">No items found in the registry.</p>
          </div>
        ) : filtered.map((item: any) => (
          <div key={item.id} className={`bg-neutral-950 border rounded-2xl overflow-hidden flex flex-col transition-all ${item.status === 'claimed' || item.isArchived ? 'border-neutral-800 opacity-70' : 'border-emerald-900/50 hover:border-emerald-500/50'}`}>
            <div className="h-48 bg-neutral-900 relative">
              {item.image ? (
                 <img src={lostPhotoUrl(item.image)} alt={item.itemName} className="w-full h-full object-cover" />
              ) : (
                 <div className="w-full h-full flex items-center justify-center text-neutral-700"><Package size={48} /></div>
              )}
              <div className="absolute top-3 right-3 flex gap-1.5">
                {item.isArchived && item.status !== 'claimed' && <span className="text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border bg-neutral-800 text-neutral-400 border-neutral-700 shadow-lg">Archived</span>}
                {item.status === 'claimed' && (
                  <span className="text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border bg-neutral-800 text-neutral-400 border-neutral-700 shadow-lg">Claimed</span>
                )}
                {item.status === 'found' && !item.isArchived && (
                  <span className="text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border bg-emerald-500/20 text-emerald-400 border-emerald-500/30 shadow-lg">Found</span>
                )}
              </div>
            </div>
            <div className="p-5 flex-1 flex flex-col">
              <h3 className="text-lg font-bold text-white mb-1">{item.itemName}</h3>
              <p className="text-xs text-neutral-500 mb-4 line-clamp-2">{item.description}</p>
              
              <div className="mt-auto space-y-2 text-[10px] text-neutral-400">
                <div className="flex items-center gap-2"><Clock size={12}/> Found: {format(new Date(item.foundDate), 'MMM d, yyyy h:mm a')}</div>
                {item.status === 'claimed' && item.claimedBy && (
                  <div className="flex items-center gap-2 text-emerald-500"><Check size={12}/> Claimed by: {item.claimedBy} on {format(new Date(item.claimedDate!), 'MMM d')}</div>
                )}
              </div>
            </div>
            {!item.isArchived && item.status !== 'claimed' && (
              <div className="border-t border-neutral-800 p-3 flex gap-2 bg-neutral-900/50">
                <button onClick={() => setClaimModalId(item.id)} className="flex-1 bg-neutral-800 hover:bg-neutral-700 text-white text-xs font-semibold py-2 rounded-lg transition-colors">Mark as Claimed</button>
                <button onClick={() => { deleteLostItem(item.id); flash("Item moved to archives.", "success"); }} className="px-3 bg-neutral-900 hover:bg-rose-900/50 border border-neutral-800 text-neutral-500 hover:text-rose-500 rounded-lg transition-colors" title="Move to History/Archive"><Archive size={14}/></button>
              </div>
            )}
            {item.status === 'claimed' && (
              <div className="border-t border-neutral-800 p-3 flex gap-2 bg-neutral-900/50">
                <button onClick={() => { updateLostItem(item.id, { status: 'found', claimedBy: null, claimedDate: null, isArchived: false }); flash("Reverted to unclaimed status.", "success"); }} className="flex-1 bg-neutral-900 border border-neutral-700 text-neutral-400 hover:text-white text-xs font-semibold py-2 rounded-lg transition-colors">Revert to Unclaimed</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* MODALS */}
      {showModal && (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-4">Log Found Item</h3>
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="block text-xs text-neutral-400">Item Name *</label>
                  <CharCount current={form.itemName} max={50} />
                </div>
                <input disabled={isSubmitting} required maxLength={50} type="text" value={form.itemName} onChange={e => setForm({...form, itemName: e.target.value})} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-emerald-500" placeholder="e.g. Black Wallet" />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="block text-xs text-neutral-400">Description *</label>
                  <CharCount current={form.description} max={400} />
                </div>
                <textarea disabled={isSubmitting} required maxLength={400} value={form.description} onChange={e => setForm({...form, description: e.target.value})} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-emerald-500 resize-none h-20" placeholder="Contents, color, brand..." />
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">Photo</label>
                <label className="flex items-center justify-center gap-2 w-full h-24 border-2 border-dashed border-neutral-700 rounded-xl cursor-pointer hover:border-emerald-500 bg-neutral-900 transition-colors">
                  <input disabled={isSubmitting} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleImage} />
                  {form.image ? <img src={lostPhotoUrl(form.image)} className="h-full object-contain" /> : <span className="text-xs text-neutral-500 flex items-center gap-2"><UploadCloud size={16}/> Click to upload image</span>}
                </label>
              </div>
              <div className="flex gap-2 pt-2">
                <button type="button" disabled={isSubmitting} onClick={() => { setShowModal(false); setImageFile(null); setForm({ itemName: '', description: '', image: '' }); }} className="flex-1 bg-neutral-800 text-white py-2.5 rounded-xl text-sm font-semibold">Cancel</button>
                <button type="submit" disabled={isSubmitting} className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
                  {isSubmitting ? 'Saving...' : 'Save Item'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {claimModalId && (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl w-full max-w-sm p-6 shadow-2xl">
             <h3 className="text-lg font-bold text-white mb-2">Claim Item</h3>
             <p className="text-xs text-neutral-400 mb-4">Record the name or details of the person claiming this item for security purposes.</p>
             <form onSubmit={handleClaim} className="space-y-4">
               <div>
                 <div className="flex justify-between items-center mb-1.5">
                   <label className="text-xs text-neutral-400">Claimant Name / ID *</label>
                   <CharCount current={claimName} max={50} />
                 </div>
                 <input disabled={isSubmitting} required maxLength={50} type="text" value={claimName} onChange={e => setClaimName(e.target.value)} autoFocus className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-500" placeholder="Customer Name or ID..." />
               </div>
               <div className="flex gap-2">
                 <button type="button" onClick={() => { setClaimModalId(null); setClaimName(''); }} className="flex-1 bg-neutral-800 text-white py-2.5 rounded-xl text-sm font-semibold">Cancel</button>
                 <button type="submit" className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white py-2.5 rounded-xl text-sm font-semibold">Confirm Claim</button>
               </div>
             </form>
          </div>
        </div>
      )}
    </div>
  );
}