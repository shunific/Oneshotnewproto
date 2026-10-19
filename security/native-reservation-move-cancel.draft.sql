-- LOCAL REVIEW CANDIDATE: fifth coordinated native lifecycle candidate.
-- Staff-authorized irreversible no-commit cancellation; never timeout-release a hold.
begin;
set local lock_timeout='3s';set local statement_timeout='20s';
do $$begin
 if current_setting('oneshot.secure_gateway_cutover',true) is distinct from 'reviewed' then raise exception 'Stop: reviewed coordinated gateway cutover required';end if;
 if to_regprocedure('oneshot_private.native_move_shape(oid)') is null then raise exception 'NATIVE_MOVE_CANCEL_PREREQUISITES_REQUIRED';end if;
end$$;
create table if not exists oneshot_private.native_move_cancellations(
 move_id uuid primary key,claim_id uuid not null references oneshot_private.checkin_claims(id),
 prepare_event_id uuid not null unique,prepare_payload text not null,
 prepare_payload_sha256 text not null check(prepare_payload_sha256 ~ '^[0-9a-f]{64}$'),
 prepare_body jsonb not null check(jsonb_typeof(prepare_body)='object'),
 cancel_event_id uuid not null unique references oneshot_private.native_reservation_events(event_id),
 accepted_prepare boolean not null,base_revision bigint not null check(base_revision between 1 and 9007199254740988),
 source_cloud_table_id text not null references public.tables(id),target_cloud_table_id text references public.tables(id),
 created_at timestamptz not null,
 check(accepted_prepare=(target_cloud_table_id is not null)),
 check(octet_length(convert_to(prepare_payload,'UTF8'))<=1048576),
 check(prepare_payload is json object with unique keys),
 check(prepare_body=prepare_payload::jsonb),
 check(prepare_payload_sha256=encode(extensions.digest(convert_to(prepare_payload,'UTF8'),'sha256'),'hex'))
);
create temporary table native_move_cancel_expected(
 move_id uuid primary key,claim_id uuid not null,prepare_event_id uuid not null unique,prepare_payload text not null,
 prepare_payload_sha256 text not null check(prepare_payload_sha256 ~ '^[0-9a-f]{64}$'),prepare_body jsonb not null check(jsonb_typeof(prepare_body)='object'),
 cancel_event_id uuid not null unique,accepted_prepare boolean not null,base_revision bigint not null check(base_revision between 1 and 9007199254740988),
 source_cloud_table_id text not null,target_cloud_table_id text,created_at timestamptz not null,
 check(accepted_prepare=(target_cloud_table_id is not null)),check(octet_length(convert_to(prepare_payload,'UTF8'))<=1048576),
 check(prepare_payload is json object with unique keys),check(prepare_body=prepare_payload::jsonb),
 check(prepare_payload_sha256=encode(extensions.digest(convert_to(prepare_payload,'UTF8'),'sha256'),'hex'))
) on commit drop;
create temporary table native_move_cancel_events_expected(
 event_id uuid primary key,event_type text not null check(event_type in ('admission','reservation-completion','reservation-move-prepare','reservation-move-commit','reservation-move-abort')),
 claim_id uuid not null,device_id uuid not null,accepted_by uuid not null,
 payload_sha256 text not null check(payload_sha256 ~ '^[0-9a-f]{64}$'),payload jsonb not null check(jsonb_typeof(payload)='object'),
 ack jsonb not null check(jsonb_typeof(ack)='object'),received_at timestamptz not null
) on commit drop;
create unique index native_cancel_events_expected_lifecycle on native_move_cancel_events_expected(claim_id,event_type) where event_type in ('admission','reservation-completion');
lock table oneshot_private.native_reservation_events,oneshot_private.native_move_cancellations in access exclusive mode;
do $$declare pair text[];a oid;e oid;f record;upgraded boolean:=exists(select 1 from pg_constraint where conrelid='oneshot_private.native_reservation_events'::regclass and contype='c' and pg_get_constraintdef(oid) like '%reservation-move-cancel%');begin
 if upgraded then
  alter table native_move_cancel_events_expected drop constraint native_move_cancel_events_expected_event_type_check;
  alter table native_move_cancel_events_expected add check(event_type in ('admission','reservation-completion','reservation-move-prepare','reservation-move-commit','reservation-move-abort','reservation-move-cancel'));
 end if;
 foreach pair slice 1 in array array[['oneshot_private.native_move_cancellations','pg_temp.native_move_cancel_expected'],['oneshot_private.native_reservation_events','pg_temp.native_move_cancel_events_expected']] loop
  a:=pair[1]::regclass;e:=pair[2]::regclass;
  if (select relkind<>'r' or relpersistence<>'p' or relispartition from pg_class where oid=a) or exists(select 1 from pg_inherits where inhrelid=a or inhparent=a) or exists(select 1 from pg_rewrite where ev_class=a) or exists(select 1 from pg_trigger where tgrelid=a and not tgisinternal and tgname<>(case pair[1] when 'oneshot_private.native_move_cancellations' then 'native_move_cancel_immutable' else 'native_event_immutable' end)) or oneshot_private.native_move_shape(a) is distinct from oneshot_private.native_move_shape(e) then raise exception 'INCOMPATIBLE_NATIVE_MOVE_CANCEL_SCHEMA';end if;
  if exists(select 1 from pg_class c cross join lateral aclexplode(c.relacl) x where c.oid=a and x.grantee<>c.relowner) then raise exception 'INCOMPATIBLE_NATIVE_MOVE_CANCEL_ACL';end if;
  if (select count(*) from pg_constraint where conrelid=a and contype='f')<>(case pair[1] when 'oneshot_private.native_move_cancellations' then 4 else 2 end) then raise exception 'INCOMPATIBLE_NATIVE_MOVE_CANCEL_FOREIGN_KEY';end if;
 end loop;
 for f in select * from (values
 ('oneshot_private.native_move_cancellations','claim_id','oneshot_private.checkin_claims','id'),('oneshot_private.native_move_cancellations','cancel_event_id','oneshot_private.native_reservation_events','event_id'),('oneshot_private.native_move_cancellations','source_cloud_table_id','public.tables','id'),('oneshot_private.native_move_cancellations','target_cloud_table_id','public.tables','id'),
 ('oneshot_private.native_reservation_events','claim_id','oneshot_private.checkin_claims','id'),('oneshot_private.native_reservation_events','accepted_by','auth.users','id')
 )expected(source,column_name,target,target_column) loop
  if not exists(select 1 from pg_constraint c where c.conrelid=f.source::regclass and c.contype='f' and c.confrelid=f.target::regclass and c.conkey=array[(select attnum from pg_attribute where attrelid=f.source::regclass and attname=f.column_name)]::smallint[] and c.confkey=array[(select attnum from pg_attribute where attrelid=f.target::regclass and attname=f.target_column)]::smallint[] and c.convalidated and not c.condeferrable and not c.condeferred and c.confupdtype='a' and c.confdeltype='a' and c.confmatchtype='s' and c.conislocal and c.coninhcount=0) then raise exception 'INCOMPATIBLE_NATIVE_MOVE_CANCEL_FOREIGN_KEY';end if;
 end loop;
 if not upgraded then
  alter table oneshot_private.native_reservation_events drop constraint native_reservation_events_event_type_check;
  alter table oneshot_private.native_reservation_events add check(event_type in ('admission','reservation-completion','reservation-move-prepare','reservation-move-commit','reservation-move-abort','reservation-move-cancel'));
 end if;
end$$;
alter table oneshot_private.native_move_cancellations enable row level security;
revoke all on oneshot_private.native_move_cancellations from public,anon,authenticated;
drop trigger if exists native_move_cancel_immutable on oneshot_private.native_move_cancellations;
create trigger native_move_cancel_immutable before update or delete on oneshot_private.native_move_cancellations for each row execute function oneshot_private.freeze_checkin_audit();

create or replace function oneshot_private.native_move_is_cancelled(move uuid,prepare_event uuid) returns boolean
language sql stable security definer set search_path='' as $$select exists(select 1 from oneshot_private.native_move_cancellations where move_id=move or prepare_event_id=prepare_event)$$;
create or replace function oneshot_private.native_move_cancel_projection_allowed(old_row jsonb,new_row jsonb) returns boolean
language sql stable security definer set search_path='' as $$
 select old_row->>'status'='checked-in' and new_row->>'status'='checked-in'
 and (old_row-array['revision'])=(new_row-array['revision'])
 and exists(select 1 from oneshot_private.native_move_cancellations x join oneshot_private.checkin_claims c on c.id=x.claim_id join oneshot_private.native_reservation_events e on e.event_id=x.cancel_event_id
 where c.reservation_id=old_row->>'id' and (old_row->>'revision')::bigint=x.base_revision+case when x.accepted_prepare then 1 else 0 end and (new_row->>'revision')::bigint=x.base_revision+2 and (e.ack->>'revision')::bigint=x.base_revision+2 and e.event_type='reservation-move-cancel' and e.ack->>'state'='move-cancelled')
$$;
create or replace function oneshot_private.native_move_cancel_release_allowed(old_row jsonb) returns boolean
language sql stable security definer set search_path='' as $$
 select old_row->>'allocation_kind'='move-target' and exists(select 1 from oneshot_private.native_move_cancellations x join oneshot_private.checkin_claims c on c.id=x.claim_id join public.reservations r on r.id=c.reservation_id join oneshot_private.native_reservation_events e on e.event_id=x.cancel_event_id
 where x.move_id::text=old_row->>'move_id' and x.claim_id::text=old_row->>'claim_id' and x.accepted_prepare and x.target_cloud_table_id=old_row->>'cloud_table_id' and r.status='checked-in' and r.revision=x.base_revision+2 and (e.ack->>'revision')::bigint=r.revision)
$$;
revoke all on function oneshot_private.native_move_is_cancelled(uuid,uuid),oneshot_private.native_move_cancel_projection_allowed(jsonb,jsonb),oneshot_private.native_move_cancel_release_allowed(jsonb) from public,anon,authenticated;

create or replace function oneshot_private.ack_native_move_cancel(envelope jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare proof jsonb;body jsonb;p jsonb;raw_prepare text;prepare_hash text;prior oneshot_private.native_reservation_events%rowtype;
 c oneshot_private.checkin_claims%rowtype;r public.reservations%rowtype;a oneshot_private.native_reservation_events%rowtype;position_event oneshot_private.native_reservation_events%rowtype;
 plan oneshot_private.native_move_operations%rowtype;prepared oneshot_private.native_reservation_events%rowtype;source_allocation oneshot_private.active_checkin_tables%rowtype;target_allocation oneshot_private.active_checkin_tables%rowtype;
 target_row public.tables%rowtype;v_event_id uuid;v_move_id uuid;v_prepare_id uuid;field text;candidate jsonb;base_revision bigint;position_sequence bigint:=0;position_id uuid;source_native text;
 accepted boolean:=false;ack jsonb;received timestamptz;hold text;changed integer;target_cloud text;
begin
 proof:=oneshot_private.authorize_staff_native_event(envelope);
 lock table public.system_settings,public.closed_dates,public.events in share mode;
 lock table public.tables,public.reservations in share row exclusive mode;
 proof:=oneshot_private.authorize_staff_native_event(envelope);body:=proof->'body';v_event_id:=(proof->>'eventId')::uuid;
 if proof->>'eventType'<>'reservation-move-cancel' then raise exception 'INVALID_NATIVE_MOVE_CANCEL_TYPE';end if;
 select * into prior from oneshot_private.native_reservation_events where event_id=v_event_id;
 if found then
  if prior.claim_id::text is distinct from proof->>'claimId' or prior.device_id::text is distinct from proof->>'deviceId' or prior.event_type<>'reservation-move-cancel' or prior.payload_sha256<>proof->>'payloadSha256' or prior.payload<>body then raise exception 'NATIVE_EVENT_IDEMPOTENCY_CONFLICT';end if;
  return jsonb_build_object('ack',prior.ack,'replayed',true,'recordType','reservation-lifecycle-ack','fundsTransferred',false);
 end if;
 perform oneshot_private.lifecycle_fields(body,array['version','eventId','type','moveId','prepareEventId','claimId','reservationId','deviceId','claimRequestId','admissionEventId','sourceTableId','targetTableId','positionSequence','previousPositionEventId','expectedRevision','localStaffId','cloudUserId','sessionStartTime','preparePayload','preparePayloadSha256']);
 if body->'version' is distinct from '1'::jsonb or jsonb_typeof(body->'preparePayload') is distinct from 'string' or jsonb_typeof(body->'preparePayloadSha256') is distinct from 'string' or body->>'preparePayloadSha256' !~ '^[0-9a-f]{64}$' then raise exception 'NATIVE_MOVE_CANCEL_INVALID_PAYLOAD';end if;
 raw_prepare:=body->>'preparePayload';prepare_hash:=encode(extensions.digest(convert_to(raw_prepare,'UTF8'),'sha256'),'hex');
 if octet_length(convert_to(raw_prepare,'UTF8'))>1048576 or prepare_hash<>body->>'preparePayloadSha256' or not(raw_prepare is json object with unique keys) then raise exception 'NATIVE_MOVE_CANCEL_PREPARE_MISMATCH';end if;
 p:=raw_prepare::jsonb;
 perform oneshot_private.lifecycle_fields(p,array['version','eventId','type','moveId','prepareEventId','claimId','reservationId','deviceId','claimRequestId','admissionEventId','sourceTableId','targetTableId','positionSequence','previousPositionEventId','expectedRevision','localStaffId','cloudUserId','sessionStartTime']);
 if p->'version' is distinct from '1'::jsonb or p->>'type'<>'reservation-move-prepare' or p->'eventId' is distinct from p->'prepareEventId' or body->'eventId'=body->'prepareEventId'
  or (body-array['eventId','type','localStaffId','cloudUserId','preparePayload','preparePayloadSha256']) is distinct from (p-array['eventId','type','localStaffId','cloudUserId']) then raise exception 'NATIVE_MOVE_CANCEL_PREPARE_MISMATCH';end if;
 foreach candidate in array array[body,p] loop
  foreach field in array array['moveId','prepareEventId','admissionEventId','previousPositionEventId','cloudUserId'] loop
   if jsonb_typeof(candidate->field) is distinct from 'string' or candidate->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'NATIVE_MOVE_INVALID_IDENTIFIER';end if;
  end loop;
  foreach field in array array['sourceTableId','targetTableId','localStaffId'] loop
   if jsonb_typeof(candidate->field) is distinct from 'string' or length(candidate->>field) not between 1 and 120 or btrim(candidate->>field)<>candidate->>field then raise exception 'NATIVE_MOVE_INVALID_IDENTIFIER';end if;
  end loop;
 end loop;
 if body->'sourceTableId'=body->'targetTableId' then raise exception 'NATIVE_MOVE_ACTOR_OR_TABLE_MISMATCH';end if;
 v_move_id:=(body->>'moveId')::uuid;v_prepare_id:=(body->>'prepareEventId')::uuid;base_revision:=oneshot_private.lifecycle_cents(body->'expectedRevision');
 if base_revision not between 1 and 9007199254740988 then raise exception 'NATIVE_MOVE_CANCEL_STALE_REVISION';end if;
 if oneshot_private.native_move_is_cancelled(v_move_id,v_prepare_id) then raise exception 'NATIVE_MOVE_CANCELLED';end if;
 select * into c from oneshot_private.checkin_claims where id=(proof->>'claimId')::uuid;
 select * into r from public.reservations where id=c.reservation_id for update;
 proof:=oneshot_private.authorize_staff_native_event(envelope);
 if not found or r.status is distinct from 'checked-in' or r.customer_user_id::text is distinct from c.snapshot->>'ownerUserId' then raise exception 'NATIVE_MOVE_BOOKING_STATE';end if;
 select * into a from oneshot_private.native_reservation_events where claim_id=c.id and event_type='admission';
 if not found or body->'admissionEventId' is distinct from to_jsonb(a.event_id::text) or body->'sessionStartTime' is distinct from a.payload->'sessionStartTime' then raise exception 'NATIVE_MOVE_ADMISSION_MISMATCH';end if;
 select * into source_allocation from oneshot_private.active_checkin_tables where claim_id=c.id and allocation_kind='current' for update;
 if not found then raise exception 'NATIVE_CURRENT_POSITION_RECONCILIATION';end if;
 proof:=oneshot_private.authorize_staff_native_event(envelope);
 -- Resolve current authority from immutable audit plus the private current
 -- allocation, never mutable target/source mapping or a caller-supplied cloud ID.
 select e.* into position_event from oneshot_private.native_reservation_events e where e.claim_id=c.id and e.event_type='reservation-move-commit' order by (e.ack->>'revision')::bigint desc limit 1;
 if found then source_native:=position_event.payload->>'targetTableId';position_sequence:=(position_event.payload->>'positionSequence')::bigint;position_id:=position_event.event_id;
 else source_native:=c.native_table_id;position_id:=a.event_id;end if;
 if body->>'sourceTableId' is distinct from source_native or oneshot_private.lifecycle_cents(body->'positionSequence')<>position_sequence+1 or body->'previousPositionEventId' is distinct from to_jsonb(position_id::text) then raise exception 'NATIVE_MOVE_POSITION_MISMATCH';end if;
 select * into plan from oneshot_private.native_move_operations where id=v_move_id;
 if found then
  accepted:=true;
  select * into prepared from oneshot_private.native_reservation_events where event_id=plan.prepare_event_id;
  if plan.claim_id<>c.id or plan.prepare_event_id<>v_prepare_id or plan.prepare_body<>p or prepared.event_type<>'reservation-move-prepare' or prepared.payload<>p or prepared.payload_sha256<>prepare_hash then raise exception 'NATIVE_MOVE_CANCEL_PREPARE_MISMATCH';end if;
  if exists(select 1 from oneshot_private.native_move_terminals where move_id=v_move_id) then raise exception 'NATIVE_MOVE_ALREADY_TERMINAL';end if;
  if r.revision<>base_revision+1 or (prepared.ack->>'revision')::bigint<>r.revision then raise exception 'NATIVE_MOVE_CANCEL_STALE_REVISION';end if;
  select * into target_allocation from oneshot_private.active_checkin_tables where claim_id=c.id and move_id=v_move_id and allocation_kind='move-target' for update;
  if not found then raise exception 'NATIVE_MOVE_TARGET_HOLD_MISMATCH';end if;
  proof:=oneshot_private.authorize_staff_native_event(envelope);target_cloud:=target_allocation.cloud_table_id;
  select * into target_row from public.tables where id=target_cloud for update;
  if not found then raise exception 'NATIVE_MOVE_TARGET_HOLD_MISMATCH';end if;
  proof:=oneshot_private.authorize_staff_native_event(envelope);
 else
  if exists(select 1 from oneshot_private.native_reservation_events where event_id=v_prepare_id) or exists(select 1 from oneshot_private.native_move_operations where prepare_event_id=v_prepare_id) then raise exception 'NATIVE_MOVE_CANCEL_PREPARE_MISMATCH';end if;
  if r.revision<>base_revision or exists(select 1 from oneshot_private.active_checkin_tables where claim_id=c.id and allocation_kind='move-target') then raise exception 'NATIVE_MOVE_CANCEL_STALE_REVISION';end if;
 end if;
 proof:=oneshot_private.authorize_staff_native_event(envelope);received:=clock_timestamp();
 ack:=jsonb_build_object('eventId',v_event_id,'eventType','reservation-move-cancel','claimId',c.id,'deviceId',c.device_id,'reservationId',c.reservation_id,'payloadSha256',proof->'payloadSha256','state','move-cancelled','revision',base_revision+2,'receiptId',null,'receivedAt',to_char(received at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'acceptedBy',auth.uid());
 insert into oneshot_private.native_reservation_events(event_id,event_type,claim_id,device_id,accepted_by,payload_sha256,payload,ack,received_at) values(v_event_id,'reservation-move-cancel',c.id,c.device_id,auth.uid(),proof->>'payloadSha256',body,ack,received);
 insert into oneshot_private.native_move_cancellations(move_id,claim_id,prepare_event_id,prepare_payload,prepare_payload_sha256,prepare_body,cancel_event_id,accepted_prepare,base_revision,source_cloud_table_id,target_cloud_table_id,created_at) values(v_move_id,c.id,v_prepare_id,raw_prepare,prepare_hash,p,v_event_id,accepted,base_revision,source_allocation.cloud_table_id,target_cloud,received);
 update public.reservations set revision=base_revision+2 where id=r.id;
 if accepted then
  delete from oneshot_private.active_checkin_tables where cloud_table_id=target_cloud and claim_id=c.id and move_id=v_move_id and allocation_kind='move-target';
  get diagnostics changed=row_count;if changed<>1 then raise exception 'NATIVE_MOVE_TARGET_HOLD_MISMATCH';end if;
  hold:=jsonb_build_object('kind','trusted-native-move-hold','claimId',c.id,'deviceId',c.device_id,'moveId',v_move_id,'prepareEventId',v_prepare_id)::text;
  -- Release only our immutable allocation. Never erase unrelated occupation or
  -- re-enable a maintenance/disabled target after an operator configuration change.
  if target_row.sessiondata is not distinct from hold and target_row."sessionData" is not distinct from hold then
   update public.tables set status=case when status='reserved' then 'available' else status end,sessiondata=null,"sessionData"=null where id=target_cloud;
  end if;
 end if;
 return jsonb_build_object('ack',ack,'replayed',false,'recordType','reservation-lifecycle-ack','fundsTransferred',false);
end$$;
revoke all on function oneshot_private.ack_native_move_cancel(jsonb) from public,anon,authenticated;
commit;
