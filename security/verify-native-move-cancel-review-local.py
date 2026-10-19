#!/usr/bin/env python3
"""Actual native cancellation and disposable PostgreSQL; synthetic credentials only."""
import concurrent.futures,hashlib,json,os,selectors,subprocess,tempfile,time,uuid
from native_lifecycle_fixture import fixture,SOURCE,PG,DEVICE,MANAGER,q
NAMES=['staff-checkin.draft.sql','native-device-proof.draft.sql','native-reservation-lifecycle.draft.sql','native-reservation-moves.draft.sql','native-reservation-move-cancel.draft.sql']
def verify():
 hashes={n:hashlib.sha256((SOURCE/n).read_bytes()).hexdigest() for n in NAMES};checks=[]
 with fixture() as f:
  command,result=f.seed()
  for name in NAMES[:3]:f.apply(name)
  f.enroll()
  for name in NAMES[3:]:f.apply(name)
  f.sql("insert into system_settings(key_name,setting_value) select key,to_char(timezone('Asia/Manila',clock_timestamp())+case when key like '%StartTime' then interval '-8 hours' else interval '8 hours' end,'HH24:MI') from unnest(array['weekdayStartTime','weekendStartTime','weekdayEndTime','weekendEndTime']) key on conflict(key_name) do update set setting_value=excluded.setting_value")
  for label in ['B','C','D']:
   f.sql(f"insert into public.tables(id,name,status,isactive,\"isActive\") values ('QA-CANCEL-CLOUD-{label}','QA target','{'maintenance' if label=='B' else 'available'}',1,1);insert into oneshot_private.checkin_table_mappings(device_id,native_table_id,cloud_table_id,active,coordinator_ready,approved_by) values ('{DEVICE}','QA-MOVE-{label}','QA-CANCEL-CLOUD-{label}',true,true,'{MANAGER}')")
  def snapshot():
   names=f.sql("select schemaname||'.'||tablename from pg_tables where (schemaname='oneshot_private' and tablename like 'native_%') or (schemaname='oneshot_private' and tablename='active_checkin_tables') or (schemaname='public' and tablename in ('reservations','tables')) order by 1").splitlines()
   return {name:f.sql("select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]')::text) from "+name+' t') for name in names}
  def wait(application,kind):
   for _ in range(150):
    if f.sql('select count(*) from pg_stat_activity where application_name='+q(application)+' and '+("wait_event='PgSleep'" if kind=='sleep' else "wait_event_type='Lock'"))=='1':return
    time.sleep(.01)
   raise AssertionError('Cancellation concurrency barrier not reached')
  def cancel_wins_race(cancel,prepare):
   # Both RPCs run concurrently; cancellation holds coarse authority while
   # waiting on a real reservation row, so late prepare must wait behind it.
   f.sql("update public.tables set status='available' where id='QA-CANCEL-CLOUD-B'")
   worker=subprocess.Popen([str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(f.base),'-p','54409','-U','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   worker.stdin.write("set application_name='qa-cancel-row-holder';begin;select id from public.reservations where id="+q(command['id'])+" for share;select pg_sleep(1.4);commit;");worker.stdin.close();wait('qa-cancel-row-holder','sleep')
   query=lambda event,app:f.user()+'set application_name='+q(app)+';select public.oneshot_staff_ack_native_event('+q(json.dumps(event))+'::jsonb)'
   with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    cancelling=pool.submit(f.execute,query(cancel,'qa-cancel-rpc'));wait('qa-cancel-rpc','lock')
    preparing=pool.submit(f.execute,query(prepare,'qa-cancel-late-prepare'));wait('qa-cancel-late-prepare','lock')
    a=cancelling.result(timeout=10);b=preparing.result(timeout=10)
   assert worker.wait(timeout=10)==0 and a.returncode==0 and b.returncode!=0 and 'NATIVE_MOVE_CANCELLED' in b.stderr
   checks.append('actual concurrent prepare waits behind cancellation row-lock transaction, then permanently denies without restoring target hold')
   return json.loads(a.stdout)
  node=os.environ.get('ONESHOT_TEST_NODE','/Users/macbookpro/.nvm/versions/node/v22.17.0/bin/node');accepted={};calls=[];prepares={};cancel_count=0;out=None
  with tempfile.TemporaryFile(mode='w+') as errors:
   child=subprocess.Popen([node,str(SOURCE/'native-move-cancel-review.fixture.cjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=errors,text=True,bufsize=1)
   poll=selectors.DefaultSelector();poll.register(child.stdout,selectors.EVENT_READ)
   def reply(value):child.stdin.write(json.dumps(value,separators=(',',':'))+'\n');child.stdin.flush()
   try:
    reply(dict(command=command,result=result,keyId=f.key_id,keyHex=f.secret.hex()))
    while True:
     if not poll.select(35):raise AssertionError('Private cancellation bridge timed out')
     line=child.stdout.readline()
     if not line:
      errors.seek(0);raise AssertionError('Private cancellation bridge stopped: '+errors.read())
     message=json.loads(line)
     if message.get('type')=='complete':out=message['result'];break
     assert set(message)=={'type','requestId','envelope'} and message['type']=='ack-request'
     envelope=message['envelope'];body=json.loads(envelope['payload']);calls.append(envelope)
     if envelope['eventType']=='reservation-move-prepare':
      assert body['moveId'] not in prepares,'Cancellation must never retry original prepare'
      prepares[body['moveId']]=envelope
      if body['targetTableId']=='QA-MOVE-B':
       before=snapshot();f.ack(envelope,error='NATIVE_MOVE_TARGET_UNAVAILABLE');assert snapshot()==before
       reply(dict(type='ack-response',requestId=message['requestId'],status=409,code='NATIVE_MOVE_TARGET_UNAVAILABLE'));continue
      permit=f.ack(envelope);accepted[envelope['eventId']]=(envelope,permit)
      if body['targetTableId']=='QA-MOVE-D':
       reply(dict(type='ack-response',requestId=message['requestId'],result=permit));continue
      f.sql(f"insert into public.tables(id,name,status,isactive,\"isActive\") values ('QA-CANCEL-REMAPPED','QA unrelated mapped target','available',1,1);update oneshot_private.checkin_table_mappings set active=false,coordinator_ready=false,cloud_table_id='QA-CANCEL-REMAPPED' where device_id='{DEVICE}' and native_table_id='QA-MOVE-C';insert into closed_dates(id,closed_date,reason,is_full_day,type,status) values ('QA-CANCEL-CLOSURE',timezone('Asia/Manila',clock_timestamp())::date,'QA closure after permit',true,'one-time','active')")
      reply(dict(type='ack-response',requestId=message['requestId'],drop=True));continue
     event=envelope['eventId'];first=event not in accepted
     ack=cancel_wins_race(envelope,prepares[body['moveId']]) if first and envelope['eventType']=='reservation-move-cancel' and body['targetTableId']=='QA-MOVE-B' else f.ack(envelope)
     if first:accepted[event]=(envelope,ack);assert ack['replayed'] is False
     else:assert envelope==accepted[event][0] and ack['replayed'] is True and ack['ack']==accepted[event][1]['ack']
     if envelope['eventType']=='reservation-move-commit' and first:
      original=prepares[body['moveId']];p=json.loads(original['payload']);cancelled=dict(p,eventId=str(uuid.uuid4()),type='reservation-move-cancel',preparePayload=original['payload'],preparePayloadSha256=hashlib.sha256(original['payload'].encode()).hexdigest())
      forged=f.resign(dict(original,eventId=cancelled['eventId'],eventType=cancelled['type']),cancelled)
      before=snapshot();response=f.execute(f.user()+"select public.oneshot_staff_ack_native_event("+q(json.dumps(forged))+"::jsonb)");assert response.returncode!=0;assert snapshot()==before
      checks.append('cancellation against an already committed move is atomically denied before altering its latest position or target occupation')
     if envelope['eventType']=='reservation-move-cancel' and first:
      cancel_count+=1;assert ack['ack']['state']=='move-cancelled';assert ack['ack']['revision']==body['expectedRevision']+2
      assert f.sql("select count(*) from oneshot_private.active_checkin_tables where allocation_kind='move-target'")=='0'
      before=snapshot()
      for name in NAMES:f.apply(name)
      assert snapshot()==before
      original=prepares[body['moveId']]
      if cancel_count==1:
       f.sql("update public.tables set status='available' where id='QA-CANCEL-CLOUD-B'")
       response=f.execute(f.user()+"select public.oneshot_staff_ack_native_event("+q(json.dumps(original))+"::jsonb)")
       assert response.returncode!=0,'Delayed neveraccepted prepare must remain permanently denied'
       other_command,other_claim=f.seed(table='QA-MOVE-B');other_events=f.native(other_command,other_claim);f.ack(other_events['admission'])
       reused=snapshot();assert f.ack(envelope)['ack']==ack['ack'];assert snapshot()==reused
       assert f.sql("select status from public.tables where id='QA-CANCEL-CLOUD-B'")=='occupied'
       checks.append('permanent prepare rejection creates cancellation without fabricated permit; delayed prepare denied and unrelated target reuse survives replay')
      else:
       assert f.ack(original)['ack']==accepted[original['eventId']][1]['ack']
       assert f.sql("select status from public.tables where id='QA-CANCEL-CLOUD-C'")=='available'
       assert f.sql("select status from public.tables where id='QA-CANCEL-REMAPPED'")=='available'
       checks.append('accepted permit cancellation releases exact historical hold after current target mapping remap/disable and closure; accepted prepare replay never restores hold')
      for terminal in ['reservation-move-commit','reservation-move-abort']:
       opposite=dict(json.loads(original['payload']),eventId=str(uuid.uuid4()),type=terminal,expectedRevision=body['expectedRevision']+1)
       signed=f.resign(dict(original,eventId=opposite['eventId'],eventType=terminal),opposite)
       before=snapshot();f.ack(signed,error='NATIVE_MOVE_CANCELLED');assert snapshot()==before
      checks.append('signed commit and legacy abort after cancellation reject atomically; coordinated reapply preserves exact tombstones/events/receipts/allocations')
      reply(dict(type='ack-response',requestId=message['requestId'],drop=True))
     else:reply(dict(type='ack-response',requestId=message['requestId'],result=ack))
    child.stdin.close();assert child.wait(timeout=10)==0
   finally:
    poll.close()
    if child.poll() is None:child.terminate();child.wait(timeout=10)
    child.stdout.close()
    if not child.stdin.closed:child.stdin.close()
  assert out and out['positionSequence']==1 and len(out['checks'])==4 and cancel_count==2
  checks+=out['checks'];assert len([e for e in calls if e['eventType']=='reservation-move-prepare'])==3
  assert f.sql('select status from public.reservations where id='+q(command['id']))=='completed'
  assert f.sql('select count(*) from oneshot_private.native_final_receipts')=='1'
  assert f.sql("select count(*) from oneshot_private.active_checkin_tables where allocation_kind='current'")=='1'
  assert hashes=={n:hashlib.sha256((SOURCE/n).read_bytes()).hexdigest() for n in NAMES},'Reviewed SQL changed during run; rerun after seal'
  return dict(passed=True,checkCount=len(checks),checks=checks,rpcAttempts=len(calls),signedCancellationEvents=cancel_count,sourceHashes=hashes,hostedWrites=False,osKeyStoreVerified=False,publicRouteAccepted=False)
if __name__=='__main__':
 try:print(json.dumps(verify(),indent=2))
 except AssertionError as e:print(json.dumps(dict(passed=False,error='Independent cancellation proof failed',detail=str(e))));raise SystemExit(1)
