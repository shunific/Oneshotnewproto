import { useState } from 'react';
export function PendingContentCreate({ kind, pending, storageError, onRetry }: { kind: string; pending: any; storageError: string; onRetry: () => Promise<any> }) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  if(!pending&&!storageError)return null;
  const retry=async()=>{if(busy)return;setBusy(true);setError('');try{await onRetry();}catch(e){setError(e instanceof Error?e.message:'Saved create request could not be confirmed.');}finally{setBusy(false);}};
  return <div role="alert" className="mb-4 rounded-xl border border-amber-700 bg-amber-950/20 p-4 text-sm text-amber-200">
    <p>{storageError || `An original ${kind} create request needs confirmation or local cleanup. Retry it before starting another.`}</p>
    {pending&&<><p className="mt-1 font-semibold">{pending.command.payload.code || pending.command.payload.title || pending.command.payload.reason}</p><button type="button" disabled={busy} onClick={retry} className="mt-2 rounded-lg border border-amber-700 px-3 py-2 disabled:opacity-50">{busy?'Checking saved request…':'Retry original create'}</button></>}
    {error&&<p className="mt-2">{error}</p>}
  </div>;
}
