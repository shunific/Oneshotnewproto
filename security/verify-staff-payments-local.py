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
with tempfile.TemporaryDirectory(prefix='oneshot-staff-payments-') as directory:
 base=Path(directory)
 subprocess.run([str(PG/'initdb'),'-D',str(base/'db'),'-A','trust','-U','postgres','--no-locale','--encoding=UTF8'],check=True,stdout=subprocess.DEVNULL)
 with (base/'postgres.log').open('w') as log:
  server=subprocess.Popen([str(PG/'postgres'),'-D',str(base/'db'),'-k',str(base),'-p','54396','-h',''],stdout=log,stderr=log)
  try:
   for _ in range(100):
    if subprocess.run([str(PG/'pg_isready'),'-h',str(base),'-p','54396'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0: break
    time.sleep(.05)
   def sql(query,error=None):
    result=subprocess.run([str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(base),'-p','54396','-U','postgres'],input=query,text=True,capture_output=True)
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
create table storage.objects(bucket_id text,name text,owner_id text,metadata jsonb,primary key(bucket_id,name));
alter table storage.objects enable row level security;
grant usage on schema storage to anon,authenticated;
grant select,insert,update,delete on storage.objects to anon,authenticated;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
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
    sql(f"insert into storage.objects(bucket_id,name,owner_id) values ('oneshot-receipts','{path}','{owner}')")
    return dict(requestId=str(uuid.uuid4()),tableId=table,date=date,timeSlot=time_slot,durationHours=2,partySize=2,customerName='QA Customer',contactNumber='09123456789',paymentRef='QA-UNPAID-EVIDENCE',receiptPath=path,acceptedTerms=True,expectedTerms='QA terms',expectedTotalCents=30000,expectedDownPaymentCents=6000,**kwargs)
   def call(op,p,owner=OWNER,error=None,role='authenticated'):
    p=dict(p,expectedCustomerId=p.get('expectedCustomerId',owner))
    body=json.dumps(p).replace("'","''")
    out=sql(f"set role {role};set request.jwt.claim.sub='{owner}';set request.jwt.claims='{json.dumps({'session_id':session_ids[owner]})}';select public.oneshot_booking_{op}('{body}'::jsonb);",error)
    return json.loads(out) if out else None
   receipts=Path(__file__).with_name('private-receipts.draft.sql').read_text()
   sql("set oneshot.private_receipts_cutover='reviewed';\n"+receipts)
   staff_identity=Path(__file__).with_name('staff-identity.draft.sql').read_text()
   sql("set oneshot.secure_gateway_cutover='reviewed';\n"+staff_identity)
   # Prior local RC had a payment-only operation ledger, with no operation column.
   sql("create table oneshot_private.staff_payment_operations(actor_user_id uuid not null references auth.users(id),request_id uuid not null,payload jsonb not null,result jsonb not null,created_at timestamptz not null default now(),primary key(actor_user_id,request_id))")
   prior_request=str(uuid.uuid4())
   sql(f"insert into oneshot_private.staff_payment_operations(actor_user_id,request_id,payload,result) values ('{OWNER}','{prior_request}','{{\"priorPayment\":true}}','{{\"retained\":true}}')")
   payments=Path(__file__).with_name('staff-payments.draft.sql').read_text()
   sql(payments,'reviewed coordinated gateway cutover required')
   sql("set oneshot.secure_gateway_cutover='reviewed';\n"+payments)
   assert sql(f"select operation||':'||(result->>'retained') from oneshot_private.staff_payment_operations where request_id='{prior_request}'")=='payment:true'
   checks.append('prior payment-only ledger gains operation column without losing payload/result')
   MANAGER='44444444-4444-4444-4444-444444444444'
   session_ids[MANAGER]=str(uuid.uuid4())
   sql(f"insert into auth.users(id,email,email_confirmed_at,is_anonymous) values ('{MANAGER}','manager@example.invalid',now(),false);insert into auth.sessions values ('{session_ids[MANAGER]}','{MANAGER}',null)")
   sql(f"insert into oneshot_private.staff_memberships(user_id,role,active,approved_by) values ('{OTHER}','cashier',true,'{MANAGER}'),('{MANAGER}','manager',true,'{MANAGER}')")
   def as_user(uid):return f"set role authenticated;set request.jwt.claim.sub='{uid}';set request.jwt.claims='{json.dumps({'session_id':session_ids[uid]})}';"
   def payment(p,uid=OTHER,error=None):
    p=dict(p,expectedStaffId=p.get('expectedStaffId',uid));body=json.dumps(p).replace("'","''")
    out=sql(as_user(uid)+f"select oneshot_staff_confirm_payment('{body}'::jsonb)",error)
    return json.loads(out) if out else None
   def verification(r,kind='deposit',amount=6000):return dict(requestId=str(uuid.uuid4()),id=r['id'],expectedRevision=r['revision'],paymentKind=kind,method='cash',expectedAmountCents=amount)
   def booking(table='A',slot='14:00'):return call('create',payload(table,time_slot=slot))['reservation']
   r=booking();p=verification(r)
   payment(p,uid=OWNER,error='STAFF_REQUIRED')
   sql(as_user(OWNER)+"set request.jwt.claims='{"+ '\"session_id\":\"'+session_ids[OWNER]+'\",\"user_metadata\":{\"role\":\"manager\"}}' +"';select oneshot_staff_reservations(current_date,current_date+30)",'STAFF_REQUIRED')
   sql(as_user(OTHER)+f"update oneshot_private.staff_memberships set role='manager' where user_id='{OTHER}'",'permission denied')
   payment(dict(p,totalAmount=1),error='INVALID_FIELDS')
   payment(dict(p,expectedAmountCents=1),error='PAYMENT_AMOUNT_CHANGED')
   payment(dict(p,method='gcash'),error='INVALID_PAYMENT')
   paid=payment(p)
   assert paid['verification']['actorUserId']==OTHER and paid['verification']['actorRole']=='cashier'
   assert paid['verification']['recordType']=='external-payment-verification' and paid['verification']['fundsTransferred'] is False
   assert paid['reservation']['downPaymentPaid']==1 and paid['reservation']['balancePaid']==0 and paid['reservation']['status']=='confirmed'
   assert paid['reservation']['customer_user_id']==OWNER and paid['reservation']['paymentSummary']['verifiedPaidCents']==6000
   assert payment(p)['replayed']
   payment(dict(p,reference='changed'),error='IDEMPOTENCY_CONFLICT')
   payment(dict(p,requestId=str(uuid.uuid4())),error='STALE_REVISION')
   payment(dict(p,requestId=str(uuid.uuid4()),expectedRevision=2),error='PAYMENT_ALREADY_VERIFIED')
   balance=verification(paid['reservation'],'balance',24000);balance.update(method='gcash',reference='QA-EXTERNAL-REFERENCE')
   final=payment(balance,uid=MANAGER)
   assert final['reservation']['balancePaid']==1 and final['reservation']['balancepaid']==1 and final['reservation']['paymentSummary']['remainingCents']==0
   payment(dict(balance,requestId=str(uuid.uuid4()),expectedRevision=3),uid=MANAGER,error='PAYMENT_ALREADY_VERIFIED')
   sql(f"update oneshot_private.staff_memberships set active=false where user_id='{OTHER}'")
   payment(p,error='STAFF_REQUIRED')
   sql(f"update oneshot_private.staff_memberships set active=true where user_id='{OTHER}';delete from auth.sessions where id='{session_ids[OTHER]}'")
   payment(p,error='STAFF_REQUIRED')
   sql(f"insert into auth.sessions values ('{session_ids[OTHER]}','{OTHER}',null)")
   # Full balance first records the full canonical bill; a later deposit must not overcharge.
   full=booking('B');paid_full=payment(verification(full,'balance',30000))
   assert paid_full['reservation']['downPaymentPaid']==1 and paid_full['reservation']['balancePaid']==1
   payment(verification(paid_full['reservation'],'deposit',6000),error='NO_PAYMENT_DUE')
   # Legacy paid flags without the immutable ledger require reconciliation.
   legacy=booking('C');sql(f"update reservations set \"downPaymentPaid\"=1 where id='{legacy['id']}'")
   payment(verification(legacy),error='PAYMENT_LEDGER_RECONCILIATION_REQUIRED')
   sql(f"update reservations set \"downPaymentPaid\"=0,total_amount_cents=null where id='{legacy['id']}'")
   payment(verification(legacy),error='BOOKING_FINANCIAL_RECONCILIATION_REQUIRED')
   sql(f"update reservations set total_amount_cents=30000,status='cancelled' where id='{legacy['id']}'")
   payment(verification(legacy),error='PAYMENT_STATE_NOT_ALLOWED')
   for invalid_status in ['pending-refund','completed',None]:
    status_sql="null" if invalid_status is None else "'"+invalid_status+"'"
    sql(f"update reservations set status={status_sql} where id='{legacy['id']}'")
    payment(verification(legacy),error='PAYMENT_STATE_NOT_ALLOWED')
   payment(dict(p,expectedStaffId=MANAGER),error='ACCOUNT_CHANGED')
   sql(f"update auth.sessions set not_after=now()-interval '1 second' where id='{session_ids[OTHER]}'")
   payment(p,error='STAFF_REQUIRED')
   sql(f"update auth.sessions set not_after=null where id='{session_ids[OTHER]}'")
   # Concurrent staff confirmations cannot double-record a payment.
   concurrent_r=booking('A','18:00');first=verification(concurrent_r);second=verification(concurrent_r)
   def contender(x):
    try:return payment(x)
    except AssertionError as e:
     assert 'STALE_REVISION' in str(e),str(e)
     return None
   with concurrent.futures.ThreadPoolExecutor(2) as pool:outcomes=list(pool.map(contender,[first,second]))
   assert sum(x is not None for x in outcomes)==1
   assert sql(f"select count(*) from oneshot_private.staff_payment_verifications where reservation_id='{concurrent_r['id']}'")=='1'
   same_r=booking('B','18:00');same=verification(same_r)
   with concurrent.futures.ThreadPoolExecutor(2) as pool:replays=list(pool.map(lambda _:payment(same),range(2)))
   assert sum(x['replayed'] for x in replays)==1 and replays[0]['verification']['id']==replays[1]['verification']['id']
   # One external transfer reference cannot be counted for separate bookings or kinds.
   ref_a=booking('A','21:00');ref_b=booking('B','21:00')
   normalized_a=verification(ref_a);normalized_a.update(method='gcash',reference='QA 123-XYZ')
   normalized_b=verification(ref_b);normalized_b.update(method='gcash',reference='  qa123xyz  ')
   payment(dict(normalized_a,reference='QA１２３XYZ'),error='INVALID_PAYMENT_REFERENCE')
   def reference_contender(x):
    try:return payment(x)
    except AssertionError as e:
     assert 'REFERENCE_ALREADY_RECORDED' in str(e),str(e)
     return None
   with concurrent.futures.ThreadPoolExecutor(2) as pool:ref_results=list(pool.map(reference_contender,[normalized_a,normalized_b]))
   assert sum(x is not None for x in ref_results)==1
   winner=next(x for x in ref_results if x is not None)
   winner_payload=normalized_a if winner['reservation']['id']==ref_a['id'] else normalized_b
   assert payment(winner_payload)['replayed'] is True
   same_ref_balance=verification(winner['reservation'],'balance',24000);same_ref_balance.update(method='gcash',reference='Qa-123 xyZ')
   payment(same_ref_balance,error='REFERENCE_ALREADY_RECORDED')
   assert sql("select count(*) from oneshot_private.staff_payment_verifications where method='gcash' and upper(translate(btrim(reference),' -',''))='QA123XYZ'")=='1'
   checks.append('concurrent normalized GCash reference one commit; replay safe; cross-kind reuse denied')
   listed=json.loads(sql(as_user(OTHER)+f"select oneshot_staff_reservations('{future}'::date,'{future}'::date)"))
   assert len(listed['reservations'])>=5 and listed['fundsTransferred'] is False
   sql(as_user(OWNER)+f"select oneshot_staff_reservations('{future}'::date,'{future}'::date)",'STAFF_REQUIRED')
   sql(as_user(OTHER)+"select oneshot_staff_reservations(current_date,current_date+94)",'INVALID_DATE_RANGE')
   sql(as_user(OTHER)+"select * from oneshot_private.staff_payment_verifications",'permission denied')
   sql(as_user(OTHER)+"update reservations set \"downPaymentPaid\"=1",'permission denied')
   receipt=json.loads(sql(as_user(OTHER)+f"select oneshot_staff_receipt('{r['id']}')"))
   assert receipt['reservationId']==r['id'] and receipt['path']==r['receiptImg']
   sql(as_user(OWNER)+f"select oneshot_staff_receipt('{r['id']}')",'STAFF_REQUIRED')
   sql(as_user(OTHER)+"select oneshot_staff_receipt('missing')",'BOOKING_NOT_FOUND')
   sql(f"update reservations set \"receiptImg\"='https://public.invalid/legacy.jpg' where id='{legacy['id']}'")
   sql(as_user(OTHER)+f"select oneshot_staff_receipt('{legacy['id']}')",'PRIVATE_RECEIPT_REQUIRED')
   sql(f"delete from storage.objects where name='{r['receiptImg']}'")
   sql(as_user(OTHER)+f"select oneshot_staff_receipt('{r['id']}')",'RECEIPT_NOT_FOUND')
   checks.append('staff receipt bound to authoritative owned private object, never arbitrary URL')
   # Approval is separate from money verification when the required deposit is zero.
   approval_sequence=0
   def approval_booking(total_zero=False,nonzero_deposit=False):
    global approval_sequence
    approval_sequence+=1
    approval_day=(dt.date.fromisoformat(future)+dt.timedelta(days=approval_sequence+3)).isoformat()
    sql("update system_settings set setting_value='"+('20' if nonzero_deposit else '0')+"' where key_name='downPaymentPercent'")
    sql("update system_settings set setting_value='"+('0' if total_zero else '150')+"' where key_name='hourlyRate'")
    q=payload('A',date=approval_day);q.update(expectedTotalCents=0 if total_zero else 30000,expectedDownPaymentCents=6000 if nonzero_deposit else 0)
    return call('create',q)['reservation']
   def approval_request(r):return dict(requestId=str(uuid.uuid4()),id=r['id'],expectedRevision=r['revision'],expectedTotalCents=r['total_amount_cents'],expectedDownPaymentCents=r['down_payment_amount_cents'])
   def approve(p,uid=OTHER,error=None):
    p=dict(p,expectedStaffId=p.get('expectedStaffId',uid));body=json.dumps(p).replace("'","''")
    out=sql(as_user(uid)+f"select oneshot_staff_approve_booking('{body}'::jsonb)",error)
    return json.loads(out) if out else None
   free=approval_booking(total_zero=True);approval=approval_request(free)
   approve(approval,uid=OWNER,error='STAFF_REQUIRED')
   approve(dict(approval,expectedStaffId=MANAGER),error='ACCOUNT_CHANGED')
   approve(dict(approval,status='confirmed'),error='INVALID_FIELDS')
   approve(dict(approval,expectedTotalCents=1),error='APPROVAL_AMOUNT_CHANGED')
   approved=approve(approval)
   assert approved['reservation']['status']=='confirmed' and approved['reservation']['revision']==2
   assert approved['reservation']['downPaymentPaid']==0 and approved['reservation']['balancePaid']==0 and approved['reservation']['balancepaid']==0
   assert approved['approval']['actorUserId']==OTHER and approved['approval']['actorRole']=='cashier' and approved['approval']['recordType']=='no-payment-due-approval' and approved['approval']['fundsTransferred'] is False
   assert sql(f"select count(*) from oneshot_private.staff_payment_verifications where reservation_id='{free['id']}'")=='0'
   assert approve(approval)['replayed']
   approve(dict(approval,expectedTotalCents=9),error='IDEMPOTENCY_CONFLICT')
   approve(dict(approval,requestId=str(uuid.uuid4())),error='STALE_REVISION')
   approve(dict(approval,requestId=str(uuid.uuid4()),expectedRevision=2),error='APPROVAL_STATE_NOT_ALLOWED')
   sql(f"update oneshot_private.staff_memberships set active=false where user_id='{OTHER}'")
   approve(approval,error='STAFF_REQUIRED')
   sql(f"update oneshot_private.staff_memberships set active=true where user_id='{OTHER}'")
   sql(f"update auth.sessions set not_after=now()-interval '1 second' where id='{session_ids[OTHER]}'")
   approve(approval,error='STAFF_REQUIRED')
   sql(f"update auth.sessions set not_after=null where id='{session_ids[OTHER]}'")
   payment(verification(approved['reservation'],'deposit',0),error='NO_PAYMENT_DUE')
   payment(verification(approved['reservation'],'balance',0),error='NO_PAYMENT_DUE')
   # Customer cancellation after approval creates no refund or payment fiction.
   cancelled_free=call('cancel',dict(requestId=str(uuid.uuid4()),id=free['id'],expectedRevision=2))['reservation']
   assert cancelled_free['status']=='cancelled' and cancelled_free['refundStatus'] is None
   payment(verification(approved['reservation'],'balance',0),error='STALE_REVISION')
   no_deposit=approval_booking();deferred=approve(approval_request(no_deposit),uid=MANAGER)
   assert deferred['reservation']['total_amount_cents']==30000 and deferred['reservation']['paymentSummary']['remainingCents']==30000 and deferred['reservation']['downPaymentPaid']==0
   later_paid=payment(verification(deferred['reservation'],'balance',30000))
   assert later_paid['reservation']['balancePaid']==1
   deposit_required=approval_booking(nonzero_deposit=True)
   approve(approval_request(deposit_required),error='DEPOSIT_PAYMENT_REQUIRED')
   malformed=approval_booking();sql(f"update reservations set total_amount_cents=null where id='{malformed['id']}'")
   approve(approval_request(malformed),error='BOOKING_FINANCIAL_RECONCILIATION_REQUIRED')
   sql(f"update reservations set total_amount_cents=30000,\"downPaymentPaid\"=1 where id='{malformed['id']}'")
   approve(approval_request(malformed),error='PAYMENT_LEDGER_RECONCILIATION_REQUIRED')
   sql(f"update reservations set \"downPaymentPaid\"=0,status='cancelled' where id='{malformed['id']}'")
   approve(approval_request(malformed),error='APPROVAL_STATE_NOT_ALLOWED')
   # Same idempotency namespace is shared with payment commands.
   namespace=approval_request(approval_booking());namespace['requestId']=p['requestId']
   approve(namespace,error='IDEMPOTENCY_CONFLICT')
   race_row=approval_booking();race1=approval_request(race_row);race2=approval_request(race_row)
   def approval_contender(q):
    try:return approve(q)
    except AssertionError as e:
     assert 'STALE_REVISION' in str(e),str(e)
     return None
   with concurrent.futures.ThreadPoolExecutor(2) as pool:approval_race=list(pool.map(approval_contender,[race1,race2]))
   assert sum(x is not None for x in approval_race)==1
   assert sql(f"select count(*) from oneshot_private.staff_booking_approvals where reservation_id='{race_row['id']}'")=='1'
   same_row=approval_booking();same_approval=approval_request(same_row)
   with concurrent.futures.ThreadPoolExecutor(2) as pool:approval_replays=list(pool.map(lambda _:approve(same_approval),range(2)))
   assert sum(x['replayed'] for x in approval_replays)==1 and approval_replays[0]['approval']['id']==approval_replays[1]['approval']['id']
   sql(as_user(OTHER)+"select * from oneshot_private.staff_booking_approvals",'permission denied')
   checks.extend(['zero-total approval changes status only, no paid flags/payment ledger','zero-approved booking cancels without refund','zero-deposit nonzero-total approval retains unpaid balance','deferred balance subsequently verified normally','concurrent approvals exactly one audit','concurrent identical approvals replay once'])
   sql(f"insert into reservations(id,date) select 'QA-LIMIT-'||i,'{future}'::date from generate_series(1,1001)i")
   sql(as_user(OTHER)+f"select oneshot_staff_reservations('{future}'::date,'{future}'::date)",'LIST_LIMIT')
   before_upgrade=sql("select (select count(*) from oneshot_private.staff_payment_operations)::text||':'||(select count(*) from oneshot_private.staff_payment_verifications)::text||':'||(select count(*) from oneshot_private.staff_booking_approvals)::text||':'||(select coalesce(sum(amount_cents),0) from oneshot_private.staff_payment_verifications)::text")
   sql("set oneshot.secure_gateway_cutover='reviewed';\n"+payments)
   after_upgrade=sql("select (select count(*) from oneshot_private.staff_payment_operations)::text||':'||(select count(*) from oneshot_private.staff_payment_verifications)::text||':'||(select count(*) from oneshot_private.staff_booking_approvals)::text||':'||(select coalesce(sum(amount_cents),0) from oneshot_private.staff_payment_verifications)::text")
   assert after_upgrade==before_upgrade
   assert payment(p)['replayed'] is True and approve(same_approval)['replayed'] is True
   checks.append('candidate applied twice preserves payment/approval audit amounts and operation replay')
   checks.extend(['cashier actor persisted and immutable verification not transfer','canonical deposit and flags','owner unchanged','balance remaining amount and mirrored flags','full payment then deposit prevents overpayment','concurrent confirmations exactly once','concurrent same request replays one verification','bounded legitimate staff list'])
   print(json.dumps({'passed':len(checks),'checks':checks,'engine':sql('select version()'),'liveWrites':False,'limits':['Actual PostgreSQL fixture only, not deployed RPC or a bank transfer.','Existing financial flags without canonical ledger require reconciliation.']},indent=2))
  finally:
   server.terminate()
   server.wait(timeout=10)
