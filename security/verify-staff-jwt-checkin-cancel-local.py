#!/usr/bin/env python3
"""Original prepared request cancellation: disposable PG races/rollback only."""
import concurrent.futures,json,uuid,hashlib,time
from staff_jwt_lifecycle_fixture import fixture,SOURCE,STAFF,MANAGER,CUSTOMER,DEVICE,q
names=['staff-checkin.draft.sql','native-staff-authorization.draft.sql']
with fixture()as f:
 for name in names:f.apply(name)
 def command():
  f.counter+=1;n=f.counter;cloud='CANCEL-CLOUD-'+str(n);local='CANCEL-LOCAL-'+str(n);rid='QA-CANCEL-'+str(n)
  f.sql(f"insert into tables(id,name,status,isactive,\"isActive\")values('{cloud}','QA table','available',1,1);insert into oneshot_private.checkin_table_mappings(device_id,native_table_id,cloud_table_id,active,coordinator_ready,approved_by)values('{DEVICE}','{local}','{cloud}',true,true,'{MANAGER}')")
  f.sql(f'''insert into reservations(id,"customerName","contactNumber",email,date,"timeSlot","durationHours","partySize","tableId",status,"downPaymentPaid","balancePaid",balancepaid,customer_user_id,revision,total_amount_cents,down_payment_amount_cents,discount_amount_cents)values('{rid}','QA cancellation','09123456789','owner@example.invalid',timezone('Asia/Manila',now())::date,'14:00',2,2,'{cloud}','pending',0,0,0,'{CUSTOMER}',1,20000,0,0)''')
  f.rpc('oneshot_staff_approve_booking',dict(requestId=str(uuid.uuid4()),id=rid,expectedRevision=1,expectedStaffId=STAFF,expectedTotalCents=20000,expectedDownPaymentCents=0))
  return dict(requestId=str(uuid.uuid4()),id=rid,expectedRevision=2,expectedStaffId=STAFF,deviceId=DEVICE,tableId=local)
 cancel=lambda p,user=STAFF,error=None:f.rpc('oneshot_staff_cancel_checkin_request',p,user,error)
 c=command();cancelled_original=dict(c);a=cancel(c);assert a==dict(requestId=c['requestId'],reservationId=c['id'],deviceId=DEVICE,tableId=c['tableId'],cancelled=True,replayed=False,recordType='reservation-check-in-cancellation',fundsTransferred=False)
 before=f.snapshot();assert cancel(c)['replayed']is True;assert f.snapshot()==before;f.rpc('oneshot_staff_claim_checkin',c,error='CHECKIN_REQUEST_CANCELLED');assert f.snapshot()==before
 cancel(dict(c,expectedRevision=3),error='IDEMPOTENCY_CONFLICT');assert f.snapshot()==before
 cancel(c,MANAGER,error='ACCOUNT_CHANGED');cancel(dict(c,expectedStaffId=CUSTOMER),CUSTOMER,error='STAFF_REQUIRED');assert f.snapshot()==before
 f.checks.append('exact no-claim cancellation tombstone blocks delayed original claim; replay/mismatch/crossedactor/customer guards preserve state')
 claimed=command();claim=f.rpc('oneshot_staff_claim_checkin',claimed);before=f.snapshot();recovered=cancel(claimed);assert recovered['claim']==claim['claim']and recovered['recordType']=='reservation-check-in-claim'and recovered['replayed']is True;assert f.snapshot()==before
 assert f.sql('select count(*)from oneshot_private.active_checkin_tables')=='1';f.checks.append('already-claimed cancel returns original claim for recovery without releasing occupancy or money')
 for _ in range(5):
  c=command()
  def send(which):return f.execute(f.user()+f"select public.oneshot_staff_{which}({q(json.dumps(c))}::jsonb)")
  with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:rs=list(pool.map(send,['claim_checkin','cancel_checkin_request']))
  cancelled=json.loads(rs[1].stdout);assert rs[1].returncode==0
  if cancelled['recordType']=='reservation-check-in-cancellation':assert rs[0].returncode!=0 and'CHECKIN_REQUEST_CANCELLED'in rs[0].stderr
  else:assert rs[0].returncode==0 and cancelled['claim']==json.loads(rs[0].stdout)['claim']
  assert f.sql(f"select count(*)from oneshot_private.checkin_operations where actor_user_id='{STAFF}'and request_id='{c['requestId']}'")=='1'
 f.checks.append('five actual competing claim/cancel transactions yield exactly one original ledger outcome; no late claim after tombstone')
 c=command();f.sql("create function oneshot_private.qa_cancel_fail()returns trigger language plpgsql as $$begin raise exception 'QA_CANCEL_LATE_FAILURE';end$$;create trigger qa_cancel_fail before insert on oneshot_private.checkin_operations for each row execute function oneshot_private.qa_cancel_fail()")
 before=f.snapshot();cancel(c,error='QA_CANCEL_LATE_FAILURE');assert f.snapshot()==before;f.sql('drop trigger qa_cancel_fail on oneshot_private.checkin_operations;drop function oneshot_private.qa_cancel_fail()');assert cancel(c)['cancelled']is True;f.checks.append('late tombstone write failure rolls back completely and same original cancellation retries successfully')
 for mode in ['membership','session']:
  c=command()
  if mode=='membership':f.sql(f"update oneshot_private.staff_memberships set active=false where user_id='{STAFF}'")
  else:f.sql(f"update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id='{f.sessions[STAFF]}'")
  cancel(c,error='STAFF_REQUIRED')
  f.sql(f"update oneshot_private.staff_memberships set active=true where user_id='{STAFF}';update auth.sessions set not_after=null where id='{f.sessions[STAFF]}'")
 f.checks.append('revoked membership and expired current session deny cancellation before mutation')
 for kind in ['claim_checkin','cancel_checkin_request']:
  c=command()
  with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:
   holder=pool.submit(f.execute,"set application_name='qa-cancel-holder';begin;lock table public.tables,public.reservations in share row exclusive mode;select pg_sleep(1.1);commit;")
   for _ in range(200):
    if f.sql("select count(*)from pg_stat_activity where application_name='qa-cancel-holder'and wait_event='PgSleep'")=='1':break
    time.sleep(.01)
   else:raise AssertionError('Holder not reached')
   pending=pool.submit(f.execute,f.user()+"set application_name='qa-cancel-waiter';select public.oneshot_staff_"+kind+"("+q(json.dumps(c))+"::jsonb)")
   for _ in range(200):
    if f.sql("select count(*)from pg_stat_activity where application_name='qa-cancel-waiter'and wait_event_type='Lock'")=='1':break
    time.sleep(.01)
   else:raise AssertionError('Waiter not reached')
   f.sql(f"update auth.sessions set not_after=clock_timestamp()+interval'50 milliseconds'where id='{f.sessions[STAFF]}'")
   result=pending.result(timeout=10);assert holder.result(timeout=10).returncode==0
  assert result.returncode!=0 and 'STAFF_REQUIRED'in result.stderr
  assert f.sql(f"select count(*)from oneshot_private.checkin_operations where actor_user_id='{STAFF}'and request_id='{c['requestId']}'")=='0'
  f.sql(f"update auth.sessions set not_after=null where id='{f.sessions[STAFF]}'")
 f.checks.append('claim and cancel both recheck current session clock after controlled shared claim lock wait; expired JWT cannot commit a late outcome')
 before=f.snapshot()
 for name in names*2:f.apply(name)
 assert f.snapshot()==before
 f.rpc('oneshot_staff_claim_checkin',cancelled_original,error='CHECKIN_REQUEST_CANCELLED')
 f.checks.append('two claim/authorization reapplications preserve cancellation tombstones and delayed original claims remain denied')
 print(json.dumps({'passed':len(f.checks),'checks':f.checks,'liveWrites':False,'sourceHashes':{n:hashlib.sha256((SOURCE/n).read_bytes()).hexdigest()for n in names}},indent=2))
