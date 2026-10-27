import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { ShieldCheck, User, Lock, Eye, EyeOff, AlertTriangle, ArrowLeft, KeyRound, CheckCircle, TerminalSquare, X, Copy, Download } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import logoImg from 'figma:asset/40eb82831843e17a3c48a360fd80f0aaaa58ddc8.png';

type FormView = 'login' | 'reset' | 'force-change' | 'recovery-pin' | 'god-mode';

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

// 🟢 THE MASTER RECOVERY KEY
const MASTER_RECOVERY_KEY = 'OSB-MASTER-KEY';

export function OfflineLogin() {
  const navigate = useNavigate();
  const { staffLogin, adminLogin, siteConfig, resetPasswordWithPin, updateStaffUser, staffUsers, staffLogout, hashPassword, resetStaffUserPassword } = useAppContext() as any;
  
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

  // 🟢 God Mode State
  const [logoClicks, setLogoClicks] = useState(0);
  const [godKeyInput, setGodKeyInput] = useState('');

  // 🟢 Close Confirmation Modal State
  const [showCloseModal, setShowCloseModal] = useState(false);

  const [pinSaved, setPinSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  // 🟢 SAFE PARSER: Prevents the .map() crash if database returns a string
  let parsedImages: any[] = [];
  try {
    parsedImages = typeof siteConfig?.heroImages === 'string' ? JSON.parse(siteConfig.heroImages) : siteConfig?.heroImages;
  } catch (e) {}

  const sliderImages = Array.isArray(parsedImages) && parsedImages.length > 0 
    ? parsedImages 
    : [
        'https://images.unsplash.com/photo-1595079676339-1534801ad6cb?q=80&w=2000&auto=format&fit=crop',
        'https://images.unsplash.com/photo-1514933651103-005eec06c04b?q=80&w=2000&auto=format&fit=crop',
      ];

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

  const pwStrength = getPasswordStrength(newPassword);

  const switchView = (newView: FormView) => {
    setError(''); setSuccessMsg(''); setView(newView);
  };

  const handleLogoClick = () => {
    const newCount = logoClicks + 1;
    setLogoClicks(newCount);
    if (newCount === 7) {
      switchView('god-mode');
      setLogoClicks(0); 
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setIsProcessing(true);

    const targetUser = staffUsers.find((u: any) => u.username.toLowerCase() === username.toLowerCase());
    
    if (targetUser && password === 'oneshotstaff') {
      switchView('force-change');
      setIsProcessing(false);
      return;
    }

    const res = await (username === 'superadmin' || targetUser?.isAdmin 
      ? adminLogin(username, password) 
      : staffLogin(username, password));
      
    if (res) {
      setSuccessMsg('Authentication successful...');
      setTimeout(() => {
        navigate(username === 'superadmin' || targetUser?.isAdmin ? '/admin' : '/staff');
      }, 1000);
    } else {
      setError('Invalid username or password.');
      setIsProcessing(false);
    }
  };

  const handleForceChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword === 'oneshotstaff') { setError('You cannot use the default password.'); return; }
    if (!pwStrength.isValid) { setError('Password does not meet security requirements.'); return; }
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }

    setIsProcessing(true);
    const targetUser = staffUsers.find((u: any) => u.username.toLowerCase() === username.toLowerCase());    
    if (targetUser) {
      const hashedNew = await hashPassword(newPassword);
      updateStaffUser(targetUser.id, { password: hashedNew });
      setSuccessMsg('Password updated. Generating recovery credentials...');
      setTimeout(() => { switchView('recovery-pin'); setIsProcessing(false); }, 1500);
    } else {
      setError('User record not found.');
      setIsProcessing(false);
    }
  };

  const handleCopyPin = (pin: string) => {
    navigator.clipboard.writeText(pin);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadPin = () => {
    const targetUser = staffUsers.find((u: any) => u.username.toLowerCase() === username.toLowerCase());
    if (!targetUser) return;
    const text = `ONE SHOT BAR & BILLIARDS\n=================================\nACCOUNT RECOVERY CREDENTIALS\n=================================\n\nAccount Name : ${targetUser.fullName}\nUsername     : ${targetUser.username}\nRole         : ${targetUser.role.toUpperCase()}\n\nOFFLINE RECOVERY PIN: ${targetUser.recoveryPin}\n\n=================================\nIMPORTANT: Keep this file secure. Because this system operates offline, if you forget your password, you will strictly need this 4-digit PIN to recover your account without a Super Admin.\n`;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `oneshot-recovery-pin-${targetUser.username}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleCompleteSetup = async () => {
    const targetUser = staffUsers.find((u: any) => u.username.toLowerCase() === username.toLowerCase());
    
    // 🟢 FIXED: Actually authenticate the user into the session before navigating
    if (targetUser?.isAdmin || username === 'superadmin') {
      await adminLogin(username, newPassword);
    } else {
      await staffLogin(username, newPassword);
    }
    
    navigate(targetUser?.isAdmin ? '/admin' : '/staff');
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    if (!pwStrength.isValid) { setError('Password does not meet security requirements.'); return; }
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (resetPin.length !== 4) { setError('Recovery PIN must be exactly 4 digits.'); return; }

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

  const handleGodModeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsProcessing(true);

    if (godKeyInput === MASTER_RECOVERY_KEY) {
      setSuccessMsg('MASTER OVERRIDE ACCEPTED. Resetting Super Admin...');
      
      const superAdmin = staffUsers.find((u: any) => u.username === 'superadmin');
      if (superAdmin) {
        await resetStaffUserPassword(superAdmin.id);
        
        setTimeout(async () => {
          await adminLogin('superadmin', 'oneshotstaff');
          navigate('/admin');
        }, 2000);
      } else {
        setError('CRITICAL: Super Admin account not found in database.');
        setIsProcessing(false);
      }
    } else {
      setError('ACCESS DENIED.');
      setGodKeyInput('');
      setIsProcessing(false);
    }
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
              onClick={handleLogoClick}
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
                        Your password has been reset to the system default by an Administrator. You must set a new private password before you can access the dashboard.
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
                      {isProcessing ? 'Verifying...' : 'Set Password & Enter System'}
                    </button>
                    
                    <button type="button" disabled={isProcessing} onClick={() => { staffLogout(); switchView('login'); }} className="w-full text-xs text-neutral-500 hover:text-neutral-300 font-bold py-2 transition-all">
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
                        <label className="block text-[10px] text-neutral-500 font-bold uppercase tracking-widest pl-1 text-amber-500">4-Digit PIN</label>
                        <input type="password" required maxLength={4} value={resetPin} onChange={e => setResetPin(e.target.value.replace(/\D/g, ''))} disabled={isProcessing} className="w-full bg-amber-950/20 border border-amber-900/50 rounded-xl px-3 py-3 text-lg font-mono text-center tracking-[0.2em] text-amber-400 focus:outline-none focus:border-amber-500 transition-all placeholder-amber-900/40" placeholder="••••" />
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

                    <button type="submit" disabled={isProcessing || !pwStrength.isValid || resetPin.length !== 4} className="w-full mt-4 bg-amber-600 hover:bg-amber-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg">
                      {isProcessing ? 'Saving...' : 'Confirm & Log In'}
                    </button>
                  </form>
                </motion.div>
              )}

              {/* ── GOD MODE RECOVERY VIEW ── */}
              {view === 'god-mode' && (
                <motion.div key="god-mode" initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} transition={{ duration: 0.4 }} className="w-full">
                  <form onSubmit={handleGodModeSubmit} className="space-y-4">
                    <button type="button" onClick={() => switchView('login')} className="flex items-center gap-2 text-xs font-bold text-neutral-400 hover:text-white mb-2 transition-colors"><ArrowLeft size={14} /> Back to Login</button>
                    
                    <div className="flex items-center gap-2 mb-2 text-rose-500">
                      <TerminalSquare size={18} />
                      <h2 className="text-sm font-bold uppercase tracking-widest">Master Terminal Override</h2>
                    </div>
                    
                    <p className="text-xs text-rose-200/80 leading-relaxed mb-4 border-l-2 border-rose-500 pl-3">
                      WARNING: You have initiated an Admin bypass. Enter the 16-character Cold Storage Master Key to reset the core Administrator account.
                    </p>

                    {error && <div className="flex items-center gap-2 bg-rose-950/40 border border-rose-800/50 text-rose-400 text-xs px-4 py-3 rounded-xl"><AlertTriangle size={14} className="flex-shrink-0" />{error}</div>}
                    {successMsg && <div className="flex items-center gap-2 bg-emerald-950/40 border border-emerald-800/50 text-emerald-400 text-xs px-4 py-3 rounded-xl"><CheckCircle size={14} className="flex-shrink-0" />{successMsg}</div>}

                    <div className="space-y-1.5 pt-2">
                      <label className="block text-[10px] text-rose-500 font-bold uppercase tracking-widest pl-1">Master Recovery Key</label>
                      <div className="relative">
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
                    </div>

                    <button type="submit" disabled={isProcessing || !godKeyInput} className="w-full mt-4 bg-rose-600 hover:bg-rose-500 disabled:bg-rose-900/50 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-rose-900/20 uppercase tracking-widest text-xs">
                      {isProcessing ? 'Decrypting Key...' : 'Execute Override'}
                    </button>
                  </form>
                </motion.div>
              )}

              {/* ── RECOVERY PIN BACKUP VIEW ── */}
              {view === 'recovery-pin' && (() => {
                const targetUser = staffUsers.find((u: any) => u.username.toLowerCase() === username.toLowerCase());
                return (
                  <motion.div key="recovery-pin" initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} transition={{ duration: 0.3 }} className="w-full">
                    <div className="bg-amber-950/20 border border-amber-900/40 rounded-xl p-5 mb-5 text-center">
                      <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-3 text-amber-500">
                        <ShieldCheck size={24} />
                      </div>
                      <h2 className="text-lg font-black text-amber-400 tracking-wide uppercase mb-2">Save Your Recovery PIN</h2>
                      <p className="text-xs text-amber-200/80 leading-relaxed mb-5">
                        This system operates offline. If you forget your password, this 4-digit PIN is the <strong>ONLY</strong> way to recover your account without a Super Admin.
                      </p>
                      
                      <div className="bg-black/40 border border-black/50 rounded-lg p-5 mb-5">
                        <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-bold mb-1">Your Unique PIN</p>
                        <p className="text-5xl font-mono font-black text-white tracking-[0.2em]">{targetUser?.recoveryPin || '0000'}</p>
                      </div>
                      
                      <div className="flex gap-3">
                        <button onClick={() => handleCopyPin(targetUser?.recoveryPin || '0000')} className="flex-1 py-3 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-xl text-xs font-bold transition-colors border border-neutral-800 flex items-center justify-center gap-2">
                          {copied ? <CheckCircle size={15} className="text-emerald-400" /> : <Copy size={15} />} {copied ? 'Copied!' : 'Copy PIN'}
                        </button>
                        <button onClick={handleDownloadPin} className="flex-1 py-3 bg-neutral-900 hover:bg-neutral-800 text-neutral-300 rounded-xl text-xs font-bold transition-colors border border-neutral-800 flex items-center justify-center gap-2">
                          <Download size={15} /> Save as .txt
                        </button>
                      </div>
                    </div>

                    <label className="flex items-start gap-3 cursor-pointer p-4 rounded-xl border border-neutral-800 bg-neutral-900/30 hover:bg-neutral-900/50 transition-colors mb-6">
                      <input type="checkbox" checked={pinSaved} onChange={() => setPinSaved(!pinSaved)} className="mt-1 h-4 w-4 rounded border-neutral-700 bg-neutral-800 text-emerald-500 focus:ring-emerald-500" />
                      <span className="text-xs text-neutral-400 leading-relaxed">
                        I confirm that I have copied or downloaded my recovery PIN and stored it in a safe, private place.
                      </span>
                    </label>

                    <button 
                      onClick={handleCompleteSetup} 
                      disabled={!pinSaved} 
                      className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-600 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg flex items-center justify-center gap-2"
                    >
                      Complete Setup & Enter System
                    </button>
                  </motion.div>
                );
              })()}

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
            <img src={img} alt={`Slide ${index + 1}`} className="w-full h-full object-cover object-center" />
          </div>
        ))}
      </div>
    </div>
  );
}