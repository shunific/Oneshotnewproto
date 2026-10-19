"""Disposable actual PostgreSQL/native bridge helpers. No production credentials."""
from contextlib import contextmanager
from pathlib import Path
import hashlib,hmac,json,os,re,subprocess,tempfile,time,uuid
SOURCE=Path(__file__).parent
PG=Path(os.environ.get('ONESHOT_TEST_PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
STAFF='11111111-1111-4111-8111-111111111111';MANAGER='22222222-2222-4222-8222-222222222222'
CUSTOMER='33333333-3333-4333-8333-333333333333';OTHER='44444444-4444-4444-8444-444444444444'
DEVICE='55555555-5555-4555-8555-555555555555'
def q(v):return "'"+str(v).replace("'","''")+"'"
def redact(v):return re.sub(r'[0-9a-fA-F]{64}','[REDACTED 32-BYTE VALUE]',v)
class Fixture:
 def __init__(self,base):self.base=base;self.checks=[];self.counter=0;self.key_id=str(uuid.uuid4());self.secret=os.urandom(32);self.sessions={u:str(uuid.uuid4()) for u in [STAFF,MANAGER,CUSTOMER,OTHER]}
 def execute(self,query):return subprocess.run([str(PG/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(self.base),'-p','54409','-U','postgres'],input=query,text=True,capture_output=True,timeout=30)
 def sql(self,query,error=None):
  r=self.execute(query)
  if error is not None:
   assert r.returncode!=0 and error in r.stderr,(error,redact(r.stderr));self.checks.append(error);return None
  assert r.returncode==0,redact(r.stderr);return r.stdout.strip()
 def user(self,user=STAFF,role='authenticated'):return f"set role {role};set request.jwt.claim.sub='{user}';set request.jwt.claims={q(json.dumps({'session_id':self.sessions[user]}))};"
 def rpc(self,name,body,user=STAFF,error=None):
  out=self.sql(self.user(user)+f"select public.{name}({q(json.dumps(body,ensure_ascii=False))}::jsonb)",error);return json.loads(out) if out else None
 def apply(self,name,error=None):return self.sql("set oneshot.secure_gateway_cutover='reviewed';set oneshot.private_receipts_cutover='reviewed';"+(SOURCE/name).read_text(),error)
 def bootstrap(self):
  self.sql('''create role anon;create role authenticated;create schema auth;create schema storage;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,banned_until timestamptz,deleted_at timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth,storage to anon,authenticated;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create function storage.allow_only_operation(expected text) returns boolean language sql stable as $$select current_setting('oneshot.test.storage_operation',true)=expected$$;
create table storage.objects(bucket_id text,name text,owner_id text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;grant select,insert,update,delete on storage.objects to anon,authenticated;''')
  self.sql((SOURCE/'cloud-schema.fixture.sql').read_text())
  for name in ['customer-identity.draft.sql','cloud-containment.draft.sql','private-receipts.draft.sql','booking-transactions.draft.sql','booking-availability.draft.sql','staff-identity.draft.sql','staff-payments.draft.sql','feedback-commands.draft.sql','receipt-upload-intents.draft.sql','fixtures/staff-checkin-v1.fixture.sql']:self.apply(name)
  for u,s in self.sessions.items():self.sql(f"insert into auth.users values ('{u}','{u[:8]}@example.invalid',now(),false,null,null);insert into auth.sessions values ('{s}','{u}',null)")
  self.sql(f"insert into oneshot_private.staff_memberships(user_id,role,active,approved_by) values ('{STAFF}','cashier',true,'{MANAGER}'),('{MANAGER}','manager',true,'{MANAGER}')")
 def seed(self,net=20100,deposit=4020,discount=10001,table=None,revision=1):
  self.counter+=1;ident=f'QA-LIFECYCLE-{self.counter}';native=table or f'LOCAL-{self.counter}';cloud=f'CLOUD-{self.counter}'
  if table is None:
   self.sql(f"insert into public.tables(id,name,status,isactive,\"isActive\") values ('{cloud}','QA table','available',1,1)")
   self.sql(f"insert into oneshot_private.checkin_table_mappings(device_id,native_table_id,cloud_table_id,active,coordinator_ready,approved_by) values ('{DEVICE}','{native}','{cloud}',true,true,'{MANAGER}')")
  else:cloud=self.sql(f"select cloud_table_id from oneshot_private.checkin_table_mappings where device_id='{DEVICE}' and native_table_id='{table}'")
  self.sql(f'''insert into public.reservations(id,"customerName","contactNumber",email,date,"timeSlot","durationHours","partySize","tableId",status,"downPaymentPaid","balancePaid",balancepaid,customer_user_id,revision,total_amount_cents,down_payment_amount_cents,discount_amount_cents) values ('{ident}','QA Lifecycle','09123456789','owner@example.invalid',timezone('Asia/Manila',statement_timestamp())::date,'14:00',2,2,'{cloud}','pending',0,0,0,'{CUSTOMER}',{revision},{net},{deposit},{discount})''')
  if deposit:self.rpc('oneshot_staff_confirm_payment',dict(requestId=str(uuid.uuid4()),id=ident,expectedRevision=revision,expectedStaffId=STAFF,paymentKind='deposit',method='cash',expectedAmountCents=deposit))
  else:self.rpc('oneshot_staff_approve_booking',dict(requestId=str(uuid.uuid4()),id=ident,expectedRevision=revision,expectedStaffId=STAFF,expectedTotalCents=net,expectedDownPaymentCents=0))
  command=dict(requestId=str(uuid.uuid4()),id=ident,expectedRevision=revision+1,expectedStaffId=STAFF,deviceId=DEVICE,tableId=native)
  result=self.rpc('oneshot_staff_claim_checkin',command);return command,result
 def enroll(self):self.sql(f"insert into oneshot_private.native_device_keys(key_id,device_id,secret_key,approved_by,active) values ('{self.key_id}','{DEVICE}',decode('{self.secret.hex()}','hex'),'{MANAGER}',true)")
 def native(self,command,result,mode='paid',checkout_request_id=None):
  node=os.environ.get('ONESHOT_TEST_NODE','/Users/macbookpro/.nvm/versions/node/v22.17.0/bin/node')
  r=subprocess.run([node,str(SOURCE/'native-lifecycle-events.fixture.cjs')],input=json.dumps(dict(command=command,result=result,keyId=self.key_id,keyHex=self.secret.hex(),mode=mode,checkoutRequestId=checkout_request_id)),text=True,capture_output=True,timeout=30)
  assert r.returncode==0,redact(r.stderr);return json.loads(r.stdout)
 def resign(self,envelope,body=None,actor=STAFF,event_id=None):
  e=dict(envelope,actorId=actor)
  if body is not None:e['payload']=json.dumps(body,ensure_ascii=False,sort_keys=True,separators=(',',':'))
  if event_id:e['eventId']=event_id
  data='\n'.join(['oneshot-native-event-v1',e['keyId'],e['deviceId'],e['actorId'],e['eventType'],e['eventId'],e['claimId'],hashlib.sha256(e['payload'].encode()).hexdigest()])
  e['signature']=hmac.new(self.secret,data.encode(),hashlib.sha256).hexdigest();return e
 def ack(self,envelope,user=STAFF,error=None):return self.rpc('oneshot_staff_ack_native_event',envelope,user,error)
 def snapshot(self):
  names=['public.reservations','public.tables','public.e_receipts','oneshot_private.checkin_table_mappings','oneshot_private.checkin_claims','oneshot_private.checkin_operations','oneshot_private.active_checkin_tables','oneshot_private.checkin_active_registry_upgrades','oneshot_private.staff_payment_verifications','oneshot_private.staff_payment_operations','oneshot_private.staff_booking_approvals','oneshot_private.staff_memberships','oneshot_private.native_device_keys','oneshot_private.native_reservation_events','oneshot_private.native_final_receipts']
  names += [n for n in ['oneshot_private.native_move_operations','oneshot_private.native_move_terminals','oneshot_private.native_move_upgrades','oneshot_private.native_move_cancellations'] if self.sql('select to_regclass('+q(n)+') is not null')=='t']
  return self.sql('select jsonb_build_object('+','.join(q(n)+f",(select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]') from {n} r)" for n in names)+')')
@contextmanager
def fixture(factory=Fixture):
 with tempfile.TemporaryDirectory(prefix='oneshot-native-lifecycle-') as directory:
  base=Path(directory);subprocess.run([str(PG/'initdb'),'-D',str(base/'db'),'-A','trust','-U','postgres','--no-locale','--encoding=UTF8'],check=True,stdout=subprocess.DEVNULL)
  with (base/'postgres.log').open('w') as log:
   server=subprocess.Popen([str(PG/'postgres'),'-D',str(base/'db'),'-k',str(base),'-p','54409','-h',''],stdout=log,stderr=log)
   try:
    for _ in range(100):
     if subprocess.run([str(PG/'pg_isready'),'-h',str(base),'-p','54409'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
     if server.poll() is not None:raise RuntimeError(redact((base/'postgres.log').read_text()))
     time.sleep(.05)
    else:raise RuntimeError('Local PostgreSQL startup failed')
    f=factory(base);f.bootstrap();yield f
   finally:server.terminate();server.wait(timeout=10)
