import { useEffect, useRef, useState } from 'react';
import { localFetch } from '../utils/localApi';
import { confirmRefundReturn, pendingRefundReturn, receiptRefundCents, reconcileRefundReturn, validateRefundReturnSnapshot, validRefundReference } from '../utils/refundReturnPersistence';

export function ReceiptRefundReturn({ receiptId, localStaffId }: { receiptId: string; localStaffId: string }) {
  const identity = `${localStaffId}:${receiptId}`;
  const active = useRef(identity), generation = useRef(0);
  active.current = identity;
  const [snapshot, setSnapshot] = useState<any>(null), [pending, setPending] = useState<any>(null);
  const [method,setMethod] = useState('cash'), [reference,setReference] = useState(''), [reason,setReason] = useState(''), [checked,setChecked] = useState(false);
  const [busy,setBusy] = useState(false), [message,setMessage] = useState(''), [ready,setReady] = useState(false);
  const current = (epoch:number) => active.current === identity && generation.current === epoch;
  const request = async (body?:unknown) => {
    const response = await localFetch(`http://localhost:3001/api/e-receipts/${encodeURIComponent(receiptId)}/refund-return`, { method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || 'Refund return is unconfirmed. Retry the same request.'),{status:response.status,committed:value.committed});
    return value;
  };
  const load = async (epoch:number) => {
    setBusy(true);setReady(false);setMessage('');
    try {
      const stored = pendingRefundReturn(sessionStorage,localStaffId,receiptId);
      if (!current(epoch)) return;
      setPending(stored);
      const value = validateRefundReturnSnapshot(await request(),receiptId);
      if (!current(epoch)) return;
      if (stored && value.refundReturn) {
        try { reconcileRefundReturn(sessionStorage,localStaffId,receiptId,value,()=>current(epoch));setPending(pendingRefundReturn(sessionStorage,localStaffId,receiptId)); }
        catch { setMessage('A pending request remains unconfirmed. Retry it or ask staff to reconcile the audit; do not return money again.'); }
      }
      setSnapshot({identity,value});setReady(true);
    } catch (error:any) { if(current(epoch)){setSnapshot(null);setMessage(error.message);} }
    finally { if(current(epoch))setBusy(false); }
  };
  useEffect(()=>{
    const epoch=++generation.current;setSnapshot(null);setPending(null);setMethod('cash');setReference('');setReason('');setChecked(false);void load(epoch);
    const ended=()=>{generation.current++;setSnapshot(null);setPending(null);setReady(false);setBusy(false);setMessage('Administrator session ended. Sign in again to review the result.');};
    window.addEventListener('oneshot-session-ended',ended);
    return ()=>{generation.current++;window.removeEventListener('oneshot-session-ended',ended);};
  },[identity]);
  const value=snapshot?.identity===identity?snapshot.value:null;
  const cents=value?receiptRefundCents(value.receipt):null, audit=value?.refundReturn;
  const submit=async()=>{
    const epoch=generation.current;
    if(!ready||!value||!current(epoch))return;
    const input=pending || {requestId:crypto.randomUUID(),expectedActorId:localStaffId,expectedRefundDueCents:cents,method,...(reference.trim()?{reference:reference.trim()}:{}),reason:reason.trim(),acknowledgedReturned:checked};
    setBusy(true);setMessage('');
    try {
      const result=await confirmRefundReturn(body=>request(body),sessionStorage,localStaffId,receiptId,input,()=>current(epoch));
      if(current(epoch)){setSnapshot({identity,value:result});setPending(pendingRefundReturn(sessionStorage,localStaffId,receiptId));setMessage('Completed return recorded. This app did not transfer funds.');}
    } catch(error:any){if(current(epoch)){try{setPending(pendingRefundReturn(sessionStorage,localStaffId,receiptId));}catch{setReady(false);}if(error.status===401||error.status===403){setSnapshot(null);setReady(false);}if(error.committed===false&&[400,404,409].includes(error.status)){setReady(false);setMessage(error.message+' Refresh the authoritative receipt before correcting this record.');}else{setMessage(error.message+' Keep this tab open; do not return money again while the result is unconfirmed.');}}}
    finally{if(current(epoch))setBusy(false);}
  };
  const money=cents===null?'Needs reconciliation':new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(cents/100);
  return <section className="mt-3 p-3 bg-neutral-950 border border-neutral-700 rounded-xl text-xs text-neutral-200 space-y-3" aria-label="Completed refund return">
    <h3 className="font-bold">Completed refund return</h3>
    <p>This records a full return already completed outside this app. It does not send money or initiate a refund.</p>
    {message&&<p role="status" className="text-amber-300">{message}</p>}
    {value&&<p>Original refund due: <strong>{money}</strong></p>}
    {audit&&<div className="space-y-1"><p className="text-emerald-300 font-bold">Returned · {money}</p><p>{audit.method.toUpperCase()}{audit.reference?` · ${audit.reference}`:''}</p><p>{audit.reason}</p><p>Recorded by {audit.actorName} · {audit.createdAt}</p></div>}
    {pending&&<p className="text-amber-300">A return request is unconfirmed. Retry the identical request; do not return money again.</p>}
    {value&&!audit&&cents===0&&<p>No refund return is due on this receipt.</p>}
    {ready&&value&&(pending||(!audit&&cents!==null&&cents>0&&value.receipt.refund_status==='pending'))&&<div className="space-y-2">
      <label className="block">Return method<select value={pending?.method||method} onChange={e=>setMethod(e.target.value)} disabled={busy||!!pending} className="block w-full bg-neutral-900 border border-neutral-700 rounded p-2"><option value="cash">Cash</option><option value="gcash">GCash</option></select></label>
      <label className="block">Reference {(pending?.method||method)==='gcash'?'(required)':'(optional)'}<input value={pending?.reference??reference} onChange={e=>setReference(e.target.value)} disabled={busy||!!pending} maxLength={128} className="block w-full bg-neutral-900 border border-neutral-700 rounded p-2"/></label>
      {(pending?.method||method)==='gcash'&&<p className="text-neutral-400">Use letters and numbers, spaces or hyphens; at least 3 letters/numbers.</p>}
      <label className="block">Reason<textarea value={pending?.reason||reason} onChange={e=>setReason(e.target.value)} disabled={busy||!!pending} maxLength={1000} className="block w-full bg-neutral-900 border border-neutral-700 rounded p-2"/></label>
      <label className="flex gap-2"><input type="checkbox" checked={pending?true:checked} onChange={e=>setChecked(e.target.checked)} disabled={busy||!!pending}/>I verified the full amount was returned outside this app.</label>
      <button type="button" onClick={submit} disabled={busy||(!pending&&(!checked||!reason.trim()||(method==='gcash'&&!validRefundReference(reference))))} className="w-full p-2 rounded bg-emerald-700 disabled:bg-neutral-800 font-bold">{busy?'Checking…':pending?'Retry pending return':'Record completed return'}</button>
    </div>}
    <button type="button" disabled={busy} onClick={()=>void load(++generation.current)} className="underline disabled:opacity-50">Refresh authoritative receipt</button>
  </section>;
}
