#!/usr/bin/env python3
"""Real native outboxes -> disposable PG lifecycle, never hosted state/activation."""
import concurrent.futures,copy,datetime,hashlib,json,os,uuid
from staff_jwt_lifecycle_fixture import fixture,SOURCE,STAFF,MANAGER,CUSTOMER,OTHER,DEVICE,q
with fixture() as f:
 command,result=f.seed()
 old_query="select jsonb_build_object('claims',(select jsonb_agg(to_jsonb(c)) from oneshot_private.checkin_claims c),'operations',(select jsonb_agg(to_jsonb(o)) from oneshot_private.checkin_operations o),'payments',(select jsonb_agg(to_jsonb(p)) from oneshot_private.staff_payment_verifications p))"
 old=f.sql(old_query)
 # Unknown v1 index shape is rejected before dropping that historical index.
 f.sql("drop index oneshot_private.checkin_pending_table_unique;create unique index checkin_pending_table_unique on oneshot_private.checkin_claims(cloud_table_id) where state='claim-pending'")
 f.apply('staff-checkin.draft.sql',error='INCOMPATIBLE_CHECKIN_SCHEMA')
 assert f.sql(old_query)==old and f.sql("select to_regclass('oneshot_private.active_checkin_tables') is null")=='t'
 f.sql("drop index oneshot_private.checkin_pending_table_unique;create unique index checkin_pending_table_unique on oneshot_private.checkin_claims(cloud_table_id)")
 f.apply('staff-checkin.draft.sql')
 assert f.sql("select count(*) from oneshot_private.active_checkin_tables")=='1'
 assert f.sql("select count(*) from oneshot_private.checkin_active_registry_upgrades")=='1'
 assert f.sql("select to_regclass('oneshot_private.checkin_pending_table_unique') is null")=='t' and f.sql(old_query)==old
 f.checks.append('known v1 rows survive one-time pointer upgrade; unknown old index rejected before destructive index change')
 f.apply('native-staff-authorization.draft.sql')
 draft=(SOURCE/'native-reservation-lifecycle.draft.sql').read_text()
 f.sql(draft,error='reviewed coordinated gateway cutover required');f.apply('native-reservation-lifecycle.draft.sql')
 envelopes=f.native(command,result)
 before=f.snapshot();f.ack(envelopes['completion'],error='NATIVE_LIFECYCLE_ADMISSION_ACK_REQUIRED');assert f.snapshot()==before
 for column in ['active','coordinator_ready']:
  f.sql(f"update oneshot_private.checkin_table_mappings set {column}=false where device_id='{DEVICE}' and native_table_id={q(command['tableId'])}")
  before=f.snapshot();f.ack(envelopes['admission'],error='CHECKIN_COORDINATOR_NOT_READY');assert f.snapshot()==before
  f.sql(f"update oneshot_private.checkin_table_mappings set {column}=true where device_id='{DEVICE}' and native_table_id={q(command['tableId'])}")
 f.checks.append('committed mapping deactivation and readiness pause deny new acceptance with no event or projection')
 old_admission=json.loads(envelopes['admission']['payload']);del old_admission['overtimeRateCents']
 before=f.snapshot();f.ack(f.resign(envelopes['admission'],old_admission),error='NATIVE_LIFECYCLE_INVALID_FIELDS');assert f.snapshot()==before
 f.checks.append('pre-lifecycle admission without immutable overtime snapshot is preserved and rejected without projection')
 admitted=f.ack(envelopes['admission'])
 assert admitted['ack']['state']=='checked-in' and admitted['ack']['revision']==4 and admitted['ack']['receiptId'] is None
 assert f.sql("select count(*) from oneshot_private.active_checkin_tables")=='1'
 assert f.sql("select status from public.tables where id='CLOUD-1'")=='occupied'
 before=f.snapshot();assert f.ack(envelopes['admission'])['replayed'] is True and f.snapshot()==before
 # A newly submitted staff message is not financial authorization: independently
 # recomputed quote, orders, time, payment and identity all remain mandatory.
 original=json.loads(envelopes['completion']['payload'])
 mutations=[
  (lambda b:b['receipt'].__setitem__('owner_user_id',OTHER),'NATIVE_COMPLETION_RECEIPT_BINDING'),
  (lambda b:b['receipt'].__setitem__('reservation_id','other-booking'),'NATIVE_COMPLETION_RECEIPT_BINDING'),
  (lambda b:b['receipt'].__setitem__('booking_discount_amount',0),'NATIVE_COMPLETION_FINANCIAL_MISMATCH'),
  (lambda b:b['receipt'].__setitem__('total_amount',-1),'NATIVE_LIFECYCLE_INVALID_MONEY'),
  (lambda b:b['receipt'].__setitem__('total_amount','226'),'NATIVE_LIFECYCLE_INVALID_MONEY'),
  (lambda b:b['receipt'].__setitem__('total_amount',226.001),'NATIVE_LIFECYCLE_INVALID_MONEY'),
  (lambda b:b['amounts'].__setitem__('totalCents',1.5),'NATIVE_LIFECYCLE_INVALID_CENTS'),
  (lambda b:b.__setitem__('collectedNowCents',1),'NATIVE_COMPLETION_FINANCIAL_MISMATCH'),
  (lambda b:b.__setitem__('changeCents',1),'NATIVE_COMPLETION_FINANCIAL_MISMATCH'),
  (lambda b:b.__setitem__('priorPaymentCents',0),'NATIVE_COMPLETION_FINANCIAL_MISMATCH'),
  (lambda b:b.__setitem__('refundDueCents',1),'NATIVE_COMPLETION_FINANCIAL_MISMATCH'),
  (lambda b:b['history']['orders'][0].__setitem__('qty',2),'NATIVE_COMPLETION_PAYMENT_STATE_MISMATCH'),
  (lambda b:b['history']['orders'][0].__setitem__('qty',0),'NATIVE_COMPLETION_INVALID_ORDERS'),
  (lambda b:b['history']['orders'][0].__setitem__('qty',9007199254740991),'NATIVE_COMPLETION_INVALID_ORDERS'),
  (lambda b:b['receipt'].__setitem__('overtime_rate',150),'NATIVE_COMPLETION_RATE_MISMATCH'),
  (lambda b:b['receipt'].__setitem__('overtime_minutes',1),'NATIVE_COMPLETION_RATE_MISMATCH'),
  (lambda b:b['receipt'].__setitem__('payment_status','unpaid'),'NATIVE_COMPLETION_PAYMENT_STATE_MISMATCH'),
  (lambda b:b['receipt'].__setitem__('refund_status','returned'),'NATIVE_COMPLETION_PAYMENT_STATE_MISMATCH'),
  (lambda b:b['history'].__setitem__('amountPaid',0),'NATIVE_COMPLETION_HISTORY_MISMATCH'),
  (lambda b:b.__setitem__('admissionEventId',str(uuid.uuid4())),'NATIVE_COMPLETION_ADMISSION_MISMATCH'),
  (lambda b:b.__setitem__('checkoutTableId','other-local-table'),'NATIVE_COMPLETION_RECEIPT_BINDING'),
  (lambda b:b['receipt'].__setitem__('play_end_time','9999-12-31T00:00:00.000Z'),'NATIVE_COMPLETION_TIME_MISMATCH'),
  (lambda b:b['receipt'].__setitem__('extra','caller-value'),'NATIVE_LIFECYCLE_INVALID_FIELDS'),
 ]
 for mutate,error in mutations:
  body=copy.deepcopy(original);mutate(body);before=f.snapshot();f.ack(f.resign(envelopes['completion'],body),error=error);assert f.snapshot()==before
 f.checks.append('newly valid staff-authorized events cannot override exact receipt/owner/quote/items/time/cents/payment equations')
 # A late receipt failure or a late table-pointer release failure must roll back
 # accepted event, receipt, booking, projection and active pointer together.
 for target in ['oneshot_private.native_final_receipts','oneshot_private.active_checkin_tables']:
  operation='insert' if target.endswith('native_final_receipts') else 'delete'
  f.sql(f"create function oneshot_private.qa_lifecycle_late_fail() returns trigger language plpgsql as $$begin raise exception 'QA_LIFECYCLE_LATE_FAILURE';end$$;create trigger qa_lifecycle_fail before {operation} on {target} for each row execute function oneshot_private.qa_lifecycle_late_fail()")
  before=f.snapshot();f.ack(envelopes['completion'],error='QA_LIFECYCLE_LATE_FAILURE');assert f.snapshot()==before
  f.sql(f"drop trigger qa_lifecycle_fail on {target};drop function oneshot_private.qa_lifecycle_late_fail()")
 f.checks.append('late receipt and final pointer-release failures roll back the complete cross-projection transaction')
 closed=f.ack(envelopes['completion'])
 assert closed['ack']['state']=='completed' and closed['ack']['revision']==5 and closed['ack']['receiptId']==original['receipt']['id']
 assert f.sql("select count(*) from oneshot_private.active_checkin_tables")=='0' and f.sql("select count(*) from oneshot_private.native_final_receipts")=='1'
 assert f.sql("select count(*) from public.e_receipts")=='0'
 assert f.sql("select status||':'||\"balancePaid\"||':'||balancepaid from reservations where id='QA-LIFECYCLE-1'")=='completed:1:1'
 assert f.sql("select sum(amount_cents) from oneshot_private.staff_payment_verifications where reservation_id='QA-LIFECYCLE-1'")=='4020'
 summary=json.loads(f.sql("select oneshot_private.staff_reservation_json(r) from reservations r where id='QA-LIFECYCLE-1'"))
 assert summary['paymentSummary']==dict(verifiedPaidCents=4020,remainingCents=0)
 assert summary['settlement']['nativeCollectedNowCents']==18580 and summary['settlement']['grandTotalCents']==22600 and summary['settlement']['remainingCents']==0
 f.checks.append('actual native paid receipt releases original cloud table while preserving original payment ledger and separate grand-bill collection')
 def receipts(user=CUSTOMER,staff=False,error=None):
  name='oneshot_staff_final_receipts' if staff else 'oneshot_customer_final_receipts'
  out=f.sql(f.user(user)+f"select public.{name}(timezone('Asia/Manila',now())::date,timezone('Asia/Manila',now())::date)",error)
  return json.loads(out) if out else None
 assert len(receipts()['receipts'])==1 and receipts(OTHER)['receipts']==[] and len(receipts(MANAGER,staff=True)['receipts'])==1
 receipts(OTHER,staff=True,error='STAFF_REQUIRED')
 f.sql(f.user(role='anon')+"select public.oneshot_customer_final_receipts(current_date,current_date)",error='permission denied')
 for table in ['native_reservation_events','native_final_receipts','active_checkin_tables','checkin_active_registry_upgrades']:
  for operation in [f'select * from oneshot_private.{table}',f'delete from oneshot_private.{table}']:
   f.sql(f.user()+operation,error='permission denied')
 f.sql("update oneshot_private.native_final_receipts set owner_customer_id='44444444-4444-4444-8444-444444444444'",error='CHECKIN_AUDIT_IMMUTABLE')
 f.sql("delete from oneshot_private.native_reservation_events",error='CHECKIN_AUDIT_IMMUTABLE')
 f.sql("delete from oneshot_private.checkin_active_registry_upgrades",error='CHECKIN_AUDIT_IMMUTABLE')
 f.sql("update reservations set \"totalAmount\"=0 where id='QA-LIFECYCLE-1'",error='BOOKING_CHECKIN_CLAIMED')
 f.checks.append('verified customer owner-only final receipt access; unrelated customer and raw private-table mutations denied')
 before=f.snapshot();replayed=f.ack(f.resign(envelopes['completion'],actor=MANAGER),MANAGER)
 assert replayed['replayed'] is True and replayed['ack']==closed['ack'] and f.snapshot()==before
 body=copy.deepcopy(original);body['changeCents']+=1
 f.ack(f.resign(envelopes['completion'],body),error='NATIVE_EVENT_IDEMPOTENCY_CONFLICT')
 f.sql(f"update oneshot_private.staff_memberships set active=false where user_id='{STAFF}'")
 f.ack(envelopes['completion'],error='STAFF_REQUIRED')
 f.sql(f"update oneshot_private.staff_memberships set active=true where user_id='{STAFF}'")
 f.sql(f"update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id='{f.sessions[STAFF]}'")
 f.ack(envelopes['completion'],error='STAFF_REQUIRED')
 f.sql(f"update auth.sessions set not_after=null where id='{f.sessions[STAFF]}'")
 f.checks.append('exact replay preserves first acceptance, rejects changed content and rechecks current staff membership and session expiry')
 # A released physical table can serve a NEW booking. Old admission/completion
 # retries must never overwrite its new claim, projection or billing status.
 command2,result2=f.seed(table=command['tableId']);events2=f.native(command2,result2)
 f.ack(events2['admission']);before=f.snapshot()
 assert f.ack(envelopes['admission'])['replayed'] is True and f.ack(envelopes['completion'])['replayed'] is True and f.snapshot()==before
 assert f.sql("select count(*) from oneshot_private.checkin_claims where cloud_table_id='CLOUD-1'")=='2'
 f.checks.append('new reservation reuses released physical table while old immutable claim/replays cannot clear the new occupation')
 # Do not overwrite an unrelated/cloud-owner-changed occupation marker.
 marker=f.sql("select sessiondata from public.tables where id='CLOUD-1'")
 f.sql("update public.tables set sessiondata='unrelated occupation',\"sessionData\"='unrelated occupation' where id='CLOUD-1'")
 before=f.snapshot();f.ack(events2['completion'],error='NATIVE_LIFECYCLE_TABLE_MISMATCH');assert f.snapshot()==before
 f.sql(f"update public.tables set sessiondata={q(marker)},\"sessionData\"={q(marker)} where id='CLOUD-1'")
 def raw_ack(event,user=STAFF):return f.execute(f.user(user)+f"select public.oneshot_staff_ack_native_event({q(json.dumps(event))}::jsonb)")
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:raced=list(pool.map(lambda _:raw_ack(events2['completion']),range(4)))
 assert all(r.returncode==0 for r in raced) and sum(not json.loads(r.stdout)['replayed'] for r in raced)==1
 f.checks.append('four concurrent same-event completions produce one receipt and three immutable ACK replays')
 # Different completion UUIDs for the same claim cannot settle it twice.
 c3,r3=f.seed();e3=f.native(c3,r3);f.ack(e3['admission'])
 alternate=copy.deepcopy(json.loads(e3['completion']['payload']));alternate['eventId']=str(uuid.uuid4());other_event=f.resign(e3['completion'],alternate,event_id=alternate['eventId'])
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:raced=list(pool.map(raw_ack,[e3['completion'],other_event]))
 assert sorted(r.returncode==0 for r in raced)==[False,True]
 f.checks.append('competing different completion events for one claim create exactly one accepted settlement')
 # Actual native partial/walkout/void records retain honest remaining/refund state.
 for mode in ['partial','walkout','unpaid','void']:
  c,r=f.seed();e=f.native(c,r,mode);f.ack(e['admission']);body=json.loads(e['completion']['payload'])
  if mode=='void':
   before=f.snapshot();f.ack(e['completion'],error='CLOUD_MANAGER_REQUIRED');assert f.snapshot()==before
   accepted=f.ack(f.resign(e['completion'],actor=MANAGER),MANAGER)
   f.ack(e['completion'],error='CLOUD_MANAGER_REQUIRED')
  else:accepted=f.ack(e['completion'])
  row=json.loads(f.sql(f"select to_jsonb(r) from reservations r where id={q(c['id'])}"))
  final=json.loads(f.sql(f"select settlement from oneshot_private.native_final_receipts where reservation_id={q(c['id'])}"))
  assert accepted['ack']['state']=='completed' and row['balancePaid']==0
  assert final['remainingCents']==body['amounts']['balanceCents'] and final['refundDueCents']==body['refundDueCents']
  if mode=='void':assert final['refundDueCents']==4020 and row['refundStatus']=='pending' and final['nativeCollectedNowCents']==0
  if mode=='partial':assert final['nativeCollectedNowCents']==100 and final['remainingCents']==18480
  if mode in ['walkout','unpaid']:assert final['nativeCollectedNowCents']==0 and final['remainingCents']==18580
 f.checks.append('actual native partial/unpaid/walkout preserve unallocated debt; only cloud manager accepts void with refund pending and no fictional return')
 c,r=f.seed();e=f.native(c,r,checkout_request_id='X'*128);f.ack(e['admission']);f.ack(e['completion'])
 f.checks.append('actual native maximum 128-character checkout id remains compatible with cloud lifecycle')
 # Independent elapsed-time/rounding oracle uses a real native receipt as the
 # template, then verifies SQL finance without relying on wall-clock day/slot.
 c_ot,r_ot=f.seed();e_ot=f.native(c_ot,r_ot)
 a_ot=json.loads(e_ot['admission']['payload']);b_ot=json.loads(e_ot['completion']['payload'])
 end=datetime.datetime.fromisoformat(b_ot['receipt']['play_end_time'].replace('Z','+00:00'))
 start=(end-datetime.timedelta(minutes=122,seconds=1)).isoformat(timespec='milliseconds').replace('+00:00','Z')
 a_ot['sessionStartTime']=start;b_ot['sessionStartTime']=start
 b_ot['receipt'].update(play_start_time=start,duration_minutes=123,overtime_minutes=3,overtime_charge=15,original_amount=241,subtotal=341.01,total_amount=241,amount_paid=241)
 b_ot['history'].update(startTime=start,durationMinutes=123,totalAmount=241,amountPaid=241,status='completed_overtime')
 b_ot['amounts'].update(overtimeCents=1500,totalCents=24100,allocatedPaidCents=24100)
 b_ot.update(collectedNowCents=20080,tenderedCents=20080)
 def validate_ot(body,error=None):
  return f.sql('select oneshot_private.validate_native_completion('+q(json.dumps(body))+ '::jsonb,'+q(json.dumps(r_ot['claim']))+'::jsonb,'+q(json.dumps(a_ot))+'::jsonb)',error)
 oracle=json.loads(validate_ot(b_ot));assert oracle['grandTotalCents']==24100 and oracle['nativeCollectedNowCents']==20080 and oracle['remainingCents']==0
 for key,value in [('overtime_minutes',2),('overtime_rate',150),('overtime_charge',14.99)]:
  hostile=copy.deepcopy(b_ot);hostile['receipt'][key]=value
  validate_ot(hostile,'NATIVE_COMPLETION_RATE_MISMATCH' if key!='overtime_charge' else 'NATIVE_COMPLETION_FINANCIAL_MISMATCH')
 f.checks.append('independent SQL finance oracle:122m1s becomes123 elapsed/3 overtime minutes at stored300PHP per hour =1500cents; changed rate/minutes/charge rejected')

 c,r=f.seed(net=0,deposit=0,discount=30000);e=f.native(c,r);f.ack(e['admission']);f.ack(e['completion'])
 assert f.sql(f"select \"balancePaid\"||':'||\"downPaymentPaid\" from reservations where id={q(c['id'])}")=='0:0'
 f.checks.append('zero-net booking retains zero original payment flags while its separate food bill can be fully settled')
 # Global normalized GCash references cannot be double-counted across the old
 # verification ledger and the new final settlement receipts in either direction.
 f.sql("insert into reservations(id) values ('QA-REFERENCE-ONLY')")
 f.sql(f"insert into oneshot_private.staff_payment_verifications(reservation_id,payment_kind,amount_cents,method,reference,actor_user_id,actor_role,actor_email) values ('QA-REFERENCE-ONLY','deposit',1,'gcash','QA-OLD 123','{STAFF}','cashier','qa@example.invalid')")
 def gcash(event,reference):
  body=json.loads(event['payload']);body['receipt']['payment_method']='gcash';body['receipt']['payment_reference']=reference;return f.resign(event,body)
 c,r=f.seed();e=f.native(c,r);f.ack(e['admission']);before=f.snapshot()
 f.ack(gcash(e['completion'],'qa old-123'),error='REFERENCE_ALREADY_RECORDED');assert f.snapshot()==before
 f.ack(gcash(e['completion'],'QA NEW-456'))
 f.sql("insert into reservations(id) values ('QA-REFERENCE-REUSE')")
 f.sql(f"insert into oneshot_private.staff_payment_verifications(reservation_id,payment_kind,amount_cents,method,reference,actor_user_id,actor_role,actor_email) values ('QA-REFERENCE-REUSE','deposit',1,'gcash','qa-new456','{STAFF}','cashier','qa@example.invalid')",error='REFERENCE_ALREADY_RECORDED')
 cash_events=[]
 for _ in range(2):
  c,r=f.seed();e=f.native(c,r);f.ack(e['admission']);cash_events.append(gcash(e['completion'],'QA SAME-789'))
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:raced=list(pool.map(raw_ack,cash_events))
 assert sorted(r.returncode==0 for r in raced)==[False,True] and any('REFERENCE_ALREADY_RECORDED' in r.stderr for r in raced)
 f.checks.append('normalized GCash reference reuse rejected across old/new ledgers and competing new settlements')
 before=f.snapshot()
 for name in ['staff-checkin.draft.sql','native-staff-authorization.draft.sql','native-reservation-lifecycle.draft.sql']*2:f.apply(name)
 assert f.snapshot()==before and f.ack(envelopes['completion'])['ack']==closed['ack']
 assert f.sql("select count(*) from oneshot_private.active_checkin_tables a join oneshot_private.native_final_receipts r on r.claim_id=a.claim_id")=='0'
 f.checks.append('two complete claim/staff/lifecycle reapplications preserve 15 exact table snapshots and never reclaim completed audit rows')
 for mutation in [
  'alter table oneshot_private.native_reservation_events alter payload drop not null',
  'alter table oneshot_private.native_final_receipts drop constraint native_final_receipts_owner_customer_id_fkey',
  'grant select(receipt) on oneshot_private.native_final_receipts to authenticated',
  'alter table oneshot_private.native_reservation_events drop constraint native_reservation_events_claim_id_event_type_key',
  'alter table oneshot_private.native_final_receipts alter booking_fully_covered drop not null',
 ]:
  f.sql("begin;"+mutation+";set oneshot.secure_gateway_cutover='reviewed';"+draft,error='INCOMPATIBLE_NATIVE_LIFECYCLE_');assert f.snapshot()==before
 f.checks.append('five weak existing lifecycle schemas/column ACL variants rejected atomically with all rows preserved')
 print(json.dumps(dict(passed=len(f.checks),checks=f.checks,liveWrites=False,sourceHashes={n:hashlib.sha256((SOURCE/n).read_bytes()).hexdigest() for n in ['fixtures/staff-checkin-v1.fixture.sql','staff-checkin.draft.sql','native-staff-authorization.draft.sql','native-reservation-lifecycle.draft.sql']},engine=f.sql('select version()'),ackAdmission=admitted,ackCompletion=closed,limits=['Actual native source coordinator/order/checkout/staff-JWT envelope plus isolated PostgreSQL only; no hosted API, deployment or keystore activation.','Coordinator readiness remains owner-disabled by default; no live enrollment or cutover bundle changed.','Cloud completion releases original mapped table only; move projection is verified separately by focused move/cancel tests.','No money transfer/refund return performed; partial grand-bill allocation remains explicit unknown; final receipt records canonical debt/refund-pending truth.','Old pre-lifecycle admission outboxes without immutable overtime rate require reconciliation; no silent rewrite.']),indent=2))
