#!/usr/bin/env python3
"""Disposable PG17 claim tests only: no network, live cloud or device admission."""
from pathlib import Path
import concurrent.futures
import hashlib
import json
import os
import subprocess
import tempfile
import time
import uuid

PG = Path(os.environ.get('ONESHOT_TEST_PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
SOURCE = Path(__file__).parent
STAFF = '11111111-1111-4111-8111-111111111111'
MANAGER = '22222222-2222-4222-8222-222222222222'
CUSTOMER = '33333333-3333-4333-8333-333333333333'
ORDINARY = '44444444-4444-4444-8444-444444444444'
DEVICE = '55555555-5555-4555-8555-555555555555'
DEVICE2 = '66666666-6666-4666-8666-666666666666'
checks = []

def quote(value):
    return "'" + str(value).replace("'", "''") + "'"

with tempfile.TemporaryDirectory(prefix='oneshot-checkin-') as directory:
    base = Path(directory)
    subprocess.run([str(PG/'initdb'), '-D', str(base/'db'), '-A', 'trust', '-U', 'postgres', '--no-locale', '--encoding=UTF8'], check=True, stdout=subprocess.DEVNULL)
    with (base/'postgres.log').open('w') as log:
        server = subprocess.Popen([str(PG/'postgres'), '-D', str(base/'db'), '-k', str(base), '-p', '54407', '-h', ''], stdout=log, stderr=log)
        try:
            for _ in range(100):
                if subprocess.run([str(PG/'pg_isready'), '-h', str(base), '-p', '54407'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                    break
                if server.poll() is not None:
                    raise RuntimeError((base/'postgres.log').read_text())
                time.sleep(.05)
            else:
                raise RuntimeError('PostgreSQL startup failed')

            def execute(query):
                return subprocess.run([str(PG/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(base), '-p', '54407', '-U', 'postgres'], input=query, text=True, capture_output=True, timeout=25)

            def sql(query, error=None):
                result = execute(query)
                if error is not None:
                    assert result.returncode != 0 and error in result.stderr, (error, result.stdout, result.stderr)
                    checks.append(error)
                    return None
                assert result.returncode == 0, (result.stdout, result.stderr)
                return result.stdout.strip()

            sql('''create role anon;create role authenticated;create schema auth;create schema storage;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,banned_until timestamptz,deleted_at timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth,storage to anon,authenticated;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create function storage.allow_only_operation(expected text) returns boolean language sql stable as $$select current_setting('oneshot.test.storage_operation',true)=expected$$;
create table storage.objects(bucket_id text,name text,owner_id text,metadata jsonb,primary key(bucket_id,name));
alter table storage.objects enable row level security;
grant select,insert,update,delete on storage.objects to anon,authenticated;''')
            sql((SOURCE/'cloud-schema.fixture.sql').read_text())
            gates = "set oneshot.secure_gateway_cutover='reviewed';set oneshot.private_receipts_cutover='reviewed';\n"
            sources = ['customer-identity.draft.sql','cloud-containment.draft.sql','private-receipts.draft.sql','booking-transactions.draft.sql','booking-availability.draft.sql','staff-identity.draft.sql','staff-payments.draft.sql','feedback-commands.draft.sql','receipt-upload-intents.draft.sql']
            sql(gates + '\n'.join((SOURCE/name).read_text() for name in sources))
            draft = (SOURCE/'staff-checkin.draft.sql').read_text()
            sql(draft, 'reviewed coordinated gateway cutover required')
            sql(gates + draft)
            checks.append('all nine prerequisites plus tenth claim candidate apply to observed fixture')
            session_ids = {uid: str(uuid.uuid4()) for uid in [STAFF, MANAGER, CUSTOMER, ORDINARY]}
            for uid, sid in session_ids.items():
                sql(f"insert into auth.users values ('{uid}','{uid[:8]}@example.invalid',now(),false,null,null);insert into auth.sessions values ('{sid}','{uid}',null)")
            sql(f"insert into oneshot_private.staff_memberships(user_id,role,active,approved_by) values ('{STAFF}','cashier',true,'{MANAGER}'),('{MANAGER}','manager',true,'{MANAGER}')")
            sql("insert into system_settings values ('cancellationHours','0')")
            counter = 0

            def as_user(uid=STAFF, role='authenticated', sid=None):
                return f"set role {role};set request.jwt.claim.sub='{uid}';set request.jwt.claims={quote(json.dumps({'session_id': sid or session_ids[uid]}))};"

            def rpc(name, payload, uid=STAFF, error=None):
                result = sql(as_user(uid) + f'select public.{name}({quote(json.dumps(payload))}::jsonb);', error)
                return json.loads(result) if result else None

            def seed(total=30000, deposit=6000, discount=5000, verify=True, approve=False):
                global counter
                counter += 1
                ident = f'QA-CHECKIN-{counter}'
                table = f'CLOUD-{counter}'
                native = f'LOCAL-{counter}'
                sql(f"insert into public.tables(id,name,status,isactive,\"isActive\") values ('{table}','QA table','available',1,1)")
                sql(f"insert into oneshot_private.checkin_table_mappings(device_id,native_table_id,cloud_table_id,active,coordinator_ready,approved_by) values ('{DEVICE}','{native}','{table}',true,true,'{MANAGER}'),('{DEVICE2}','{native}','{table}',true,true,'{MANAGER}')")
                sql(f'''insert into reservations(id,"customerName","contactNumber",email,date,"timeSlot","durationHours","partySize","tableId",status,"downPaymentPaid","balancePaid",balancepaid,customer_user_id,revision,total_amount_cents,down_payment_amount_cents,discount_amount_cents,"rescheduleCount") values ('{ident}','QA Owner','09123456789','owner@example.invalid',timezone('Asia/Manila',statement_timestamp())::date,'23:59',2,2,'{table}','pending',0,0,0,'{CUSTOMER}',1,{total},{deposit},{discount},0)''')
                revision = 1
                if verify:
                    amount = deposit if deposit else total
                    payment = dict(requestId=str(uuid.uuid4()), id=ident, expectedRevision=revision, expectedStaffId=STAFF, paymentKind='deposit' if deposit else 'balance', method='cash', expectedAmountCents=amount)
                    rpc('oneshot_staff_confirm_payment', payment)
                    revision += 1
                elif approve:
                    rpc('oneshot_staff_approve_booking', dict(requestId=str(uuid.uuid4()), id=ident, expectedRevision=revision, expectedStaffId=STAFF, expectedTotalCents=total, expectedDownPaymentCents=deposit))
                    revision += 1
                else:
                    sql(f"update reservations set status='confirmed' where id='{ident}'")
                return dict(requestId=str(uuid.uuid4()), id=ident, expectedRevision=revision, expectedStaffId=STAFF, deviceId=DEVICE, tableId=native)

            def claim(payload, uid=STAFF, error=None):
                return rpc('oneshot_staff_claim_checkin', payload, uid, error)

            def snapshot():
                return sql("select jsonb_build_object('reservations',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.reservations r),'claims',(select coalesce(jsonb_agg(to_jsonb(c) order by id),'[]') from oneshot_private.checkin_claims c),'operations',(select coalesce(jsonb_agg(to_jsonb(o) order by actor_user_id,request_id),'[]') from oneshot_private.checkin_operations o),'payments',(select coalesce(jsonb_agg(to_jsonb(v) order by id),'[]') from oneshot_private.staff_payment_verifications v),'approvals',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from oneshot_private.staff_booking_approvals a),'mappings',(select coalesce(jsonb_agg(to_jsonb(m) order by device_id,native_table_id),'[]') from oneshot_private.checkin_table_mappings m))")

            p = seed()
            result = claim(p)
            successful_command = dict(p)
            successful_result = result
            c = result['claim']
            assert c['netTotalCents'] == 30000 and c['discountCents'] == 5000 and c['grossTotalCents'] == 35000 and c['verifiedPaidCents'] == 6000
            assert c['state'] == 'claim-pending' and c['ownerUserId'] == CUSTOMER and c['actorUserId'] == STAFF and c['actorRole'] == 'cashier'
            assert c['sourceRevision'] == 2 and c['claimRevision'] == 3 and c['durationMinutes'] == 120 and c['requiredDepositCents'] == 6000
            assert c['tableId'] == p['tableId'] and c['deviceId'] == DEVICE and result['fundsTransferred'] is False
            assert sql(f"select status||':'||revision from reservations where id='{p['id']}'") == 'claim-pending:3'
            assert sql("select count(*) from oneshot_private.staff_payment_verifications") == '1'
            assert sql(f"select status from public.tables where id={quote(c['cloudTableId'])}") == 'available'
            before = snapshot()
            assert claim(p)['replayed'] is True and snapshot() == before
            checks.extend(['immutable quote, identity, owner and verified deposit snapshot', 'claim-pending is neither admission nor completion nor payment', 'exact replay preserves six table snapshots'])
            claim(dict(p, tableId='changed'), error='IDEMPOTENCY_CONFLICT')
            claim(dict(p, requestId=str(uuid.uuid4())), error='BOOKING_ALREADY_CLAIMED')
            claim(dict(p, expectedStaffId=MANAGER), error='ACCOUNT_CHANGED')
            claim(dict(p, expectedStaffId=MANAGER), uid=MANAGER, error='BOOKING_ALREADY_CLAIMED')
            claim(dict(p, expectedStaffId=ORDINARY), uid=ORDINARY, error='STAFF_REQUIRED')
            sql(as_user(STAFF, role='anon') + f"select public.oneshot_staff_claim_checkin({quote(json.dumps(p))}::jsonb)", 'permission denied')
            for table in ['checkin_claims','checkin_operations','checkin_table_mappings']:
                for operation in [f'select * from oneshot_private.{table}', f'delete from oneshot_private.{table}']:
                    sql(as_user()+operation, 'permission denied')
            sql(as_user()+f"update public.reservations set status='completed' where id='{p['id']}'", 'permission denied')
            sql(f"update public.reservations set status='cancelled' where id='{p['id']}'", 'BOOKING_CHECKIN_CLAIMED')
            sql(f"delete from public.reservations where id='{p['id']}'", 'BOOKING_CHECKIN_CLAIMED')
            sql(f"update oneshot_private.staff_payment_verifications set amount_cents=1 where reservation_id='{p['id']}'", 'BOOKING_CHECKIN_CLAIMED')
            sql(f"delete from oneshot_private.staff_payment_verifications where reservation_id='{p['id']}'", 'BOOKING_CHECKIN_CLAIMED')
            sql(f"insert into oneshot_private.staff_payment_verifications(reservation_id,payment_kind,amount_cents,method,actor_user_id,actor_role,actor_email) values ('{p['id']}','balance',24000,'cash','{STAFF}','cashier','cashier@example.invalid')", 'BOOKING_CHECKIN_CLAIMED')
            sql("update oneshot_private.checkin_claims set snapshot='{}'", 'CHECKIN_AUDIT_IMMUTABLE')
            sql("delete from oneshot_private.checkin_operations", 'CHECKIN_AUDIT_IMMUTABLE')
            assert snapshot() == before
            checks.append('all old direct reservation and payment mutation paths frozen after claim')
            sql(f"update oneshot_private.staff_memberships set active=false where user_id='{STAFF}'")
            claim(p, error='STAFF_REQUIRED')
            sql(f"update oneshot_private.staff_memberships set active=true where user_id='{STAFF}'")
            sid = session_ids[STAFF]
            sql(f"delete from auth.sessions where id='{sid}'")
            claim(p, error='STAFF_REQUIRED')
            sql(f"insert into auth.sessions values ('{sid}','{STAFF}',now()-interval '1 second')")
            claim(p, error='STAFF_REQUIRED')
            sql(f"update auth.sessions set not_after=null where id='{sid}'")
            checks.append('membership revocation, revoked session and expired session deny even replay')
            sql(f"update oneshot_private.checkin_table_mappings set active=false,coordinator_ready=false where device_id='{DEVICE}' and native_table_id='{p['tableId']}'")
            assert claim(p)['replayed'] is True
            sql(f"update oneshot_private.staff_memberships set role='manager' where user_id='{STAFF}'")
            assert claim(p)['claim']['actorRole']=='cashier'
            sql(f"update oneshot_private.staff_memberships set role='cashier' where user_id='{STAFF}'")
            checks.append('exact recovery replay survives disabled mapping/readiness and preserves original role after promotion')

            for mutation, error in [({'expectedRevision':1},'STALE_REVISION'),({'expectedRevision':'2'},'INVALID_REQUEST'),({'expectedRevision':2.5},'INVALID_REQUEST'),({'expectedRevision':None},'INVALID_REQUEST'),({'expectedRevision':9007199254740991},'INVALID_REQUEST'),({'requestId':None},'INVALID_REQUEST'),({'deviceId':'not-uuid'},'INVALID_REQUEST'),({'deviceId':str(uuid.uuid4())},'CHECKIN_MAPPING_REQUIRED'),({'amountPaid':6000},'INVALID_FIELDS'),({'id':' padded '},'INVALID_REQUEST'),({'tableId':' padded '},'INVALID_REQUEST'),({'tableId':'\u00a0padded'},'INVALID_REQUEST'),({'requestId':str(uuid.uuid4()).upper()},'INVALID_REQUEST'),({'deviceId':DEVICE.replace('-','')},'INVALID_REQUEST')]:
                q=seed();before_case=snapshot();claim(dict(q,**mutation),error=error);assert snapshot()==before_case
            for patch, error in [("\"downPaymentPaid\"=1",'PAYMENT_LEDGER_RECONCILIATION_REQUIRED'),("customer_user_id=null",'BOOKING_OWNER_RECONCILIATION_REQUIRED'),("\"refundStatus\"='acknowledged'",'PAYMENT_LEDGER_RECONCILIATION_REQUIRED'),("total_amount_cents=null",'BOOKING_FINANCIAL_RECONCILIATION_REQUIRED'),("total_amount_cents=240000000,discount_amount_cents=1",'BOOKING_FINANCIAL_RECONCILIATION_REQUIRED'),("email='bad.email'",'BOOKING_RECONCILIATION_REQUIRED'),("\"customerName\"=repeat(' ',600)||'QA'",'BOOKING_RECONCILIATION_REQUIRED'),("\"contactNumber\"=repeat(' ',150)||'0912'",'BOOKING_RECONCILIATION_REQUIRED'),("\"customerName\"=U&'\\00a0\\2000'",'BOOKING_RECONCILIATION_REQUIRED'),("email=U&'bad\\00a0email@example.invalid'",'BOOKING_RECONCILIATION_REQUIRED'),("date=timezone('Asia/Manila',statement_timestamp())::date+1",'CHECKIN_DATE_NOT_ALLOWED')]:
                q=seed(verify=False);sql(f"update reservations set {patch} where id='{q['id']}'");before_case=snapshot();claim(q,error=error);assert snapshot()==before_case
            q=seed(verify=False);claim(q,error='DEPOSIT_VERIFICATION_REQUIRED')
            q=seed(total=30000,deposit=0,verify=False);claim(q,error='APPROVAL_VERIFICATION_REQUIRED')
            for total in [0,30000]:
                q=seed(total=total,deposit=0,discount=0,verify=False,approve=True);zero=claim(q)['claim'];assert zero['verifiedPaidCents']==0 and zero['requiredDepositCents']==0 and zero['netTotalCents']==total
            checks.append('zero-total and zero-deposit require trusted approval without fabricated paid flags')
            q=seed();sql(f"update reservations set \"partySize\"=750 where id='{q['id']}'")
            assert claim(q)['claim']['partySize']==750
            checks.append('claim preserves original positive integer party without inventing a new capacity cap')
            q=seed();sql(f"update oneshot_private.checkin_table_mappings set coordinator_ready=false where native_table_id='{q['tableId']}'");claim(q,error='CHECKIN_COORDINATOR_NOT_READY')
            q=seed();sql(f"update oneshot_private.checkin_table_mappings set active=false where device_id='{DEVICE}' and native_table_id='{q['tableId']}'");claim(q,error='CHECKIN_MAPPING_REQUIRED')
            q=seed();cloud=sql(f"select \"tableId\" from reservations where id='{q['id']}'");sql(f"update public.tables set \"isActive\"=0 where id='{cloud}'");claim(q,error='CHECKIN_CLOUD_TABLE_UNAVAILABLE')
            q=seed();sql(f"update reservations set \"tableId\"='not-mapped' where id='{q['id']}'");claim(q,error='CHECKIN_TABLE_MISMATCH')

            def raw_claim(payload, uid=STAFF):
                return execute(as_user(uid)+f"select public.oneshot_staff_claim_checkin({quote(json.dumps(payload))}::jsonb)")

            q=seed()
            contenders=[q,dict(q,requestId=str(uuid.uuid4()),expectedStaffId=MANAGER,deviceId=DEVICE2)]
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                raced=list(pool.map(lambda pair:raw_claim(*pair),[(contenders[0],STAFF),(contenders[1],MANAGER)]))
            assert sorted(r.returncode==0 for r in raced)==[False,True]
            assert any('BOOKING_ALREADY_CLAIMED' in r.stderr for r in raced)
            assert sql(f"select count(*) from oneshot_private.checkin_claims where reservation_id='{q['id']}'")=='1'
            checks.append('two actors/devices competing for one reservation produce exactly one immutable claim')
            q=seed()
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                raced=list(pool.map(lambda _:raw_claim(q),range(4)))
            assert all(r.returncode==0 for r in raced)
            assert sum(not json.loads(r.stdout)['replayed'] for r in raced)==1
            checks.append('four concurrent identical requests commit once and replay three times')

            # A second confirmed reservation mapped onto an already claimed physical
            # table must not bypass uniqueness through a different request or device.
            q=seed();occupied=claim(q)['claim']['cloudTableId'];other=seed();sql(f"update reservations set \"tableId\"='{occupied}' where id='{other['id']}';update oneshot_private.checkin_table_mappings set cloud_table_id='{occupied}' where native_table_id='{other['tableId']}'")
            claim(other,error='CHECKIN_TABLE_ALREADY_CLAIMED')

            def held_transaction(query, label):
                worker = subprocess.Popen([str(PG/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(base), '-p', '54407', '-U', 'postgres'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                worker.stdin.write(f"set application_name='{label}';begin;{query};select pg_sleep(1.2);commit;")
                worker.stdin.close()
                for _ in range(100):
                    if sql(f"select count(*) from pg_stat_activity where application_name='{label}' and wait_event='PgSleep'") == '1':
                        return worker
                    if worker.poll() is not None:
                        raise AssertionError((worker.stdout.read(), worker.stderr.read()))
                    time.sleep(.01)
                raise AssertionError('Held transaction did not reach its controlled commit barrier')

            def finish(worker):
                assert worker.wait(timeout=10) == 0, worker.stderr.read()

            # An already-held claim must serialize actual legacy cancel/payment
            # RPCs and direct ledger INSERT before any can alter its snapshot.
            q=seed()
            worker=held_transaction(as_user()+f"select public.oneshot_staff_claim_checkin({quote(json.dumps(q))}::jsonb)", 'qa-held-claim')
            cancel=as_user(CUSTOMER)+f"select public.oneshot_booking_cancel({quote(json.dumps(dict(requestId=str(uuid.uuid4()),id=q['id'],expectedRevision=2,expectedCustomerId=CUSTOMER,reason='QA race')))}::jsonb)"
            payment=as_user()+f"select public.oneshot_staff_confirm_payment({quote(json.dumps(dict(requestId=str(uuid.uuid4()),id=q['id'],expectedRevision=2,expectedStaffId=STAFF,paymentKind='balance',method='cash',expectedAmountCents=24000)))}::jsonb)"
            direct=f"insert into oneshot_private.staff_payment_verifications(reservation_id,payment_kind,amount_cents,method,actor_user_id,actor_role,actor_email) values ('{q['id']}','balance',24000,'cash','{STAFF}','cashier','cashier@example.invalid')"
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                raced=list(pool.map(execute,[cancel,payment,direct]))
            finish(worker)
            assert all(r.returncode != 0 for r in raced)
            assert 'BOOKING_CHECKIN_CLAIMED' in raced[2].stderr
            assert sql(f"select status||':'||revision from reservations where id='{q['id']}'")=='claim-pending:3'
            assert sql(f"select sum(amount_cents) from oneshot_private.staff_payment_verifications where reservation_id='{q['id']}'")=='6000'
            checks.append('held claim defeats concurrent real cancellation/payment RPCs and direct ledger insertion')

            # Conversely a payment committed first changes the revision; a stale
            # claim cannot freeze the earlier paid amount and must be re-reviewed.
            q=seed()
            payment=as_user()+f"select public.oneshot_staff_confirm_payment({quote(json.dumps(dict(requestId=str(uuid.uuid4()),id=q['id'],expectedRevision=2,expectedStaffId=STAFF,paymentKind='balance',method='cash',expectedAmountCents=24000)))}::jsonb)"
            worker=held_transaction(payment,'qa-held-payment')
            outcome=raw_claim(q);finish(worker)
            assert outcome.returncode != 0 and 'STALE_REVISION' in outcome.stderr
            assert claim(dict(q,expectedRevision=3))['claim']['verifiedPaidCents']==30000
            checks.append('payment-first race rejects stale claim; reviewed retry snapshots full verified payment')

            # This clock condition uses the fixture server's Manila date/time;
            # cancellation close to midnight can already be outside cutoff.
            if sql("select timezone('Asia/Manila',statement_timestamp())::time < '23:59'::time")=='t':
                q=seed()
                cancel=as_user(CUSTOMER)+f"select public.oneshot_booking_cancel({quote(json.dumps(dict(requestId=str(uuid.uuid4()),id=q['id'],expectedRevision=2,expectedCustomerId=CUSTOMER,reason='QA cancel first')))}::jsonb)"
                worker=held_transaction(cancel,'qa-held-cancel')
                outcome=raw_claim(q);finish(worker)
                assert outcome.returncode != 0 and ('STALE_REVISION' in outcome.stderr or 'CHECKIN_STATE_NOT_ALLOWED' in outcome.stderr)
                assert sql(f"select count(*) from oneshot_private.checkin_claims where reservation_id='{q['id']}'")=='0'
                checks.append('cancellation-first race prevents claim after real pending-refund transition')
            else:
                checks.append('cancellation-first race explicitly inapplicable in final Manila minute; held-claim cancellation denial still tested')

            # Recheck authorization after waiting for contended table locks.
            q=seed()
            blocker=held_transaction('lock table public.tables in share row exclusive mode','qa-auth-blocker')
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                waiting=pool.submit(raw_claim,q)
                for _ in range(100):
                    if sql("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%oneshot_staff_claim_checkin%'")!='0':break
                    time.sleep(.01)
                else:raise AssertionError('Claim did not wait at the table lock barrier')
                sql(f"update oneshot_private.staff_memberships set active=false where user_id='{STAFF}'")
                outcome=waiting.result()
            finish(blocker)
            assert outcome.returncode != 0 and 'STAFF_REQUIRED' in outcome.stderr
            assert sql(f"select count(*) from oneshot_private.checkin_claims where reservation_id='{q['id']}'")=='0'
            sql(f"update oneshot_private.staff_memberships set active=true where user_id='{STAFF}'")
            checks.append('membership revoked during lock wait denies claim before replay or mutation')

            # Failure after reservation transition and claim insertion must roll back
            # all of them, preserving exact request retry rather than leaving a claim.
            q=seed();before_failure=snapshot()
            sql("create function oneshot_private.test_fail_checkin_operation() returns trigger language plpgsql as $$begin raise exception 'QA_LATE_FAILURE';end$$;create trigger qa_late_failure before insert on oneshot_private.checkin_operations for each row execute function oneshot_private.test_fail_checkin_operation()")
            claim(q,error='QA_LATE_FAILURE');assert snapshot()==before_failure
            sql("drop trigger qa_late_failure on oneshot_private.checkin_operations;drop function oneshot_private.test_fail_checkin_operation()")
            assert claim(q)['replayed'] is False
            checks.append('late operation-ledger failure atomically rolls back status, revision and claim; exact retry commits')

            before_reapply=snapshot()
            sql(gates+draft)
            assert snapshot()==before_reapply and claim(p)['replayed'] is True
            sql(gates+draft)
            assert snapshot()==before_reapply
            checks.append('two reapplications preserve exact six-table snapshots and legitimate replay')
            for mutation in [
                'alter table oneshot_private.checkin_table_mappings alter active drop not null',
                'alter table oneshot_private.checkin_table_mappings alter active set default true',
                'grant select(native_table_id) on oneshot_private.checkin_table_mappings to authenticated',
                'alter table oneshot_private.checkin_claims drop constraint checkin_claims_state_check',
                'alter table oneshot_private.checkin_operations alter payload drop not null',
                'alter table oneshot_private.checkin_claims drop constraint checkin_claims_actor_user_id_fkey',
            ]:
                sql('begin;'+mutation+';'+gates+draft,error='INCOMPATIBLE_CHECKIN_')
                assert snapshot()==before_reapply
            checks.append('six weak existing schema/column-ACL variants fail atomically without changing audit rows')
            print(json.dumps({'passed':len(checks),'checks':checks,'sourceSha256':hashlib.sha256(draft.encode()).hexdigest(),'successfulCommand':successful_command,'successfulResult':successful_result,'documentationReviewed':['https://supabase.com/changelog.md','https://supabase.com/docs/guides/database/functions','https://supabase.com/docs/guides/api/securing-your-api'],'engine':sql('select version()'),'liveWrites':False,'limits':['Local PostgreSQL/JWT fixture only; no hosted PostgREST proof.','Owner-enrolled mappings required; caller device UUID is not hardware attestation.','coordinator_ready defaults false and must remain disabled until native durable admission/completion recovery exists. Candidate excluded from deployment bundle.','Claim pending only; native durable admission and completion/release ACK are not implemented.','No expiry, automatic release, payment collection, refund, extension or alternative-table policy.']},indent=2))
        finally:
            server.terminate()
            server.wait(timeout=10)
