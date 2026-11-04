import { useRef, useState } from 'react';
import { User, Phone, CheckCircle, X } from 'lucide-react';
import type { StaffUser } from '../context/AppContext';

const ROLES: { value: StaffUser['role']; label: string; color: string; icon: React.ReactNode }[] = [
  { value: 'manager', label: 'Manager', color: 'bg-amber-500/10 text-amber-400 border-amber-500/20', icon: <User size={11} /> },
  { value: 'cashier', label: 'Cashier', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', icon: <User size={11} /> },
];

type Employee = Pick<StaffUser, 'id' | 'username' | 'fullName' | 'phone' | 'role'>;
type ProfilePatch = { fullName: string; phone: string; role?: StaffUser['role'] };

export function EmployeeProfileEditor({ employee, currentUserId, save, onSaved, onCancel }: {
  employee: Employee;
  currentUserId: string;
  save: (id: string, patch: ProfilePatch) => Promise<void> | void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [fullName, setFullName] = useState(employee.fullName || '');
  const [phone, setPhone] = useState(employee.phone || '');
  const [role, setRole] = useState<StaffUser['role']>(employee.role || 'cashier');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);

  const protectedRole = employee.id === currentUserId || employee.id === 'admin_001' || employee.username?.toLowerCase() === 'superadmin';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    if (!fullName.trim()) {
      setError('Enter the employee’s full name.');
      return;
    }
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      await save(employee.id, {
        fullName: fullName.trim(),
        phone: phone.trim(),
        ...(protectedRole ? {} : { role }),
      });
      onSaved();
    } catch {
      setError('Employee changes were not saved. Please try again.');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-neutral-950 border border-amber-900/30 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-800 flex justify-between items-center flex-none">
          <div>
            <h2 className="text-base font-bold text-neutral-100">Edit Employee</h2>
            <p className="text-xs text-neutral-500">@{employee.username} · Update profile details</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="p-2 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={submit} className="overflow-y-auto flex-1 p-6 space-y-4">
          {error && (
            <div className="bg-rose-950/40 border border-rose-800/50 text-rose-400 text-xs px-3.5 py-2.5 rounded-xl">
              {error}
            </div>
          )}

          {/* Full Name */}
          <div>
            <label className="text-xs text-neutral-400 mb-1.5 block font-medium">Full Name *</label>
            <input
              type="text"
              maxLength={50}
              value={fullName}
              disabled={saving}
              onChange={e => setFullName(e.target.value)}
              required
              autoFocus
              className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:border-amber-600/50 transition-colors"
              placeholder="e.g. Juan dela Cruz (max 50 chars)"
            />
            <div className="flex justify-end mt-1">
              <span className="text-[10px] text-neutral-500 font-mono">{fullName.length}/50</span>
            </div>
          </div>

          {/* Phone */}
          <div>
            <label className="text-xs text-neutral-400 mb-1.5 block font-medium">Phone</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">
                <Phone size={14} />
              </span>
              <input
                type="tel"
                maxLength={13}
                value={phone}
                disabled={saving}
                onChange={e => setPhone(e.target.value.replace(/[^\d+]/g, '').slice(0, 13))}
                className="w-full bg-neutral-900 border border-neutral-800 rounded-xl pl-9 pr-3 py-2.5 text-sm text-neutral-200 focus:outline-none focus:border-amber-600/50 transition-colors"
                placeholder="e.g. 09123456789"
              />
            </div>
          </div>

          {/* Role Picker */}
          <div>
            <label className="text-xs text-neutral-400 mb-2 block font-medium">Role *</label>
            <div className="flex flex-col gap-2">
              {ROLES.map(r => {
                const isSelected = role === r.value;
                return (
                  <button
                    key={r.value}
                    type="button"
                    disabled={saving || protectedRole}
                    onClick={() => setRole(r.value)}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-semibold transition-all duration-200 ${
                      protectedRole
                        ? 'opacity-60 cursor-not-allowed bg-neutral-900 border-neutral-800 text-neutral-500'
                        : isSelected
                        ? `${r.color} ring-1 ring-amber-500/50 shadow-sm`
                        : 'bg-neutral-900 border-neutral-800 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300'
                    }`}
                  >
                    <div className={`flex items-center justify-center w-8 h-8 rounded-lg ${isSelected ? 'bg-amber-500/20 text-amber-400' : 'bg-neutral-800 text-neutral-400'}`}>
                      {r.icon}
                    </div>
                    <span className="flex-1 text-left">{r.label}</span>
                    {isSelected && <CheckCircle size={16} />}
                  </button>
                );
              })}
            </div>
            {protectedRole && (
              <p className="text-[11px] text-neutral-500 mt-2">
                Protected role: Master Super Admin and logged-in roles cannot be demoted.
              </p>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              disabled={saving}
              onClick={onCancel}
              className="px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-amber-600 hover:bg-amber-500 text-white text-sm rounded-xl font-semibold transition-all py-2.5 flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-amber-900/30"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
