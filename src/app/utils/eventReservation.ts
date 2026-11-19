type ReservationLabel = { id?: string; paymentRef?: string | null; customerName?: string | null };

export function eventReservationName(row: ReservationLabel) {
  const name = row.customerName?.trim() || '';
  if (row.paymentRef !== 'EVENT' && !row.id?.startsWith('EVT-') && !/^EVENT:\s*/i.test(name)) return null;
  return name.replace(/^EVENT:\s*/i, '') || 'Event';
}
