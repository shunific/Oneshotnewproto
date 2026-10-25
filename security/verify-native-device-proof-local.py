#!/usr/bin/env python3
"""Actual disposable PG17 native HMAC verification; never prints or persists keys."""
from pathlib import Path
import concurrent.futures
import hashlib
import hmac
import json
import os
import re
import subprocess
import tempfile
import time
import uuid

PG=Path(os.environ.get('ONESHOT_TEST_PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
SOURCE=Path(__file__).parent
STAFF='11111111-1111-4111-8111-111111111111'
MANAGER='22222222-2222-4222-8222-222222222222'
CUSTOMER='33333333-3333-4333-8333-333333333333'
DEVICE='55555555-5555-4555-8555-555555555555'
OTHER_DEVICE='66666666-6666-4666-8666-666666666666'
KEY_ID=str(uuid.uuid4())
SECRET=os.urandom(32)
checks=[]

def quote(value):return "'"+str(value).replace("'","''")+"'"
def clean(value):return re.sub(r'[0-9a-fA-F]{64}','[REDACTED 32-BYTE VALUE]',value)

with tempfile.TemporaryDirectory(prefix='oneshot-native-proof-') as directory:
 base=Path(directory)
 subprocess.run([str(PG/'initdb'),'-D',str(base/'db'),'-A','trust','-U','postgres','--no-locale','--encoding=UTF8'],check=True,stdout=subprocess.DEVNULL)
 with (base/'postgres.log').open('w') as log:
  server=subprocess.Popen([str(PG/'postgres'),'-D',str(base/'db'),'-k',str(base),'-p','54408','-h',''],stdout=log,stderr=log)
  try:
   for _ in range(100):
    if subprocess.run([str(PG/'pg_isready'),'-h',str(base),'-p','54408'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
    if server.poll() is not None:raise RuntimeError(clean((base/'postgres.log').read_text()))
    time.sleep(.05)
   else:raise RuntimeError('Local PostgreSQL startup failed')
   def execute(query):
    return subprocess.run([str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(base),'-p','54408','-U','postgres'],input=query,text=True,capture_output=True,timeout=25)
   def sql(query,error=None):
    r=execute(query)
    if error is not None:
     assert r.returncode!=0 and error in r.stderr,(error,clean(r.stderr));checks.append(error);return None
    assert r.returncode==0,clean(r.stderr)
    return r.stdout.strip()
   sql('''create role anon;create role authenticated;create schema auth;create schema storage;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,banned_until timestamptz,deleted_at timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth,storage to anon,authenticated;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create function storage.allow_only_operation(expected text) returns boolean language sql stable as $$select current_setting('oneshot.test.storage_operation',true)=expected$$;
create table storage.objects(bucket_id text,name text,owner_id text,metadata jsonb,primary key(bucket_id,name));
alter table storage.objects enable row level security;grant select,insert,update,delete on storage.objects to anon,authenticated;''')
   sql((SOURCE/'cloud-schema.fixture.sql').read_text())
   gates="set oneshot.secure_gateway_cutover='reviewed';set oneshot.private_receipts_cutover='reviewed';\n"
   prerequisites=['customer-identity.draft.sql','cloud-containment.draft.sql','private-receipts.draft.sql','booking-transactions.draft.sql','booking-availability.draft.sql','staff-identity.draft.sql','staff-payments.draft.sql','feedback-commands.draft.sql','receipt-upload-intents.draft.sql','staff-checkin.draft.sql']
   sql(gates+'\n'.join((SOURCE/name).read_text() for name in prerequisites))
   draft=(SOURCE/'native-device-proof.draft.sql').read_text()
   sql(draft,error='reviewed coordinated gateway cutover required')
   sql(gates+draft)
   session_ids={u:str(uuid.uuid4()) for u in [STAFF,MANAGER,CUSTOMER]}
   for u,sid in session_ids.items():sql(f"insert into auth.users values ('{u}','{u[:8]}@example.invalid',now(),false,null,null);insert into auth.sessions values ('{sid}','{u}',null)")
   sql(f"insert into oneshot_private.staff_memberships(user_id,role,active,approved_by) values ('{STAFF}','cashier',true,'{MANAGER}'),('{MANAGER}','manager',true,'{MANAGER}')")
   sql("insert into public.tables(id,name,status,isactive,\"isActive\") values ('CLOUD-A','QA A','available',1,1)")
   sql(f"insert into oneshot_private.checkin_table_mappings(device_id,native_table_id,cloud_table_id,active,coordinator_ready,approved_by) values ('{DEVICE}','LOCAL-A','CLOUD-A',true,true,'{MANAGER}')")
   sql(f'''insert into public.reservations(id,"customerName","contactNumber",email,date,"timeSlot","durationHours","partySize","tableId",status,"downPaymentPaid","balancePaid",balancepaid,customer_user_id,revision,total_amount_cents,down_payment_amount_cents,discount_amount_cents) values ('QA-PROOF','QA Signed Device','09123456789','owner@example.invalid',timezone('Asia/Manila',statement_timestamp())::date,'14:00',2,2,'CLOUD-A','pending',0,0,0,'{CUSTOMER}',1,20100,4020,10001)''')
   def as_user(user=STAFF,role='authenticated'):
    return f"set role {role};set request.jwt.claim.sub='{user}';set request.jwt.claims={quote(json.dumps({'session_id':session_ids[user]}))};"
   def rpc(name,payload,user=STAFF):
    return json.loads(sql(as_user(user)+f"select public.{name}({quote(json.dumps(payload))}::jsonb)"))
   rpc('oneshot_staff_confirm_payment',dict(requestId=str(uuid.uuid4()),id='QA-PROOF',expectedRevision=1,expectedStaffId=STAFF,paymentKind='deposit',method='cash',expectedAmountCents=4020))
   command=dict(requestId=str(uuid.uuid4()),id='QA-PROOF',expectedRevision=2,expectedStaffId=STAFF,deviceId=DEVICE,tableId='LOCAL-A')
   claim_result=rpc('oneshot_staff_claim_checkin',command)
   claim=claim_result['claim']
   sql(f"insert into oneshot_private.native_device_keys(key_id,device_id,secret_key,approved_by,active) values ('{KEY_ID}','{DEVICE}',decode('{SECRET.hex()}','hex'),'{MANAGER}',true)")
   # Test-only future-DEFINER caller, not part of the candidate or public API.
   sql("create function oneshot_private.fixture_verify_native_event(envelope jsonb) returns jsonb language sql security definer set search_path='' as $$select oneshot_private.verify_native_device_event(envelope)$$;revoke all on function oneshot_private.fixture_verify_native_event(jsonb) from public,anon,authenticated;grant execute on function oneshot_private.fixture_verify_native_event(jsonb) to authenticated")
   def verify(envelope,user=STAFF,error=None):
    out=sql(as_user(user)+f"select oneshot_private.fixture_verify_native_event({quote(json.dumps(envelope,ensure_ascii=False))}::jsonb)",error)
    return json.loads(out) if out else None
   def sign_envelope(envelope,secret=SECRET):
    data='\n'.join(['oneshot-native-event-v1',envelope['keyId'],envelope['deviceId'],envelope['actorId'],envelope['eventType'],envelope['eventId'],envelope['claimId'],hashlib.sha256(envelope['payload'].encode()).hexdigest()])
    envelope['signature']=hmac.new(secret,data.encode(),hashlib.sha256).hexdigest()
    return envelope
   def signed(body,event_type='admission',actor=STAFF,raw=None,**headers):
    envelope=dict(version=1,keyId=KEY_ID,deviceId=DEVICE,actorId=actor,eventType=event_type,eventId=body.get('eventId') if isinstance(body.get('eventId'),str) else str(uuid.uuid4()),claimId=claim['claimId'],payload=raw if raw is not None else json.dumps(body,sort_keys=True,separators=(',',':'),ensure_ascii=False))
    envelope.update(headers)
    return sign_envelope(envelope)
   admission=dict(eventId=str(uuid.uuid4()),type='admission',requestId=claim['requestId'],claimId=claim['claimId'],reservationId=claim['reservationId'],deviceId=DEVICE,tableId=claim['tableId'],cloudUserId=claim['actorUserId'],localStaffId='qa-local',sessionStartTime='2026-10-19T00:00:00.000Z')
   pricing={key:claim[source] for key,source in dict(claimId='claimId',reservationId='reservationId',ownerUserId='ownerUserId',sourceRevision='sourceRevision',claimRevision='claimRevision',durationMinutes='durationMinutes',grossCents='grossTotalCents',discountCents='discountCents',netCents='netTotalCents',verifiedPaidCents='verifiedPaidCents').items()}
   completion=dict(version=1,eventId=str(uuid.uuid4()),type='reservation-completion',claimRequestId=claim['requestId'],claimId=claim['claimId'],reservationId=claim['reservationId'],deviceId=DEVICE,admissionTableId=claim['tableId'],admissionCloudUserId=claim['actorUserId'],reservationPricing=pricing)
   envelope=signed(admission)
   accepted=verify(envelope)
   assert accepted['body']==admission and accepted['payloadSha256']==hashlib.sha256(envelope['payload'].encode()).hexdigest()
   assert accepted['actorId']==STAFF and accepted['eventType']=='admission'
   assert verify(signed(completion,'reservation-completion'))['body']==completion
   assert verify(signed(admission,actor=MANAGER),user=MANAGER)['actorId']==MANAGER
   assert verify(signed(completion,'reservation-completion',actor=MANAGER),user=MANAGER)['body']['admissionCloudUserId']==STAFF
   checks.extend(['Python HMAC-SHA256 admission and completion vectors accepted','fresh different approved staff may re-sign original device event without rewriting original claim actor'])
   other_key_id=str(uuid.uuid4());other_secret=os.urandom(32)
   sql(f"insert into oneshot_private.native_device_keys(key_id,device_id,secret_key,approved_by,active) values ('{other_key_id}','{OTHER_DEVICE}',decode('{other_secret.hex()}','hex'),'{MANAGER}',true)")
   wrong_device=sign_envelope(dict(envelope,keyId=other_key_id,deviceId=OTHER_DEVICE),other_secret)
   verify(wrong_device,error='NATIVE_EVENT_CLAIM_MISMATCH')
   checks.append('independently enrolled valid key for another device cannot verify this device claim')
   inactive_key=str(uuid.uuid4())
   sql(f"insert into oneshot_private.native_device_keys(key_id,device_id) values ('{inactive_key}','{DEVICE}')")
   assert sql(f"select (not active and approved_by is null and octet_length(secret_key)=32)::text from oneshot_private.native_device_keys where key_id='{inactive_key}'")=='true'
   verify(dict(envelope,keyId=inactive_key),error='NATIVE_DEVICE_KEY_REQUIRED')
   checks.append('owner enrollment generates 32 random bytes and defaults to inactive without approval')
   for fields,error in [("secret_key=decode('00','hex')",'native_device_keys_secret_key_check'),("approved_by=null,active=true",'native_device_keys_check'),("venue_id='other-venue'",'native_device_keys_venue_id_check')]:
    sql(f"update oneshot_private.native_device_keys set {fields} where key_id='{inactive_key}'",error=error)
   for signature in ['0'*64,envelope['signature'][:-2]+('00' if envelope['signature'][-2:]!='00' else '01')]:verify(dict(envelope,signature=signature),error='NATIVE_DEVICE_SIGNATURE_INVALID')
   for field,value,error in [('version','1','INVALID_NATIVE_EVENT_VERSION'),('version',2,'INVALID_NATIVE_EVENT_VERSION'),('keyId',[], 'INVALID_NATIVE_EVENT_IDENTIFIER'),('keyId',KEY_ID.upper(),'INVALID_NATIVE_EVENT_IDENTIFIER'),('deviceId',OTHER_DEVICE,'NATIVE_DEVICE_KEY_REQUIRED'),('actorId',MANAGER,'NATIVE_EVENT_ACCOUNT_CHANGED'),('claimId',str(uuid.uuid4()),'NATIVE_EVENT_CLAIM_MISMATCH'),('eventType',[],'INVALID_NATIVE_EVENT_TYPE'),('eventType','completion','INVALID_NATIVE_EVENT_TYPE'),('eventId','bad','INVALID_NATIVE_EVENT_IDENTIFIER'),('payload',{},'INVALID_NATIVE_EVENT_PAYLOAD'),('signature',envelope['signature'].upper(),'INVALID_NATIVE_EVENT_SIGNATURE'),('signature','0'*63,'INVALID_NATIVE_EVENT_SIGNATURE')]:verify(dict(envelope,**{field:value}),error=error)
   verify(dict(envelope,extra='forged'),error='INVALID_NATIVE_EVENT_ENVELOPE')
   verify({k:v for k,v in envelope.items() if k!='payload'},error='INVALID_NATIVE_EVENT_ENVELOPE')
   verify(dict(envelope,payload=envelope['payload']+' '),error='NATIVE_DEVICE_SIGNATURE_INVALID')
   raw=json.dumps(admission,ensure_ascii=False,indent=2)
   assert verify(signed(admission,raw=raw))['body']==admission
   checks.append('layout bytes are authenticated exactly; separately signed JSON layout is accepted without SQL normalization')
   for text in ['café 😀','line\nreturn\r tab\t','e\u0301','é','zero\u200bwidth']:
    body=dict(admission,note=text);result=verify(signed(body));assert result['body']['note']==text
   checks.append('UTF8 astral, combining/composed Unicode and escaped layout vectors preserve exact signed bytes')
   nested_pricing=json.dumps(completion).replace('"netCents": 20100','"netCents": 20100,"netCents": 20100')
   assert nested_pricing.count('"netCents"')==2
   nested_receipt=json.dumps(completion)[:-1]+',"receipt":{"id":"x","id":"x"}}'
   for raw in ['[]','null','{"x":1,"x":2}',json.dumps(admission)[:-1]+',"type":"admission"}',nested_pricing,nested_receipt,'{broken','{"n":"\\u0000"}','{"n":"\\ud800"}','{"n":"\\udc00"}',json.dumps(admission)+'\u200b']:
    verify(signed(admission,raw=raw),error='INVALID_NATIVE_EVENT_PAYLOAD')
   escaped_unicode=dict(admission,note='😀')
   assert verify(signed(escaped_unicode,raw=json.dumps(escaped_unicode,ensure_ascii=True)))['body']['note']=='😀'
   verify(dict(envelope,payload=envelope['payload']+'\u200b'),error='NATIVE_DEVICE_SIGNATURE_INVALID')
   checks.append('nested pricing/receipt duplicate keys, null/lone surrogate escapes and zero-width layout fail closed; valid surrogate pair accepted')
   oversized=json.dumps(dict(admission,note='é'*524289),ensure_ascii=False)
   verify(signed(admission,raw=oversized),error='NATIVE_EVENT_PAYLOAD_TOO_LARGE')
   for field in ['eventId','claimId','deviceId','type','reservationId']:
    verify(signed(dict(admission,**{field:[admission[field]]})),error='NATIVE_EVENT_BODY_MISMATCH')
   for field in ['requestId','tableId','cloudUserId']:
    verify(signed(dict(admission,**{field:'forged'})),error='NATIVE_EVENT_ADMISSION_BINDING_MISMATCH')
   for field in ['claimRequestId','admissionTableId','admissionCloudUserId']:
    verify(signed(dict(completion,**{field:'forged'}),'reservation-completion'),error='NATIVE_EVENT_COMPLETION_BINDING_MISMATCH')
   for field in pricing:
    bad=dict(pricing,**{field:'forged' if isinstance(pricing[field],str) else pricing[field]+1})
    verify(signed(dict(completion,reservationPricing=bad),'reservation-completion'),error='NATIVE_EVENT_PRICING_MISMATCH')
   verify(signed(dict(completion,reservationPricing=dict(pricing,netCents=str(pricing['netCents']))),'reservation-completion'),error='NATIVE_EVENT_PRICING_MISMATCH')
   verify(signed(dict(completion,reservationPricing=dict(pricing,extra=1)),'reservation-completion'),error='NATIVE_EVENT_PRICING_MISMATCH')
   checks.append('strict header/body admission and complete original owner/quote/revision bindings reject newly signed tampering')
   sql(as_user()+f"select oneshot_private.verify_native_device_event({quote(json.dumps(envelope))}::jsonb)",error='permission denied')
   sql(as_user(role='anon')+f"select oneshot_private.verify_native_device_event({quote(json.dumps(envelope))}::jsonb)",error='permission denied')
   for operation in ['select * from oneshot_private.native_device_keys','delete from oneshot_private.native_device_keys',"update oneshot_private.native_device_keys set active=true",f"insert into oneshot_private.native_device_keys(key_id,device_id) values ('{uuid.uuid4()}','{OTHER_DEVICE}')"]:
    sql(as_user()+operation,error='permission denied')
   verify(envelope,user=CUSTOMER,error='STAFF_REQUIRED')
   for update,restore in [(f"update oneshot_private.native_device_keys set active=false where key_id='{KEY_ID}'",f"update oneshot_private.native_device_keys set active=true where key_id='{KEY_ID}'"),(f"update oneshot_private.staff_memberships set active=false where user_id='{STAFF}'",f"update oneshot_private.staff_memberships set active=true where user_id='{STAFF}'"),(f"update auth.users set banned_until=now()+interval '1 day' where id='{STAFF}'",f"update auth.users set banned_until=null where id='{STAFF}'"),(f"update auth.users set deleted_at=now() where id='{STAFF}'",f"update auth.users set deleted_at=null where id='{STAFF}'"),(f"update auth.sessions set not_after=now()-interval '1 second' where id='{session_ids[STAFF]}'",f"update auth.sessions set not_after=null where id='{session_ids[STAFF]}'")]:
    sql(update);verify(envelope,error='NATIVE_DEVICE_KEY_REQUIRED' if 'native_device_keys' in update else 'STAFF_REQUIRED');sql(restore)
   sql(f"delete from auth.sessions where id='{session_ids[STAFF]}'");verify(envelope,error='STAFF_REQUIRED');sql(f"insert into auth.sessions values ('{session_ids[STAFF]}','{STAFF}',null)")
   sql(f"insert into oneshot_private.native_device_keys(key_id,device_id,approved_by,active) values ('{uuid.uuid4()}','{DEVICE}','{MANAGER}',true)",error='native_device_one_active_key')

   def held(query,label):
    p=subprocess.Popen([str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(base),'-p','54408','-U','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    p.stdin.write(f"set application_name='{label}';begin;{query};select pg_sleep(1.3);commit;");p.stdin.close()
    for _ in range(100):
     if sql(f"select count(*) from pg_stat_activity where application_name='{label}' and wait_event='PgSleep'")=='1':return p
     if p.poll() is not None:raise AssertionError(clean(p.stderr.read()))
     time.sleep(.01)
    raise AssertionError('Controlled lock barrier failed')
   def raw_verify():return execute(as_user()+f"select oneshot_private.fixture_verify_native_event({quote(json.dumps(envelope))}::jsonb)")
   blocker=held(f"update oneshot_private.native_device_keys set active=false where key_id='{KEY_ID}'",'qa-key-revoke')
   outcome=raw_verify();assert blocker.wait(timeout=10)==0;assert outcome.returncode!=0 and 'NATIVE_DEVICE_KEY_REQUIRED' in outcome.stderr
   sql(f"update oneshot_private.native_device_keys set active=true where key_id='{KEY_ID}'")
   checks.append('verification waiting on key revocation observes current committed inactive key')
   for mode in ['membership','expiration']:
    blocker=held(f"select key_id from oneshot_private.native_device_keys where key_id='{KEY_ID}' for update",'qa-proof-lock')
    if mode=='expiration':sql(f"update auth.sessions set not_after=clock_timestamp()+interval '0.5 seconds' where id='{session_ids[STAFF]}'")
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
     waiting=pool.submit(raw_verify)
     if mode=='membership':
      for _ in range(100):
       if sql("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%fixture_verify_native_event%'")!='0':break
       time.sleep(.01)
      else:raise AssertionError('Verifier did not reach key lock')
      sql(f"update oneshot_private.staff_memberships set active=false where user_id='{STAFF}'")
     outcome=waiting.result()
    assert blocker.wait(timeout=10)==0;assert outcome.returncode!=0 and 'STAFF_REQUIRED' in outcome.stderr
    sql(f"update oneshot_private.staff_memberships set active=true where user_id='{STAFF}';update auth.sessions set not_after=null where id='{session_ids[STAFF]}'")
   checks.append('membership revocation and real session-clock expiry during key-lock wait deny proof')
   # Reapplication never touches enrolled keys or the original claim/payment audit.
   snapshot_query="select jsonb_build_object('keys',(select jsonb_agg(to_jsonb(k) order by key_id) from oneshot_private.native_device_keys k),'claims',(select jsonb_agg(to_jsonb(c) order by id) from oneshot_private.checkin_claims c),'reservations',(select jsonb_agg(to_jsonb(r) order by id) from reservations r),'payments',(select jsonb_agg(to_jsonb(p) order by id) from oneshot_private.staff_payment_verifications p))"
   before=sql(snapshot_query)
   sql(gates+draft);sql(gates+draft);assert sql(snapshot_query)==before and verify(envelope)['body']==admission
   for mutation in ['alter table oneshot_private.native_device_keys alter active drop not null','alter table oneshot_private.native_device_keys alter active set default true','alter table oneshot_private.native_device_keys drop constraint native_device_keys_secret_key_check','grant select(secret_key) on oneshot_private.native_device_keys to authenticated','alter table oneshot_private.native_device_keys drop constraint native_device_keys_approved_by_fkey']:
    sql('begin;'+mutation+';'+gates+draft,error='INCOMPATIBLE_NATIVE_DEVICE_KEY_');assert sql(snapshot_query)==before
   checks.append('two reapplications preserve byte-exact key/claim/payment rows; five weak existing schemas fail atomically')
   bridge=SOURCE/'native-device-cross-contract.cjs'
   assert bridge.exists(),'Actual native signer bridge is required for complete cross-contract evidence'
   bridge_proof=None
   if bridge.exists():
    node=os.environ.get('ONESHOT_TEST_NODE','/Users/macbookpro/.nvm/versions/node/v22.17.0/bin/node')
    r=subprocess.run([node,str(bridge)],input=json.dumps(dict(command=command,result=claim_result,keyId=KEY_ID,keyHex=SECRET.hex())),text=True,capture_output=True,timeout=30)
    assert r.returncode==0,clean(r.stderr)
    produced=json.loads(r.stdout)
    envelopes=produced if isinstance(produced,list) else list(produced.values()) if 'admission' in produced else [produced]
    verified=[]
    for native_envelope in envelopes:
     proof=verify(native_envelope);assert proof['body']==json.loads(native_envelope['payload']);verified.append(proof['eventType'])
    bridge_proof=dict(verifiedEventTypes=verified)
    checks.append('actual native SQLite coordinator/outbox signer envelopes accepted by PostgreSQL private verifier')
   print(json.dumps(dict(passed=len(checks),checks=checks,sourceSha256=hashlib.sha256(draft.encode()).hexdigest(),engine=sql('select version()'),liveWrites=False,nativeBridge=bridge_proof,documentationReviewed=['https://www.postgresql.org/docs/17/pgcrypto.html','https://supabase.com/docs/guides/database/extensions','https://supabase.com/changelog.md'],limits=['Private verification primitive only: no public RPC, event deduplication ledger, ACK or lifecycle/state mutation.','Owner-enrolled per-device keys; OS secure storage and provisioning remain separate gates.','Local PostgreSQL/Auth fixtures; no hosted token/API or device hardware attestation proof.','Payload exact bytes authenticated and JSON bindings checked; full receipt lifecycle validation remains future.']),indent=2))
  finally:
   server.terminate();server.wait(timeout=10)
