-- REVIEW CANDIDATE ONLY. Not a migration and never automatically executed.
-- Requires customer-identity.draft.sql first and coordinated customer/gateway cutover; current public booking code is incompatible.
begin;
do $$
begin
  if current_setting('oneshot.secure_gateway_cutover', true) is distinct from 'reviewed' then
    raise exception 'Stop: deploy and verify the authenticated gateway and customer cutover first';
  end if;
end $$;

-- RLS does not govern TRUNCATE. Remove broad table privileges as well as policies.
revoke all on table public.activities, public.announcements, public.closed_dates,
  public.cms, public.e_receipts, public.events, public.feedback, public.inventory,
  public.lost_and_found, public.promo_codes, public.queue, public.reservations,
  public.session_history, public.system_settings, public.system_status,
  public.tables, public.watchlist from public, anon, authenticated;

do $$
declare target text; columns text;
begin
  foreach target in array array['activities','announcements','closed_dates','cms',
    'e_receipts','events','feedback','inventory','lost_and_found','promo_codes',
    'queue','reservations','session_history','system_settings','system_status','tables','watchlist']
  loop
    execute format('alter table public.%I enable row level security', target);
    -- Table REVOKE does not remove separately granted column privileges.
    SELECT string_agg(format('%I',a.attname),', ' ORDER BY a.attnum) INTO columns
      FROM pg_attribute AS a
      WHERE a.attrelid=to_regclass(format('public.%I',target)) AND a.attnum>0 AND NOT a.attisdropped;
    IF columns IS NOT NULL THEN
      EXECUTE format('revoke all (%s) on table public.%I from public, anon, authenticated',columns,target);
    END IF;
  end loop;
end $$;

-- Existing guest bookings remain NULL/unclaimed. Never backfill ownership using an email match.
alter table public.reservations add column if not exists customer_user_id uuid references auth.users(id);
create index if not exists reservations_customer_user_id_idx on public.reservations(customer_user_id);
drop policy if exists "Allow public reservation inserts" on public.reservations;
drop policy if exists "allow public reservation select" on public.reservations;
drop policy if exists "reservation_owner_select" on public.reservations;
create policy reservation_owner_select on public.reservations for select to authenticated
  using ((select auth.uid()) = customer_user_id AND (select oneshot_private.verified_customer()));
-- A later broad permissive policy cannot bypass ownership or fresh-session checks.
drop policy if exists reservation_owner_guard on public.reservations;
create policy reservation_owner_guard on public.reservations as restrictive for select to authenticated
  using ((select auth.uid()) = customer_user_id AND (select oneshot_private.verified_customer()));
grant select on public.reservations to authenticated;
-- No client INSERT/UPDATE/DELETE: ownership alone cannot prevent forged prices, payment,
-- status, reschedule count, schedule overlap, or promo depletion. Gateway owns these writes.

-- Only non-sensitive display columns are available directly. Never grant SELECT * on tables:
-- sessionData/sessiondata include customer details. Anonymous availability comes from gateway.
grant select (id, name, status, isactive, "isActive") on public.tables to anon, authenticated;
-- Existing read policies limit rows only; column grants above prevent session disclosure.
-- Audit new/unknown policies before deployment: policies combine with OR by default.

-- Public content remains read-only. Restrict settings/CMS to a gateway field allowlist instead
-- of granting all setting values (future rows could contain operational secrets).
grant select (id, title, content, type, expiresat, createdat) on public.announcements to anon, authenticated;
drop policy if exists "Public read access" on public.announcements;
drop policy if exists "published_announcements" on public.announcements;
create policy published_announcements on public.announcements for select to anon, authenticated
  using (isactive = 1 and (expiresat is null or expiresat > now()));
-- Gateway provides closures/events/rates/promo quote/feedback/booking APIs. Public direct access
-- to these tables stays revoked until the reviewed per-column contracts are implemented.
commit;
