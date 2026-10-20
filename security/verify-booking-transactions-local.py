#!/usr/bin/env python3
"""Actual isolated PostgreSQL 17 behavioral tests. Never connects to remote state."""
from pathlib import Path
import concurrent.futures
import datetime as dt
import json
import os
import subprocess
import tempfile
import time
import uuid
PG=Path(os.environ.get('ONESHOT_TEST_PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
OWNER='11111111-1111-1111-1111-111111111111'
OTHER='22222222-2222-2222-2222-222222222222'
UNVERIFIED='33333333-3333-3333-3333-333333333333'
checks=[]
with tempfile.TemporaryDirectory(prefix='oneshot-booking-') as directory:
 base=Path(directory)
 subprocess.run([str(PG/'initdb'),'-D',str(base/'db'),'-A','trust','-U','postgres','--no-locale'],check=True,stdout=subprocess.DEVNULL)
 with (base/'postgres.log').open('w') as log:
  server=subprocess.Popen([str(PG/'postgres'),'-D',str(base/'db'),'-k',str(base),'-p','54394','-h',''],stdout=log,stderr=log)
  try:
   for _ in range(100):
    if subprocess.run([str(PG/'pg_isready'),'-h',str(base),'-p','54394'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0: break
    time.sleep(.05)
   def sql(query,error=None):
    result=subprocess.run([str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(base),'-p','54394','-U','postgres'],input=query,text=True,capture_output=True)
    if error is not None:
     assert result.returncode!=0 and error in result.stderr,(error,result.stderr,result.stdout)
     checks.append(error)
     return None
    assert result.returncode==0,(result.stderr,result.stdout)
    return result.stdout.strip()
   sql("""
create role anon; create role authenticated; create schema auth; create schema storage;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false,banned_until timestamptz,deleted_at timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to public; grant execute on function auth.uid() to public;
create table storage.objects(bucket_id text,name text,owner_id text);
create table public.system_settings(key_name text primary key,setting_value text);
create table public.tables(id text primary key,name text,status text,isactive integer,"isActive" integer,sessiondata text,"sessionData" text);
create table public.closed_dates(id text primary key,closed_date date,reason text,is_full_day boolean,open_time text,close_time text,type text,day_of_week integer,status text,cancelled_at timestamptz);
create table public.events(id text primary key,date date,iscancelled integer,status text,cancelled_at timestamptz,allowreservations integer);
create table public.promo_codes(id text primary key,code text,discount_percent real,is_active boolean,is_limited_uses boolean,max_usage integer,usage_count integer,start_date timestamptz,expires_at timestamptz);
create table public.reservations(id text primary key,"customerName" text,"contactNumber" text,email text,date date,"timeSlot" text,"durationHours" integer,"partySize" integer,"tableId" text,status text,"totalAmount" real,"downPaymentAmount" real,"downPaymentPaid" integer,balancepaid integer,"balancePaid" integer,promocode text,"promoCode" text,"discountAmount" real,cancellationreason text,cancellation_reason text,"createdAt" timestamptz,"refundStatus" text,"refundMethod" text,"refundNotes" text,"receiptImg" text,"paymentRef" text,"rescheduleCount" integer);
grant all on public.reservations to anon,authenticated;
""")
   draft=Path(__file__).with_name('booking-transactions.draft.sql').read_text()
   sql(draft,'reviewed coordinated gateway cutover required')
   identity=Path(__file__).with_name('customer-identity.draft.sql').read_text()
   sql("set oneshot.secure_gateway_cutover='reviewed';\n"+identity)
   sql("set oneshot.secure_gateway_cutover='reviewed';\n"+draft)
   config={'hourlyRate':'150','downPaymentPercent':'20','minHours':'1','maxHours':'24','advanceBookingHours':'1','cancellationHours':'12','weekdayStartTime':'12:00','weekdayEndTime':'01:00','weekendStartTime':'12:00','weekendEndTime':'01:00','weekdayMinPartySize':'1','weekdayMaxPartySize':'10','weekendMinPartySize':'1','weekendMaxPartySize':'10','weekdayOnlineCapacityLimit':'6','weekendOnlineCapacityLimit':'6','bookingCapacityMode':'tables','termsAndConditions':'QA terms'}
   for k,v in config.items(): sql("insert into system_settings values ('%s','%s')"%(k,v))
   sql(f"insert into auth.users(id,email,email_confirmed_at,is_anonymous) values ('{OWNER}','owner@example.invalid',now(),false),('{OTHER}','other@example.invalid',now(),false),('{UNVERIFIED}','unverified@example.invalid',null,false);")
   session_ids={uid:str(uuid.uuid4()) for uid in [OWNER,OTHER,UNVERIFIED]}
   for uid,sid in session_ids.items(): sql(f"insert into auth.sessions values ('{sid}','{uid}',null)")
   sql("insert into tables values ('A','A','available',1,1,null,null),('B','B','available',1,1,null,null),('C','C','available',1,1,null,null);")
   future=(dt.date.today()+dt.timedelta(days=30)).isoformat()
   receipt_counter=0
   def payload(table='A',time_slot='14:00',date=future,owner=OWNER,**kwargs):
    path=f'{owner}/{uuid.uuid4()}.jpg'
    sql(f"insert into storage.objects values ('oneshot-receipts','{path}','{owner}')")
    return dict(requestId=str(uuid.uuid4()),tableId=table,date=date,timeSlot=time_slot,durationHours=2,partySize=2,customerName='QA Customer',contactNumber='09123456789',paymentRef='QA-UNPAID-EVIDENCE',receiptPath=path,acceptedTerms=True,expectedTerms='QA terms',expectedTotalCents=30000,expectedDownPaymentCents=6000,**kwargs)
   def call(op,p,owner=OWNER,error=None,role='authenticated'):
    p=dict(p,expectedCustomerId=p.get('expectedCustomerId',owner))
    body=json.dumps(p).replace("'","''")
    out=sql(f"set role {role};set request.jwt.claim.sub='{owner}';set request.jwt.claims='{json.dumps({'session_id':session_ids[owner]})}';select public.oneshot_booking_{op}('{body}'::jsonb);",error)
    return json.loads(out) if out else None
   p=payload(); saved=call('create',p)
   assert saved['reservation']['customer_user_id']==OWNER and saved['reservation']['email']=='owner@example.invalid'
   assert saved['reservation']['downPaymentPaid']==0 and saved['reservation']['balancePaid']==0
   assert call('create',p)['replayed'] is True
   call('create',dict(p,customerName='Changed'),error='IDEMPOTENCY_CONFLICT')
   # A once-valid bearer must not replay a committed command after its authority ends.
   for field in ('banned_until','deleted_at'):
    sql(f"update auth.users set {field}=now()+interval '1 day' where id='{OWNER}'")
    call('create',p,error='VERIFIED_ACCOUNT_REQUIRED')
    sql(f"update auth.users set {field}=null where id='{OWNER}'")
   sql(f"update auth.sessions set not_after=now()-interval '1 second' where id='{session_ids[OWNER]}'")
   call('create',p,error='VERIFIED_ACCOUNT_REQUIRED')
   sql(f"delete from auth.sessions where id='{session_ids[OWNER]}'")
   call('create',p,error='VERIFIED_ACCOUNT_REQUIRED')
   sql(f"insert into auth.sessions values ('{session_ids[OWNER]}','{OWNER}',null)")
   old_sid=session_ids[OWNER];session_ids[OWNER]=str(uuid.uuid4())
   call('create',p,error='VERIFIED_ACCOUNT_REQUIRED')
   session_ids[OWNER]=old_sid
   raw=json.dumps(dict(p,expectedCustomerId=OWNER)).replace("'","''")
   sql(f"set role authenticated;set request.jwt.claim.sub='{OWNER}';select oneshot_booking_create('{raw}'::jsonb)",'VERIFIED_ACCOUNT_REQUIRED')

   call('create',payload('B'),owner=UNVERIFIED,error='VERIFIED_ACCOUNT_REQUIRED')
   call('create',payload('B'),role='anon',error='permission denied')
   call('create',dict(payload('B'),totalAmount=0),error='INVALID_FIELDS')
   call('create',dict(payload('B'),expectedTotalCents=1),error='QUOTE_CHANGED')
   call('create',dict(payload('B'),expectedTerms='changed'),error='TERMS_CHANGED')
   call('create',dict(payload('B'),receiptPath=p['receiptPath']),owner=OTHER,error='RECEIPT_NOT_OWNED')
   call('create',dict(payload('B'),receiptPath=p['receiptPath']),error='RECEIPT_ALREADY_USED')
   sql("set role authenticated;insert into reservations(id) values ('forged')",'permission denied')
   rid=saved['reservation']['id']
   change=dict(requestId=str(uuid.uuid4()),id=rid,expectedRevision=1,date=future,timeSlot='17:00')
   call('reschedule',change,owner=OTHER,error='BOOKING_NOT_FOUND')
   moved=call('reschedule',change); assert moved['reservation']['revision']==2 and moved['reservation']['totalAmount']==300
   call('reschedule',dict(change,requestId=str(uuid.uuid4())),error='STALE_REVISION')
   call('reschedule',dict(change,requestId=str(uuid.uuid4()),expectedRevision=2,timeSlot='20:00'),error='RESCHEDULE_LIMIT')
   cancel=dict(requestId=str(uuid.uuid4()),id=rid,expectedRevision=2,reason='QA cancel')
   cancelled=call('cancel',cancel); assert cancelled['reservation']['status']=='cancelled' and cancelled['reservation']['refundStatus'] is None
   assert call('cancel',cancel)['replayed']
   # NULL status and malformed owned legacy schedules cannot bypass transition guards.
   corrupt=call('create',payload('B',time_slot='20:00'))['reservation']
   sql(f"update reservations set status=null where id='{corrupt['id']}'")
   bad_change=dict(requestId=str(uuid.uuid4()),id=corrupt['id'],expectedRevision=1,date=future,timeSlot='21:00')
   call('reschedule',bad_change,error='RESCHEDULE_STATE_NOT_ALLOWED')
   call('cancel',dict(requestId=str(uuid.uuid4()),id=corrupt['id'],expectedRevision=1),error='CANCELLATION_STATE_NOT_ALLOWED')
   sql(f"update reservations set status='pending',date=null where id='{corrupt['id']}'")
   call('cancel',dict(requestId=str(uuid.uuid4()),id=corrupt['id'],expectedRevision=1),error='BOOKING_RECONCILIATION_REQUIRED')
   sql(f"delete from reservations where id='{corrupt['id']}'")
   # Legacy null ownership cannot be claimed by matching email.
   sql(f"insert into reservations(id,email,date,\"timeSlot\",status,revision) values ('LEGACY','owner@example.invalid','{future}','14:00','pending',1)")
   call('cancel',dict(cancel,requestId=str(uuid.uuid4()),id='LEGACY',expectedRevision=1),error='BOOKING_NOT_FOUND')
   sql("delete from reservations where id='LEGACY'")
   # Actual concurrent connections contend for same slot; exactly one commit.
   concurrent_payloads=[payload('A'),payload('A',owner=OTHER)]
   def contender(pair):
    q,uid=pair
    try: return call('create',q,owner=uid)
    except AssertionError as e:
     assert 'TABLE_CONFLICT' in str(e),str(e)
     return None
   with concurrent.futures.ThreadPoolExecutor(2) as pool:
    outcomes=list(pool.map(contender,zip(concurrent_payloads,[OWNER,OTHER])))
   assert sum(x is not None for x in outcomes)==1
   checks.append('concurrent overlap exactly one commit')
   sql("insert into promo_codes values ('LAST','LAST',50,true,true,1,0,null,null)")
   bad_quote=payload('B',promoCode='LAST'); bad_quote.update(expectedTotalCents=1,expectedDownPaymentCents=1)
   call('create',bad_quote,error='QUOTE_CHANGED')
   assert sql("select usage_count from promo_codes where id='LAST'")=='0'
   promos=[payload('B',promoCode='LAST'),payload('C',owner=OTHER,promoCode='LAST')]
   for q in promos: q.update(expectedTotalCents=15000,expectedDownPaymentCents=3000)
   def promo_contender(pair):
    q,uid=pair
    try: return call('create',q,owner=uid)
    except AssertionError as e:
     assert 'PROMO_UNAVAILABLE' in str(e),str(e)
     return None
   with concurrent.futures.ThreadPoolExecutor(2) as pool:
    outcomes=list(pool.map(promo_contender,zip(promos,[OWNER,OTHER])))
   assert sum(x is not None for x in outcomes)==1 and sql("select usage_count from promo_codes where id='LAST'")=='1'
   checks.append('concurrent last promo exactly once')
   nextday=(dt.date.fromisoformat(future)+dt.timedelta(days=1)).isoformat()
   sql(f"insert into closed_dates values ('FULL','{nextday}','QA',true,null,null,'specific',null,null,null)")
   call('create',payload('A',date=nextday),error='CLOSED_DATE')
   sql("update closed_dates set is_full_day=false,open_time='16:00',close_time='23:00'")
   call('create',payload('A',date=nextday),error='PARTIAL_CLOSURE')
   call('create',payload('A',date=nextday,time_slot='17:00'))
   sql("delete from closed_dates")
   sql(f"insert into events values ('EVENT','{nextday}',0,'active',null,1)")
   call('create',payload('B',date=nextday),error='EVENT_ALLOCATION_REQUIRED')
   sql("delete from events;update tables set status='occupied' where id='B'")
   call('create',payload('B',date=nextday),error='TABLE_UNAVAILABLE')
   sql("update tables set status='available',\"sessionData\"='{}' where id='B'")
   overnight=payload('B',date=nextday,time_slot='00:00'); overnight.update(durationHours=1,expectedTotalCents=15000,expectedDownPaymentCents=3000); call('create',overnight)
   call('create',payload('C',date=nextday,time_slot='00:30'),error='OUTSIDE_OPERATING_HOURS')
   sql("update system_settings set setting_value='' where key_name='termsAndConditions'")
   call('create',payload('C',date=nextday),error='CONFIG_TERMS_REQUIRED')
   sql("update system_settings set setting_value='QA terms' where key_name='termsAndConditions'")
   # Verified payment state creates a pending refund, never marks money returned.
   paid=call('create',payload('C',date=nextday))['reservation']
   sql(f"update reservations set \"downPaymentPaid\"=1 where id='{paid['id']}'")
   refund=call('cancel',dict(requestId=str(uuid.uuid4()),id=paid['id'],expectedRevision=1))
   assert refund['reservation']['status']=='pending-refund' and refund['reservation']['refundStatus']=='pending'
   checks.append('paid cancellation pending refund only')
   call('create',dict(payload('C',date=nextday),expectedCustomerId=OTHER),error='ACCOUNT_CHANGED')
   sql("insert into reservations(id,status) values ('BAD-ACTIVE','pending')")
   call('create',payload('C',date=nextday),error='ACTIVE_BOOKINGS_RECONCILIATION_REQUIRED')
   sql("delete from reservations where id='BAD-ACTIVE'; update system_settings set setting_value='0' where key_name in ('weekdayOnlineCapacityLimit','weekendOnlineCapacityLimit')")
   call('create',payload('C',date=nextday),error='ONLINE_CAPACITY')
   sql("update system_settings set setting_value='6' where key_name in ('weekdayOnlineCapacityLimit','weekendOnlineCapacityLimit')")
   sql(f"insert into closed_dates values ('WEEKLY',null,'QA',true,null,null,'weekly',extract(dow from '{nextday}'::date),null,null)")
   call('create',payload('C',date=nextday),error='CLOSED_DATE')
   sql("delete from closed_dates; update tables set \"sessionData\"='broken session' where id='C'")
   call('create',payload('C',date=nextday),error='ACTIVE_SESSION')
   sql("update tables set \"sessionData\"=null where id='C'")
   # Reference-only and receipt-only are evidence submissions, never payment confirmation.
   reference=payload('C',date=nextday); reference.pop('receiptPath'); call('create',reference)
   receipt_only=payload('C',date=nextday,time_slot='17:00'); receipt_only.pop('paymentRef'); call('create',receipt_only)
   no_evidence=payload('C',date=nextday,time_slot='20:00'); no_evidence.pop('paymentRef'); no_evidence.pop('receiptPath'); call('create',no_evidence,error='PAYMENT_EVIDENCE_REQUIRED')
   sql("update tables set isactive=0 where id='C'")
   call('create',payload('C',date=nextday,time_slot='20:00'),error='TABLE_UNAVAILABLE')
   sql("update tables set isactive=1 where id='C';insert into promo_codes values ('DUP','last',50,true,true,10,0,null,null)")
   duplicate=payload('A',date=nextday,promoCode='LAST'); duplicate.update(expectedTotalCents=15000,expectedDownPaymentCents=3000)
   call('create',duplicate,error='PROMO_UNAVAILABLE')
   sql("delete from promo_codes where id='DUP'")
   # Confirmed paid reservations retain price/payment state while moving once before cutoff.
   confirmed=call('create',payload('A',date=nextday))['reservation']
   sql(f"update reservations set status='confirmed',\"downPaymentPaid\"=1 where id='{confirmed['id']}'")
   paid_moved=call('reschedule',dict(requestId=str(uuid.uuid4()),id=confirmed['id'],expectedRevision=1,date=nextday,timeSlot='20:00'))['reservation']
   assert paid_moved['status']=='confirmed' and paid_moved['downPaymentPaid']==1 and paid_moved['totalAmount']==300 and paid_moved['revision']==2
   checks.append('paid confirmed reschedule retains price and payment flags')
   same=payload('C',date=nextday,time_slot='20:00')
   before=int(sql('select count(*) from reservations'))
   with concurrent.futures.ThreadPoolExecutor(2) as pool:
    repeats=list(pool.map(lambda _:call('create',same),range(2)))
   assert repeats[0]['reservation']['id']==repeats[1]['reservation']['id'] and sum(x['replayed'] for x in repeats)==1
   assert int(sql('select count(*) from reservations'))==before+1
   checks.append('concurrent same request one commit and one replay')
   # REAL float32 compatibility columns lose cents at large totals; canonical ledger and ack do not.
   highday=(dt.date.fromisoformat(nextday)+dt.timedelta(days=1)).isoformat()
   sql("update system_settings set setting_value='99999.99' where key_name='hourlyRate'")
   high=payload('A',date=highday,time_slot='12:00');high.update(durationHours=12,expectedTotalCents=119999988,expectedDownPaymentCents=24000000)
   exact=call('create',high)['reservation']
   assert exact['total_amount_cents']==119999988 and exact['down_payment_amount_cents']==24000000 and exact['discount_amount_cents']==0
   assert str(exact['totalAmount'])=='1199999.88' and exact['downPaymentAmount']==240000
   assert sql(f"select total_amount_cents::text||','||down_payment_amount_cents::text||','||discount_amount_cents::text from reservations where id='{exact['id']}'")=='119999988,24000000,0'
   assert sql(f"select (\"totalAmount\"::numeric*100)::text from reservations where id='{exact['id']}'")!='119999988'
   assert call('create',high)['reservation']['totalAmount']==exact['totalAmount']
   checks.append('large fractional money stored and replayed in exact canonical cents despite REAL rounding')
   sql(f"update reservations set total_amount_cents=null where id='{exact['id']}'")
   call('cancel',dict(requestId=str(uuid.uuid4()),id=exact['id'],expectedRevision=1),error='BOOKING_FINANCIAL_RECONCILIATION_REQUIRED')
   sql("update system_settings set setting_value='150' where key_name='hourlyRate'")
   # Whole-peso down-payment rounding must never collect more than the complete bill.
   sql("update system_settings set setting_value='0.01' where key_name='hourlyRate'")
   penny=payload('B',date=highday,time_slot='14:00');penny.update(durationHours=1,expectedTotalCents=1,expectedDownPaymentCents=1)
   penny_saved=call('create',penny)['reservation']
   assert penny_saved['total_amount_cents']==1 and penny_saved['down_payment_amount_cents']==1
   assert penny_saved['totalAmount']==0.01 and penny_saved['downPaymentAmount']==0.01
   checks.append('one-cent bill caps rounded down payment at one cent')
   sql("update system_settings set setting_value='150' where key_name='hourlyRate'")
   # Capacity counts peak simultaneous use, not every row touching a long slot.
   peakday=(dt.date.fromisoformat(highday)+dt.timedelta(days=3)).isoformat()
   sql("update system_settings set setting_value='2' where key_name in ('weekdayOnlineCapacityLimit','weekendOnlineCapacityLimit')")
   call('create',payload('A',date=peakday,time_slot='14:00'))
   call('create',payload('A',date=peakday,time_slot='16:00'))
   bridge=payload('C',date=peakday,time_slot='14:00');bridge.update(durationHours=4,expectedTotalCents=60000,expectedDownPaymentCents=12000)
   bridged=call('create',bridge)['reservation']
   call('create',payload('B',date=peakday,time_slot='17:00'),error='ONLINE_CAPACITY')
   call('reschedule',dict(requestId=str(uuid.uuid4()),id=bridged['id'],expectedRevision=1,date=peakday,timeSlot='15:00'))
   call('create',payload('B',date=peakday,time_slot='18:00'))
   checks.append('peak simultaneous capacity permits adjacent bookings, rejects nested overload, excludes rescheduled self')
   nightday=(dt.date.fromisoformat(peakday)+dt.timedelta(days=5)).isoformat()
   aftermidnight=(dt.date.fromisoformat(nightday)+dt.timedelta(days=1)).isoformat()
   for date,slot in [(nightday,'23:00'),(aftermidnight,'00:00')]:
    adjacent=payload('A',date=date,time_slot=slot);adjacent.update(durationHours=1,expectedTotalCents=15000,expectedDownPaymentCents=3000)
    call('create',adjacent)
   call('create',payload('C',date=nightday,time_slot='23:00'))
   checks.append('midnight adjacent bookings count one simultaneous occupancy over a two-hour bridge')
   capday=(dt.date.fromisoformat(peakday)+dt.timedelta(days=1)).isoformat()
   sql("update system_settings set setting_value='1' where key_name in ('weekdayOnlineCapacityLimit','weekendOnlineCapacityLimit')")
   def capacity_contender(pair):
    q,uid=pair
    try:return call('create',q,owner=uid)
    except AssertionError as e:
     assert 'ONLINE_CAPACITY' in str(e),str(e)
     return None
   with concurrent.futures.ThreadPoolExecutor(2) as pool:
    capped=list(pool.map(capacity_contender,[(payload('A',date=capday),OWNER),(payload('B',date=capday,owner=OTHER),OTHER)]))
   assert sum(x is not None for x in capped)==1
   checks.append('concurrent different-table last-capacity requests exactly one commit')
   sql("update system_settings set setting_value='6' where key_name in ('weekdayOnlineCapacityLimit','weekendOnlineCapacityLimit')")
   guardday=(dt.date.fromisoformat(capday)+dt.timedelta(days=1)).isoformat()
   sql("update tables set status=null where id='C'")
   call('create',payload('C',date=guardday),error='TABLE_UNAVAILABLE')
   sql("update tables set status='available' where id='C'")
   for field in ['isactive','"isActive"']:
    sql(f"update tables set {field}=null where id='C'")
    call('create',payload('C',date=guardday),error='TABLE_UNAVAILABLE')
    sql(f"update tables set {field}=1 where id='C'")
   for invalid_capacity in ['NaN','Infinity','-Infinity','1.5','9007199254740992','']:
    sql("update system_settings set setting_value='%s' where key_name in ('weekdayOnlineCapacityLimit','weekendOnlineCapacityLimit')"%invalid_capacity)
    call('create',payload('C',date=guardday),error='CONFIG_INVALID')
   sql("update system_settings set setting_value='6.0' where key_name in ('weekdayOnlineCapacityLimit','weekendOnlineCapacityLimit')")
   for minimum,maximum in [(None,'10'),('1',None),('0','10'),('2','1'),('1.5','10'),('1','2.5')]:
    for prefix in ['weekday','weekend']:
     sql("delete from system_settings where key_name in ('%sMinPartySize','%sMaxPartySize')"%(prefix,prefix))
     for suffix,value in [('MinPartySize',minimum),('MaxPartySize',maximum)]:
      if value is not None:sql("insert into system_settings values ('%s%s','%s')"%(prefix,suffix,value))
    call('create',payload('C',date=guardday),error='CONFIG_INVALID')
   for prefix in ['weekday','weekend']:
    sql("delete from system_settings where key_name in ('%sMinPartySize','%sMaxPartySize');insert into system_settings values ('%sMinPartySize','1'),('%sMaxPartySize','10')"%(prefix,prefix,prefix,prefix))
   for prefix in ['weekday','weekend']:
    sql("update system_settings set setting_value='1.0' where key_name='%sMinPartySize';update system_settings set setting_value='10.0' where key_name='%sMaxPartySize'"%(prefix,prefix))
   call('create',payload('C',date=guardday,time_slot='20:00'))
   checks.append('safe integer decimal table capacity and party bounds retain count meaning')
   empty_party=payload('C',date=guardday);empty_party['partySize']=0
   call('create',empty_party,error='INVALID_PARTY_OR_DURATION')
   sql("delete from system_settings where key_name='bookingCapacityMode'")
   call('create',payload('C',date=nextday,time_slot='22:00'),error='CONFIG_CAPACITY_REVIEW_REQUIRED')
   checks.extend(['saved verified owner and email','payment flags remain zero','identical create replays','reschedule revision increments preserves total','unpaid cancellation has no refund','cancellation replay','overnight previous operating day accepted','reference-only and receipt-only evidence accepted'])
   print(json.dumps({'passed':len(checks),'checks':checks,'engine':sql('select version()'),'liveWrites':False,'limits':['Fixture mirrors booking-related live columns only; not full production data replay.','Capacity unit and event allocation require operator review before cutover.','No staff gateway or payment-provider verification asserted.']},indent=2))
  finally:
   server.terminate()
   server.wait(timeout=10)
