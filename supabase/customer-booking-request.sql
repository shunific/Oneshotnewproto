-- Customer requests change the review status only. Staff approve the actual date or refund.
create or replace function public.request_booking_change(
  booking_id text, request_kind text, requested_day date default null,
  requested_time time default null, request_reason text default null
) returns text language plpgsql security invoker set search_path = '' as $$
declare
  booking public.reservations%rowtype;
  target_status text;
  reason text;
begin
  if auth.uid() is null then raise exception 'Sign in to manage your reservation.'; end if;
  select * into booking from public.reservations r
    where r.id = booking_id and lower(trim(r.email)) = lower(nullif(trim(auth.jwt()->>'email'),''))
    for update;
  if not found then raise exception 'Reservation unavailable for this account.'; end if;
  if request_kind = 'refund' then
    target_status := 'pending-refund';
    reason := 'Customer requested cancellation & refund';
  elsif request_kind = 'reschedule' then
    target_status := 'pending-reschedule';
    if requested_day is null or requested_time is null or nullif(trim(request_reason),'') is null
       or length(request_reason) > 300 then raise exception 'Choose a date, time and reason.'; end if;
    reason := '__RESCHEDULE_REQUEST__' || jsonb_build_object('requestedDate',requested_day,
      'requestedTime',to_char(requested_time,'HH24:MI'),'reason',trim(request_reason))::text;
  else raise exception 'Unknown request type.';
  end if;
  if booking.status = target_status and booking.cancellation_reason = reason then return target_status; end if;
  if booking.status not in ('confirmed','pending') and not (request_kind='refund' and booking.status='pending-reschedule')
    then raise exception 'This booking has changed. Refresh its status.'; end if;
  if request_kind='reschedule' and (coalesce(booking."rescheduleCount",0) >= 1 or
      requested_day + requested_time < timezone('Asia/Manila', now()) + interval '60 minutes'
      or requested_day > timezone('Asia/Manila', now())::date + 30)
    then raise exception 'This reservation cannot be rescheduled to that date and time.'; end if;
  update public.reservations set status=target_status, cancellation_reason=reason, cancellationreason=reason,
    "refundStatus"=case when request_kind='refund' then 'pending' else "refundStatus" end
    where id=booking_id;
  return target_status;
end $$;
revoke all on function public.request_booking_change(text,text,date,time,text) from public, anon;
grant execute on function public.request_booking_change(text,text,date,time,text) to authenticated;
