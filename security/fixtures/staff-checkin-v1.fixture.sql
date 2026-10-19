-- REVIEW CANDIDATE ONLY: DO NOT DEPLOY ALONE OR ADD TO CUTOVER BUNDLE YET.
-- Requires durable native admission/completion coordination before enabling mappings.
-- Apply only after the nine coordinated security candidates, under owner review.
-- A durable claim is NOT physical admission, completion, payment, or a funds transfer.
-- No expiry/release/ACK endpoint exists in this unit. Future admission/completion work
-- must preserve this immutable snapshot and explicitly reconcile/release its table claim.
begin;
set local lock_timeout='3s'; set local statement_timeout='10s';
do $$begin if current_setting('oneshot.secure_gateway_cutover',true) is distinct from 'reviewed' then raise exception 'Stop: reviewed coordinated gateway cutover required'; end if; end$$;

-- Owner-enrolled mapping only. Device IDs supplied by callers are assertions against
-- this registry, not proof of physical device attestation. No alternate-table policy.
create table if not exists oneshot_private.checkin_table_mappings (
 device_id uuid not null,native_table_id text not null check(length(native_table_id) between 1 and 120),
 cloud_table_id text not null references public.tables(id),
 venue_id text not null default 'oneshot' check(venue_id='oneshot'),
 active boolean not null default false,coordinator_ready boolean not null default false,approved_by uuid references auth.users(id),
 created_at timestamptz not null default now(),primary key(device_id,native_table_id),
 check(not active or approved_by is not null)
);
create table if not exists oneshot_private.checkin_claims (
 id uuid primary key default gen_random_uuid(),reservation_id text not null unique references public.reservations(id),
 actor_user_id uuid not null references auth.users(id),request_id uuid not null,
 device_id uuid not null,native_table_id text not null,cloud_table_id text not null references public.tables(id),
 state text not null default 'claim-pending' check(state='claim-pending'),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 created_at timestamptz not null default now(),unique(actor_user_id,request_id),
 foreign key(device_id,native_table_id) references oneshot_private.checkin_table_mappings(device_id,native_table_id)
);
-- Pending claims intentionally retain the physical table until a future trusted ACK
-- workflow exists. A timeout, reboot, expired token or new request never frees it.
create unique index if not exists checkin_pending_table_unique on oneshot_private.checkin_claims(cloud_table_id);
create table if not exists oneshot_private.checkin_operations (
 actor_user_id uuid not null references auth.users(id),request_id uuid not null,
 payload jsonb not null,result jsonb not null,created_at timestamptz not null default now(),
 primary key(actor_user_id,request_id)
);
-- Validate existing tables before trusting their authorization/audit constraints.
-- Temporary expected shapes deliberately omit foreign keys (PG forbids temp-to-
-- permanent FKs); exact validated targets and actions are checked separately.
create temporary table checkin_mappings_expected (
 device_id uuid not null,native_table_id text not null check(length(native_table_id) between 1 and 120),
 cloud_table_id text not null,venue_id text not null default 'oneshot' check(venue_id='oneshot'),
 active boolean not null default false,coordinator_ready boolean not null default false,approved_by uuid,created_at timestamptz not null default now(),
 primary key(device_id,native_table_id),check(not active or approved_by is not null)
) on commit drop;
create temporary table checkin_claims_expected (
 id uuid primary key default gen_random_uuid(),reservation_id text not null unique,
 actor_user_id uuid not null,request_id uuid not null,device_id uuid not null,native_table_id text not null,cloud_table_id text not null,
 state text not null default 'claim-pending' check(state='claim-pending'),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),created_at timestamptz not null default now(),unique(actor_user_id,request_id)
) on commit drop;
create unique index checkin_expected_table_unique on checkin_claims_expected(cloud_table_id);
create temporary table checkin_operations_expected (
 actor_user_id uuid not null,request_id uuid not null,payload jsonb not null,result jsonb not null,
 created_at timestamptz not null default now(),primary key(actor_user_id,request_id)
) on commit drop;
do $$
declare actual_oid oid;expected_oid oid;pair text[];shapes jsonb;f record;expected_count integer;
begin
 lock table oneshot_private.checkin_table_mappings,oneshot_private.checkin_claims,oneshot_private.checkin_operations in access exclusive mode;
 foreach pair slice 1 in array array[
  ['oneshot_private.checkin_table_mappings','pg_temp.checkin_mappings_expected'],
  ['oneshot_private.checkin_claims','pg_temp.checkin_claims_expected'],
  ['oneshot_private.checkin_operations','pg_temp.checkin_operations_expected']
 ] loop
  actual_oid:=pair[1]::regclass;expected_oid:=pair[2]::regclass;
  if (select relkind<>'r' or relpersistence<>'p' or relispartition from pg_class where oid=actual_oid)
   or exists(select 1 from pg_inherits where inhrelid=actual_oid or inhparent=actual_oid)
   or exists(select 1 from pg_rewrite where ev_class=actual_oid)
   or exists(select 1 from pg_trigger where tgrelid=actual_oid and not tgisinternal and tgname<>case pair[1] when 'oneshot_private.checkin_claims' then 'checkin_claim_immutable' when 'oneshot_private.checkin_operations' then 'checkin_operation_immutable' else '' end) then raise exception 'INCOMPATIBLE_CHECKIN_SCHEMA';end if;
  with targets as(select unnest(array[actual_oid,expected_oid]) as target),definitions as(
   select target,jsonb_build_object(
    'owner',(select relowner from pg_class where oid=target),
    'columns',(select jsonb_agg(jsonb_build_array(a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,a.attacl,a.attinhcount,a.attislocal,pg_get_expr(d.adbin,d.adrelid,false)) order by a.attnum)
     from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=target and a.attnum>0 and not a.attisdropped),
    'constraints',(select jsonb_agg(jsonb_build_array(contype,pg_get_constraintdef(oid,false),convalidated,condeferrable,condeferred,connoinherit,conislocal,coninhcount) order by contype,pg_get_constraintdef(oid,false)) from pg_constraint where conrelid=target and contype<>'f'),
    'indexes',(select jsonb_agg(jsonb_build_array(indkey::text,indisunique,indisprimary,indisvalid,indisready,pg_get_expr(indexprs,indrelid),pg_get_expr(indpred,indrelid)) order by indkey::text,indisunique,indisprimary) from pg_index where indrelid=target)
   ) as shape from targets
  )select jsonb_object_agg(target::text,shape) into shapes from definitions;
  if shapes->actual_oid::text is distinct from shapes->expected_oid::text then raise exception 'INCOMPATIBLE_CHECKIN_SCHEMA';end if;
  expected_count:=case pair[1] when 'oneshot_private.checkin_table_mappings' then 2 when 'oneshot_private.checkin_claims' then 4 else 1 end;
  if (select count(*) from pg_constraint where conrelid=actual_oid and contype='f')<>expected_count then raise exception 'INCOMPATIBLE_CHECKIN_FOREIGN_KEYS';end if;
 end loop;
 for f in select * from (values
  ('oneshot_private.checkin_table_mappings',array['cloud_table_id'],'public.tables',array['id']),
  ('oneshot_private.checkin_table_mappings',array['approved_by'],'auth.users',array['id']),
  ('oneshot_private.checkin_claims',array['reservation_id'],'public.reservations',array['id']),
  ('oneshot_private.checkin_claims',array['actor_user_id'],'auth.users',array['id']),
  ('oneshot_private.checkin_claims',array['cloud_table_id'],'public.tables',array['id']),
  ('oneshot_private.checkin_claims',array['device_id','native_table_id'],'oneshot_private.checkin_table_mappings',array['device_id','native_table_id']),
  ('oneshot_private.checkin_operations',array['actor_user_id'],'auth.users',array['id'])
 ) as expected(source,columns,target,target_columns) loop
  if not exists(select 1 from pg_constraint c where c.conrelid=f.source::regclass and c.contype='f' and c.confrelid=f.target::regclass
   and c.conkey=(select array_agg(a.attnum order by u.ordinality)::smallint[] from unnest(f.columns) with ordinality u(name,ordinality) join pg_attribute a on a.attrelid=f.source::regclass and a.attname=u.name)
   and c.confkey=(select array_agg(a.attnum order by u.ordinality)::smallint[] from unnest(f.target_columns) with ordinality u(name,ordinality) join pg_attribute a on a.attrelid=f.target::regclass and a.attname=u.name)
   and c.convalidated and not c.condeferrable and not c.condeferred and c.confupdtype='a' and c.confdeltype='a' and c.confmatchtype='s' and c.conislocal and c.coninhcount=0) then raise exception 'INCOMPATIBLE_CHECKIN_FOREIGN_KEYS';end if;
 end loop;
end$$;
alter table oneshot_private.checkin_table_mappings enable row level security;
alter table oneshot_private.checkin_claims enable row level security;
alter table oneshot_private.checkin_operations enable row level security;
revoke all on oneshot_private.checkin_table_mappings,oneshot_private.checkin_claims,oneshot_private.checkin_operations from public,anon,authenticated;

create or replace function oneshot_private.freeze_checkin_audit() returns trigger
language plpgsql security definer set search_path='' as $$begin raise exception 'CHECKIN_AUDIT_IMMUTABLE'; end$$;
revoke all on function oneshot_private.freeze_checkin_audit() from public,anon,authenticated;
drop trigger if exists checkin_claim_immutable on oneshot_private.checkin_claims;
create trigger checkin_claim_immutable before update or delete on oneshot_private.checkin_claims for each row execute function oneshot_private.freeze_checkin_audit();
drop trigger if exists checkin_operation_immutable on oneshot_private.checkin_operations;
create trigger checkin_operation_immutable before update or delete on oneshot_private.checkin_operations for each row execute function oneshot_private.freeze_checkin_audit();

-- Guard every older reservation/payment writer, including privileged maintenance.
-- New trusted lifecycle endpoints must explicitly evolve these guards; no GUC bypass.
create or replace function oneshot_private.guard_claimed_reservation() returns trigger
language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from oneshot_private.checkin_claims where reservation_id=old.id) then raise exception 'BOOKING_CHECKIN_CLAIMED'; end if;
 if tg_op='DELETE' then return old; end if;return new;
end$$;
revoke all on function oneshot_private.guard_claimed_reservation() from public,anon,authenticated;
drop trigger if exists checkin_reservation_guard on public.reservations;
create trigger checkin_reservation_guard before update or delete on public.reservations for each row execute function oneshot_private.guard_claimed_reservation();
create or replace function oneshot_private.guard_claimed_payment() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_id text;new_id text;
begin
 if tg_op<>'INSERT' then old_id:=old.reservation_id;end if;
 if tg_op<>'DELETE' then new_id:=new.reservation_id;end if;
 -- Serialize direct ledger DML with claim creation, not merely FK key-share checks.
 perform 1 from public.reservations where id=old_id or id=new_id order by id for update;
 if exists(select 1 from oneshot_private.checkin_claims where reservation_id=old_id or reservation_id=new_id) then raise exception 'BOOKING_CHECKIN_CLAIMED'; end if;
 if tg_op='DELETE' then return old;end if;return new;
end$$;
revoke all on function oneshot_private.guard_claimed_payment() from public,anon,authenticated;
drop trigger if exists checkin_payment_guard on oneshot_private.staff_payment_verifications;
create trigger checkin_payment_guard before insert or update or delete on oneshot_private.staff_payment_verifications for each row execute function oneshot_private.guard_claimed_payment();

create or replace function oneshot_private.staff_claim_checkin(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();req uuid;device uuid;role_name text;expected_revision bigint;
 r public.reservations%rowtype;m oneshot_private.checkin_table_mappings%rowtype;
 t public.tables%rowtype;prior oneshot_private.checkin_operations%rowtype;
 claim_id uuid:=gen_random_uuid();paid bigint;deposit_flag integer;balance_flag integer;
 snap jsonb;result jsonb;
begin
 if not oneshot_private.verified_staff() then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 role_name:=oneshot_private.staff_role();
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>4096 then raise exception 'INVALID_PAYLOAD';end if;
 if exists(select 1 from jsonb_object_keys(p) k where not(k=any(array['requestId','id','expectedRevision','expectedStaffId','deviceId','tableId']))) then raise exception 'INVALID_FIELDS';end if;
 if (select count(*) from jsonb_object_keys(p))<>6 then raise exception 'INVALID_FIELDS';end if;
 if jsonb_typeof(p->'expectedStaffId') is distinct from 'string' or p->>'expectedStaffId' is distinct from uid::text then raise exception 'ACCOUNT_CHANGED' using errcode='42501';end if;
 if jsonb_typeof(p->'requestId') is distinct from 'string' or jsonb_typeof(p->'deviceId') is distinct from 'string' or jsonb_typeof(p->'id') is distinct from 'string' or length(p->>'id') not between 1 and 120 or jsonb_typeof(p->'tableId') is distinct from 'string' or length(p->>'tableId') not between 1 and 120 or jsonb_typeof(p->'expectedRevision') is distinct from 'number' or (p->>'expectedRevision') !~ '^[1-9][0-9]{0,15}$' then raise exception 'INVALID_REQUEST';end if;
 begin req:=(p->>'requestId')::uuid;device:=(p->>'deviceId')::uuid;expected_revision:=(p->>'expectedRevision')::bigint;
 exception when others then raise exception 'INVALID_REQUEST';end;
 if (p->>'requestId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or (p->>'deviceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or req is null or device is null or expected_revision>=9007199254740991 then raise exception 'INVALID_REQUEST';end if;
 if octet_length(p->>'id')>120 or octet_length(p->>'tableId')>120 or p->>'id' ~ U&'^[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]|[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]$' or p->>'tableId' ~ U&'^[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]|[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]$' then raise exception 'INVALID_REQUEST';end if;
 -- Same coarse table ordering as booking commands. Payment writers lock the same
 -- reservation row; their earlier exact replays remain read-only and valid.
 lock table public.tables,public.reservations in share row exclusive mode;
 perform pg_advisory_xact_lock(hashtextextended(uid::text||req::text,0));
 if not oneshot_private.verified_staff() then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 role_name:=oneshot_private.staff_role();
 select * into prior from oneshot_private.checkin_operations where actor_user_id=uid and request_id=req;
 if found then
  if prior.payload<>p then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  return prior.result||jsonb_build_object('replayed',true);
 end if;
 select * into m from oneshot_private.checkin_table_mappings where device_id=device and native_table_id=p->>'tableId' for share;
 if not found or not m.active or m.approved_by is null or octet_length(m.cloud_table_id) not between 1 and 120 or m.cloud_table_id ~ U&'^[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]|[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]$' then raise exception 'CHECKIN_MAPPING_REQUIRED';end if;
 if not m.coordinator_ready then raise exception 'CHECKIN_COORDINATOR_NOT_READY';end if;
 select * into r from public.reservations where id=p->>'id' for update;
 if not found then raise exception 'BOOKING_NOT_FOUND';end if;
 if exists(select 1 from oneshot_private.checkin_claims where reservation_id=r.id) then raise exception 'BOOKING_ALREADY_CLAIMED';end if;
 if r.revision is distinct from expected_revision then raise exception 'STALE_REVISION';end if;
 if r.status is distinct from 'confirmed' then raise exception 'CHECKIN_STATE_NOT_ALLOWED';end if;
 if r.customer_user_id is null then raise exception 'BOOKING_OWNER_RECONCILIATION_REQUIRED';end if;
 if r.date is distinct from timezone('Asia/Manila',statement_timestamp())::date then raise exception 'CHECKIN_DATE_NOT_ALLOWED';end if;
 if r."tableId" is distinct from m.cloud_table_id then raise exception 'CHECKIN_TABLE_MISMATCH';end if;
 if length(coalesce(r."customerName",'')) not between 1 and 120 or r."customerName" !~ U&'[^\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]' or length(coalesce(r."contactNumber",'')) not between 1 and 40 or r."contactNumber" !~ U&'[^\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]' or octet_length(coalesce(r.email,'')) not between 3 and 254 or r.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or r.email ~ U&'[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]' or r."partySize" is null or r."partySize"<1 or r."durationHours" is null or r."durationHours" not between 1 and 24 or r."timeSlot" is null or r."timeSlot" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'BOOKING_RECONCILIATION_REQUIRED';end if;
 select * into t from public.tables where id=m.cloud_table_id for update;
 if not found or t.status is distinct from 'available' or t.isactive is distinct from 1 or t."isActive" is distinct from 1 or t.sessiondata is not null or t."sessionData" is not null then raise exception 'CHECKIN_CLOUD_TABLE_UNAVAILABLE';end if;
 if exists(select 1 from oneshot_private.checkin_claims where cloud_table_id=m.cloud_table_id) then raise exception 'CHECKIN_TABLE_ALREADY_CLAIMED';end if;
 if r.total_amount_cents is null or r.total_amount_cents not between 0 and 240000000 or r.discount_amount_cents is null or r.discount_amount_cents not between 0 and 240000000 or r.down_payment_amount_cents is null or r.down_payment_amount_cents<0 or r.down_payment_amount_cents>r.total_amount_cents or r.total_amount_cents+r.discount_amount_cents>240000000 then raise exception 'BOOKING_FINANCIAL_RECONCILIATION_REQUIRED';end if;
 select coalesce(sum(amount_cents),0) into paid from oneshot_private.staff_payment_verifications where reservation_id=r.id;
 -- A legacy refund indicator cannot prove that the verified credit remains usable.
 if r."refundStatus" is not null and r."refundStatus"<>'none' then raise exception 'PAYMENT_LEDGER_RECONCILIATION_REQUIRED';end if;
 if paid<0 or paid>r.total_amount_cents then raise exception 'PAYMENT_LEDGER_RECONCILIATION_REQUIRED';end if;
 deposit_flag:=case when paid>=r.down_payment_amount_cents and paid>0 then 1 else 0 end;
 balance_flag:=case when paid>=r.total_amount_cents and paid>0 then 1 else 0 end;
 if r."downPaymentPaid" is distinct from deposit_flag or r."balancePaid" is distinct from balance_flag or r.balancepaid is distinct from balance_flag then raise exception 'PAYMENT_LEDGER_RECONCILIATION_REQUIRED';end if;
 if paid<r.down_payment_amount_cents then raise exception 'DEPOSIT_VERIFICATION_REQUIRED';end if;
 if paid=0 and not exists(select 1 from oneshot_private.staff_booking_approvals a where a.reservation_id=r.id and a.total_amount_cents=r.total_amount_cents and a.down_payment_amount_cents=0) then raise exception 'APPROVAL_VERIFICATION_REQUIRED';end if;
 snap:=jsonb_build_object('claimId',claim_id,'requestId',req,'reservationId',r.id,'actorUserId',uid,'actorRole',role_name,'deviceId',device,'tableId',m.native_table_id,'cloudTableId',m.cloud_table_id,'ownerUserId',r.customer_user_id,'sourceRevision',r.revision,'claimRevision',r.revision+1,'state','claim-pending','customerName',r."customerName",'contactNumber',r."contactNumber",'email',r.email,'partySize',r."partySize",'durationMinutes',r."durationHours"*60,'bookingDate',r.date,'timeSlot',r."timeSlot",'netTotalCents',r.total_amount_cents,'grossTotalCents',r.total_amount_cents+r.discount_amount_cents,'discountCents',r.discount_amount_cents,'requiredDepositCents',r.down_payment_amount_cents,'verifiedPaidCents',paid);
 -- Update before installing the immutable claim, inside the same transaction.
 update public.reservations set status='claim-pending',revision=revision+1 where id=r.id;
 insert into oneshot_private.checkin_claims(id,reservation_id,actor_user_id,request_id,device_id,native_table_id,cloud_table_id,snapshot) values(claim_id,r.id,uid,req,device,m.native_table_id,m.cloud_table_id,snap);
 result:=jsonb_build_object('claim',snap,'replayed',false,'recordType','reservation-check-in-claim','fundsTransferred',false);
 insert into oneshot_private.checkin_operations(actor_user_id,request_id,payload,result) values(uid,req,p,result);
 return result;
end$$;
revoke all on function oneshot_private.staff_claim_checkin(jsonb) from public,anon,authenticated;
grant execute on function oneshot_private.staff_claim_checkin(jsonb) to authenticated;
create or replace function public.oneshot_staff_claim_checkin(payload jsonb) returns jsonb
language sql security invoker set search_path='' as $$select oneshot_private.staff_claim_checkin(payload)$$;
revoke all on function public.oneshot_staff_claim_checkin(jsonb) from public,anon,authenticated;
grant execute on function public.oneshot_staff_claim_checkin(jsonb) to authenticated;
-- Enrollment is intentionally incomplete by default: active does not imply ready.
-- Only the project owner can enable coordinator_ready AFTER the native durable
-- claim/admission/ACK/recovery workflow has been built and independently verified.
-- This candidate provides no enrollment RPC and no session-GUC feature bypass.
commit;
