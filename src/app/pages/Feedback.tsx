import { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import {
  MessageSquare, ThumbsUp, Tag, AlertTriangle, Lightbulb,
  Search, Package, User, Calendar, CheckCircle2, X
} from 'lucide-react';
import { formatDistanceToNow, isToday, isYesterday, isThisWeek, isThisMonth, isWithinInterval, startOfDay, endOfDay } from 'date-fns';

type FeedbackType = 'suggestion' | 'complaint' | 'lost_item' | 'compliment' | 'other';

const TYPE_CONFIG: Record<FeedbackType, { label: string; color: string; bg: string; border: string; icon: React.ElementType }> = {
  compliment: { label: 'Compliment',        color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: ThumbsUp },
  suggestion: { label: 'Suggestion',        color: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/20',    icon: Lightbulb },
  complaint:  { label: 'Concern/Complaint', color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   icon: AlertTriangle },
  lost_item:  { label: 'Lost Item',         color: 'text-rose-400',    bg: 'bg-rose-500/10',    border: 'border-rose-500/20',    icon: Package },
  other:      { label: 'Other',             color: 'text-neutral-400', bg: 'bg-neutral-800',    border: 'border-neutral-700',    icon: MessageSquare },
};

export function FeedbackPage() {
  const { feedback, resolveFeedback, adminLoggedIn, staffProfile } = useAppContext();
  const actorId = adminLoggedIn && staffProfile?.isAdmin ? staffProfile.id : null;
  const resolutionOwner = useRef({ id: actorId, generation: 0 });
  if (resolutionOwner.current.id !== actorId) resolutionOwner.current = { id: actorId, generation: resolutionOwner.current.generation + 1 };
  const resolutionInFlight = useRef(false);
  
  // ── States ──
  const [filterType, setFilterType] = useState<FeedbackType | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState<string>('ALL_TIME');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  // ── Resolution Modal State ──
  const [resolveModal, setResolveModal] = useState<{ id: string; name: string; actorId: string; generation: number } | null>(null);
  const [resolveNotes, setResolveNotes] = useState('');
  const [isResolving, setIsResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');
  useEffect(() => {
    resolutionInFlight.current = false;
    setResolveModal(null); setResolveNotes(''); setResolveError(''); setIsResolving(false);
  }, [actorId]);

  // ── Filtering Logic ──
  const filtered = feedback.filter(f => {
    const matchType = filterType === 'all' || f.feedbackType === filterType;
    const matchSearch = !searchQuery ||
      f.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      f.comment.toLowerCase().includes(searchQuery.toLowerCase());
      
    let matchDate = true;
    const fDate = new Date(f.date);
    
    if (dateFilter === 'TODAY') matchDate = isToday(fDate);
    else if (dateFilter === 'YESTERDAY') matchDate = isYesterday(fDate);
    else if (dateFilter === 'THIS_WEEK') matchDate = isThisWeek(fDate);
    else if (dateFilter === 'THIS_MONTH') matchDate = isThisMonth(fDate);
    else if (dateFilter === 'CUSTOM') {
      if (startDate && endDate) {
        const start = startOfDay(new Date(startDate));
        const end = endOfDay(new Date(endDate));
        matchDate = isWithinInterval(fDate, { start, end });
      } else if (startDate) {
        matchDate = fDate >= startOfDay(new Date(startDate));
      } else if (endDate) {
        matchDate = fDate <= endOfDay(new Date(endDate));
      }
    }

    return matchType && matchSearch && matchDate;
  });

  // ── Stats ──
  const compliments  = feedback.filter(f => f.feedbackType === 'compliment').length;
  const complaints   = feedback.filter(f => f.feedbackType === 'complaint').length;
  const suggestions  = feedback.filter(f => f.feedbackType === 'suggestion').length;
  const total        = feedback.length;

  const topTags = (() => {
    const tagMap: Record<string, number> = {};
    feedback.forEach(f => {
        if (Array.isArray(f.tags)) {
            f.tags.forEach(t => { tagMap[t] = (tagMap[t] || 0) + 1; });
        }
    });
    return Object.entries(tagMap).sort((a, b) => b[1] - a[1]).slice(0, 6);
  })();

  const handleResolve = async (e: React.FormEvent) => {
    e.preventDefault();
    const owner = resolutionOwner.current;
    if (resolutionInFlight.current || !owner.id || !resolveModal || resolveModal.actorId !== owner.id || resolveModal.generation !== owner.generation) return;
    if (!resolveNotes.trim() || resolveNotes.length > 2000) { setResolveError('Enter a resolution summary of 1–2000 characters.'); return; }
    resolutionInFlight.current = true; setIsResolving(true); setResolveError('');
    try {
      await resolveFeedback(resolveModal.id, resolveNotes.trim());
      if (resolutionOwner.current !== owner) return;
      setResolveModal(null); setResolveNotes('');
    } catch (error: any) {
      if (resolutionOwner.current === owner) setResolveError(error.message || 'Resolution could not be confirmed. Your notes have been kept.');
    } finally {
      if (resolutionOwner.current === owner) { resolutionInFlight.current = false; setIsResolving(false); }
    }
  };

  return (
    <div className="space-y-5 relative">
      {/* ── Stats Row ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Total Messages',  value: total,       color: 'text-neutral-200',  icon: MessageSquare },
          { label: 'Compliments',     value: compliments, color: 'text-emerald-400',  icon: ThumbsUp },
          { label: 'Concerns',        value: complaints,  color: 'text-amber-400',    icon: AlertTriangle },
          { label: 'Suggestions',     value: suggestions, color: 'text-blue-400',     icon: Lightbulb },
        ].map(s => (
          <div key={s.label} className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 flex items-center gap-3">
            <s.icon size={22} className={`${s.color} opacity-70 flex-shrink-0`} />
            <div>
              <p className={`text-2xl font-black ${s.color}`}>{s.value}</p>
              <p className="text-[10px] text-neutral-600 uppercase tracking-wider font-semibold">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Toolbar ── */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col md:flex-row items-start md:items-center gap-3">
          <div className="relative flex-1 w-full">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              type="text"
              placeholder="Search by customer name or keywords..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-lg pl-9 pr-4 py-2.5 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-emerald-500 transition-colors"
            />
          </div>

          <div className="relative w-full md:w-auto flex-shrink-0">
            <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
              <Calendar size={14} className="text-neutral-400" />
            </div>
            <select 
              value={dateFilter} 
              onChange={(e) => {
                setDateFilter(e.target.value);
                if (e.target.value !== 'CUSTOM') {
                  setStartDate('');
                  setEndDate('');
                }
              }}
              className="w-full md:w-auto pl-9 pr-8 py-2.5 bg-neutral-950 border border-neutral-800 rounded-lg text-sm font-semibold text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors appearance-none"
            >
              <option value="ALL_TIME">All Time</option>
              <option value="TODAY">Today</option>
              <option value="YESTERDAY">Yesterday</option>
              <option value="THIS_WEEK">This Week</option>
              <option value="THIS_MONTH">This Month</option>
              <option value="CUSTOM">Custom Range...</option>
            </select>
          </div>
        </div>

        {dateFilter === 'CUSTOM' && (
          <div className="flex items-center gap-3 bg-neutral-950 p-4 rounded-xl border border-neutral-800 animate-in fade-in slide-in-from-top-2">
            <div className="flex-1 sm:flex-none">
              <label className="block text-[10px] text-neutral-500 uppercase tracking-wider font-semibold mb-1.5">Start Date</label>
              <input 
                type="date" 
                style={{ colorScheme: 'dark' }}
                value={startDate} 
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full sm:w-auto bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>
            <div className="flex-1 sm:flex-none">
              <label className="block text-[10px] text-neutral-500 uppercase tracking-wider font-semibold mb-1.5">End Date</label>
              <input 
                type="date" 
                style={{ colorScheme: 'dark' }}
                value={endDate} 
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full sm:w-auto bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>
            {(startDate || endDate) && (
              <div className="pt-5 hidden sm:block">
                <button 
                  onClick={() => { setStartDate(''); setEndDate(''); setDateFilter('ALL_TIME'); }}
                  className="text-xs text-rose-400 hover:text-rose-300 font-semibold px-3 py-2 rounded-lg hover:bg-rose-950/30 transition-colors"
                >
                  Clear Range
                </button>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-1.5 flex-wrap">
          {(['all', 'compliment', 'suggestion', 'complaint', 'lost_item', 'other'] as const).map(t => {
            const cfg = t !== 'all' ? TYPE_CONFIG[t] : null;
            const isActive = filterType === t;
            return (
              <button key={t} onClick={() => setFilterType(t)}
                className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
                  isActive
                    ? cfg ? `${cfg.bg} ${cfg.border} ${cfg.color}` : 'bg-neutral-800 text-neutral-200 border-neutral-700'
                    : 'bg-neutral-950 text-neutral-500 border-neutral-800 hover:border-neutral-700 hover:text-neutral-300'
                }`}
              >
                {t === 'all' ? 'All Types' : TYPE_CONFIG[t].label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Top Tags ── */}
      {topTags.length > 0 && (
        <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-4">
          <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold mb-3 flex items-center gap-1.5">
            <Tag size={11} /> Common Feedback Tags
          </p>
          <div className="flex flex-wrap gap-2">
            {topTags.map(([tag, count]) => (
              <span key={tag} className="flex items-center gap-1.5 bg-neutral-900 border border-neutral-800 rounded-full px-3 py-1 text-xs text-neutral-300">
                {tag}
                <span className="bg-neutral-700 text-neutral-400 text-[10px] font-black px-1.5 rounded-full">{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Feedback List ── */}
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-12 text-center">
            <MessageSquare size={32} className="mx-auto text-neutral-700 mb-3" />
            <p className="text-neutral-300 font-semibold">No feedback found</p>
            <p className="text-neutral-500 text-xs mt-1">Try adjusting your search or filters.</p>
          </div>
        ) : filtered.map(fb => {
          const type = (fb.feedbackType || 'other') as FeedbackType;
          const cfg = TYPE_CONFIG[type];
          const Icon = cfg.icon;
          return (
            <div key={fb.id} className={`bg-neutral-950 border rounded-xl p-5 hover:border-neutral-700 transition-colors flex flex-col ${fb.feedbackType ? cfg.border : 'border-neutral-800'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center text-sm font-bold text-neutral-400 flex-none">
                    <User size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-neutral-200">{fb.customerName}</p>
                      {fb.reservationId && (
                        <span className="text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded uppercase font-bold">Verified Booking</span>
                      )}
                    </div>
                    {fb.contactInfo && (
                      <p className="text-[11px] text-neutral-600 mt-0.5">{fb.contactInfo}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      <p className="text-[10px] text-neutral-500 font-medium">
                        {new Date(fb.date).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </p>
                      <span className="text-neutral-700">•</span>
                      <p className="text-[10px] text-neutral-600">{formatDistanceToNow(new Date(fb.date), { addSuffix: true })}</p>
                    </div>
                  </div>
                </div>
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold flex-shrink-0 ${cfg.bg} ${cfg.color} border ${cfg.border}`}>
                  <Icon size={11} />
                  <span className="hidden sm:inline">{cfg.label}</span>
                </div>
              </div>

              <p className="text-sm text-neutral-300 mt-4 leading-relaxed">"{fb.comment}"</p>

              {fb.tags && fb.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-4 pt-4 border-t border-neutral-800/50">
                  {fb.tags.map((tag: string) => (
                    <span key={tag} className="bg-neutral-900 text-neutral-500 text-[10px] px-2 py-0.5 rounded-full border border-neutral-800">
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Resolution Block */}
              {actorId && (
                <div className="mt-4 pt-4 border-t border-neutral-800/50">
                  {fb.status === 'resolved' ? (
                    <div className="bg-emerald-950/20 border border-emerald-900/40 p-3 rounded-lg flex gap-3 items-start">
                      <CheckCircle2 size={16} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[10px] text-emerald-500 font-bold uppercase tracking-wider mb-1">Resolved</p>
                        <p className="text-xs text-emerald-200/80 leading-relaxed">{fb.notes}</p>
                      </div>
                    </div>
                  ) : (
                    <button 
                      onClick={() => { if (!actorId) return; setResolveNotes(''); setResolveError(''); setResolveModal({ id: fb.id, name: fb.customerName, actorId, generation: resolutionOwner.current.generation }); }}
                      className="text-xs font-bold text-neutral-400 bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 hover:border-neutral-700 px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                    >
                      <CheckCircle2 size={14} /> Mark as Resolved
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Resolve Modal ── */}
      {resolveModal && actorId === resolveModal.actorId && resolutionOwner.current.generation === resolveModal.generation && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-neutral-800 flex justify-between items-center bg-neutral-900/50">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={16} className="text-emerald-500" />
                <div>
                  <h3 className="text-base font-bold text-neutral-100">Resolve Feedback</h3>
                  <p className="text-xs text-neutral-500">{resolveModal.name}</p>
                </div>
              </div>
              <button type="button" aria-label="Close resolution" disabled={isResolving} onClick={() => { setResolveModal(null); setResolveNotes(''); setResolveError(''); }} className="p-1.5 text-neutral-500 hover:text-white rounded-lg transition-colors">
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleResolve} className="p-6 space-y-4">
              <div className="space-y-2">
                <label htmlFor="feedback-resolution-notes" className="text-xs text-neutral-400 uppercase tracking-wider font-semibold">Resolution Summary / Admin Notes *</label>
                <textarea
                  id="feedback-resolution-notes"
                  required
                  autoFocus
                  disabled={isResolving}
                  maxLength={2000}
                  rows={4}
                  value={resolveNotes}
                  onChange={(e) => setResolveNotes(e.target.value)}
                  placeholder="e.g. Contacted customer and offered a free hour on next visit to compensate for the aircon issue."
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 placeholder-neutral-600 resize-none"
                />
              </div>
              {resolveError && <p role="alert" className="text-sm text-rose-400">{resolveError}</p>}

              <div className="flex gap-3 pt-2">
                <button type="button" disabled={isResolving} onClick={() => { setResolveModal(null); setResolveNotes(''); setResolveError(''); }} className="px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl transition-colors font-semibold">
                  Cancel
                </button>
                <button type="submit" disabled={isResolving || !resolveNotes.trim() || resolveNotes.length > 2000} className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white text-sm rounded-xl font-bold transition-all shadow-lg shadow-emerald-900/30 flex items-center justify-center gap-2">
                  <CheckCircle2 size={16} /> {isResolving ? 'Saving resolution…' : 'Confirm Resolution'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
