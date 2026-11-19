import { useRef, useState } from 'react';
import { clockLabel } from '../../utils/clockDisplay';

interface TimeFieldProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  dateTime?: boolean;
  min?: string;
  required?: boolean;
  className?: string;
  placeholder?: string;
  style?: React.CSSProperties;
}

const minutes = Array.from({length: 60}, (_,i) => String(i).padStart(2,'0'));
const hours = Array.from({length: 12}, (_,i) => i+1);
const control = 'rounded border border-neutral-600 bg-neutral-900 p-2 text-white';

export function TimeField({value, onChange, label, dateTime, min, required, className, placeholder, style}: TimeFieldProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [day, setDay] = useState('');
  const [hour, setHour] = useState(12);
  const [minute, setMinute] = useState('00');
  const [period, setPeriod] = useState('AM');
  const [error, setError] = useState('');
  const [date, time] = dateTime ? (value || '').split('T') : ['',value];
  const display = time ? [date,clockLabel(time)].filter(Boolean).join(' · ') : '';
  function open() {
    const start = value || min || (dateTime ? '' : '12:00');
    const [d,t] = dateTime ? start.split('T') : ['',start];
    const [h,m] = (t || '12:00').split(':');
    setDay(d); setHour(Number(h)%12 || 12); setMinute(m); setPeriod(Number(h)>=12 ? 'PM' : 'AM');
    setError('');
    dialog.current?.showModal();
  }
  function apply() {
    const h = hour%12 + (period === 'PM' ? 12 : 0);
    const clock = String(h).padStart(2,'0') + ':' + minute;
    const next = dateTime ? day + 'T' + clock : clock;
    if (dateTime && !day) { setError('Choose a date.'); return; }
    if (min && next < min) {
      const [d,t] = dateTime ? min.split('T') : ['', min];
      setError('Earliest allowed: ' + [d,clockLabel(t)].filter(Boolean).join(' · ')); return;
    }
    onChange(next); dialog.current?.close();
  }
  return <>
    <button type="button" aria-haspopup="dialog" aria-label={label + ': ' + (display || 'Select time')}
      onClick={open} className={className} style={style}>{display || placeholder || 'Select time'}</button>
    <input className="sr-only" tabIndex={-1} aria-hidden="true" type={dateTime ? 'datetime-local' : 'time'}
      value={value || ''} min={min} required={required} onChange={e=>onChange(e.target.value)}
      onInvalid={e=>{e.preventDefault();open();}} />
    <dialog ref={dialog} aria-label={label} className="fixed inset-0 m-auto w-fit max-w-[95vw] rounded-xl border border-neutral-700 bg-neutral-950 p-5 text-neutral-100 shadow-xl backdrop:bg-black/60"
      onKeyDown={e=>{if(e.key==='Enter' && (e.target as HTMLElement).tagName === 'INPUT'){e.preventDefault();apply();}}}>
      <p className="mb-3 font-semibold">{label}</p>
      {dateTime && <input type="date" aria-label="Date" value={day} onChange={e=>setDay(e.target.value)} className={control + ' mb-3 block'} />}
      <div className="flex items-center gap-2">
        <select aria-label="Hour" className={control} value={hour} onChange={e=>setHour(Number(e.target.value))}>{hours.map(h=><option key={h}>{h}</option>)}</select>
        <span>:</span>
        <select aria-label="Minute" className={control} value={minute} onChange={e=>setMinute(e.target.value)}>{minutes.map(m=><option key={m}>{m}</option>)}</select>
        <select aria-label="AM or PM" className={control} value={period} onChange={e=>setPeriod(e.target.value)}><option>AM</option><option>PM</option></select>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-rose-400">{error}</p>}
      <div className="mt-4 flex justify-end gap-3 text-sm">
        {!required && value && <button type="button" onClick={()=>{onChange('');dialog.current?.close();}}>Clear</button>}
        <button type="button" onClick={()=>dialog.current?.close()}>Cancel</button>
        <button type="button" className="rounded bg-emerald-700 px-3 py-1.5 text-white" onClick={apply}>Apply</button>
      </div>
    </dialog>
  </>;
}
