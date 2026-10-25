#!/usr/bin/env python3
"""Independent lifecycle authorization/ordering checks on disposable PostgreSQL only."""
import copy
import concurrent.futures
import hashlib
import json
import subprocess
import time
from native_lifecycle_fixture import fixture, SOURCE, PG, STAFF, CUSTOMER, OTHER, q

reviewed_sources = ['staff-checkin.draft.sql','native-device-proof.draft.sql','native-reservation-lifecycle.draft.sql']
source_hashes = {name:hashlib.sha256((SOURCE/name).read_bytes()).hexdigest() for name in reviewed_sources}

with fixture() as f:
    command, claim = f.seed()
    f.apply('staff-checkin.draft.sql')
    f.apply('native-device-proof.draft.sql')
    f.enroll()
    f.apply('native-reservation-lifecycle.draft.sql')
    events = f.native(command, claim)

    def held_table_lock(label, lock_sql="lock table public.tables in share row exclusive mode"):
        worker = subprocess.Popen([
            str(PG/'psql'), '-X', '-qAt',
            '-v', 'ON_ERROR_STOP=1', '-h', str(f.base), '-p', '54409', '-U', 'postgres',
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        worker.stdin.write(f"set application_name='{label}';begin;{lock_sql};select pg_sleep(1.5);commit;")
        worker.stdin.close()
        for _ in range(100):
            if f.sql(f"select count(*) from pg_stat_activity where application_name='{label}' and wait_event='PgSleep'") == '1':
                return worker
            if worker.poll() is not None:
                raise AssertionError('Controlled table-lock holder exited early')
            time.sleep(.01)
        raise AssertionError('Controlled table-lock holder never reached its barrier')

    def wait_for_ack_lock(application='qa-review-ack-wait'):
        for _ in range(100):
            if f.sql(f"select count(*) from pg_stat_activity where application_name={q(application)} and wait_event_type='Lock'") == '1':
                return
            time.sleep(.01)
        raise AssertionError('ACK did not reach its controlled lock wait')

    for boundary, lock_sql in [
        ('table', 'lock table public.tables in share row exclusive mode'),
        ('reservation-row', f"select id from reservations where id={q(command['id'])} for update"),
        ('cloud-table-row', "select id from public.tables where id='CLOUD-1' for update"),
    ]:
        for mode in ['membership-revoked', 'session-expired']:
            holder = held_table_lock('qa-review-'+boundary+'-'+mode, lock_sql)
            query = "set application_name='qa-review-ack-wait';" + f.user() + f"select public.oneshot_staff_ack_native_event({q(json.dumps(events['admission']))}::jsonb)"
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                waiting = pool.submit(f.execute, query)
                wait_for_ack_lock()
                if mode == 'membership-revoked':
                    f.sql(f"update oneshot_private.staff_memberships set active=false where user_id='{STAFF}'")
                else:
                    f.sql(f"update auth.sessions set not_after=clock_timestamp()+interval '50 milliseconds' where id='{f.sessions[STAFF]}'")
                outcome = waiting.result(timeout=10)
            assert holder.wait(timeout=10) == 0, holder.stderr.read()
            assert outcome.returncode != 0 and 'STAFF_REQUIRED' in outcome.stderr, (boundary, mode, outcome.returncode, outcome.stderr, f.sql('select count(*) from oneshot_private.native_reservation_events'))
            assert f.sql('select count(*) from oneshot_private.native_reservation_events') == '0'
            assert f.sql(f"select status from reservations where id={q(command['id'])}") == 'claim-pending'
            assert f.sql('select count(*) from oneshot_private.active_checkin_tables') == '1'
            f.sql(f"update oneshot_private.staff_memberships set active=true where user_id='{STAFF}';update auth.sessions set not_after=null where id='{f.sessions[STAFF]}'")
            f.checks.append(mode+' during actual '+boundary+' ACK lock wait denies before projection or event mutation')

    before = f.snapshot()
    f.sql(f"set oneshot.secure_gateway_cutover='reviewed';update reservations set status='checked-in',revision=revision+1 where id={q(command['id'])}", error='BOOKING_CHECKIN_CLAIMED')
    f.sql('delete from oneshot_private.active_checkin_tables', error='CHECKIN_RELEASE_REQUIRES_ACCEPTED_COMPLETION')
    assert f.snapshot() == before
    f.sql(f.user()+"update public.tables set status='available'", error='permission denied')
    f.sql(f.user()+"insert into oneshot_private.native_reservation_events(event_id) values(gen_random_uuid())", error='permission denied')
    f.checks.append('neither migration GUC nor authenticated direct DML can forge the projection ledger or release a claim')

    holder = held_table_lock('qa-review-mapping-holder', f"select id from reservations where id={q(command['id'])} for update")
    accept_query = "set application_name='qa-review-ack-wait';" + f.user() + f"select public.oneshot_staff_ack_native_event({q(json.dumps(events['admission']))}::jsonb)"
    pause_query = "set application_name='qa-review-mapping-pause';update oneshot_private.checkin_table_mappings set active=false,coordinator_ready=false"
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        accepting = pool.submit(f.execute, accept_query)
        wait_for_ack_lock()
        pausing = pool.submit(f.execute, pause_query)
        wait_for_ack_lock('qa-review-mapping-pause')
        assert not accepting.done() and not pausing.done()
        accepted = accepting.result(timeout=10)
        paused = pausing.result(timeout=10)
    assert holder.wait(timeout=10) == 0, holder.stderr.read()
    assert accepted.returncode == 0 and paused.returncode == 0, (accepted.stderr, paused.stderr)
    admitted = json.loads(accepted.stdout)
    assert admitted['ack']['state'] == 'checked-in'
    assert f.sql("select active::text||':'||coordinator_ready::text from oneshot_private.checkin_table_mappings") == 'false:false'
    before_pause_denial = f.snapshot()
    f.ack(events['completion'], error='CHECKIN_COORDINATOR_NOT_READY')
    assert f.snapshot() == before_pause_denial
    assert f.ack(events['admission'])['ack'] == admitted['ack']
    f.sql('update oneshot_private.checkin_table_mappings set active=true,coordinator_ready=true')
    f.checks.append('mapping pause waits for an authorized in-flight admission; committed pause denies new completion while exact accepted replay remains recoverable')
    reference_body = copy.deepcopy(json.loads(events['completion']['payload']))
    reference_body['receipt']['payment_method'] = 'gcash'
    reference_body['receipt']['payment_reference'] = 'QA REVIEW-001'
    reference_body['tenderedCents'] = reference_body['collectedNowCents']
    reference_body['changeCents'] = 0
    reference_event = f.resign(events['completion'], reference_body)
    for mode in ['membership-revoked', 'session-expired']:
        holder = held_table_lock('qa-review-reference-'+mode,
            "select pg_advisory_xact_lock(hashtextextended('oneshot-gcash:QAREVIEW001',0))")
        query = "set application_name='qa-review-ack-wait';" + f.user() + f"select public.oneshot_staff_ack_native_event({q(json.dumps(reference_event))}::jsonb)"
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            waiting = pool.submit(f.execute, query)
            wait_for_ack_lock()
            if mode == 'membership-revoked':
                f.sql(f"update oneshot_private.staff_memberships set active=false where user_id='{STAFF}'")
            else:
                f.sql(f"update auth.sessions set not_after=clock_timestamp()+interval '50 milliseconds' where id='{f.sessions[STAFF]}'")
            outcome = waiting.result(timeout=10)
        assert holder.wait(timeout=10) == 0, holder.stderr.read()
        assert outcome.returncode != 0 and 'STAFF_REQUIRED' in outcome.stderr, (mode, outcome.stderr)
        assert f.sql('select count(*) from oneshot_private.native_reservation_events') == '1'
        assert f.sql('select count(*) from oneshot_private.native_final_receipts') == '0'
        assert f.sql(f"select status from reservations where id={q(command['id'])}") == 'checked-in'
        assert f.sql('select count(*) from oneshot_private.active_checkin_tables') == '1'
        f.sql(f"update oneshot_private.staff_memberships set active=true where user_id='{STAFF}';update auth.sessions set not_after=null where id='{f.sessions[STAFF]}'")
        f.checks.append(mode+' during GCash reference advisory lock wait denies before receipt, completion ACK or release')
    completed = f.ack(events['completion'])
    assert admitted['ack']['state'] == 'checked-in' and completed['ack']['state'] == 'completed'
    new_command, new_claim = f.seed(table=command['tableId'])
    before = f.snapshot()
    assert f.ack(events['admission'])['replayed'] is True
    assert f.ack(events['completion'])['replayed'] is True
    assert f.snapshot() == before
    assert f.sql('select claim_id from oneshot_private.active_checkin_tables') == new_claim['claim']['claimId']
    f.checks.append('old admission/completion retries preserve a new active claim reusing the original cloud table')

    today = "timezone('Asia/Manila',clock_timestamp())::date"
    owner = json.loads(f.sql(f.user(CUSTOMER)+f'select public.oneshot_customer_final_receipts({today},{today})'))
    stranger = json.loads(f.sql(f.user(OTHER)+f'select public.oneshot_customer_final_receipts({today},{today})'))
    assert len(owner['receipts']) == 1 and stranger['receipts'] == []
    f.sql(f.user(OTHER)+f'select oneshot_private.final_receipts({today},{today},true)', error='permission denied')
    f.checks.append('receipt owner sees one final receipt; unrelated customer cannot invoke privileged staff=true helper')

    for source in ['staff-checkin.draft.sql','native-device-proof.draft.sql','native-reservation-lifecycle.draft.sql']:
        f.apply(source)
    assert f.snapshot() == before
    f.checks.append('reapplication retains released historical receipts and the newly active claim without pointer reassignment')
    assert source_hashes == {name:hashlib.sha256((SOURCE/name).read_bytes()).hexdigest() for name in reviewed_sources}, 'Source changed during independent verification; rerun against sealed files'
    print(json.dumps({
        'passed':len(f.checks), 'checks':f.checks, 'liveWrites':False,
        'sourceHashes':source_hashes,
        'limits':['Disposable local PostgreSQL and actual native fixture only; no hosted API or device activation.','Key-row SHARE locks deliberately prevent revocation from committing during an already-authorized transaction; membership and session-clock revocation were tested independently.'],
    },indent=2))
