-- ============================================================================
-- Reservation email queue
--
-- Every reservation change in public.reservations is written by both the
-- website and the desktop app. This trigger records the customer's address and queues
-- one email per meaningful change. A cron job invokes the reservation-email
-- Edge Function once a minute; the function leases a small batch and sends it
-- over Gmail SMTP (port 465).
--
-- Apply this file once in the Supabase SQL editor. Then follow
-- supabase/functions/reservation-email/README.md for the Edge Function,
-- Vault secrets and cron job.
-- ============================================================================

create schema if not exists reservation_mail;

create table if not exists reservation_mail.recipients (
  reservation_id text primary key,
  email text not null
);

create table if not exists reservation_mail.queue (
  id bigint generated always as identity primary key,
  reservation_id text not null,
  recipient text not null,
  event text not null,
  event_key text not null default '',
  details jsonb not null,
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  attempts integer not null default 0,
  claim_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  last_error text,
  unique (reservation_id, event, event_key)
);

create index if not exists queue_next_attempt_at_id_idx
  on reservation_mail.queue (next_attempt_at, id)
  where sent_at is null and failed_at is null;

create index if not exists queue_reservation_id_id_idx
  on reservation_mail.queue (reservation_id, id)
  where sent_at is null and failed_at is null;

create index if not exists queue_recipient_sent_at_idx
  on reservation_mail.queue (recipient, sent_at)
  where sent_at is not null;

create index if not exists queue_sent_at_idx
  on reservation_mail.queue (sent_at)
  where sent_at is not null;

alter table reservation_mail.recipients enable row level security;
alter table reservation_mail.queue enable row level security;

revoke all on reservation_mail.recipients, reservation_mail.queue from anon, authenticated;

-- Collect the fields the email template needs, regardless of which casing a
-- legacy client used for a column name.
create or replace function reservation_mail.reservation_details(row_data jsonb)
returns jsonb
language sql
immutable
set search_path to ''
as $$
  select jsonb_build_object(
    'date', coalesce(row_data->>'date', row_data->>'reservation_date'),
    'time', coalesce(row_data->>'timeSlot', row_data->>'timeslot', row_data->>'time_slot'),
    'hours', coalesce(row_data->>'durationHours', row_data->>'durationhours', row_data->>'duration_hours'),
    'partySize', coalesce(row_data->>'partySize', row_data->>'partysize', row_data->>'party_size'),
    'status', row_data->>'status',
    'total', coalesce(row_data->>'totalAmount', row_data->>'totalamount', row_data->>'total_amount'),
    'deposit', coalesce(row_data->>'downPaymentAmount', row_data->>'downpaymentamount', row_data->>'down_payment_amount'),
    'depositOnFile', coalesce(row_data->>'downPaymentPaid', row_data->>'downpaymentpaid', row_data->>'down_payment_paid', '') in ('1', 'true')
  );
$$;

-- Turn a reservation INSERT/UPDATE into queued mail events.
create or replace function reservation_mail.enqueue_reservation_emails()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  current_row jsonb := to_jsonb(new);
  previous_row jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  details jsonb := reservation_mail.reservation_details(current_row);
  previous_details jsonb := reservation_mail.reservation_details(previous_row);
  booking_id text := current_row->>'id';
  next_status text := current_row->>'status';
  old_status text := previous_row->>'status';
  next_reason text := coalesce(current_row->>'cancellationReason', current_row->>'cancellationreason', current_row->>'cancellation_reason', '');
  next_refund text := lower(coalesce(current_row->>'refundStatus', current_row->>'refundstatus', current_row->>'refund_status', ''));
  old_refund text := lower(coalesce(previous_row->>'refundStatus', previous_row->>'refundstatus', previous_row->>'refund_status', ''));
  checkout_reference text := coalesce(current_row->>'paymentRef', current_row->>'paymentref', current_row->>'payment_ref', '');
  candidate_email text := lower(trim(coalesce(previous_row->>'email', '')));
  recipient_email text;
  booking_created text := coalesce(current_row->>'createdAt', current_row->>'createdat', current_row->>'created_at');
  event_names text[] := '{}';
  mail_event text;
  dedupe_key text;
begin
  if booking_id !~ '^[A-Za-z0-9-]{1,40}$' or booking_id ilike 'EVT-%' or checkout_reference = 'EVENT'
      or coalesce(current_row->>'customerName', current_row->>'customername', current_row->>'customer_name', '') like 'EVENT:%' then
    return new;
  end if;

  -- The original booking address is kept stable across updates from legacy clients.
  if length(candidate_email) > 254 or candidate_email !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$' then
    candidate_email := lower(trim(coalesce(current_row->>'email', '')));
  end if;
  if length(candidate_email) <= 254 and candidate_email ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$' then
    insert into reservation_mail.recipients values (booking_id, candidate_email) on conflict do nothing;
  end if;
  select email into recipient_email from reservation_mail.recipients where reservation_id = booking_id;
  if recipient_email is null then return new; end if;

  if tg_op = 'INSERT' then
    if coalesce(next_status, '') not in ('pending', 'confirmed') then return new; end if;
    -- Existing imports or desktop snapshots should not replay old receipts.
    if booking_created is not null then
      begin
        if booking_created::timestamptz < now() - interval '24 hours' then return new; end if;
      exception when invalid_datetime_format or datetime_field_overflow then return new;
      end;
    end if;
    event_names := array_append(event_names, 'booking-received');
  end if;

  -- A deposit saved as part of the initial booking is already covered by
  -- booking-received, so only a later deposit update gets its own email.
  if tg_op = 'UPDATE' and details->>'depositOnFile' = 'true' and previous_details->>'depositOnFile' = 'false'
      and (case when coalesce(details->>'deposit', '') ~ '^[0-9]{1,10}(\.[0-9]{1,4})?$'
        then (details->>'deposit')::numeric > 0 else false end)
      and checkout_reference <> 'TRUSTED_WAIVER' then
    event_names := array_append(event_names, 'deposit-received');
  end if;
  if tg_op = 'UPDATE' then
    if old_status is distinct from next_status then
      case next_status
        when 'confirmed' then
          if old_status = 'pending-reschedule' then
            event_names := array_append(event_names,
              case when next_reason ~ '"decision"[[:space:]]*:[[:space:]]*"rejected"'
                then 'reschedule-declined' else 'rescheduled' end);
          else
            event_names := array_append(event_names, 'confirmed');
          end if;
        when 'checked-in' then event_names := array_append(event_names, 'checked-in');
        when 'completed' then event_names := array_append(event_names, 'completed');
        when 'cancelled' then event_names := array_append(event_names, 'cancelled');
        when 'pending-refund' then event_names := array_append(event_names, 'refund-pending');
        else null;
      end case;
    elsif next_status = 'confirmed' and
        (details->'date', details->'time', details->'hours') is distinct from
        (previous_details->'date', previous_details->'time', previous_details->'hours') then
      event_names := array_append(event_names, 'rescheduled');
    end if;
    if next_refund = 'settled' and old_refund <> 'settled' then
      event_names := array_append(event_names, 'refund-settled');
    end if;
    if coalesce(current_row->>'balancePaid', current_row->>'balancepaid', current_row->>'balance_paid', '') in ('1', 'true')
        and coalesce(previous_row->>'balancePaid', previous_row->>'balancepaid', previous_row->>'balance_paid', '') not in ('1', 'true') then
      event_names := array_append(event_names, 'balance-received');
    end if;
  end if;

  foreach mail_event in array event_names loop
    dedupe_key := case when mail_event = 'rescheduled' then md5(jsonb_build_array(details->'date', details->'time', details->'hours')::text) else '' end;
    insert into reservation_mail.queue (reservation_id, recipient, event, event_key, details)
    values (booking_id, recipient_email, mail_event, dedupe_key, details)
    on conflict (reservation_id, event, event_key) do nothing;
  end loop;
  return new;
end;
$$;

drop trigger if exists enqueue_reservation_emails on public.reservations;
create trigger enqueue_reservation_emails
  after insert or update on public.reservations
  for each row execute function reservation_mail.enqueue_reservation_emails();

-- Lease one queue item. The advisory lock serializes concurrent workers so
-- they share the Gmail rate limit instead of competing for the same rows.
create or replace function public.claim_reservation_email()
returns table(id bigint, claim_token uuid, reservation_id text, recipient text, event text, details jsonb)
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('oneshot-reservation-mail-claim'));
  update reservation_mail.queue as q
    set failed_at = now(), last_error = 'attempt-limit', claim_token = null, lease_until = null
    where q.attempts >= 6 and q.sent_at is null and q.failed_at is null and q.lease_until <= now();

  if (select count(*) from reservation_mail.queue as q
      where q.sent_at >= now() - interval '24 hours' or q.lease_until > now()) >= 150 then return; end if;

  return query
  with candidate as (
    select q.id from reservation_mail.queue as q
    where q.sent_at is null and q.failed_at is null and q.attempts < 6 and q.next_attempt_at <= now()
      and (q.lease_until is null or q.lease_until <= now())
      and not exists (select 1 from reservation_mail.queue as earlier where earlier.reservation_id = q.reservation_id
        and earlier.id < q.id and earlier.sent_at is null and earlier.failed_at is null)
      and (select count(*) from reservation_mail.queue as recent where recent.recipient = q.recipient
        and (recent.sent_at >= now() - interval '1 hour' or recent.lease_until > now())) < 12
    order by q.next_attempt_at, q.id
    limit 1 for update skip locked
  )
  update reservation_mail.queue as q
    set attempts = q.attempts + 1, claim_token = gen_random_uuid(), lease_until = now() + interval '5 minutes'
    from candidate where q.id = candidate.id
    returning q.id, q.claim_token, q.reservation_id, q.recipient, q.event, q.details;
end;
$$;

-- Record the worker's result and schedule a retry with exponential backoff.
create or replace function public.finish_reservation_email(p_id bigint, p_token uuid, p_result text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
begin
  if p_result not in ('sent', 'temporary', 'recipient-rejected', 'invalid-message', 'provider-auth') or p_result is null then
    raise exception 'Invalid reservation email result';
  end if;
  update reservation_mail.queue as q set
    sent_at = case when p_result = 'sent' then now() end,
    failed_at = case when p_result in ('recipient-rejected', 'invalid-message') or (p_result <> 'sent' and q.attempts >= 6) then now() end,
    next_attempt_at = now() + make_interval(mins => least(60, (2 ^ q.attempts)::int)),
    last_error = case when p_result <> 'sent' then p_result end,
    lease_until = null, claim_token = null
    where q.id = p_id and q.claim_token = p_token and q.sent_at is null and q.failed_at is null;
  return found;
end;
$$;

revoke all on function public.claim_reservation_email() from public, anon, authenticated;
revoke all on function public.finish_reservation_email(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_reservation_email() to service_role;
grant execute on function public.finish_reservation_email(bigint, uuid, text) to service_role;
