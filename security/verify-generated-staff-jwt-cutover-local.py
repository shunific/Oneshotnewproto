#!/usr/bin/env python3
"""Fresh legacy-shaped disposable PG: exact generated14 atomic apply/reapply/rollback."""
import hashlib,importlib.util,json,uuid
from pathlib import Path
from native_lifecycle_fixture import Fixture,fixture,STAFF,MANAGER,CUSTOMER,OTHER,DEVICE,q,SOURCE
class FreshLegacyFixture(Fixture):
 def bootstrap(self):
  self.sql('''create role anon;create role authenticated;create schema auth;create schema storage;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,banned_until timestamptz,deleted_at timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth,storage to anon,authenticated;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create function storage.allow_only_operation(expected text)returns boolean language sql stable as $$select current_setting('oneshot.test.storage_operation',true)=expected$$;
create table storage.objects(bucket_id text,name text,owner_id text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;grant select,insert,update,delete on storage.objects to anon,authenticated;
create policy legacy_read on storage.objects for select using(true);create policy legacy_insert on storage.objects for insert with check(true);create policy legacy_update on storage.objects for update using(true)with check(true);create policy legacy_delete on storage.objects for delete using(true);''')
  self.sql((SOURCE/'cloud-schema.fixture.sql').read_text())
  for user,session in self.sessions.items():self.sql(f"insert into auth.users values('{user}','{user[:8]}@example.invalid',now(),false,null,null);insert into auth.sessions values('{session}','{user}',null)")
  self.sql('''alter table reservations enable row level security;
create policy "allow public reservation select"on reservations for select to anon using(true);
create policy "Allow public reservation inserts"on reservations for insert to anon with check(true);
create policy "Public can view billiard tables"on tables for select using(true);
grant all on all tables in schema public to anon,authenticated;
grant update("downPaymentPaid","balancePaid")on reservations to authenticated;
grant insert(id,"customerName","totalAmount")on reservations to anon;
grant select(sessiondata,"sessionData")on tables to anon,authenticated;
grant select(setting_value)on system_settings to anon,authenticated;
insert into tables(id,name,status,isactive,"isActive")values('LEGACY-QA','Legacy QA table','available',1,1);
insert into reservations(id,"customerName",email,"totalAmount","downPaymentAmount","downPaymentPaid","balancePaid",balancepaid,status)values('LEGACY-QA','Legacy QA owner','legacy@example.invalid',300,60,0,0,0,'pending');
insert into system_settings values('hourlyRate','150');insert into announcements(id,title,content)values('LEGACY-QA','Legacy QA notice','Retain this content');''')
 def snapshot(self):
  names=json.loads(self.sql("select coalesce(jsonb_agg(schemaname||'.'||tablename order by schemaname,tablename),'[]')from pg_tables where schemaname in('public','oneshot_private','auth','storage')"))
  return self.sql('select jsonb_build_object('+','.join(q(n)+f",(select coalesce(jsonb_agg(to_jsonb(r)order by to_jsonb(r)::text),'[]')from {n} r)"for n in names)+')')
 def catalog(self):return self.sql('''select jsonb_build_object(
 'schemas',(select jsonb_agg(jsonb_build_array(nspname,(select jsonb_agg(v::text order by v::text)from unnest(nspacl)v))order by nspname)from pg_namespace where nspname in('public','auth','storage','oneshot_private','extensions')),
 'relations',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,(select jsonb_agg(v::text order by v::text)from unnest(c.relacl)v),(select jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull,(select jsonb_agg(v::text order by v::text)from unnest(a.attacl)v),pg_get_expr(d.adbin,d.adrelid))order by a.attnum)from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped))order by n.nspname,c.relname)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','auth','storage','oneshot_private','extensions')and c.relkind in('r','v','S')),
 'functions',(select jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid),(select jsonb_agg(v::text order by v::text)from unnest(p.proacl)v))order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','auth','storage','oneshot_private','extensions')and p.prokind='f'),
 'policies',(select jsonb_agg(to_jsonb(p)order by schemaname,tablename,policyname)from pg_policies p where schemaname in('public','storage','oneshot_private')),
 'constraints',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid))order by n.nspname,c.relname,k.conname)from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','storage','oneshot_private')),
 'triggers',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid))order by n.nspname,c.relname,t.tgname)from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in('public','storage','oneshot_private')),
 'extensions',(select jsonb_agg(jsonb_build_array(e.extname,n.nspname,e.extversion)order by e.extname)from pg_extension e join pg_namespace n on n.oid=e.extnamespace))''')
def digest(s):return hashlib.sha256(s.encode()).hexdigest()
spec=importlib.util.spec_from_file_location('cutover_builder',SOURCE.parent/'scripts/build-cloud-cutover.py');builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
bundle=(SOURCE/'secure-cloud-cutover.generated.sql').read_text();assert bundle==builder.render();assert len(builder.SOURCES)==14;assert 'native-device-proof.draft.sql'not in builder.SOURCES
bundle_hash=digest(bundle);gates="set oneshot.secure_gateway_cutover='reviewed';set oneshot.private_receipts_cutover='reviewed';\n"
with fixture(factory=FreshLegacyFixture)as f:
 before_data=f.snapshot();before_catalog=f.catalog();assert f.sql("select to_regnamespace('oneshot_private')is null")=='t'
 failure=bundle.rsplit('COMMIT;',1)[0]+"select 1/0;\nCOMMIT;\n"
 f.sql(gates+failure,error='division by zero');assert f.snapshot()==before_data and f.catalog()==before_catalog
 assert f.sql("select count(*)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname like'oneshot_%'")=='0'
 assert f.sql("select has_table_privilege('anon','public.reservations','INSERT')")=='t'
 f.checks.append('injected final-step failure rolls entire generated14 transaction back: exact original rows/catalog/schema/functions/policies/grants/extensions preserved')
 f.sql(gates+bundle)
 legacy=json.loads(f.sql("select to_jsonb(r)from reservations r where id='LEGACY-QA'"));assert legacy['totalAmount']==300 and legacy['downPaymentAmount']==60 and legacy['customer_user_id']is None and legacy['total_amount_cents']is None
 assert f.sql("select has_column_privilege('anon','public.reservations','id','INSERT')")=='f'
 assert f.sql("select has_column_privilege('anon','public.tables','sessionData','SELECT')")=='f'
 assert f.sql("select has_column_privilege('anon','public.tables','name','SELECT')")=='t'
 assert f.sql("select to_regclass('oneshot_private.native_device_keys')is null")=='t'
 assert f.sql("select count(*)from pg_class where relnamespace='public'::regnamespace and relkind='r'and not relrowsecurity")=='0'
 f.sql(f"insert into oneshot_private.staff_memberships(user_id,role,active,approved_by)values('{STAFF}','cashier',true,'{MANAGER}'),('{MANAGER}','manager',true,'{MANAGER}')")
 f.checks.append('exact generated14 bundle applies fresh legacy shapes atomically, protects grants/RLS, preserves unreconciled legacy money/ownership and needs no key schema')
 # A corrected command uses a NEW request ID; the cancelled original stays blocked.
 f.sql(f"insert into oneshot_private.checkin_table_mappings(device_id,native_table_id,cloud_table_id,active,coordinator_ready,approved_by)values('{DEVICE}','LOCAL-CANCEL-CORRECT','LEGACY-QA',true,true,'{MANAGER}')")
 f.sql(f'''insert into reservations(id,"customerName","contactNumber",email,date,"timeSlot","durationHours","partySize","tableId",status,"downPaymentPaid","balancePaid",balancepaid,customer_user_id,revision,total_amount_cents,down_payment_amount_cents,discount_amount_cents)values('QA-CANCEL-CORRECT','QA corrected request','09123456789','owner@example.invalid',timezone('Asia/Manila',now())::date,'14:00',2,2,'LEGACY-QA','pending',0,0,0,'{CUSTOMER}',1,20000,0,0)''')
 f.rpc('oneshot_staff_approve_booking',dict(requestId=str(uuid.uuid4()),id='QA-CANCEL-CORRECT',expectedRevision=1,expectedStaffId=STAFF,expectedTotalCents=20000,expectedDownPaymentCents=0))
 original=dict(requestId=str(uuid.uuid4()),id='QA-CANCEL-CORRECT',expectedRevision=2,expectedStaffId=STAFF,deviceId=DEVICE,tableId='LOCAL-CANCEL-CORRECT')
 cancellation=f.rpc('oneshot_staff_cancel_checkin_request',original);assert cancellation['cancelled']is True
 corrected=dict(original,requestId=str(uuid.uuid4()));new_claim=f.rpc('oneshot_staff_claim_checkin',corrected)
 assert new_claim['claim']['requestId']==corrected['requestId']and new_claim['claim']['reservationId']==original['id']and new_claim['claim']['tableId']==original['tableId']
 f.rpc('oneshot_staff_claim_checkin',original,error='CHECKIN_REQUEST_CANCELLED')
 f.checks.append('new requestID claims same reservation/physical table after original cancellation; delayed original remains tombstoned')
 # Exercise real claims + accepted event/receipt using the keyless native bridge.
 from staff_jwt_lifecycle_fixture import StaffJwtFixture
 f.native=StaffJwtFixture.native.__get__(f);c,r=f.seed();events=f.native(c,r);f.ack(events['admission']);completed=f.ack(events['completion']);assert completed['ack']['state']=='completed'
 sample=json.loads(f.sql(f.user(CUSTOMER)+"select public.oneshot_customer_final_receipts(timezone('Asia/Manila',now())::date,timezone('Asia/Manila',now())::date)"));assert len(sample['receipts'])==1
 f.checks.append('generated bundle alone supports verified staff claim, actual native admission/order/checkout, JWT admission/completion ACK and owner final receipt')
 retained_data=f.snapshot();retained_catalog=f.catalog()
 for _ in range(2):
  f.sql(gates+bundle);new_data=f.snapshot();new_catalog=f.catalog()
  if new_data!=retained_data or new_catalog!=retained_catalog:
   before_rows=json.loads(retained_data);after_rows=json.loads(new_data);before_meta=json.loads(retained_catalog);after_meta=json.loads(new_catalog)
   (SOURCE.parent/'output/playwright/staff-jwt-generated-reapply-diff.json').write_text(json.dumps({'dataChanged':{key:{'before':before_rows.get(key),'after':after_rows.get(key)}for key in before_rows if before_rows.get(key)!=after_rows.get(key)},'catalogChanged':{key:{'before':before_meta.get(key),'after':after_meta.get(key)}for key in before_meta if before_meta.get(key)!=after_meta.get(key)}},indent=2))
  assert new_data==retained_data and new_catalog==retained_catalog
 f.checks.append('two exact whole-bundle reapplications preserve all retained data and exact function/policy/ACL/constraint/trigger catalog after completed receipt')
 f.sql(gates+failure,error='division by zero');assert f.snapshot()==retained_data and f.catalog()==retained_catalog
 assert f.ack(events['completion'])['ack']==completed['ack']
 f.checks.append('late failing reapplication preserves completed receipt/audit and original ACK, with no partial schema/API/grant changes')
 assert digest((SOURCE/'secure-cloud-cutover.generated.sql').read_text())==bundle_hash
 print(json.dumps({'passed':True,'checkCount':len(f.checks),'checks':f.checks,'sourceCount':14,'bundleSha256':bundle_hash,'sourceHashes':{name:hashlib.sha256((SOURCE/name).read_bytes()).hexdigest()for name in builder.SOURCES},'snapshotHashes':{'freshLegacyRows':digest(before_data),'freshLegacyCatalog':digest(before_catalog),'retainedRows':digest(retained_data),'retainedCatalog':digest(retained_catalog)},'engine':f.sql('select version()'),'hostedWrites':False,'completionAck':completed,'customerFinalReceiptCount':len(sample['receipts']),'limits':['Disposable PostgreSQL17 metadata-shaped legacy fixture; not a production schema clone.','Auth/JWT role/session inputs and Storage operation provenance are local stubs; no hosted PostgREST/Storage transport or live account deployment.']},indent=2))
