#!/usr/bin/env python3
"""Run feedback authorization/transaction checks in a disposable local PostgreSQL 17 cluster."""
from pathlib import Path
import concurrent.futures
import json
import os
import subprocess
import tempfile
import time
import uuid
PG=Path(os.environ.get('ONESHOT_TEST_PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
SOURCE=Path(__file__).parent
OWNER='11111111-1111-4111-8111-111111111111'
OTHER='22222222-2222-4222-8222-222222222222'
UNVERIFIED='33333333-3333-4333-8333-333333333333'
CONCURRENT='44444444-4444-4444-8444-444444444444'
checks=[]
with tempfile.TemporaryDirectory(prefix='oneshot-feedback-') as directory:
 base=Path(directory)
 subprocess.run([str(PG/'initdb'),'-D',str(base/'db'),'-A','trust','-U','postgres','--no-locale'],check=True,stdout=subprocess.DEVNULL)
 with (base/'postgres.log').open('w') as log:
  process=subprocess.Popen([str(PG/'postgres'),'-D',str(base/'db'),'-k',str(base),'-p','54396','-h',''],stdout=log,stderr=log)
  try:
   for _ in range(100):
    if subprocess.run([str(PG/'pg_isready'),'-h',str(base),'-p','54396'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
    if process.poll() is not None:raise RuntimeError((base/'postgres.log').read_text())
    time.sleep(.05)
   else:raise RuntimeError('Local PostgreSQL did not become ready')
   def sql(query,error=None):
    result=subprocess.run([str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(base),'-p','54396','-U','postgres'],input=query,text=True,capture_output=True)
    if error:
     assert result.returncode!=0 and error in result.stderr,(error,result.stderr,result.stdout)
     checks.append(error)
     return
    assert result.returncode==0,(result.stderr,result.stdout)
    return result.stdout.strip()
   sql('''create role anon;create role authenticated;create schema auth;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,banned_until timestamptz,deleted_at timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to public;
''')
   sql((SOURCE/'cloud-schema.fixture.sql').read_text())
   sql('alter table reservations add column customer_user_id uuid references auth.users(id);grant all on feedback to anon,authenticated;')
   draft=(SOURCE/'feedback-commands.draft.sql').read_text()
   sql(draft,'reviewed coordinated customer cutover required')
   sql("set oneshot.secure_gateway_cutover='reviewed';"+(SOURCE/'customer-identity.draft.sql').read_text())
   sql("set oneshot.secure_gateway_cutover='reviewed';"+draft)
   sessions={uid:str(uuid.uuid4()) for uid in [OWNER,OTHER,UNVERIFIED,CONCURRENT]}
   for uid,sid in sessions.items():
    confirmed='null' if uid==UNVERIFIED else 'now()'
    sql(f"insert into auth.users values ('{uid}','{uid[:4]}@example.invalid',{confirmed},false,null,null);insert into auth.sessions values ('{sid}','{uid}',null)")
   def payload(owner=OWNER,**changes):return dict(requestId=str(uuid.uuid4()),expectedCustomerId=owner,customerName=' QA Customer ',contactInfo='09123456789',feedbackType='suggestion',comment=' QA message: https://example.invalid is untrusted text. ',**changes)
   def call(p,owner=OWNER,error=None,role='authenticated',sid=None):
    body=json.dumps(p).replace("'","''")
    auth=f"set role {role};set request.jwt.claim.sub='{owner}';set request.jwt.claims='{json.dumps({'session_id':sid or sessions.get(owner)})}';"
    result=sql(auth+f"select public.oneshot_feedback_create('{body}'::jsonb)",error)
    return json.loads(result) if result else None
   first=payload();saved=call(first)
   assert saved['feedback']['customer_user_id']==OWNER and saved['feedback']['status']=='pending'
   fid=saved['feedback']['id'];uuid.UUID(fid)
   assert fid!=first['requestId']
   row=json.loads(sql(f"select row_to_json(f) from feedback f where id='{fid}'"))
   assert row['customer_email']=='1111@example.invalid' and row['customerName']==row['customername']=='QA Customer'
   assert row['feedbackType']==row['feedbacktype']=='suggestion' and row['comment']==first['comment'].strip()
   assert row['date'] and row['notes'] is None and json.loads(row['tags'])==['suggestion']
   assert call(first)['replayed'] and sql('select count(*) from feedback')=='1';checks.append('authoritative_metadata_and_exact_replay')
   call(dict(first,comment='Changed'),error='IDEMPOTENCY_CONFLICT')
   call(dict(payload(),expectedCustomerId=OTHER),error='ACCOUNT_CHANGED')
   call(payload(),role='anon',error='permission denied')
   sql("set role authenticated;select oneshot_feedback_create('{}')",'VERIFIED_ACCOUNT_REQUIRED')
   call(payload(UNVERIFIED),owner=UNVERIFIED,error='VERIFIED_ACCOUNT_REQUIRED')
   for field in ['banned_until','deleted_at']:
    sql(f"update auth.users set {field}=now()+interval '1 day' where id='{OWNER}'")
    call(first,error='VERIFIED_ACCOUNT_REQUIRED')
    sql(f"update auth.users set {field}=null where id='{OWNER}'")
   sql(f"update auth.users set is_anonymous=true where id='{OWNER}'");call(first,error='VERIFIED_ACCOUNT_REQUIRED');sql(f"update auth.users set is_anonymous=false where id='{OWNER}'")
   call(first,sid=sessions[OTHER],error='VERIFIED_ACCOUNT_REQUIRED')
   sql(f"update auth.sessions set not_after=now()-interval '1 second' where id='{sessions[OWNER]}'");call(first,error='VERIFIED_ACCOUNT_REQUIRED');sql(f"update auth.sessions set not_after=null where id='{sessions[OWNER]}'")
   sql(f"delete from auth.sessions where id='{sessions[OWNER]}'");call(first,error='VERIFIED_ACCOUNT_REQUIRED');sql(f"insert into auth.sessions values ('{sessions[OWNER]}','{OWNER}',null)")
   for key in ['status','notes','date','customer_user_id','customer_email','tags','rating']:
    call(dict(payload(),**{key:'forged'}),error='INVALID_FIELDS')
   for changes,code in [({'requestId':None},'INVALID_REQUEST_ID'),({'requestId':'bad'},'INVALID_REQUEST_ID'),({'comment':''},'INVALID_MESSAGE'),({'comment':'x'*4001},'INVALID_MESSAGE'),({'customerName':False},'INVALID_FIELDS'),({'customerName':'x'*121},'INVALID_MESSAGE'),({'feedbackType':'admin'},'INVALID_CATEGORY'),({'contactInfo':'123'},'INVALID_CONTACT'),({'contactInfo':'a@@b.invalid'},'INVALID_CONTACT'),({'reservationId':{}},'INVALID_RESERVATION_ID')]:call(dict(payload(),**changes),error=code)
   owned=str(uuid.uuid4());sql(f"insert into reservations(id,customer_user_id) values ('{owned}','{OWNER}'),('FOREIGN','{OTHER}'),('LEGACY',null)")
   call(dict(payload(),reservationId='FOREIGN'),error='BOOKING_NOT_FOUND')
   call(dict(payload(),reservationId='LEGACY'),error='BOOKING_NOT_FOUND')
   linked=call(dict(payload(),reservationId=owned.upper()))
   assert sql(f"select \"reservationId\" from feedback where id='{linked['feedback']['id']}'")==owned;checks.append('owned_reservation_link_uuid_case_normalized')
   # A different verified account may reuse a UUID without replaying or reading the first account's record.
   other_payload=dict(first,expectedCustomerId=OTHER);other=call(other_payload,owner=OTHER);assert other['feedback']['id']!=fid;checks.append('idempotency_scoped_to_owner')
   for phone in ['639123456789','+639123456789','followup@example.invalid']:call(dict(payload(),contactInfo=phone))
   assert sql(f"select count(*) from feedback where customer_user_id='{OWNER}'")=='5'
   call(payload(),error='FEEDBACK_RATE_LIMIT');assert call(first)['replayed'];checks.append('replay_before_quota')
   sql(f"update oneshot_private.feedback_operations set created_at=now()-interval '16 minutes' where customer_user_id='{OWNER}'")
   call(payload());checks.append('fifteen_minute_quota_window')
   def contender(_):
    try:return call(payload(CONCURRENT),owner=CONCURRENT)
    except AssertionError as error:
     assert 'FEEDBACK_RATE_LIMIT' in str(error),str(error)
     return None
   with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:results=list(pool.map(contender,range(8)))
   assert sum(r is not None for r in results)==5
   assert sql(f"select count(*) from feedback where customer_user_id='{CONCURRENT}'")=='5';checks.append('concurrent_five_of_eight_quota_atomic')
   repeat=payload(OTHER)
   with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:results=list(pool.map(lambda _:call(repeat,owner=OTHER),range(6)))
   assert len({r['feedback']['id'] for r in results})==1 and sum(not r['replayed'] for r in results)==1;checks.append('concurrent_same_request_commits_once')
   for role in ['anon','authenticated']:
    for operation in ['select * from feedback','insert into feedback(id) values (\'forged\')','select * from oneshot_private.feedback_operations']:
     sql(f'set role {role};'+operation,'permission denied')
   assert sql("select prosecdef from pg_proc where oid='public.oneshot_feedback_create(jsonb)'::regprocedure")=='f'
   assert sql("select prosecdef from pg_proc where oid='oneshot_private.feedback_create(jsonb)'::regprocedure")=='t'
   assert sql("select array_to_string(proconfig,',') from pg_proc where oid='oneshot_private.feedback_create(jsonb)'::regprocedure")=='search_path=""'
   assert sql("select relrowsecurity from pg_class where oid='public.feedback'::regclass")=='t';checks.append('least_privilege_function_metadata_and_rls')
   report={'status':'PASS','checkCount':len(checks),'checks':checks,'scope':'Actual disposable PostgreSQL17 roles/functions/observed column shapes; not hosted REST/JWT validation, live deploy or complete auth provider behavior.'}
   (SOURCE.parent.parent/'release-feedback-commands-tests-20261019.json').write_text(json.dumps(report,indent=2))
   print(json.dumps(report,indent=2))
  finally:
   process.terminate()
   try:process.wait(timeout=10)
   except subprocess.TimeoutExpired:raise RuntimeError('Local PostgreSQL test cluster did not terminate normally')
