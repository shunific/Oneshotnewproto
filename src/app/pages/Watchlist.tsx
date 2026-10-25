import { useState, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { ShieldAlert, Search, Plus, X, AlertTriangle, Scale, Archive, Link as LinkIcon, CheckCircle, RefreshCw, Pencil } from 'lucide-react';
import { format } from 'date-fns';

const REASON_CFG = {
  debt:   { color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20', label: 'Unpaid Debt' },
  theft:  { color: 'text-rose-500',  bg: 'bg-rose-500/10',  border: 'border-rose-500/20',  label: 'Theft / Damage' },
  banned: { color: 'text-red-500',   bg: 'bg-red-500/10',   border: 'border-red-500/30',   label: 'Banned' },
  other:  { color: 'text-blue-400',  bg: 'bg-blue-500/10',  border: 'border-blue-500/20',  label: 'Other Concern' },
};

export function Watchlist() {
  const { watchlist, addWatchlistItem, updateWatchlistItem, deleteWatchlistItem } = useAppContext() as any;
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'active' | 'resolved' | 'archived' | 'all'>('active');
  
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState({ name: '', reason: 'debt', description: '', evidenceLink: '' });
  const [confirmResolveId, setConfirmResolveId] = useState<string | null>(null);

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

  const filtered = watchlist.filter((item: any) => {
    const matchSearch = item.name.toLowerCase().includes(search.toLowerCase()) || item.description.toLowerCase().includes(search.toLowerCase());
    if (!matchSearch) return false;

    if (filter === 'all') return true;
    if (filter === 'active') return item.status === 'active' && !item.isArchived;
    if (filter === 'resolved') return item.status === 'resolved'; // Show resolved regardless of isArchived flag
    if (filter === 'archived') return item.isArchived && item.status !== 'resolved'; // Manually archived records
    return true;
  });

  const openEntry = (item?: any) => {
    setEditingId(item?.id || null);
    setForm(item ? { name: item.name, reason: item.reason, description: item.description, evidenceLink: item.evidenceLink || '' } : { name: '', reason: 'debt', description: '', evidenceLink: '' });
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    if (!form.name.trim() || !form.description.trim()) {
      flash('Name and description are required.', 'error');
      return;
    }
    setIsSaving(true);
    try {
      const details = { name: form.name.trim(), reason: form.reason as any, description: form.description.trim(), evidenceLink: form.evidenceLink.trim() };
      if (editingId) await updateWatchlistItem(editingId, details);
      else await addWatchlistItem({ ...details, dateAdded: new Date(), status: 'active' });
      flash(editingId ? 'Watchlist entry updated.' : 'New entry added to the security watchlist.', 'success');
      setShowModal(false);
      setEditingId(null);
      setForm({ name: '', reason: 'debt', description: '', evidenceLink: '' });
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Entry could not be saved. Please retry.', 'error');
    } finally { setIsSaving(false); }
  };

  const handleStatusChange = async (id: string, action: 'resolve' | 'reopen' | 'archive') => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      if (action === 'archive') await deleteWatchlistItem(id);
      else await updateWatchlistItem(id, action === 'resolve' ? { status: 'resolved', resolvedDate: new Date(), isArchived: true } : { status: 'active', resolvedDate: null, isArchived: false });
      setConfirmResolveId(null);
      flash(action === 'resolve' ? 'Case marked as resolved and moved to archives.' : action === 'reopen' ? 'Case re-opened.' : 'Case manually archived.', 'success');
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Case could not be saved. Please retry.', 'error');
    } finally { setIsSaving(false); }
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
      <div className="flex flex-col gap-5 bg-neutral-950 p-6 rounded-2xl border border-rose-900/30 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-rose-500/5 blur-[100px] pointer-events-none" />
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 relative z-10">
          <div>
            <h2 className="text-2xl font-black text-white flex items-center gap-2"><ShieldAlert className="text-rose-500" /> Security Watchlist</h2>
            <p className="text-sm text-neutral-500 mt-1">Confidential internal registry for security and debt tracking.</p>
          </div>
          <button disabled={isSaving} onClick={() => openEntry()} className="bg-rose-600 hover:bg-rose-500 text-white px-5 py-2.5 rounded-xl font-semibold flex items-center gap-2 transition-colors flex-shrink-0 w-full md:w-auto justify-center">
            <Plus size={16} /> Add Entry
          </button>
        </div>
        
        <div className="flex flex-col lg:flex-row justify-between items-stretch lg:items-center gap-3 relative z-10">
          <div className="flex bg-neutral-900 border border-neutral-800 rounded-xl p-1 overflow-x-auto w-full lg:w-auto hide-scrollbar">
            {[
              { id: 'active', label: 'Active Alerts' },
              { id: 'resolved', label: 'Resolved Cases' },
              { id: 'archived', label: 'Archived / Misc' },
              { id: 'all', label: 'All Records' },
            ].map(f => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id as any)}
                className={`flex-1 lg:flex-none px-4 py-2 text-xs font-semibold rounded-lg whitespace-nowrap transition-all ${filter === f.id ? 'bg-neutral-800 text-rose-400 shadow-sm' : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800/50'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          
          <div className="relative w-full lg:w-72 flex-shrink-0">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input type="text" placeholder="Search individuals..." value={search} onChange={e => setSearch(e.target.value)} className="w-full bg-neutral-900 border border-neutral-800 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white focus:border-rose-500 outline-none transition-colors" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.length === 0 ? (
          <div className="col-span-full py-16 text-center border-2 border-dashed border-neutral-800 rounded-2xl">
            <ShieldAlert size={32} className="mx-auto text-neutral-600 mb-3" />
            <p className="text-neutral-400 font-medium">No watchlist records found.</p>
          </div>
        ) : filtered.map((item: any) => {
          const cfg = REASON_CFG[item.reason as keyof typeof REASON_CFG] || REASON_CFG.other;
          return (
          <div key={item.id} className={`bg-neutral-950 border rounded-2xl overflow-hidden flex flex-col transition-all ${item.status === 'resolved' || item.isArchived ? 'border-neutral-800 opacity-60' : `border-${cfg.color.split('-')[1]}-900/50`}`}>
            <div className="p-5 flex-1 flex flex-col">
              <div className="flex justify-between items-start mb-2 gap-2">
                <h3 className="text-lg font-bold text-white flex items-center gap-2 min-w-0">
                  <span className="truncate" title={item.name}>{item.name}</span>
                  {item.isArchived && item.status !== 'resolved' && <span className="text-[10px] bg-neutral-800 text-neutral-500 px-2 py-0.5 rounded uppercase font-black tracking-widest border border-neutral-700 flex-shrink-0 shadow-lg">Archived</span>}
                </h3>
                {item.status === 'resolved' ? (
                  <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border bg-neutral-800 text-neutral-400 border-neutral-700 shadow-lg">Resolved</span>
                ) : (
                  !item.isArchived && <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span>
                )}
              </div>
              <p className="text-xs text-neutral-400 leading-relaxed mb-4 line-clamp-4" title={item.description}>{item.description}</p>
              
              {item.evidenceLink && (
                <a href={item.evidenceLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 bg-blue-950/20 w-fit px-3 py-1.5 rounded-lg border border-blue-900/30 mb-4 transition-colors">
                  <LinkIcon size={12} /> View Evidence Link
                </a>
              )}
              
              <div className="mt-auto space-y-3">
                <button disabled={isSaving} onClick={() => openEntry(item)} className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white disabled:opacity-50"><Pencil size={14}/> Edit Entry</button>
                <div className="flex items-center justify-between text-[10px] text-neutral-500 border-t border-neutral-800 pt-3">
                  <span>Added: {format(new Date(item.dateAdded), 'MMM d, yyyy')}</span>
                  {item.resolvedDate && <span className="text-emerald-500">Resolved: {format(new Date(item.resolvedDate), 'MMM d, yyyy')}</span>}
                </div>
                {!item.isArchived && item.status !== 'resolved' && (
                  <div className="flex gap-2">
                    {confirmResolveId === item.id ? (
                      <button 
                        disabled={isSaving} onClick={() => handleStatusChange(item.id, 'resolve')}
                        className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500 text-xs font-bold py-2 rounded-lg transition-colors flex justify-center items-center gap-1.5 shadow-lg shadow-emerald-900/40"
                      >
                        <CheckCircle size={14}/> Sure to Resolve?
                      </button>
                    ) : (
                      <button 
                        onClick={() => setConfirmResolveId(item.id)} 
                        className="flex-1 bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 text-xs font-semibold py-2 rounded-lg transition-colors flex justify-center items-center gap-1.5"
                      >
                        <Scale size={14}/> Resolve Case
                      </button>
                    )}
                    <button 
                      disabled={isSaving} onClick={() => handleStatusChange(item.id, 'archive')}
                      className="px-3 bg-neutral-900 hover:bg-rose-900/50 border border-neutral-800 text-neutral-400 hover:text-rose-500 rounded-lg transition-colors" 
                      title="Move to History/Archive"
                    >
                      <Archive size={14}/>
                    </button>
                  </div>
                )}
                {item.status === 'resolved' && (
                  <div className="flex gap-2">
                    <button 
                      disabled={isSaving} onClick={() => handleStatusChange(item.id, 'reopen')}
                      className="flex-1 bg-neutral-900 border border-neutral-700 text-neutral-400 hover:text-white text-xs font-semibold py-2 rounded-lg transition-colors"
                    >
                      Re-open Case
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )})}
      </div>

      {showModal && (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-950 border border-rose-900/30 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-rose-500 flex items-center gap-2 mb-4"><AlertTriangle size={18}/> {editingId ? 'Edit Watchlist Entry' : 'New Watchlist Entry'}</h3>
            <form onSubmit={handleSave}><fieldset disabled={isSaving} className="space-y-4">
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs text-neutral-400">Individual Name / Alias *</label>
                  <CharCount current={form.name} max={50} />
                </div>
                <input required maxLength={50} type="text" value={form.name} onChange={e => setForm({...form, name: e.target.value})} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-rose-500" placeholder="e.g. John Doe" />
              </div>
              
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">Reason Category *</label>
                <select value={form.reason} onChange={e => setForm({...form, reason: e.target.value})} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-rose-500">
                  <option value="debt">Unpaid Debt / Bill</option>
                  <option value="theft">Theft / Property Damage</option>
                  <option value="banned">Banned for Misconduct</option>
                  <option value="other">Other Concern</option>
                </select>
              </div>

              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs text-neutral-400">Description & Evidence *</label>
                  <CharCount current={form.description} max={400} />
                </div>
                <textarea required maxLength={400} value={form.description} onChange={e => setForm({...form, description: e.target.value})} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-rose-500 resize-none h-24" placeholder="Detail the incident, amount owed, or reason for banning..." />
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">Evidence Link (Google Drive, Docs, etc.)</label>
                <div className="relative">
                  <LinkIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
                  <input type="url" value={form.evidenceLink} onChange={e => setForm({...form, evidenceLink: e.target.value})} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl pl-9 pr-3 py-2 text-sm text-white outline-none focus:border-rose-500" placeholder="https://drive.google.com/..." />
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 bg-neutral-800 text-white py-2.5 rounded-xl text-sm font-semibold">Cancel</button>
                <button type="submit" className="flex-1 bg-rose-600 hover:bg-rose-500 text-white py-2.5 rounded-xl text-sm font-semibold">{isSaving ? 'Saving...' : editingId ? 'Save Changes' : 'Log Entry'}</button>
              </div>
            </fieldset></form>
          </div>
        </div>
      )}
    </div>
  );
}