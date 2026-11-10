// Renders a stored 24h "HH:mm" value as 12-hour AM/PM while keeping the native
// time picker for input, so the UI never shows bare 24-hour time.
export function to12h(value?: string | null) {
  if (typeof value !== 'string' || !value.includes(':')) return '';
  const [hStr, mStr] = value.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

interface TimeFieldProps {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  required?: boolean;
  className?: string;
  placeholder?: string;
}

export function TimeField({ value, onChange, min, required, className = '', placeholder = 'Select time' }: TimeFieldProps) {
  const display = to12h(value);
  return (
    <div className={`relative ${className}`}>
      <span className={display ? '' : 'opacity-50'}>{display || placeholder}</span>
      <input
        type="time"
        value={value}
        min={min}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      />
    </div>
  );
}
