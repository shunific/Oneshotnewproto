// ====================================================================
// CUSTOMER EMAIL NOTIFICATIONS
// Sends a transactional email to the customer whenever a reservation
// changes state (created, confirmed, cancelled, rescheduled, refunded...).
//
// Transport is provider-agnostic and optional:
//   * Resend  -> RESEND_API_KEY (+ EMAIL_FROM)
//   * SMTP    -> SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS (+ EMAIL_FROM)
// When nothing is configured every send is skipped and logged, so the app
// keeps working out of the box until a key is supplied.
//
// Configuration is read from the environment first, then from the local
// systemSettings table for developer-provisioned installs. There is no UI or
// writable API for these values: delivery is automatic once a transport exists.
// ====================================================================
const run = (db, sql, values = []) => new Promise((resolve, reject) =>
  db.run(sql, values, function (error) { error ? reject(error) : resolve(this.changes); }));
const get = (db, sql, values = []) => new Promise((resolve, reject) =>
  db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
const all = (db, sql, values = []) => new Promise((resolve, reject) =>
  db.all(sql, values, (error, rows) => error ? reject(error) : resolve(rows || [])));

const clean = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  if (!s || s === 'undefined' || s === 'null' || s === '""' || s === "''") return '';
  return s;
};

// ── Action catalogue: which reservation changes notify the customer ──
const ACTIONS = {
  created:          { label: 'Booking received',        tone: 'info',    heading: 'Your booking was received' },
  confirmed:        { label: 'Booking confirmed',       tone: 'success', heading: 'Your booking is confirmed' },
  cancelled:        { label: 'Booking cancelled',       tone: 'danger',  heading: 'Your booking was cancelled' },
  rescheduled:      { label: 'Booking rescheduled',     tone: 'info',    heading: 'Your booking was rescheduled' },
  'reschedule-declined': { label: 'Reschedule declined', tone: 'danger', heading: 'Your reschedule request was declined' },
  'checked-in':     { label: 'Checked in',              tone: 'success', heading: 'You are checked in' },
  completed:        { label: 'Session completed',       tone: 'success', heading: 'Thank you for playing' },
  'payment-received': { label: 'Payment received',      tone: 'success', heading: 'We received your payment' },
  'refund-pending': { label: 'Refund requested',        tone: 'warning', heading: 'Your refund request is being processed' },
  'refund-settled': { label: 'Refund settled',          tone: 'success', heading: 'Your refund has been settled' },
};

const TONE_COLORS = {
  info: '#3b82f6', success: '#10b981', warning: '#f59e0b', danger: '#ef4444',
};

const escapeHtml = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtMoney = (n) => {
  const val = Number(n);
  if (!Number.isFinite(val)) return '';
  return '₱' + val.toFixed(2);
};

const fmtDateTime = (d, t) => {
  const datePart = (() => {
    if (!d) return '';
    const parsed = new Date(d);
    if (Number.isNaN(parsed.getTime())) return String(d);
    return parsed.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  })();
  const timePart = (() => {
    if (!t || typeof t !== 'string' || !t.includes(':')) return clean(t);
    const [hStr, mStr] = t.split(':');
    const h = Number(hStr), m = Number(mStr);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return t;
    const period = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${period}`;
  })();
  return [datePart, timePart].filter(Boolean).join(' · ');
};

const STATUS_LINE = {
  pending: 'Pending review', confirmed: 'Confirmed', 'checked-in': 'Checked in',
  completed: 'Completed', cancelled: 'Cancelled', 'pending-refund': 'Pending refund',
  'pending-reschedule': 'Reschedule pending',
};

// ── HTML template (email-client safe: inline styles + table layout) ──
function buildEmail({ action, reservation, venue = {}, extras = {} }) {
  const meta = ACTIONS[action] || { label: 'Reservation update', tone: 'info', heading: 'Reservation update' };
  const accent = TONE_COLORS[meta.tone] || TONE_COLORS.info;
  const r = reservation || {};
  const venueName = clean(venue.name) || 'One Shot Bar & Billiards';
  const bookingId = String(r.id || '').toUpperCase();

  const rows = [
    ['Booking reference', bookingId],
    ['Customer', r.customerName],
    ['Date & time', fmtDateTime(r.date, r.timeSlot)],
    ['Duration', r.durationHours ? `${r.durationHours} hour${Number(r.durationHours) === 1 ? '' : 's'}` : ''],
    ['Party size', r.partySize ? `${r.partySize} guest${Number(r.partySize) === 1 ? '' : 's'}` : ''],
    ['Status', STATUS_LINE[r.status] || clean(r.status)],
    ['Total amount', r.totalAmount ? fmtMoney(r.totalAmount) : ''],
    ['Down payment', r.downPaymentAmount ? fmtMoney(r.downPaymentAmount) : ''],
  ].filter(([, v]) => clean(v) !== '');

  // Action-specific callout
  let callout = '';
  if (action === 'rescheduled' && (extras.newDate || extras.newTimeSlot)) {
    callout = `New schedule: <strong>${escapeHtml(fmtDateTime(extras.newDate, extras.newTimeSlot))}</strong>`;
  } else if (action === 'reschedule-declined' && extras.reason) {
    callout = escapeHtml(extras.reason);
  } else if ((action === 'cancelled' || action === 'refund-pending' || action === 'refund-settled') && extras.reason) {
    callout = escapeHtml(extras.reason);
  } else if (action === 'payment-received' && extras.reason) {
    callout = escapeHtml(extras.reason);
  } else if (action === 'created' && r.downPaymentAmount) {
    callout = `Please settle the down payment of <strong>${escapeHtml(fmtMoney(r.downPaymentAmount))}</strong> to lock in your slot.`;
  }

  const rowsHtml = rows.map(([k, v]) => `
            <tr>
              <td style="padding:8px 0;color:#71717a;font-size:13px;">${escapeHtml(k)}</td>
              <td style="padding:8px 0;color:#f4f4f5;font-size:13px;text-align:right;font-weight:600;">${escapeHtml(v)}</td>
            </tr>`).join('');

  const html = `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#18181b;border:1px solid #27272a;border-radius:16px;overflow:hidden;">
          <tr><td style="padding:24px 28px 8px 28px;">
            <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${accent};font-weight:700;">${escapeHtml(meta.label)}</div>
            <div style="font-size:22px;font-weight:800;color:#fafafa;margin-top:6px;">${escapeHtml(meta.heading)}</div>
          </td></tr>
          ${callout ? `<tr><td style="padding:4px 28px 12px 28px;">
            <div style="background:${accent}1a;border:1px solid ${accent}55;border-radius:10px;padding:12px 14px;color:#e4e4e7;font-size:13px;line-height:1.5;">${callout}</div>
          </td></tr>` : ''}
          <tr><td style="padding:8px 28px 4px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table>
          </td></tr>
          <tr><td style="padding:16px 28px 4px 28px;">
            <div style="border-top:1px solid #27272a;padding-top:16px;color:#a1a1aa;font-size:12px;line-height:1.6;">
              ${venue.address ? escapeHtml(venue.address) + '<br/>' : ''}
              ${venue.phone ? 'Hotline: ' + escapeHtml(venue.phone) + '<br/>' : ''}
              ${venue.email ? escapeHtml(venue.email) : ''}
            </div>
          </td></tr>
          <tr><td style="padding:16px 28px 24px 28px;">
            <div style="color:#52525b;font-size:11px;line-height:1.5;">
              You are receiving this email because you made a reservation at ${escapeHtml(venueName)}.
              Keep your booking reference <strong>${escapeHtml(bookingId)}</strong> handy when contacting us.
            </div>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const textLines = [
    meta.heading,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
  ];
  if (callout) textLines.push('', callout.replace(/<[^>]+>/g, ''));
  textLines.push('', `${venueName}${venue.phone ? ' · ' + venue.phone : ''}`);
  const text = textLines.join('\n');

  const subject = `${venueName}: ${meta.heading} (${bookingId})`;
  return { subject, html, text };
}

// ── Reservation change → notification mapping ──
const RESCHEDULE_PREFIX = '__RESCHEDULE_REQUEST__';

function parseRescheduleMarker(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(RESCHEDULE_PREFIX)) return null;
  try { return JSON.parse(raw.slice(RESCHEDULE_PREFIX.length)); } catch { return null; }
}

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

// Works out which customer emails a reservation write should trigger.
// `prev` is the stored row (null on insert); `updates` is the incoming patch.
function detectReservationActions(prev, updates = {}) {
  const events = [];
  const seen = new Set();
  const add = (action, extras = {}) => {
    if (seen.has(action)) return;
    seen.add(action);
    events.push({ action, extras });
  };

  const prevStatus = prev ? prev.status : undefined;
  const nextStatus = updates.status !== undefined ? updates.status : prevStatus;
  const reason = updates.cancellationReason !== undefined ? updates.cancellationReason : (prev && prev.cancellationReason);
  const marker = parseRescheduleMarker(reason);

  if (!prev) {
    add('created');
  } else if (marker && marker.decision === 'rejected' && prevStatus === 'pending-reschedule') {
    add('reschedule-declined', { reason: clean(marker.reason) });
  } else if (nextStatus && nextStatus !== prevStatus) {
    if (nextStatus === 'confirmed') {
      add(prevStatus === 'pending-reschedule' ? 'rescheduled' : 'confirmed',
        prevStatus === 'pending-reschedule' ? { newDate: updates.date, newTimeSlot: updates.timeSlot } : {});
    } else if (nextStatus === 'cancelled') {
      const refundRelated = prevStatus === 'pending-refund' || /refund/i.test(String(reason || ''));
      add(refundRelated ? 'refund-settled' : 'cancelled', { reason: clean(reason) });
    } else if (nextStatus === 'pending-refund') {
      add('refund-pending', { reason: clean(reason) });
    } else if (nextStatus === 'checked-in') {
      add('checked-in');
    } else if (nextStatus === 'completed') {
      add('completed');
    }
  } else {
    const scheduleChanged = ['date', 'timeSlot', 'durationHours'].some(
      k => updates[k] !== undefined && String(updates[k]) !== String(prev[k]));
    if (scheduleChanged && nextStatus === 'confirmed') {
      add('rescheduled', { newDate: updates.date, newTimeSlot: updates.timeSlot });
    }
  }

  if (updates.downPaymentPaid !== undefined && truthy(updates.downPaymentPaid) && !truthy(prev && prev.downPaymentPaid)) {
    add('payment-received', { reason: 'Down payment received.' });
  }
  if (updates.balancePaid !== undefined && truthy(updates.balancePaid) && !truthy(prev && prev.balancePaid)) {
    add('payment-received', { reason: 'Remaining balance settled.' });
  }
  if (clean(updates.refundStatus).toLowerCase() === 'settled' && clean(prev && prev.refundStatus).toLowerCase() !== 'settled') {
    add('refund-settled', { reason: 'Your refund has been settled.' });
  }

  return events;
}

// A stable per-action signature so an identical retry is not re-sent, while a
// genuinely new change (e.g. a second reschedule) still emails.
function actionSignature(event) {
  if (event.action === 'rescheduled') {
    return [clean(event.extras.newDate), clean(event.extras.newTimeSlot)].filter(Boolean).join('|');
  }
  if (event.action === 'payment-received') return clean(event.extras.reason);
  return '';
}

// ── Transport selection ──
async function loadConfig(db) {
  const settings = {};
  try {
    const rows = await all(db, 'SELECT keyName, settingValue FROM systemSettings');
    rows.forEach(r => { settings[r.keyName] = r.settingValue; });
  } catch (e) { /* settings table may not exist yet */ }

  const pick = (envVal, key) => clean(envVal) || clean(settings[key]);

  // A host alone is not enough for a login-based relay: without the password we
  // would hammer Gmail with doomed logins (which can lock the mailbox), so treat
  // it as unconfigured and skip cleanly instead.
  const smtpReady = !!pick(process.env.SMTP_HOST, 'smtpHost')
    && (!pick(process.env.SMTP_USER, 'smtpUser') || !!pick(process.env.SMTP_PASS, 'smtpPass'));

  const provider = (() => {
    const explicit = pick(process.env.EMAIL_PROVIDER, 'emailProvider').toLowerCase();
    if (explicit) return explicit;
    if (pick(process.env.RESEND_API_KEY, 'resendApiKey')) return 'resend';
    if (smtpReady) return 'smtp';
    return '';
  })();

  const enabledSetting = pick(process.env.EMAIL_NOTIFICATIONS_ENABLED, 'emailNotificationsEnabled');
  const enabled = enabledSetting === '' ? true : ['1', 'true', 'yes', 'on'].includes(String(enabledSetting).toLowerCase());

  return {
    enabled,
    provider,
    resendApiKey: pick(process.env.RESEND_API_KEY, 'resendApiKey'),
    fromAddress: pick(process.env.EMAIL_FROM, 'emailFromAddress') || 'notifications@oneshot.local',
    fromName: pick(process.env.EMAIL_FROM_NAME, 'emailFromName') || 'One Shot Bar & Billiards',
    smtpHost: pick(process.env.SMTP_HOST, 'smtpHost'),
    smtpPort: Number(pick(process.env.SMTP_PORT, 'smtpPort')) || 587,
    smtpSecure: ['1', 'true', 'yes'].includes(String(pick(process.env.SMTP_SECURE, 'smtpSecure')).toLowerCase()),
    smtpUser: pick(process.env.SMTP_USER, 'smtpUser'),
    smtpPass: pick(process.env.SMTP_PASS, 'smtpPass'),
  };
}

function fromHeader(config) {
  const addr = config.fromAddress;
  return config.fromName ? `${config.fromName} <${addr}>` : addr;
}

async function sendViaResend(config, message) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromHeader(config),
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }
  return true;
}

async function sendViaSmtp(config, message) {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    throw new Error('SMTP selected but the "nodemailer" package is not installed. Run: npm install nodemailer');
  }
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });
  await transport.sendMail({
    from: fromHeader(config),
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
  return true;
}

// ── Public factory ──
function createEmailService(db, { logger = console } = {}) {
  const ensureLogTable = async () => {
    await run(db, `CREATE TABLE IF NOT EXISTS email_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservationId TEXT,
      action TEXT,
      recipient TEXT,
      status TEXT,
      detail TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).catch(() => {});
  };

  const alreadySent = async (reservationId, action, signature) => {
    try {
      const row = await get(db,
        "SELECT id FROM email_notifications WHERE reservationId=? AND action=? AND status='sent' AND COALESCE(detail,'')=? LIMIT 1",
        [reservationId, action, signature || '']);
      return !!row;
    } catch (e) { return false; }
  };

  const record = async (reservationId, action, recipient, status, detail) => {
    try {
      await run(db,
        'INSERT INTO email_notifications (reservationId, action, recipient, status, detail) VALUES (?,?,?,?,?)',
        [reservationId, action, recipient, status, detail || null]);
    } catch (e) { /* logging must never break the flow */ }
  };

  const deliver = async (message, config) => {
    if (config.provider === 'resend' && config.resendApiKey) return sendViaResend(config, message);
    if (config.provider === 'smtp' && config.smtpHost) return sendViaSmtp(config, message);
    throw new Error('No email transport configured');
  };

  return {
    // Sends the notification for one reservation action. Never throws: a failed
    // email must not roll back the reservation change that triggered it.
    async notifyReservationAction({ action, reservation, extras = {}, venue = {}, force = false }) {
      if (!ACTIONS[action]) return { sent: false, reason: 'unknown-action' };
      const recipient = clean(reservation && reservation.email);
      if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        return { sent: false, reason: 'no-recipient' };
      }

      await ensureLogTable();
      const config = await loadConfig(db);
      if (!config.enabled) {
        await record(reservation.id, action, recipient, 'skipped', 'email notifications disabled');
        return { sent: false, reason: 'disabled' };
      }
      if (!config.provider) {
        logger.log(`📧 [Email]: skipped "${action}" for ${reservation.id} — no transport configured (set RESEND_API_KEY or SMTP_*).`);
        await record(reservation.id, action, recipient, 'skipped', 'no transport configured');
        return { sent: false, reason: 'not-configured' };
      }
      const signature = actionSignature({ action, extras });
      if (!force && await alreadySent(reservation.id, action, signature)) {
        return { sent: false, reason: 'duplicate' };
      }

      const message = { to: recipient, ...buildEmail({ action, reservation, venue, extras }) };
      try {
        await deliver(message, config);
        logger.log(`📧 [Email]: sent "${action}" to ${recipient} for ${reservation.id} via ${config.provider}.`);
        await record(reservation.id, action, recipient, 'sent', signature || config.provider);
        return { sent: true };
      } catch (error) {
        logger.error(`📧 [Email]: failed "${action}" to ${recipient} for ${reservation.id}: ${error.message}`);
        await record(reservation.id, action, recipient, 'failed', error.message);
        return { sent: false, reason: 'delivery-failed', error: error.message };
      }
    },

    // Sends every email implied by a reservation write. Used by the server routes.
    async notifyReservationChange({ prev, updates, reservation, venue = {} }) {
      const events = detectReservationActions(prev, updates);
      const merged = reservation || { ...(prev || {}), ...(updates || {}) };
      const results = [];
      for (const event of events) {
        results.push(await this.notifyReservationAction({ action: event.action, reservation: merged, extras: event.extras, venue }));
      }
      return results;
    },
    // Exposed for diagnostics/tests.
    _buildEmail: buildEmail,
    _loadConfig: loadConfig,
    _actions: ACTIONS,
    _detect: detectReservationActions,
  };
}

module.exports = { createEmailService, buildEmail, ACTIONS, detectReservationActions };
