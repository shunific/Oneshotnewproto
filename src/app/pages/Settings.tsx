import { authRequest } from '../utils/localApi';
import { localFetch } from '../utils/localApi';
import { useState, useMemo, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import {
  User, Lock, Phone, Eye, EyeOff, Palette, Sun, Moon,
  Save, CheckCircle, Pencil, X, Calendar, Tag,
  AlertTriangle, BarChart2, CalendarCheck, 
  ShoppingCart, LayoutGrid, Clock, ShieldAlert, Upload
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { formatDistanceToNow } from 'date-fns';
import logoImg from 'figma:asset/40eb82831843e17a3c48a360fd80f0aaaa58ddc8.png';

type Section = 'overview' | 'profile' | 'appearance' | 'security';

const getPasswordStrength = (pw: string) => {
  if (!pw) return { score: 0, color: 'bg-neutral-800', isValid: false };
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (/[a-zA-Z]/.test(pw)) score += 1;
  if (/[0-9]/.test(pw)) score += 1;

  if (score === 1) return { score, color: 'bg-rose-500', isValid: false };
  if (score === 2) return { score, color: 'bg-amber-500', isValid: false };
  return { score, color: score === 3 && pw.length <= 256 ? 'bg-emerald-500' : 'bg-rose-500', isValid: score === 3 && pw.length <= 256 && pw !== 'oneshotstaff' };
};

// 🟢 NEW: Theme Palettes matching your inspiration image
const COLOR_PALETTES = [
  { id: 'emerald', name: 'Fresh Green',     hex: '#10B981', prm: 'bg-[#10B981]', sec: 'bg-[#064E3B]', acc: 'bg-[#34D399]' },
  { id: 'blue',    name: 'Modern SaaS',     hex: '#2563EB', prm: 'bg-[#2563EB]', sec: 'bg-[#1E3A8A]', acc: 'bg-[#60A5FA]' },
  { id: 'fintech', name: 'Fintech Blue',    hex: '#1D4ED8', prm: 'bg-[#1D4ED8]', sec: 'bg-[#172554]', acc: 'bg-[#3B82F6]' },
  { id: 'gold',    name: 'Luxury Dark',     hex: '#D4AF37', prm: 'bg-[#D4AF37]', sec: 'bg-[#423305]', acc: 'bg-[#FCD34D]' },
  { id: 'purple',  name: 'Creative Purple', hex: '#7C3AED', prm: 'bg-[#7C3AED]', sec: 'bg-[#4C1D95]', acc: 'bg-[#A78BFA]' },
];

export function SettingsPage() {
  const { staffProfile, updateStaffProfile, activities, changeOwnCredentials, verifyPassword, staffUsers, updateStaffUser, theme, updateTheme, primaryColor, updatePrimaryColor } = useAppContext();
  const navigate = useNavigate();

  const [activeSection, setActiveSection] = useState<Section>('overview');
  const [saved, setSaved] = useState<string | null>(null);
  
  const [avatarImg, setAvatarImg] = useState<string | null>(staffProfile.avatarImg || null);
  const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null); 

  const [profileEdit, setProfileEdit] = useState(false);
  const [profileForm, setProfileForm] = useState({ fullName: staffProfile.fullName, phone: staffProfile.phone, role: staffProfile.role });

  const [secEdit, setSecEdit] = useState(false);
  const [secForm, setSecForm] = useState({ username: staffProfile.username, currentPassword: '', newPassword: '', confirmPassword: '', newRecoveryPin: '' });
  const [showPw, setShowPw] = useState({ current: false, new: false, confirm: false });
  const [secError, setSecError] = useState('');
  const securityInFlight = useRef(false);
  const [isSavingSecurity, setIsSavingSecurity] = useState(false);

  const userActivities = useMemo(() => activities.filter((a: any) => a.metadata?.actorId === staffProfile.id), [activities, staffProfile.id]);

  const stats = useMemo(() => ({
    total: userActivities.length,
    reservations: userActivities.filter(a => a.type.includes('reservation')).length,
    posOrders: userActivities.filter(a => a.type === 'pos_order').length,
    tablesAssigned: userActivities.filter(a => a.type === 'table_assigned').length,
  }), [userActivities]);

  const pwStrength = getPasswordStrength(secForm.newPassword);

  const [toast, setToast] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  const toastTimeout = useRef<NodeJS.Timeout | null>(null);

  const flash = (msg: string, type: 'success' | 'error' = 'success') => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToast({ msg, type });
    toastTimeout.current = setTimeout(() => setToast(null), 5000); // 5 seconds
  };

  // 🟢 FIXED: Added strict validation checks before saving
  const handleSaveProfile = async () => {
    if (!profileForm.fullName.trim()) {
      flash("Full Name cannot be empty.", "error");
      return;
    }
    if (profileForm.phone.length !== 11) {
      flash("Phone number must be exactly 11 digits.", "error");
      return;
    }
    try {
      if (!staffProfile.id) throw new Error('Current account was not found');
      const changes = { fullName: profileForm.fullName.trim(), phone: profileForm.phone };
      await updateStaffUser(staffProfile.id, changes);
      updateStaffProfile(changes);
      setProfileEdit(false);
      flash("Profile changes saved!", "success");
    } catch {
      flash("Failed to save profile changes. Please try again.", "error");
    }
  };

  const handleSaveAvatar = async () => {
    if (!pendingFile) return;
    flash("Uploading profile picture...", "success");
    try {
      const formData = new FormData();
      formData.append('image', pendingFile);

      const res = await localFetch('http://localhost:3001/api/images', { method: 'POST', body: formData });
      if (!res.ok) throw new Error('Failed to upload image');
      const data = await res.json();

      if (!staffProfile.id) throw new Error('Current account was not found');
      await updateStaffUser(staffProfile.id, { avatarImg: data.url });
      updateStaffProfile({ avatarImg: data.url });
      setAvatarImg(data.url);

      setPendingAvatar(null); setPendingFile(null);
      flash("Profile picture updated!", "success");
    } catch (error) {
      flash("Failed to update profile picture.", "error");
    }
  };

  const handleSaveSecurity = async () => {
    if (securityInFlight.current) return;
    setSecError('');
    if (!secForm.currentPassword) { setSecError('Enter your current password to confirm changes.'); return; }
    
    if (secForm.newRecoveryPin && !/^\d{4,12}$/.test(secForm.newRecoveryPin)) { setSecError('Recovery PIN must contain 4–12 digits.'); return; }
    securityInFlight.current = true;
    setIsSavingSecurity(true);
    let passwordSaved = false;
    let pinSaved = false;
    try {
      if (!staffProfile.id) throw new Error('Current account was not found');
      if (secForm.newPassword) {
        if (!pwStrength.isValid) { setSecError('New password does not meet security requirements.'); return; }
        if (secForm.newPassword !== secForm.confirmPassword) { setSecError('New passwords do not match.'); return; }
        if (secForm.newPassword === secForm.currentPassword) { setSecError('Choose a different password from your current password.'); return; }
      }

      if (secForm.newPassword) {
        await changeOwnCredentials({ currentPassword: secForm.currentPassword, newPassword: secForm.newPassword, recoveryPin: secForm.newRecoveryPin || undefined });
        passwordSaved = true;
        pinSaved = Boolean(secForm.newRecoveryPin);
      } else if (secForm.newRecoveryPin) {
        await authRequest('change-pin', { currentPassword: secForm.currentPassword, recoveryPin: secForm.newRecoveryPin });
        pinSaved = true;
      } else if (!await verifyPassword(secForm.currentPassword)) { setSecError('Current password is incorrect.'); return; }
      if (secForm.username && secForm.username !== staffProfile.username) {
        const result = await authRequest('change-username', { username: secForm.username, currentPassword: secForm.newPassword || secForm.currentPassword });
        updateStaffProfile(result.user);
      }
      setSecEdit(false);
      setSecForm(f => ({ ...f, currentPassword: '', newPassword: '', confirmPassword: '', newRecoveryPin: '' }));
      flash("Security credentials saved!", "success");
    } catch {
      if (passwordSaved || pinSaved) {
        setSecForm(f => ({ ...f, currentPassword: passwordSaved ? secForm.newPassword : f.currentPassword, newPassword: passwordSaved ? '' : f.newPassword, confirmPassword: passwordSaved ? '' : f.confirmPassword, newRecoveryPin: pinSaved ? '' : f.newRecoveryPin }));
        setSecError('Your password or PIN was saved, but the username change failed. Review the username and try again.');
      } else setSecError('Failed to save security credentials. Please try again.');
    } finally {
      securityInFlight.current = false;
      setIsSavingSecurity(false);
    }
  };

  const handleSetNewPin = () => {
    setSecEdit(true);
    setSecError('');
    setSecForm(f => ({ ...f, username: staffProfile.username }));
  };

  const tabs: { id: Section; label: string; icon: React.ElementType }[] = [
    { id: 'overview',   label: 'Overview',   icon: BarChart2 },
    { id: 'profile',    label: 'Profile',    icon: User },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'security',   label: 'Security',   icon: Lock },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      {/* 🟢 TOP-RIGHT FLOATING TOAST WITH 5S TIMER & FADE OUT */}
      {toast && (
        <div 
          className="fixed top-6 right-6 z-[9999] animate-in slide-in-from-top-4 fade-in duration-300"
          style={{ animation: 'toast-fade-out 5s forwards' }}
        >
          <div className={`relative overflow-hidden flex items-start gap-3 px-5 py-4 rounded-xl border shadow-2xl backdrop-blur-md min-w-[320px] max-w-md ${
            toast.type === 'success' 
              ? 'bg-emerald-950/90 border-emerald-900/50 text-emerald-400' 
              : 'bg-rose-950/90 border-rose-900/50 text-rose-400'
          }`}>
            <div className="mt-0.5 flex-shrink-0">
              {toast.type === 'success' ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
            </div>
            <span className="text-sm font-semibold leading-snug whitespace-pre-wrap pr-4">{toast.msg}</span>
            <button 
              onClick={() => { setToast(null); if (toastTimeout.current) clearTimeout(toastTimeout.current); }} 
              className="absolute top-4 right-4 text-neutral-500 hover:text-white transition-colors"
            >
              <X size={14} />
            </button>
            <div 
              className={`absolute bottom-0 left-0 h-1 ${toast.type === 'success' ? 'bg-emerald-500' : 'bg-rose-500'}`}
              style={{ animation: 'toast-shrink 5s linear forwards' }}
            />
          </div>
          <style>{`
            @keyframes toast-shrink {
              0% { width: 100%; }
              100% { width: 0%; }
            }
            @keyframes toast-fade-out {
              0%, 90% { opacity: 1; transform: translateY(0); }
              100% { opacity: 0; transform: translateY(-10px); }
            }
          `}</style>
        </div>
      )}

      {/* HEADER */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-2xl p-6 flex items-center gap-5 shadow-sm">
        <div className="flex flex-col items-center gap-2">
          <div className="relative group w-20 h-20 rounded-2xl flex-shrink-0 overflow-hidden border border-neutral-800 bg-neutral-900">
            <img src={pendingAvatar || (avatarImg ? (avatarImg.startsWith('http') ? avatarImg : `http://localhost:3001${avatarImg}`) : logoImg)} onError={(e) => { e.currentTarget.src = logoImg; }} alt="Profile Avatar" className="w-full h-full object-cover" />
            <label className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center cursor-pointer transition-opacity">
              <input type="file" accept="image/*" className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) { setPendingFile(file); setPendingAvatar(URL.createObjectURL(file)); } }} />
              <Upload size={16} className="text-white mb-1" />
              <span className="text-[10px] text-white font-semibold">Change</span>
            </label>
          </div>
          {pendingAvatar && (
            <div className="flex gap-1.5">
              <button onClick={handleSaveAvatar} className="flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] px-2 py-1 rounded font-bold transition-all"><CheckCircle size={10} /> Save</button>
              <button onClick={() => { setPendingAvatar(null); setPendingFile(null); }} className="flex items-center gap-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-[10px] px-2 py-1 rounded font-bold transition-all"><X size={10} /> Cancel</button>
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-black text-neutral-100">{staffProfile.fullName}</h2>
          <p className="text-sm text-neutral-400 font-medium">{staffProfile.role} · @{staffProfile.username}</p>
        </div>
      </div>

      <div className="flex flex-wrap sm:flex-nowrap gap-1 bg-neutral-950 border border-neutral-800 rounded-xl p-1">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveSection(tab.id)} className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all ${activeSection === tab.id ? 'bg-emerald-600/15 text-emerald-400 border border-emerald-600/20' : 'text-neutral-500 hover:text-neutral-300'}`}>
            <tab.icon size={15} /> {tab.label}
          </button>
        ))}
      </div>

      {/* OVERVIEW */}
      {activeSection === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
             {[{ label: 'Total Actions', val: stats.total, icon: BarChart2, color: 'text-emerald-500' }, { label: 'Bookings', val: stats.reservations, icon: CalendarCheck, color: 'text-blue-500' }, { label: 'POS Orders', val: stats.posOrders, icon: ShoppingCart, color: 'text-amber-500' }, { label: 'Tables Seated', val: stats.tablesAssigned, icon: LayoutGrid, color: 'text-purple-500' }].map((s, i) => (
               <div key={i} className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 flex flex-col justify-between">
                 <div className="flex justify-between items-start mb-2"><p className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold">{s.label}</p><s.icon size={14} className={s.color} /></div>
                 <p className="text-3xl font-black text-white">{s.val}</p>
               </div>
             ))}
          </div>
          
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl overflow-hidden p-6">
            <h3 className="text-sm font-bold text-neutral-100 mb-4 flex items-center gap-2"><Clock size={16} className="text-emerald-500" /> Your Recent Activity</h3>
            <div className="space-y-3">
              {userActivities.length === 0 ? <p className="text-xs text-neutral-500 italic">No recent activity found.</p> : userActivities.slice(0, 5).map(act => (
                <div key={act.id} className="flex items-start gap-3 p-3 bg-neutral-900 border border-neutral-800/60 rounded-xl hover:border-neutral-700 transition-colors">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 mt-1.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-neutral-300 font-medium mb-1">{act.description.replace(/\s*\(Action by:.*?\)/, '')}</p>
                    <div className="flex items-center gap-2 text-[10px] text-neutral-500">
                      <span className="uppercase tracking-wider font-bold bg-neutral-800 px-1.5 py-0.5 rounded border border-neutral-700">{act.type.replace('_', ' ')}</span>
                      <span>{formatDistanceToNow(new Date(act.timestamp), { addSuffix: true })}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* PROFILE */}
      {activeSection === 'profile' && (
        <div className="bg-neutral-950 border border-neutral-800 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between">
            <div><h3 className="text-sm font-bold text-neutral-100">Personal Information</h3><p className="text-xs text-neutral-500 mt-0.5">Your display name, contact, and role details</p></div>
            {!profileEdit ? <button onClick={() => { setProfileEdit(true); setProfileForm({ fullName: staffProfile.fullName, phone: staffProfile.phone, role: staffProfile.role }); }} className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200 bg-neutral-800 border border-neutral-700 px-3 py-1.5 rounded-lg"><Pencil size={12} /> Edit</button> : <button onClick={() => setProfileEdit(false)} className="flex items-center gap-1.5 text-xs text-neutral-500 px-3 py-1.5 rounded-lg"><X size={12} /> Cancel</button>}
          </div>
          <div className="p-6 space-y-4">
            {/* 🟢 FIXED: Full Name input with strict regex (no symbols), 50 chars max, and live counter */}
            <FieldRow 
              icon={User} 
              label="Full Name" 
              value={staffProfile.fullName} 
              editing={profileEdit} 
              input={
                <div className="space-y-1">
                  <input 
                    type="text" 
                    value={profileForm.fullName} 
                    maxLength={50}
                    onChange={e => {
                      const cleanName = e.target.value.replace(/[^a-zA-Z\s]/g, '').slice(0, 50);
                      setProfileForm(f => ({ ...f, fullName: cleanName }));
                    }} 
                    placeholder="Letters and spaces only" 
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-emerald-600/50" 
                  />
                  <div className="flex justify-between items-center text-[10px] text-neutral-500">
                    <span>Letters and spaces only (no symbols)</span>
                    <span className={profileForm.fullName.length === 50 ? 'text-amber-400 font-bold' : ''}>
                      {profileForm.fullName.length}/50
                    </span>
                  </div>
                </div>
              } 
            />
            {/* 🟢 FIXED: Phone Number input with digits only, 11 digits max, and live counter */}
            <FieldRow 
              icon={Phone} 
              label="Phone Number" 
              value={staffProfile.phone} 
              editing={profileEdit} 
              input={
                <div className="space-y-1">
                  <input 
                    type="tel" 
                    value={profileForm.phone} 
                    maxLength={11}
                    onChange={e => {
                      const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, 11);
                      setProfileForm(f => ({ ...f, phone: digitsOnly }));
                    }} 
                    placeholder="e.g. 09171234567" 
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-emerald-600/50" 
                  />
                  <div className="flex justify-between items-center text-[10px] text-neutral-500">
                    <span>Must be exactly 11 numeric digits</span>
                    <span className={profileForm.phone.length === 11 ? 'text-emerald-400 font-bold' : 'text-amber-400'}>
                      {profileForm.phone.length}/11
                    </span>
                  </div>
                </div>
              } 
            />
            <FieldRow icon={Tag} label="Role / Position" value={staffProfile.role} editing={false} input={null} />
            <FieldRow icon={Calendar} label="Date Joined" value={new Date(staffProfile.joinedDate).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })} editing={false} input={null} />
            {profileEdit && (
              <div className="pt-2 flex items-center justify-between">
                <p className="text-[10px] text-amber-500/80 italic">* Role updates must be requested from the Administrator.</p>
                <button onClick={handleSaveProfile} className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm rounded-xl font-semibold"><Save size={14} /> Save Changes</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* APPEARANCE */}
      {activeSection === 'appearance' && (
        <div className="bg-neutral-950 border border-neutral-800 rounded-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-2">
          <div className="px-6 py-5 border-b border-neutral-800">
            <h3 className="text-sm font-bold text-neutral-100">Application Theme</h3>
            <p className="text-xs text-neutral-500 mt-0.5">Customize how the local POS system looks on this device.</p>
          </div>
          
          <div className="p-6 space-y-8">
            <div>
              <p className="text-xs text-neutral-400 font-bold uppercase tracking-wider mb-3">Base Mode</p>
              <div className="grid grid-cols-2 gap-4 max-w-md">
                <button onClick={() => updateTheme('dark')} className={`flex items-center justify-center gap-3 p-3.5 rounded-xl border-2 transition-all ${theme === 'dark' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400 shadow-md' : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-700'}`}>
                  <Moon size={18} /> <span className="font-semibold text-sm">Dark</span>
                </button>
                <button onClick={() => updateTheme('light')} className={`flex items-center justify-center gap-3 p-3.5 rounded-xl border-2 transition-all ${theme === 'light' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 shadow-md' : 'border-neutral-800 bg-white text-neutral-800 hover:border-neutral-700'}`}>
                  <Sun size={18} /> <span className="font-semibold text-sm">Light</span>
                </button>
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-3">
                <p className="text-xs text-neutral-400 font-bold uppercase tracking-wider">Color Palettes</p>
                <span className="text-[10px] text-neutral-500 font-medium bg-neutral-900 border border-neutral-800 px-2 py-0.5 rounded-md">{COLOR_PALETTES.length} themes</span>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {COLOR_PALETTES.map(p => {
                  const isActive = primaryColor === p.id;
                  return (
                    <div 
                      key={p.id} 
                      onClick={() => updatePrimaryColor(p.id)} 
                      className={`flex flex-col p-4 rounded-2xl border-2 cursor-pointer transition-all ${isActive ? 'border-emerald-500 bg-emerald-500/5 shadow-lg shadow-emerald-900/10' : 'border-neutral-800 bg-neutral-900 hover:bg-neutral-800/80 hover:border-neutral-700'}`}
                    >
                      <div className="flex justify-between items-center mb-4">
                        <span className={`text-sm font-bold flex items-center gap-2 ${isActive ? 'text-emerald-400' : 'text-neutral-200'}`}>
                          {p.name}
                          {isActive && <CheckCircle size={14} className="text-emerald-500" />}
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-1 rounded-lg ${isActive ? 'bg-emerald-500 text-white' : 'bg-neutral-800 text-neutral-400'}`}>
                          {p.hex}
                        </span>
                      </div>
                      
                      <div className="flex gap-2 h-10 w-full">
                        <div className="flex-1 rounded-lg bg-neutral-950 border border-neutral-800 flex items-end justify-center pb-1"><span className="text-[8px] text-neutral-600 font-bold uppercase tracking-widest">BG</span></div>
                        <div className={`flex-1 rounded-lg ${p.prm} flex items-end justify-center pb-1`}><span className="text-[8px] text-white/70 font-bold uppercase tracking-widest">Prm</span></div>
                        <div className={`flex-1 rounded-lg ${p.sec} flex items-end justify-center pb-1`}><span className="text-[8px] text-white/50 font-bold uppercase tracking-widest">Sec</span></div>
                        <div className={`flex-1 rounded-lg ${p.acc} flex items-end justify-center pb-1`}><span className="text-[8px] text-black/50 font-bold uppercase tracking-widest">Acc</span></div>
                        <div className="flex-1 rounded-lg bg-white border border-neutral-300 flex items-end justify-center pb-1"><span className="text-[8px] text-neutral-400 font-bold uppercase tracking-widest">Txt</span></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            
            <div className="bg-neutral-900 border border-neutral-800 p-4 rounded-xl flex items-start gap-3">
              <Palette size={16} className="text-emerald-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-neutral-400 leading-relaxed">
                Changes made here only apply to this local device. Customer-facing online bookings and other staff terminals will not be affected.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* SECURITY */}
      {activeSection === 'security' && (
        <div className="space-y-6 animate-in fade-in duration-300">
          <div className="bg-neutral-950 border border-neutral-800 rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between">
              <div><h3 className="text-sm font-bold text-neutral-100">Login Credentials</h3><p className="text-xs text-neutral-500 mt-0.5">Manage your username, password and recovery PIN</p></div>
              {!secEdit ? <button onClick={() => { setSecEdit(true); setSecError(''); setSecForm(f => ({ ...f, username: staffProfile.username })); }} className="flex items-center gap-1.5 text-xs text-neutral-400 bg-neutral-800 border border-neutral-700 px-3 py-1.5 rounded-lg"><Pencil size={12} /> Edit</button> : <button onClick={() => { setSecEdit(false); setSecError(''); }} className="flex items-center gap-1.5 text-xs text-neutral-500 px-3 py-1.5 rounded-lg"><X size={12} /> Cancel</button>}
            </div>
            <div className="p-6 space-y-4">
              <div className="flex items-start gap-4">
                <div className="w-9 h-9 rounded-xl bg-neutral-800 border border-neutral-700 flex items-center justify-center mt-1"><User size={16} className="text-neutral-400" /></div>
                <div className="flex-1">
                  <p className="text-xs text-neutral-500 mb-1.5 font-medium uppercase tracking-wider">Username</p>
                  {secEdit ? <input type="text" value={secForm.username} onChange={e => setSecForm(f => ({ ...f, username: e.target.value }))} className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-emerald-600/50" /> : <p className="text-sm text-neutral-200 font-semibold">@{staffProfile.username}</p>}
                </div>
              </div>

              {secEdit && (
                <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-3 mt-2">
                  <p className="text-xs text-neutral-500 uppercase tracking-widest font-semibold">Change Password or Recovery PIN</p>
                  
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1.5">Current Password <span className="text-rose-500">*</span></label>
                    <div className="relative">
                      <input type={showPw.current ? 'text' : 'password'} value={secForm.currentPassword} onChange={e => setSecForm(f => ({ ...f, currentPassword: e.target.value }))} placeholder="Your current password" className="w-full bg-neutral-800 border border-neutral-700 rounded-xl px-3 pr-10 py-2 text-sm text-neutral-100" />
                      <button type="button" tabIndex={-1} onClick={() => setShowPw(s => ({ ...s, current: !s.current }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300">{showPw.current ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-neutral-400 mb-1.5">New Password</label>
                    <div className="relative">
                      <input type={showPw.new ? 'text' : 'password'} value={secForm.newPassword} onChange={e => setSecForm(f => ({ ...f, newPassword: e.target.value }))} placeholder="Leave blank to keep current" className="w-full bg-neutral-800 border border-neutral-700 rounded-xl px-3 pr-10 py-2 text-sm text-neutral-100" />
                      <button type="button" tabIndex={-1} onClick={() => setShowPw(s => ({ ...s, new: !s.new }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300">{showPw.new ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                    </div>
                    {secForm.newPassword && (
                      <div className="mt-2 space-y-1">
                        <div className="flex gap-1 h-1.5 w-full rounded-full overflow-hidden bg-neutral-800/50">
                          <div className={`h-full ${pwStrength.score >= 1 ? pwStrength.color : 'bg-transparent'} transition-all w-1/3`} />
                          <div className={`h-full ${pwStrength.score >= 2 ? pwStrength.color : 'bg-transparent'} transition-all w-1/3`} />
                          <div className={`h-full ${pwStrength.score >= 3 ? pwStrength.color : 'bg-transparent'} transition-all w-1/3`} />
                        </div>
                        <p className={`text-[10px] ${pwStrength.isValid ? 'text-emerald-500' : 'text-neutral-500'}`}>Requires 8–256 characters, letters, and numbers.</p>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs text-neutral-400 mb-1.5">Confirm New Password</label>
                    <div className="relative">
                      <input type={showPw.confirm ? 'text' : 'password'} value={secForm.confirmPassword} onChange={e => setSecForm(f => ({ ...f, confirmPassword: e.target.value }))} placeholder="Re-enter new password" className="w-full bg-neutral-800 border border-neutral-700 rounded-xl px-3 pr-10 py-2 text-sm text-neutral-100" />
                      <button type="button" tabIndex={-1} onClick={() => setShowPw(s => ({ ...s, confirm: !s.confirm }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500">{showPw.confirm ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="new-recovery-pin" className="block text-xs text-neutral-400 mb-1.5">New Recovery PIN (optional)</label>
                    <input id="new-recovery-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12} value={secForm.newRecoveryPin} onChange={e => setSecForm(f => ({ ...f, newRecoveryPin: e.target.value.replace(/\D/g, '').slice(0, 12) }))} placeholder="Leave blank to keep your current PIN" className="w-full bg-neutral-800 border border-neutral-700 rounded-xl px-3 py-2 text-sm text-neutral-100" />
                    <p className="mt-1.5 text-[10px] text-neutral-500">Use 4–12 digits. Keep your PIN private in a secure place; it cannot be retrieved after saving.</p>
                  </div>
                  {secError && <div className="flex items-center gap-2 bg-rose-950/50 border border-rose-800/40 text-rose-400 text-xs px-3 py-2.5 rounded-xl"><AlertTriangle size={13} className="flex-shrink-0" />{secError}</div>}
                </div>
              )}
              {secEdit && (
                <div className="pt-1 flex justify-end">
                  <button onClick={handleSaveSecurity} disabled={isSavingSecurity || (secForm.newPassword ? !pwStrength.isValid : false) || (!!secForm.newRecoveryPin && !/^\d{4,12}$/.test(secForm.newRecoveryPin))} className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white text-sm rounded-xl font-semibold"><Save size={14} /> {isSavingSecurity ? 'Saving...' : 'Save Credentials'}</button>
                </div>
              )}
            </div>
          </div>

          {/* 🟢 NEW: Offline Recovery PIN Backup Box */}
          <div className="bg-neutral-950 border border-amber-900/40 rounded-2xl overflow-hidden shadow-lg shadow-amber-900/5">
            <div className="px-6 py-4 border-b border-amber-900/40 flex items-center gap-3 bg-amber-500/5">
              <ShieldAlert size={18} className="text-amber-500" />
              <div>
                <h3 className="text-sm font-bold text-amber-500">Offline Recovery Credential</h3>
                <p className="text-xs text-amber-500/70 mt-0.5">Your emergency access PIN</p>
              </div>
            </div>
            <div className="p-6">
              <p className="text-xs text-neutral-400 leading-relaxed mb-5">
                Your recovery PIN lets you reset a forgotten password while offline. The saved PIN cannot be retrieved or downloaded. To replace it, enter your current password and a new PIN in Login Credentials. Keep the new PIN private in a secure place.
              </p>
              <button 
                onClick={handleSetNewPin}
                className="flex items-center gap-2 px-5 py-3 bg-amber-600/10 hover:bg-amber-600/20 text-amber-500 border border-amber-600/30 rounded-xl text-sm font-bold transition-all"
              >
                <Lock size={16} /> Set a New Recovery PIN
              </button>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}

function FieldRow({ icon: Icon, label, value, editing, input }: { icon: React.ElementType; label: string; value: string; editing: boolean; input: React.ReactNode; }) {
  return (
    <div className="flex items-start gap-4">
      <div className="w-9 h-9 rounded-xl bg-neutral-800 border border-neutral-700 flex items-center justify-center mt-1"><Icon size={16} className="text-neutral-400" /></div>
      <div className="flex-1">
        <p className="text-xs text-neutral-500 mb-1.5 font-medium uppercase tracking-wider">{label}</p>
        {editing && input ? input : <p className="text-sm text-neutral-200 font-semibold">{value || '—'}</p>}
      </div>
    </div>
  );
}