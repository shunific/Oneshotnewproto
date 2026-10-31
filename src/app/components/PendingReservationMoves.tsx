import type { PendingReservationMove, Table } from '../context/AppContext';

export function PendingReservationMoves({records,tables,error,busy,onRecover,onRefresh}:{records:PendingReservationMove[];tables:Table[];error:string;busy:boolean;onRecover:(record:PendingReservationMove,action:'continue'|'abort')=>void;onRefresh:()=>void}) {
  if(!records.length&&!error)return null;
  const name=(id:string)=>tables.find(table=>table.id===id)?.name||id;
  return <section aria-label="Transfer recovery" className="space-y-3 rounded-xl border border-amber-800 bg-amber-950/20 p-4">
    <h2 className="font-bold text-amber-300">Transfers need attention</h2>
    {error&&<div role="alert" className="text-sm text-amber-200">{error} <button disabled={busy} onClick={onRefresh} className="font-bold underline">Refresh transfers</button></div>}
    {records.map(record=><div key={record.moveId} className="space-y-2 border-t border-amber-900 pt-3">
      <p className="font-semibold text-white">{name(record.sourceId)} → {name(record.targetId)}</p>
      <p className="text-sm text-neutral-300">{record.phase==='local-committed'?'The session moved locally. Confirm its transfer before using either table.':record.phase==='aborting'?'Cancellation is pending. Retry cancellation to release the held tables.':'The transfer is unconfirmed. Retry it or cancel it before using either table.'}</p>
      <div className="flex flex-wrap gap-3">
        <button disabled={busy} onClick={()=>onRecover(record,record.phase==='aborting'?'abort':'continue')} className="rounded-lg bg-amber-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">{record.phase==='aborting'?'Retry cancellation':'Retry transfer'}</button>
        {record.phase==='prepared'&&<button disabled={busy} onClick={()=>onRecover(record,'abort')} className="rounded-lg border border-neutral-600 px-3 py-2 text-sm text-white disabled:opacity-50">Cancel transfer</button>}
      </div>
    </div>)}
  </section>;
}
