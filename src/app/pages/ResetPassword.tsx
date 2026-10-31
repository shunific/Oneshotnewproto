import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { supabase } from '../utils/supabase';
import { Lock, CheckCircle, AlertTriangle, Eye, EyeOff } from 'lucide-react';

export function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    // Listen for the specific recovery event from Supabase
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        console.log("Password recovery session established.");
      }
    });
    return () => authListener.subscription.unsubscribe();
  }, []);

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      return setError('Password must be at least 8 characters long.');
    }
    if (password !== confirmPassword) {
      return setError('Passwords do not match.');
    }

    setLoading(true);
    // Since Supabase established a temporary session via the email link, we just update the user.
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      setSuccess(true);
      setLoading(false);
      setTimeout(() => {
        navigate('/'); // Send them back to the app!
      }, 3000);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-3xl p-8 shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-emerald-500 to-sky-500" />
        
        {success ? (
          <div className="text-center py-6 animate-in fade-in zoom-in-95">
            <CheckCircle size={48} className="text-emerald-500 mx-auto mb-4" />
            <h2 className="text-2xl font-black text-white mb-2">Password Updated!</h2>
            <p className="text-neutral-400 text-sm">Your account is secure. Redirecting you back to the home page...</p>
          </div>
        ) : (
          <>
            <div className="w-16 h-16 bg-neutral-950 rounded-full flex items-center justify-center mb-6 border border-neutral-800 shadow-inner">
              <Lock size={28} className="text-emerald-400" />
            </div>
            <h2 className="text-2xl font-black text-white mb-2">Set New Password</h2>
            <p className="text-neutral-400 text-sm mb-6">Create a strong, 8-character minimum password to secure your One Shot account.</p>

            {error && (
              <div className="mb-4 bg-rose-950/40 border border-rose-800/50 text-rose-400 text-xs px-4 py-3 rounded-xl flex items-center gap-2">
                <AlertTriangle size={14} className="flex-shrink-0" /> {error}
              </div>
            )}

            <form onSubmit={handleReset} className="space-y-4">
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">New Password</label>
                <div className="relative">
                  <input 
                    type={showPw ? 'text' : 'password'} 
                    autoFocus 
                    value={password} 
                    onChange={e => { setPassword(e.target.value); setError(''); }} 
                    className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-4 py-3.5 pr-10 text-sm text-neutral-100 focus:border-emerald-500 outline-none transition-colors" 
                  />
                  <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-4 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300">
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">Confirm New Password</label>
                <input 
                  type="password" 
                  value={confirmPassword} 
                  onChange={e => { setConfirmPassword(e.target.value); setError(''); }} 
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-4 py-3.5 text-sm text-neutral-100 focus:border-emerald-500 outline-none transition-colors" 
                />
              </div>

              <button 
                type="submit" 
                disabled={loading || password.length < 8} 
                className="w-full mt-4 bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white py-3.5 rounded-xl text-sm font-bold shadow-lg shadow-emerald-900/30 transition-colors"
              >
                {loading ? 'Updating Password...' : 'Save New Password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}