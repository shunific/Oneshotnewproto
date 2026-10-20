#!/usr/bin/env python3
"""Exercise server-owned receipt upload intents on disposable PG17; never remote."""
from pathlib import Path
import os
import subprocess
import tempfile
import time
import json
import uuid
import concurrent.futures

pg = Path(os.environ.get('ONESHOT_TEST_PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
script = Path(__file__).with_name('private-receipts.draft.sql').read_text()
owner = '11111111-1111-4111-8111-111111111111'
other = '22222222-2222-4222-8222-222222222222'
unverified = '44444444-4444-4444-8444-444444444444'
anonymous = '55555555-5555-4555-8555-555555555555'
object_id = '33333333-3333-4333-8333-333333333333'
with tempfile.TemporaryDirectory(prefix='oneshot-receipt-intents-') as directory:
    base = Path(directory)
    subprocess.run([str(pg/'initdb'),'-D',str(base/'db'),'-A','trust','-U','postgres','--no-locale'], check=True, stdout=subprocess.DEVNULL)
    with (base/'postgres.log').open('w') as log:
        server = subprocess.Popen([str(pg/'postgres'),'-D',str(base/'db'),'-k',str(base),'-p','54401','-h',''],stdout=log,stderr=log)
        try:
            for _ in range(100):
                if subprocess.run([str(pg/'pg_isready'),'-h',str(base),'-p','54401','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0: break
                if server.poll() is not None: raise RuntimeError((base/'postgres.log').read_text())
                time.sleep(.05)
            else: raise RuntimeError('Disposable Postgres not ready')
            def sql(query,success=True):
                result = subprocess.run([str(pg/'psql'),'-X','-q','-v','ON_ERROR_STOP=1','-At','-h',str(base),'-p','54401','-U','postgres'],input=query,text=True,capture_output=True)
                if (result.returncode == 0) != success: raise AssertionError(result.stderr or result.stdout)
                return result.stdout.strip()
            sql('''create role anon; create role authenticated; create schema auth; create schema storage;
            create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean,banned_until timestamptz,deleted_at timestamptz);
            create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
            create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
            create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
            grant usage on schema auth,storage to anon,authenticated; grant execute on function auth.uid() to public;
            create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
            create table storage.objects(bucket_id text,name text,owner_id text,metadata jsonb,primary key(bucket_id,name));
            alter table storage.objects enable row level security;
            grant select,insert,update,delete on storage.objects to anon,authenticated;
            create policy legacy_public_select on storage.objects for select using(true);
            create policy legacy_public_insert on storage.objects for insert with check(true);
            create policy legacy_public_update on storage.objects for update using(true) with check(true);
            create policy legacy_public_delete on storage.objects for delete using(true);
            insert into storage.buckets values ('oneshot-assets','oneshot-assets',true,31457280,null);
            insert into storage.objects values ('oneshot-assets','existing-public.jpg',null,'{}');''')
            sql(script,False)
            assert sql("select count(*) from storage.buckets where id='oneshot-receipts'") == '0'
            identity=Path(__file__).with_name('customer-identity.draft.sql').read_text()
            sql(identity,False)
            sql("set oneshot.secure_gateway_cutover='reviewed';\n"+identity)
            sql("set oneshot.private_receipts_cutover='reviewed';\n"+script)
            sql(f"insert into auth.users(id,email_confirmed_at,is_anonymous) values ('{owner}',now(),false),('{other}',now(),false),('{unverified}',null,false),('{anonymous}',now(),true)")
            sql("insert into auth.sessions select id,id,null from auth.users")
            sql('create table public.reservations(id text primary key,"receiptImg" text)')
            sql('alter table auth.users add column email text')
            sql("set oneshot.secure_gateway_cutover='reviewed';"+Path(__file__).with_name('staff-identity.draft.sql').read_text())
            intent_sql=Path(__file__).with_name('receipt-upload-intents.draft.sql').read_text()
            sql(intent_sql,False)
            sql("set oneshot.secure_gateway_cutover='reviewed';"+intent_sql,False)
            sql("set oneshot.private_receipts_cutover='reviewed';"+intent_sql,False)
            gated="set oneshot.secure_gateway_cutover='reviewed';set oneshot.private_receipts_cutover='reviewed';"
            sql(gated+intent_sql,False)  # Current hosted helper is a required rollout gate.
            # Simulated authoritative Storage operation only; not real API provenance proof.
            sql("""create function storage.allow_only_operation(operation text) returns boolean language sql stable as $$select coalesce(operation<>'',false) and regexp_replace(coalesce(current_setting('oneshot.test.storage_operation',true),''),'^storage\\.','')=regexp_replace(operation,'^storage\\.','')$$""")
            sql(gated+intent_sql)
            sql(gated+intent_sql)
            def as_user(uid):return f"set role authenticated;set request.jwt.claim.sub='{uid}';set request.jwt.claims='{{\"session_id\":\"{uid}\"}}';set oneshot.test.storage_operation='storage.object.upload';"
            def payload(uid=owner,**changes):return dict(requestId=str(uuid.uuid4()),expectedCustomerId=uid,contentType='image/png',byteSize=9,sha256='a'*64,**changes)
            def call(p,uid=owner,success=True):
                body=json.dumps(p).replace("'","''")
                out=sql(as_user(uid)+f"select public.oneshot_receipt_upload_intent('{body}'::jsonb)",success)
                return json.loads(out) if success else None
            def upload(uid,path,success=True):
                return sql(as_user(uid)+f"insert into storage.objects values ('oneshot-receipts','{path}','{uid}','{{\"mimetype\":\"image/png\",\"contentLength\":9}}')",success)
            p=payload();first=call(p)
            assert first['bucket']=='oneshot-receipts' and first['path'].startswith(owner+'/') and first['path'].endswith('.png')
            assert first['declaredSize']==9 and first['declaredMime']=='image/png' and first['sha256']=='a'*64 and not first['replayed']
            assert first['uploadAllowed'] is True
            again=call(p);assert again==dict(first,replayed=True)
            assert sql('select count(*) from oneshot_private.receipt_upload_intents')=='1'
            call(dict(p,byteSize=10),success=False)
            call(dict(p,path='forged'),success=False)
            call(dict(p,expectedCustomerId=other),success=False)
            call(p,uid=other,success=False)
            for change in [dict(byteSize=0),dict(byteSize=5242881),dict(byteSize='9'),dict(byteSize=1.5),dict(contentType='image/svg+xml'),dict(sha256='A'*64),dict(sha256='a'*63),dict(requestId='bad')]:
                call(dict(p,requestId=str(uuid.uuid4()),**change) if 'requestId' not in change else dict(p,**change),success=False)
            for invalid_uid in [unverified,anonymous]:call(payload(invalid_uid),uid=invalid_uid,success=False)
            sql("set role anon;select public.oneshot_receipt_upload_intent('{}'::jsonb)",False)
            for command in ["select * from oneshot_private.receipt_upload_intents","update oneshot_private.receipt_upload_intents set expires_at=now()+interval '1 hour'","delete from oneshot_private.receipt_upload_intents"]:
                sql(as_user(owner)+command,False)
            upload(owner,f'{owner}/{uuid.uuid4()}.png',False)
            upload(other,first['path'],False)
            for operation in ['storage.object.sign_upload_url','storage.object.upload_signed','storage.object.copy','storage.object.upload_resumable','storage.s3.put_object','']:
                sql(as_user(owner)+f"set oneshot.test.storage_operation='{operation}';insert into storage.objects values ('oneshot-receipts','{first['path']}','{owner}','{{}}')",False)
            upload(owner,first['path'])
            assert sql(as_user(owner)+"set oneshot.test.storage_operation='storage.object.get_authenticated';select count(*) from storage.objects where bucket_id='oneshot-receipts'")=='1'
            for user in [owner,other]:
                if user==other:
                    sql(f"insert into oneshot_private.staff_memberships(user_id,role,active,approved_by) values ('{other}','manager',true,'{owner}')")
                for operation in ['storage.object.sign','storage.object.sign_many','storage.object.list','','storage.object.upload']:
                    assert sql(as_user(user)+f"set oneshot.test.storage_operation='{operation}';select count(*) from storage.objects where bucket_id='oneshot-receipts'")=='0'
                assert sql(as_user(user)+"set oneshot.test.storage_operation='storage.object.get_authenticated';select count(*) from storage.objects where bucket_id='oneshot-receipts'")=='1'
            sql(f"update oneshot_private.staff_memberships set active=false where user_id='{other}'")
            assert sql(as_user(other)+"set oneshot.test.storage_operation='storage.object.get_authenticated';select count(*) from storage.objects where bucket_id='oneshot-receipts'")=='0'
            second_payload=payload();second=call(second_payload)
            sql("update oneshot_private.receipt_upload_intents set created_at=created_at-interval '16 minutes',expires_at=expires_at-interval '16 minutes'")
            old_expiry=json.loads(sql(f"select to_jsonb(expires_at) from oneshot_private.receipt_upload_intents where request_id='{second_payload['requestId']}'"))
            expired=call(second_payload);assert expired['path']==second['path'] and expired['replayed']
            assert expired['expiresAt']==old_expiry and expired['expiresAt']!=second['expiresAt']
            assert expired['uploadAllowed'] is False
            assert json.loads(sql(f"select to_jsonb(expires_at) from oneshot_private.receipt_upload_intents where request_id='{second_payload['requestId']}'"))==old_expiry
            upload(owner,second['path'],False)
            # Existing uploaded object remains recoverable after its intent expires.
            assert sql(as_user(owner)+"set oneshot.test.storage_operation='storage.object.get_authenticated';select count(*) from storage.objects where bucket_id='oneshot-receipts'")=='1'
            for update,reset in [
                (f"update auth.users set banned_until=now()+interval '1 day' where id='{owner}'",f"update auth.users set banned_until=null where id='{owner}'"),
                (f"update auth.users set deleted_at=now() where id='{owner}'",f"update auth.users set deleted_at=null where id='{owner}'"),
                (f"delete from auth.sessions where id='{owner}'",f"insert into auth.sessions values ('{owner}','{owner}',null)")]:
                sql(update);call(p,success=False);upload(owner,second['path'],False);sql(reset)
            sql(f"insert into public.reservations values ('LINKED-OLD','{first['path']}')")
            # The expired unused second ticket still reserves one of five slots.
            def new_intent(_):
                try:return ('ok',call(payload()))
                except AssertionError as error:
                    assert any(code in str(error) for code in ['RECEIPT_UPLOAD_LIMIT','RECEIPT_UNLINKED_LIMIT']),str(error)
                    return ('limited',None)
            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:results=list(pool.map(new_intent,range(10)))
            assert sum(kind=='ok' for kind,_ in results)==4 and sum(kind=='limited' for kind,_ in results)==6
            assert len({value['path'] for kind,value in results if kind=='ok'})==4
            call(payload(),success=False)
            active_path=next(value['path'] for kind,value in results if kind=='ok')
            for update,reset in [
                (f"update auth.users set banned_until=now()+interval '1 day' where id='{owner}'",f"update auth.users set banned_until=null where id='{owner}'"),
                (f"update auth.users set email_confirmed_at=null where id='{owner}'",f"update auth.users set email_confirmed_at=now() where id='{owner}'"),
                (f"delete from auth.sessions where id='{owner}'",f"insert into auth.sessions values ('{owner}','{owner}',null)")]:
                sql(update);upload(owner,active_path,False);sql(reset)
            upload(owner,active_path)
            sql(f"insert into public.reservations values ('LINKED-ACTIVE','{active_path}')")
            call(payload())  # A real linked object frees exactly one allocation slot.
            call(payload(),success=False)
            # A different owner's ten identical calls create one intent and replay nine times.
            other_payload=payload(other)
            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:repeats=list(pool.map(lambda _:call(other_payload,uid=other),range(10)))
            assert len({value['path'] for value in repeats})==1 and sum(value['replayed'] for value in repeats)==9
            assert sql(f"select count(*) from oneshot_private.receipt_upload_intents where owner_user_id='{other}'")=='1'
            # Linking valid objects frees capacity but does not bypass the rolling rate.
            rate_intents=[repeats[0]]+[call(payload(other),uid=other) for _ in range(4)]
            for index,value in enumerate(rate_intents):
                upload(other,value['path'])
                sql(f"insert into public.reservations values ('RATE-{index}','{value['path']}')")
            try:call(payload(other),uid=other);raise AssertionError('Rolling rate bypassed')
            except AssertionError as error:assert 'RECEIPT_UPLOAD_LIMIT' in str(error),str(error)
            # Same-ID replay remains available at quota without allocating/resurrecting anything.
            count_before=sql('select count(*) from oneshot_private.receipt_upload_intents')
            replay=call(p);assert replay['replayed'] and replay['path']==first['path']
            sql(gated+intent_sql)
            assert sql('select count(*) from oneshot_private.receipt_upload_intents')==count_before
            call(payload(),success=False)
            # Five uploaded orphans retain a capacity bound even after the rolling window.
            retained='66666666-6666-4666-8666-666666666666'
            sql(f"insert into auth.users(id,email_confirmed_at,is_anonymous) values ('{retained}',now(),false);insert into auth.sessions values ('{retained}','{retained}',null)")
            retained_payloads=[payload(retained) for _ in range(5)]
            retained_intents=[call(value,uid=retained) for value in retained_payloads]
            for value in retained_intents:upload(retained,value['path'])
            sql(f"update oneshot_private.receipt_upload_intents set created_at=created_at-interval '16 minutes',expires_at=expires_at-interval '16 minutes' where owner_user_id='{retained}'")
            try:call(payload(retained),uid=retained);raise AssertionError('Retained orphan quota bypassed')
            except AssertionError as error:assert 'RECEIPT_UNLINKED_LIMIT' in str(error),str(error)
            assert call(retained_payloads[0],uid=retained)['replayed'] is True
            sql(f"insert into public.reservations values ('LINKED-RETAINED','{retained_intents[0]['path']}')")
            unused=call(payload(retained),uid=retained)
            try:call(payload(retained),uid=retained);raise AssertionError('Reserved upload slot quota bypassed')
            except AssertionError as error:assert 'RECEIPT_UNLINKED_LIMIT' in str(error),str(error)
            sql(f"update oneshot_private.receipt_upload_intents set created_at=created_at-interval '16 minutes',expires_at=expires_at-interval '16 minutes' where path='{unused['path']}'")
            try:call(payload(retained),uid=retained);raise AssertionError('Expired unused slot was reclaimed')
            except AssertionError as error:assert 'RECEIPT_UNLINKED_LIMIT' in str(error),str(error)
            sql(f"insert into public.reservations values ('LINKED-RETAINED-SECOND','{retained_intents[1]['path']}')")
            def retained_attempt(_):
                try:return call(payload(retained),uid=retained)
                except AssertionError as error:
                    assert 'RECEIPT_UNLINKED_LIMIT' in str(error),str(error)
                    return None
            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:retained_results=list(pool.map(retained_attempt,range(10)))
            assert sum(value is not None for value in retained_results)==1
            assert sql(f"select count(*) from oneshot_private.receipt_upload_intents i where owner_user_id='{retained}' and not exists(select 1 from reservations r where r.\"receiptImg\"=i.path)")=='5'
            # A fifth INSERT held across its ticket expiry must serialize allocation.
            racing='77777777-7777-4777-8777-777777777777'
            sql(f"insert into auth.users(id,email_confirmed_at,is_anonymous) values ('{racing}',now(),false);insert into auth.sessions values ('{racing}','{racing}',null)")
            race_payloads=[payload(racing) for _ in range(5)]
            race_intents=[call(value,uid=racing) for value in race_payloads]
            for value in race_intents[:4]:upload(racing,value['path'])
            race_path=race_intents[4]['path']
            sql(f"update oneshot_private.receipt_upload_intents set created_at=created_at-interval '16 minutes',expires_at=expires_at-interval '16 minutes' where owner_user_id='{racing}' and path<>'{race_path}'")
            sql(f"update oneshot_private.receipt_upload_intents set created_at=statement_timestamp()-interval '14 minutes 59 seconds',expires_at=statement_timestamp()+interval '1 second' where path='{race_path}'")
            held_query='begin;'+as_user(racing)+f"insert into storage.objects values ('oneshot-receipts','{race_path}','{racing}','{{}}');select 'insert-held';\n"
            held=subprocess.Popen([str(pg/'psql'),'-X','-q','-v','ON_ERROR_STOP=1','-At','-h',str(base),'-p','54401','-U','postgres'],text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            held.stdin.write(held_query);held.stdin.flush()
            assert held.stdout.readline().strip()=='insert-held'
            held.stdin.write('select pg_sleep(3);commit;\n');held.stdin.close();held.stdin=None
            deadline=time.monotonic()+2
            while sql(f"select clock_timestamp()>expires_at from oneshot_private.receipt_upload_intents where path='{race_path}'")!='t':
                assert time.monotonic()<deadline,'Ticket did not expire during held INSERT'
                time.sleep(.02)
            assert held.poll() is None,'Held INSERT ended before expiry race was exercised'
            began=time.monotonic()
            try:call(payload(racing),uid=racing);raise AssertionError('Allocator bypassed held fifth INSERT')
            except AssertionError as error:assert 'RECEIPT_UNLINKED_LIMIT' in str(error),str(error)
            waited=time.monotonic()-began
            remaining,errors=held.communicate(timeout=5)
            assert held.returncode==0,errors
            assert waited>0.5,'Allocator did not wait for held Storage INSERT transaction'
            assert sql(f"select count(*) from storage.objects where bucket_id='oneshot-receipts' and owner_id='{racing}'")=='5'
            assert sql(f"select count(*) from oneshot_private.receipt_upload_intents where owner_user_id='{racing}'")=='5'
            # Model Storage's savepoint-rolled-back permission probe and privileged
            # final metadata write. Persistent allocation, not the probe lock, is the bound.
            probed='88888888-8888-4888-8888-888888888888'
            sql(f"insert into auth.users(id,email_confirmed_at,is_anonymous) values ('{probed}',now(),false);insert into auth.sessions values ('{probed}','{probed}',null)")
            probe_intents=[call(payload(probed),uid=probed) for _ in range(5)]
            for value in probe_intents[:4]:upload(probed,value['path'])
            probe_path=probe_intents[4]['path']
            sql('begin;'+as_user(probed)+f"savepoint storage_permission_probe;insert into storage.objects values ('oneshot-receipts','{probe_path}','{probed}','{{}}');rollback to savepoint storage_permission_probe;commit;")
            assert sql(f"select count(*) from storage.objects where owner_id='{probed}'")=='4'
            sql(f"update oneshot_private.receipt_upload_intents set created_at=created_at-interval '16 minutes',expires_at=expires_at-interval '16 minutes' where owner_user_id='{probed}'")
            try:call(payload(probed),uid=probed);raise AssertionError('Rolled-back probe/expiry released reserved slot')
            except AssertionError as error:assert 'RECEIPT_UNLINKED_LIMIT' in str(error),str(error)
            sql(f"insert into storage.objects values ('oneshot-receipts','{probe_path}','{probed}','{{}}')")
            assert sql(f"select count(*) from storage.objects where owner_id='{probed}'")=='5'
            assert sql(f"select count(*) from oneshot_private.receipt_upload_intents where owner_user_id='{probed}'")=='5'
            assert sql("select provolatile from pg_proc where proname='has_receipt_upload_intent' and pronamespace='oneshot_private'::regnamespace")=='v'
            assert sql("select count(*) from pg_policy where polrelid='storage.objects'::regclass and polname='receipt_upload_intent_guard' and not polpermissive")=='1'
            sql("set role anon;insert into storage.objects values ('oneshot-assets','unrelated-public.jpg',null,'{}')")
            assert sql("set role anon;select count(*) from storage.objects where bucket_id='oneshot-assets'")=='2'
            assert sql("select prosecdef from pg_proc where proname='oneshot_receipt_upload_intent'")=='f'
            assert sql("select relrowsecurity from pg_class where oid='oneshot_private.receipt_upload_intents'::regclass")=='t'
            print('PASS: dual rollout gates; server-generated immutable owner paths; strict declaration fields; fresh identity before replay; exact same-ID replay/conflict; declared JPEG/PNG<=5MB; no direct intent reads/mutations; no-intent/expired/cross-owner/anonymous/unverified/banned/deleted/revoked insertion denial; legacy permissive policies cannot bypass restrictive intent guard; expired object recovery; rolling rate five new/15min even with linked evidence and concurrent identical ID exactly one new; all five issued unlinked paths remain reserved including expired/no-object paths, actual booking link frees a slot, parallel calls cannot exceed remaining capacity; simulated savepoint rollback plus privileged final write cannot release reserved allocations; held fifth direct SQL INSERT crossing expiry serializes allocator until commit and prevents sixthobject; simulated standard-upload passes while signed-mint/copy/TUS/S3/missing upload operations deny; owner/staff authenticated-download passes while signed-read/sign-many/list/no-op/direct-DataAPI reads deny and staffdeactivation revokesread; replay/rerun preserves expiry/quota; other buckets unchanged.')
            print('LIMIT: local PostgreSQL role/JWT fixture. MIME/size/SHA256 are declarations, not server content/hash verification; Storage operation helper is simulated, not real API operation provenance; direct SQL INSERT locks do not prove actual Storage permission-probe/final-write transaction semantics. No automatic reclamation of expired unused paths: failed-ticket support/trusted cleanup remains a release gate. No live Storage API/real-token rollout, scanner or retention cleanup verified.')
        finally:
            server.terminate()
            server.wait(timeout=10)
