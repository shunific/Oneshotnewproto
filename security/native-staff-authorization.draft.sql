-- Staff-JWT event authorization: no per-device key or host attestation claim.
-- Install after staff identity and check-in claims, before lifecycle/moves.
begin;
set local lock_timeout='3s';set local statement_timeout='15s';
do $$begin
 if current_setting('oneshot.secure_gateway_cutover',true) is distinct from 'reviewed' then raise exception 'Stop: reviewed coordinated gateway cutover required';end if;
 if to_regprocedure('oneshot_private.verified_staff()') is null or to_regclass('oneshot_private.checkin_claims') is null then raise exception 'STAFF_NATIVE_PREREQUISITES_REQUIRED';end if;
end$$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$begin
 if not exists(select 1 from pg_extension where extname='pgcrypto' and extnamespace='extensions'::regnamespace) or to_regprocedure('extensions.digest(bytea,text)') is null then raise exception 'PGCRYPTO_EXTENSIONS_SCHEMA_REQUIRED';end if;
end$$;
create or replace function oneshot_private.authorize_staff_native_event(envelope jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();
 claim_row oneshot_private.checkin_claims%rowtype;claim jsonb;body jsonb;raw_payload text;
 device_uuid uuid;claim_uuid uuid;field text;payload_hash text;

begin
 -- This helper remains private even though future lifecycle DEFINER functions may
 -- call it. Authorization is rechecked for every invocation, including any replay.
 if not oneshot_private.verified_staff() or not exists(select 1 from auth.sessions s where s.user_id=uid and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after>clock_timestamp())) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 if jsonb_typeof(envelope) is distinct from 'object' or (select count(*) from jsonb_object_keys(envelope))<>7 or exists(select 1 from jsonb_object_keys(envelope) k where not(k=any(array['version','deviceId','actorId','eventType','eventId','claimId','payload']))) then raise exception 'INVALID_NATIVE_EVENT_ENVELOPE';end if;
 if jsonb_typeof(envelope->'version') is distinct from 'number' or envelope->'version'<>'2'::jsonb then raise exception 'INVALID_NATIVE_EVENT_VERSION';end if;
 foreach field in array array['deviceId','actorId','eventId','claimId'] loop
  if jsonb_typeof(envelope->field) is distinct from 'string' or envelope->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_NATIVE_EVENT_IDENTIFIER';end if;
 end loop;
 if envelope->>'actorId' is distinct from uid::text then raise exception 'NATIVE_EVENT_ACCOUNT_CHANGED' using errcode='42501';end if;
 if jsonb_typeof(envelope->'eventType') is distinct from 'string' or envelope->>'eventType' not in ('admission','reservation-completion','reservation-move-prepare','reservation-move-commit','reservation-move-abort','reservation-move-cancel') then raise exception 'INVALID_NATIVE_EVENT_TYPE';end if;
 if jsonb_typeof(envelope->'payload') is distinct from 'string' then raise exception 'INVALID_NATIVE_EVENT_PAYLOAD';end if;
 raw_payload:=envelope->>'payload';
 if octet_length(convert_to(raw_payload,'UTF8'))>1048576 then raise exception 'NATIVE_EVENT_PAYLOAD_TOO_LARGE';end if;
 device_uuid:=(envelope->>'deviceId')::uuid;claim_uuid:=(envelope->>'claimId')::uuid;
 select * into claim_row from oneshot_private.checkin_claims where id=claim_uuid for share;
 if not found or claim_row.device_id<>device_uuid then raise exception 'NATIVE_EVENT_CLAIM_MISMATCH';end if;
 if not oneshot_private.verified_staff() or not exists(select 1 from auth.sessions s where s.user_id=uid and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after>clock_timestamp())) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 payload_hash:=encode(extensions.digest(convert_to(raw_payload,'UTF8'),'sha256'),'hex');
 -- Require unique JSON keys before interpreting the exact stored payload bytes.
 if not(raw_payload is json object with unique keys) then raise exception 'INVALID_NATIVE_EVENT_PAYLOAD';end if;
 begin body:=raw_payload::jsonb;exception when others then raise exception 'INVALID_NATIVE_EVENT_PAYLOAD';end;
 foreach field in array array['eventId','claimId','deviceId'] loop
  if body->field is distinct from envelope->field then raise exception 'NATIVE_EVENT_BODY_MISMATCH';end if;
 end loop;
 if body->'type' is distinct from envelope->'eventType' or body->'reservationId' is distinct from to_jsonb(claim_row.reservation_id) then raise exception 'NATIVE_EVENT_BODY_MISMATCH';end if;
 claim:=claim_row.snapshot;
 if claim->'claimId' is distinct from to_jsonb(claim_row.id::text) or claim->'deviceId' is distinct from to_jsonb(claim_row.device_id::text) or claim->'actorUserId' is distinct from to_jsonb(claim_row.actor_user_id::text) or claim->'requestId' is distinct from to_jsonb(claim_row.request_id::text) or claim->'reservationId' is distinct from to_jsonb(claim_row.reservation_id) or claim->'tableId' is distinct from to_jsonb(claim_row.native_table_id) then raise exception 'NATIVE_EVENT_CLAIM_MISMATCH';end if;
 if envelope->>'eventType'='admission' then
  if body->'requestId' is distinct from claim->'requestId' or body->'tableId' is distinct from claim->'tableId' or body->'cloudUserId' is distinct from claim->'actorUserId' then raise exception 'NATIVE_EVENT_ADMISSION_BINDING_MISMATCH';end if;
 elsif envelope->>'eventType'='reservation-completion' then
  if body->'claimRequestId' is distinct from claim->'requestId' or body->'admissionTableId' is distinct from claim->'tableId' or body->'admissionCloudUserId' is distinct from claim->'actorUserId' then raise exception 'NATIVE_EVENT_COMPLETION_BINDING_MISMATCH';end if;
  if body->'reservationPricing' is distinct from jsonb_build_object('claimId',claim->'claimId','reservationId',claim->'reservationId','ownerUserId',claim->'ownerUserId','sourceRevision',claim->'sourceRevision','claimRevision',claim->'claimRevision','durationMinutes',claim->'durationMinutes','grossCents',claim->'grossTotalCents','discountCents',claim->'discountCents','netCents',claim->'netTotalCents','verifiedPaidCents',claim->'verifiedPaidCents') then raise exception 'NATIVE_EVENT_PRICING_MISMATCH';end if;
 else
  if body->'claimRequestId' is distinct from claim->'requestId' then raise exception 'NATIVE_EVENT_MOVE_BINDING_MISMATCH';end if;
 end if;
 return jsonb_build_object('version',2,'deviceId',envelope->'deviceId','actorId',envelope->'actorId','eventType',envelope->'eventType','eventId',envelope->'eventId','claimId',envelope->'claimId','payloadSha256',payload_hash,'body',body);
end$$;
revoke all on function oneshot_private.authorize_staff_native_event(jsonb) from public,anon,authenticated;

create or replace function oneshot_private.staff_native_table_mappings(p_device_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare rows jsonb;begin
 if not oneshot_private.verified_staff() or not exists(select 1 from auth.sessions s where s.user_id=auth.uid() and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after>clock_timestamp())) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 if p_device_id is null then raise exception 'INVALID_DEVICE_IDENTIFIER';end if;
 select coalesce(jsonb_agg(jsonb_build_object('tableId',m.native_table_id,'cloudTableId',m.cloud_table_id) order by m.native_table_id),'[]') into rows
 from oneshot_private.checkin_table_mappings m where m.device_id=p_device_id and m.active and m.coordinator_ready and m.approved_by is not null;
 return jsonb_build_object('deviceId',p_device_id::text,'mappings',rows,'recordType','staff-native-table-mappings','fundsTransferred',false);
end$$;
revoke all on function oneshot_private.staff_native_table_mappings(uuid) from public,anon,authenticated;
grant execute on function oneshot_private.staff_native_table_mappings(uuid) to authenticated;
create or replace function public.oneshot_staff_native_table_mappings(p_device_id uuid) returns jsonb language sql security invoker set search_path='' as $$select oneshot_private.staff_native_table_mappings(p_device_id)$$;
revoke all on function public.oneshot_staff_native_table_mappings(uuid) from public,anon,authenticated;
grant execute on function public.oneshot_staff_native_table_mappings(uuid) to authenticated;

-- Cancels only the exact original staff request. It never releases a claim/hold.
create or replace function oneshot_private.staff_cancel_checkin_request(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();req uuid;device uuid;expected_revision bigint;
 prior oneshot_private.checkin_operations%rowtype;result jsonb;
begin
 if not oneshot_private.verified_staff() or not exists(select 1 from auth.sessions s where s.user_id=uid and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after>clock_timestamp())) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>4096 then raise exception 'INVALID_PAYLOAD';end if;
 if exists(select 1 from jsonb_object_keys(p) k where not(k=any(array['requestId','id','expectedRevision','expectedStaffId','deviceId','tableId']))) then raise exception 'INVALID_FIELDS';end if;
 if (select count(*) from jsonb_object_keys(p))<>6 then raise exception 'INVALID_FIELDS';end if;
 if jsonb_typeof(p->'expectedStaffId') is distinct from 'string' or p->>'expectedStaffId' is distinct from uid::text then raise exception 'ACCOUNT_CHANGED' using errcode='42501';end if;
 if jsonb_typeof(p->'requestId') is distinct from 'string' or jsonb_typeof(p->'deviceId') is distinct from 'string' or jsonb_typeof(p->'id') is distinct from 'string' or length(p->>'id') not between 1 and 120 or jsonb_typeof(p->'tableId') is distinct from 'string' or length(p->>'tableId') not between 1 and 120 or jsonb_typeof(p->'expectedRevision') is distinct from 'number' or (p->>'expectedRevision') !~ '^[1-9][0-9]{0,15}$' then raise exception 'INVALID_REQUEST';end if;
 begin req:=(p->>'requestId')::uuid;device:=(p->>'deviceId')::uuid;expected_revision:=(p->>'expectedRevision')::bigint;
 exception when others then raise exception 'INVALID_REQUEST';end;
 if (p->>'requestId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or (p->>'deviceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or req is null or device is null or expected_revision>9007199254740988 then raise exception 'INVALID_REQUEST';end if;
 if octet_length(p->>'id')>120 or octet_length(p->>'tableId')>120 or p->>'id' ~ U&'^[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]|[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]$' or p->>'tableId' ~ U&'^[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]|[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]$' then raise exception 'INVALID_REQUEST';end if;
 -- Same coarse table ordering as booking commands. Payment writers lock the same
 -- reservation row; their earlier exact replays remain read-only and valid.
 lock table public.tables,public.reservations in share row exclusive mode;
 perform pg_advisory_xact_lock(hashtextextended(uid::text||req::text,0));
 if not oneshot_private.verified_staff() or not exists(select 1 from auth.sessions s where s.user_id=uid and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after>clock_timestamp())) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 select * into prior from oneshot_private.checkin_operations where actor_user_id=uid and request_id=req;
 if found then
  if prior.payload<>p then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if prior.result->>'recordType' is distinct from 'reservation-check-in-claim' and prior.result->>'recordType' is distinct from 'reservation-check-in-cancellation' then raise exception 'CHECKIN_REQUEST_RECONCILIATION_REQUIRED';end if;
  return prior.result||jsonb_build_object('replayed',true);
 end if;
 result:=jsonb_build_object('requestId',req::text,'reservationId',p->>'id','deviceId',device::text,'tableId',p->>'tableId','cancelled',true,'replayed',false,'recordType','reservation-check-in-cancellation','fundsTransferred',false);
 insert into oneshot_private.checkin_operations(actor_user_id,request_id,payload,result) values(uid,req,p,result);
 return result;
end$$;
revoke all on function oneshot_private.staff_cancel_checkin_request(jsonb) from public,anon,authenticated;
grant execute on function oneshot_private.staff_cancel_checkin_request(jsonb) to authenticated;
create or replace function public.oneshot_staff_cancel_checkin_request(payload jsonb) returns jsonb language sql security invoker set search_path='' as $$select oneshot_private.staff_cancel_checkin_request(payload)$$;
revoke all on function public.oneshot_staff_cancel_checkin_request(jsonb) from public,anon,authenticated;
grant execute on function public.oneshot_staff_cancel_checkin_request(jsonb) to authenticated;
commit;
