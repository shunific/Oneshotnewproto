import { LoadingRing } from '../components/LoadingRing';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { supabase } from '../utils/supabase';
import { Lock, CheckCircle, AlertTriangle, Eye, EyeOff, Mail } from 'lucide-react';

// Supabase consumes the recovery token from the URL as soon as the client is
// created, so remember what the visitor arrived with before that happens.
const INITIAL_LINK_PARAMS = (() => {
  try {
    const raw = `${window.location.search}${window.location.hash}`;
    return new URLSearchParams(raw.replace(/^#/, '&'));
  } catch {
    return new URLSearchParams();
  }
})();

const INITIAL_LINK_ERROR = (() => {
  const desc = INITIAL_LINK_PARAMS.get('error_description') || INITIAL_LINK_PARAMS.get('error');
  return desc ? decodeURIComponent(desc.replace(/\+/g, ' ')) : '';
})();

export function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [status, setStatus] = useState<'checking' | 'ready' | 'expired'>(INITIAL_LINK_ERROR ? 'expired' : 'checking');
  const [accountEmail, setAccountEmail] = useState('');
  const [resendEmail, setResendEmail] = useState('');
  const [resend, setResend] = useState({ loading: false, sent: false, error: '' });

  useEffect(() => {
    let cancelled = false;

    const useSession = (session: any) => {
      if (cancelled || !session?.user || INITIAL_LINK_ERROR) return;
      setAccountEmail(session.user.email || '');
      setStatus('ready');
    };

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        useSession(session);
      } else if (event === 'SIGNED_IN') {
        useSession(session);
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session?.user && !INITIAL_LINK_ERROR) {
        useSession(data.session);
        return;
      }
      // The token check may still be settling; only give up after a short wait.
      setTimeout(() => {
        if (!cancelled) setStatus(current => (current === 'ready' ? current : 'expired'));
      }, 2500);
    });

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
    };
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
    const { data: { session } } = await supabase.auth.getSession();
    const email = session?.user?.email || accountEmail;
    if (!session?.user || !email) {
      setError('Your reset link has expired. Please request a new one.');
      setStatus('expired');
      setLoading(false);
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    // Prove the new password actually works before reporting success. A stale
    // recovery session can make this silent, which is exactly what leaves the
    // customer unable to sign in afterwards.
    await supabase.auth.signOut();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError(`Your password was saved but signing in with it failed (${signInError.message}). Please request a new reset link.`);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
    setTimeout(() => {
      navigate('/');
    }, 3000);
  };

  const handleResend = async () => {
    const email = resendEmail.trim();
    if (!email) return setResend(r => ({ ...r, error: 'Enter the email on your account.' }));
    setResend({ loading: true, sent: false, error: '' });
    const { error: sendError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (sendError) {
      setResend({ loading: false, sent: false, error: sendError.message });
    } else {
      setResend({ loading: false, sent: true, error: '' });
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
            <p className="text-neutral-400 text-sm">Your new password has been verified. Redirecting you back to the home page...</p>
          </div>
        ) : status === 'checking' ? (
          <div className="text-center py-10">
            <LoadingRing className="h-10 w-10 mx-auto mb-4" />
            <p className="text-sm text-neutral-400">Checking your reset link...</p>
          </div>
        ) : status === 'expired' ? (
          <>
            <div className="w-16 h-16 bg-neutral-950 rounded-full flex items-center justify-center mb-6 border border-neutral-800 shadow-inner">
              <AlertTriangle size={28} className="text-amber-400" />
            </div>
            <h2 className="text-2xl font-black text-white mb-2">Reset Link Expired</h2>
            <p className="text-neutral-400 text-sm mb-6">
              {INITIAL_LINK_ERROR || 'This password reset link is invalid, already used, or has expired.'}
              {' '}Enter your email and we will send you a fresh link.
            </p>

            {resend.sent ? (
              <div className="bg-emerald-950/40 border border-emerald-800/50 text-emerald-300 text-xs px-4 py-3 rounded-xl flex items-center gap-2">
                <CheckCircle size={14} className="flex-shrink-0" /> Link sent. Check your inbox (and spam folder).
              </div>
            ) : (
              <form onSubmit={e => { e.preventDefault(); handleResend(); }} className="space-y-4">
                {resend.error && (
                  <div className="bg-rose-950/40 border border-rose-800/50 text-rose-400 text-xs px-4 py-3 rounded-xl flex items-center gap-2">
                    <AlertTriangle size={14} className="flex-shrink-0" /> {resend.error}
                  </div>
                )}
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Account Email</label>
                  <div className="relative">
                    <Mail size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-500" />
                    <input
                      type="email"
                      required
                      autoComplete="email"
                      value={resendEmail}
                      onChange={e => { setResendEmail(e.target.value); setResend(r => ({ ...r, error: '' })); }}
                      placeholder="you@email.com"
                      className="w-full bg-neutral-950 border border-neutral-700 rounded-xl pl-11 pr-4 py-3.5 text-sm text-neutral-100 focus:border-emerald-500 outline-none transition-colors placeholder-neutral-600"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={resend.loading}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white py-3.5 rounded-xl text-sm font-bold shadow-lg shadow-emerald-900/30 transition-colors"
                >
                  {resend.loading ? 'Sending...' : 'Send New Reset Link'}
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  className="w-full text-neutral-400 hover:text-neutral-200 text-xs font-semibold py-1 transition-colors"
                >
                  Back to Home
                </button>
              </form>
            )}
          </>
        ) : (
          <>
            <div className="w-16 h-16 bg-neutral-950 rounded-full flex items-center justify-center mb-6 border border-neutral-800 shadow-inner">
              <Lock size={28} className="text-emerald-400" />
            </div>
            <h2 className="text-2xl font-black text-white mb-2">Set New Password</h2>
            <p className="text-neutral-400 text-sm mb-2">Create a strong, 8-character minimum password to secure your One Shot account.</p>
            {accountEmail && (
              <p className="text-xs text-neutral-500 mb-6">
                Resetting the password for <span className="font-semibold text-neutral-300">{accountEmail}</span>
              </p>
            )}

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
                    name="new-password"
                    autoComplete="new-password"
                    minLength={8}
                    required
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
                  type={showPw ? 'text' : 'password'}
                  name="confirm-password"
                  autoComplete="new-password"
                  minLength={8}
                  required
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
