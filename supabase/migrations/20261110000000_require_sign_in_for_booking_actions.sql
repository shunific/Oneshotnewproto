begin;

create or replace function public.request_booking_reschedule(
  booking_id text, booking_contact text, requested_date date, requested_time text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  local_now timestamp := now() at time zone 'Asia/Manila';
  matched integer;
begin
  if auth.uid() is null or booking_contact is null or length(btrim(booking_contact)) < 5
     or requested_date is null or requested_time is null
     or requested_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return false;
  end if;
  if requested_date + requested_time::time <= local_now
     or requested_date > local_now::date + 30 then
    return false;
  end if;

  update public.reservations as r
  set "rescheduleCount" = 1,
      requested_reschedule_date = requested_date,
      requested_reschedule_time = requested_time
  where r.id = booking_id
    and r.status in ('pending', 'confirmed')
    and coalesce(r."rescheduleCount", 0) = 0
    and (r.date is distinct from requested_date or r."timeSlot" is distinct from requested_time)
    and (lower(btrim(r.email)) = lower(btrim(booking_contact))
         or (booking_contact ~ '^[+0-9 ()-]+$'
             and length(regexp_replace(booking_contact, '[^0-9]', '', 'g')) >= 7
             and regexp_replace(r."contactNumber", '[^0-9]', '', 'g') =
                 regexp_replace(booking_contact, '[^0-9]', '', 'g')));
  get diagnostics matched = row_count;
  return matched = 1;
end;
$$;

revoke all on function public.request_booking_reschedule(text, text, date, text) from public, anon, service_role;
grant execute on function public.request_booking_reschedule(text, text, date, text) to authenticated;


create or replace function public.request_booking_refund(booking_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_email text := lower(btrim(auth.jwt() ->> 'email'));
  matched integer;
begin
  if auth.uid() is null or coalesce(account_email, '') = '' then
    return false;
  end if;

  update public.reservations as r
  set status = 'pending-refund',
      cancellation_reason = 'Customer requested cancellation & refund'
  where r.id = booking_id
    and lower(btrim(r.email)) = account_email
    and r.status in ('pending', 'confirmed', 'pending-reschedule');
  get diagnostics matched = row_count;
  return matched = 1;
end;
$$;

revoke all on function public.request_booking_refund(text) from public, anon, service_role;
grant execute on function public.request_booking_refund(text) to authenticated;

commit;
