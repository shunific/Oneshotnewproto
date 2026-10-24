import { useState, useEffect } from 'react';
import { Table } from '../context/AppContext';
import { Play, XSquare, Clock, Calendar, Wrench, ShoppingCart, Plus, Infinity as InfinityIcon } from 'lucide-react';
import { addMinutes, differenceInSeconds } from 'date-fns';

interface TableCardProps {
  table: Table;
  onAssign: () => void;
  onExtend: () => void;
  onEnd: () => void;
  onOrder: () => void;
  nextReservation: { date: Date; customerName: string; timeSlot: string } | null;
}

export function TableCard({ table, onAssign, onExtend, onEnd, onOrder, nextReservation }: TableCardProps) {
  const [now, setNow] = useState(new Date());
  const isEvent = table.status === 'event';

  const backgroundCls = isEvent 
    ? 'bg-purple-950/40 border-purple-800/50 text-purple-400 opacity-90' 
    : '...';
    
  // Update timer every second if the table is occupied
  useEffect(() => {
    if (table.status !== 'occupied') return;
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, [table.status]);

  // Timer Calculation Logic
  const getTimerInfo = () => {
    if (!table.session) return null;
    
    // 🟢 NEW: Intercept Open Time Logic
    if (table.session.isOpenTime || table.session.durationMinutes === null) {
      const elapsedSecs = Math.max(0, differenceInSeconds(now, new Date(table.session.startTime)));
      const hrs = String(Math.floor(elapsedSecs / 3600)).padStart(2, '0');
      const mm = String(Math.floor((elapsedSecs % 3600) / 60)).padStart(2, '0');
      const ss = String(elapsedSecs % 60).padStart(2, '0');
      
      return { 
        isOvertime: false, 
        percentLeft: 100, // Keeps the progress bar solid
        display: `${hrs}:${mm}:${ss}`, // Count UP instead of down
        isOpenTime: true 
      };
    }

    // Standard Countdown Logic
    const endTime = addMinutes(new Date(table.session.startTime), table.session.durationMinutes);
    const secsLeft = differenceInSeconds(endTime, now);
    const isOvertime = secsLeft < 0;
    const absSecs = Math.abs(secsLeft);
    
    const hrs = Math.floor(absSecs / 3600);
    const mm = String(Math.floor((absSecs % 3600) / 60)).padStart(2, '0');
    const ss = String(absSecs % 60).padStart(2, '0');
    
    const display = hrs > 0 ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;

    // Calculate progress bar percentage
    const totalSecs = table.session.durationMinutes * 60;
    const percentLeft = Math.max(0, Math.min(100, (secsLeft / totalSecs) * 100));

    return { display, isOvertime, percentLeft, isOpenTime: false };
  };

  const timer = getTimerInfo();

  // Smart click handler for the whole card
  const handleCardClick = () => {
    if (table.status === 'available' || table.status === 'reserved') {
      onAssign();
    } else if (table.status === 'occupied') {
      onOrder();
    }
    // If maintenance, do nothing.
  };

  return (
    <div 
      onClick={handleCardClick}
      className={`relative flex flex-col bg-neutral-900 border-2 border-transparent hover:border-neutral-700 rounded-2xl overflow-hidden transition-all duration-200 
      ${table.status !== 'maintenance' ? 'cursor-pointer hover:-translate-y-1 hover:shadow-xl hover:shadow-black/50' : 'opacity-80'}
      ${timer?.isOvertime ? '!border-rose-600 shadow-[0_0_15px_rgba(225,29,72,0.15)] hover:!border-rose-400' : ''}`}
    >
      
      {/* Overtime Pulse Background */}
      {timer?.isOvertime && <div className="absolute inset-0 bg-rose-500/5 animate-pulse pointer-events-none" />}

      {/* Header */}
      <div className="px-5 py-4 border-b border-neutral-800/60 flex items-start justify-between bg-neutral-950/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-neutral-800 border border-neutral-700 flex items-center justify-center font-black text-lg text-white">
            {table.name.replace('Table ', '')}
          </div>
          <div>
            <p className="text-xs text-neutral-500 uppercase tracking-widest font-semibold">{table.name}</p>
            {table.status === 'available' && <span className="text-sm font-bold text-emerald-400 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Open</span>}
            {table.status === 'reserved' && <span className="text-sm font-bold text-blue-400 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /> Reserved</span>}
            {table.status === 'maintenance' && <span className="text-sm font-bold text-orange-400 flex items-center gap-1.5"><Wrench size={12}/> Maintenance</span>}
            {table.status === 'occupied' && (
              <span className={`text-sm font-bold flex items-center gap-1.5 ${timer?.isOvertime ? 'text-rose-400' : timer?.isOpenTime ? 'text-blue-400' : 'text-amber-400'}`}>
                <span className={`w-2 h-2 rounded-full ${timer?.isOvertime ? 'bg-rose-500 animate-pulse' : timer?.isOpenTime ? 'bg-blue-500' : 'bg-amber-500'}`} />
                {timer?.isOvertime ? 'Overtime' : timer?.isOpenTime ? 'Open Time' : 'In Use'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Body Content */}
      <div className="p-5 flex-1 flex flex-col justify-center">
        
        {/* Available State */}
        {table.status === 'available' && (
          <div className="text-center space-y-4 my-2">
            {nextReservation ? (
              <div className="bg-blue-950/20 border border-blue-900/30 rounded-lg p-3 text-left">
                <p className="text-[10px] text-blue-400 uppercase tracking-wider font-semibold mb-1 flex items-center gap-1"><Calendar size={10}/> Next Reservation</p>
                <p className="text-sm text-neutral-200 font-semibold truncate">{nextReservation.customerName}</p>
                <p className="text-xs text-neutral-500">{nextReservation.timeSlot}</p>
              </div>
            ) : (
              <p className="text-xs text-neutral-500 pointer-events-none">Ready for walk-in or reservation.</p>
            )}
            <button 
              onClick={(e) => { e.stopPropagation(); onAssign(); }} 
              className="w-full flex items-center justify-center gap-2 py-3 bg-emerald-600/10 hover:bg-emerald-600/20 border border-emerald-600/30 text-emerald-400 rounded-xl text-sm font-semibold transition-colors"
            >
              <Play size={14} /> Start Session
            </button>
          </div>
        )}

        {/* Maintenance State */}
        {table.status === 'maintenance' && (
          <div className="text-center my-4">
            <Wrench size={24} className="mx-auto text-orange-500/50 mb-2" />
            <p className="text-sm text-neutral-300 font-medium">Under Maintenance</p>
            <p className="text-xs text-neutral-500 mt-1">{table.maintenanceReason || 'No reason specified'}</p>
          </div>
        )}

        {/* Reserved State */}
        {table.status === 'reserved' && (
          <div className="text-center space-y-4 my-2">
            <p className="text-xs text-blue-400">Reserved table. Awaiting customer arrival.</p>
            <button 
              onClick={(e) => { e.stopPropagation(); onAssign(); }} 
              className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600/10 hover:bg-blue-600/20 border border-blue-600/30 text-blue-400 rounded-xl text-sm font-semibold transition-colors"
            >
              <Play size={14} /> Check-in Customer
            </button>
          </div>
        )}

        {/* Occupied State */}
        {table.status === 'occupied' && table.session && timer && (
          <div className="space-y-4 relative z-10">
            <div className="text-center">
              <p className="text-xs text-neutral-400 font-medium truncate px-2">{table.session.customerName}</p>
              
              <div className="flex items-center justify-center gap-2 mt-1">
                {timer.isOpenTime && <InfinityIcon size={24} className="text-blue-400/50" />}
                <div className={`text-4xl font-black tabular-nums tracking-tight ${timer.isOvertime ? 'text-rose-400' : timer.isOpenTime ? 'text-blue-400' : timer.percentLeft < 15 ? 'text-amber-400' : 'text-white'}`}>
                  {timer.isOvertime && '+'}{timer.display}
                </div>
              </div>
              
              {/* Progress Bar */}
              <div className="mt-3 h-1.5 w-full bg-neutral-800 rounded-full overflow-hidden">
                {timer.isOpenTime ? (
                  <div className="h-full w-full bg-blue-500/80" />
                ) : !timer.isOvertime ? (
                  <div 
                    className={`h-full transition-all duration-1000 ${timer.percentLeft < 15 ? 'bg-rose-500' : timer.percentLeft < 30 ? 'bg-amber-500' : 'bg-emerald-500'}`} 
                    style={{ width: `${timer.percentLeft}%` }} 
                  />
                ) : (
                  <div className="h-full w-full bg-rose-500/50 animate-pulse" />
                )}
              </div>
            </div>

            {/* F&B Total Indicator */}
            {table.session.orders && table.session.orders.length > 0 && (
              <div className="flex justify-between items-center px-3 py-2 bg-neutral-950 rounded-lg border border-neutral-800">
                <span className="text-[10px] text-neutral-500 flex items-center gap-1"><ShoppingCart size={10}/> Orders</span>
                <span className="text-xs font-bold text-emerald-400">
                  ₱{table.session.orders.reduce((sum, o) => sum + (o.price * o.qty), 0).toFixed(2)}
                </span>
              </div>
            )}

            {/* Action Buttons */}
            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-neutral-800/60">
              <button 
                onClick={(e) => { e.stopPropagation(); onOrder(); }} 
                className="col-span-2 flex items-center justify-center gap-2 py-2 bg-emerald-950/30 hover:bg-emerald-900/40 border border-emerald-800/30 text-emerald-400 rounded-lg text-xs font-semibold transition-colors"
              >
                <Plus size={13} /> Add F&B Orders
              </button>
              
              <button 
                onClick={(e) => { e.stopPropagation(); onExtend(); }} 
                disabled={timer.isOpenTime} // Cannot extend an open-ended session
                className={`flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-semibold transition-colors ${timer.isOpenTime ? 'bg-neutral-900 text-neutral-600 opacity-50 cursor-not-allowed' : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-300'}`}
              >
                <Clock size={13} /> Extend
              </button>
              <button 
                onClick={(e) => { e.stopPropagation(); onEnd(); }} 
                className="flex items-center justify-center gap-1.5 py-2.5 bg-rose-950/30 hover:bg-rose-900/40 border border-rose-800/30 text-rose-400 rounded-lg text-xs font-semibold transition-colors"
              >
                <XSquare size={13} /> End
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}