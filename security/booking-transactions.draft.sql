-- REVIEWED CUTOVER CANDIDATE; no live application. Apply with containment + private storage.
-- Apply customer-identity.draft.sql first. Existing public booking clients are incompatible.
-- Trusted staff gateway remains separate. Every command checks current account + live session
-- before idempotency replay; an old receipt never authorizes a revoked caller.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
do $$ begin
 if current_setting('oneshot.secure_gateway_cutover',true) is distinct from 'reviewed' then
  raise exception 'Stop: reviewed coordinated gateway cutover required';
 end if;
end $$;
create schema if not exists oneshot_private;
revoke all on schema oneshot_private from public;
grant usage on schema oneshot_private to authenticated;
alter table public.reservations add column if not exists customer_user_id uuid references auth.users(id);
alter table public.reservations add column if not exists revision bigint not null default 1;
-- Legacy REAL fields remain compatibility display only. Never infer/backfill unknown ledger cents.
alter table public.reservations add column if not exists total_amount_cents bigint;
alter table public.reservations add column if not exists down_payment_amount_cents bigint;
alter table public.reservations add column if not exists discount_amount_cents bigint;
create index if not exists reservations_customer_user_id_idx on public.reservations(customer_user_id);
create table if not exists oneshot_private.booking_operations (
 customer_user_id uuid not null references auth.users(id), request_id uuid not null,
 operation text not null, payload jsonb not null, result jsonb not null,
 created_at timestamptz not null default now(), primary key(customer_user_id,request_id)
);
alter table oneshot_private.booking_operations enable row level security;
revoke all on oneshot_private.booking_operations from public,anon,authenticated;

create or replace function oneshot_private.booking_command(op text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 uid uuid := auth.uid(); account_email text; req uuid; oldop record;
 r public.reservations%rowtype; result jsonb; cfg jsonb; tbl public.tables%rowtype;
 d date; tm time; duration integer; party integer; table_id text; begins timestamp; ends timestamp;
 anchor date; opening timestamp; closing timestamp; segment timestamp; segment_end timestamp;
 day_cursor date; day_end timestamp; closure record; ev record; fits boolean:=false;
 weekend boolean; prefix text; minimum numeric; maximum numeric; cutoff numeric; party_minimum numeric; party_maximum numeric; peak_occupied bigint;
 rate numeric; base_cents bigint; total_cents bigint; discount_cents bigint:=0; dp_cents bigint;
 promo public.promo_codes%rowtype; promo_code text; operation_result jsonb;
 has_paid boolean; receipt_path text; current_start timestamp; allowed text[];
begin
 if uid is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
 if not oneshot_private.verified_customer() then raise exception 'VERIFIED_ACCOUNT_REQUIRED' using errcode='42501'; end if;
 select email into account_email from auth.users where id=uid and email_confirmed_at is not null and coalesce(is_anonymous,false)=false;
 if account_email is null then raise exception 'VERIFIED_ACCOUNT_REQUIRED' using errcode='42501'; end if;
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>16384 then raise exception 'INVALID_PAYLOAD'; end if;
 allowed:=case op when 'create' then array['requestId','tableId','date','timeSlot','durationHours','partySize','customerName','contactNumber','promoCode','paymentRef','receiptPath','acceptedTerms','expectedTerms','expectedTotalCents','expectedDownPaymentCents'] when 'reschedule' then array['requestId','id','expectedRevision','date','timeSlot'] when 'cancel' then array['requestId','id','expectedRevision','reason'] else array[]::text[] end;
 allowed:=array_append(allowed,'expectedCustomerId');
 if p->>'expectedCustomerId' is distinct from uid::text then raise exception 'ACCOUNT_CHANGED' using errcode='42501'; end if;
 if cardinality(allowed)=1 or exists(select 1 from jsonb_object_keys(p) k where not(k=any(allowed))) then raise exception 'INVALID_FIELDS'; end if;
 begin req:=(p->>'requestId')::uuid; exception when others then raise exception 'INVALID_REQUEST_ID'; end;
 if req is null then raise exception 'INVALID_REQUEST_ID'; end if;
 -- Transaction-level serialization prevents missing-row/phantom conflicts, config edit races,
 -- duplicate promo depletion and concurrent staff writes. All writers take normal DML locks.
 -- Fixed lock order across create/reschedule/cancel. Deliberately coarse for capstone scale.
 lock table public.system_settings,public.closed_dates,public.events,public.tables,public.promo_codes,public.reservations,oneshot_private.booking_operations in share row exclusive mode;
 select * into oldop from oneshot_private.booking_operations where customer_user_id=uid and request_id=req;
 if found then
  if oldop.operation<>op or oldop.payload<>p then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return oldop.result || jsonb_build_object('replayed',true);
 end if;
 select jsonb_object_agg(key_name,setting_value) into cfg from public.system_settings;
 if op<>'create' then
  select * into r from public.reservations where id=p->>'id' and customer_user_id=uid for update;
  if not found then raise exception 'BOOKING_NOT_FOUND' using errcode='42501'; end if;
  if (p->>'expectedRevision') is null or (p->>'expectedRevision')::bigint<>r.revision then raise exception 'STALE_REVISION'; end if;
  if r.date is null or r."timeSlot" is null or r."timeSlot" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'BOOKING_RECONCILIATION_REQUIRED'; end if;
  if r.total_amount_cents is null or r.down_payment_amount_cents is null or r.discount_amount_cents is null or r.total_amount_cents<0 or r.down_payment_amount_cents<0 or r.discount_amount_cents<0 then raise exception 'BOOKING_FINANCIAL_RECONCILIATION_REQUIRED'; end if;
  current_start:=r.date+r."timeSlot"::time;
  if current_start <= timezone('Asia/Manila',statement_timestamp()) then raise exception 'BOOKING_ALREADY_STARTED'; end if;
 end if;
 if op='cancel' then
  if coalesce(r.status,'') not in ('pending','confirmed') then raise exception 'CANCELLATION_STATE_NOT_ALLOWED'; end if;
  cutoff:=(cfg->>'cancellationHours')::numeric;
  if cutoff is null or cutoff<0 or cutoff>8760 then raise exception 'CONFIG_INVALID'; end if;
  if current_start < timezone('Asia/Manila',statement_timestamp()) + cutoff*interval '1 hour' then raise exception 'CANCELLATION_CUTOFF'; end if;
  if length(coalesce(p->>'reason',''))>500 then raise exception 'INVALID_REASON'; end if;
  if coalesce(r."downPaymentPaid",0) not in (0,1) or coalesce(r."balancePaid",0) not in (0,1) or coalesce(r.balancepaid,0) not in (0,1) then raise exception 'PAYMENT_STATE_RECONCILIATION_REQUIRED'; end if;
  has_paid:=coalesce(r."downPaymentPaid",0)=1 or coalesce(r."balancePaid",0)=1 or coalesce(r.balancepaid,0)=1;
  update public.reservations set status=case when has_paid then 'pending-refund' else 'cancelled' end,
   cancellationreason=coalesce(nullif(p->>'reason',''),'Customer cancellation'),cancellation_reason=coalesce(nullif(p->>'reason',''),'Customer cancellation'),
   "refundStatus"=case when has_paid then 'pending' else null end,revision=revision+1
   where id=r.id returning * into r;
 else
  d:=(p->>'date')::date;
  if p->>'timeSlot' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or d is null then raise exception 'INVALID_SLOT'; end if;
  tm:=(p->>'timeSlot')::time;
  if op='create' then
   duration:=(p->>'durationHours')::integer; party:=(p->>'partySize')::integer; table_id:=p->>'tableId';
   if p->>'durationHours' !~ '^[0-9]+$' or p->>'partySize' !~ '^[0-9]+$' or duration is null or party is null then raise exception 'INVALID_PARTY_OR_DURATION'; end if;
  else
   cutoff:=(cfg->>'cancellationHours')::numeric;
   if cutoff is null or cutoff<0 or current_start < timezone('Asia/Manila',statement_timestamp())+cutoff*interval '1 hour' then raise exception 'RESCHEDULE_CUTOFF'; end if;
   if coalesce(r.status,'') not in ('pending','confirmed') or coalesce(r."downPaymentPaid",0) not in (0,1) or coalesce(r."balancePaid",0) not in (0,1) or coalesce(r.balancepaid,0) not in (0,1) then raise exception 'RESCHEDULE_STATE_NOT_ALLOWED'; end if;
   if coalesce(r."rescheduleCount",0)>=1 then raise exception 'RESCHEDULE_LIMIT'; end if;
   duration:=r."durationHours"; party:=r."partySize"; table_id:=r."tableId";
  end if;
  begins:=d+tm; ends:=begins+duration*interval '1 hour'; weekend:=extract(dow from d) in (0,5,6); prefix:=case when weekend then 'weekend' else 'weekday' end;
  minimum:=(cfg->>'minHours')::numeric; maximum:=(cfg->>'maxHours')::numeric;
  cutoff:=(cfg->>'advanceBookingHours')::numeric;
  if minimum is null or maximum is null or cutoff is null or minimum<1 or maximum>24 or maximum<minimum or cutoff<0 then raise exception 'CONFIG_INVALID'; end if;
  if coalesce(btrim(cfg->>(prefix||'MinPartySize')),'') !~ '^[0-9]+([.][0-9]+)?$' or coalesce(btrim(cfg->>(prefix||'MaxPartySize')),'') !~ '^[0-9]+([.][0-9]+)?$' then raise exception 'CONFIG_INVALID'; end if;
  party_minimum:=(cfg->>(prefix||'MinPartySize'))::numeric; party_maximum:=(cfg->>(prefix||'MaxPartySize'))::numeric;
  if party_minimum<1 or party_maximum<party_minimum or party_minimum<>trunc(party_minimum) or party_maximum<>trunc(party_maximum) or party_maximum>9007199254740991 then raise exception 'CONFIG_INVALID'; end if;
  if duration<minimum or duration>maximum or party<1 or party<party_minimum or party>party_maximum then raise exception 'INVALID_PARTY_OR_DURATION'; end if;
  if begins <= timezone('Asia/Manila',statement_timestamp()) or begins < timezone('Asia/Manila',statement_timestamp())+cutoff*interval '1 hour' then raise exception 'ADVANCE_CUTOFF'; end if;
  if begins > timezone('Asia/Manila',statement_timestamp())+interval '366 days' then raise exception 'BOOKING_HORIZON'; end if;
  -- A calendar-day early morning slot can belong to yesterday's operating window.
  for anchor in select generate_series(d-1,d,interval '1 day')::date loop
   prefix:=case when extract(dow from anchor) in (0,5,6) then 'weekend' else 'weekday' end;
   if cfg->>(prefix||'StartTime') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or cfg->>(prefix||'EndTime') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or cfg->>(prefix||'StartTime') is null or cfg->>(prefix||'EndTime') is null then raise exception 'CONFIG_INVALID'; end if;
   opening:=anchor+(cfg->>(prefix||'StartTime'))::time; closing:=anchor+(cfg->>(prefix||'EndTime'))::time;
   if closing<=opening then closing:=closing+interval '1 day'; end if;
   if begins>=opening and ends<=closing then fits:=true; end if;
  end loop;
  if not fits then raise exception 'OUTSIDE_OPERATING_HOURS'; end if;
  for day_cursor in select generate_series(d,ends::date,interval '1 day')::date loop
   day_end:=day_cursor+interval '1 day'; segment:=greatest(begins,day_cursor::timestamp); segment_end:=least(ends,day_end);
   if segment>=segment_end then continue; end if;
   for closure in select * from public.closed_dates where coalesce(status,'')<>'cancelled' and cancelled_at is null and ((type='weekly' and day_of_week=extract(dow from day_cursor)) or (coalesce(type,'')<>'weekly' and closed_date=day_cursor)) loop
    if coalesce(closure.is_full_day,true) then raise exception 'CLOSED_DATE'; end if;
    if closure.open_time is null or closure.close_time is null or closure.open_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or closure.close_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'CLOSURE_CONFIG_INVALID'; end if;
    opening:=day_cursor+closure.open_time::time; closing:=day_cursor+closure.close_time::time;
    if closure.close_time='00:00' then closing:=day_end; end if;
    if closing>opening then
     if segment<opening or segment_end>closing then raise exception 'PARTIAL_CLOSURE'; end if;
    elsif not ((segment>=opening and segment_end<=day_end) or (segment>=day_cursor::timestamp and segment_end<=closing)) then raise exception 'PARTIAL_CLOSURE'; end if;
   end loop;
   -- Event table allocation has no trusted per-table mapping. Fail closed for active event dates,
   -- including allowreservations=1, until operator-approved allocation is represented explicitly.
   if exists(select 1 from public.events where date=day_cursor and coalesce(iscancelled,0)=0 and coalesce(status,'')<>'cancelled' and cancelled_at is null) then raise exception 'EVENT_ALLOCATION_REQUIRED'; end if;
  end loop;
  select * into tbl from public.tables where id=table_id for update;
  if not found or tbl."isActive" is distinct from 1 or tbl.isactive is distinct from 1 or tbl.status is distinct from 'available' then raise exception 'TABLE_UNAVAILABLE'; end if;
  if coalesce(nullif(tbl."sessionData",''),'null') not in ('null','{}') or coalesce(nullif(tbl.sessiondata,''),'null') not in ('null','{}') then raise exception 'ACTIVE_SESSION'; end if;
  if exists(select 1 from public.reservations x where coalesce(x.status,'') not in ('cancelled','completed','pending-refund') and (x.date is null or x."timeSlot" is null or x."timeSlot" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or x."durationHours" is null or x."durationHours"<1 or x."durationHours">24 or x."tableId" is null)) then raise exception 'ACTIVE_BOOKINGS_RECONCILIATION_REQUIRED'; end if;
  if exists(select 1 from public.reservations x where x."tableId"=table_id and (op='create' or x.id<>r.id) and coalesce(x.status,'') not in ('cancelled','completed','pending-refund') and (x.date+x."timeSlot"::time)<ends and (x.date+x."timeSlot"::time+x."durationHours"*interval '1 hour')>begins) then raise exception 'TABLE_CONFLICT'; end if;
  -- New explicit operator-reviewed unit avoids silently interpreting legacy 6 as 6%.
  if cfg->>'bookingCapacityMode' is distinct from 'tables' then raise exception 'CONFIG_CAPACITY_REVIEW_REQUIRED'; end if;
  prefix:=case when weekend then 'weekend' else 'weekday' end;
  if coalesce(btrim(cfg->>(prefix||'OnlineCapacityLimit')),'') !~ '^[0-9]+([.][0-9]+)?$' then raise exception 'CONFIG_INVALID'; end if;
  maximum:=(cfg->>(prefix||'OnlineCapacityLimit'))::numeric;
  if maximum is null or maximum<0 or maximum<>trunc(maximum) or maximum>9007199254740991 then raise exception 'CONFIG_INVALID'; end if;
  -- Half-open intervals: simultaneous end/start events are grouped before the running sum.
  -- Count peak occupancy within the requested interval, not all rows touching any part of it.
  with intervals as (
   select greatest(begins,x.date+x."timeSlot"::time) as starts_at,
    least(ends,x.date+x."timeSlot"::time+x."durationHours"*interval '1 hour') as ends_at
   from public.reservations x where (op='create' or x.id<>r.id)
    and coalesce(x.status,'') not in ('cancelled','completed','pending-refund')
    and (x.date+x."timeSlot"::time)<ends and (x.date+x."timeSlot"::time+x."durationHours"*interval '1 hour')>begins
  ), changes as (
   select starts_at as at_time,1 as delta from intervals union all select ends_at,-1 from intervals
  ), grouped as (select at_time,sum(delta) as delta from changes group by at_time),
  occupancy as (select at_time,sum(delta) over(order by at_time rows unbounded preceding) as used from grouped)
  select coalesce(max(used),0) into peak_occupied from occupancy where at_time<ends;
  if peak_occupied>=maximum then raise exception 'ONLINE_CAPACITY'; end if;
  if op='create' then
   if length(trim(coalesce(cfg->>'termsAndConditions','')))=0 then raise exception 'CONFIG_TERMS_REQUIRED'; end if;
   if p->'acceptedTerms' is distinct from 'true'::jsonb or p->>'expectedTerms' is distinct from cfg->>'termsAndConditions' then raise exception 'TERMS_CHANGED'; end if;
   if length(trim(coalesce(p->>'customerName','')))<2 or length(p->>'customerName')>120 or coalesce(p->>'contactNumber','') !~ '^\+?[0-9][0-9 -]{6,24}$' then raise exception 'INVALID_CONTACT'; end if;
   rate:=(cfg->>'hourlyRate')::numeric;
   if rate is null or rate<0 or rate>100000 or rate*100<>trunc(rate*100) or (cfg->>'downPaymentPercent') is null or (cfg->>'downPaymentPercent')::numeric not between 0 and 100 then raise exception 'CONFIG_INVALID'; end if;
   base_cents:=(rate*100)::bigint*duration;
   promo_code:=nullif(upper(trim(coalesce(p->>'promoCode',''))),'');
   if promo_code is not null then
    if (select count(*) from public.promo_codes where upper(code)=promo_code)<>1 then raise exception 'PROMO_UNAVAILABLE'; end if;
    select * into promo from public.promo_codes where upper(code)=promo_code for update;
    if not found or promo.is_active is distinct from true or promo.discount_percent is null or promo.discount_percent<=0 or promo.discount_percent>100 or (promo.start_date is not null and promo.start_date>statement_timestamp()) or (promo.expires_at is not null and promo.expires_at<=statement_timestamp()) or (coalesce(promo.is_limited_uses,false) and (promo.max_usage is null or coalesce(promo.usage_count,0)>=promo.max_usage)) then raise exception 'PROMO_UNAVAILABLE'; end if;
    discount_cents:=floor(base_cents*promo.discount_percent::numeric/10000)*100;
   end if;
   total_cents:=base_cents-discount_cents; dp_cents:=least(total_cents,ceil(total_cents*(cfg->>'downPaymentPercent')::numeric/10000)*100);
   if (p->>'expectedTotalCents')::bigint is distinct from total_cents or (p->>'expectedDownPaymentCents')::bigint is distinct from dp_cents then
    raise exception 'QUOTE_CHANGED' using detail=jsonb_build_object('totalCents',total_cents,'downPaymentCents',dp_cents,'discountCents',discount_cents)::text;
   end if;
   receipt_path:=nullif(p->>'receiptPath','');
   if dp_cents>0 and (receipt_path is null and length(trim(coalesce(p->>'paymentRef','')))<3) then raise exception 'PAYMENT_EVIDENCE_REQUIRED'; end if;
   if length(coalesce(p->>'paymentRef',''))>120 then raise exception 'INVALID_PAYMENT_REFERENCE'; end if;
   if receipt_path is not null then
    if receipt_path !~ ('^'||uid::text||'/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(jpg|png)$') or not exists(select 1 from storage.objects where bucket_id='oneshot-receipts' and name=receipt_path and owner_id=uid::text for share) then raise exception 'RECEIPT_NOT_OWNED'; end if;
    if exists(select 1 from public.reservations where "receiptImg"=receipt_path) then raise exception 'RECEIPT_ALREADY_USED'; end if;
   end if;
   insert into public.reservations(id,"customerName","contactNumber",email,date,"timeSlot","durationHours","partySize","tableId",status,"totalAmount","downPaymentAmount","downPaymentPaid",balancepaid,"balancePaid",promocode,"promoCode","discountAmount","createdAt","receiptImg","paymentRef","rescheduleCount",customer_user_id,revision,total_amount_cents,down_payment_amount_cents,discount_amount_cents)
   values(gen_random_uuid()::text,trim(p->>'customerName'),trim(p->>'contactNumber'),account_email,d,to_char(tm,'HH24:MI'),duration,party,table_id,'pending',total_cents::numeric/100,dp_cents::numeric/100,0,0,0,promo_code,promo_code,discount_cents::numeric/100,statement_timestamp(),receipt_path,nullif(trim(p->>'paymentRef'),''),0,uid,1,total_cents,dp_cents,discount_cents) returning * into r;
   if promo_code is not null then update public.promo_codes set usage_count=coalesce(usage_count,0)+1 where id=promo.id; end if;
  else
   update public.reservations set date=d,"timeSlot"=to_char(tm,'HH24:MI'),"rescheduleCount"=coalesce("rescheduleCount",0)+1,revision=revision+1 where id=r.id returning * into r;
  end if;
 end if;
 operation_result:=jsonb_build_object('reservation',to_jsonb(r)||jsonb_build_object('totalAmount',r.total_amount_cents::numeric/100,'downPaymentAmount',r.down_payment_amount_cents::numeric/100,'discountAmount',r.discount_amount_cents::numeric/100),'replayed',false);
 insert into oneshot_private.booking_operations(customer_user_id,request_id,operation,payload,result) values(uid,req,op,p,operation_result);
 return operation_result;
end $$;
revoke all on function oneshot_private.booking_command(text,jsonb) from public,anon,authenticated;
grant execute on function oneshot_private.booking_command(text,jsonb) to authenticated;
create or replace function public.oneshot_booking_create(payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select oneshot_private.booking_command('create',payload)$$;
create or replace function public.oneshot_booking_reschedule(payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select oneshot_private.booking_command('reschedule',payload)$$;
create or replace function public.oneshot_booking_cancel(payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select oneshot_private.booking_command('cancel',payload)$$;
revoke all on function public.oneshot_booking_create(jsonb),public.oneshot_booking_reschedule(jsonb),public.oneshot_booking_cancel(jsonb) from public,anon,authenticated;
grant execute on function public.oneshot_booking_create(jsonb),public.oneshot_booking_reschedule(jsonb),public.oneshot_booking_cancel(jsonb) to authenticated;
-- Require the matching containment policy cutover: direct client writes remain forbidden.
revoke insert,update,delete,truncate,references,trigger,maintain on public.reservations from public,anon,authenticated;
commit;
