"""Disposable PostgreSQL + actual native records; active staff-JWT v2 only."""
import json,os,subprocess
from native_lifecycle_fixture import Fixture,fixture as base_fixture,SOURCE,PG,STAFF,MANAGER,CUSTOMER,OTHER,DEVICE,q
class StaffJwtFixture(Fixture):
 def native(self,*args,**kwargs):
  command,result=args[:2];mode=kwargs.get('mode',args[2]if len(args)>2 else'paid');checkout_request_id=kwargs.get('checkout_request_id')
  node=os.environ.get('ONESHOT_TEST_NODE','/Users/macbookpro/.nvm/versions/node/v22.17.0/bin/node')
  result=subprocess.run([node,str(SOURCE/'native-staff-lifecycle-events.fixture.cjs')],input=json.dumps(dict(command=command,result=result,mode=mode,checkoutRequestId=checkout_request_id)),text=True,capture_output=True,timeout=30)
  assert result.returncode==0,result.stderr
  return json.loads(result.stdout)
 def resign(self,envelope,body=None,actor=STAFF,event_id=None):
  e={k:v for k,v in dict(envelope,version=2,actorId=actor).items()if k not in ['keyId','signature']}
  if body is not None:e['payload']=json.dumps(body,ensure_ascii=False,sort_keys=True,separators=(',',':'))
  if event_id:e['eventId']=event_id
  return e
 def snapshot(self):
  names=json.loads(self.sql("select coalesce(jsonb_agg(schemaname||'.'||tablename order by schemaname,tablename),'[]') from pg_tables where schemaname in ('public','oneshot_private')"))
  return self.sql('select jsonb_build_object('+','.join(q(n)+f",(select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]') from {n} r)"for n in names)+')')
def fixture():return base_fixture(factory=StaffJwtFixture)
