import { useState, useEffect, useRef } from 'react';
import { Lock, Eye, EyeOff, ShieldAlert, User } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { authRequest } from '../utils/localApi';

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const { staffProfile } = useAppContext();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const identity = useRef(staffProfile?.id);
  identity.current = staffProfile?.id;
  const [administrator, setAdministrator] = useState(false);
  const [username, setUsername] = useState('');

  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // 🛡️ THE REACT INTERCEPTOR: Block malicious browser bypasses
  useEffect(() => {
    const blockBypasses = (e: KeyboardEvent) => {
      if (e.key === 'F5' || (e.ctrlKey && e.key === 'r') || (e.metaKey && e.key === 'r')) e.preventDefault();
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I') || (e.metaKey && e.altKey && e.key === 'i')) e.preventDefault();
      if ((e.ctrlKey && e.key === 'w') || (e.ctrlKey && e.key === 't')) e.preventDefault();
    };
    const blockContextMenu = (e: MouseEvent) => e.preventDefault();

    window.addEventListener('keydown', blockBypasses);
    window.addEventListener('contextmenu', blockContextMenu);
    return () => {
      window.removeEventListener('keydown', blockBypasses);
      window.removeEventListener('contextmenu', blockContextMenu);
    };
  }, []);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsProcessing(true);

    try {
      const originalIdentity = identity.current;
      const result = await authRequest('unlock', administrator ? { username, password } : { password });
      if (mounted.current && result.success === true && originalIdentity && identity.current === originalIdentity) onUnlock();
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure instanceof Error ? failure.message : 'Unable to verify password. Please try again.');
      setPassword('');
    } finally {
      if (mounted.current) setIsProcessing(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Terminal locked" className="fixed inset-0 z-[99999] bg-neutral-950 flex flex-col items-center justify-center select-none">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-xl z-0" />

      <div className="relative z-10 w-full max-w-sm p-8 bg-neutral-900 border border-neutral-800 rounded-3xl shadow-2xl flex flex-col items-center animate-in zoom-in-95 duration-200">

        <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-rose-500/10 border border-rose-500/20 shadow-[0_0_50px_rgba(244,63,94,0.1)]">
          <Lock size={32} className="text-rose-500" />
        </div>

        <h1 className="text-2xl font-black text-white tracking-tight mb-1">Terminal Locked</h1>

        {/* 🟢 FIXED: Display who specifically locked the terminal */}
        <p className="text-sm text-neutral-400 mb-8 flex items-center gap-1.5">
          <User size={14} /> Locked by <strong className="text-neutral-200">@{staffProfile?.username}</strong>
        </p>

        <form onSubmit={handleUnlock} className="w-full space-y-5">
          {error && (
            <div className="flex items-center gap-2 bg-rose-950/40 border border-rose-800/50 text-rose-400 text-xs px-4 py-3 rounded-xl animate-in shake">
              <ShieldAlert size={14} className="flex-shrink-0" /> {error}
            </div>
          )}

          {administrator && (
            <input aria-label="Administrator username" autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)} disabled={isProcessing} placeholder="Administrator username" className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-3.5 text-sm text-white" />
          )}
          <div className="relative">
            <input
              type={showPw ? "text" : "password"}
              autoFocus
              aria-label={administrator ? "Administrator password" : "Your password"}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isProcessing}
              placeholder="Enter password to unlock"
              className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 pr-12 py-3.5 text-center text-sm text-white focus:outline-none focus:border-rose-500/50 focus:ring-1 focus:ring-rose-500/20 transition-all placeholder-neutral-600 tracking-widest"
            />
            <button type="button" tabIndex={-1} onClick={() => setShowPw(!showPw)} className="absolute right-4 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300">
              {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          <button type="submit" disabled={!password || isProcessing} className="w-full bg-rose-600 hover:bg-rose-500 disabled:bg-neutral-800 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-rose-900/20">
            {isProcessing ? 'Verifying...' : 'Unlock Terminal'}
          </button>
          <button type="button" disabled={isProcessing} onClick={() => { setAdministrator(!administrator); setPassword(''); setUsername(''); setError(''); }} className="w-full text-sm text-neutral-300 underline disabled:opacity-50">
            {administrator ? 'Use my password' : 'Use administrator credentials'}
          </button>
          {administrator && <p className="text-xs text-neutral-400">Administrator approval unlocks this terminal. You remain signed in as @{staffProfile?.username} with your existing permissions.</p>}
        </form>

      </div>
    </div>
  );
}