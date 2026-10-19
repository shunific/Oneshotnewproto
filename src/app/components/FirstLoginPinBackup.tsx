import { useRef, useState } from 'react';

export function FirstLoginPinBackup({ pin, username, onContinue, onRestart }: {
  pin: string; username: string; onContinue: () => Promise<void>; onRestart: () => void;
}) {
  const [action, setAction] = useState<'copied' | 'download' | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(pin); setAction('copied'); setConfirmed(false); setError(''); }
    catch { setError('Copy failed. Please retry or save the PIN as a text file.'); }
  };
  const download = () => {
    try {
      const url = URL.createObjectURL(new Blob([`One Shot recovery PIN for ${username}\n${pin}\nKeep this file private.\n`], { type: 'text/plain' }));
      const link = document.createElement('a'); link.href = url; link.download = 'One-Shot-Recovery-PIN.txt'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setAction('download'); setConfirmed(false); setError('');
    } catch { setError('Download could not start. Please copy the PIN instead.'); }
  };
  const complete = async () => {
    if (!action || !confirmed || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await onContinue(); }
    catch { setError('Backup confirmation was not confirmed by the server. Retry, or sign in again with your new password.'); }
    finally { pending.current = false; setBusy(false); }
  };
  return <section className="space-y-5">
    <h2 className="text-xl font-bold">Keep your Recovery PIN</h2>
    <p className="text-sm text-neutral-400">Your password has been changed. This automatically generated 4-digit PIN is shown only here. Keep it privately before continuing.</p>
    <p aria-label="Recovery PIN" className="text-center text-4xl font-mono tracking-[0.4em]">{pin}</p>
    <div className="flex gap-3">
      <button type="button" disabled={busy} onClick={copy} className="flex-1 rounded-xl bg-neutral-800 px-3 py-3">Copy PIN</button>
      <button type="button" disabled={busy} onClick={download} className="flex-1 rounded-xl bg-neutral-800 px-3 py-3">Save as .txt</button>
    </div>
    {action === 'download' && <p role="status" className="text-sm text-amber-300">A download was requested. Check that the file was saved and contains your PIN. If you cancelled the download, try again or use Copy PIN.</p>}
    {action === 'copied' && <p role="status" className="text-sm text-emerald-400">PIN copied. Keep your private backup before continuing.</p>}
    <label className="flex gap-3 text-sm"><input type="checkbox" disabled={!action || busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I have kept the copied PIN privately, or verified that the downloaded file was saved.</label>
    {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
    <button type="button" disabled={!action || !confirmed || busy} onClick={complete} className="w-full rounded-xl bg-emerald-600 py-3 font-bold disabled:opacity-50">{busy ? 'Confirming…' : 'Continue to POS'}</button>
    <button type="button" disabled={busy} onClick={onRestart} className="text-sm text-neutral-400 underline">Sign in again</button>
  </section>;
}
