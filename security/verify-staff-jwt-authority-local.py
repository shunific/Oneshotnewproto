#!/usr/bin/env python3
"""Real disposable PostgreSQL staff-JWT authority and mapping tests; no hosted writes."""
import copy,json,uuid,hashlib
from staff_jwt_lifecycle_fixture import fixture,SOURCE,STAFF,MANAGER,CUSTOMER,OTHER,DEVICE,q
names=['staff-checkin.draft.sql','native-staff-authorization.draft.sql','native-reservation-lifecycle.draft.sql']
with fixture()as f:
 c,r=f.seed()
 for name in names:f.apply(name)
 assert f.sql("select to_regclass('oneshot_private.native_device_keys') is null")=='t'
 assert f.sql("select count(*) from pg_attribute where attrelid='oneshot_private.native_reservation_events'::regclass and attname='key_id' and not attisdropped")=='0'
 e=f.native(c,r);assert set(e['admission'])=={'version','deviceId','actorId','eventType','eventId','claimId','payload'}and e['admission']['version']==2
 before=f.snapshot()
 for user in [CUSTOMER,OTHER]:f.ack(f.resign(e['admission'],actor=user),user,error='STAFF_REQUIRED');assert f.snapshot()==before
 f.ack(e['admission'],MANAGER,error='NATIVE_EVENT_ACCOUNT_CHANGED');assert f.snapshot()==before
 for key,value,error in [('version',1,'INVALID_NATIVE_EVENT_VERSION'),('version','2','INVALID_NATIVE_EVENT_VERSION'),('actorId','not-uuid','INVALID_NATIVE_EVENT_IDENTIFIER'),('deviceId',str(uuid.uuid4()),'NATIVE_EVENT_CLAIM_MISMATCH'),('claimId',str(uuid.uuid4()),'NATIVE_EVENT_CLAIM_MISMATCH')]:
  bad=dict(e['admission']);bad[key]=value;f.ack(bad,error=error);assert f.snapshot()==before
 for extra in [{'keyId':str(uuid.uuid4())},{'signature':'0'*64},{'extra':True}]:f.ack(dict(e['admission'],**extra),error='INVALID_NATIVE_EVENT_ENVELOPE');assert f.snapshot()==before
 missing=dict(e['admission']);del missing['actorId'];f.ack(missing,error='INVALID_NATIVE_EVENT_ENVELOPE');assert f.snapshot()==before
 raw=e['admission']['payload'];bad=dict(e['admission'],payload=raw[:-1]+',"type":"admission"}');f.ack(bad,error='INVALID_NATIVE_EVENT_PAYLOAD');assert f.snapshot()==before
 f.ack(dict(e['admission'],payload='x'*1048577),error='NATIVE_EVENT_PAYLOAD_TOO_LARGE');assert f.snapshot()==before
 for field,value in [('cloudUserId',MANAGER),('tableId','other'),('reservationId','other')]:
  body=json.loads(raw);body[field]=value;f.ack(f.resign(e['admission'],body),error='NATIVE_EVENT_BODY_MISMATCH'if field=='reservationId'else'NATIVE_EVENT_ADMISSION_BINDING_MISMATCH');assert f.snapshot()==before
 f.checks.append('no key registry required; exact v2 only, customer/actor/claim/device/body/duplicate-key/size tampering rejects without mutation')
 mapping=lambda user=STAFF:json.loads(f.sql(f.user(user)+f"select public.oneshot_staff_native_table_mappings('{DEVICE}')"))
 assert mapping()=={'deviceId':DEVICE,'mappings':[{'tableId':c['tableId'],'cloudTableId':'CLOUD-1'}],'recordType':'staff-native-table-mappings','fundsTransferred':False}
 f.sql(f.user(CUSTOMER)+f"select public.oneshot_staff_native_table_mappings('{DEVICE}')",error='STAFF_REQUIRED')
 f.sql(f"update oneshot_private.checkin_table_mappings set coordinator_ready=false where device_id='{DEVICE}'");assert mapping()['mappings']==[];f.sql(f"update oneshot_private.checkin_table_mappings set coordinator_ready=true where device_id='{DEVICE}'")
 f.checks.append('fresh staff mapping read exposes only approved active ready physical-table IDs; unrelated customer denied')
 a=f.ack(e['admission']);before=f.snapshot()
 for change,restore in [(f"update oneshot_private.staff_memberships set active=false where user_id='{STAFF}'",f"update oneshot_private.staff_memberships set active=true where user_id='{STAFF}'"),(f"delete from auth.sessions where id='{f.sessions[STAFF]}'",f"insert into auth.sessions values('{f.sessions[STAFF]}','{STAFF}',null)"),(f"update auth.users set banned_until=clock_timestamp()+interval '1 day' where id='{STAFF}'",f"update auth.users set banned_until=null where id='{STAFF}'")]:
  f.sql(change);f.ack(e['admission'],error='STAFF_REQUIRED');f.sql(f.user()+f"select public.oneshot_staff_native_table_mappings('{DEVICE}')",error='STAFF_REQUIRED');f.sql(restore);assert f.snapshot()==before
 f.checks.append('membership revoked, session deleted, and user banned deny ACK replay and mapping lookup despite matching old JWT claims')
 assert f.ack(f.resign(e['admission'],actor=MANAGER),MANAGER)['ack']==a['ack'];assert f.snapshot()==before
 before=f.snapshot()
 for name in names*2:f.apply(name)
 assert f.snapshot()==before;f.checks.append('reapply staff authorization and lifecycle twice preserves exact accepted rows without key provisioning')
 f.ack(e['completion'])
 sample=json.loads(f.sql(f.user(CUSTOMER)+"select public.oneshot_customer_final_receipts(timezone('Asia/Manila',now())::date,timezone('Asia/Manila',now())::date)"))
 (SOURCE.parent/'output/playwright/staff-jwt-customer-final-receipt-sample.json').write_text(json.dumps(sample,indent=2))
 print(json.dumps({'passed':len(f.checks),'checks':f.checks,'liveWrites':False,'sourceHashes':{n:hashlib.sha256((SOURCE/n).read_bytes()).hexdigest()for n in names},'engine':f.sql('select version()')},indent=2))
