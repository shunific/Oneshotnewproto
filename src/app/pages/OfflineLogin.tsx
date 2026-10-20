import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAppContext } from '../context/AppContext';
import { authRequest } from '../utils/localApi';
import { FirstLoginPinBackup } from '../components/FirstLoginPinBackup';
import { Lock, ShieldCheck } from 'lucide-react';

type View = 'login' | 'setup' | 'recover' | 'bootstrap';

export function OfflineLogin() {
  const { signIn, resetPasswordWithPin, staffLoggedIn, adminLoggedIn } = useAppContext();
  const navigate = useNavigate();
  const [generatedPin, setGeneratedPin] = useState('');
  const [view, setView] = useState<View>('login');
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pin, setPin] = useState('');
  const [savedPin, setSavedPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (adminLoggedIn) navigate('/admin', { replace: true });
    else if (staffLoggedIn) navigate('/staff', { replace: true });
  }, [adminLoggedIn, staffLoggedIn, navigate]);

  useEffect(() => {
    authRequest('status').then(r => { if (r.needsBootstrap) setView('bootstrap'); }).catch(() => {});
  }, []);

  const passwordChecks = [newPassword.length >= 8 && newPassword.length <= 256, /[a-zA-Z]/.test(newPassword), /[0-9]/.test(newPassword)];
  const passwordValid = passwordChecks.every(Boolean) && newPassword !== 'oneshotstaff';

  const switchView = (v: View) => { setView(v); setError(''); setMessage(''); setNewPassword(''); setConfirmPassword(''); setPin(''); setSavedPin(false); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (view === 'login') {
        const result = await signIn(username, password);
        if (result.requiresPasswordChange) { setView('setup'); return; }
        setPassword('');
        return;
      }
      if (!passwordValid) throw new Error('Use 8–256 characters with at least one letter and one number.');
      if (newPassword !== confirmPassword) throw new Error('New passwords do not match. Confirm your new password exactly.');
      if (view === 'setup' && newPassword === password) throw new Error('Choose a different password from your current temporary password.');
      if (view !== 'setup' && !/^\d{4,12}$/.test(pin)) throw new Error('Use a recovery PIN of 4–12 digits. A longer PIN is safer.');
      if (view === 'bootstrap' && !savedPin) throw new Error('Keep your recovery PIN in a safe place and confirm below.');
      if (view === 'bootstrap') {
        await authRequest('bootstrap', { username, fullName, password: newPassword, recoveryPin: pin });
        setPassword(''); setNewPassword(''); setConfirmPassword(''); setPin(''); setView('login');
        setMessage('Administrator created. Sign in with your new password.');
      } else if (view === 'setup') {
        const result = await authRequest('setup', { currentPassword: password, newPassword });
        if (result.requiresPinBackup !== true || typeof result.recoveryPin !== 'string' || !/^\d{4}$/.test(result.recoveryPin)) throw new Error('PIN setup response was not confirmed. Sign in with your new password and repeat setup.');
        setGeneratedPin(result.recoveryPin);
        setPassword(''); setConfirmPassword('');
      } else {
        const result = await resetPasswordWithPin(username, pin, newPassword);
        if (!result.success) throw new Error(result.message);
        setPassword(''); setNewPassword(''); setConfirmPassword(''); setPin(''); setView('login');
        setMessage('Password changed. Sign in with your new password.');
      }
    } catch (e: any) { setError(e.message || 'Unable to reach the local server. Please retry.'); }
    finally { setBusy(false); }
  };

  const field = (label: string, value: string, setValue: (v: string) => void, type = 'text', autoComplete?: string) => (
    <label className="block text-sm text-neutral-300 space-y-2">
      <span>{label}</span>
      <input required disabled={busy} type={type} autoComplete={autoComplete} value={value} onChange={e => setValue(e.target.value)} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500" />
    </label>
  );
  return (
    <main className="min-h-screen bg-neutral-950 text-white grid place-items-center p-6">
      <section className="w-full max-w-md rounded-3xl border border-neutral-800 p-8 space-y-6">
        <ShieldCheck className="text-emerald-400" size={36} />
        <div><h1 className="text-2xl font-bold">One Shot</h1><h2 className="text-neutral-400 mt-2">{view === 'login' ? 'Staff sign in' : view === 'bootstrap' ? 'Create the first administrator' : view === 'setup' ? 'Secure your account' : 'Recover your account'}</h2></div>
        {view === 'setup' && !generatedPin && <p className="text-sm text-neutral-400">Choose a new password. Your 4-digit Recovery PIN will be generated next. If a previous save lost its response, sign in again with your new password and repeat setup.</p>}
        {generatedPin ? <FirstLoginPinBackup pin={generatedPin} username={username} onContinue={async () => {
          await authRequest('acknowledge-pin', { acknowledged: true });
          setGeneratedPin('');
          try { await signIn(username, newPassword); }
          catch { setView('login'); setMessage('Setup completed. Sign in with your new password.'); }
          finally { setNewPassword(''); setPassword(''); }
        }} onRestart={() => { setGeneratedPin(''); switchView('login'); setPassword(''); }} /> : <>
        <form onSubmit={submit} className="space-y-5">
          {view !== 'setup' && field('Username', username, setUsername, 'text', 'username')}
          {view === 'bootstrap' && field('Full name', fullName, setFullName, 'text', 'name')}
          {view === 'login' ? field('Password', password, setPassword, 'password', 'current-password') : <>
            {field('New password', newPassword, setNewPassword, 'password', 'new-password')}
            <div aria-label="Password strength" role="status" className="space-y-2 text-xs">
              <div className="flex gap-1" aria-hidden="true">{passwordChecks.map((met, index) => <span key={index} className={`h-1.5 flex-1 rounded ${met ? passwordValid ? 'bg-emerald-500' : 'bg-amber-500' : 'bg-neutral-800'}`} />)}</div>
              <p className={passwordValid ? 'text-emerald-400' : 'text-neutral-400'}>{passwordValid ? 'Password meets requirements.' : 'Use 8–256 characters, including letters and numbers.'}</p>
              <ul className="text-neutral-400">{['8–256 characters', 'At least one letter', 'At least one number'].map((label, index) => <li key={label}>{passwordChecks[index] ? '✓' : '○'} {label}</li>)}</ul>
            </div>
            {field('Confirm password', confirmPassword, setConfirmPassword, 'password', 'new-password')}
            {view !== 'setup' && field(view === 'recover' ? 'Your recovery PIN' : 'Choose a recovery PIN (4–12 digits)', pin, setPin, 'password', 'off')}
            {view === 'bootstrap' && <label className="flex gap-3 text-sm text-neutral-400"><input type="checkbox" checked={savedPin} onChange={e => setSavedPin(e.target.checked)} disabled={busy} />I have kept this PIN privately. It cannot be retrieved later.</label>}
          </>}
          {error && <p role="alert" className="text-rose-400 text-sm">{error}</p>}
          {message && <p role="status" className="text-emerald-400 text-sm">{message}</p>}
          <button disabled={busy} className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-xl py-3 font-bold flex justify-center items-center gap-2"><Lock size={16} />{busy ? 'Saving…' : view === 'login' ? 'Sign in' : view === 'recover' ? 'Reset password' : 'Save account'}</button>
        </form>
        {view === 'login' && <button disabled={busy} onClick={() => switchView('recover')} className="text-sm text-emerald-400">Forgot password?</button>}
        {view === 'recover' && <button disabled={busy} onClick={() => switchView('login')} className="text-sm text-emerald-400">Back to sign in</button>}
        {view === 'setup' && <button disabled={busy} onClick={() => { switchView('login'); setPassword(''); }} className="text-sm text-neutral-400 underline">Back to sign in</button>}
        </>}
        <p className="text-xs text-neutral-500">Local POS access. Cloud synchronization requires a separately secured service.</p>
      </section>
    </main>
  );
}
