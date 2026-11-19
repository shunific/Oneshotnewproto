import { useState } from 'react';
import { format } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { bookingDayKey, closureOn, freeIntervals, holdsBooking } from '../utils/bookingSchedule.js';

type Props = {
  selectedDate: Date | null;
  onSelect: (day: Date) => void;
  settings: any;
  tables: any[];
  hours?: number;
  excludeId?: string;
  onClosedClick?: (day: Date, reason: string) => void;
};

export function BookingCalendar({ selectedDate, onSelect, settings, tables, hours = 1, excludeId, onClosedClick }: Props) {
  const today = new Date();
  today.setHours(0,0,0,0);
  const last = new Date(today);
  last.setDate(last.getDate()+30);
  const [month, setMonth] = useState(() => selectedDate || today);
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const move = (offset: number) => setMonth(new Date(first.getFullYear(), first.getMonth()+offset, 1));
  return <div>
    <div className="mb-4 flex items-center justify-between">
      <button type="button" aria-label="Previous month" onClick={() => move(-1)}><ChevronLeft size={16}/></button>
      <span className="text-xs font-bold">{format(month,'MMMM yyyy')}</span>
      <button type="button" aria-label="Next month" onClick={() => move(1)}><ChevronRight size={16}/></button>
    </div>
    <div className="grid grid-cols-7 gap-y-1 text-center">
      {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(name=><span key={name} className="mb-1 text-[9px] uppercase text-neutral-500">{name}</span>)}
      {Array.from({length:42},(_,i)=>{
        const day = new Date(first.getFullYear(),first.getMonth(),1-first.getDay()+i);
        const key = bookingDayKey(day);
        const outside = day.getMonth() !== first.getMonth() || day < today || day > last;
        const closed = !outside && closureOn(day,settings.closedDates);
        const available = !outside && !closed && tables.some(table=>freeIntervals(day,table,settings,excludeId).some(([a,b]:number[])=>b-a >= hours*60));
        const hasBookings = available && settings.reservations.some((r:any)=>r.id!==excludeId && holdsBooking(r) && bookingDayKey(r.date)===key);
        const selected = !!selectedDate && bookingDayKey(selectedDate)===key;
        const label = available ? (hasBookings ? 'Bookings on this date, slots available' : 'Available') : (closed ? 'Closed' : 'Unavailable');
        return <button key={key} type="button" aria-label={format(day,'MMMM d, yyyy') + ', ' + label} aria-pressed={selected}
          disabled={outside || (!available && !closed)} onClick={()=>closed ? onClosedClick?.(day,closed.reason || 'Venue closed.') : onSelect(day)}
          className={`relative mx-auto h-8 w-8 rounded-full text-xs font-semibold ${outside ? 'opacity-25' : selected ? 'bg-emerald-500 text-white' : available ? 'hover:bg-neutral-800' : 'text-rose-400'}`}>
          {day.getDate()}{!outside && <span className={`absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full ${selected ? 'bg-white' : !available ? 'bg-rose-500' : hasBookings ? 'bg-amber-400' : 'bg-emerald-500'}`}/>}
        </button>;
      })}
    </div>
    <div className="mt-3 flex flex-wrap justify-center gap-3 text-[10px]">
      <span className="text-emerald-400">● Available</span><span className="text-amber-400">● Partly booked</span><span className="text-rose-400">● Unavailable</span>
    </div>
  </div>;
}
