import { FirstLoginPinBackup } from '../components/FirstLoginPinBackup';
import { toast } from 'sonner';
import { authRequest } from '../utils/localApi';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { ShieldCheck, User, Lock, Eye, EyeOff, AlertTriangle, ArrowLeft, KeyRound, CheckCircle, X } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import logoImg from 'figma:asset/40eb82831843e17a3c48a360fd80f0aaaa58ddc8.png';
import heroFallbackImg from 'figma:asset/15fb8dcab89448c8f2ad20fb9946631b1c246968.png';
import venueFallbackImg from 'figma:asset/622002b1a57eb609a09cacd650764fb95c911672.png';
import playerFallbackImg from 'figma:asset/759b04149309a4f38a99d59a2ef822b4e59fd5d3.png';

type FormView = 'login' | 'reset' | 'force-change' | 'recovery-pin';

const getPasswordStrength = (pw: string) => {
  if (!pw) return { score: 0, color: 'bg-neutral-800/50', isValid: false };
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (/[a-zA-Z]/.test(pw)) score += 1;
  if (/[0-9]/.test(pw)) score += 1;

  if (score === 1) return { score, color: 'bg-rose-500', isValid: false };
  if (score === 2) return { score, color: 'bg-amber-500', isValid: false };
  return { score, color: 'bg-emerald-500', isValid: true };
};

export function OfflineLogin() {
  const navigate = useNavigate();
  const { staffLogin, confirmPinBackup, siteConfig, resetPasswordWithPin } = useAppContext();
  
  const [view, setView] = useState<FormView>('login');
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);

  const [resetUsername, setResetUsername] = useState('');
  const [resetPin, setResetPin] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // 🟢 Close Confirmation Modal State
  const [showCloseModal, setShowCloseModal] = useState(false);

  const [generatedPin, setGeneratedPin] = useState('');

  // 🟢 SAFE PARSER: Prevents the .map() crash if database returns a string
  let parsedImages: any[] = [];
  try {
    parsedImages = typeof siteConfig?.heroImages === 'string' ? JSON.parse(siteConfig.heroImages) : siteConfig?.heroImages;
  } catch (e) {}

  // Bundled images are shipped with the app, so the login screen never renders
  // a blank slider on a fresh install or while the device is offline.
  const sliderImages = Array.isArray(parsedImages) && parsedImages.length > 0
    ? parsedImages.filter((img: any) => typeof img === 'string' && img.trim() !== '')
    : [heroFallbackImg, venueFallbackImg, playerFallbackImg];

  useEffect(() => {
    const timer = setInterval(() => setCurrentSlide((prev) => (prev + 1) % sliderImages.length), 5000);
    return () => clearInterval(timer);
  }, [sliderImages.length]);

  useEffect(() => {
    if (sessionStorage.getItem('oneshot_admin_auth') === 'true') {
      navigate('/admin', { replace: true });
    } else if (sessionStorage.getItem('oneshot_staff_auth') === 'true') {
      navigate('/staff', { replace: true });
    }
  }, [navigate]);

  useEffect(() => {
    if (sessionStorage.getItem('oneshot_signed_out')) {
      sessionStorage.removeItem('oneshot_signed_out');
      toast.success('Signed out successfully.');
    }
  }, []);
  const pwStrength = getPasswordStrength(newPassword);

  const switchView = (newView: FormView) => {
    setError(''); setSuccessMsg(''); setView(newView);
  };

  const enterPortal = (portal: 'admin' | 'staff') => {
    toast.success('Signed in successfully.');
    navigate('/' + portal, { replace: true });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsProcessing(true);
    try {
      const result = await staffLogin(username.trim(), password);
      if (typeof result === 'object') {
        setPassword('');
        setGeneratedPin(result.recoveryPin);
        switchView('recovery-pin');
      } else if (result === 'setup') switchView('force-change');
      else enterPortal(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sign-in failed.');
    } finally {
      setIsProcessing(false);
    }
  };

  const restartLogin = async () => {
    try {
      await authRequest('logout', {});
      setGeneratedPin('');
      setPassword('');
      setNewPassword('');
      setConfirmPassword('');
      switchView('login');
      toast.success('Signed out successfully.');
    } catch { toast.error('Sign-out failed. Please try again.'); }
  };

  const handleForceChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword === 'oneshotstaff') { setError('You cannot use the default password.'); return; }
    if (!pwStrength.isValid) { setError('Password does not meet security requirements.'); return; }
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }

    setIsProcessing(true);
    try {
      const { recoveryPin } = await authRequest('setup', { currentPassword: password, newPassword });
      setGeneratedPin(recoveryPin);
      setPassword('');
      setNewPassword('');
      setConfirmPassword('');
      switchView('recovery-pin');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Account setup failed.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    if (!pwStrength.isValid) { setError('Password does not meet security requirements.'); return; }
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (resetPin.length < 4) { setError('Enter your recovery PIN (4–12 digits).'); return; }

    setIsProcessing(true);
    const res = await resetPasswordWithPin(resetUsername, resetPin, newPassword);
    
    if (res.success) {
      setSuccessMsg('Password successfully changed! Returning to login...');
      setTimeout(() => {
        setUsername(resetUsername);
        setPassword(''); setResetUsername(''); setResetPin(''); setNewPassword(''); setConfirmPassword('');
        switchView('login');
      }, 3000);
    } else {
      setError(res.message);
    }
    setIsProcessing(false);
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col lg:flex-row font-sans overflow-hidden relative">
      
      {/* 🟢 CLOSE CONFIRMATION MODAL */}
      <AnimatePresence>
        {showCloseModal && (
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm px-4"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }} 
              animate={{ scale: 1, opacity: 1 }} 
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 max-w-sm w-full shadow-2xl"
            >
              <div className="flex items-center gap-3 text-rose-500 mb-4">
                <AlertTriangle size={24} />
                <h3 className="text-lg font-bold text-white">Exit System?</h3>
              </div>
              <p className="text-sm text-neutral-400 mb-6 leading-relaxed">
                Are you sure you want to close the Application? 
              </p>
              <div className="flex gap-3">
                <button 
                  onClick={() => setShowCloseModal(false)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-neutral-300 hover:text-white bg-neutral-800 hover:bg-neutral-700 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => window.close()}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white bg-rose-600 hover:bg-rose-500 shadow-lg shadow-rose-900/20 transition-all"
                >
                  Yes, Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 🟢 X BUTTON - Now triggers the modal instead of closing instantly */}
      <button 
        onClick={() => setShowCloseModal(true)} 
        className="fixed top-6 right-6 p-2.5 text-neutral-300 hover:text-white bg-black/40 hover:bg-rose-600/90 backdrop-blur-md border border-white/10 rounded-full transition-all z-[100] shadow-2xl"
        title="Close Application"
      >
        <X size={20} />
      </button>

      <div className="w-full lg:w-[480px] xl:w-[540px] flex flex-col justify-center px-8 sm:px-12 lg:px-16 py-12 z-20 bg-neutral-950 shadow-[20px_0_50px_rgba(0,0,0,0.5)] relative">
        <div className="w-full max-w-sm mx-auto relative overflow-hidden">
          
          <div className="mb-8 select-none">
            <img 
              src={logoImg} 
              alt="One Shot Logo" 
              className="w-16 h-16 object-contain mb-5 rounded-2xl shadow-lg shadow-emerald-900/20 cursor-default" 
            />
            <h1 className="text-3xl font-black text-white tracking-tight leading-tight">ONE SHOT BAR</h1>
            <p className="text-[11px] text-emerald-500 font-bold uppercase tracking-[0.2em] mt-2">Offline Management System</p>
          </div>

          <div className="w-full">
            <AnimatePresence mode="wait">
              
              {/* ── LOGIN VIEW ── */}
              {view === 'login' && (
                <motion.div key="login" initial={{ x: -50, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 50, opacity: 0 }} transition={{ duration: 0.3 }} className="w-full">
                  <form onSubmit={handleLogin} className="space-y-4">
                    <div className="flex items-center gap-2 mb-2">
                      <ShieldCheck className="text-emerald-500" size={18} />
                      <h2 className="text-sm font-bold text-neutral-300 uppercase tracking-wider">Authorized Access Only</h2>
                    </div>
                    {error && <div className="flex items-center gap-2 bg-rose-950/40 border border-rose-800/50 text-rose-400 text-xs px-4 py-3 rounded-xl"><AlertTriangle size={14} className="flex-shrink-0" />{error}</div>}
                    <div className="space-y-4">
                      <div className="space-y-1.5">
                        <label className="block text-[10px] text-neutral-500 font-bold uppercase tracking-widest pl-1">Username</label>
                        <div className="relative">
                          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-500"><User size={16} /></div>
                          <input type="text" autoFocus value={username} onChange={e => setUsername(e.target.value)} disabled={isProcessing} className="w-full bg-neutral-900/50 border border-neutral-800 rounded-xl pl-11 pr-4 py-3 text-sm text-white focus:outline-none focus:border-emerald-500/50 transition-all placeholder-neutral-600" placeholder="Enter your username" />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center pr-1">
                          <label className="block text-[10px] text-neutral-500 font-bold uppercase tracking-widest pl-1">Password</label>
                          <button type="button" onClick={() => switchView('reset')} className="text-[10px] text-emerald-500 hover:text-emerald-400 font-bold transition-colors">Forgot Password?</button>
                        </div>
                        <div className="relative">
                          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-500"><Lock size={16} /></div>
                          <input type={showPw ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} disabled={isProcessing} className="w-full bg-neutral-900/50 border border-neutral-800 rounded-xl pl-11 pr-12 py-3 text-sm text-white focus:outline-none focus:border-emerald-500/50 transition-all placeholder-neutral-600" placeholder="••••••••" />
                          <button type="button" disabled={isProcessing} onClick={() => setShowPw(!showPw)} className="absolute right-4 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 disabled:opacity-50 transition-colors">
                            {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                        </div>
                      </div>
                    </div>
                    <button type="submit" disabled={isProcessing} className="w-full mt-6 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg flex items-center justify-center gap-2">
                      {isProcessing ? 'Authenticating...' : 'Secure Login'}
                    </button>
                  </form>
                </motion.div>
              )}

              {/* ── FORCE PASSWORD CHANGE VIEW ── */}
              {view === 'force-change' && (
                <motion.div key="force-change" initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} transition={{ duration: 0.3 }} className="w-full">
                  <form onSubmit={handleForceChange} className="space-y-4">
                    <div className="bg-rose-950/20 border border-rose-900/40 rounded-xl p-4 mb-4">
                      <div className="flex items-center gap-2 mb-2 text-rose-500">
                        <AlertTriangle size={18} />
                        <h2 className="text-sm font-bold uppercase tracking-wider">Action Required</h2>
                      </div>
                      <p className="text-xs text-rose-200/80 leading-relaxed">
                        Choose a private password for this account. On the next screen, copy or save your four-digit recovery PIN.
                      </p>
                    </div>

                    {error && <div className="flex items-center gap-2 bg-rose-950/40 border border-rose-800/50 text-rose-400 text-xs px-4 py-3 rounded-xl"><AlertTriangle size={14} className="flex-shrink-0" />{error}</div>}
                    {successMsg && <div className="flex items-center gap-2 bg-emerald-950/40 border border-emerald-800/50 text-emerald-400 text-xs px-4 py-3 rounded-xl"><CheckCircle size={14} className="flex-shrink-0" />{successMsg}</div>}

                    <div className="space-y-1.5">
                      <label className="block text-[10px] text-neutral-500 font-bold uppercase tracking-widest pl-1">New Password</label>
                      <div className="relative">
                        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-500"><KeyRound size={16} /></div>
                        <input type={showPw ? "text" : "password"} required autoFocus value={newPassword} onChange={e => setNewPassword(e.target.value)} disabled={isProcessing} className="w-full bg-neutral-900/50 border border-rose-900/50 rounded-xl pl-11 pr-12 py-3 text-sm text-white focus:outline-none focus:border-rose-500/50 transition-all" placeholder="Enter a secure password" />
                        <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-4 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300"><Eye size={16} /></button>
                      </div>
                      {newPassword && (
                        <div className="pt-1 pb-1 space-y-1.5">
                          <div className="flex gap-1 h-1 w-full rounded-full overflow-hidden bg-neutral-900">
                            <div className={`h-full ${pwStrength.score >= 1 ? pwStrength.color : 'bg-transparent'} transition-all w-1/3`} />
                            <div className={`h-full ${pwStrength.score >= 2 ? pwStrength.color : 'bg-transparent'} transition-all w-1/3`} />
                            <div className={`h-full ${pwStrength.score >= 3 ? pwStrength.color : 'bg-transparent'} transition-all w-1/3`} />
                          </div>
                          <p className={`text-[9px] ${pwStrength.isValid ? 'text-emerald-500' : 'text-neutral-500'}`}>Requires 8+ characters, containing letters and numbers.</p>
                        </div>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-[10px] text-neutral-500 font-bold uppercase tracking-widest pl-1">Confirm New Password</label>
                      <div className="relative">
                        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-500"><KeyRound size={16} /></div>
                        <input type="password" required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} disabled={isProcessing} className="w-full bg-neutral-900/50 border border-neutral-800 rounded-xl pl-11 pr-4 py-3 text-sm text-white focus:outline-none focus:border-rose-500/50 transition-all" placeholder="Re-enter password" />
                      </div>
                    </div>

                    <button type="submit" disabled={isProcessing || !pwStrength.isValid} className="w-full mt-4 bg-rose-600 hover:bg-rose-500 disabled:bg-rose-900/50 disabled:text-rose-400/50 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg">
                      {isProcessing ? 'Verifying...' : 'Set Password & Get PIN'}
                    </button>
                    
                    <button type="button" disabled={isProcessing} onClick={restartLogin} className="w-full text-xs text-neutral-500 hover:text-neutral-300 font-bold py-2 transition-all">
                      Cancel & Log Out
                    </button>
                  </form>
                </motion.div>
              )}

              {/* ── RESET VIA PIN VIEW ── */}
              {view === 'reset' && (
                <motion.div key="reset" initial={{ x: 50, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -50, opacity: 0 }} transition={{ duration: 0.3 }} className="w-full">
                  <form onSubmit={handleConfirmReset} className="space-y-4">
                    <button type="button" onClick={() => switchView('login')} className="flex items-center gap-2 text-xs font-bold text-neutral-400 hover:text-white mb-2 transition-colors"><ArrowLeft size={14} /> Back to Login</button>
                    <h2 className="text-xl font-bold text-white mb-4">Account Recovery</h2>

                    {error && <div className="flex items-center gap-2 bg-rose-950/40 border border-rose-800/50 text-rose-400 text-xs px-4 py-3 rounded-xl"><AlertTriangle size={14} className="flex-shrink-0" />{error}</div>}
                    {successMsg && <div className="flex items-center gap-2 bg-emerald-950/40 border border-emerald-800/50 text-emerald-400 text-xs px-4 py-3 rounded-xl"><CheckCircle size={14} className="flex-shrink-0" />{successMsg}</div>}

                    <div className="grid grid-cols-[1fr_120px] gap-3">
                      <div className="space-y-1.5">
                        <label className="block text-[10px] text-neutral-500 font-bold uppercase tracking-widest pl-1">Username</label>
                        <input type="text" required value={resetUsername} onChange={e => setResetUsername(e.target.value)} disabled={isProcessing} className="w-full bg-neutral-900/50 border border-neutral-800 rounded-xl px-3 py-3 text-sm text-white focus:outline-none focus:border-amber-500/50 transition-all" placeholder="Username" />
                      </div>
                      <div className="space-y-1.5">
                        <label className="block text-[10px] text-neutral-500 font-bold uppercase tracking-widest pl-1 text-amber-500">Recovery PIN</label>
                        <input type="password" required inputMode="numeric" maxLength={12} value={resetPin} onChange={e => setResetPin(e.target.value.replace(/\D/g, ''))} disabled={isProcessing} className="w-full bg-amber-950/20 border border-amber-900/50 rounded-xl px-3 py-3 text-lg font-mono text-center tracking-[0.2em] text-amber-400 focus:outline-none focus:border-amber-500 transition-all placeholder-amber-900/40" placeholder="••••" />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-[10px] text-neutral-500 font-bold uppercase tracking-widest pl-1">New Password</label>
                      <div className="relative">
                        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-500"><KeyRound size={16} /></div>
                        <input type={showPw ? "text" : "password"} required value={newPassword} onChange={e => setNewPassword(e.target.value)} disabled={isProcessing} className="w-full bg-neutral-900/50 border border-neutral-800 rounded-xl pl-11 pr-12 py-3 text-sm text-white focus:outline-none focus:border-amber-500/50 transition-all" placeholder="••••••••" />
                        <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-4 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300"><Eye size={16} /></button>
                      </div>
                      {newPassword && (
                        <div className="pt-1 pb-1 space-y-1.5">
                          <div className="flex gap-1 h-1 w-full rounded-full overflow-hidden bg-neutral-900">
                            <div className={`h-full ${pwStrength.score >= 1 ? pwStrength.color : 'bg-transparent'} transition-all w-1/3`} />
                            <div className={`h-full ${pwStrength.score >= 2 ? pwStrength.color : 'bg-transparent'} transition-all w-1/3`} />
                            <div className={`h-full ${pwStrength.score >= 3 ? pwStrength.color : 'bg-transparent'} transition-all w-1/3`} />
                          </div>
                          <p className={`text-[9px] ${pwStrength.isValid ? 'text-emerald-500' : 'text-neutral-500'}`}>Requires 8+ characters, containing letters and numbers.</p>
                        </div>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-[10px] text-neutral-500 font-bold uppercase tracking-widest pl-1">Confirm Password</label>
                      <div className="relative">
                        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-500"><KeyRound size={16} /></div>
                        <input type="password" required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} disabled={isProcessing} className="w-full bg-neutral-900/50 border border-neutral-800 rounded-xl pl-11 pr-4 py-3 text-sm text-white focus:outline-none focus:border-amber-500/50 transition-all" placeholder="••••••••" />
                      </div>
                    </div>

                    <button type="submit" disabled={isProcessing || !pwStrength.isValid || resetPin.length < 4} className="w-full mt-4 bg-amber-600 hover:bg-amber-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg">
                      {isProcessing ? 'Saving...' : 'Confirm & Log In'}
                    </button>
                  </form>
                </motion.div>
              )}

              {view === 'recovery-pin' && (
                <FirstLoginPinBackup pin={generatedPin} username={username.trim()}
                  onContinue={async () => enterPortal(await confirmPinBackup())}
                  onRestart={restartLogin} />
              )}

            </AnimatePresence>
          </div>
          
          <div className="mt-8 pt-6 border-t border-neutral-800/50">
            <p className="text-[10px] text-neutral-600 font-medium">© {new Date().getFullYear()} One Shot Bar & Billiards. All rights reserved.</p>
          </div>
        </div>
      </div>

      <div className="hidden lg:block relative flex-1 bg-neutral-900 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-neutral-950 via-neutral-950/20 to-transparent z-10" />
        <div className="absolute inset-0 bg-gradient-to-t from-neutral-950/80 via-transparent to-neutral-950/30 z-10" />
        {sliderImages.map((img: string, index: number) => (
          <div key={index} className={`absolute inset-0 transition-opacity duration-1000 ease-in-out ${index === currentSlide ? 'opacity-100 scale-100' : 'opacity-0 scale-105'}`}>
            <img
              src={img}
              alt={`Slide ${index + 1}`}
              className="w-full h-full object-cover object-center"
              onError={(event) => {
                const target = event.currentTarget;
                if (target.dataset.fallbackApplied === '1') return;
                target.dataset.fallbackApplied = '1';
                target.src = [heroFallbackImg, venueFallbackImg, playerFallbackImg][index % 3];
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}