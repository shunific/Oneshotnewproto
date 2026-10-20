#!/usr/bin/env python3
"""Apply all coordinated candidates to observed public column shapes in disposable PG17."""
from pathlib import Path
import os, subprocess, tempfile, time, json, uuid, datetime
pg=Path(os.environ.get('ONESHOT_TEST_PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
source=Path(__file__).parent
owner='11111111-1111-4111-8111-111111111111'; other='22222222-2222-4222-8222-222222222222'
with tempfile.TemporaryDirectory(prefix='oneshot-cloud-cutover-') as directory:
    base=Path(directory)
    subprocess.run([str(pg/'initdb'),'-D',str(base/'db'),'-A','trust','-U','postgres','--no-locale'],check=True,stdout=subprocess.DEVNULL)
    with (base/'postgres.log').open('w') as log:
        process=subprocess.Popen([str(pg/'postgres'),'-D',str(base/'db'),'-k',str(base),'-p','54395','-h',''],stdout=log,stderr=log)
        try:
            def sql(query,ok=True):
                r=subprocess.run([str(pg/'psql'),'-X','-q','-v','ON_ERROR_STOP=1','-At','-h',str(base),'-p','54395','-U','postgres'],input=query,text=True,capture_output=True)
                assert (r.returncode==0)==ok,r.stderr or r.stdout
                return r.stdout.strip()
            for _ in range(100):
                if subprocess.run([str(pg/'pg_isready'),'-h',str(base),'-p','54395','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
                if process.poll() is not None:raise RuntimeError((base/'postgres.log').read_text())
                time.sleep(.05)
            else:raise RuntimeError('Postgres startup failed')
            sql('''create role anon; create role authenticated; create schema auth; create schema storage;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,banned_until timestamptz,deleted_at timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth,storage to anon,authenticated;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
-- Fixture-only operation provenance. The hosted Storage API must set its real operation.
create function storage.allow_only_operation(expected text) returns boolean language sql stable as $$
 select coalesce(case when current_setting('oneshot.test.storage_operation',true) like 'storage.%' then substr(current_setting('oneshot.test.storage_operation',true),9) else current_setting('oneshot.test.storage_operation',true) end
 =case when expected like 'storage.%' then substr(expected,9) else expected end,false)
$$;
create table storage.objects(bucket_id text,name text,owner_id text,metadata jsonb,primary key(bucket_id,name));
alter table storage.objects enable row level security;
grant select,insert,update,delete on storage.objects to anon,authenticated;
create policy legacy_read on storage.objects for select using(true);
create policy legacy_insert on storage.objects for insert with check(true);
create policy legacy_update on storage.objects for update using(true) with check(true);
create policy legacy_delete on storage.objects for delete using(true);
''')
            sql((source/'cloud-schema.fixture.sql').read_text())
            sql('''alter table reservations enable row level security;
create policy "allow public reservation select" on reservations for select to anon using(true);
create policy "Allow public reservation inserts" on reservations for insert to anon with check(true);
create policy "Public can view billiard tables" on tables for select using(true);
grant all on all tables in schema public to anon,authenticated;
-- Legacy explicit column grants survive a table-level REVOKE unless removed too.
grant update ("downPaymentPaid","balancePaid") on reservations to authenticated;
grant insert (id,"customerName","totalAmount") on reservations to anon;
grant select (sessiondata,"sessionData") on tables to anon,authenticated;
grant select (setting_value) on system_settings to anon,authenticated;

''')
            subprocess.run(['python3', str(source.parent/'scripts/build-cloud-cutover.py'), '--check'], check=True)
            bundle=(source/'secure-cloud-cutover.generated.sql').read_text()
            gates="set oneshot.secure_gateway_cutover='reviewed';set oneshot.private_receipts_cutover='reviewed';\n"
            # Deliberately fail immediately before commit; no partial protections may persist.
            rollback_bundle=bundle.rsplit('COMMIT;',1)[0]+"select 1/0;\nCOMMIT;\n"
            sql(gates+rollback_bundle,False)
            assert sql("select count(*) from storage.buckets where id='oneshot-receipts'")=='0'
            assert sql("select to_regprocedure('public.oneshot_receipt_upload_intent(jsonb)') is null")=='t'
            assert sql("select has_table_privilege('anon','public.reservations','INSERT')")=='t'
            assert sql("select count(*) from pg_policies where schemaname='public' and policyname='Allow public reservation inserts'")=='1'
            sql(gates+bundle)
            print('PASS: injected final-step failure rolls back the entire nine-part cutover; valid atomic bundle applies.')
            sql(f"insert into auth.users(id,email,email_confirmed_at,is_anonymous) values ('{owner}','owner@example.invalid',now(),false),('{other}','other@example.invalid',now(),false);")
            sql("insert into auth.sessions select id,id,null from auth.users")
            config={'hourlyRate':'150','downPaymentPercent':'20','minHours':'1','maxHours':'24','advanceBookingHours':'1','cancellationHours':'12','weekdayStartTime':'12:00','weekdayEndTime':'01:00','weekendStartTime':'12:00','weekendEndTime':'01:00','weekdayMinPartySize':'1','weekdayMaxPartySize':'10','weekendMinPartySize':'1','weekendMaxPartySize':'10','weekdayOnlineCapacityLimit':'6','weekendOnlineCapacityLimit':'6','bookingCapacityMode':'tables','termsAndConditions':'QA terms'}
            for key,value in config.items():sql("insert into system_settings values ('%s','%s')"%(key,value))
            sql("insert into tables(id,name,status,isactive,\"isActive\") values ('QA','QA table','available',1,1)")
            future=(datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date()+datetime.timedelta(days=7)).isoformat()
            owner_sql=f"set oneshot.test.storage_operation='storage.object.get_authenticated';set role authenticated;set request.jwt.claim.sub='{owner}';set request.jwt.claims='{{\"session_id\":\"{owner}\"}}';"
            other_sql=f"set oneshot.test.storage_operation='storage.object.get_authenticated';set role authenticated;set request.jwt.claim.sub='{other}';set request.jwt.claims='{{\"session_id\":\"{other}\"}}';"
            intent_payload=dict(requestId=str(uuid.uuid4()),expectedCustomerId=owner,contentType='image/png',byteSize=9,sha256='a'*64)
            intent=json.loads(sql(owner_sql+"select oneshot_receipt_upload_intent('%s'::jsonb)"%json.dumps(intent_payload)))
            path=intent['path'];assert intent['uploadAllowed'] is True and intent['replayed'] is False
            assert json.loads(sql(owner_sql+"select oneshot_receipt_upload_intent('%s'::jsonb)"%json.dumps(intent_payload)))['path']==path
            sql(owner_sql+"set oneshot.test.storage_operation='storage.object.upload';"+f"insert into storage.objects values ('oneshot-receipts','{owner}/{uuid.uuid4()}.png','{owner}','{{}}')",False)
            sql(owner_sql+"set oneshot.test.storage_operation='storage.object.upload';"+f"insert into storage.objects values ('oneshot-receipts','{path}','{owner}','{{\"mimetype\":\"image/png\",\"size\":9}}')")
            command=dict(expectedCustomerId=owner,requestId=str(uuid.uuid4()),tableId='QA',date=future,timeSlot='14:00',durationHours=2,partySize=2,customerName='PRIVATE NAME',contactNumber='09123456789',receiptPath=path,acceptedTerms=True,expectedTerms='QA terms',expectedTotalCents=30000,expectedDownPaymentCents=6000)
            payload=json.dumps(command)
            saved=json.loads(sql(owner_sql+f"select oneshot_booking_create('{payload}'::jsonb)"))
            rid=saved['reservation']['id']
            assert saved['reservation']['receiptImg']==path
            assert json.loads(sql(owner_sql+f"select oneshot_booking_create('{payload}'::jsonb)"))['replayed'] is True
            availability=json.loads(sql(f"set role anon;select oneshot_booking_availability('{future}','{future}')"))
            assert availability['bookingReady'] is True and len(availability['busy'])==1
            assert all(secret not in json.dumps(availability) for secret in ['PRIVATE NAME','09123456789',path,owner,rid])
            assert sql(owner_sql+"select count(*) from reservations")=='1'
            sql("create policy unexpected_broad_read on public.reservations for select using(true)")
            assert sql(other_sql+"select count(*) from reservations")=='0'
            assert sql(other_sql+"select count(*) from storage.objects where bucket_id='oneshot-receipts'")=='0'
            for operation in ['storage.object.sign','storage.object.sign_many','storage.object.list','']:
                assert sql(owner_sql+"set oneshot.test.storage_operation='%s';select count(*) from storage.objects where bucket_id='oneshot-receipts'"%operation)=='0'
            sql('set role anon;select * from reservations',False)
            sql(owner_sql+"update reservations set \"totalAmount\"=0",False)
            sql('set role anon;select sessiondata from tables',False)
            change=dict(expectedCustomerId=owner,requestId=str(uuid.uuid4()),id=rid,expectedRevision=1,date=future,timeSlot='17:00')
            moved=json.loads(sql(owner_sql+"select oneshot_booking_reschedule('%s'::jsonb)"%json.dumps(change)))
            assert moved['reservation']['revision']==2
            cancel=dict(expectedCustomerId=owner,requestId=str(uuid.uuid4()),id=rid,expectedRevision=2,reason='QA cancel')
            cancelled=json.loads(sql(owner_sql+"select oneshot_booking_cancel('%s'::jsonb)"%json.dumps(cancel)))
            assert cancelled['reservation']['status']=='cancelled' and cancelled['reservation']['revision']==3
            assert sql("select count(*) from oneshot_private.booking_operations")=='3'
            sql("update system_settings set setting_value='99999.99' where key_name='hourlyRate'")
            large=dict(command,requestId=str(uuid.uuid4()),timeSlot='12:00',durationHours=12,receiptPath=None,paymentRef='QA-LARGE-NO-PAYMENT',expectedTotalCents=119999988,expectedDownPaymentCents=24000000)
            exact=json.loads(sql(owner_sql+"select oneshot_booking_create('%s'::jsonb)"%json.dumps(large)))['reservation']
            assert exact['total_amount_cents']==119999988 and exact['totalAmount']==1199999.88
            assert sql("select total_amount_cents from reservations where id='%s'"%exact['id'])=='119999988'
            staff='33333333-3333-4333-8333-333333333333'
            sql(f"insert into auth.users(id,email,email_confirmed_at,is_anonymous) values ('{staff}','staff@example.invalid',now(),false);insert into auth.sessions values ('{staff}','{staff}',null)")
            sql(f"insert into oneshot_private.staff_memberships(user_id,role,active,approved_by) values ('{staff}','cashier',true,'{owner}')")
            staff_sql=f"set oneshot.test.storage_operation='storage.object.get_authenticated';set role authenticated;set request.jwt.claim.sub='{staff}';set request.jwt.claims='{{\"session_id\":\"{staff}\"}}';"
            assert json.loads(sql(staff_sql+"select oneshot_staff_identity()"))['role']=='cashier'
            assert json.loads(sql(staff_sql+"select oneshot_staff_receipt('%s')"%rid))['path']==path
            assert sql(staff_sql+"select count(*) from storage.objects where bucket_id='oneshot-receipts'")=='1'
            sql("update system_settings set setting_value='150' where key_name='hourlyRate'")
            staff_day=(datetime.date.fromisoformat(future)+datetime.timedelta(days=1)).isoformat()
            booking=dict(command,requestId=str(uuid.uuid4()),date=staff_day,receiptPath=None,paymentRef='QA-EVIDENCE-NO-TRANSFER')
            staff_r=json.loads(sql(owner_sql+"select oneshot_booking_create('%s'::jsonb)"%json.dumps(booking)))['reservation']
            payment=dict(requestId=str(uuid.uuid4()),id=staff_r['id'],expectedRevision=1,paymentKind='deposit',method='gcash',reference='QA-GCASH-UNIQUE-001',expectedAmountCents=6000,expectedStaffId=staff)
            sql(owner_sql+"select oneshot_staff_confirm_payment('%s'::jsonb)"%json.dumps(payment),False)
            paid=json.loads(sql(staff_sql+"select oneshot_staff_confirm_payment('%s'::jsonb)"%json.dumps(payment)))
            assert paid['verification']['fundsTransferred'] is False and paid['verification']['actorUserId']==staff
            assert paid['reservation']['downPaymentPaid']==1 and paid['reservation']['revision']==2
            assert json.loads(sql(staff_sql+"select oneshot_staff_confirm_payment('%s'::jsonb)"%json.dumps(payment)))['replayed'] is True
            sql("update system_settings set setting_value='0' where key_name='downPaymentPercent'")
            no_deposit=dict(booking,requestId=str(uuid.uuid4()),date=(datetime.date.fromisoformat(staff_day)+datetime.timedelta(days=1)).isoformat(),expectedDownPaymentCents=0)
            zero_r=json.loads(sql(owner_sql+"select oneshot_booking_create('%s'::jsonb)"%json.dumps(no_deposit)))['reservation']
            approve=dict(requestId=str(uuid.uuid4()),id=zero_r['id'],expectedRevision=1,expectedStaffId=staff,expectedTotalCents=30000,expectedDownPaymentCents=0)
            approved=json.loads(sql(staff_sql+"select oneshot_staff_approve_booking('%s'::jsonb)"%json.dumps(approve)))
            assert approved['reservation']['status']=='confirmed' and approved['reservation']['downPaymentPaid']==0
            assert approved['reservation']['paymentSummary']['verifiedPaidCents']==0 and approved['reservation']['paymentSummary']['remainingCents']==30000
            assert approved['approval']['fundsTransferred'] is False
            assert json.loads(sql(staff_sql+"select oneshot_staff_approve_booking('%s'::jsonb)"%json.dumps(approve)))['replayed'] is True
            assert sql("select count(*) from oneshot_private.staff_payment_verifications where reservation_id='%s'"%zero_r['id'])=='0'
            sql(f"update oneshot_private.staff_memberships set active=false where user_id='{staff}'")
            sql(staff_sql+"select oneshot_staff_confirm_payment('%s'::jsonb)"%json.dumps(payment),False)
            assert sql(staff_sql+"select count(*) from storage.objects where bucket_id='oneshot-receipts'")=='0'
            feedback=dict(requestId=str(uuid.uuid4()),expectedCustomerId=owner,customerName='QA feedback',contactInfo='09123456789',feedbackType='complaint',comment='QA test only',reservationId=rid)
            sent=json.loads(sql(owner_sql+"select oneshot_feedback_create('%s'::jsonb)"%json.dumps(feedback)))
            assert sent['feedback']['customer_user_id']==owner and sent['feedback']['status']=='pending'
            assert json.loads(sql(owner_sql+"select oneshot_feedback_create('%s'::jsonb)"%json.dumps(feedback)))['replayed'] is True
            sql('set role anon;select * from feedback',False)
            # Reapplication must preserve every business/audit row and authorization state.
            manager='44444444-4444-4444-8444-444444444444'
            sql(f"insert into auth.users(id,email,email_confirmed_at,is_anonymous) values ('{manager}','manager@example.invalid',now(),false);insert into auth.sessions values ('{manager}','{manager}',null);insert into oneshot_private.staff_memberships(user_id,role,active,approved_by) values ('{manager}','manager',true,'{owner}')")
            manager_sql=f"set oneshot.test.storage_operation='storage.object.get_authenticated';set role authenticated;set request.jwt.claim.sub='{manager}';set request.jwt.claims='{{\"session_id\":\"{manager}\"}}';"
            public_tables=['activities','announcements','closed_dates','cms','e_receipts','events','feedback','inventory','lost_and_found','promo_codes','queue','reservations','session_history','system_settings','system_status','tables','watchlist']
            preserved_tables=['public.'+name for name in public_tables]+['storage.objects','storage.buckets','oneshot_private.booking_operations','oneshot_private.staff_memberships','oneshot_private.staff_payment_operations','oneshot_private.staff_payment_verifications','oneshot_private.staff_booking_approvals','oneshot_private.feedback_operations','oneshot_private.receipt_upload_intents']
            def snapshot():
                return {table:sql("select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from %s t"%table) for table in preserved_tables}
            before=snapshot()
            before_policies=sql("select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p where schemaname in ('public','storage')")
            sql(gates+rollback_bundle,False)
            assert snapshot()==before,'Failed reapply changed persisted rows'
            assert sql("select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p where schemaname in ('public','storage')")==before_policies,'Failed reapply changed policies'
            sql(gates+bundle)
            assert snapshot()==before,'Cutover reapplication changed preserved data'
            assert json.loads(sql(owner_sql+f"select oneshot_booking_create('{payload}'::jsonb)"))['replayed'] is True
            assert json.loads(sql(owner_sql+"select oneshot_receipt_upload_intent('%s'::jsonb)"%json.dumps(intent_payload)))['path']==path
            assert json.loads(sql(owner_sql+"select oneshot_feedback_create('%s'::jsonb)"%json.dumps(feedback)))['replayed'] is True
            assert json.loads(sql(manager_sql+"select oneshot_staff_identity()"))['role']=='manager'
            assert sql(manager_sql+"select count(*) from storage.objects where bucket_id='oneshot-receipts'")=='1'
            sql(staff_sql+"select oneshot_staff_confirm_payment('%s'::jsonb)"%json.dumps(payment),False)
            assert sql(staff_sql+"select count(*) from storage.objects where bucket_id='oneshot-receipts'")=='0'
            assert sql(other_sql+"select count(*) from reservations")=='0'
            assert sql(other_sql+"select count(*) from storage.objects where bucket_id='oneshot-receipts'")=='0'
            sql(owner_sql+"update reservations set \"totalAmount\"=0",False)
            sql('set role anon;select * from reservations',False)
            sql('set role anon;select sessiondata from tables',False)
            sql(f"update oneshot_private.staff_memberships set active=true where user_id='{staff}'")
            assert json.loads(sql(staff_sql+"select oneshot_staff_confirm_payment('%s'::jsonb)"%json.dumps(payment)))['replayed'] is True
            assert json.loads(sql(staff_sql+"select oneshot_staff_approve_booking('%s'::jsonb)"%json.dumps(approve)))['replayed'] is True
            sql(f"update oneshot_private.staff_memberships set active=false where user_id='{staff}'")
            assert snapshot()==before,'Replays changed data or restored the wrong membership state'
            print('PASS: reapplying all nine coordinated candidates preserves all 26 public/business/audit/storage snapshots, active manager and deactivated cashier authorization, exact receipt path and booking/feedback replay; reactivated original cashier replays payment/approval without duplicate records, then deactivation is restored; owner/other/anon denials remain intact.')
            sql(f"update auth.users set banned_until=now()+interval '1 hour' where id='{owner}'")
            assert sql(owner_sql+"select count(*) from reservations")=='0'
            sql(owner_sql+f"select oneshot_booking_create('{payload}'::jsonb)",False)
            sql(f"update auth.users set banned_until=null where id='{owner}';delete from auth.sessions where user_id='{owner}'")
            assert sql(owner_sql+"select count(*) from reservations")=='0'
            assert sql(owner_sql+"select count(*) from storage.objects where bucket_id='oneshot-receipts'")=='0'
            sql(owner_sql+f"select oneshot_booking_create('{payload}'::jsonb)",False)
            for principal in ['anon','authenticated']:
                assert sql("select has_column_privilege('%s','public.reservations','downPaymentPaid','UPDATE')"%principal)=='f'
                assert sql("select has_column_privilege('%s','public.reservations','id','INSERT')"%principal)=='f'
                assert sql("select has_column_privilege('%s','public.tables','sessiondata','SELECT')"%principal)=='f'
                assert sql("select has_column_privilege('%s','public.tables','sessionData','SELECT')"%principal)=='f'
                assert sql("select has_column_privilege('%s','public.system_settings','setting_value','SELECT')"%principal)=='f'
                assert sql("select has_column_privilege('%s','public.tables','name','SELECT')"%principal)=='t'
            print('PASS: separately granted legacy column privileges are removed; forged paid-flag updates/inserts, private session data and raw setting reads remain denied while approved table-name display stays readable.')
            assert sql("select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r' and not relrowsecurity")=='0'
            print('PASS: nine coordinated SQL candidates apply to all 17 observed public table column shapes. Verified owner reserves bounded upload intent and uploads private evidence, creates server-priced booking, replays once, sees owner row; other customer and anon cannot read it; public availability contains no booking/customer/receipt identifiers; direct price/session mutations denied; owner reschedules/cancels via revisioned commands; all 17 public tables have RLS; trusted staff membership enables receipt read and one payment verification without transfer, zero-deposit approval confirms without payment and replays once; deactivation denies replay/read; authenticated feedback replays without public reads; large totals retain exact stored cents despite legacy REAL rounding; banned/revoked sessions cannot read private rows/receipts or replay committed commands.')
            print('LIMIT: Storage operation provenance is simulated; no actual Storage permission probe/final-writer transaction is executed. Receipt bytes/hash are not verified by this SQL fixture. Metadata-derived fixture simplifies defaults, constraints, indexes and triggers. Role/JWT subjects are simulated locally; no deployed PostgREST/Storage API, live tokens, staff receipt review, website deployment, old-key revocation or legacy receipt migration verified.')
        finally:
            process.terminate();process.wait(timeout=10)
