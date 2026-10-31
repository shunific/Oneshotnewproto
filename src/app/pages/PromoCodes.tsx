// Staff view: Read-only promo codes. Creation/deletion is managed in the Admin portal.
import { useAppContext, PromoCode } from '../context/AppContext';
import { Tag, ShieldCheck } from 'lucide-react';
import { format } from 'date-fns';

export function PromoCodesPage() {
  const { promoCodes } = useAppContext();

  const getStatus = (p: PromoCode) => {
    if (!p.isActive) return { label: 'Inactive', color: 'bg-neutral-700/40 text-neutral-500 border-neutral-700' };
    if (p.usageCount >= p.maxUsage) return { label: 'Exhausted', color: 'bg-rose-500/10 text-rose-400 border-rose-500/20' };
    if (p.expiresAt && new Date() > new Date(p.expiresAt)) return { label: 'Expired', color: 'bg-rose-500/10 text-rose-400 border-rose-500/20' };
    return { label: 'Active', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' };
  };

  // 🟢 NEW: Function to mask the promo code (e.g., WELCOME20 -> W***O***0)
  const maskCode = (code: string) => {
    if (!code) return '';
    if (code.length <= 3) return '***';
    const mid = Math.floor(code.length / 2);
    return code.split('').map((char, i) => 
      (i === 0 || i === mid || i === code.length - 1) ? char : '*'
    ).join('');
  };

  const activeCount = promoCodes.filter(p => p.isActive).length;
  const totalUsage  = promoCodes.reduce((s, p) => s + p.usageCount, 0);

  return (
    <div className="space-y-5">
     

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Codes',   value: promoCodes.length,  color: 'text-white' },
          { label: 'Active',        value: activeCount,         color: 'text-emerald-400' },
          { label: 'Total Uses',    value: totalUsage,          color: 'text-violet-400' },
          { label: 'Avg. Discount', value: promoCodes.length ? `${Math.round(promoCodes.reduce((s,p)=>s+p.discountPercent,0)/promoCodes.length)}%` : '—', color: 'text-amber-400' },
        ].map(s => (
          <div key={s.label} className="bg-neutral-950 border border-neutral-800 rounded-xl p-4">
            <p className="text-xs text-neutral-500 uppercase tracking-wider mb-1">{s.label}</p>
            <p className={`text-2xl font-black ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      <p className="text-sm text-neutral-400">{promoCodes.length} promo code{promoCodes.length !== 1 ? 's' : ''} (view only)</p>

      {/* Codes List */}
      <div className="space-y-3">
        {promoCodes.length === 0 ? (
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-12 text-center">
            <Tag size={32} className="mx-auto text-neutral-700 mb-3" />
            <p className="text-neutral-500">No promo codes yet.</p>
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
                      {/* 🟢 NEW: Code is now run through the mask helper */}
                      <span className="text-sm font-black text-white tracking-widest">{maskCode(pc.code)}</span>
                    </div>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${status.color}`}>{status.label}</span>
                  </div>
                  <p className="text-xs text-neutral-400 mb-2">{pc.description}</p>
                  <div className="flex items-center gap-4 text-[11px] text-neutral-600">
                    <span>Used: <strong className="text-neutral-400">{pc.usageCount}</strong> / {pc.isLimitedUses === false ? 'Unlimited' : pc.maxUsage}</span>
                    {pc.expiresAt && <span>Expires: <strong className="text-neutral-400">{format(new Date(pc.expiresAt), 'MMM d, yyyy')}</strong></span>}
                    {pc.createdAt && <span>Created: {format(new Date(pc.createdAt), 'MMM d')}</span>}
                  </div>
                  <div className="mt-2 h-1.5 bg-neutral-800 rounded-full overflow-hidden w-full max-w-xs">
                    <div className="h-full bg-violet-500 rounded-full transition-all" style={{ width: `${Math.min((pc.usageCount/pc.maxUsage)*100,100)}%` }} />
                  </div>
                </div>
                {/* 🟢 NEW: Removed the Copy to Clipboard button entirely to ensure security */}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}