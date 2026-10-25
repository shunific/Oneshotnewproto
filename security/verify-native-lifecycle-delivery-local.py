#!/usr/bin/env python3
"""Actual delivery -> actual authenticated disposable PG; private duplex pipe only."""
import json,os,selectors,subprocess,tempfile
from native_lifecycle_fixture import fixture,SOURCE,CUSTOMER,q

def verify():
 with fixture() as f:
  command,result=f.seed()
  f.apply('staff-checkin.draft.sql')
  f.apply('native-device-proof.draft.sql');f.enroll()
  f.apply('native-reservation-lifecycle.draft.sql')
  node=os.environ.get('ONESHOT_TEST_NODE','/Users/macbookpro/.nvm/versions/node/v22.17.0/bin/node')
  calls=[];accepted={};admission_dropped=False;out=None
  with tempfile.TemporaryFile(mode='w+') as private_errors:
   child=subprocess.Popen([node,str(SOURCE/'native-lifecycle-delivery.fixture.cjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=private_errors,text=True,bufsize=1)
   poll=selectors.DefaultSelector();poll.register(child.stdout,selectors.EVENT_READ)
   def reply(value):child.stdin.write(json.dumps(value,separators=(',',':'))+'\n');child.stdin.flush()
   try:
    reply(dict(command=command,result=result,keyId=f.key_id,keyHex=f.secret.hex()))
    while True:
     if not poll.select(30):raise AssertionError('Private child timed out')
     line=child.stdout.readline()
     if not line:raise AssertionError('Private child exited early')
     message=json.loads(line)
     if message.get('type')=='complete':out=message['result'];break
     assert set(message)=={'type','requestId','envelope'} and message['type']=='ack-request'
     envelope=message['envelope'];calls.append(envelope)
     response=f.ack(envelope)
     event=envelope['eventId']
     if event in accepted:
      assert response['replayed'] is True and response['ack']==accepted[event]['ack']
     else:
      assert response['replayed'] is False;accepted[event]=response
     if envelope['eventType']=='admission' and not admission_dropped:
      admission_dropped=True
      assert f.sql('select count(*) from oneshot_private.native_reservation_events')=='1'
      reply(dict(type='ack-response',requestId=message['requestId'],drop=True))
     else:reply(dict(type='ack-response',requestId=message['requestId'],result=response))
    child.stdin.close();assert child.wait(timeout=10)==0
   finally:
    poll.close()
    if child.poll() is None:child.terminate();child.wait(timeout=10)
    child.stdout.close()
    if not child.stdin.closed:child.stdin.close()
  assert out and out['syntheticOnly'] is True and len(out['checks'])==4
  assert out['network']==out['signing']==out['keys']==4 and len(calls)==4 and len(accepted)==2
  for first,second in [(calls[0],calls[1]),(calls[2],calls[3])]:assert first==second
  assert calls[0]['eventType']=='admission' and calls[2]['eventType']=='reservation-completion'
  assert f.sql('select count(*) from oneshot_private.native_reservation_events')=='2'
  assert f.sql('select count(*) from oneshot_private.native_final_receipts')=='1'
  assert f.sql('select count(*) from public.e_receipts')=='0'
  assert f.sql('select count(*) from oneshot_private.active_checkin_tables')=='0'
  assert f.sql('select status from public.reservations where id='+q(command['id']))=='completed'
  owner=json.loads(f.sql(f.user(CUSTOMER)+"select public.oneshot_customer_final_receipts((now()-interval '1 day')::date,(now()+interval '1 day')::date)"))
  assert owner['recordType']=='owner-linked-final-receipt' and owner['fundsTransferred'] is False
  assert len(owner['receipts'])==1 and owner['receipts'][0]['receiptId']==out['receiptId'] and owner['receipts'][0]['ownerUserId']==CUSTOMER
  return dict(passed=True,checks=out['checks']+['two exact immutable cloud events, one owner-linked private final receipt, completed booking and released cloud pointer verified in real PostgreSQL'],checkCount=5,rpcAttempts=4,uniqueCloudEvents=2,privateOwnerReceipts=1,localReceipts=out['localReceiptCount'],localHistory=out['localHistoryCount'],syntheticOnly=True,hostedWrites=False,osKeyStoreVerified=False,publicRouteActivated=False,packagedModules=bool(os.environ.get('ONESHOT_PROOF_PACKAGE_ARCHIVE')))
if __name__=='__main__':
 try:print(json.dumps(verify(),indent=2))
 except Exception:print(json.dumps(dict(passed=False,error='Synthetic native delivery/local PostgreSQL verification failed; private credentials and source errors omitted.')));raise SystemExit(1)
