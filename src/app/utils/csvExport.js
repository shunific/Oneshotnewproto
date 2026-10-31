export function exportCsv(headers, rows) {
  const cell = value => {
    if (value === null || value === undefined) return '""';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '""';
    const text = String(value);
    const safe = /^\s*[=+@-]/.test(text) ? "'" + text : text;
    return '"' + safe.replace(/"/g, '""') + '"';
  };
  return [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}
