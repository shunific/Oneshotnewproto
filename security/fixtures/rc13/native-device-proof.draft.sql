-- PRIVATE REVIEW CANDIDATE ONLY: excluded from deployment/cutover bundles.
-- Verifies native device proof; does NOT ACK, admit, complete, deduplicate events,
-- transfer funds, publish receipts or release tables. No public endpoint exists.
-- Prerequisites: reviewed identity/staff/immutable-checkin candidates and pgcrypto
-- installed in the explicitly reviewed extensions schema. Never relocate it silently.
begin;
set local lock_timeout='3s';set local statement_timeout='10s';
do $$begin
 if current_setting('oneshot.secure_gateway_cutover',true) is distinct from 'reviewed' then raise exception 'Stop: reviewed coordinated gateway cutover required';end if;
 if to_regprocedure('oneshot_private.verified_staff()') is null or to_regclass('oneshot_private.checkin_claims') is null then raise exception 'NATIVE_DEVICE_PROOF_PREREQUISITES_REQUIRED';end if;
end$$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$declare extension_oid oid;proc_oid oid;signature text;begin
 select oid into extension_oid from pg_extension where extname='pgcrypto' and extnamespace='extensions'::regnamespace;
 if extension_oid is null then raise exception 'PGCRYPTO_EXTENSIONS_SCHEMA_REQUIRED';end if;
 foreach signature in array array['extensions.digest(bytea,text)','extensions.hmac(bytea,bytea,text)','extensions.gen_random_bytes(integer)'] loop
  proc_oid:=to_regprocedure(signature);
  if proc_oid is null or not exists(select 1 from pg_depend where classid='pg_proc'::regclass and objid=proc_oid and refclassid='pg_extension'::regclass and refobjid=extension_oid and deptype='e') then raise exception 'PGCRYPTO_EXTENSION_FUNCTION_REQUIRED';end if;
 end loop;
end$$;

-- Owner-only enrollment: retain device/key IDs and distribute each random secret
-- out of band to its corresponding trusted native host. No global shared key.
-- Revocation changes active; rotation uses a NEW key ID and disables the old row.
create table if not exists oneshot_private.native_device_keys (
 key_id uuid primary key,device_id uuid not null,
 secret_key bytea not null default extensions.gen_random_bytes(32) check(octet_length(secret_key)=32),
 venue_id text not null default 'oneshot' check(venue_id='oneshot'),
 approved_by uuid references auth.users(id),active boolean not null default false,
 created_at timestamptz not null default now(),check(not active or approved_by is not null)
);
create unique index if not exists native_device_one_active_key on oneshot_private.native_device_keys(device_id) where active;
create temporary table native_device_keys_expected (
 key_id uuid primary key,device_id uuid not null,
 secret_key bytea not null default extensions.gen_random_bytes(32) check(octet_length(secret_key)=32),
 venue_id text not null default 'oneshot' check(venue_id='oneshot'),
 approved_by uuid,active boolean not null default false,
 created_at timestamptz not null default now(),check(not active or approved_by is not null)
) on commit drop;
create unique index native_device_expected_one_active_key on native_device_keys_expected(device_id) where active;
do $$declare actual_oid oid;expected_oid oid:='pg_temp.native_device_keys_expected'::regclass;shapes jsonb;begin
 lock table oneshot_private.native_device_keys in access exclusive mode;
 actual_oid:='oneshot_private.native_device_keys'::regclass;
 if (select relkind<>'r' or relpersistence<>'p' or relispartition from pg_class where oid=actual_oid)
  or exists(select 1 from pg_inherits where inhrelid=actual_oid or inhparent=actual_oid)
  or exists(select 1 from pg_rewrite where ev_class=actual_oid)
  or exists(select 1 from pg_trigger where tgrelid=actual_oid and not tgisinternal) then raise exception 'INCOMPATIBLE_NATIVE_DEVICE_KEY_SCHEMA';end if;
 with targets as(select unnest(array[actual_oid,expected_oid]) target),definitions as(
  select target,jsonb_build_object(
   'owner',(select relowner from pg_class where oid=target),
   'columns',(select jsonb_agg(jsonb_build_array(a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,a.attacl,a.attinhcount,a.attislocal,pg_get_expr(d.adbin,d.adrelid,false)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=target and a.attnum>0 and not a.attisdropped),
   'constraints',(select jsonb_agg(jsonb_build_array(contype,pg_get_constraintdef(oid,false),convalidated,condeferrable,condeferred,connoinherit,conislocal,coninhcount) order by contype,pg_get_constraintdef(oid,false)) from pg_constraint where conrelid=target and contype<>'f'),
   'indexes',(select jsonb_agg(jsonb_build_array(indkey::text,indisunique,indisprimary,indisvalid,indisready,pg_get_expr(indexprs,indrelid),pg_get_expr(indpred,indrelid)) order by indkey::text,indisunique,indisprimary) from pg_index where indrelid=target)
  ) shape from targets
 )select jsonb_object_agg(target::text,shape) into shapes from definitions;
 if shapes->actual_oid::text is distinct from shapes->expected_oid::text then raise exception 'INCOMPATIBLE_NATIVE_DEVICE_KEY_SCHEMA';end if;
 if (select count(*) from pg_constraint where conrelid=actual_oid and contype='f')<>1 or not exists(
  select 1 from pg_constraint c where c.conrelid=actual_oid and c.contype='f' and c.confrelid='auth.users'::regclass
   and c.conkey=array[(select attnum from pg_attribute where attrelid=actual_oid and attname='approved_by')]::smallint[]
   and c.confkey=array[(select attnum from pg_attribute where attrelid='auth.users'::regclass and attname='id')]::smallint[]
   and c.convalidated and not c.condeferrable and not c.condeferred and c.confupdtype='a' and c.confdeltype='a' and c.confmatchtype='s' and c.conislocal and c.coninhcount=0
 )then raise exception 'INCOMPATIBLE_NATIVE_DEVICE_KEY_FOREIGN_KEY';end if;
end$$;
alter table oneshot_private.native_device_keys enable row level security;
revoke all on oneshot_private.native_device_keys from public,anon,authenticated;

create or replace function oneshot_private.verify_native_device_event(envelope jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid();key_row oneshot_private.native_device_keys%rowtype;
 claim_row oneshot_private.checkin_claims%rowtype;claim jsonb;body jsonb;raw_payload text;
 key_uuid uuid;device_uuid uuid;claim_uuid uuid;field text;payload_hash text;
 signing_text text;expected_mac bytea;received_mac bytea;difference integer:=0;i integer;
begin
 -- This helper remains private even though future lifecycle DEFINER functions may
 -- call it. Authorization is rechecked for every invocation, including any replay.
 if not oneshot_private.verified_staff() or not exists(select 1 from auth.sessions s where s.user_id=uid and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after>clock_timestamp())) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 if jsonb_typeof(envelope) is distinct from 'object' or (select count(*) from jsonb_object_keys(envelope))<>9 or exists(select 1 from jsonb_object_keys(envelope) k where not(k=any(array['version','keyId','deviceId','actorId','eventType','eventId','claimId','payload','signature']))) then raise exception 'INVALID_NATIVE_EVENT_ENVELOPE';end if;
 if jsonb_typeof(envelope->'version') is distinct from 'number' or envelope->'version'<>'1'::jsonb then raise exception 'INVALID_NATIVE_EVENT_VERSION';end if;
 foreach field in array array['keyId','deviceId','actorId','eventId','claimId'] loop
  if jsonb_typeof(envelope->field) is distinct from 'string' or envelope->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_NATIVE_EVENT_IDENTIFIER';end if;
 end loop;
 if envelope->>'actorId' is distinct from uid::text then raise exception 'NATIVE_EVENT_ACCOUNT_CHANGED' using errcode='42501';end if;
 if jsonb_typeof(envelope->'eventType') is distinct from 'string' or envelope->>'eventType' not in ('admission','reservation-completion') then raise exception 'INVALID_NATIVE_EVENT_TYPE';end if;
 if jsonb_typeof(envelope->'payload') is distinct from 'string' then raise exception 'INVALID_NATIVE_EVENT_PAYLOAD';end if;
 raw_payload:=envelope->>'payload';
 if octet_length(convert_to(raw_payload,'UTF8'))>1048576 then raise exception 'NATIVE_EVENT_PAYLOAD_TOO_LARGE';end if;
 if jsonb_typeof(envelope->'signature') is distinct from 'string' or envelope->>'signature' !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_NATIVE_EVENT_SIGNATURE';end if;
 key_uuid:=(envelope->>'keyId')::uuid;device_uuid:=(envelope->>'deviceId')::uuid;claim_uuid:=(envelope->>'claimId')::uuid;
 -- Fixed future lock order: key, then claim. Row SHARE lock prevents revocation or
 -- secret replacement from committing between the active check and verification.
 select * into key_row from oneshot_private.native_device_keys where key_id=key_uuid for share;
 if not found or not key_row.active or key_row.approved_by is null or key_row.venue_id<>'oneshot' or key_row.device_id<>device_uuid then raise exception 'NATIVE_DEVICE_KEY_REQUIRED';end if;
 select * into claim_row from oneshot_private.checkin_claims where id=claim_uuid for share;
 if not found or claim_row.device_id<>device_uuid then raise exception 'NATIVE_EVENT_CLAIM_MISMATCH';end if;
 if not oneshot_private.verified_staff() or not exists(select 1 from auth.sessions s where s.user_id=uid and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after>clock_timestamp())) then raise exception 'STAFF_REQUIRED' using errcode='42501';end if;
 payload_hash:=encode(extensions.digest(convert_to(raw_payload,'UTF8'),'sha256'),'hex');
 signing_text:='oneshot-native-event-v1'||E'\n'||(envelope->>'keyId')||E'\n'||(envelope->>'deviceId')||E'\n'||(envelope->>'actorId')||E'\n'||(envelope->>'eventType')||E'\n'||(envelope->>'eventId')||E'\n'||(envelope->>'claimId')||E'\n'||payload_hash;
 expected_mac:=extensions.hmac(convert_to(signing_text,'UTF8'),key_row.secret_key,'sha256');
 received_mac:=decode(envelope->>'signature','hex');
 for i in 0..31 loop difference:=difference | (get_byte(expected_mac,i) # get_byte(received_mac,i));end loop;
 if difference<>0 then raise exception 'NATIVE_DEVICE_SIGNATURE_INVALID';end if;
 -- Authenticate the exact bytes before parsing. Never hash jsonb::text or silently
 -- normalize layout/Unicode. Unique keys remove ambiguous JSON object semantics.
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
 else
  if body->'claimRequestId' is distinct from claim->'requestId' or body->'admissionTableId' is distinct from claim->'tableId' or body->'admissionCloudUserId' is distinct from claim->'actorUserId' then raise exception 'NATIVE_EVENT_COMPLETION_BINDING_MISMATCH';end if;
  if body->'reservationPricing' is distinct from jsonb_build_object('claimId',claim->'claimId','reservationId',claim->'reservationId','ownerUserId',claim->'ownerUserId','sourceRevision',claim->'sourceRevision','claimRevision',claim->'claimRevision','durationMinutes',claim->'durationMinutes','grossCents',claim->'grossTotalCents','discountCents',claim->'discountCents','netCents',claim->'netTotalCents','verifiedPaidCents',claim->'verifiedPaidCents') then raise exception 'NATIVE_EVENT_PRICING_MISMATCH';end if;
 end if;
 return jsonb_build_object('version',1,'keyId',envelope->'keyId','deviceId',envelope->'deviceId','actorId',envelope->'actorId','eventType',envelope->'eventType','eventId',envelope->'eventId','claimId',envelope->'claimId','payloadSha256',payload_hash,'body',body);
end$$;
revoke all on function oneshot_private.verify_native_device_event(jsonb) from public,anon,authenticated;
commit;
