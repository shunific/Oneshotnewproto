// Full promo code management (Admin only — create, edit, toggle, delete)
import { useState } from 'react';
import { useAppContext, generateRandomPromoCode, PromoCode } from '../context/AppContext';
import { Plus, X, Tag, Copy, ToggleLeft, ToggleRight, Trash2, Wand2, CheckCircle, RefreshCw, Edit2 } from 'lucide-react';
import { format } from 'date-fns';

export function AdminPromoCodes() {
  const { promoCodes, addPromoCode, updatePromoCode, togglePromoCode, deletePromoCode } = useAppContext();
  const [editingPromoId, setEditingPromoId] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [form, setForm] = useState({ code: '', discountPercent: 10, description: '', maxUsage: 100, isActive: true, hasExpiry: false, expiresAt: '' });

  const handleOpenCreate = () => {
    setEditingPromoId(null);
    setForm({ code: '', discountPercent: 10, description: '', maxUsage: 100, isActive: true, hasExpiry: false, expiresAt: '' });
    setShowForm(true);
  };

  const handleOpenEdit = (pc: PromoCode) => {
    setEditingPromoId(pc.id);
    setForm({
      code: pc.code,
      discountPercent: pc.discountPercent,
      description: pc.description,
      maxUsage: pc.maxUsage,
      isActive: pc.isActive,
      hasExpiry: !!pc.expiresAt,
      expiresAt: pc.expiresAt ? format(new Date(pc.expiresAt), "yyyy-MM-dd'T'HH:mm") : ''
    });
    setShowForm(true);
  };

  const handleGenerateCode = () => setForm(f => ({ ...f, code: generateRandomPromoCode() }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.code || !form.description) return;
    const payload = {
      code: form.code.toUpperCase(),
      discountPercent: form.discountPercent,
      description: form.description,
      isActive: form.isActive,
      maxUsage: form.maxUsage,
      expiresAt: form.hasExpiry && form.expiresAt ? new Date(form.expiresAt) : undefined,
    };
    if (editingPromoId) {
      updatePromoCode(editingPromoId, payload);
    } else {
      addPromoCode(payload);
    }
    setShowForm(false);
    setEditingPromoId(null);
    setForm({ code: '', discountPercent: 10, description: '', maxUsage: 100, isActive: true, hasExpiry: false, expiresAt: '' });
  };

  const handleCopy = (code: string, id: string) => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const getStatus = (p: PromoCode) => {
    if (!p.isActive) return { label: 'Inactive', color: 'bg-neutral-700/40 text-neutral-500 border-neutral-700' };
    if (p.usageCount >= p.maxUsage) return { label: 'Exhausted', color: 'bg-rose-500/10 text-rose-400 border-rose-500/20' };
    if (p.expiresAt && new Date() > new Date(p.expiresAt)) return { label: 'Expired', color: 'bg-rose-500/10 text-rose-400 border-rose-500/20' };
    return { label: 'Active', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' };
  };

  const activeCount = promoCodes.filter(p => p.isActive).length;
  const totalUsage  = promoCodes.reduce((s, p) => s + p.usageCount, 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Codes',   value: promoCodes.length, color: 'text-white' },
          { label: 'Active',        value: activeCount,        color: 'text-emerald-400' },
          { label: 'Total Uses',    value: totalUsage,         color: 'text-violet-400' },
          { label: 'Avg. Discount', value: promoCodes.length ? `${Math.round(promoCodes.reduce((s,p)=>s+p.discountPercent,0)/promoCodes.length)}%` : '—', color: 'text-amber-400' },
        ].map(s => (
          <div key={s.label} className="bg-neutral-950 border border-neutral-800 rounded-xl p-4">
            <p className="text-xs text-neutral-500 uppercase tracking-wider mb-1">{s.label}</p>
            <p className={`text-2xl font-black ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-neutral-400">{promoCodes.length} promo code{promoCodes.length !== 1 ? 's' : ''}</p>
        <button onClick={handleOpenCreate}
          className="flex items-center gap-2 bg-violet-600 hover:bg-violet-500 text-white text-sm px-4 py-2.5 rounded-xl font-semibold transition-all shadow-lg shadow-violet-900/30">
          <Plus size={15} /> Generate Code
        </button>
      </div>

      <div className="space-y-3">
        {promoCodes.length === 0 ? (
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-12 text-center">
            <Tag size={32} className="mx-auto text-neutral-700 mb-3" />
            <p className="text-neutral-500">No promo codes yet. Generate your first one!</p>
          </div>
        ) : promoCodes.map(pc => {
          const status = getStatus(pc);
          return (
            <div key={pc.id} className="bg-neutral-950 border border-neutral-800 rounded-xl p-5 hover:border-neutral-700 transition-colors">
              <div className="flex items-start gap-4">
                <div className="w-14 h-14 rounded-xl bg-violet-600/15 border border-violet-600/25 flex flex-col items-center justify-center flex-shrink-0">
                  <span className="text-lg font-black text-violet-400">{pc.discountPercent}%</span>
                  <span className="text-[9px] text-violet-600 font-semibold">OFF</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <div className="flex items-center gap-1.5 bg-neutral-800 rounded-lg px-3 py-1">
                      <Tag size={11} className="text-neutral-400" />
                      <span className="text-sm font-black text-white tracking-wider">{pc.code}</span>
                    </div>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${status.color}`}>{status.label}</span>
                  </div>
                  <p className="text-xs text-neutral-400 mb-2">{pc.description}</p>
                  <div className="flex items-center gap-4 text-[11px] text-neutral-600">
                    <span>Used: <strong className="text-neutral-400">{pc.usageCount}</strong> / {pc.maxUsage}</span>
                    {pc.expiresAt && <span>Expires: <strong className="text-neutral-400">{format(new Date(pc.expiresAt), 'MMM d, yyyy')}</strong></span>}
                    <span>Created: {format(new Date(pc.createdAt), 'MMM d')}</span>
                  </div>
                  <div className="mt-2 h-1.5 bg-neutral-800 rounded-full overflow-hidden w-full max-w-xs">
                    <div className="h-full bg-violet-500 rounded-full transition-all" style={{ width: `${Math.min((pc.usageCount/pc.maxUsage)*100,100)}%` }} />
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => handleCopy(pc.code, pc.id)} title="Copy code"
                    className="p-2 rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors">
                    {copiedId === pc.id ? <CheckCircle size={15} className="text-emerald-400" /> : <Copy size={15} />}
                  </button>
                  <button onClick={() => togglePromoCode(pc.id)} title={pc.isActive ? 'Deactivate' : 'Activate'}
                    className="p-2 rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors">
                    {pc.isActive ? <ToggleRight size={18} className="text-emerald-400" /> : <ToggleLeft size={18} />}
                  </button>
                  <button onClick={() => handleOpenEdit(pc)} title="Edit code"
                    className="p-2 rounded-lg text-neutral-500 hover:text-blue-400 hover:bg-neutral-800 transition-colors">
                    <Edit2 size={15} />
                  </button>
                  {deleteConfirm === pc.id ? (
                    <div className="flex items-center gap-1">
                      <button onClick={() => { deletePromoCode(pc.id); setDeleteConfirm(null); }}
                        className="px-2 py-1 text-[10px] bg-rose-700 hover:bg-rose-600 text-white rounded-lg font-semibold">Yes</button>
                      <button onClick={() => setDeleteConfirm(null)} className="px-2 py-1 text-[10px] bg-neutral-800 text-neutral-400 rounded-lg">No</button>
                    </div>
                  ) : (
                    <button onClick={() => setDeleteConfirm(pc.id)} title="Delete code"
                      className="p-2 rounded-lg text-neutral-500 hover:text-rose-400 hover:bg-rose-950/20 transition-colors">
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-amber-900/30 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-neutral-800 flex justify-between items-center sticky top-0 bg-neutral-950">
              <div>
                <h2 className="text-base font-bold text-neutral-100">{editingPromoId ? "Edit Promo Code" : "Generate Promo Code"}</h2>
                <p className="text-xs text-neutral-500">{editingPromoId ? "Modify discount code details" : "Create a new discount code"}</p>
              </div>
              <button onClick={() => setShowForm(false)} className="p-2 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg"><X size={16} /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Promo Code *</label>
                <div className="flex gap-2">
                  <input required value={form.code} onChange={e => setForm(f=>({...f, code: e.target.value.toUpperCase().replace(/\s/g,'')}) )}
                    placeholder="e.g. SUMMER20"
                    className="flex-1 bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm text-neutral-200 font-mono tracking-wider focus:outline-none focus:ring-2 focus:ring-violet-500/40 placeholder-neutral-600" />
                  <button type="button" onClick={handleGenerateCode}
                    className="flex items-center gap-1.5 px-3 py-2.5 bg-violet-600/20 border border-violet-600/30 text-violet-400 rounded-lg text-xs font-semibold hover:bg-violet-600/30 transition-colors">
                    <Wand2 size={13} /> Generate
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Discount Percentage *</label>
                <div className="flex items-center gap-3">
                  <input type="range" min={5} max={50} step={5} value={form.discountPercent}
                    onChange={e => setForm(f=>({...f, discountPercent: parseInt(e.target.value)}))}
                    className="flex-1 accent-violet-500" />
                  <span className="text-xl font-black text-violet-400 w-12 text-right">{form.discountPercent}%</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Description *</label>
                <input required value={form.description} onChange={e => setForm(f=>({...f, description: e.target.value}))}
                  placeholder="e.g. 20% off for birthday celebrants"
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-violet-500/40 placeholder-neutral-600" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Maximum Uses</label>
                <input type="number" min={1} max={9999} value={form.maxUsage}
                  onChange={e => setForm(f=>({...f, maxUsage: parseInt(e.target.value)||1}))}
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <div className={`w-9 h-5 rounded-full relative transition-colors ${form.hasExpiry ? 'bg-violet-600' : 'bg-neutral-700'}`}
                  onClick={() => setForm(f=>({...f, hasExpiry: !f.hasExpiry}))}>
                  <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.hasExpiry ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
                <span className="text-xs text-neutral-500 uppercase tracking-wider font-semibold">Set Expiry Date</span>
              </label>
              {form.hasExpiry && (
                <input type="datetime-local" value={form.expiresAt} onChange={e => setForm(f=>({...f, expiresAt: e.target.value}))}
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
              )}
              <label className="flex items-center gap-2 cursor-pointer">
                <div className={`w-9 h-5 rounded-full relative transition-colors ${form.isActive ? 'bg-emerald-600' : 'bg-neutral-700'}`}
                  onClick={() => setForm(f=>({...f, isActive: !f.isActive}))}>
                  <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.isActive ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
                <span className="text-xs text-neutral-400">Activate immediately</span>
              </label>
              {form.code && (
                <div className="bg-neutral-900 border border-violet-600/20 rounded-xl p-3 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-violet-600/20 flex flex-col items-center justify-center">
                    <span className="text-sm font-black text-violet-400">{form.discountPercent}%</span>
                  </div>
                  <div>
                    <p className="text-sm font-black text-white tracking-wider">{form.code}</p>
                    <p className="text-xs text-neutral-500">{form.description || 'No description'}</p>
                  </div>
                </div>
              )}
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl transition-colors">Cancel</button>
                <button type="submit" className="flex-1 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-xl font-semibold py-2.5 flex items-center justify-center gap-2 shadow-lg shadow-violet-900/30">
                  <RefreshCw size={14} /> {editingPromoId ? "Save Changes" : "Create Promo Code"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
