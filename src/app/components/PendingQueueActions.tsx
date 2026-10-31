import {useRef,useState} from 'react';
import {useAppContext} from '../context/AppContext';

export function PendingQueueActions() {
  const {pendingQueueOperations=[],queueOperationError,retryPendingQueueOperation}=useAppContext();
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const inFlight=useRef(false);
  if(!pendingQueueOperations.length&&!queueOperationError&&!notice)return null;
  const retry=async(requestId:string)=>{
    if(inFlight.current)return;
    inFlight.current=true;setBusy(true);setNotice('');
    try{await retryPendingQueueOperation(requestId);setNotice('The original queue action is confirmed. Review the refreshed queue and tables.');}
    catch(error:any){setNotice(error?.message||'The original queue action is still unconfirmed. Retry after reconnecting.');}
    finally{inFlight.current=false;setBusy(false);}
  };
  return <section aria-label="Queue recovery" className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 my-4 space-y-2">
    <h2 className="font-bold text-amber-300">Queue recovery</h2>
    <p className="text-sm text-neutral-300">Confirm an interrupted action before changing the same customer. Retry uses the original saved request.</p>
    {queueOperationError&&<p role="alert">{queueOperationError}</p>}
    {notice&&<p role="status">{notice}</p>}
    {pendingQueueOperations.map(({command}:any)=><div key={command.requestId} className="flex flex-wrap items-center justify-between gap-3">
      <span>{command.kind} · {command.customerName||command.expectedQueue?.customerName}{command.tableId?` · Table ${command.tableId}`:''}</span>
      <button type="button" disabled={busy} onClick={()=>void retry(command.requestId)} className="rounded border border-amber-400/50 px-3 py-2 disabled:opacity-50">{busy?'Confirming…':'Retry original action'}</button>
    </div>)}
  </section>;
}
