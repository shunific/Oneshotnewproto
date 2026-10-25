#!/usr/bin/env python3
"""Independent actual-PG cancellation lock ordering and fresh authority tests; disposable only."""
import concurrent.futures,hashlib,json,subprocess,time,uuid
from native_lifecycle_fixture import fixture,SOURCE,PG,STAFF,DEVICE,MANAGER,q
NAMES=['staff-checkin.draft.sql','native-device-proof.draft.sql','native-reservation-lifecycle.draft.sql','native-reservation-moves.draft.sql','native-reservation-move-cancel.draft.sql']
def verify():
 hashes={n:hashlib.sha256((SOURCE/n).read_bytes()).hexdigest() for n in NAMES};checks=[]
 with fixture() as f:
  c,r=f.seed()
  for name in NAMES[:3]:f.apply(name)
  f.enroll();e=f.native(c,r);admission=f.ack(e['admission']);f.apply(NAMES[3]);f.apply(NAMES[4])
  f.sql("insert into system_settings(key_name,setting_value) select key,to_char(timezone('Asia/Manila',clock_timestamp())+case when key like '%StartTime' then interval '-8 hours' else interval '8 hours' end,'HH24:MI') from unnest(array['weekdayStartTime','weekendStartTime','weekdayEndTime','weekendEndTime']) key on conflict(key_name) do update set setting_value=excluded.setting_value")
  f.sql(f"insert into public.tables(id,name,status,isactive,\"isActive\") values ('QA-LOCK-TARGET','QA target','available',1,1);insert into oneshot_private.checkin_table_mappings(device_id,native_table_id,cloud_table_id,active,coordinator_ready,approved_by) values ('{DEVICE}','QA-LOCK-NATIVE','QA-LOCK-TARGET',true,true,'{MANAGER}')")
  event=str(uuid.uuid4());body=dict(version=1,eventId=event,type='reservation-move-prepare',moveId=str(uuid.uuid4()),prepareEventId=event,claimId=r['claim']['claimId'],reservationId=c['id'],deviceId=DEVICE,claimRequestId=c['requestId'],admissionEventId=admission['ack']['eventId'],sourceTableId=c['tableId'],targetTableId='QA-LOCK-NATIVE',positionSequence=1,previousPositionEventId=admission['ack']['eventId'],expectedRevision=admission['ack']['revision'],localStaffId='qa-independent-lock-review',cloudUserId=STAFF,sessionStartTime=json.loads(e['admission']['payload'])['sessionStartTime'])
  prepare=f.resign(dict(e['admission'],eventId=event,eventType=body['type']),body)
  f.ack(prepare)
  raw=json.dumps(body,ensure_ascii=False,sort_keys=True,separators=(',',':'))
  cancelled=dict(body,eventId=str(uuid.uuid4()),type='reservation-move-cancel',preparePayload=raw,preparePayloadSha256=hashlib.sha256(raw.encode()).hexdigest())
  envelope=f.resign(dict(e['admission'],eventId=cancelled['eventId'],eventType=cancelled['type']),cancelled)
  def wait(application,kind):
   for _ in range(150):
    count=f.sql(f"select count(*) from pg_stat_activity where application_name={q(application)} and "+("wait_event='PgSleep'" if kind=='sleep' else "wait_event_type='Lock'"))
    if count=='1':return
    time.sleep(.01)
   raise AssertionError('Controlled private lock barrier not reached')
  def holder(sql,label):
   worker=subprocess.Popen([str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(f.base),'-p','54409','-U','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   worker.stdin.write(f"set application_name={q(label)};begin;{sql}");worker.stdin.close();wait(label,'sleep');return worker
  query=f.user()+"set application_name='qa-move-lock-ack';begin;select public.oneshot_staff_ack_native_event("+q(json.dumps(envelope))+"::jsonb);rollback;"
  # Opposite order below models the existing booking_command prefix exactly.
  worker=holder('lock table public.system_settings,public.closed_dates,public.events in share row exclusive mode;select pg_sleep(1.4);lock table public.tables,public.reservations in share row exclusive mode;commit;','qa-move-booking-lock')
  with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
   pending=pool.submit(f.execute,query);wait('qa-move-lock-ack','lock');result=pending.result(timeout=12)
  worker.wait(timeout=10);holder_errors=worker.stderr.read();deadlock='deadlock detected' in result.stderr or 'deadlock detected' in holder_errors
  if deadlock:return dict(passed=False,checkCount=0,defect='Actual booking-prefix vs move-prefix deadlock reproduced',sourceHashes=hashes,hostedWrites=False)
  assert result.returncode==0 and worker.returncode==0
  checks.append('move and booking coarse lock prefixes serialize without a lock-order cycle')
  for boundary,lock in [
   ('configuration','lock table public.system_settings in share row exclusive mode'),
   ('reservation-row',f"select id from public.reservations where id={q(c['id'])} for share"),
   ('source-allocation',f"select cloud_table_id from oneshot_private.active_checkin_tables where claim_id='{r['claim']['claimId']}' and allocation_kind='current' for share"),
   ('target-allocation',f"select cloud_table_id from oneshot_private.active_checkin_tables where claim_id='{r['claim']['claimId']}' and allocation_kind='move-target' for share"),
   ('target-row',"select id from public.tables where id='QA-LOCK-TARGET' for share"),
  ]:
   for mode in ['membership','key','session-expiry']:
    worker=holder(lock+';select pg_sleep(1.3);commit;','qa-move-auth-holder')
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
     pending=pool.submit(f.execute,query);wait('qa-move-lock-ack','lock')
     if mode=='membership':f.sql(f"update oneshot_private.staff_memberships set active=false where user_id='{STAFF}'")
     elif mode=='key':
      revoking=pool.submit(f.execute,f"set application_name='qa-move-key-revoke';update oneshot_private.native_device_keys set active=false where key_id='{f.key_id}'");wait('qa-move-key-revoke','lock')
     else:f.sql(f"update auth.sessions set not_after=clock_timestamp()+interval '40 milliseconds' where id='{f.sessions[STAFF]}'")
     result=pending.result(timeout=10)
     if mode=='key':assert revoking.result(timeout=10).returncode==0
    assert worker.wait(timeout=10)==0
    if mode=='key':
     assert result.returncode==0
     f.ack(envelope,error='NATIVE_DEVICE_KEY_REQUIRED')
    else:assert result.returncode!=0 and 'STAFF_REQUIRED' in result.stderr,(boundary,mode,result.returncode,next((line for line in result.stderr.splitlines() if 'ERROR:' in line),'No SQL error'))
    assert f.sql('select count(*) from oneshot_private.native_move_cancellations')=='0'
    assert f.sql('select count(*) from oneshot_private.active_checkin_tables')=='2'
    f.sql(f"update oneshot_private.staff_memberships set active=true where user_id='{STAFF}';update oneshot_private.native_device_keys set active=true where key_id='{f.key_id}';update auth.sessions set not_after=null where id='{f.sessions[STAFF]}'")
    checks.append(('key revocation waits for verified transaction then denies subsequent cancellation at ' if mode=='key' else mode+' revoked during wait denies cancellation before any hold/event write at ')+boundary)
  assert hashes=={n:hashlib.sha256((SOURCE/n).read_bytes()).hexdigest() for n in NAMES},'Reviewed SQL changed during run'
  return dict(passed=True,checkCount=len(checks),checks=checks,sourceHashes=hashes,hostedWrites=False)
if __name__=='__main__':
 try:result=verify();print(json.dumps(result,indent=2));raise SystemExit(0 if result['passed'] else 1)
 except AssertionError as e:print(json.dumps(dict(passed=False,error='Independent disposable move lock review failed',detail=str(e))));raise SystemExit(1)
