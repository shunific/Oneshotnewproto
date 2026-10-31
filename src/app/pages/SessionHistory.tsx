import { useState, useMemo, useEffect, useRef } from 'react';
import { localFetch } from '../utils/localApi';
import { HistoryReceiptSummary } from '../components/HistoryReceiptSummary';
import { projectHistoryReceipt } from '../utils/historyReceiptProjection.js';
import { ReceiptRefundReturn } from '../components/ReceiptRefundReturn';
import { useAppContext } from '../context/AppContext';
import { History, Search, Calendar, Clock, DollarSign, ShoppingCart, CheckCircle, X, ChevronRight, Filter, QrCode } from 'lucide-react';
import { format, isToday, isThisWeek, isThisMonth, isWithinInterval, startOfDay, endOfDay } from 'date-fns';

// 🟢 BULLETPROOF FORMATTER: Safely handles null/undefined amounts to prevent crashes
const formatPHP = (amount: any) => `₱${(Number(amount) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

export function SessionHistory() {
  const { sessionHistory, reservations, tables, staffProfile } = useAppContext() as any;
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'table_session' | 'reservation'>('all');
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'week' | 'month' | 'custom'>('all');
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [selectedRecord, setSelectedRecord] = useState<any | null>(null);
  const [savedReceipt,setSavedReceipt]=useState<any>(null);
  const [receiptRefresh,setReceiptRefresh]=useState(0);
  const activeSelection=useRef('');
  const selectionKey=selectedRecord?`${staffProfile?.id||''}:${selectedRecord.source}:${selectedRecord.id}`:'';
  activeSelection.current=selectionKey;
  useEffect(()=>{
    let stopped=false;
    const key=selectionKey;
    setSavedReceipt(null);
    const ended=()=>{stopped=true;setSavedReceipt(null);setSelectedRecord(null);};
    window.addEventListener('oneshot-session-ended',ended);
    if(selectedRecord?.source==='table_session'&&staffProfile?.id){
      setSavedReceipt({key,state:'loading',receipt:null});
      void (async()=>{
        try{
          const response=await localFetch(`http://localhost:3001/api/e-receipts/${encodeURIComponent(selectedRecord.id)}`);
          if(stopped||activeSelection.current!==key)return;
          if(response.status===404){setSavedReceipt({key,state:'missing',receipt:null});return;}
          if(!response.ok)throw Error('Saved receipt unavailable.');
          const receipt=await response.json();
          if(stopped||activeSelection.current!==key)return;
          projectHistoryReceipt(selectedRecord,receipt);
          setSavedReceipt({key,state:'loaded',receipt});
        }catch{if(!stopped&&activeSelection.current===key)setSavedReceipt({key,state:'error',receipt:null});}
      })();
    }
    return()=>{stopped=true;window.removeEventListener('oneshot-session-ended',ended);};
  },[selectedRecord,staffProfile?.id,selectionKey,receiptRefresh]);

  // Unify and format data safely
  const unifiedHistory = useMemo(() => {
    const tableSessions = (sessionHistory || []).map((sh: any) => ({
      id: sh.id,
      tableId: sh.tableId,
      sortDate: new Date(sh.endTime || new Date()),
      source: 'table_session',
      status: sh.status,
      customerName: sh.customerName || 'Walk-in Guest',
      tableName: sh.tableName || 'N/A',
      startTime: sh.startTime ? new Date(sh.startTime) : new Date(),
      endTime: sh.endTime ? new Date(sh.endTime) : new Date(),
      durationLabel: `${sh.durationMinutes || 0} mins`,
      durationMinutes: sh.durationMinutes,
      totalAmount: Number(sh.totalAmount) || 0,
      amountPaid: Number(sh.amountPaid) || 0,
      orders: sh.orders || [],
      isFullyPaid: (Number(sh.amountPaid) || 0) >= (Number(sh.totalAmount) || 0)
    }));

    const completedReservations = (reservations || [])
      .filter((r: any) => r.status === 'completed')
      .map((r: any) => {
        const paid = (Number(r.downPaymentAmount) || 0) + (r.balancePaid ? ((Number(r.totalAmount) || 0) - (Number(r.downPaymentAmount) || 0)) : 0);
        return {
          id: r.id,
          sortDate: new Date(r.createdAt || new Date()),
          source: 'reservation',
          status: r.status,
          customerName: r.customerName || 'Guest',
          tableName: tables?.find((t: any) => t.id === r.tableId)?.name || r.tableId || 'N/A',
          startTime: r.date ? new Date(r.date) : new Date(),
          endTime: null, 
          durationLabel: `${r.durationHours || 0} hrs`,
          totalAmount: Number(r.totalAmount) || 0,
          amountPaid: paid,
          orders: [],
          isFullyPaid: !!r.balancePaid
        };
      });

    return [...tableSessions, ...completedReservations].sort((a, b) => b.sortDate.getTime() - a.sortDate.getTime());
  }, [sessionHistory, reservations, tables]);

  const filtered = unifiedHistory.filter(record => {
    const matchSearch = record.customerName.toLowerCase().includes(search.toLowerCase()) || record.id.toLowerCase().includes(search.toLowerCase());
    const matchType = filterType === 'all' || record.source === filterType;
    
    let matchDate = true;
    if (dateFilter === 'today') {
      matchDate = isToday(record.sortDate);
    } else if (dateFilter === 'week') {
      matchDate = isThisWeek(record.sortDate, { weekStartsOn: 1 }); 
    } else if (dateFilter === 'month') {
      matchDate = isThisMonth(record.sortDate);
    } else if (dateFilter === 'custom' && dateRange.start && dateRange.end) {
      const start = startOfDay(new Date(dateRange.start));
      const end = endOfDay(new Date(dateRange.end));
      matchDate = isWithinInterval(record.sortDate, { start, end });
    }

    return matchSearch && matchType && matchDate;
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-20">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-neutral-950 p-6 rounded-2xl border border-neutral-800">
        <div>
          <h2 className="text-2xl font-black text-white flex items-center gap-2"><History className="text-emerald-500" /> Session History</h2>
          <p className="text-sm text-neutral-500 mt-1">Comprehensive log of completed walk-in sessions and reservations.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto justify-end">
          <div className="relative flex-1 min-w-[200px] lg:w-48">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input type="text" placeholder="Search customer or ID..." value={search} onChange={e => setSearch(e.target.value)} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white focus:border-emerald-500 outline-none transition-colors" />
          </div>
          
          <select value={filterType} onChange={e => setFilterType(e.target.value as any)} className="bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-emerald-500 transition-colors">
            <option value="all">All Records</option>
            <option value="table_session">Walk-ins</option>
            <option value="reservation">Reservations</option>
          </select>

          <select value={dateFilter} onChange={e => setDateFilter(e.target.value as any)} className="bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-emerald-500 transition-colors">
            <option value="all">All Time</option>
            <option value="today">Today</option>
            <option value="week">This Week</option>
            <option value="month">This Month</option>
            <option value="custom">Custom Range</option>
          </select>
        </div>
      </div>

      {dateFilter === 'custom' && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex flex-wrap items-end gap-4 animate-in slide-in-from-top-2">
          <div className="space-y-1.5">
            <label className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold flex items-center gap-1.5"><Calendar size={12}/> Start Date</label>
            <input type="date" value={dateRange.start} onChange={e => setDateRange(prev => ({ ...prev, start: e.target.value }))} className="bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-emerald-500" style={{ colorScheme: 'dark' }} />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold flex items-center gap-1.5"><Calendar size={12}/> End Date</label>
            <input type="date" value={dateRange.end} onChange={e => setDateRange(prev => ({ ...prev, end: e.target.value }))} className="bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-emerald-500" style={{ colorScheme: 'dark' }} />
          </div>
          {(dateRange.start || dateRange.end) && (
            <button onClick={() => setDateRange({ start: '', end: '' })} className="px-3 py-2 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-950/30 rounded-lg transition-colors border border-transparent hover:border-rose-900/50">
              Clear Dates
            </button>
          )}
        </div>
      )}

      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto min-h-[300px]">
          <table className="w-full">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-900/50 text-left text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">
                <th className="px-4 py-3">Customer & Type</th>
                <th className="px-4 py-3">Date / Time</th>
                <th className="px-4 py-3">Table</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3">Total Bill</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/50">
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12 text-neutral-500">No completed sessions found.</td></tr>
              ) : filtered.map((r, i) => (
                <tr key={`${r.id}-${i}`} className="hover:bg-neutral-900/60 transition-colors cursor-pointer" onClick={() => setSelectedRecord(r)}>
                  <td className="px-4 py-3">
                    <p className="text-sm font-bold text-neutral-200">{r.customerName}</p>
                    <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-widest ${r.source === 'table_session' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'}`}>
                      {r.source === 'table_session' ? 'Walk-In Session' : 'Reservation'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-neutral-300 font-medium">{format(r.sortDate, 'MMM d, yyyy')}</p>
                    <p className="text-[10px] text-neutral-500">
                      {format(r.startTime, 'h:mm a')} {r.endTime ? `- ${format(r.endTime, 'h:mm a')}` : ''}
                    </p>
                  </td>
                  <td className="px-4 py-3"><span className="text-sm text-neutral-400">{r.tableName}</span></td>
                  <td className="px-4 py-3"><span className="text-sm text-neutral-400">{r.durationLabel}</span></td>
                  <td className="px-4 py-3"><span className="text-sm font-bold text-white">{formatPHP(r.totalAmount)}</span></td>
                  <td className="px-4 py-3">
                    {['voided', 'voided_refund_pending', 'refund_pending'].includes(r.status) ? (
                      <span className="text-[10px] font-bold text-amber-400 uppercase">{r.status === 'voided' ? 'Voided' : r.status === 'voided_refund_pending' ? 'Voided · Return review' : 'Return review'}</span>
                    ) : r.isFullyPaid ? (
                      <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 uppercase"><CheckCircle size={12}/> Settled</span>
                    ) : (
                      <span className="flex items-center gap-1 text-[10px] font-bold text-rose-400 uppercase">Unpaid / Debt</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 rounded-lg text-xs font-semibold text-neutral-300 transition-colors">
                      Receipt <ChevronRight size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 🟢 THERMAL E-RECEIPT VIEWER MODAL */}
      {selectedRecord && (() => {
        const rData = selectedRecord;
        const receiptSnapshot=savedReceipt?.key===selectionKey?savedReceipt:null;
        const receiptDate = rData.endTime || rData.sortDate || new Date();

        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 sm:p-8" onClick={() => setSelectedRecord(null)}>
            <div className="w-full max-w-[340px] relative animate-in zoom-in-95 duration-200 max-h-[90vh] overflow-y-auto hide-scrollbar rounded-xl drop-shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
              
              <div className="pb-2 w-full"> 
                {/* THERMAL PAPER UI */}
                <div className="bg-[#f8f9fa] text-neutral-800 rounded-sm shadow-2xl relative overflow-hidden font-mono text-[11px] leading-tight w-full">
                  {/* Torn Paper Top */}
                  <div className="w-full h-3 bg-repeat-x flex" style={{ backgroundImage: 'radial-gradient(circle at 4px 0, transparent 4px, #f8f9fa 5px)', backgroundSize: '8px 10px' }} />
                  
                  <div className="px-5 pt-6 pb-8 flex flex-col">
                    {/* Header */}
                    <div className="text-center mb-5 space-y-1">
                      <p className="text-[9px] uppercase tracking-widest text-neutral-500 font-bold mb-2">History Record</p>
                      <h2 className="text-xl font-black tracking-widest text-black">*** SESSION SUMMARY ***</h2>
                    </div>
                    
                    {/* Meta Data */}
                    <div className="flex justify-between items-center uppercase text-[9px] font-bold text-neutral-500 mb-3 border-b border-dashed border-neutral-400 pb-3">
                      <span>CASHIER: ARCHIVE</span>
                      <span>{format(receiptDate, 'dd/MM/yyyy - hh:mm a')}</span>
                    </div>

                    <HistoryReceiptSummary record={rData} receipt={receiptSnapshot?.receipt} state={receiptSnapshot?.state||(rData.source==='table_session'?'loading':'history')} />
                    {rData.source==='table_session'&&<button type="button" disabled={receiptSnapshot?.state==='loading'} onClick={()=>setReceiptRefresh(value=>value+1)} className="mt-3 text-[10px] font-bold text-neutral-600 underline disabled:opacity-50">Refresh saved receipt</button>}

                    <div className="border-t border-dashed border-neutral-400 my-4" />

                    {/* Footer */}
                    <div className="text-center space-y-4">
                      <p className="font-bold text-[10px] uppercase tracking-widest text-black">
                        THANK YOU FOR PLAYING!
                      </p>
                      <div className="flex flex-col items-center opacity-80">
                        <QrCode size={40} strokeWidth={1.5} className="mb-2" />
                        <p className="text-[9px] tracking-widest">{rData.id}</p>
                      </div>
                    </div>
                  </div>

                  {/* Torn Paper Bottom */}
                  <div className="w-full h-3 bg-repeat-x flex rotate-180" style={{ backgroundImage: 'radial-gradient(circle at 4px 0, transparent 4px, #f8f9fa 5px)', backgroundSize: '8px 10px' }} />
                </div>

                {selectedRecord.source === 'table_session' && receiptSnapshot?.state==='loaded' && staffProfile?.isAdmin && <ReceiptRefundReturn key={`${staffProfile.id}:${rData.id}`} receiptId={rData.id} localStaffId={staffProfile.id} />}

                {/* Action Buttons */}
                <button onClick={() => setSelectedRecord(null)} className="mt-4 w-full bg-neutral-800 hover:bg-neutral-700 text-white font-bold py-3.5 rounded-xl transition-colors border border-neutral-700">
                  Close Receipt
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}