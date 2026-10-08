import { useState, useRef } from 'react';
import { useAppContext, Announcement, AnnouncementType } from '../context/AppContext';
import { Plus, X, Pencil, Trash2, Megaphone, ToggleLeft, ToggleRight, CheckCircle, Info, AlertTriangle, Star, Calendar, Clock, Archive, RotateCcw } from 'lucide-react';
import { format } from 'date-fns';

const TYPE_CONFIG: Record<AnnouncementType, { label: string; color: string; bg: string; border: string; icon: React.ElementType }> = {
  info:    { label: 'Info',    color: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/20',    icon: Info },
  warning: { label: 'Warning', color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   icon: AlertTriangle },
  promo:   { label: 'Promo',   color: 'text-violet-400',  bg: 'bg-violet-500/10',  border: 'border-violet-500/20',  icon: Star },
  event:   { label: 'Event',   color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: Calendar },
};

type FormState = { 
  title: string; content: string; type: AnnouncementType; 
  isActive: boolean; 
  hasExpiry: boolean; expiresAt: string; 
  startDate: string; 
};

const blank: FormState = { 
  title: '', content: '', type: 'info', 
  isActive: true, 
  hasExpiry: false, expiresAt: '', 
  startDate: '' 
};

export function AdminAnnouncements() {
  const { announcements, addAnnouncement, updateAnnouncement, deleteAnnouncement, toggleAnnouncement } = useAppContext();
  const [showForm, setShowForm]   = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm]           = useState<FormState>(blank);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [viewTab, setViewTab]     = useState<'active' | 'history'>('active');
  
  // 🟢 TOAST STATE WITH 5-SECOND FADE
  const [toast, setToast] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  const toastTimeout = useRef<NodeJS.Timeout | null>(null);

  const flash = (msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToast({ msg, type });
    toastTimeout.current = setTimeout(() => setToast(null), 5000);
  };

  const openAdd  = () => { setEditingId(null); setForm(blank); setShowForm(true); };

  const getMinDateTime = () => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  };
  
  const openEdit = (a: Announcement) => {
    setEditingId(a.id);
    const sDate = (a as any).startDate; 
    setForm({ 
      title: a.title, content: a.content, type: a.type, 
      isActive: a.isActive, 
      hasExpiry: !!a.expiresAt, expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString().slice(0,16) : '',
      startDate: sDate ? new Date(sDate).toISOString().slice(0,16) : ''
    });
    setShowForm(true);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title || !form.content) return;
    
    // Scheduled Start Validation
    if (!form.isActive && !form.startDate) {
      flash("Please select a start date and time to schedule this announcement.", "error");
      return;
    }

    if (!form.isActive && form.startDate) {
      if (new Date(form.startDate) <= new Date()) {
        flash("Scheduled start date must be set in the future.", "error");
        return;
      }
    }

    // Expiry Validation
    if (form.hasExpiry && form.expiresAt) {
      const expiryDate = new Date(form.expiresAt);
      if (expiryDate <= new Date()) {
        flash("Expiry date cannot be in the past. Please select a future date.", "error");
        return;
      }
      if (!form.isActive && form.startDate && expiryDate <= new Date(form.startDate)) {
        flash("Expiry date must be after the scheduled start date.", "error");
        return;
      }
    }

    const payload = { 
      title: form.title, content: form.content, type: form.type, 
      isActive: form.isActive, 
      expiresAt: form.hasExpiry && form.expiresAt ? new Date(form.expiresAt) : null,
      startDate: !form.isActive && form.startDate ? new Date(form.startDate) : null 
    };
    
    if (editingId) { 
      updateAnnouncement(editingId, payload); 
      flash('Announcement updated successfully!', 'success'); 
    } else { 
      addAnnouncement(payload as any); 
      flash('Announcement posted successfully!', 'success'); 
    }
    
    setShowForm(false); setEditingId(null); setForm(blank);
  };

  // 🟢 Categorize & Sort Announcements
  const sortedAnnouncements = [...announcements].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const checkIsExpired = (a: Announcement) => a.expiresAt && new Date() > new Date(a.expiresAt);
  
  const activeList = sortedAnnouncements.filter(a => !checkIsExpired(a));
  const historyList = sortedAnnouncements.filter(a => checkIsExpired(a));
  
  const displayedAnnouncements = viewTab === 'active' ? activeList : historyList;

  const CharCount = ({ current, max }: { current?: string, max: number }) => {
    const len = current?.length || 0;
    return (
      <span className={`text-[10px] ${len >= max ? 'text-rose-400 font-bold' : 'text-neutral-600'}`}>
        {len}/{max}
      </span>
    );
  };

  return (
    <div className="space-y-5">
      {/* 🟢 TOP-RIGHT FLOATING TOAST */}
      {toast && (
        <div className="fixed top-6 right-6 z-[9999] animate-in slide-in-from-top-4 fade-in duration-300" style={{ animation: 'toast-fade-out 5s forwards' }}>
          <div className={`relative overflow-hidden flex items-start gap-3 px-5 py-4 rounded-xl border shadow-2xl backdrop-blur-md min-w-[320px] max-w-md ${toast.type === 'success' ? 'bg-emerald-950/90 border-emerald-900/50 text-emerald-400' : 'bg-rose-950/90 border-rose-900/50 text-rose-400'}`}>
            <div className="mt-0.5 flex-shrink-0">
              {toast.type === 'success' ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
            </div>
            <span className="text-sm font-semibold leading-snug whitespace-pre-wrap pr-4">{toast.msg}</span>
            <button onClick={() => { setToast(null); if (toastTimeout.current) clearTimeout(toastTimeout.current); }} className="absolute top-4 right-4 text-neutral-500 hover:text-white transition-colors">
              <X size={14} />
            </button>
            <div className={`absolute bottom-0 left-0 h-1 ${toast.type === 'success' ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ animation: 'toast-shrink 5s linear forwards' }} />
          </div>
          <style>{`
            @keyframes toast-shrink { 0% { width: 100%; } 100% { width: 0%; } }
            @keyframes toast-fade-out { 0%, 90% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(-10px); } }
          `}</style>
        </div>
      )}

      {/* 🟢 Informational Context Banner */}
      <div className="bg-amber-950/20 border border-amber-900/30 rounded-xl p-4 flex items-start gap-3">
        <Megaphone size={15} className="text-amber-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-400/80 leading-relaxed">
          <strong>Customer Broadcasts:</strong> Announcements appear prominently at the top of the customer-facing homepage. Use this tool to highlight active promos, upcoming tournaments, or critical venue updates. Scheduled announcements will automatically go live on their start date.
        </p>
      </div>

      {/* 🟢 Dynamic Stats (Based on Active/Drafts List) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 text-center">
          <p className="text-2xl font-black text-white">{activeList.length}</p>
          <p className="text-xs text-neutral-500 mt-1 uppercase tracking-wider">Active & Drafts</p>
        </div>
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 text-center">
          <p className="text-2xl font-black text-emerald-400">{activeList.filter(a => a.isActive).length}</p>
          <p className="text-xs text-neutral-500 mt-1 uppercase tracking-wider">Live Now</p>
        </div>
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 text-center">
          <p className="text-2xl font-black text-blue-400">{activeList.filter(a => !a.isActive && (a as any).startDate && new Date((a as any).startDate) > new Date()).length}</p>
          <p className="text-xs text-neutral-500 mt-1 uppercase tracking-wider">Scheduled</p>
        </div>
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 text-center">
          <p className="text-2xl font-black text-neutral-400">{historyList.length}</p>
          <p className="text-xs text-neutral-500 mt-1 uppercase tracking-wider">History</p>
        </div>
      </div>

      {/* 🟢 Toolbar & Tabs */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex gap-1 bg-neutral-950 border border-neutral-800 rounded-xl p-1 w-full sm:w-auto">
          <button 
            onClick={() => { setViewTab('active'); setDeleteConfirm(null); }}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-xs font-semibold transition-all ${viewTab === 'active' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/20' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            Active & Drafts
          </button>
          <button 
            onClick={() => { setViewTab('history'); setDeleteConfirm(null); }}
            className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${viewTab === 'history' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/20' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            <Archive size={14} /> History
          </button>
        </div>

        <button onClick={openAdd} className="flex items-center justify-center w-full sm:w-auto gap-2 bg-amber-600 hover:bg-amber-500 text-white text-sm px-4 py-2 rounded-xl font-semibold transition-all shadow-lg shadow-amber-900/30">
          <Plus size={15} /> New Announcement
        </button>
      </div>

      {/* 🟢 List Rendering */}
      <div className="space-y-3">
        {displayedAnnouncements.length === 0 ? (
          <div className="bg-neutral-950 border border-neutral-800 border-dashed rounded-2xl p-12 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 bg-neutral-900 rounded-full flex items-center justify-center mb-4">
              {viewTab === 'active' ? <Megaphone size={24} className="text-neutral-500" /> : <Archive size={24} className="text-neutral-500" />}
            </div>
            <h3 className="text-sm font-bold text-white mb-1">
              {viewTab === 'active' ? 'No Active Announcements' : 'No Announcement History'}
            </h3>
            <p className="text-xs text-neutral-500 max-w-sm mb-6">
              {viewTab === 'active' 
                ? 'Keep your customers engaged by posting updates, promos, and upcoming events.' 
                : 'Expired and removed announcements will automatically be stored here for your records.'}
            </p>
            {viewTab === 'active' && (
              <button onClick={openAdd} className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white text-xs px-4 py-2 rounded-lg font-semibold transition-colors">
                <Plus size={14} /> Create First Announcement
              </button>
            )}
          </div>
        ) : displayedAnnouncements.map(a => {
          const cfg = TYPE_CONFIG[a.type];
          const Icon = cfg.icon;
          const isExpired = checkIsExpired(a);
          const isScheduled = (a as any).startDate && new Date((a as any).startDate) > new Date();
          const isLive = a.isActive && !isExpired && !isScheduled;

          return (
            <div key={a.id} className={`bg-neutral-950 border rounded-xl p-5 transition-colors ${isLive ? cfg.border : 'border-neutral-800 opacity-75'}`}>
              <div className="flex items-start gap-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${cfg.bg} border ${cfg.border}`}>
                  <Icon size={16} className={cfg.color} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <p className="text-sm font-bold text-neutral-100">{a.title}</p>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color} ${cfg.border}`}>{cfg.label}</span>
                    
                    {/* Status Badges */}
                    {isLive && (
                      <span className="flex items-center gap-1.5 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live Now
                      </span>
                    )}
                    {isExpired && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">Expired</span>}
                    {!a.isActive && !isExpired && !isScheduled && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-500 border border-neutral-700">Draft</span>}
                    {isScheduled && !a.isActive && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">Scheduled</span>}
                  </div>
                  
                  <p className="text-xs text-neutral-400 leading-relaxed mt-1">{a.content}</p>
                  
                  {/* Structured Timeline */}
                  <div className="flex flex-wrap items-center gap-4 mt-3 text-[10px] text-neutral-500">
                    <div className="flex items-center gap-1.5">
                      <Clock size={12} className="text-neutral-600" />
                      <span>Posted {format(new Date(a.createdAt), 'MMM d, yyyy')}</span>
                    </div>
                    {(a as any).startDate && (
                      <div className="flex items-center gap-1.5">
                        <div className="w-1 h-1 bg-neutral-700 rounded-full" />
                        <span className="text-blue-400/80">Starts {format(new Date((a as any).startDate), 'MMM d, yyyy h:mm a')}</span>
                      </div>
                    )}
                    {a.expiresAt && (
                      <div className="flex items-center gap-1.5">
                        <div className="w-1 h-1 bg-neutral-700 rounded-full" />
                        <span className="text-rose-400/80">Expires {format(new Date(a.expiresAt), 'MMM d, yyyy h:mm a')}</span>
                      </div>
                    )}
                  </div>
                </div>
                
                {/* 🟢 Contextual Actions (Active vs History) */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {viewTab === 'active' ? (
                    <>
                      <button onClick={() => openEdit(a)} className="p-1.5 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors"><Pencil size={13} /></button>
                      <button onClick={() => toggleAnnouncement(a.id)} title={a.isActive ? 'Deactivate' : 'Activate'}
                        className="p-1.5 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors">
                        {a.isActive ? <ToggleRight size={18} className="text-emerald-400" /> : <ToggleLeft size={18} />}
                      </button>
                      {deleteConfirm === a.id ? (
                        <div className="flex items-center gap-1">
                          <button onClick={() => { 
                              updateAnnouncement(a.id, { isActive: false, expiresAt: new Date(), startDate: null } as any); 
                              setDeleteConfirm(null); 
                              flash('Moved to History.', 'success'); 
                            }}
                            className="px-2 py-1 text-[10px] bg-amber-700 hover:bg-amber-600 text-white rounded-lg font-semibold">Move</button>
                          <button onClick={() => setDeleteConfirm(null)} className="px-2 py-1 text-[10px] bg-neutral-800 text-neutral-400 rounded-lg">Cancel</button>
                        </div>
                      ) : (
                        <button onClick={() => setDeleteConfirm(a.id)} title="Move to History" className="p-1.5 text-neutral-500 hover:text-amber-400 hover:bg-amber-950/20 rounded-lg transition-colors"><Archive size={13} /></button>
                      )}
                    </>
                  ) : (
                    <>
                      <button onClick={() => {
                          updateAnnouncement(a.id, { isActive: false, expiresAt: null, startDate: null } as any);
                          flash('Restored to active tab as draft.', 'success');
                        }} title="Restore to Drafts" className="p-1.5 text-neutral-500 hover:text-sky-400 hover:bg-sky-950/20 rounded-lg transition-colors">
                        <RotateCcw size={13} />
                      </button>
                      {deleteConfirm === a.id ? (
                        <div className="flex items-center gap-1">
                          <button onClick={() => { deleteAnnouncement(a.id); setDeleteConfirm(null); flash('Permanently deleted.', 'success'); }}
                            className="px-2 py-1 text-[10px] bg-rose-700 hover:bg-rose-600 text-white rounded-lg font-semibold">Delete Forever</button>
                          <button onClick={() => setDeleteConfirm(null)} className="px-2 py-1 text-[10px] bg-neutral-800 text-neutral-400 rounded-lg">Cancel</button>
                        </div>
                      ) : (
                        <button onClick={() => setDeleteConfirm(a.id)} title="Permanently Delete" className="p-1.5 text-neutral-500 hover:text-rose-400 hover:bg-rose-950/20 rounded-lg transition-colors"><Trash2 size={13} /></button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 🟢 Modal */}
      {showForm && (
        <div className="fixed inset-0 z-[99] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-amber-900/30 rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[92vh]">
            <div className="px-6 py-4 border-b border-neutral-800 flex justify-between items-center flex-none">
              <h2 className="text-base font-bold text-neutral-100">{editingId ? 'Edit Announcement' : 'New Announcement'}</h2>
              <button onClick={() => setShowForm(false)} className="p-2 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg"><X size={16} /></button>
            </div>
            <form onSubmit={handleSave} className="overflow-y-auto flex-1 p-6 space-y-4">
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs text-neutral-400 font-medium">Title *</label>
                  <CharCount current={form.title} max={50} />
                </div>
                <input type="text" maxLength={50} value={form.title} onChange={e => setForm(f=>({...f, title: e.target.value}))} required autoFocus
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:border-amber-600/50 transition-colors placeholder-neutral-600" placeholder="Announcement title" />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs text-neutral-400 font-medium">Content *</label>
                  <CharCount current={form.content} max={300} />
                </div>
                <textarea value={form.content} maxLength={300} onChange={e => setForm(f=>({...f, content: e.target.value}))} required rows={4}
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:border-amber-600/50 transition-colors placeholder-neutral-600 resize-none"
                  placeholder="Announcement details..." />
              </div>
              <div>
                <label className="text-xs text-neutral-400 mb-2 block font-medium">Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.entries(TYPE_CONFIG) as [AnnouncementType, typeof TYPE_CONFIG[AnnouncementType]][]).map(([t, cfg]) => (
                    <button key={t} type="button" onClick={() => setForm(f=>({...f, type: t}))}
                      className={`flex items-center gap-2 py-2 px-3 rounded-xl border text-xs font-semibold transition-all ${form.type === t ? `${cfg.bg} ${cfg.border} ${cfg.color}` : 'bg-neutral-900 border-neutral-800 text-neutral-500 hover:border-neutral-700'}`}>
                      <cfg.icon size={12} /> {cfg.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-4 p-4 rounded-xl border border-neutral-800 bg-neutral-900/50">
                <label className="flex items-center gap-3 cursor-pointer">
                  <div className={`w-9 h-5 rounded-full relative transition-colors ${form.isActive ? 'bg-emerald-600' : 'bg-neutral-700'}`}
                    onClick={() => setForm(f=>({...f, isActive: !f.isActive}))}>
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.isActive ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </div>
                  <div>
                    <span className="text-xs font-bold text-neutral-200">Publish Immediately</span>
                    <p className="text-[10px] text-neutral-500 mt-0.5">Toggle off to schedule this announcement for later.</p>
                  </div>
                </label>

                {!form.isActive && (
                  <div className="pl-12 animate-in fade-in slide-in-from-top-1">
                    <label className="text-[10px] text-neutral-400 uppercase tracking-wider font-semibold block mb-1.5 flex items-center gap-1.5">
                      <Calendar size={10} /> Schedule Start Time *
                    </label>
                    <input 
                      type="datetime-local" 
                      min={getMinDateTime()}
                      value={form.startDate} 
                      onChange={e => setForm(f=>({...f, startDate: e.target.value}))}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-amber-500 transition-colors" 
                    />
                  </div>
                )}
              </div>

              <div className="pt-2">
                <label className="flex items-center gap-2 cursor-pointer mb-3">
                  <div className={`w-9 h-5 rounded-full relative transition-colors ${form.hasExpiry ? 'bg-amber-600' : 'bg-neutral-700'}`}
                    onClick={() => setForm(f=>({...f, hasExpiry: !f.hasExpiry}))}>
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.hasExpiry ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </div>
                  <span className="text-xs font-bold text-neutral-200">Set Expiry Date</span>
                </label>
                {form.hasExpiry && (
                  <div className="pl-11 animate-in fade-in slide-in-from-top-1">
                    <input 
                      type="datetime-local" 
                      min={!form.isActive && form.startDate ? form.startDate : getMinDateTime()} 
                      value={form.expiresAt} 
                      onChange={e => setForm(f=>({...f, expiresAt: e.target.value}))}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-amber-500 transition-colors" 
                    />
                  </div>
                )}
              </div>

              <div className="flex gap-3 pt-4 border-t border-neutral-800">
                <button type="button" onClick={() => setShowForm(false)}
                  className="px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl transition-colors">Cancel</button>
                <button type="submit"
                  className="flex-1 bg-amber-600 hover:bg-amber-500 text-white text-sm rounded-xl font-semibold py-2.5 flex items-center justify-center gap-2 shadow-lg shadow-amber-900/20">
                  {editingId ? <><Pencil size={14} /> Update</> : <><Plus size={14} /> {form.isActive ? 'Post Now' : 'Schedule'}</>}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}