import { useRef, useState } from 'react';
import type { StaffUser } from '../context/AppContext';

type Employee = Pick<StaffUser, 'id' | 'username' | 'fullName' | 'phone' | 'role'>;
type ProfilePatch = { fullName: string; phone: string; role?: StaffUser['role'] };

export function EmployeeProfileEditor({ employee, currentUserId, save, onSaved, onCancel }: {
  employee: Employee;
  currentUserId: string;
  save: (id: string, patch: ProfilePatch) => Promise<void>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [fullName, setFullName] = useState(employee.fullName);
  const [phone, setPhone] = useState(employee.phone || '');
  const [role, setRole] = useState(employee.role);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const protectedRole = employee.id === currentUserId || employee.id === 'admin_001' || employee.username.toLowerCase() === 'superadmin';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    if (!fullName.trim()) { setError('Enter the employee’s full name.'); return; }
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      await save(employee.id, { fullName: fullName.trim(), phone: phone.trim(), ...(protectedRole ? {} : { role }) });
      onSaved();
    } catch {
      setError('Employee changes were not saved. Your entries are preserved; please retry.');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
    <section role="dialog" aria-modal="true" aria-labelledby="employee-edit-title" className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-950 p-6 text-neutral-200 shadow-2xl">
      <h2 id="employee-edit-title" className="text-base font-bold">Edit employee</h2>
      <p className="mt-1 text-xs text-neutral-400">@{employee.username} · Login credentials and administrator privileges stay unchanged.</p>
      <form onSubmit={submit} className="mt-5 space-y-4">
        {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
        <label className="block text-sm">Full name
          <input aria-label="Employee full name" autoFocus required maxLength={200} value={fullName} disabled={saving} onChange={event => setFullName(event.target.value)} className="mt-1 w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2.5" />
        </label>
        <label className="block text-sm">Phone
          <input aria-label="Employee phone" type="tel" maxLength={40} value={phone} disabled={saving} onChange={event => setPhone(event.target.value)} className="mt-1 w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2.5" />
        </label>
        <label className="block text-sm">Role
          <select aria-label="Employee role" value={role} disabled={saving || protectedRole} onChange={event => setRole(event.target.value as StaffUser['role'])} className="mt-1 w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2.5">
            <option value="cashier">Cashier</option><option value="manager">Manager</option>
          </select>
        </label>
        {protectedRole && <p className="text-xs text-neutral-400">Your own role and the Master Super Admin’s role are protected.</p>}
        <div className="flex gap-3 pt-2">
          <button type="button" disabled={saving} onClick={() => { if (!pending.current) onCancel(); }} className="rounded-xl bg-neutral-800 px-4 py-2.5 text-sm disabled:opacity-50">Cancel</button>
          <button type="submit" disabled={saving} className="flex-1 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save employee'}</button>
        </div>
      </form>
    </section>
  </div>;
}
