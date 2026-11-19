export const messages = {
  'booking-received': ['Booking received', 'Your booking was received', '#2563eb'],
  'deposit-received': ['Down payment update', 'Your down-payment details were received', '#047857'],
  'balance-received': ['Payment received', 'Your remaining balance was recorded', '#047857'],
  confirmed: ['Booking confirmed', 'Your reservation is confirmed', '#047857'],
  rescheduled: ['Rescheduled', 'Your reservation was rescheduled', '#7c3aed'],
  'reschedule-declined': ['Reschedule declined', 'Your original reservation is still scheduled', '#a16207'],
  'checked-in': ['Checked in', 'You are checked in', '#0369a1'],
  completed: ['Session completed', 'Thank you for playing', '#047857'],
  cancelled: ['Booking cancelled', 'Your reservation was cancelled', '#be123c'],
  'refund-pending': ['Refund requested', 'Your refund request is being processed', '#a16207'],
  'refund-settled': ['Refund settled', 'Your refund was marked as settled', '#047857'],
} as const;

export type MailEvent = keyof typeof messages;

export type QueueEntry = {
  id: number;
  claim_token: string;
  reservation_id: string;
  recipient: string;
  event: MailEvent;
  details: {
    date: string | null;
    time: string | null;
    hours: string | null;
    partySize: string | null;
    status: string | null;
    total: string | null;
    deposit: string | null;
    depositOnFile: boolean;
  };
};

export type VenueDetails = {
  name: string;
  phone: string;
  email: string;
  address: string;
};

export const defaultVenue: VenueDetails = {
  name: 'One Shot Bar & Billiards',
  phone: '',
  email: '',
  address: '',
};
const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
const dayInManila = new Intl.DateTimeFormat('en-PH', {
  dateStyle: 'full', timeZone: 'Asia/Manila',
});
const statusLabels: Record<string, string> = {
  pending: 'Pending review', confirmed: 'Confirmed', 'checked-in': 'Checked in',
  completed: 'Completed', cancelled: 'Cancelled', 'pending-refund': 'Refund pending',
  'pending-reschedule': 'Reschedule pending',
};

function number(value: string | null): number | undefined {
  return value && /^[0-9]{1,10}(\.[0-9]{1,4})?$/.test(value) ? Number(value) : undefined;
}

function html(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, character => entities[character]);
}

function schedule(details: QueueEntry['details']): string {
  if (!details.date) return '';
  const value = /^\d{4}-\d{2}-\d{2}$/.test(details.date) ? `${details.date}T00:00:00+08:00` : details.date;
  const date = new Date(value);
  if (isNaN(date.getTime())) return '';
  const clock = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(details.time ?? '');
  if (!clock) return dayInManila.format(date);
  const hours = Number(clock[1]);
  return `${dayInManila.format(date)} · ${hours % 12 || 12}:${clock[2]} ${hours >= 12 ? 'PM' : 'AM'}`;
}

export function buildReservationEmail(entry: QueueEntry, venue: VenueDetails = defaultVenue) {
  const { details, event } = entry;
  const [label, heading, color] = messages[event];
  const reference = entry.reservation_id.toUpperCase();
  const amount = number(details.total);
  const deposit = number(details.deposit);
  const hours = number(details.hours);
  const people = number(details.partySize);
  const status = details.status ?? '';
  let note = '';
  if (event === 'booking-received') {
    if (details.depositOnFile && details.status === 'pending') {
      note = 'Your down-payment details are on file. Your booking is pending review.';
    } else if (!details.depositOnFile && deposit !== undefined && deposit > 0) {
      note = `Please settle the down payment of ${peso.format(deposit)} to reserve your slot.`;
    }
  } else if (event === 'deposit-received' && details.status === 'pending') {
    note = 'Your booking is pending review.';
  }

  const rows = [
    ['Booking reference', reference],
    ['Date & time', schedule(details)],
    ['Duration', hours === undefined ? '' : `${hours} ${hours === 1 ? 'hour' : 'hours'}`],
    ['Party size', people === undefined ? '' : `${people} ${people === 1 ? 'guest' : 'guests'}`],
    ['Status', Object.hasOwn(statusLabels, status) ? statusLabels[status] : ''],
    ['Total amount', amount === undefined ? '' : peso.format(amount)],
    ['Down payment', deposit === undefined ? '' : peso.format(deposit)],
  ].filter(([, value]) => value !== '');

  const contactDetails = [
    venue.address,
    venue.phone ? `Hotline: ${venue.phone}` : '',
    venue.email,
  ].filter(Boolean);
  const contactHtml = [
    venue.address ? html(venue.address) : '',
    venue.phone ? `Hotline: ${html(venue.phone)}` : '',
    venue.email ? html(venue.email) : '',
  ].filter(Boolean).join('<br>');
  const footer = `You are receiving this email because you made a reservation at ${venue.name}. Keep your booking reference ${reference} handy when contacting us.`;

  return {
    subject: `${venue.name}: ${heading} (${reference})`,
    text: [
      venue.name,
      heading,
      note,
      ...rows.map(([key, value]) => `${key}: ${value}`),
      contactDetails.join('\n'),
      footer,
    ].filter(Boolean).join('\n'),
    html: `<div style="background:#f4f4f5;padding:24px;font-family:Arial,sans-serif;color:#18181b">
      <div style="max-width:520px;margin:auto;background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:24px">
        <p style="color:${color};font-weight:bold;text-transform:uppercase;letter-spacing:1px">${html(label)}</p>
        <h1 style="font-size:24px;margin:0 0 16px">${html(heading)}</h1>
        ${note ? `<p style="background:#f4f4f5;border-radius:8px;padding:12px">${html(note)}</p>` : ''}
        <table style="width:100%;border-collapse:collapse">${rows.map(([key, value]) =>
          `<tr><th scope="row" style="text-align:left;padding:8px 4px;color:#52525b">${html(key)}</th><td style="text-align:right;padding:8px 4px">${html(value)}</td></tr>`
        ).join('')}</table>
        ${contactHtml ? `<p style="margin:20px 0 0;color:#52525b;font-size:13px;line-height:1.6">${contactHtml}</p>` : ''}
        <p style="margin:20px 0 0;padding-top:16px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px;line-height:1.5">
          You are receiving this email because you made a reservation at ${html(venue.name)}. Keep your booking reference <strong>${html(reference)}</strong> handy when contacting us.
        </p>
      </div>
    </div>`,
  };
}
