import { useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import { useAppContext } from '../context/AppContext';
import { localFetch } from '../utils/localApi';
import { bookingDay } from '../utils/bookingSchedule.js';
import { HistoryReceiptSummary } from './HistoryReceiptSummary';
import { projectHistoryReceipt } from '../utils/historyReceiptProjection.js';
import { ReceiptRefundReturn } from './ReceiptRefundReturn';

export function bookingReceiptRecord(r:any, tables:any[], history:any[] = []) {
  const linked = history.find(sh => sh.receipt?.reservation_id === r.id && sh.receipt.id === sh.id);
  if (linked) return { ...linked, source:'table_session', sortDate:new Date(linked.endTime), amountPaid:Number(linked.amountPaid), totalAmount:Number(linked.totalAmount) };
  const start = bookingDay(r.date);
  if (r.timeSlot) { const [h,m] = r.timeSlot.split(':').map(Number); start.setHours(h,m,0,0); }
  const paid = r.balancePaid ? Number(r.totalAmount) || 0 : (r.downPaymentPaid ? Number(r.downPaymentAmount) || 0 : 0);
  return {
    id: r.id,
    sortDate: new Date(r.createdAt || new Date()),
    source: 'reservation',
    status: r.status,
    customerName: r.customerName || 'Guest',
    tableName: tables?.find((t: any) => t.id === r.tableId)?.name || r.tableId || 'N/A',
    startTime: start,
    endTime: null,
    durationLabel: `${r.durationHours || 0} hrs`,
    durationMinutes: Number(r.durationHours) * 60,
    totalAmount: Number(r.totalAmount) || 0,
    amountPaid: paid,
    orders: [],
    isFullyPaid: !!r.balancePaid
  };
}

export function SessionReceipt({record:selectedRecord,onClose}:{record:any;onClose:()=>void}) {
  const {siteConfig,staffProfile}=useAppContext() as any;
  const [savedReceipt,setSavedReceipt]=useState<any>(null);
  const [receiptRefresh,setReceiptRefresh]=useState(0);
  const activeSelection=useRef('');
  const selectionKey=selectedRecord?`${staffProfile?.id||''}:${selectedRecord.source}:${selectedRecord.id}`:'';
  activeSelection.current=selectionKey;
  useEffect(()=>{
    let stopped=false;
    const key=selectionKey;
    setSavedReceipt(null);
    const ended=()=>{stopped=true;setSavedReceipt(null);onClose();};
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

  const rData = selectedRecord;
  const receiptSnapshot=savedReceipt?.key===selectionKey?savedReceipt:null;
  const receiptDate = rData.endTime || rData.sortDate || new Date();

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 sm:p-8" onClick={() => onClose()}>
      <div className="w-full max-w-[340px] relative animate-in zoom-in-95 duration-200 max-h-[90vh] overflow-y-auto hide-scrollbar rounded-xl drop-shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>

        <div className="pb-2 w-full">
          {/* THERMAL PAPER UI */}
          <div className="bg-[#f8f9fa] text-neutral-800 rounded-sm shadow-2xl relative overflow-hidden font-mono text-[11px] leading-tight w-full">
            {/* Torn Paper Top */}
            <div className="w-full h-3 bg-repeat-x flex" style={{ backgroundImage: 'radial-gradient(circle at 4px 0, transparent 4px, #f8f9fa 5px)', backgroundSize: '8px 10px' }} />

            <div className="px-5 pt-6 pb-8 flex flex-col">
              {/* Header */}
              <div className="text-center mb-4 space-y-0.5">
                <h2 className="text-base font-black tracking-wide text-black uppercase">{siteConfig?.venueName || 'One Shot Bar & Billiards'}</h2>
                <p className="text-[9px] text-neutral-600">{siteConfig?.address || 'Manila, Philippines'}</p>
                {(siteConfig?.contactNumber || siteConfig?.contactEmail) && <p className="text-[9px] text-neutral-600">{[siteConfig?.contactNumber, siteConfig?.contactEmail].filter(Boolean).join(' · ')}</p>}
              </div>

              <div className="text-center mb-4 space-y-1 border-t border-b border-dashed border-neutral-400 py-2">
                <p className="text-[9px] uppercase tracking-widest text-neutral-500 font-bold">Invoice · Session Summary</p>
                <h2 className="text-lg font-black tracking-widest text-black">*** RECEIPT ***</h2>
              </div>

              {/* Meta Data */}
              <div className="space-y-1 text-[9px] font-bold text-neutral-600 mb-3 border-b border-dashed border-neutral-400 pb-3">
                <div className="flex justify-between"><span>INVOICE NO.</span><span>{rData.id}</span></div>
                <div className="flex justify-between"><span>DATE ISSUED</span><span>{format(receiptDate, 'dd/MM/yyyy - hh:mm a')}</span></div>
                <div className="flex justify-between"><span>TABLE</span><span>{rData.tableName || '—'}</span></div>
                <div className="flex justify-between"><span>CUSTOMER</span><span>{rData.customerName || 'Walk-in Guest'}</span></div>
                <div className="flex justify-between"><span>PROCESSED BY</span><span>{receiptSnapshot?.receipt?.processed_by_name || rData.processedBy || 'Unavailable'}</span></div>
              </div>

              <HistoryReceiptSummary record={rData} receipt={receiptSnapshot?.receipt} state={receiptSnapshot?.state||(rData.source==='table_session'?'loading':'history')} />
              {rData.source==='table_session'&&<button type="button" disabled={receiptSnapshot?.state==='loading'} onClick={()=>setReceiptRefresh(value=>value+1)} className="mt-3 text-[10px] font-bold text-neutral-600 underline disabled:opacity-50">Refresh saved receipt</button>}

              <div className="border-t border-dashed border-neutral-400 my-4" />

              {/* Footer */}
              <div className="text-center space-y-4">
                <p className="font-bold text-[10px] uppercase tracking-widest text-black">
                  THANK YOU FOR PLAYING!
                </p>
                <p className="text-[9px] text-neutral-600">This serves as your official invoice and receipt. Please keep for your records.</p>
              </div>
            </div>

            {/* Torn Paper Bottom */}
            <div className="w-full h-3 bg-repeat-x flex rotate-180" style={{ backgroundImage: 'radial-gradient(circle at 4px 0, transparent 4px, #f8f9fa 5px)', backgroundSize: '8px 10px' }} />
          </div>

          {selectedRecord.source === 'table_session' && receiptSnapshot?.state==='loaded' && staffProfile?.isAdmin && <ReceiptRefundReturn key={`${staffProfile.id}:${rData.id}`} receiptId={rData.id} localStaffId={staffProfile.id} />}

          {/* Action Buttons */}
          <button onClick={() => onClose()} className="mt-4 w-full bg-neutral-800 hover:bg-neutral-700 text-white font-bold py-3.5 rounded-xl transition-colors border border-neutral-700">
            Close Receipt
          </button>
        </div>
      </div>
    </div>
  );
}
