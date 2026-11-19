/** Format wall-clock times without converting their date or time zone. */
export function clockLabel(value?: string | null): string {
  if (!value) return '';
  const match = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/.exec(value.trim());
  if (!match || Number(match[1]) > 23) return value;
  const hour = Number(match[1]);
  return (hour % 12 || 12) + ':' + match[2] + (hour < 12 ? ' AM' : ' PM');
}

export function clockRangeLabel(value?: string | null): string {
  if (!value) return '';
  const range = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}:\d{2}(?::\d{2})?)$/.exec(value.trim());
  return range ? clockLabel(range[1]) + ' – ' + clockLabel(range[2]) : clockLabel(value);
}
