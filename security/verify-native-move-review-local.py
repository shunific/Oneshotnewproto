#!/usr/bin/env python3
"""Independent real SQLite/signer/delivery ↔ disposable PG move protocol checks."""
import hashlib,json,os,selectors,subprocess,tempfile,uuid
from native_lifecycle_fixture import fixture,SOURCE,STAFF,DEVICE,MANAGER,CUSTOMER,q

NAMES=['staff-checkin.draft.sql','native-device-proof.draft.sql','native-reservation-lifecycle.draft.sql','native-reservation-moves.draft.sql']
def verify():
 hashes={n:hashlib.sha256((SOURCE/n).read_bytes()).hexdigest() for n in NAMES}
 with fixture() as f:
  command,result=f.seed()
  for name in NAMES[:3]:f.apply(name)
  f.enroll();f.apply(NAMES[3])
  f.sql("insert into system_settings(key_name,setting_value) select key,to_char(timezone('Asia/Manila',clock_timestamp())+case when key like '%StartTime' then interval '-8 hours' else interval '8 hours' end,'HH24:MI') from unnest(array['weekdayStartTime','weekendStartTime','weekdayEndTime','weekendEndTime']) key on conflict(key_name) do update set setting_value=excluded.setting_value")
  for label in ['B','C']:
   f.sql(f"insert into public.tables(id,name,status,isactive,\"isActive\") values ('QA-CLOUD-{label}','QA target','available',1,1);insert into oneshot_private.checkin_table_mappings(device_id,native_table_id,cloud_table_id,active,coordinator_ready,approved_by) values ('{DEVICE}','QA-MOVE-{label}','QA-CLOUD-{label}',true,true,'{MANAGER}')")
  config={'hourlyRate':'150','downPaymentPercent':'0','minHours':'1','maxHours':'24','advanceBookingHours':'0','cancellationHours':'0','weekdayMinPartySize':'1','weekdayMaxPartySize':'10','weekendMinPartySize':'1','weekendMaxPartySize':'10','weekdayOnlineCapacityLimit':'20','weekendOnlineCapacityLimit':'20','bookingCapacityMode':'tables','termsAndConditions':'Synthetic QA terms only'}
  for k,v in config.items():f.sql('insert into system_settings(key_name,setting_value) values('+q(k)+','+q(v)+') on conflict(key_name) do update set setting_value=excluded.setting_value')
  slot=json.loads(f.sql("select jsonb_build_object('date',(timezone('Asia/Manila',clock_timestamp())+interval '2 hours')::date,'timeSlot',to_char(timezone('Asia/Manila',clock_timestamp())+interval '2 hours','HH24:MI'))"))
  def booking(table):return dict(requestId=str(uuid.uuid4()),expectedCustomerId=CUSTOMER,tableId=table,date=slot['date'],timeSlot=slot['timeSlot'],durationHours=1,partySize=2,customerName='QA synthetic held target',contactNumber='09123456789',acceptedTerms=True,expectedTerms=config['termsAndConditions'],expectedTotalCents=15000,expectedDownPaymentCents=0)
  f.sql("insert into public.tables(id,name,status,isactive,\"isActive\") values ('QA-CONTROL','QA control','available',1,1)")
  assert f.rpc('oneshot_booking_create',booking('QA-CONTROL'),CUSTOMER)['reservation']['tableId']=='QA-CONTROL'
  f.sql(f"""insert into public.reservations(id,\"customerName\",\"contactNumber\",email,date,\"timeSlot\",\"durationHours\",\"partySize\",\"tableId\",status,\"downPaymentPaid\",\"balancePaid\",balancepaid,customer_user_id,revision,total_amount_cents,down_payment_amount_cents,discount_amount_cents,\"rescheduleCount\") values ('QA-FUTURE-RESCHEDULE','QA synthetic','09123456789','owner@example.invalid',timezone('Asia/Manila',clock_timestamp())::date+2,'12:00',1,2,'QA-CLOUD-B','pending',0,0,0,'{CUSTOMER}',1,15000,0,0,0)""")
  node=os.environ.get('ONESHOT_TEST_NODE','/Users/macbookpro/.nvm/versions/node/v22.17.0/bin/node')
  seen={};calls=[];out=None;checks=[]
  with tempfile.TemporaryFile(mode='w+') as errors:
   child=subprocess.Popen([node,str(SOURCE/'native-move-review.fixture.cjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=errors,text=True,bufsize=1)
   poll=selectors.DefaultSelector();poll.register(child.stdout,selectors.EVENT_READ)
   def reply(value):child.stdin.write(json.dumps(value,separators=(',',':'))+'\n');child.stdin.flush()
   try:
    reply(dict(command=command,result=result,keyId=f.key_id,keyHex=f.secret.hex()))
    while True:
     if not poll.select(35):raise AssertionError('Independent private native move bridge timed out')
     line=child.stdout.readline()
     if not line:raise AssertionError('Independent private native move bridge stopped')
     message=json.loads(line)
     if message.get('type')=='complete':out=message['result'];break
     assert set(message)=={'type','requestId','envelope'} and message['type']=='ack-request'
     envelope=message['envelope'];body=json.loads(envelope['payload']);calls.append(envelope)
     ack=f.ack(envelope);event=envelope['eventId'];first=event not in seen
     if first:
      assert ack['replayed'] is False;seen[event]=(envelope,ack)
      if envelope['eventType']=='reservation-move-prepare':
       assert f.sql("select count(*) from oneshot_private.active_checkin_tables where allocation_kind='move-target'")=='1'
       cloud=f.sql(f"select cloud_table_id from oneshot_private.checkin_table_mappings where device_id='{DEVICE}' and native_table_id={q(body['targetTableId'])}")
       assert f.sql('select status from public.tables where id='+q(cloud))=='reserved'
       checks.append('actual signed prepare projects reserved target and retains two authoritative cloud allocations')
       if len(checks)==1:
        f.rpc('oneshot_booking_create',booking(cloud),CUSTOMER,error='TABLE_UNAVAILABLE')
        f.rpc('oneshot_booking_reschedule',dict(requestId=str(uuid.uuid4()),expectedCustomerId=CUSTOMER,id='QA-FUTURE-RESCHEDULE',expectedRevision=1,date=slot['date'],timeSlot=slot['timeSlot']),CUSTOMER,error='TABLE_UNAVAILABLE')
        before=f.snapshot()
        for source in NAMES:f.apply(source)
        assert f.snapshot()==before
        assert f.sql("select count(*) from oneshot_private.native_move_operations")=='1'
        checks.append('held target rejects actual verified-customer create and reschedule after populated available control; reapply preserves pending hold')
      if envelope['eventType'] in ['reservation-move-commit','reservation-move-abort']:
       assert f.sql('select count(*) from oneshot_private.active_checkin_tables')=='1'
     else:
      assert envelope==seen[event][0] and ack['replayed'] is True and ack['ack']==seen[event][1]['ack']
     if first and envelope['eventType'].startswith('reservation-move-'):
      reply(dict(type='ack-response',requestId=message['requestId'],drop=True))
     else:reply(dict(type='ack-response',requestId=message['requestId'],result=ack))
    child.stdin.close();assert child.wait(timeout=10)==0
   finally:
    poll.close()
    if child.poll() is None:child.terminate();child.wait(timeout=10)
    child.stdout.close()
    if not child.stdin.closed:child.stdin.close()
  assert out and out['positionSequence']==3 and len(out['checks'])==4
  assert len(seen)==10 and len(calls)==18
  assert f.sql('select count(*) from oneshot_private.active_checkin_tables')=='0'
  assert f.sql('select count(*) from oneshot_private.native_move_operations')=='4'
  assert f.sql('select count(*) from oneshot_private.native_move_terminals')=='4'
  assert f.sql('select count(*) from oneshot_private.native_final_receipts')=='1'
  assert f.sql('select status from public.reservations where id='+q(command['id']))=='completed'
  before=f.snapshot()
  for source in NAMES*2:f.apply(source)
  assert f.snapshot()==before
  checks.append('two complete coordinated SQL reapplications preserve completed booking, final receipt and immutable move events')
  checks+=out['checks']+['ten exact cloud events, four terminal operations and one private final receipt; all eight move events replay identical original ACKs']
  assert hashes=={n:hashlib.sha256((SOURCE/n).read_bytes()).hexdigest() for n in NAMES},'Reviewed SQL changed during run; rerun sealed source'
  return dict(passed=True,checkCount=len(checks),checks=checks,rpcAttempts=len(calls),uniqueCloudEvents=len(seen),sourceHashes=hashes,hostedWrites=False,osKeyStoreVerified=False,publicRouteAccepted=False)
if __name__=='__main__':
 try:print(json.dumps(verify(),indent=2))
 except Exception:print(json.dumps(dict(passed=False,error='Independent synthetic native move/local PostgreSQL verification failed; private source errors omitted.')));raise SystemExit(1)
