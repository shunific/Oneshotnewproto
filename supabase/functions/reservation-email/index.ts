import { timingSafeEqual } from 'node:crypto';
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
// @ts-types="npm:@types/nodemailer@7.0.11"
import nodemailer from 'npm:nodemailer@10.5.0';
import { buildReservationEmail, defaultVenue, messages, type QueueEntry, type VenueDetails } from './message.ts';

const maxBatch = 5;
const maxBatchTime = 25000;
const emailPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;
type Result = 'sent' | 'temporary' | 'recipient-rejected' | 'invalid-message' | 'provider-auth';

function matchesSecret(supplied: string, expected: string): boolean {
  if (expected.length < 32 || supplied.length !== expected.length) return false;
  const encoder = new TextEncoder();
  const left = encoder.encode(supplied);
  const right = encoder.encode(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function serviceKey(): string | undefined {
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  return (keys ? JSON.parse(keys).default : undefined) || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
}

async function loadVenue(supabase: ReturnType<typeof createClient>): Promise<VenueDetails> {
  try {
    const [cms, settings] = await Promise.all([
      supabase.from('cms').select('keyname, settingvalue'),
      supabase.from('system_settings').select('key_name, setting_value'),
    ]);
    const config: Record<string, string> = {};
    for (const row of (settings.data ?? []) as Array<{ key_name?: string; setting_value?: string }>) {
      if (row.key_name) config[row.key_name] = row.setting_value ?? '';
    }
    // The website treats CMS as the source of truth, so it wins over settings.
    for (const row of (cms.data ?? []) as Array<{ keyname?: string; settingvalue?: string }>) {
      if (row.keyname) config[row.keyname] = row.settingvalue ?? '';
    }

    const pick = (...keys: string[]) => {
      for (const key of keys) {
        const value = config[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
      }
      return '';
    };
    const name = pick('venueName', 'name') || defaultVenue.name;
    const phone = (pick('contactNumber', 'contactPhone', 'contactnumber', 'phone').split('|')[0] || '').trim();
    const email = pick('contactEmail', 'contactemail', 'email');
    const address = pick('address', 'venueAddress');
    const nameKey = name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '').replace(/and/g, '');
    const addressKey = address.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '').replace(/and/g, '');
    const addressIsName = !!address && (addressKey === nameKey || nameKey.includes(addressKey) || addressKey.includes(nameKey));

    return { name, phone, email, address: addressIsName ? '' : address };
  } catch (error) {
    console.error('Could not load venue contact details:', error);
    return defaultVenue;
  }
}

function smtpResult(error: unknown): Result {
  const smtp = error as { code?: string; responseCode?: number; command?: string } | null;
  if (smtp?.code === 'EAUTH' || smtp?.responseCode === 535) return 'provider-auth';
  if (smtp?.command === 'RCPT TO' && (smtp.responseCode ?? 0) >= 500) return 'recipient-rejected';
  return 'temporary';
}

async function handle(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });

  const secret = Deno.env.get('RESERVATION_MAIL_WORKER_SECRET') ?? '';
  if (!matchesSecret(request.headers.get('X-Reservation-Mail-Secret') ?? '', secret)) {
    return new Response(null, { status: 401 });
  }

  const url = Deno.env.get('SUPABASE_URL');
  const key = serviceKey();
  const user = Deno.env.get('RESERVATION_SMTP_USER') ?? '';
  const password = Deno.env.get('RESERVATION_SMTP_APP_PASSWORD') ?? '';
  if (!url || !key || !/^[A-Za-z0-9._+%-]+@gmail\.com$/i.test(user) || !/^[A-Za-z]{16}$/.test(password)) {
    console.error('Reservation email worker is missing its Supabase or Gmail configuration.');
    return Response.json({ error: 'worker-not-configured' }, { status: 503 });
  }

  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  // Supabase Edge blocks outbound port 587. Gmail also supports implicit TLS on 465.
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass: password },
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 8000,
  });

  // A deployment check authenticates to Gmail without leasing a job or sending mail.
  if (new URL(request.url).searchParams.get('check') === 'smtp') {
    try {
      await transport.verify();
      return Response.json({ smtp: 'ready' });
    } catch (error) {
      return Response.json({ error: smtpResult(error) }, { status: 503 });
    } finally {
      transport.close();
    }
  }

  const venue = await loadVenue(supabase);
  const start = Date.now();
  let sent = 0;
  let unsuccessful = 0;
  try {
    for (let index = 0; index < maxBatch && Date.now() - start < maxBatchTime; index++) {
      const { data: rows, error: claimError } = await supabase.rpc('claim_reservation_email').abortSignal(AbortSignal.timeout(5000));
      if (claimError) return Response.json({ error: 'queue-claim-failed', sent, unsuccessful }, { status: 503 });
      const entry: QueueEntry | undefined = rows?.[0];
      if (!entry) break;

      let result: Result = 'invalid-message';
      if (Object.hasOwn(messages, entry.event) && emailPattern.test(entry.recipient) && /^[A-Za-z0-9-]{1,40}$/.test(entry.reservation_id)) {
        try {
          const receipt = await transport.sendMail({
            from: { address: user, name: 'One Shot Bar & Billiards' },
            to: { address: entry.recipient, name: '' },
            messageId: `<reservation-email-${entry.id}@gmail.com>`,
            ...buildReservationEmail(entry, venue),
          });
          result = receipt.accepted.map(value => String(value).toLowerCase()).includes(entry.recipient.toLowerCase())
            ? 'sent' : 'recipient-rejected';
        } catch (error) {
          result = smtpResult(error);
        }
      }

      const finish = () => supabase.rpc('finish_reservation_email', {
        p_id: entry.id, p_token: entry.claim_token, p_result: result,
      }).abortSignal(AbortSignal.timeout(4000));
      let saved = await finish();
      if (saved.error) saved = await finish();
      if (saved.error || !saved.data) {
        console.error(`Could not confirm the send result for queue item ${entry.id}.`);
        return Response.json({ error: 'queue-update-failed', sent, unsuccessful }, { status: 503 });
      }
      if (result === 'sent') sent++;
      else unsuccessful++;
      if (result === 'provider-auth') {
        console.error('Gmail rejected the reservation worker’s credentials.');
        return Response.json({ error: 'smtp-auth-rejected', sent, unsuccessful }, { status: 503 });
      }
    }
    return Response.json({ sent, unsuccessful });
  } finally {
    transport.close();
  }
}

export default { fetch: handle };
