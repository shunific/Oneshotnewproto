import { useState } from 'react';
import { ShieldCheck, Copy, Download, CheckCircle } from 'lucide-react';
import { useAppContext } from '../context/AppContext';

export function FirstTimeLoginModal({ onComplete }: { onComplete: () => void }) {
  const { staffProfile, updateStaffUser } = useAppContext();
  const [pin] = useState(() => Math.floor(1000 + Math.random() * 9000).toString());
  const [actionsDone, setActionsDone] = useState({ copy: false, download: false });

  const handleCopy = () => {
    navigator.clipboard.writeText(pin);
    setActionsDone(prev => ({ ...prev, copy: true }));
  };

  const handleDownload = () => {
    const element = document.createElement("a");
    const file = new Blob([`One Shot Bar - Recovery PIN for ${staffProfile.username}: ${pin}`], {type: 'text/plain'});
    element.href = URL.createObjectURL(file);
    element.download = "OneShot_Recovery_PIN.txt";
    document.body.appendChild(element);
    element.click();
    setActionsDone(prev => ({ ...prev, download: true }));
  };

  const handleConfirm = () => {
    // Save PIN and disable first-time-login flag
    updateStaffUser(staffProfile.username, { recoveryPin: pin, isFirstLogin: 0 } as any);
    onComplete();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-neutral-950 border border-emerald-900/30 rounded-2xl w-full max-w-sm p-6 shadow-2xl">
        <ShieldCheck className="text-emerald-500 mx-auto mb-4" size={40} />
        <h2 className="text-lg font-bold text-white text-center mb-2">Secure Setup Required</h2>
        <p className="text-xs text-neutral-400 text-center mb-6">
          This is your only chance to save your Recovery PIN. If you lose this, you will be locked out of your account if you forget your password.
        </p>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 text-center mb-6">
          <p className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2">Your Recovery PIN</p>
          <p className="text-3xl font-mono font-bold text-emerald-400 tracking-[0.5em]">{pin}</p>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-6">
          <button onClick={handleCopy} className="flex flex-col items-center gap-2 p-3 bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 rounded-xl transition-all">
            <Copy size={18} className={actionsDone.copy ? "text-emerald-400" : "text-neutral-400"} />
            <span className="text-[10px] font-bold text-neutral-300">Copy</span>
          </button>
          <button onClick={handleDownload} className="flex flex-col items-center gap-2 p-3 bg-neutral-900 hover:bg-neutral-800 border border-neutral-700 rounded-xl transition-all">
            <Download size={18} className={actionsDone.download ? "text-emerald-400" : "text-neutral-400"} />
            <span className="text-[10px] font-bold text-neutral-300">Download</span>
          </button>
        </div>

        <button 
          disabled={!actionsDone.copy && !actionsDone.download}
          onClick={handleConfirm}
          className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-600 text-white font-bold py-3 rounded-xl transition-all"
        >
          I have saved my PIN
        </button>
      </div>
    </div>
  );
}