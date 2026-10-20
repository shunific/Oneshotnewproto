-- LOCAL REVIEW CANDIDATE ONLY. Do not deploy or enable coordinator readiness yet.
-- Prerequisites: upgraded claim active-registry and private device-proof candidates.
-- ACKs describe verified native records, never bank transfers or refund returns.
begin;
set local lock_timeout='3s';set local statement_timeout='15s';
do $$begin
 if current_setting('oneshot.secure_gateway_cutover',true) is distinct from 'reviewed' then raise exception 'Stop: reviewed coordinated gateway cutover required';end if;
 if to_regclass('oneshot_private.active_checkin_tables') is null or to_regprocedure('oneshot_private.verify_native_device_event(jsonb)') is null then raise exception 'NATIVE_LIFECYCLE_PREREQUISITES_REQUIRED';end if;
end$$;
create table if not exists oneshot_private.native_reservation_events (
 event_id uuid primary key,event_type text not null check(event_type in ('admission','reservation-completion')),
 claim_id uuid not null references oneshot_private.checkin_claims(id),device_id uuid not null,
 accepted_by uuid not null references auth.users(id),key_id uuid not null references oneshot_private.native_device_keys(key_id),
 payload_sha256 text not null check(payload_sha256 ~ '^[0-9a-f]{64}$'),payload jsonb not null check(jsonb_typeof(payload)='object'),
 ack jsonb not null check(jsonb_typeof(ack)='object'),received_at timestamptz not null,
 unique(claim_id,event_type)
);
create table if not exists oneshot_private.native_final_receipts (
 id uuid primary key,claim_id uuid not null unique references oneshot_private.checkin_claims(id),
 event_id uuid not null unique references oneshot_private.native_reservation_events(event_id),
 reservation_id text not null references public.reservations(id),owner_customer_id uuid not null references auth.users(id),
 receipt jsonb not null check(jsonb_typeof(receipt)='object'),history jsonb not null check(jsonb_typeof(history)='object'),
 settlement jsonb not null check(jsonb_typeof(settlement)='object'),
 grand_total_cents bigint not null check(grand_total_cents between 0 and 9007199254740991),
 balance_cents bigint not null check(balance_cents between 0 and 9007199254740991),
 refund_due_cents bigint not null check(refund_due_cents between 0 and 9007199254740991),
 native_collected_cents bigint not null check(native_collected_cents between 0 and 9007199254740991),
 original_credit_cents bigint not null check(original_credit_cents between 0 and 9007199254740991),
 booking_fully_covered boolean not null,gcash_reference_key text unique check(gcash_reference_key ~ '^[A-Z0-9]{3,128}$'),
 played_on date not null,accepted_at timestamptz not null
);
create temporary table native_events_expected (
 event_id uuid primary key,event_type text not null check(event_type in ('admission','reservation-completion')),
 claim_id uuid not null,device_id uuid not null,
 accepted_by uuid not null,key_id uuid not null,
 payload_sha256 text not null check(payload_sha256 ~ '^[0-9a-f]{64}$'),payload jsonb not null check(jsonb_typeof(payload)='object'),
 ack jsonb not null check(jsonb_typeof(ack)='object'),received_at timestamptz not null,
 unique(claim_id,event_type)
) on commit drop;
create temporary table native_receipts_expected (
 id uuid primary key,claim_id uuid not null unique,
 event_id uuid not null unique,
 reservation_id text not null,owner_customer_id uuid not null,
 receipt jsonb not null check(jsonb_typeof(receipt)='object'),history jsonb not null check(jsonb_typeof(history)='object'),
 settlement jsonb not null check(jsonb_typeof(settlement)='object'),
 grand_total_cents bigint not null check(grand_total_cents between 0 and 9007199254740991),
 balance_cents bigint not null check(balance_cents between 0 and 9007199254740991),
 refund_due_cents bigint not null check(refund_due_cents between 0 and 9007199254740991),
 native_collected_cents bigint not null check(native_collected_cents between 0 and 9007199254740991),
 original_credit_cents bigint not null check(original_credit_cents between 0 and 9007199254740991),
 booking_fully_covered boolean not null,gcash_reference_key text unique check(gcash_reference_key ~ '^[A-Z0-9]{3,128}$'),
 played_on date not null,accepted_at timestamptz not null
) on commit drop;
do $$declare a oid;e oid;pair text[];shapes jsonb;f record;begin
 lock table oneshot_private.native_reservation_events,oneshot_private.native_final_receipts in access exclusive mode;
 foreach pair slice 1 in array array[['oneshot_private.native_reservation_events','pg_temp.native_events_expected'],['oneshot_private.native_final_receipts','pg_temp.native_receipts_expected']] loop
  a:=pair[1]::regclass;e:=pair[2]::regclass;
  if (select relkind<>'r' or relpersistence<>'p' or relispartition from pg_class where oid=a) or exists(select 1 from pg_inherits where inhrelid=a or inhparent=a) or exists(select 1 from pg_rewrite where ev_class=a) or exists(select 1 from pg_trigger where tgrelid=a and not tgisinternal and tgname<>case pair[1] when 'oneshot_private.native_reservation_events' then 'native_event_immutable' else 'native_receipt_immutable' end) then raise exception 'INCOMPATIBLE_NATIVE_LIFECYCLE_SCHEMA';end if;
  with targets as(select unnest(array[a,e]) target),definitions as(
   select target,jsonb_build_object(
    'owner',(select relowner from pg_class where oid=target),
    'columns',(select jsonb_agg(jsonb_build_array(x.attnum,x.attname,x.atttypid,x.atttypmod,x.attnotnull,x.attidentity,x.attgenerated,x.attcollation,x.attacl,x.attinhcount,x.attislocal,pg_get_expr(d.adbin,d.adrelid,false)) order by x.attnum) from pg_attribute x left join pg_attrdef d on d.adrelid=x.attrelid and d.adnum=x.attnum where x.attrelid=target and x.attnum>0 and not x.attisdropped),
    'constraints',(select jsonb_agg(jsonb_build_array(contype,pg_get_constraintdef(oid,false),convalidated,condeferrable,condeferred,connoinherit,conislocal,coninhcount) order by contype,pg_get_constraintdef(oid,false)) from pg_constraint where conrelid=target and contype<>'f'),
    'indexes',(select jsonb_agg(jsonb_build_array(indkey::text,indisunique,indisprimary,indisvalid,indisready,pg_get_expr(indexprs,indrelid),pg_get_expr(indpred,indrelid)) order by indkey::text,indisunique,indisprimary) from pg_index where indrelid=target)
   ) shape from targets
  )select jsonb_object_agg(target::text,shape) into shapes from definitions;
  if shapes->a::text is distinct from shapes->e::text then raise exception 'INCOMPATIBLE_NATIVE_LIFECYCLE_SCHEMA';end if;
  if (select count(*) from pg_constraint where conrelid=a and contype='f')<>(case pair[1] when 'oneshot_private.native_reservation_events' then 3 else 4 end) then raise exception 'INCOMPATIBLE_NATIVE_LIFECYCLE_FOREIGN_KEY';end if;
 end loop;
 for f in select * from (values
  ('oneshot_private.native_reservation_events','claim_id','oneshot_private.checkin_claims','id'),
  ('oneshot_private.native_reservation_events','accepted_by','auth.users','id'),
  ('oneshot_private.native_reservation_events','key_id','oneshot_private.native_device_keys','key_id'),
  ('oneshot_private.native_final_receipts','claim_id','oneshot_private.checkin_claims','id'),
  ('oneshot_private.native_final_receipts','event_id','oneshot_private.native_reservation_events','event_id'),
  ('oneshot_private.native_final_receipts','reservation_id','public.reservations','id'),
  ('oneshot_private.native_final_receipts','owner_customer_id','auth.users','id')
 )expected(source,column_name,target,target_column) loop
  if not exists(select 1 from pg_constraint c where c.conrelid=f.source::regclass and c.contype='f' and c.confrelid=f.target::regclass
   and c.conkey=array[(select attnum from pg_attribute where attrelid=f.source::regclass and attname=f.column_name)]::smallint[]
   and c.confkey=array[(select attnum from pg_attribute where attrelid=f.target::regclass and attname=f.target_column)]::smallint[]
   and c.convalidated and not c.condeferrable and not c.condeferred and c.confupdtype='a' and c.confdeltype='a' and c.confmatchtype='s' and c.conislocal and c.coninhcount=0) then raise exception 'INCOMPATIBLE_NATIVE_LIFECYCLE_FOREIGN_KEY';end if;
 end loop;
end$$;

alter table oneshot_private.native_reservation_events enable row level security;
alter table oneshot_private.native_final_receipts enable row level security;
revoke all on oneshot_private.native_reservation_events,oneshot_private.native_final_receipts from public,anon,authenticated;
drop trigger if exists native_event_immutable on oneshot_private.native_reservation_events;
create trigger native_event_immutable before update or delete on oneshot_private.native_reservation_events for each row execute function oneshot_private.freeze_checkin_audit();
drop trigger if exists native_receipt_immutable on oneshot_private.native_final_receipts;
create trigger native_receipt_immutable before update or delete on oneshot_private.native_final_receipts for each row execute function oneshot_private.freeze_checkin_audit();

create or replace function oneshot_private.lifecycle_fields(value jsonb,fields text[]) returns void
language plpgsql immutable set search_path='' as $$begin
 if jsonb_typeof(value) is distinct from 'object' or (select count(*) from jsonb_object_keys(value))<>cardinality(fields) or exists(select 1 from jsonb_object_keys(value) k where not(k=any(fields))) then raise exception 'NATIVE_LIFECYCLE_INVALID_FIELDS';end if;
end$$;
create or replace function oneshot_private.lifecycle_cents(value jsonb) returns bigint
language plpgsql immutable set search_path='' as $$declare n numeric;begin
 if jsonb_typeof(value) is distinct from 'number' then raise exception 'NATIVE_LIFECYCLE_INVALID_CENTS';end if;
 n:=value::numeric;if n<0 or n>9007199254740991 or n<>trunc(n) then raise exception 'NATIVE_LIFECYCLE_INVALID_CENTS';end if;return n::bigint;
end$$;
create or replace function oneshot_private.lifecycle_money(value jsonb) returns bigint
language plpgsql immutable set search_path='' as $$declare n numeric;begin
 if jsonb_typeof(value) is distinct from 'number' then raise exception 'NATIVE_LIFECYCLE_INVALID_MONEY';end if;
 n:=value::numeric*100;if n<0 or n>9007199254740991 or n<>trunc(n) then raise exception 'NATIVE_LIFECYCLE_INVALID_MONEY';end if;return n::bigint;
end$$;
create or replace function oneshot_private.lifecycle_timestamp(value jsonb) returns timestamptz
language plpgsql immutable set search_path='' as $$declare t timestamptz;begin
 if jsonb_typeof(value) is distinct from 'string' or value#>>'{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then raise exception 'NATIVE_LIFECYCLE_INVALID_TIME';end if;
 begin t:=(value#>>'{}')::timestamptz;exception when others then raise exception 'NATIVE_LIFECYCLE_INVALID_TIME';end;
 if to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>value#>>'{}' then raise exception 'NATIVE_LIFECYCLE_INVALID_TIME';end if;return t;
end$$;
create or replace function oneshot_private.lifecycle_reference(value text) returns text
language plpgsql immutable set search_path='' as $$declare normalized text;begin
 if value is null or length(value)>128 or value !~ '^[A-Za-z0-9 -]+$' then raise exception 'INVALID_PAYMENT_REFERENCE';end if;
 normalized:=upper(translate(value,' -','') collate "C");if length(normalized)<3 then raise exception 'INVALID_PAYMENT_REFERENCE';end if;return normalized;
end$$;
revoke all on function oneshot_private.lifecycle_fields(jsonb,text[]),oneshot_private.lifecycle_cents(jsonb),oneshot_private.lifecycle_money(jsonb),oneshot_private.lifecycle_timestamp(jsonb),oneshot_private.lifecycle_reference(text) from public,anon,authenticated;

-- No implicit allocation of partial grand-bill collections to booked time versus
-- food/overtime. Fully settling a nonvoid bill proves booked net is covered.
create or replace function oneshot_private.validate_native_completion(body jsonb,claim jsonb,admission jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare receipt jsonb:=body->'receipt';history jsonb:=body->'history';amounts jsonb:=body->'amounts';item jsonb;
 start_at timestamptz;end_at timestamptz;elapsed bigint;ot_minutes bigint;rate bigint;
 gross bigint;discount bigint;net bigint;prior bigint;fnb bigint:=0;price bigint;qty bigint;ot bigint;original_total bigint;
 total bigint;paid bigint;balance bigint;collected bigint;tender bigint;change_due bigint;refund bigint;waiver bigint;
 is_void boolean;closure text:=body->>'closureKind';expected_status text;expected_history text;field text;reference_key text;
begin
 perform oneshot_private.lifecycle_fields(body,array['version','eventId','type','checkoutRequestId','claimRequestId','claimId','reservationId','deviceId','admissionEventId','admissionTableId','checkoutTableId','admissionLocalStaffId','admissionCloudUserId','checkoutLocalStaffId','sessionStartTime','closureKind','receipt','history','reservationPricing','amounts','priorPaymentCents','collectedNowCents','tenderedCents','changeCents','refundDueCents']);
 perform oneshot_private.lifecycle_fields(receipt,array['id','receipt_no','reservation_id','customer_name','customer_email','customer_phone','booking_discount_amount','reservation_claim_id','owner_user_id','table_id','table_name','play_start_time','play_end_time','duration_minutes','table_rate','overtime_minutes','overtime_rate','pricing_version','table_charge','overtime_charge','fnb_charge','subtotal','discount_amount','total_amount','amount_paid','balance_due','payment_method','payment_status','refund_due','refund_status','payment_reference','original_amount','void_reason','void_actor_id','void_actor_name','created_at']);
 perform oneshot_private.lifecycle_fields(history,array['id','customerName','tableId','tableName','startTime','endTime','durationMinutes','totalAmount','amountPaid','orders','status','closureReason','partySize']);
 perform oneshot_private.lifecycle_fields(amounts,array['bookedGrossCents','bookingDiscountCents','bookedNetCents','overtimeCents','foodAndDrinkCents','sessionWaiverCents','totalCents','allocatedPaidCents','balanceCents']);
 if body->'version' is distinct from '1'::jsonb or receipt->'pricing_version' is distinct from '2'::jsonb or receipt->'table_rate' is distinct from 'null'::jsonb or closure is null or closure not in ('checkout','walkout','void') then raise exception 'NATIVE_COMPLETION_INVALID_MODE';end if;
 if body->'admissionEventId' is distinct from admission->'eventId' or body->'admissionLocalStaffId' is distinct from admission->'localStaffId' or body->'sessionStartTime' is distinct from admission->'sessionStartTime' or body->'admissionTableId' is distinct from admission->'tableId' then raise exception 'NATIVE_COMPLETION_ADMISSION_MISMATCH';end if;
 foreach field in array array['checkoutTableId','checkoutLocalStaffId'] loop
  if jsonb_typeof(body->field) is distinct from 'string' or length(btrim(body->>field)) not between 1 and 120 or length(body->>field)>120 then raise exception 'NATIVE_COMPLETION_INVALID_ID';end if;
 end loop;
 if jsonb_typeof(body->'checkoutRequestId') is distinct from 'string' or body->>'checkoutRequestId' !~ '^[A-Za-z0-9_-]{8,128}$' then raise exception 'NATIVE_COMPLETION_INVALID_ID';end if;
 if jsonb_typeof(receipt->'id') is distinct from 'string' or receipt->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or receipt->'receipt_no' is distinct from to_jsonb('REC-'||(receipt->>'id')) or receipt->'reservation_id' is distinct from claim->'reservationId' or receipt->'reservation_claim_id' is distinct from claim->'claimId' or receipt->'owner_user_id' is distinct from claim->'ownerUserId' or receipt->'customer_name' is distinct from claim->'customerName' or receipt->'customer_email' is distinct from claim->'email' or receipt->'customer_phone' is distinct from claim->'contactNumber' or receipt->'table_id' is distinct from body->'checkoutTableId' or jsonb_typeof(receipt->'table_name') is distinct from 'string' or length(btrim(receipt->>'table_name')) not between 1 and 500 then raise exception 'NATIVE_COMPLETION_RECEIPT_BINDING';end if;
 start_at:=oneshot_private.lifecycle_timestamp(admission->'sessionStartTime');end_at:=oneshot_private.lifecycle_timestamp(receipt->'play_end_time');
 if receipt->'play_start_time' is distinct from admission->'sessionStartTime' or receipt->'created_at' is distinct from receipt->'play_end_time' or end_at<start_at or end_at>clock_timestamp()+interval '60 seconds' then raise exception 'NATIVE_COMPLETION_TIME_MISMATCH';end if;
 elapsed:=ceil(floor(extract(epoch from(end_at-start_at)))/60)::bigint;
 ot_minutes:=greatest(0,ceil(floor(extract(epoch from(end_at-start_at))-(claim->>'durationMinutes')::bigint*60)/60))::bigint;
 rate:=oneshot_private.lifecycle_cents(admission->'overtimeRateCents');if rate not between 1 and 500000 then raise exception 'NATIVE_COMPLETION_RATE_MISMATCH';end if;
 if oneshot_private.lifecycle_money(receipt->'overtime_rate')<>rate or oneshot_private.lifecycle_cents(receipt->'duration_minutes')<>elapsed or oneshot_private.lifecycle_cents(receipt->'overtime_minutes')<>ot_minutes then raise exception 'NATIVE_COMPLETION_RATE_MISMATCH';end if;
 if jsonb_typeof(history->'orders') is distinct from 'array' or jsonb_array_length(history->'orders')>50000 then raise exception 'NATIVE_COMPLETION_INVALID_ORDERS';end if;
 for item in select value from jsonb_array_elements(history->'orders') loop
  perform oneshot_private.lifecycle_fields(item,array['id','name','price','qty']);
  if jsonb_typeof(item->'id') is distinct from 'string' or length(btrim(item->>'id')) not between 1 and 120 or jsonb_typeof(item->'name') is distinct from 'string' or length(item->>'name') not between 1 and 500 then raise exception 'NATIVE_COMPLETION_INVALID_ORDERS';end if;
  price:=oneshot_private.lifecycle_money(item->'price');qty:=oneshot_private.lifecycle_cents(item->'qty');
  if qty<1 or price::numeric*qty>9007199254740991 then raise exception 'NATIVE_COMPLETION_INVALID_ORDERS';end if;
  fnb:=fnb+price*qty;if fnb>9007199254740991 then raise exception 'NATIVE_COMPLETION_INVALID_ORDERS';end if;
 end loop;
 gross:=oneshot_private.lifecycle_cents(claim->'grossTotalCents');discount:=oneshot_private.lifecycle_cents(claim->'discountCents');net:=oneshot_private.lifecycle_cents(claim->'netTotalCents');prior:=oneshot_private.lifecycle_cents(claim->'verifiedPaidCents');
 ot:=round(ot_minutes::numeric*rate/60)::bigint;original_total:=net+ot+fnb;if original_total>9007199254740991 or original_total+discount>9007199254740991 then raise exception 'NATIVE_COMPLETION_INVALID_CENTS';end if;
 is_void:=closure='void';total:=case when is_void then 0 else original_total end;waiver:=case when is_void then original_total else 0 end;
 tender:=oneshot_private.lifecycle_cents(body->'tenderedCents');collected:=least(tender,greatest(0,total-prior));
 paid:=least(total,prior+collected);balance:=greatest(0,total-prior)-collected;change_due:=greatest(0,tender-greatest(0,total-prior));refund:=greatest(0,prior-total);
 if is_void and tender<>0 or closure='walkout' and tender<>0 then raise exception 'NATIVE_COMPLETION_INVALID_COLLECTION';end if;
 if receipt->>'payment_method' not in ('cash','gcash') or jsonb_typeof(receipt->'payment_method') is distinct from 'string' or is_void and receipt->>'payment_method'<>'cash' then raise exception 'NATIVE_COMPLETION_INVALID_COLLECTION';end if;
 if receipt->>'payment_method'='gcash' and tender>greatest(0,total-prior) then raise exception 'NATIVE_COMPLETION_INVALID_COLLECTION';end if;
 if receipt->>'payment_method'='gcash' and collected>0 then
  if jsonb_typeof(receipt->'payment_reference') is distinct from 'string' then raise exception 'INVALID_PAYMENT_REFERENCE';end if;
  reference_key:=oneshot_private.lifecycle_reference(receipt->>'payment_reference');
 elsif receipt->'payment_reference' is distinct from 'null'::jsonb then raise exception 'NATIVE_COMPLETION_INVALID_COLLECTION';end if;
 if is_void then
  if jsonb_typeof(receipt->'void_reason') is distinct from 'string' or length(btrim(receipt->>'void_reason')) not between 1 and 1000 or receipt->'void_actor_id' is distinct from body->'checkoutLocalStaffId' or jsonb_typeof(receipt->'void_actor_name') is distinct from 'string' or length(btrim(receipt->>'void_actor_name')) not between 1 and 500 then raise exception 'NATIVE_COMPLETION_INVALID_VOID';end if;
 elsif receipt->'void_reason' is distinct from 'null'::jsonb or receipt->'void_actor_id' is distinct from 'null'::jsonb or receipt->'void_actor_name' is distinct from 'null'::jsonb then raise exception 'NATIVE_COMPLETION_INVALID_VOID';end if;
 expected_status:=case when is_void then case when refund>0 then 'voided_refund_pending' else 'voided' end when refund>0 then 'refund_pending' when balance=0 then 'paid' when paid>0 then 'partial' else 'unpaid' end;
 expected_history:=case when is_void then 'voided' when closure='walkout' then 'walkout' when refund>0 then 'refund_pending' when elapsed<(claim->>'durationMinutes')::bigint then 'ended_early' when ot_minutes>0 then 'completed_overtime' else 'completed' end;
 if receipt->'payment_status' is distinct from to_jsonb(expected_status) or receipt->'refund_status' is distinct from to_jsonb(case when refund>0 then 'pending' else 'none' end) then raise exception 'NATIVE_COMPLETION_PAYMENT_STATE_MISMATCH';end if;
 if oneshot_private.lifecycle_money(receipt->'table_charge')<>gross or oneshot_private.lifecycle_money(receipt->'booking_discount_amount')<>discount or oneshot_private.lifecycle_money(receipt->'overtime_charge')<>ot or oneshot_private.lifecycle_money(receipt->'fnb_charge')<>fnb or oneshot_private.lifecycle_money(receipt->'subtotal')<>original_total+discount or oneshot_private.lifecycle_money(receipt->'discount_amount')<>discount+waiver or oneshot_private.lifecycle_money(receipt->'original_amount')<>original_total or oneshot_private.lifecycle_money(receipt->'total_amount')<>total or oneshot_private.lifecycle_money(receipt->'amount_paid')<>paid or oneshot_private.lifecycle_money(receipt->'balance_due')<>balance or oneshot_private.lifecycle_money(receipt->'refund_due')<>refund then raise exception 'NATIVE_COMPLETION_FINANCIAL_MISMATCH';end if;
 if oneshot_private.lifecycle_cents(amounts->'bookedGrossCents')<>gross or oneshot_private.lifecycle_cents(amounts->'bookingDiscountCents')<>discount or oneshot_private.lifecycle_cents(amounts->'bookedNetCents')<>net or oneshot_private.lifecycle_cents(amounts->'overtimeCents')<>ot or oneshot_private.lifecycle_cents(amounts->'foodAndDrinkCents')<>fnb or oneshot_private.lifecycle_cents(amounts->'sessionWaiverCents')<>waiver or oneshot_private.lifecycle_cents(amounts->'totalCents')<>total or oneshot_private.lifecycle_cents(amounts->'allocatedPaidCents')<>paid or oneshot_private.lifecycle_cents(amounts->'balanceCents')<>balance or oneshot_private.lifecycle_cents(body->'priorPaymentCents')<>prior or oneshot_private.lifecycle_cents(body->'collectedNowCents')<>collected or oneshot_private.lifecycle_cents(body->'changeCents')<>change_due or oneshot_private.lifecycle_cents(body->'refundDueCents')<>refund then raise exception 'NATIVE_COMPLETION_FINANCIAL_MISMATCH';end if;
 if history->>'closureReason' is distinct from (case when is_void then 'Voided by '||(receipt->>'void_actor_name')||' ('||(receipt->>'void_actor_id')||'). Reason: '||(receipt->>'void_reason')||'. Original bill ₱'||to_char(original_total::numeric/100,'FM9999999999999990.00')||' waived; consumed inventory remains deducted.'||case when refund>0 then ' Prepaid refund ₱'||to_char(refund::numeric/100,'FM9999999999999990.00')||' pending return.' else '' end when refund>0 then 'Checkout committed; prepaid refund is due and has not been acknowledged as returned.' else 'Checkout committed with payment and receipt.' end) then raise exception 'NATIVE_COMPLETION_HISTORY_MISMATCH';end if;
 if history->'id' is distinct from receipt->'id' or history->'customerName' is distinct from claim->'customerName' or history->'tableId' is distinct from receipt->'table_id' or history->'tableName' is distinct from receipt->'table_name' or history->'startTime' is distinct from receipt->'play_start_time' or history->'endTime' is distinct from receipt->'play_end_time' or history->'durationMinutes' is distinct from receipt->'duration_minutes' or history->'partySize' is distinct from claim->'partySize' or oneshot_private.lifecycle_money(history->'totalAmount')<>total or oneshot_private.lifecycle_money(history->'amountPaid')<>paid or history->'status' is distinct from to_jsonb(expected_history) or jsonb_typeof(history->'closureReason') is distinct from 'string' or length(history->>'closureReason') not between 1 and 4000 then raise exception 'NATIVE_COMPLETION_HISTORY_MISMATCH';end if;
 return jsonb_build_object('originalVerifiedBookingCreditCents',prior,'nativeCollectedNowCents',collected,'grandTotalCents',total,'remainingCents',balance,'refundDueCents',refund,'bookingFullyCovered',not is_void and balance=0 and net>0,'gcashReferenceKey',reference_key,'playedOn',timezone('Asia/Manila',end_at)::date,'allocation',case when is_void then 'voided' when balance=0 then 'full-bill-settled' else 'unallocated-partial' end);
end$$;
revoke all on function oneshot_private.validate_native_completion(jsonb,jsonb,jsonb) from public,anon,authenticated;

create or replace function oneshot_private.allow_claimed_reservation_projection(old_row public.reservations,new_row public.reservations) returns boolean
language plpgsql stable security definer set search_path='' as $$declare event_row oneshot_private.native_reservation_events%rowtype;receipt_row oneshot_private.native_final_receipts%rowtype;begin
 if (to_jsonb(old_row)-array['status','revision','downPaymentPaid','balancePaid','balancepaid','refundStatus']) is distinct from (to_jsonb(new_row)-array['status','revision','downPaymentPaid','balancePaid','balancepaid','refundStatus']) then return false;end if;
 if old_row.status='claim-pending' and new_row.status='checked-in' and new_row.revision=old_row.revision+1 then
  select e.* into event_row from oneshot_private.native_reservation_events e join oneshot_private.checkin_claims c on c.id=e.claim_id where c.reservation_id=old_row.id and e.event_type='admission' and e.ack->>'state'='checked-in' and (e.ack->>'revision')::bigint=new_row.revision;
  return found and new_row."downPaymentPaid" is not distinct from old_row."downPaymentPaid" and new_row."balancePaid" is not distinct from old_row."balancePaid" and new_row.balancepaid is not distinct from old_row.balancepaid and new_row."refundStatus" is not distinct from old_row."refundStatus";
 elsif old_row.status='checked-in' and new_row.status='completed' and new_row.revision=old_row.revision+1 then
  select f.* into receipt_row from oneshot_private.native_final_receipts f join oneshot_private.native_reservation_events e on e.event_id=f.event_id where f.reservation_id=old_row.id and e.event_type='reservation-completion' and e.ack->>'state'='completed' and (e.ack->>'revision')::bigint=new_row.revision;
  return found and new_row."downPaymentPaid" is not distinct from case when receipt_row.booking_fully_covered then 1 else old_row."downPaymentPaid" end and new_row."balancePaid" is not distinct from case when receipt_row.booking_fully_covered then 1 else old_row."balancePaid" end and new_row.balancepaid is not distinct from case when receipt_row.booking_fully_covered then 1 else old_row.balancepaid end and new_row."refundStatus" is not distinct from case when receipt_row.refund_due_cents>0 then 'pending' else old_row."refundStatus" end;
 end if;return false;
end$$;
create or replace function oneshot_private.lifecycle_release_allowed(claim uuid,cloud_table text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from oneshot_private.native_final_receipts f join oneshot_private.native_reservation_events e on e.event_id=f.event_id join oneshot_private.checkin_claims c on c.id=f.claim_id join public.reservations r on r.id=f.reservation_id where c.id=claim and c.cloud_table_id=cloud_table and e.event_type='reservation-completion' and r.status='completed' and (e.ack->>'revision')::bigint=r.revision)
$$;
revoke all on function oneshot_private.allow_claimed_reservation_projection(public.reservations,public.reservations),oneshot_private.lifecycle_release_allowed(uuid,text) from public,anon,authenticated;

create or replace function oneshot_private.guard_final_native_gcash_reference() returns trigger
language plpgsql security definer set search_path='' as $$declare reference_key text;begin
 if new.method='gcash' then
  reference_key:=oneshot_private.lifecycle_reference(new.reference);
  perform pg_advisory_xact_lock(hashtextextended('oneshot-gcash:'||reference_key,0));
  if exists(select 1 from oneshot_private.native_final_receipts where gcash_reference_key=reference_key) then raise exception 'REFERENCE_ALREADY_RECORDED';end if;
 end if;return new;
end$$;
revoke all on function oneshot_private.guard_final_native_gcash_reference() from public,anon,authenticated;
drop trigger if exists native_final_gcash_reference_guard on oneshot_private.staff_payment_verifications;
create trigger native_final_gcash_reference_guard before insert or update on oneshot_private.staff_payment_verifications for each row execute function oneshot_private.guard_final_native_gcash_reference();

create or replace function oneshot_private.ack_native_event(envelope jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare proof jsonb;body jsonb;prior oneshot_private.native_reservation_events%rowtype;admission oneshot_private.native_reservation_events%rowtype;
 c oneshot_private.checkin_claims%rowtype;r public.reservations%rowtype;t public.tables%rowtype;
 ack jsonb;projection text;settlement jsonb;result jsonb;received timestamptz:=clock_timestamp();
 v_event_id uuid;v_event_type text;receipt_id uuid;next_revision bigint;started timestamptz;rate bigint;changed integer;reference_key text;
begin
 proof:=oneshot_private.verify_native_device_event(envelope);
 lock table public.tables,public.reservations in share row exclusive mode;
 -- Includes current key/staff/session clock validation after any lock wait.
 proof:=oneshot_private.verify_native_device_event(envelope);body:=proof->'body';v_event_id:=(proof->>'eventId')::uuid;v_event_type:=proof->>'eventType';
 if v_event_type='reservation-completion' and body->>'closureKind'='void' and oneshot_private.staff_role() is distinct from 'manager' then raise exception 'CLOUD_MANAGER_REQUIRED' using errcode='42501';end if;
 select * into prior from oneshot_private.native_reservation_events where native_reservation_events.event_id=v_event_id;
 if found then
  if prior.claim_id::text is distinct from proof->>'claimId' or prior.device_id::text is distinct from proof->>'deviceId' or prior.event_type<>v_event_type or prior.payload_sha256<>proof->>'payloadSha256' or prior.payload<>body then raise exception 'NATIVE_EVENT_IDEMPOTENCY_CONFLICT';end if;
  return jsonb_build_object('ack',prior.ack,'replayed',true,'recordType','reservation-lifecycle-ack','fundsTransferred',false);
 end if;
 select * into c from oneshot_private.checkin_claims where id=(proof->>'claimId')::uuid;
 perform 1 from oneshot_private.checkin_table_mappings m where m.device_id=c.device_id and m.native_table_id=c.native_table_id and m.cloud_table_id=c.cloud_table_id and m.active and m.coordinator_ready and m.approved_by is not null for share;
 if not found then raise exception 'CHECKIN_COORDINATOR_NOT_READY';end if;
 select * into r from public.reservations where id=c.reservation_id for update;
 if not found or r.customer_user_id::text is distinct from c.snapshot->>'ownerUserId' then raise exception 'NATIVE_LIFECYCLE_BOOKING_MISMATCH';end if;
 if r.revision>=9007199254740991 then raise exception 'NATIVE_LIFECYCLE_REVISION_RECONCILIATION';end if;
 if not exists(select 1 from oneshot_private.active_checkin_tables a where a.cloud_table_id=c.cloud_table_id and a.claim_id=c.id) then raise exception 'NATIVE_LIFECYCLE_ACTIVE_CLAIM_MISMATCH';end if;
 if exists(select 1 from oneshot_private.native_reservation_events e where e.claim_id=c.id and e.event_type=v_event_type) then raise exception 'NATIVE_LIFECYCLE_EVENT_ALREADY_ACCEPTED';end if;
 select * into t from public.tables where id=c.cloud_table_id for update;
 if not found then raise exception 'NATIVE_LIFECYCLE_TABLE_MISMATCH';end if;
 -- RowShare holders can delay FOR UPDATE even while coarse table locks are held.
 -- Bind authorization to the publisher/session after both row waits too.
 proof:=oneshot_private.verify_native_device_event(envelope);
 next_revision:=r.revision+1;
 if v_event_type='admission' then
  perform oneshot_private.lifecycle_fields(body,array['eventId','type','requestId','claimId','reservationId','deviceId','tableId','localStaffId','cloudUserId','sessionStartTime','overtimeRateCents']);
  if r.status is distinct from 'claim-pending' or r.revision is distinct from (c.snapshot->>'claimRevision')::bigint then raise exception 'NATIVE_LIFECYCLE_ADMISSION_STATE';end if;
  if jsonb_typeof(body->'localStaffId') is distinct from 'string' or length(btrim(body->>'localStaffId')) not between 1 and 120 or length(body->>'localStaffId')>120 then raise exception 'NATIVE_LIFECYCLE_INVALID_LOCAL_ACTOR';end if;
  rate:=oneshot_private.lifecycle_cents(body->'overtimeRateCents');if rate not between 1 and 500000 then raise exception 'NATIVE_LIFECYCLE_INVALID_RATE';end if;
  started:=oneshot_private.lifecycle_timestamp(body->'sessionStartTime');
  if started>clock_timestamp()+interval '60 seconds' or timezone('Asia/Manila',started)::date is distinct from (c.snapshot->>'bookingDate')::date then raise exception 'NATIVE_LIFECYCLE_ADMISSION_TIME';end if;
  if t.status is distinct from 'available' or t.isactive is distinct from 1 or t."isActive" is distinct from 1 or t.sessiondata is not null or t."sessionData" is not null then raise exception 'NATIVE_LIFECYCLE_TABLE_MISMATCH';end if;
  projection:=jsonb_build_object('kind','trusted-native-reservation','claimId',c.id,'admissionEventId',v_event_id,'deviceId',c.device_id,'startTime',body->'sessionStartTime','durationMinutes',c.snapshot->'durationMinutes','isOpenTime',false)::text;
  ack:=jsonb_build_object('eventId',v_event_id,'eventType',v_event_type,'claimId',c.id,'deviceId',c.device_id,'reservationId',c.reservation_id,'payloadSha256',proof->'payloadSha256','state','checked-in','revision',next_revision,'receiptId',null,'receivedAt',to_char(received at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'acceptedBy',auth.uid());
  insert into oneshot_private.native_reservation_events(event_id,event_type,claim_id,device_id,accepted_by,key_id,payload_sha256,payload,ack,received_at) values(v_event_id,v_event_type,c.id,c.device_id,auth.uid(),(proof->>'keyId')::uuid,proof->>'payloadSha256',body,ack,received);
  update public.reservations set status='checked-in',revision=next_revision where id=r.id;
  update public.tables set status='occupied',sessiondata=projection,"sessionData"=projection where id=c.cloud_table_id;
 else
  select * into admission from oneshot_private.native_reservation_events e where e.claim_id=c.id and e.event_type='admission';
  if not found or r.status is distinct from 'checked-in' or r.revision is distinct from (admission.ack->>'revision')::bigint then raise exception 'NATIVE_LIFECYCLE_ADMISSION_ACK_REQUIRED';end if;
  projection:=jsonb_build_object('kind','trusted-native-reservation','claimId',c.id,'admissionEventId',admission.event_id,'deviceId',c.device_id,'startTime',admission.payload->'sessionStartTime','durationMinutes',c.snapshot->'durationMinutes','isOpenTime',false)::text;
  if t.status is distinct from 'occupied' or t.sessiondata is distinct from projection or t."sessionData" is distinct from projection then raise exception 'NATIVE_LIFECYCLE_TABLE_MISMATCH';end if;
  settlement:=oneshot_private.validate_native_completion(body,c.snapshot,admission.payload);
  reference_key:=settlement->>'gcashReferenceKey';
  if reference_key is not null then
   perform pg_advisory_xact_lock(hashtextextended('oneshot-gcash:'||reference_key,0));
   if exists(select 1 from oneshot_private.staff_payment_verifications v where v.method='gcash' and upper(translate(btrim(v.reference),' -','') collate "C")=reference_key) or exists(select 1 from oneshot_private.native_final_receipts f where f.gcash_reference_key=reference_key) then raise exception 'REFERENCE_ALREADY_RECORDED';end if;
  end if;
  -- GCash reference serialization can wait behind another ledger writer.
  -- Revalidate the current publisher/session after that final possible wait.
  proof:=oneshot_private.verify_native_device_event(envelope);
  if body->>'closureKind'='void' and oneshot_private.staff_role() is distinct from 'manager' then raise exception 'CLOUD_MANAGER_REQUIRED' using errcode='42501';end if;
  receipt_id:=(body->'receipt'->>'id')::uuid;
  ack:=jsonb_build_object('eventId',v_event_id,'eventType',v_event_type,'claimId',c.id,'deviceId',c.device_id,'reservationId',c.reservation_id,'payloadSha256',proof->'payloadSha256','state','completed','revision',next_revision,'receiptId',receipt_id,'receivedAt',to_char(received at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'acceptedBy',auth.uid());
  insert into oneshot_private.native_reservation_events(event_id,event_type,claim_id,device_id,accepted_by,key_id,payload_sha256,payload,ack,received_at) values(v_event_id,v_event_type,c.id,c.device_id,auth.uid(),(proof->>'keyId')::uuid,proof->>'payloadSha256',body,ack,received);
  insert into oneshot_private.native_final_receipts(id,claim_id,event_id,reservation_id,owner_customer_id,receipt,history,settlement,grand_total_cents,balance_cents,refund_due_cents,native_collected_cents,original_credit_cents,booking_fully_covered,gcash_reference_key,played_on,accepted_at)
   values(receipt_id,c.id,v_event_id,c.reservation_id,(c.snapshot->>'ownerUserId')::uuid,body->'receipt',body->'history',settlement,(settlement->>'grandTotalCents')::bigint,(settlement->>'remainingCents')::bigint,(settlement->>'refundDueCents')::bigint,(settlement->>'nativeCollectedNowCents')::bigint,(settlement->>'originalVerifiedBookingCreditCents')::bigint,(settlement->>'bookingFullyCovered')::boolean,reference_key,(settlement->>'playedOn')::date,received);
  update public.reservations set status='completed',revision=next_revision,"downPaymentPaid"=case when (settlement->>'bookingFullyCovered')::boolean then 1 else "downPaymentPaid" end,"balancePaid"=case when (settlement->>'bookingFullyCovered')::boolean then 1 else "balancePaid" end,balancepaid=case when (settlement->>'bookingFullyCovered')::boolean then 1 else balancepaid end,"refundStatus"=case when (settlement->>'refundDueCents')::bigint>0 then 'pending' else "refundStatus" end where id=r.id;
  update public.tables set status='available',sessiondata=null,"sessionData"=null where id=c.cloud_table_id;
  delete from oneshot_private.active_checkin_tables where cloud_table_id=c.cloud_table_id and claim_id=c.id;
  get diagnostics changed=row_count;if changed<>1 then raise exception 'NATIVE_LIFECYCLE_ACTIVE_CLAIM_MISMATCH';end if;
 end if;
 return jsonb_build_object('ack',ack,'replayed',false,'recordType','reservation-lifecycle-ack','fundsTransferred',false);
end$$;
revoke all on function oneshot_private.ack_native_event(jsonb) from public,anon,authenticated;
grant execute on function oneshot_private.ack_native_event(jsonb) to authenticated;
create or replace function public.oneshot_staff_ack_native_event(payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select oneshot_private.ack_native_event(payload)$$;
revoke all on function public.oneshot_staff_ack_native_event(jsonb) from public,anon,authenticated;
grant execute on function public.oneshot_staff_ack_native_event(jsonb) to authenticated;

create or replace function oneshot_private.final_receipt_json(r oneshot_private.native_final_receipts) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('receiptId',r.id,'claimId',r.claim_id,'eventId',r.event_id,'reservationId',r.reservation_id,'ownerUserId',r.owner_customer_id,'receipt',r.receipt,'history',r.history,'settlement',r.settlement-array['gcashReferenceKey','playedOn'],'acceptedAt',to_char(r.accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;
revoke all on function oneshot_private.final_receipt_json(oneshot_private.native_final_receipts) from public,anon,authenticated;
create or replace function oneshot_private.final_receipts(p_from date,p_to date,staff boolean) returns jsonb
language plpgsql stable security definer set search_path='' as $$declare rows jsonb;begin
 if staff then if not oneshot_private.verified_staff() then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 elsif not oneshot_private.verified_customer() then raise exception 'VERIFIED_ACCOUNT_REQUIRED' using errcode='42501';end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>93 then raise exception 'INVALID_DATE_RANGE';end if;
 select coalesce(jsonb_agg(oneshot_private.final_receipt_json(f) order by f.played_on,f.id),'[]') into rows from (select * from oneshot_private.native_final_receipts where played_on between p_from and p_to and (staff or owner_customer_id=auth.uid()) order by played_on,id limit 1001)f;
 if jsonb_array_length(rows)>1000 then raise exception 'LIST_LIMIT';end if;
 return jsonb_build_object('receipts',rows,'recordType','owner-linked-final-receipt','fundsTransferred',false);
end$$;
revoke all on function oneshot_private.final_receipts(date,date,boolean) from public,anon,authenticated;
-- Separate wrappers prevent an owner from passing staff=true to elevate scope.
create or replace function oneshot_private.customer_final_receipts(p_from date,p_to date) returns jsonb language sql stable security definer set search_path='' as $$select oneshot_private.final_receipts(p_from,p_to,false)$$;
create or replace function oneshot_private.staff_final_receipts(p_from date,p_to date) returns jsonb language sql stable security definer set search_path='' as $$select oneshot_private.final_receipts(p_from,p_to,true)$$;
revoke all on function oneshot_private.customer_final_receipts(date,date),oneshot_private.staff_final_receipts(date,date) from public,anon,authenticated;
grant execute on function oneshot_private.customer_final_receipts(date,date),oneshot_private.staff_final_receipts(date,date) to authenticated;
create or replace function public.oneshot_customer_final_receipts(p_from date,p_to date) returns jsonb language sql stable security invoker set search_path='' as $$select oneshot_private.customer_final_receipts(p_from,p_to)$$;
create or replace function public.oneshot_staff_final_receipts(p_from date,p_to date) returns jsonb language sql stable security invoker set search_path='' as $$select oneshot_private.staff_final_receipts(p_from,p_to)$$;
revoke all on function public.oneshot_customer_final_receipts(date,date),public.oneshot_staff_final_receipts(date,date) from public,anon,authenticated;
grant execute on function public.oneshot_customer_final_receipts(date,date),public.oneshot_staff_final_receipts(date,date) to authenticated;

create or replace function oneshot_private.staff_reservation_json(r public.reservations) returns jsonb
language sql stable security definer set search_path='' as $$
 select to_jsonb(r)||jsonb_build_object('totalAmount',case when r.total_amount_cents is not null then r.total_amount_cents::numeric/100 else null end,'downPaymentAmount',case when r.down_payment_amount_cents is not null then r.down_payment_amount_cents::numeric/100 else null end,'discountAmount',case when r.discount_amount_cents is not null then r.discount_amount_cents::numeric/100 else null end,
 'paymentSummary',jsonb_build_object('verifiedPaidCents',coalesce((select sum(amount_cents) from oneshot_private.staff_payment_verifications where reservation_id=r.id),0),'remainingCents',case when exists(select 1 from oneshot_private.native_final_receipts where reservation_id=r.id and booking_fully_covered) then 0 else r.total_amount_cents-coalesce((select sum(amount_cents) from oneshot_private.staff_payment_verifications where reservation_id=r.id),0) end),
 'settlement',(select settlement-array['gcashReferenceKey','playedOn'] from oneshot_private.native_final_receipts where reservation_id=r.id))
$$;
revoke all on function oneshot_private.staff_reservation_json(public.reservations) from public,anon,authenticated;
commit;
