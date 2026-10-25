import { projectHistoryReceipt } from '../utils/historyReceiptProjection.js';
const savedTime=(value:any)=>{if(value===null||value===undefined||value==='')return 'Unavailable';const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',year:'numeric',month:'short',day:'2-digit',hour:'numeric',minute:'2-digit',hour12:true}).format(date)+' PHT':'Unavailable';};
const money=(cents:number)=>`₱${(cents/100).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
export function HistoryReceiptSummary({record,receipt,state}:{record:any;receipt:any;state:'loading'|'loaded'|'missing'|'error'|'history'}){
 let saved:any=null;try{if(state==='loaded')saved=projectHistoryReceipt(record,receipt);}catch{/* Invalid canonical snapshots remain visibly unverified. */}
 const row=(label:string,value:number)=> <div key={label} className="flex justify-between gap-3"><span>{label}</span><span>{money(value)}</span></div>;
 if(!saved){
  const recorded=(value:any)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?`₱${value.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}`:'Unavailable';
  return <section aria-label="History payment summary" className="space-y-2 text-black">
   <p role="status" className="text-[10px] text-neutral-600">{state==='loading'?'Loading saved receipt…':state==='error'||state==='loaded'?'Saved receipt could not be verified. Showing history amounts only.':'History summary only. Detailed payment and return records are unavailable.'}</p>
   <p>RECORDED START: {savedTime(record.startTime)}</p>
   <p>RECORDED END: {savedTime(record.endTime)}</p>
   <p>RECORDED DURATION: {Number.isSafeInteger(record.durationMinutes)&&record.durationMinutes>=0?`${record.durationMinutes} mins`:'Unavailable'}</p>
   <div className="flex justify-between font-bold"><span>RECORDED BILL</span><span>{recorded(record.totalAmount)}</span></div>
   <div className="flex justify-between"><span>RECORDED PAID</span><span>{recorded(record.source==='table_session'?record.amountPaid:undefined)}</span></div>
   {['voided','voided_refund_pending','refund_pending'].includes(record.status)&&<p className="font-bold">{record.status==='voided'?'Voided':record.status==='voided_refund_pending'?'Voided · Return review':'Return review'}</p>}
  </section>;
 }
 const a=saved.amounts;
 return <section aria-label="Saved receipt payment summary" className="space-y-2 text-black">
  <p className="text-[10px] text-neutral-600">Saved receipt · {saved.receiptNo}</p>
  <p className="font-bold">{saved.customerName} · {saved.tableName}</p>
  <p>START: {savedTime(saved.startTime)}</p>
  <p>END: {savedTime(saved.endTime)}</p>
  <p>DURATION: {saved.durationMinutes===null?'Unavailable':`${saved.durationMinutes} mins`}</p>
  {saved.isVoided&&<p className="font-black">VOIDED{saved.voidReason?` · ${saved.voidReason}`:''}</p>}
  {row('TABLE PLAY',a.table_charge)}
  {a.overtime_charge>0&&row('OVERTIME',a.overtime_charge)}
  {a.fnb_charge>0&&row('FOOD & DRINK',a.fnb_charge)}
  {saved.items.map((item:any,index:number)=><div key={index} className="flex justify-between gap-3 text-[10px] text-neutral-600"><span>{item.name} × {item.qty}</span><span>{money(item.totalCents)}</span></div>)}
  <div className="border-t border-dashed border-neutral-400 pt-2 space-y-1">{row('SUBTOTAL',a.subtotal)}{a.discount_amount>0&&row(saved.isVoided?'DISCOUNT / WAIVER':'DISCOUNT',a.discount_amount)}</div>
  <div className="border-t border-dashed border-neutral-400 pt-2 space-y-1 font-bold">{row('TOTAL BILL',a.total_amount)}{row('AMOUNT APPLIED',a.amount_paid)}{row('BALANCE DUE',a.balance_due)}</div>
  {saved.refundCents!==null&&saved.refundCents>0&&<div className="border-t border-dashed border-neutral-400 pt-2 font-bold">{row(saved.refundStatus==='returned'?'REFUND RECORDED RETURNED':'REFUND PENDING RETURN',saved.refundCents)}</div>}
  {saved.refundCents===null&&<p className="text-[10px] text-neutral-600">Return status is unavailable for this saved receipt.</p>}
 </section>;
}
