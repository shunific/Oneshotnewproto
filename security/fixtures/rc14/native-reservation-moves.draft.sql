-- LOCAL REVIEW CANDIDATE ONLY. Apply atomically with claim/proof/lifecycle changes.
-- No live activation: mappings remain owner-disabled; no timer releases move holds.
begin;
set local lock_timeout='3s';set local statement_timeout='20s';
do $$begin
 if current_setting('oneshot.secure_gateway_cutover',true) is distinct from 'reviewed' then raise exception 'Stop: reviewed coordinated gateway cutover required';end if;
 if to_regprocedure('oneshot_private.ack_native_event(jsonb)') is null then raise exception 'NATIVE_MOVE_PREREQUISITES_REQUIRED';end if;
end$$;
create table if not exists oneshot_private.native_move_operations(
 id uuid primary key,claim_id uuid not null references oneshot_private.checkin_claims(id),
 prepare_event_id uuid not null unique references oneshot_private.native_reservation_events(event_id),
 prepare_body jsonb not null check(jsonb_typeof(prepare_body)='object'),created_at timestamptz not null
);
create table if not exists oneshot_private.native_move_terminals(
 move_id uuid primary key references oneshot_private.native_move_operations(id),
 event_id uuid not null unique references oneshot_private.native_reservation_events(event_id),
 event_type text not null check(event_type in ('reservation-move-commit','reservation-move-abort'))
);
create table if not exists oneshot_private.native_move_upgrades(version integer primary key check(version=1),created_at timestamptz not null default now());
create temporary table native_move_ops_expected(id uuid primary key,claim_id uuid not null,prepare_event_id uuid not null unique,prepare_body jsonb not null check(jsonb_typeof(prepare_body)='object'),created_at timestamptz not null) on commit drop;
create temporary table native_move_term_expected(move_id uuid primary key,event_id uuid not null unique,event_type text not null check(event_type in ('reservation-move-commit','reservation-move-abort'))) on commit drop;
create temporary table native_move_upgrade_expected(version integer primary key check(version=1),created_at timestamptz not null default now()) on commit drop;
create temporary table native_move_alloc_expected(cloud_table_id text primary key,claim_id uuid not null unique) on commit drop;
create temporary table native_move_events_expected(
 event_id uuid primary key,event_type text not null check(event_type in ('admission','reservation-completion')),
 claim_id uuid not null,device_id uuid not null,accepted_by uuid not null,key_id uuid not null,
 payload_sha256 text not null check(payload_sha256 ~ '^[0-9a-f]{64}$'),payload jsonb not null check(jsonb_typeof(payload)='object'),
 ack jsonb not null check(jsonb_typeof(ack)='object'),received_at timestamptz not null,unique(claim_id,event_type)
) on commit drop;
lock table oneshot_private.active_checkin_tables,oneshot_private.native_reservation_events,oneshot_private.native_move_operations,oneshot_private.native_move_terminals,oneshot_private.native_move_upgrades in access exclusive mode;
do $$begin
 if exists(select 1 from pg_attribute where attrelid='oneshot_private.active_checkin_tables'::regclass and attname='allocation_kind' and not attisdropped) then
  alter table native_move_alloc_expected drop constraint native_move_alloc_expected_claim_id_key;
  alter table native_move_alloc_expected add allocation_kind text not null default 'current' check(allocation_kind in ('current','move-target'));
  alter table native_move_alloc_expected add move_id uuid;
  alter table native_move_alloc_expected add check(allocation_kind='current' or move_id is not null);
  create unique index native_move_alloc_expected_current on native_move_alloc_expected(claim_id) where allocation_kind='current';
  create unique index native_move_alloc_expected_target on native_move_alloc_expected(claim_id) where allocation_kind='move-target';
  alter table native_move_events_expected drop constraint native_move_events_expected_event_type_check;
  alter table native_move_events_expected add check(event_type in ('admission','reservation-completion','reservation-move-prepare','reservation-move-commit','reservation-move-abort'));
  alter table native_move_events_expected drop constraint native_move_events_expected_claim_id_event_type_key;
  create unique index native_move_expected_lifecycle on native_move_events_expected(claim_id,event_type) where event_type in ('admission','reservation-completion');
 end if;
end$$;
-- Exact known old/new shapes are validated before changing any existing constraint.
create or replace function oneshot_private.native_move_shape(target oid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('owner',(select relowner from pg_class where oid=target),
 'columns',(select jsonb_agg(jsonb_build_array(a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,a.attacl,a.attinhcount,a.attislocal,pg_get_expr(d.adbin,d.adrelid,false)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=target and a.attnum>0 and not a.attisdropped),
 'constraints',(select jsonb_agg(jsonb_build_array(contype,pg_get_constraintdef(oid,false),convalidated,condeferrable,condeferred,connoinherit,conislocal,coninhcount) order by contype,pg_get_constraintdef(oid,false)) from pg_constraint where conrelid=target and contype<>'f'),
 'indexes',(select jsonb_agg(jsonb_build_array(indkey::text,indisunique,indisprimary,indisvalid,indisready,pg_get_expr(indexprs,indrelid),pg_get_expr(indpred,indrelid)) order by indkey::text,indisunique,indisprimary) from pg_index where indrelid=target))
$$;
revoke all on function oneshot_private.native_move_shape(oid) from public,anon,authenticated;
do $$declare pair text[];a oid;e oid;f record;new_shape boolean:=exists(select 1 from pg_attribute where attrelid='oneshot_private.active_checkin_tables'::regclass and attname='allocation_kind' and not attisdropped);begin
 foreach pair slice 1 in array array[
 ['oneshot_private.active_checkin_tables','pg_temp.native_move_alloc_expected'],['oneshot_private.native_reservation_events','pg_temp.native_move_events_expected'],
 ['oneshot_private.native_move_operations','pg_temp.native_move_ops_expected'],['oneshot_private.native_move_terminals','pg_temp.native_move_term_expected'],['oneshot_private.native_move_upgrades','pg_temp.native_move_upgrade_expected']] loop
  a:=pair[1]::regclass;e:=pair[2]::regclass;
  if (select relkind<>'r' or relpersistence<>'p' or relispartition from pg_class where oid=a) or exists(select 1 from pg_inherits where inhrelid=a or inhparent=a) or exists(select 1 from pg_rewrite where ev_class=a) or exists(select 1 from pg_trigger where tgrelid=a and not tgisinternal and tgname not in ('checkin_active_pointer_guard','native_event_immutable','native_move_operation_immutable','native_move_terminal_immutable','native_move_upgrade_immutable')) or oneshot_private.native_move_shape(a) is distinct from oneshot_private.native_move_shape(e) then raise exception 'INCOMPATIBLE_NATIVE_MOVE_SCHEMA';end if;
  if exists(select 1 from pg_class c cross join lateral aclexplode(c.relacl) x where c.oid=a and x.grantee<>c.relowner) then raise exception 'INCOMPATIBLE_NATIVE_MOVE_ACL';end if;
  if (select count(*) from pg_constraint where conrelid=a and contype='f')<>(case pair[1] when 'oneshot_private.active_checkin_tables' then case when new_shape then 3 else 2 end when 'oneshot_private.native_reservation_events' then 3 when 'oneshot_private.native_move_upgrades' then 0 else 2 end) then raise exception 'INCOMPATIBLE_NATIVE_MOVE_FOREIGN_KEY';end if;
 end loop;
 for f in select * from (values
 ('oneshot_private.active_checkin_tables','cloud_table_id','public.tables','id'),('oneshot_private.active_checkin_tables','claim_id','oneshot_private.checkin_claims','id'),('oneshot_private.active_checkin_tables','move_id','oneshot_private.native_move_operations','id'),
 ('oneshot_private.native_reservation_events','claim_id','oneshot_private.checkin_claims','id'),('oneshot_private.native_reservation_events','accepted_by','auth.users','id'),('oneshot_private.native_reservation_events','key_id','oneshot_private.native_device_keys','key_id'),
 ('oneshot_private.native_move_operations','claim_id','oneshot_private.checkin_claims','id'),('oneshot_private.native_move_operations','prepare_event_id','oneshot_private.native_reservation_events','event_id'),('oneshot_private.native_move_terminals','move_id','oneshot_private.native_move_operations','id'),('oneshot_private.native_move_terminals','event_id','oneshot_private.native_reservation_events','event_id')
 )expected(source,column_name,target,target_column) loop
  if f.column_name='move_id' and f.source='oneshot_private.active_checkin_tables' and not new_shape then continue;end if;
  if not exists(select 1 from pg_constraint c where c.conrelid=f.source::regclass and c.contype='f' and c.confrelid=f.target::regclass and c.conkey=array[(select attnum from pg_attribute where attrelid=f.source::regclass and attname=f.column_name)]::smallint[] and c.confkey=array[(select attnum from pg_attribute where attrelid=f.target::regclass and attname=f.target_column)]::smallint[] and c.convalidated and not c.condeferrable and not c.condeferred and c.confupdtype='a' and c.confdeltype='a' and c.confmatchtype='s' and c.conislocal and c.coninhcount=0) then raise exception 'INCOMPATIBLE_NATIVE_MOVE_FOREIGN_KEY';end if;
 end loop;
 if not new_shape then
  alter table oneshot_private.active_checkin_tables drop constraint active_checkin_tables_claim_id_key;
  alter table oneshot_private.active_checkin_tables add allocation_kind text not null default 'current' check(allocation_kind in ('current','move-target'));
  alter table oneshot_private.active_checkin_tables add move_id uuid references oneshot_private.native_move_operations(id);
  alter table oneshot_private.active_checkin_tables add check(allocation_kind='current' or move_id is not null);
  create unique index checkin_one_current on oneshot_private.active_checkin_tables(claim_id) where allocation_kind='current';
  create unique index checkin_one_move_target on oneshot_private.active_checkin_tables(claim_id) where allocation_kind='move-target';
  alter table oneshot_private.native_reservation_events drop constraint native_reservation_events_event_type_check;
  alter table oneshot_private.native_reservation_events add check(event_type in ('admission','reservation-completion','reservation-move-prepare','reservation-move-commit','reservation-move-abort'));
  alter table oneshot_private.native_reservation_events drop constraint native_reservation_events_claim_id_event_type_key;
  create unique index native_events_one_lifecycle on oneshot_private.native_reservation_events(claim_id,event_type) where event_type in ('admission','reservation-completion');
  insert into oneshot_private.native_move_upgrades(version) values(1);
 elsif not exists(select 1 from oneshot_private.native_move_upgrades where version=1) then raise exception 'NATIVE_MOVE_UPGRADE_MARKER_REQUIRED';end if;
end$$;
alter table oneshot_private.native_move_operations enable row level security;
alter table oneshot_private.native_move_terminals enable row level security;
alter table oneshot_private.native_move_upgrades enable row level security;
revoke all on oneshot_private.native_move_operations,oneshot_private.native_move_terminals,oneshot_private.native_move_upgrades from public,anon,authenticated;
drop trigger if exists native_move_operation_immutable on oneshot_private.native_move_operations;
create trigger native_move_operation_immutable before update or delete on oneshot_private.native_move_operations for each row execute function oneshot_private.freeze_checkin_audit();
drop trigger if exists native_move_terminal_immutable on oneshot_private.native_move_terminals;
create trigger native_move_terminal_immutable before update or delete on oneshot_private.native_move_terminals for each row execute function oneshot_private.freeze_checkin_audit();
drop trigger if exists native_move_upgrade_immutable on oneshot_private.native_move_upgrades;
create trigger native_move_upgrade_immutable before update or delete on oneshot_private.native_move_upgrades for each row execute function oneshot_private.freeze_checkin_audit();

create or replace function oneshot_private.native_position(claim uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$declare c oneshot_private.checkin_claims%rowtype;a oneshot_private.native_reservation_events%rowtype;e oneshot_private.native_reservation_events%rowtype;p oneshot_private.active_checkin_tables%rowtype;native_table text;seq bigint:=0;position_event uuid;begin
 select * into c from oneshot_private.checkin_claims where id=claim;
 select * into a from oneshot_private.native_reservation_events where claim_id=claim and event_type='admission';
 if not found then raise exception 'NATIVE_ADMISSION_ACK_REQUIRED';end if;
 select * into e from oneshot_private.native_reservation_events where claim_id=claim and event_type='reservation-move-commit' order by (ack->>'revision')::bigint desc limit 1;
 if found then native_table:=e.payload->>'targetTableId';seq:=(e.payload->>'positionSequence')::bigint;position_event:=e.event_id;
 else native_table:=c.native_table_id;position_event:=a.event_id;end if;
 select * into p from oneshot_private.active_checkin_tables where claim_id=claim and allocation_kind='current';
 if not found or not exists(select 1 from oneshot_private.checkin_table_mappings where device_id=c.device_id and native_table_id=native_table and cloud_table_id=p.cloud_table_id) then raise exception 'NATIVE_CURRENT_POSITION_RECONCILIATION';end if;
 return jsonb_build_object('tableId',native_table,'cloudTableId',p.cloud_table_id,'positionSequence',seq,'positionEventId',position_event,'admissionEventId',a.event_id,'sessionStartTime',a.payload->'sessionStartTime');
end$$;
create or replace function oneshot_private.native_position_projection(claim uuid) returns text
language plpgsql stable security definer set search_path='' as $$declare c oneshot_private.checkin_claims%rowtype;p jsonb;result jsonb;begin
 select * into c from oneshot_private.checkin_claims where id=claim;p:=oneshot_private.native_position(claim);
 result:=jsonb_build_object('kind','trusted-native-reservation','claimId',c.id,'admissionEventId',p->'admissionEventId','deviceId',c.device_id,'startTime',p->'sessionStartTime','durationMinutes',c.snapshot->'durationMinutes','isOpenTime',false);
 if (p->>'positionSequence')::bigint>0 then result:=result||jsonb_build_object('positionSequence',p->'positionSequence','positionEventId',p->'positionEventId');end if;
 return result::text;
end$$;
create or replace function oneshot_private.native_move_release_allowed(claim uuid,cloud_table text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from oneshot_private.native_final_receipts f join oneshot_private.native_reservation_events e on e.event_id=f.event_id join public.reservations r on r.id=f.reservation_id join oneshot_private.active_checkin_tables p on p.claim_id=f.claim_id and p.allocation_kind='current' join oneshot_private.checkin_claims c on c.id=f.claim_id join oneshot_private.checkin_table_mappings m on m.device_id=c.device_id and m.cloud_table_id=p.cloud_table_id and m.native_table_id=f.receipt->>'table_id'
 where f.claim_id=claim and p.cloud_table_id=cloud_table and e.event_type='reservation-completion' and r.status='completed' and (e.ack->>'revision')::bigint=r.revision)
$$;
create or replace function oneshot_private.native_allocation_allowed(operation text,old_row jsonb,new_row jsonb) returns boolean
language plpgsql stable security definer set search_path='' as $$declare plan oneshot_private.native_move_operations%rowtype;terminal oneshot_private.native_reservation_events%rowtype;r public.reservations%rowtype;c oneshot_private.checkin_claims%rowtype;row_value jsonb:=case when operation='DELETE' then old_row else new_row end;begin
 select * into c from oneshot_private.checkin_claims where id=(row_value->>'claim_id')::uuid;
 select * into r from public.reservations where id=c.reservation_id;
 if operation='INSERT' and new_row->>'allocation_kind'='current' and new_row->'move_id'='null'::jsonb then
  return c.cloud_table_id=new_row->>'cloud_table_id' and r.status='claim-pending' and not exists(select 1 from oneshot_private.native_reservation_events where claim_id=c.id and event_type='admission');
 end if;
 if operation='DELETE' and old_row->>'allocation_kind'='current' and oneshot_private.native_move_release_allowed(c.id,old_row->>'cloud_table_id') then return true;end if;
 if operation='DELETE' and old_row->>'allocation_kind'='current' then
  select e.* into terminal from oneshot_private.native_move_terminals x join oneshot_private.native_reservation_events e on e.event_id=x.event_id join oneshot_private.native_move_operations o on o.id=x.move_id where o.claim_id=c.id and x.event_type='reservation-move-commit' and (e.ack->>'revision')::bigint=r.revision;
  return found and exists(select 1 from oneshot_private.checkin_table_mappings where device_id=c.device_id and native_table_id=terminal.payload->>'sourceTableId' and cloud_table_id=old_row->>'cloud_table_id');
 end if;
 select * into plan from oneshot_private.native_move_operations where id=(row_value->>'move_id')::uuid and claim_id=c.id;
 if not found or not exists(select 1 from oneshot_private.checkin_table_mappings where device_id=c.device_id and native_table_id=plan.prepare_body->>'targetTableId' and cloud_table_id=row_value->>'cloud_table_id') then return false;end if;
 if operation='INSERT' then
  return new_row->>'allocation_kind'='move-target' and r.status='checked-in' and exists(select 1 from oneshot_private.native_reservation_events where event_id=plan.prepare_event_id and payload=plan.prepare_body and (ack->>'revision')::bigint=r.revision) and not exists(select 1 from oneshot_private.native_move_terminals where move_id=plan.id);
 end if;
 select e.* into terminal from oneshot_private.native_move_terminals x join oneshot_private.native_reservation_events e on e.event_id=x.event_id where x.move_id=plan.id and (e.ack->>'revision')::bigint=r.revision;
 if not found or r.status<>'checked-in' then return false;end if;
 if operation='DELETE' then return old_row->>'allocation_kind'='move-target' and terminal.event_type='reservation-move-abort';end if;
 return operation='UPDATE' and terminal.event_type='reservation-move-commit' and old_row->>'allocation_kind'='move-target' and new_row->>'allocation_kind'='current' and (old_row-'allocation_kind')=(new_row-'allocation_kind');
end$$;
revoke all on function oneshot_private.native_position(uuid),oneshot_private.native_position_projection(uuid),oneshot_private.native_move_release_allowed(uuid,text),oneshot_private.native_allocation_allowed(text,jsonb,jsonb) from public,anon,authenticated;

-- Occupancy safety only: this does not extend booked time or change any charge.
-- Overdue play checks commitments through reviewed operating close; venue must
-- validate this conservative rule before activation.
create or replace function oneshot_private.native_move_target_schedule(c oneshot_private.checkin_claims,admission jsonb,target text) returns void
language plpgsql set search_path='' as $$declare cfg jsonb;begins timestamp:=timezone('Asia/Manila',clock_timestamp());ends timestamp;closing timestamp;opening timestamp;anchor date;prefix text;fits boolean:=false;day_cursor date;day_end timestamp;segment timestamp;segment_end timestamp;closure record;begin
 select jsonb_object_agg(key_name,setting_value) into cfg from public.system_settings;
 ends:=timezone('Asia/Manila',oneshot_private.lifecycle_timestamp(admission->'sessionStartTime'))+(c.snapshot->>'durationMinutes')::bigint*interval '1 minute';
 for anchor in select generate_series(begins::date-1,begins::date,interval '1 day')::date loop
  prefix:=case when extract(dow from anchor) in (0,5,6) then 'weekend' else 'weekday' end;
  if coalesce(cfg->>(prefix||'StartTime'),'') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(cfg->>(prefix||'EndTime'),'') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or cfg->>(prefix||'StartTime')=cfg->>(prefix||'EndTime') then raise exception 'NATIVE_MOVE_SCHEDULE_CONFIG_REQUIRED';end if;
  opening:=anchor+(cfg->>(prefix||'StartTime'))::time;closing:=anchor+(cfg->>(prefix||'EndTime'))::time;
  if closing<opening then closing:=closing+interval '1 day';end if;
  if begins>=opening and begins<closing then
   if ends<=begins then ends:=closing;end if;
   if ends>closing then raise exception 'NATIVE_MOVE_OUTSIDE_OPERATING_HOURS';end if;
   fits:=true;exit;
  end if;
 end loop;
 if not fits then raise exception 'NATIVE_MOVE_OUTSIDE_OPERATING_HOURS';end if;
 for day_cursor in select generate_series(begins::date,ends::date,interval '1 day')::date loop
  day_end:=day_cursor+interval '1 day';segment:=greatest(begins,day_cursor::timestamp);segment_end:=least(ends,day_end);if segment>=segment_end then continue;end if;
  for closure in select * from public.closed_dates where coalesce(status,'')<>'cancelled' and cancelled_at is null and ((type='weekly' and day_of_week=extract(dow from day_cursor)) or (coalesce(type,'')<>'weekly' and closed_date=day_cursor)) loop
   if coalesce(closure.is_full_day,true) then raise exception 'NATIVE_MOVE_CLOSED_DATE';end if;
   if coalesce(closure.open_time,'') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(closure.close_time,'') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'NATIVE_MOVE_CLOSURE_CONFIG_REQUIRED';end if;
   opening:=day_cursor+closure.open_time::time;closing:=day_cursor+closure.close_time::time;if closure.close_time='00:00' then closing:=day_end;end if;
   if closing>opening then if segment<opening or segment_end>closing then raise exception 'NATIVE_MOVE_PARTIAL_CLOSURE';end if;
   elsif not((segment>=opening and segment_end<=day_end) or(segment>=day_cursor::timestamp and segment_end<=closing)) then raise exception 'NATIVE_MOVE_PARTIAL_CLOSURE';end if;
  end loop;
  if exists(select 1 from public.events where date=day_cursor and coalesce(iscancelled,0)=0 and coalesce(status,'')<>'cancelled' and cancelled_at is null) then raise exception 'NATIVE_MOVE_EVENT_ALLOCATION_REQUIRED';end if;
 end loop;
 if exists(select 1 from public.reservations x where x.id<>c.reservation_id and coalesce(x.status,'') not in ('cancelled','completed','pending-refund') and (x."tableId"=target or x."tableId" is null) and (x.date is null or coalesce(x."timeSlot",'') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or x."durationHours" is null or x."durationHours"<1 or x."durationHours">24)) then raise exception 'NATIVE_MOVE_BOOKING_RECONCILIATION_REQUIRED';end if;
 if exists(select 1 from public.reservations x where x.id<>c.reservation_id and x."tableId"=target and coalesce(x.status,'') not in ('cancelled','completed','pending-refund') and (x.date+x."timeSlot"::time)<ends and (x.date+x."timeSlot"::time+x."durationHours"*interval '1 hour')>begins) then raise exception 'NATIVE_MOVE_TARGET_BOOKING_CONFLICT';end if;
end$$;
revoke all on function oneshot_private.native_move_target_schedule(oneshot_private.checkin_claims,jsonb,text) from public,anon,authenticated;

create or replace function oneshot_private.ack_native_move(envelope jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare proof jsonb;body jsonb;position jsonb;prior oneshot_private.native_reservation_events%rowtype;a oneshot_private.native_reservation_events%rowtype;c oneshot_private.checkin_claims%rowtype;r public.reservations%rowtype;
 source_map oneshot_private.checkin_table_mappings%rowtype;target_map oneshot_private.checkin_table_mappings%rowtype;source_table public.tables%rowtype;target_table public.tables%rowtype;plan oneshot_private.native_move_operations%rowtype;
 move_uuid uuid;event_uuid uuid;v_event_type text;field text;ack jsonb;received timestamptz;projection text;hold text;next_revision bigint;changed integer;
begin
 proof:=oneshot_private.verify_native_device_event(envelope);
 lock table public.system_settings,public.closed_dates,public.events in share mode;
 lock table public.tables,public.reservations in share row exclusive mode;
 proof:=oneshot_private.verify_native_device_event(envelope);body:=proof->'body';v_event_type:=proof->>'eventType';event_uuid:=(proof->>'eventId')::uuid;
 if v_event_type not in ('reservation-move-prepare','reservation-move-commit','reservation-move-abort') then raise exception 'INVALID_NATIVE_MOVE_TYPE';end if;
 select * into prior from oneshot_private.native_reservation_events where event_id=event_uuid;
 if found then
  if prior.claim_id::text is distinct from proof->>'claimId' or prior.device_id::text is distinct from proof->>'deviceId' or prior.event_type<>v_event_type or prior.payload_sha256<>proof->>'payloadSha256' or prior.payload<>body then raise exception 'NATIVE_EVENT_IDEMPOTENCY_CONFLICT';end if;
  return jsonb_build_object('ack',prior.ack,'replayed',true,'recordType','reservation-lifecycle-ack','fundsTransferred',false);
 end if;
 perform oneshot_private.lifecycle_fields(body,array['version','eventId','type','moveId','prepareEventId','claimId','reservationId','deviceId','claimRequestId','admissionEventId','sourceTableId','targetTableId','positionSequence','previousPositionEventId','expectedRevision','localStaffId','cloudUserId','sessionStartTime']);
 if body->'version' is distinct from '1'::jsonb then raise exception 'NATIVE_MOVE_INVALID_VERSION';end if;
 foreach field in array array['moveId','prepareEventId','admissionEventId','previousPositionEventId','cloudUserId'] loop
  if jsonb_typeof(body->field) is distinct from 'string' or body->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'NATIVE_MOVE_INVALID_IDENTIFIER';end if;
 end loop;
 foreach field in array array['sourceTableId','targetTableId','localStaffId'] loop
  if jsonb_typeof(body->field) is distinct from 'string' or length(body->>field) not between 1 and 120 or btrim(body->>field)<>body->>field then raise exception 'NATIVE_MOVE_INVALID_IDENTIFIER';end if;
 end loop;
 if body->'sourceTableId'=body->'targetTableId' then raise exception 'NATIVE_MOVE_ACTOR_OR_TABLE_MISMATCH';end if;
 move_uuid:=(body->>'moveId')::uuid;
 select * into c from oneshot_private.checkin_claims where id=(proof->>'claimId')::uuid;
 -- Mapping locks use deterministic native-ID order, then reservation/table rows.
 perform 1 from oneshot_private.checkin_table_mappings where device_id=c.device_id and native_table_id in (body->>'sourceTableId',body->>'targetTableId') order by native_table_id for share;
 select * into source_map from oneshot_private.checkin_table_mappings where device_id=c.device_id and native_table_id=body->>'sourceTableId' and active and coordinator_ready and approved_by is not null;
 if not found then raise exception 'CHECKIN_COORDINATOR_NOT_READY';end if;
 select * into target_map from oneshot_private.checkin_table_mappings where device_id=c.device_id and native_table_id=body->>'targetTableId' and active and coordinator_ready and approved_by is not null;
 if not found or source_map.cloud_table_id=target_map.cloud_table_id then raise exception 'CHECKIN_COORDINATOR_NOT_READY';end if;
 select * into r from public.reservations where id=c.reservation_id for update;
 proof:=oneshot_private.verify_native_device_event(envelope);
 if r.status is distinct from 'checked-in' or r.customer_user_id::text is distinct from c.snapshot->>'ownerUserId' then raise exception 'NATIVE_MOVE_BOOKING_STATE';end if;
 if oneshot_private.lifecycle_cents(body->'expectedRevision')<>r.revision or r.revision>(case when v_event_type='reservation-move-prepare' then 9007199254740988 else 9007199254740989 end) then raise exception 'NATIVE_MOVE_STALE_REVISION';end if;
 select * into a from oneshot_private.native_reservation_events where claim_id=c.id and event_type='admission';
 if not found or body->'admissionEventId' is distinct from to_jsonb(a.event_id::text) or body->'sessionStartTime' is distinct from a.payload->'sessionStartTime' then raise exception 'NATIVE_MOVE_ADMISSION_MISMATCH';end if;
 position:=oneshot_private.native_position(c.id);
 if body->'sourceTableId' is distinct from position->'tableId' or source_map.cloud_table_id is distinct from position->>'cloudTableId' or oneshot_private.lifecycle_cents(body->'positionSequence')<>(position->>'positionSequence')::bigint+1 or body->'previousPositionEventId' is distinct from position->'positionEventId' then raise exception 'NATIVE_MOVE_POSITION_MISMATCH';end if;
 perform 1 from public.tables where id in(source_map.cloud_table_id,target_map.cloud_table_id) order by id for update;
 proof:=oneshot_private.verify_native_device_event(envelope);
 select * into source_table from public.tables where id=source_map.cloud_table_id;select * into target_table from public.tables where id=target_map.cloud_table_id;
 projection:=oneshot_private.native_position_projection(c.id);
 if source_table.status is distinct from 'occupied' or source_table.sessiondata is distinct from projection or source_table."sessionData" is distinct from projection then raise exception 'NATIVE_MOVE_SOURCE_MISMATCH';end if;
 next_revision:=r.revision+1;
 if v_event_type='reservation-move-prepare' then
  if body->'prepareEventId' is distinct from body->'eventId' or exists(select 1 from oneshot_private.native_move_operations where id=move_uuid) or exists(select 1 from oneshot_private.active_checkin_tables where claim_id=c.id and allocation_kind='move-target') then raise exception 'NATIVE_MOVE_ALREADY_PREPARED';end if;
  if target_table.status is distinct from 'available' or target_table.isactive is distinct from 1 or target_table."isActive" is distinct from 1 or target_table.sessiondata is not null or target_table."sessionData" is not null or exists(select 1 from oneshot_private.active_checkin_tables where cloud_table_id=target_map.cloud_table_id) then raise exception 'NATIVE_MOVE_TARGET_UNAVAILABLE';end if;
  proof:=oneshot_private.verify_native_device_event(envelope);
  perform oneshot_private.native_move_target_schedule(c,a.payload,target_map.cloud_table_id);
 else
  select * into plan from oneshot_private.native_move_operations where id=move_uuid and claim_id=c.id;
  if not found or body->'prepareEventId' is distinct from to_jsonb(plan.prepare_event_id::text) or (body-array['eventId','type','expectedRevision','localStaffId','cloudUserId']) is distinct from (plan.prepare_body-array['eventId','type','expectedRevision','localStaffId','cloudUserId']) then raise exception 'NATIVE_MOVE_PREPARE_MISMATCH';end if;
  if (select (e.ack->>'revision')::bigint from oneshot_private.native_reservation_events e where e.event_id=plan.prepare_event_id)<>r.revision then raise exception 'NATIVE_MOVE_STALE_REVISION';end if;
  if exists(select 1 from oneshot_private.native_move_terminals where move_id=move_uuid) then raise exception 'NATIVE_MOVE_ALREADY_TERMINAL';end if;
  hold:=jsonb_build_object('kind','trusted-native-move-hold','claimId',c.id,'deviceId',c.device_id,'moveId',move_uuid,'prepareEventId',plan.prepare_event_id)::text;
  if target_table.status is distinct from 'reserved' or target_table.sessiondata is distinct from hold or target_table."sessionData" is distinct from hold or not exists(select 1 from oneshot_private.active_checkin_tables where cloud_table_id=target_map.cloud_table_id and claim_id=c.id and allocation_kind='move-target' and move_id=move_uuid) then raise exception 'NATIVE_MOVE_TARGET_HOLD_MISMATCH';end if;
 end if;
 -- Every mapping, reservation, table and configuration wait has completed.
 proof:=oneshot_private.verify_native_device_event(envelope);received:=clock_timestamp();
 ack:=jsonb_build_object('eventId',event_uuid,'eventType',v_event_type,'claimId',c.id,'deviceId',c.device_id,'reservationId',c.reservation_id,'payloadSha256',proof->'payloadSha256','state',case v_event_type when 'reservation-move-prepare' then 'move-prepared' when 'reservation-move-commit' then 'moved' else 'move-aborted' end,'revision',next_revision,'receiptId',null,'receivedAt',to_char(received at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'acceptedBy',auth.uid());
 insert into oneshot_private.native_reservation_events(event_id,event_type,claim_id,device_id,accepted_by,key_id,payload_sha256,payload,ack,received_at) values(event_uuid,v_event_type,c.id,c.device_id,auth.uid(),(proof->>'keyId')::uuid,proof->>'payloadSha256',body,ack,received);
 if v_event_type='reservation-move-prepare' then
  insert into oneshot_private.native_move_operations(id,claim_id,prepare_event_id,prepare_body,created_at) values(move_uuid,c.id,event_uuid,body,received);
 else
  insert into oneshot_private.native_move_terminals(move_id,event_id,event_type) values(move_uuid,event_uuid,v_event_type);
 end if;
 update public.reservations set revision=next_revision where id=r.id;
 if v_event_type='reservation-move-prepare' then
  insert into oneshot_private.active_checkin_tables(cloud_table_id,claim_id,allocation_kind,move_id) values(target_map.cloud_table_id,c.id,'move-target',move_uuid);
  hold:=jsonb_build_object('kind','trusted-native-move-hold','claimId',c.id,'deviceId',c.device_id,'moveId',move_uuid,'prepareEventId',event_uuid)::text;
  update public.tables set status='reserved',sessiondata=hold,"sessionData"=hold where id=target_map.cloud_table_id;
 elsif v_event_type='reservation-move-commit' then
  delete from oneshot_private.active_checkin_tables where cloud_table_id=source_map.cloud_table_id and claim_id=c.id and allocation_kind='current';
  get diagnostics changed=row_count;if changed<>1 then raise exception 'NATIVE_MOVE_CURRENT_ALLOCATION_MISMATCH';end if;
  update oneshot_private.active_checkin_tables set allocation_kind='current' where cloud_table_id=target_map.cloud_table_id and claim_id=c.id and allocation_kind='move-target' and move_id=move_uuid;
  get diagnostics changed=row_count;if changed<>1 then raise exception 'NATIVE_MOVE_TARGET_HOLD_MISMATCH';end if;
  projection:=oneshot_private.native_position_projection(c.id);
  update public.tables set status='available',sessiondata=null,"sessionData"=null where id=source_map.cloud_table_id;
  update public.tables set status='occupied',sessiondata=projection,"sessionData"=projection where id=target_map.cloud_table_id;
 else
  delete from oneshot_private.active_checkin_tables where cloud_table_id=target_map.cloud_table_id and claim_id=c.id and allocation_kind='move-target' and move_id=move_uuid;
  get diagnostics changed=row_count;if changed<>1 then raise exception 'NATIVE_MOVE_TARGET_HOLD_MISMATCH';end if;
  update public.tables set status='available',sessiondata=null,"sessionData"=null where id=target_map.cloud_table_id;
 end if;
 return jsonb_build_object('ack',ack,'replayed',false,'recordType','reservation-lifecycle-ack','fundsTransferred',false);
end$$;
revoke all on function oneshot_private.ack_native_move(jsonb) from public,anon,authenticated;
commit;
