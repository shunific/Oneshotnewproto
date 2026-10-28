import { useState, useEffect, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import {
  Plus, X, Pencil, Table2, CheckCircle, AlertTriangle,
  PowerOff, Power, Wrench, MoreVertical, Users, Clock, Percent, ShieldAlert
} from 'lucide-react';

import { format } from 'date-fns';

const COMMON_MAINTENANCE_REASONS = [
  'Torn / Damaged Felt',
  'Cue / Cushion Repair Needed',
  'Table Leveling & Calibration',
  'Routine Cleaning / Sanitation',
  'Others (Specify below)'
];

export function AdminTableManagement() {
  const { tables, addTable, updateTable, updateTableState } = useAppContext() as any;

  const [newName, setNewName]               = useState('');
  const [showAddForm, setShowAddForm]       = useState(false);
  const [isSubmitting, setIsSubmitting]     = useState(false);

  const [editingId, setEditingId]           = useState<string | null>(null);
  const [editName, setEditName]             = useState('');
  const [toast, setToast]                   = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  // Dropdown menu state
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // Unified Deactivate / Maintenance Modal
  const [maintenanceModal, setMaintenanceModal] = useState<{
    tableId: string;
    tableName: string;
    targetActive: boolean;
  } | null>(null);
  const [selectedReason, setSelectedReason]   = useState<string>(COMMON_MAINTENANCE_REASONS[0]);
  const [customReason, setCustomReason]       = useState('');
  const [isConfirming, setIsConfirming]       = useState(false);

  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const [isLoading, setIsLoading]   = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('PROCESSING...');

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpenDropdownId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const flash = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    const trimmedName = newName.trim();
    if (!trimmedName) return;

    const isDuplicate = tables.some(
      (t: any) => t.name.trim().toLowerCase() === trimmedName.toLowerCase()
    );
    if (isDuplicate) {
      flash(`A table named "${trimmedName}" already exists.`, 'error');
      return;
    }

    setIsSubmitting(true);
    setLoadingMsg('ADDING NEW TABLE...');
    setIsLoading(true);
    try {
      await addTable(trimmedName);
      setNewName('');
      setShowAddForm(false);
      flash(`Table "${trimmedName}" added!`);
    } catch (error: any) {
      flash(error.message || 'Table could not be added.', 'error');
    } finally {
      setIsSubmitting(false);
      setIsLoading(false);
    }
  };

  const handleUpdateName = async (id: string) => {
    if (isLoading) return;
    const trimmedName = editName.trim();
    if (!trimmedName) return;
    if (tables.some((table: any) => table.id !== id && table.name.trim().toLowerCase() === trimmedName.toLowerCase())) {
      flash(`A table named "${trimmedName}" already exists.`, 'error');
      return;
    }
    setIsLoading(true);
    setLoadingMsg('RENAMING TABLE...');
    try {
      await updateTable(id, trimmedName);
      setEditingId(null);
      flash('Table renamed successfully.');
    } catch (error: any) {
      flash(error.message || 'Table could not be renamed.', 'error');
    } finally { setIsLoading(false); }
  };

  const handleConfirmMaintenance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!maintenanceModal || isConfirming) return;
    const finalReason = selectedReason === 'Others (Specify below)' ? customReason.trim() : selectedReason;
    if (!finalReason) { flash('Please specify a maintenance reason.', 'error'); return; }
    const table = tables.find((table: any) => table.id === maintenanceModal.tableId);
    if (!table || table.session || table.status === 'occupied') {
      flash('End the active session in the Staff Table Monitor, using checkout or the authorized session-void action, before maintenance.', 'error');
      return;
    }
    setIsConfirming(true);
    setLoadingMsg('UPDATING TABLE STATUS...');
    setIsLoading(true);
    try {
      await updateTableState(table.id, { status: 'maintenance', maintenanceReason: finalReason, isActive: maintenanceModal.targetActive });
      setMaintenanceModal(null);
      setCustomReason('');
      flash(`"${maintenanceModal.tableName}" has been set to maintenance: ${finalReason}`);
    } catch (error: any) {
      flash(error.message || 'Table status could not be saved.', 'error');
    } finally { setIsConfirming(false); setIsLoading(false); }
  };

  const handleReactivateTable = async (table: any) => {
    setOpenDropdownId(null);
    if (table.session || table.status === 'occupied') {
      flash('End the active session in the Staff Table Monitor before reactivating this table.', 'error');
      return;
    }
    setLoadingMsg('REACTIVATING TABLE...');
    setIsLoading(true);
    try {
      await updateTableState(table.id, { status: 'available', session: null, maintenanceReason: '', isActive: true });
      flash(`"${table.name}" is now active and available for guests.`);
    } catch (error: any) {
      flash(error.message || 'Table could not be reactivated.', 'error');
    } finally { setIsLoading(false); }
  };

  const handleForceClear = async (table: any) => {
    setOpenDropdownId(null);
    if (table.session || table.status === 'occupied') {
      flash('End this session in the Staff Table Monitor using checkout or the authorized session-void action. Its history must be preserved.', 'error');
      return;
    }
    setLoadingMsg('RESETTING EMPTY TABLE...');
    setIsLoading(true);
    try {
      await updateTableState(table.id, { status: 'available', session: null, maintenanceReason: null });
      flash(`"${table.name}" reset to available.`);
    } catch (error: any) {
      flash(error.message || 'Empty table could not be reset.', 'error');
    } finally { setIsLoading(false); }
  };

  const STATUS_COLOR: Record<string, string> = {
    available:   'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    occupied:    'bg-rose-500/10 text-rose-400 border-rose-500/20',
    reserved:    'bg-amber-500/10 text-amber-400 border-amber-500/20',
    maintenance: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
    event:       'bg-purple-500/10 text-purple-400 border-purple-500/20',
  };

  const activeCount   = (tables || []).filter((t: any) => t.isActive).length;
  const inactiveCount = (tables || []).filter((t: any) => !t.isActive || t.status === 'maintenance').length;
  const occupiedCount = (tables || []).filter((t: any) => t.status === 'occupied').length;
  
  // 🟢 NEW: Utilization Calculation
  const utilization = activeCount > 0 ? Math.round((occupiedCount / activeCount) * 100) : 0;

  const filtered = tables.filter((t: any) => {
    if (filter === 'active')   return t.isActive && t.status !== 'maintenance';
    if (filter === 'inactive') return !t.isActive || t.status === 'maintenance';
    return true;
  });

  return (
    <div className="relative space-y-6">
      {/* 🟢 FULL SCREEN SPINNER TO BLOCK INPUTS */}
      {isLoading && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-4 bg-neutral-950 p-8 rounded-2xl border border-neutral-800 shadow-2xl">
            <div className="w-12 h-12 border-4 border-sky-500/20 border-t-sky-500 rounded-full animate-spin"></div>
            <p className="text-xs font-bold text-sky-400 uppercase tracking-widest animate-pulse">
              {loadingMsg || "Syncing Changes..."}
            </p>
          </div>
        </div>
      )}

      {/* Header Info */}
      <div>
        <h2 className="text-2xl font-black text-neutral-100 tracking-tight">Table Management</h2>
        <p className="text-sm text-neutral-500 mt-1">Add, rename, and manage the physical status of billiard tables.</p>
      </div>

      {toast && (
        <div className={`flex items-center gap-2.5 text-sm px-4 py-3 rounded-xl border animate-in fade-in ${
          toast.type === 'error'
            ? 'bg-rose-950/40 border-rose-700/40 text-rose-400'
            : 'bg-emerald-950/40 border-emerald-700/40 text-emerald-400'
        }`}>
          {toast.type === 'error' ? <AlertTriangle size={15} /> : <CheckCircle size={15} />}
          {toast.msg}
        </div>
      )}

      {/* 🟢 UPGRADED: Enhanced Analytics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { label: 'Total Tables',     value: tables.length,  color: 'text-white',          icon: Table2 },
          { label: 'Utilization',      value: `${utilization}%`, color: 'text-blue-400',    icon: Percent },
          { label: 'Active',           value: activeCount,    color: 'text-emerald-400',    icon: CheckCircle },
          { label: 'Occupied Now',     value: occupiedCount,  color: 'text-rose-400',       icon: Users },
          { label: 'In Maintenance',   value: inactiveCount,  color: 'text-orange-400',     icon: Wrench },
        ].map(s => (
          <div key={s.label} className="bg-neutral-950 border border-neutral-800 rounded-xl p-4 flex flex-col justify-between">
            <div className="flex justify-between items-start mb-2">
              <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-semibold">{s.label}</p>
              <s.icon size={14} className={s.color} />
            </div>
            <p className={`text-2xl font-black ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Add New Table Control */}
      <div className="bg-neutral-950 border border-amber-900/30 rounded-xl overflow-hidden shadow-lg shadow-amber-900/5">
        {!showAddForm ? (
          <button
            onClick={() => setShowAddForm(true)}
            className="w-full px-5 py-4 flex items-center gap-2 text-amber-400 hover:text-amber-300 hover:bg-amber-950/20 transition-colors font-semibold text-sm"
          >
            <Plus size={16} /> Add New Table
          </button>
        ) : (
          <div className="p-5 bg-neutral-900/30">
            <h3 className="text-sm font-bold text-neutral-200 mb-4 flex items-center gap-2">
              <Plus size={16} className="text-amber-500" /> New Table Configuration
            </h3>
            <form onSubmit={handleAdd} className="space-y-4 max-w-lg">
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs text-neutral-400 font-medium">Table Name *</label>
                  <span className="text-[10px] text-neutral-500 font-mono">{newName.length}/15</span>
                </div>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  maxLength={15}
                  placeholder="e.g. Table 11, VIP 1 (max 15 chars)"
                  autoFocus
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-amber-600/50"
                />
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => { setShowAddForm(false); setNewName(''); }}
                  className="px-6 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-xl text-sm font-semibold transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!newName.trim() || isSubmitting}
                  className="flex-1 flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 disabled:bg-neutral-800 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-all shadow-md shadow-amber-900/20"
                >
                  {isSubmitting ? 'Saving...' : 'Add Table to System'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* Table Filters */}
      <div className="flex items-center gap-1.5 border-b border-neutral-800 pb-4">
        {(['all', 'active', 'inactive'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all capitalize ${
              filter === f
                ? 'bg-neutral-100 text-neutral-900'
                : 'bg-neutral-900 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300'
            }`}
          >
            {f === 'inactive' ? 'In Maintenance' : f}
          </button>
        ))}
      </div>

      {/* 🟢 UPGRADED: Rich Grid Layout for Tables */}
      {filtered.length === 0 ? (
        <div className="px-5 py-16 text-center border border-dashed border-neutral-800 rounded-2xl">
          <Table2 size={32} className="mx-auto text-neutral-700 mb-3" />
          <p className="text-sm text-neutral-400 font-medium">No tables match your filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {filtered.map((t: any) => {
            const isMaintenance = t.status === 'maintenance' || !t.isActive;
            const isOccupied = t.status === 'occupied' && t.session;

            return (
              <div
                key={t.id}
                className={`bg-neutral-950 border rounded-2xl p-5 flex flex-col relative transition-all ${
                  isMaintenance ? 'border-orange-900/30 opacity-80' : 
                  isOccupied ? 'border-rose-900/30 shadow-[0_0_15px_rgba(225,29,72,0.05)]' : 
                  'border-neutral-800 hover:border-neutral-700'
                }`}
              >
                {/* Card Header */}
                <div className="flex justify-between items-start mb-5">
                  <span className={`text-[10px] font-bold px-2.5 py-1 rounded border flex items-center gap-1.5 uppercase tracking-wider ${
                    STATUS_COLOR[t.status] || STATUS_COLOR.available
                  }`}>
                    {t.status === 'maintenance' && <Wrench size={11} />}
                    {isOccupied && <div className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />}
                    {t.status}
                  </span>

                  {/* Actions Dropdown Menu */}
                  {editingId !== t.id && (
                    <div className="relative flex-shrink-0" ref={openDropdownId === t.id ? dropdownRef : null}>
                      <button
                        onClick={() => setOpenDropdownId(openDropdownId === t.id ? null : t.id)}
                        className="p-1.5 rounded-lg bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-700 transition-colors"
                      >
                        <MoreVertical size={14} />
                      </button>

                      {openDropdownId === t.id && (
                        <div className="absolute right-0 top-full mt-2 w-48 bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl z-50 overflow-hidden py-1">
                          <button
                            onClick={() => {
                              setOpenDropdownId(null);
                              setEditingId(t.id);
                              setEditName(t.name);
                            }}
                            className="w-full px-4 py-2.5 text-left text-xs text-neutral-300 hover:bg-neutral-800 transition-colors flex items-center gap-2"
                          >
                            <Pencil size={13} className="text-amber-400" />
                            <span>Rename Table</span>
                          </button>

                          {/* 🟢 Reset Empty Table Action */}
                          {(t.status === 'occupied' || t.status === 'reserved' || t.status === 'event') && (
                            <button
                              onClick={() => handleForceClear(t)}
                              className="w-full px-4 py-2.5 text-left text-xs text-rose-400 hover:bg-rose-950/20 transition-colors flex items-center gap-2 border-t border-neutral-800/60"
                            >
                              <ShieldAlert size={13} />
                              <span>Reset Empty Table</span>
                            </button>
                          )}

                          {t.status !== 'maintenance' ? (
                            <button
                              onClick={() => {
                                setOpenDropdownId(null);
                                if (t.status === 'occupied') {
                                  flash('End the occupied session in the Staff Table Monitor using checkout or the authorized session-void action before maintenance.', 'error');
                                  return;
                                }
                                setMaintenanceModal({ tableId: t.id, tableName: t.name, targetActive: false });
                                setSelectedReason(COMMON_MAINTENANCE_REASONS[0]);
                                setCustomReason('');
                              }}
                              className="w-full px-4 py-2.5 text-left text-xs text-orange-400 hover:bg-orange-950/20 transition-colors flex items-center gap-2 border-t border-neutral-800/60"
                            >
                              <PowerOff size={13} />
                              <span>Set Maintenance</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => handleReactivateTable(t)}
                              className="w-full px-4 py-2.5 text-left text-xs text-emerald-400 hover:bg-emerald-950/20 transition-colors flex items-center gap-2 border-t border-neutral-800/60"
                            >
                              <Power size={13} />
                              <span>Reactivate Table</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Card Middle: Table Name & Edit State */}
                <div className="flex items-center gap-3 mb-6">
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center border flex-shrink-0 ${isOccupied ? 'bg-rose-500/10 border-rose-500/20 text-rose-400' : 'bg-neutral-900 border-neutral-800 text-neutral-500'}`}>
                    <Table2 size={20} />
                  </div>
                  
                  {editingId === t.id ? (
                    <div className="flex-1 flex flex-col gap-2 relative z-10">
                      <input
                        type="text"
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        maxLength={15}
                        onKeyDown={e => { if (e.key === 'Enter') handleUpdateName(t.id); if (e.key === 'Escape') setEditingId(null); }}
                        autoFocus
                        className="w-full bg-neutral-900 border border-amber-600/50 rounded-lg px-3 py-1.5 text-sm text-neutral-200 focus:outline-none"
                      />
                      <div className="flex gap-1.5">
                        <button onClick={() => handleUpdateName(t.id)} className="flex-1 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 text-[10px] font-bold py-1 rounded">Save</button>
                        <button onClick={() => setEditingId(null)} className="flex-1 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 text-[10px] font-bold py-1 rounded">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="min-w-0">
                      <h3 className="text-lg font-black text-white truncate">{t.name}</h3>
                      {!t.isActive && t.status !== 'maintenance' && (
                        <p className="text-[10px] text-neutral-500 font-semibold mt-0.5">DISABLED</p>
                      )}
                    </div>
                  )}
                </div>

                {/* Card Footer: Contextual Information */}
                <div className="mt-auto pt-4 border-t border-neutral-800/60">
                  {isOccupied ? (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 overflow-hidden">
                        <div className="w-6 h-6 rounded bg-neutral-900 border border-neutral-800 flex items-center justify-center flex-shrink-0">
                          <Users size={12} className="text-neutral-400" />
                        </div>
                        <p className="text-xs font-bold text-neutral-300 truncate">{t.session.customerName}</p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-[10px] text-neutral-500 font-medium">Started</p>
                        <p className="text-xs font-mono text-neutral-300">{format(new Date(t.session.startTime), 'h:mm a')}</p>
                      </div>
                    </div>
                  ) : isMaintenance ? (
                    <div className="flex items-start gap-2">
                      <Wrench size={14} className="text-orange-500/70 mt-0.5 flex-shrink-0" />
                      <p className="text-xs text-orange-400/80 leading-relaxed line-clamp-2">
                        {t.maintenanceReason || "Offline for routine maintenance."}
                      </p>
                    </div>
                  ) : t.status === 'event' ? (
                     <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
                      <p className="text-xs text-purple-400 font-semibold truncate">{t.maintenanceReason || "Reserved for Event"}</p>
                    </div>
                  ) : (
                    <p className="text-xs text-neutral-500 font-medium flex items-center gap-1.5">
                      <CheckCircle size={12} className="text-emerald-500/50" /> Ready for next guest
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Unified Maintenance / Disable Modal */}
      {maintenanceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-neutral-950 border border-orange-800/40 rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between bg-orange-950/20">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
                  <Wrench size={16} className="text-orange-400" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-neutral-100">Set Maintenance</h2>
                  <p className="text-xs text-neutral-500">{maintenanceModal.tableName}</p>
                </div>
              </div>
              <button onClick={() => setMaintenanceModal(null)} className="p-2 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg">
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleConfirmMaintenance} className="p-6 space-y-4">
              <p className="text-xs text-neutral-400 leading-relaxed">
                Select a reason below to mark this table for maintenance and disable new guest sessions.
              </p>

              <div className="space-y-2">
                {COMMON_MAINTENANCE_REASONS.map(reason => (
                  <label
                    key={reason}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border text-xs font-semibold cursor-pointer transition-colors ${
                      selectedReason === reason
                        ? 'bg-orange-500/15 border-orange-500/40 text-orange-400'
                        : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:bg-neutral-800'
                    }`}
                  >
                    <input
                      type="radio"
                      name="maintenanceReason"
                      checked={selectedReason === reason}
                      onChange={() => setSelectedReason(reason)}
                      className="hidden"
                    />
                    <span>{reason}</span>
                  </label>
                ))}
              </div>

              {selectedReason === 'Others (Specify below)' && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex justify-between items-center">
                    <label className="text-xs text-neutral-400 font-semibold">Custom Maintenance Reason *</label>
                    <span className="text-[10px] text-neutral-500 font-mono">{customReason.length}/50</span>
                  </div>
                  <input
                    type="text"
                    required
                    maxLength={50}
                    value={customReason}
                    onChange={e => setCustomReason(e.target.value)}
                    placeholder="Enter custom maintenance note (max 50 chars)"
                    className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-orange-500/50"
                  />
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setMaintenanceModal(null)}
                  className="px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm rounded-xl transition-colors font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isConfirming || (selectedReason === 'Others (Specify below)' && !customReason.trim())}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold bg-orange-700 hover:bg-orange-600 text-white shadow-lg flex items-center justify-center gap-2"
                >
                  {isConfirming ? 'Saving...' : <><Wrench size={14} /> Confirm Disable</>}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}