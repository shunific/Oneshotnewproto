-- REVIEW CANDIDATE ONLY: apply customer identity, bookings, private receipts and staff identity first.
-- Human payment verification records an external cash/GCash receipt. It never transfers funds.
begin;
set local lock_timeout='3s'; set local statement_timeout='10s';
do $$begin if current_setting('oneshot.secure_gateway_cutover',true) is distinct from 'reviewed' then raise exception 'Stop: reviewed coordinated gateway cutover required'; end if; end$$;
create table if not exists oneshot_private.staff_payment_verifications (
 id uuid primary key default gen_random_uuid(),reservation_id text not null references public.reservations(id),
 payment_kind text not null check(payment_kind in ('deposit','balance')), amount_cents bigint not null check(amount_cents>0),
 method text not null check(method in ('cash','gcash')),reference text,
 actor_user_id uuid not null references auth.users(id),actor_role text not null check(actor_role in ('cashier','manager')),
 actor_email text not null,venue_id text not null default 'oneshot' check(venue_id='oneshot'),
 created_at timestamptz not null default now(),unique(reservation_id,payment_kind)
);
-- No batch-payment allocation exists: one normalized GCash transfer reference may back
-- exactly one verification. Unsupported batch cases require manager reconciliation.
create unique index if not exists staff_payment_gcash_reference_unique
 on oneshot_private.staff_payment_verifications ((upper(translate(btrim(reference),' -','') collate "C")))
 where method='gcash';
create table if not exists oneshot_private.staff_payment_operations (
 actor_user_id uuid not null references auth.users(id),request_id uuid not null,operation text not null default 'payment' check(operation in ('payment','approval')),payload jsonb not null,result jsonb not null,
 created_at timestamptz not null default now(),primary key(actor_user_id,request_id)
);
-- The preceding reviewed RC exposed payment operations only. Its rows have that known
-- provenance; adding DEFAULT payment preserves their meaning without inspecting payloads.
alter table oneshot_private.staff_payment_operations add column if not exists operation text not null default 'payment';
alter table oneshot_private.staff_payment_operations alter column operation set default 'payment';
alter table oneshot_private.staff_payment_operations alter column operation set not null;
do $$begin
 if not exists(select 1 from pg_constraint where conrelid='oneshot_private.staff_payment_operations'::regclass and conname='staff_payment_operations_operation_check') then
  alter table oneshot_private.staff_payment_operations add constraint staff_payment_operations_operation_check check(operation in ('payment','approval'));
 end if;
end$$;
alter table oneshot_private.staff_payment_operations validate constraint staff_payment_operations_operation_check;
alter table oneshot_private.staff_payment_verifications enable row level security;
alter table oneshot_private.staff_payment_operations enable row level security;
revoke all on oneshot_private.staff_payment_verifications,oneshot_private.staff_payment_operations from public,anon,authenticated;

create or replace function oneshot_private.staff_reservation_json(r public.reservations) returns jsonb
language sql stable security definer set search_path='' as $$
 select to_jsonb(r)||jsonb_build_object(
 'totalAmount',case when r.total_amount_cents is not null then r.total_amount_cents::numeric/100 else null end,
 'downPaymentAmount',case when r.down_payment_amount_cents is not null then r.down_payment_amount_cents::numeric/100 else null end,
 'discountAmount',case when r.discount_amount_cents is not null then r.discount_amount_cents::numeric/100 else null end,
 'paymentSummary',jsonb_build_object('verifiedPaidCents',coalesce((select sum(v.amount_cents) from oneshot_private.staff_payment_verifications v where v.reservation_id=r.id),0),
 'remainingCents',r.total_amount_cents-coalesce((select sum(v.amount_cents) from oneshot_private.staff_payment_verifications v where v.reservation_id=r.id),0)))
$$;
revoke all on function oneshot_private.staff_reservation_json(public.reservations) from public,anon,authenticated;

create or replace function oneshot_private.staff_reservations(p_from date,p_to date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not oneshot_private.verified_staff() then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>93 then raise exception 'INVALID_DATE_RANGE'; end if;
 select coalesce(jsonb_agg(oneshot_private.staff_reservation_json(r::public.reservations) order by r.date,r."timeSlot",r.id),'[]'::jsonb) into result from (select x.* from public.reservations x where x.date between p_from and p_to order by x.date,x."timeSlot",x.id limit 1001) r;
 if jsonb_array_length(result)>1000 then raise exception 'LIST_LIMIT'; end if;
 return jsonb_build_object('reservations',result,'recordType','external-payment-verification','fundsTransferred',false);
end$$;
revoke all on function oneshot_private.staff_reservations(date,date) from public,anon,authenticated;
grant execute on function oneshot_private.staff_reservations(date,date) to authenticated;
create or replace function public.oneshot_staff_reservations(p_from date,p_to date) returns jsonb language sql security invoker set search_path='' as $$select oneshot_private.staff_reservations(p_from,p_to)$$;
revoke all on function public.oneshot_staff_reservations(date,date) from public,anon,authenticated;
grant execute on function public.oneshot_staff_reservations(date,date) to authenticated;

create or replace function oneshot_private.staff_confirm_payment(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); role_name text; actor_email text; req uuid; oldop record;
 r public.reservations%rowtype; v oneshot_private.staff_payment_verifications%rowtype;
 paid bigint; due bigint; deposit_paid integer; balance_paid integer; kind text; method_name text; ref text; result jsonb;
begin
 -- Check current account/session and authoritative membership before returning even an old result.
 if not oneshot_private.verified_staff() then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 role_name:=oneshot_private.staff_role(); select email into actor_email from auth.users where id=uid;
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>8192 then raise exception 'INVALID_PAYLOAD'; end if;
 if exists(select 1 from jsonb_object_keys(p) k where not(k=any(array['requestId','id','expectedRevision','paymentKind','method','reference','expectedAmountCents','expectedStaffId']))) then raise exception 'INVALID_FIELDS'; end if;
 if p->>'expectedStaffId' is distinct from uid::text then raise exception 'ACCOUNT_CHANGED' using errcode='42501'; end if;
 req:=(p->>'requestId')::uuid;
 if req is null or length(coalesce(p->>'id','')) not between 1 and 120 then raise exception 'INVALID_REQUEST'; end if;
 -- Match customer command lock order before row locks to prevent lock upgrades deadlocking.
 lock table public.reservations in row exclusive mode;
 perform pg_advisory_xact_lock(hashtextextended(uid::text||req::text,0));
 select * into oldop from oneshot_private.staff_payment_operations where actor_user_id=uid and request_id=req;
 if found then if oldop.operation<>'payment' or oldop.payload<>p then raise exception 'IDEMPOTENCY_CONFLICT'; end if; return oldop.result||jsonb_build_object('replayed',true); end if;
 select * into r from public.reservations where id=p->>'id' for update;
 if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
 if (p->>'expectedRevision') is null or (p->>'expectedRevision')::bigint<>r.revision then raise exception 'STALE_REVISION'; end if;
 if coalesce(r.status,'') not in ('pending','confirmed') then raise exception 'PAYMENT_STATE_NOT_ALLOWED'; end if;
 if r.total_amount_cents is null or r.down_payment_amount_cents is null or r.discount_amount_cents is null or r.total_amount_cents<0 or r.total_amount_cents>240000000 or r.down_payment_amount_cents<0 or r.down_payment_amount_cents>r.total_amount_cents or r.discount_amount_cents<0 then raise exception 'BOOKING_FINANCIAL_RECONCILIATION_REQUIRED'; end if;
 select coalesce(sum(amount_cents),0) into paid from oneshot_private.staff_payment_verifications where reservation_id=r.id;
 if paid>r.total_amount_cents then raise exception 'BOOKING_FINANCIAL_RECONCILIATION_REQUIRED'; end if;
 deposit_paid:=case when paid>=r.down_payment_amount_cents and paid>0 then 1 else 0 end;
 balance_paid:=case when paid>=r.total_amount_cents and paid>0 then 1 else 0 end;
 -- Legacy paid flags without an authoritative verification ledger cannot be guessed or charged again.
 if coalesce(r."downPaymentPaid",0)<>deposit_paid or coalesce(r."balancePaid",0)<>balance_paid or coalesce(r.balancepaid,0)<>balance_paid then raise exception 'PAYMENT_LEDGER_RECONCILIATION_REQUIRED'; end if;
 kind:=p->>'paymentKind'; method_name:=p->>'method'; ref:=nullif(trim(coalesce(p->>'reference','')),'');
 if kind is null or kind not in ('deposit','balance') or method_name is null or method_name not in ('cash','gcash') or length(coalesce(ref,''))>120 or (method_name='gcash' and length(coalesce(ref,''))<3) then raise exception 'INVALID_PAYMENT'; end if;
 if method_name='gcash' and (translate(ref,'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -','')<>'' or length(translate(ref,' -',''))<3) then raise exception 'INVALID_PAYMENT_REFERENCE'; end if;
 if exists(select 1 from oneshot_private.staff_payment_verifications where reservation_id=r.id and payment_kind=kind) then raise exception 'PAYMENT_ALREADY_VERIFIED'; end if;
 due:=case when kind='deposit' then r.down_payment_amount_cents else r.total_amount_cents-paid end;
 if due<=0 or paid+due>r.total_amount_cents then raise exception 'NO_PAYMENT_DUE'; end if;
 if kind='deposit' and paid<>0 then raise exception 'NO_PAYMENT_DUE'; end if;
 if (p->>'expectedAmountCents') is null or (p->>'expectedAmountCents')::bigint<>due then raise exception 'PAYMENT_AMOUNT_CHANGED' using detail=jsonb_build_object('amountCents',due,'verifiedPaidCents',paid,'remainingCents',r.total_amount_cents-paid)::text; end if;
 begin
  insert into oneshot_private.staff_payment_verifications(reservation_id,payment_kind,amount_cents,method,reference,actor_user_id,actor_role,actor_email)
  values(r.id,kind,due,method_name,ref,uid,role_name,actor_email) returning * into v;
 exception when unique_violation then
  if method_name='gcash' and exists(select 1 from oneshot_private.staff_payment_verifications where method='gcash' and upper(translate(btrim(reference),' -','') collate "C")=upper(translate(btrim(ref),' -','') collate "C")) then raise exception 'REFERENCE_ALREADY_RECORDED'; end if;
  raise;
 end;
 paid:=paid+due;
 update public.reservations set "downPaymentPaid"=case when paid>=down_payment_amount_cents then 1 else 0 end,
 "balancePaid"=case when paid>=total_amount_cents then 1 else 0 end,balancepaid=case when paid>=total_amount_cents then 1 else 0 end,
 status=case when status='pending' then 'confirmed' else status end,revision=revision+1 where id=r.id returning * into r;
 result:=jsonb_build_object('reservation',oneshot_private.staff_reservation_json(r),'verification',jsonb_build_object('id',v.id,'amountCents',v.amount_cents,'paymentKind',v.payment_kind,'method',v.method,'reference',v.reference,'actorUserId',v.actor_user_id,'actorRole',v.actor_role,'recordType','external-payment-verification','fundsTransferred',false),'replayed',false);
 insert into oneshot_private.staff_payment_operations(actor_user_id,request_id,payload,result) values(uid,req,p,result);
 return result;
end$$;
revoke all on function oneshot_private.staff_confirm_payment(jsonb) from public,anon,authenticated;
grant execute on function oneshot_private.staff_confirm_payment(jsonb) to authenticated;
create or replace function public.oneshot_staff_confirm_payment(payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select oneshot_private.staff_confirm_payment(payload)$$;
revoke all on function public.oneshot_staff_confirm_payment(jsonb) from public,anon,authenticated;
grant execute on function public.oneshot_staff_confirm_payment(jsonb) to authenticated;

-- Staff requests a reservation identifier, never an arbitrary storage path or external URL.
create or replace function oneshot_private.staff_receipt(p_reservation_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.reservations%rowtype;
begin
 if not oneshot_private.verified_staff() then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 if p_reservation_id is null or length(p_reservation_id) not between 1 and 120 then raise exception 'INVALID_REQUEST'; end if;
 select * into r from public.reservations where id=p_reservation_id;
 if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
 if r.customer_user_id is null or r."receiptImg" is null or r."receiptImg" !~ ('^'||r.customer_user_id::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$') then raise exception 'PRIVATE_RECEIPT_REQUIRED'; end if;
 if not exists(select 1 from storage.objects where bucket_id='oneshot-receipts' and name=r."receiptImg" and owner_id=r.customer_user_id::text) then raise exception 'RECEIPT_NOT_FOUND'; end if;
 return jsonb_build_object('path',r."receiptImg",'reservationId',r.id);
end$$;
revoke all on function oneshot_private.staff_receipt(text) from public,anon,authenticated;
grant execute on function oneshot_private.staff_receipt(text) to authenticated;
create or replace function public.oneshot_staff_receipt(p_reservation_id text) returns jsonb language sql security invoker set search_path='' as $$select oneshot_private.staff_receipt(p_reservation_id)$$;
revoke all on function public.oneshot_staff_receipt(text) from public,anon,authenticated;
grant execute on function public.oneshot_staff_receipt(text) to authenticated;


-- A booking may require no deposit. Approval confirms the reservation without inventing
-- a zero-value payment, changing payment flags or representing a funds transfer.
create table if not exists oneshot_private.staff_booking_approvals (
 id uuid primary key default gen_random_uuid(),reservation_id text not null unique references public.reservations(id),
 actor_user_id uuid not null references auth.users(id),actor_role text not null check(actor_role in ('cashier','manager')),
 actor_email text not null,venue_id text not null default 'oneshot' check(venue_id='oneshot'),
 total_amount_cents bigint not null check(total_amount_cents>=0),down_payment_amount_cents bigint not null check(down_payment_amount_cents=0),
 created_at timestamptz not null default now()
);
alter table oneshot_private.staff_booking_approvals enable row level security;
revoke all on oneshot_private.staff_booking_approvals from public,anon,authenticated;
create or replace function oneshot_private.staff_approve_booking(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); role_name text; actor_email text; req uuid; oldop record;
 r public.reservations%rowtype; a oneshot_private.staff_booking_approvals%rowtype; result jsonb;
begin
 if not oneshot_private.verified_staff() then raise exception 'STAFF_REQUIRED' using errcode='42501'; end if;
 role_name:=oneshot_private.staff_role();select email into actor_email from auth.users where id=uid;
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>8192 then raise exception 'INVALID_PAYLOAD'; end if;
 if exists(select 1 from jsonb_object_keys(p) k where not(k=any(array['requestId','id','expectedRevision','expectedStaffId','expectedTotalCents','expectedDownPaymentCents']))) then raise exception 'INVALID_FIELDS'; end if;
 if p->>'expectedStaffId' is distinct from uid::text then raise exception 'ACCOUNT_CHANGED' using errcode='42501'; end if;
 req:=(p->>'requestId')::uuid;
 if req is null or length(coalesce(p->>'id','')) not between 1 and 120 then raise exception 'INVALID_REQUEST'; end if;
 lock table public.reservations in row exclusive mode;
 perform pg_advisory_xact_lock(hashtextextended(uid::text||req::text,0));
 select * into oldop from oneshot_private.staff_payment_operations where actor_user_id=uid and request_id=req;
 if found then if oldop.operation<>'approval' or oldop.payload<>p then raise exception 'IDEMPOTENCY_CONFLICT'; end if;return oldop.result||jsonb_build_object('replayed',true); end if;
 select * into r from public.reservations where id=p->>'id' for update;
 if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
 if (p->>'expectedRevision') is null or (p->>'expectedRevision')::bigint<>r.revision then raise exception 'STALE_REVISION'; end if;
 if r.status is distinct from 'pending' then raise exception 'APPROVAL_STATE_NOT_ALLOWED'; end if;
 if r.total_amount_cents is null or r.down_payment_amount_cents is null or r.discount_amount_cents is null or r.total_amount_cents<0 or r.total_amount_cents>240000000 or r.down_payment_amount_cents<0 or r.down_payment_amount_cents>r.total_amount_cents or r.discount_amount_cents<0 or r.discount_amount_cents>240000000 then raise exception 'BOOKING_FINANCIAL_RECONCILIATION_REQUIRED'; end if;
 if r."downPaymentPaid" is distinct from 0 or r."balancePaid" is distinct from 0 or r.balancepaid is distinct from 0 or exists(select 1 from oneshot_private.staff_payment_verifications where reservation_id=r.id) then raise exception 'PAYMENT_LEDGER_RECONCILIATION_REQUIRED'; end if;
 if r.down_payment_amount_cents<>0 then raise exception 'DEPOSIT_PAYMENT_REQUIRED'; end if;
 if (p->>'expectedTotalCents')::bigint is distinct from r.total_amount_cents or (p->>'expectedDownPaymentCents')::bigint is distinct from r.down_payment_amount_cents then raise exception 'APPROVAL_AMOUNT_CHANGED' using detail=jsonb_build_object('totalCents',r.total_amount_cents,'downPaymentCents',r.down_payment_amount_cents)::text; end if;
 insert into oneshot_private.staff_booking_approvals(reservation_id,actor_user_id,actor_role,actor_email,total_amount_cents,down_payment_amount_cents)
 values(r.id,uid,role_name,actor_email,r.total_amount_cents,r.down_payment_amount_cents) returning * into a;
 update public.reservations set status='confirmed',revision=revision+1 where id=r.id returning * into r;
 result:=jsonb_build_object('reservation',oneshot_private.staff_reservation_json(r),'approval',jsonb_build_object('id',a.id,'actorUserId',a.actor_user_id,'actorRole',a.actor_role,'recordType','no-payment-due-approval','fundsTransferred',false),'replayed',false);
 insert into oneshot_private.staff_payment_operations(actor_user_id,request_id,operation,payload,result) values(uid,req,'approval',p,result);
 return result;
end$$;
revoke all on function oneshot_private.staff_approve_booking(jsonb) from public,anon,authenticated;
grant execute on function oneshot_private.staff_approve_booking(jsonb) to authenticated;
create or replace function public.oneshot_staff_approve_booking(payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select oneshot_private.staff_approve_booking(payload)$$;
revoke all on function public.oneshot_staff_approve_booking(jsonb) from public,anon,authenticated;
grant execute on function public.oneshot_staff_approve_booking(jsonb) to authenticated;

commit;
