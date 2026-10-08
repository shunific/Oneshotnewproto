import { useState, useEffect } from 'react';
import { Lock, Eye, EyeOff, ShieldAlert, User, TerminalSquare, KeyRound, ArrowLeft } from 'lucide-react';
import { useAppContext } from '../context/AppContext';

// 🟢 THE MASTER RECOVERY KEY
const MASTER_RECOVERY_KEY = 'OSB-MASTER-KEY';

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  // 🟢 FIXED: Brought back staffProfile for Account-Based locking
  const { staffProfile, staffUsers, hashPassword } = useAppContext();
  
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // 🟢 God Mode State
  const [logoClicks, setLogoClicks] = useState(0);
  const [showGodMode, setShowGodMode] = useState(false);
  const [godKeyInput, setGodKeyInput] = useState('');

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

  const handleLogoClick = () => {
    const newCount = logoClicks + 1;
    setLogoClicks(newCount);
    if (newCount === 7) {
      setShowGodMode(true);
      setLogoClicks(0); 
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsProcessing(true);

    // Hash their input to compare against the secure DB
    const hashedInput = await hashPassword(password);
    
    // 🟢 FIXED: Account-Based Check - Does it match the CURRENT user who locked it?
    const isCurrentUser = staffUsers.some(u => 
      u.username === staffProfile.username && 
      u.password === hashedInput && 
      u.isActive
    );

    // 🟢 FIXED: Admin Override Check - Allows ANY active Admin to unlock it
    const isAdminOverride = staffUsers.some(u => 
      u.isAdmin && 
      u.isActive && 
      u.password === hashedInput
    );

    if (isCurrentUser || isAdminOverride) {
      localStorage.removeItem('oneshot_is_locked'); // Clear the persistent lock
      onUnlock();
    } else {
      setError('Incorrect password.');
      setPassword(''); // Clear field on failure to prevent brute forcing
    }
    
    setIsProcessing(false);
  };

  const handleGodModeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsProcessing(true);

    if (godKeyInput === MASTER_RECOVERY_KEY) {
      // Direct bypass
      localStorage.removeItem('oneshot_is_locked');
      onUnlock();
    } else {
      setError('ACCESS DENIED.');
      setGodKeyInput('');
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[99999] bg-neutral-950 flex flex-col items-center justify-center select-none">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-xl z-0" />
      
      <div className="relative z-10 w-full max-w-sm p-8 bg-neutral-900 border border-neutral-800 rounded-3xl shadow-2xl flex flex-col items-center animate-in zoom-in-95 duration-200">
        
        {/* Clickable trigger region */}
        <div 
          onClick={handleLogoClick}
          className={`w-20 h-20 rounded-full flex items-center justify-center mb-6 transition-all ${showGodMode ? 'bg-rose-950/30 border border-rose-900/50' : 'bg-rose-500/10 border border-rose-500/20 shadow-[0_0_50px_rgba(244,63,94,0.1)]'}`}
        >
          {showGodMode ? <TerminalSquare size={32} className="text-rose-500" /> : <Lock size={32} className="text-rose-500" />}
        </div>

        {!showGodMode ? (
          <>
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

              <div className="relative">
                <input
                  type={showPw ? "text" : "password"}
                  autoFocus
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
            </form>
          </>
        ) : (
          <form onSubmit={handleGodModeSubmit} className="w-full flex flex-col items-center animate-in fade-in slide-in-from-bottom-4">
            <h1 className="text-sm font-black text-rose-500 tracking-widest uppercase mb-1">Master Override</h1>
            <p className="text-[10px] text-neutral-500 mb-6 text-center leading-relaxed px-2">Enter Cold Storage Key to bypass terminal lock sequence.</p>
            
            {error && (
              <div className="flex w-full items-center gap-2 bg-rose-950/40 border border-rose-800/50 text-rose-400 text-xs px-4 py-3 rounded-xl mb-4 animate-in shake">
                <ShieldAlert size={14} className="flex-shrink-0" /> {error}
              </div>
            )}

            <div className="w-full relative mb-5">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-rose-500/50"><KeyRound size={16} /></div>
              <input 
                type="password" 
                required 
                autoFocus 
                value={godKeyInput} 
                onChange={e => setGodKeyInput(e.target.value.toUpperCase())} 
                disabled={isProcessing} 
                className="w-full bg-rose-950/10 border border-rose-900/50 rounded-xl pl-11 pr-4 py-4 text-center text-sm font-mono tracking-[0.3em] text-rose-400 focus:outline-none focus:border-rose-500 transition-all placeholder-rose-900/30" 
                placeholder="XXXX-XXXX-XXXX-XXXX" 
              />
            </div>
            
            <button type="submit" disabled={!godKeyInput || isProcessing} className="w-full bg-rose-600 hover:bg-rose-500 disabled:bg-rose-900/50 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-rose-900/20 uppercase tracking-widest text-xs mb-3">
              {isProcessing ? 'Decrypting...' : 'Execute Override'}
            </button>
            
            <button type="button" onClick={() => { setShowGodMode(false); setError(''); setGodKeyInput(''); }} className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-300 font-bold transition-colors">
              <ArrowLeft size={12} /> Return to Lock
            </button>
          </form>
        )}
      </div>
    </div>
  );
}