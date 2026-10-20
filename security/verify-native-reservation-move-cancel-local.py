#!/usr/bin/env python3
"""Cancellation SQL behavior on disposable PG; no hosted mutations."""
import copy,hashlib,json,uuid
from native_lifecycle_fixture import fixture,SOURCE,STAFF,DEVICE,MANAGER,q
chain=['staff-checkin.draft.sql','native-device-proof.draft.sql','native-reservation-lifecycle.draft.sql','native-reservation-moves.draft.sql','native-reservation-move-cancel.draft.sql']
with fixture() as f:
 c,r=f.seed()
 for name in chain[:4]:f.apply('fixtures/rc14/'+name)
 f.enroll();e=f.native(c,r);admitted=f.ack(e['admission'])
 for target in ['B','C','X']:
  f.sql(f"insert into tables(id,name,status,isactive,\"isActive\") values ('CLOUD-{target}','QA target','available',1,1);insert into oneshot_private.checkin_table_mappings(device_id,native_table_id,cloud_table_id,active,coordinator_ready,approved_by) values ('{DEVICE}','LOCAL-{target}','CLOUD-{target}',true,true,'{MANAGER}')")
 f.sql("insert into system_settings(key_name,setting_value) select key,to_char(timezone('Asia/Manila',clock_timestamp())+case when key like '%StartTime' then interval '-8 hours' else interval '8 hours' end,'HH24:MI') from unnest(array['weekdayStartTime','weekendStartTime','weekdayEndTime','weekendEndTime']) key on conflict(key_name) do update set setting_value=excluded.setting_value")
 def prepare(target,revision):
  ident=str(uuid.uuid4());b=dict(version=1,eventId=ident,type='reservation-move-prepare',moveId=str(uuid.uuid4()),prepareEventId=ident,claimId=r['claim']['claimId'],reservationId=c['id'],deviceId=DEVICE,claimRequestId=c['requestId'],admissionEventId=admitted['ack']['eventId'],sourceTableId=c['tableId'],targetTableId=target,positionSequence=1,previousPositionEventId=admitted['ack']['eventId'],expectedRevision=revision,localStaffId='qa-native-staff',cloudUserId=STAFF,sessionStartTime=json.loads(e['admission']['payload'])['sessionStartTime'])
  return f.resign(dict(e['admission'],eventType=b['type'],eventId=ident),b)
 def cancel(p):
  b=json.loads(p['payload']);b.update(eventId=str(uuid.uuid4()),type='reservation-move-cancel',preparePayload=p['payload'],preparePayloadSha256=hashlib.sha256(p['payload'].encode()).hexdigest())
  return f.resign(dict(p,eventType=b['type'],eventId=b['eventId']),b)
 revision=admitted['ack']['revision']
 legacy_prepare=prepare('LOCAL-B',revision);legacy_permit=f.ack(legacy_prepare)
 legacy_body=json.loads(legacy_prepare['payload']);legacy_body.update(eventId=str(uuid.uuid4()),type='reservation-move-abort',expectedRevision=legacy_permit['ack']['revision'])
 legacy_abort=f.resign(dict(legacy_prepare,eventType=legacy_body['type'],eventId=legacy_body['eventId']),legacy_body);legacy_result=f.ack(legacy_abort);revision=legacy_result['ack']['revision']
 old_c,old_r=f.seed();old_e=f.native(old_c,old_r);f.ack(old_e['admission']);f.ack(old_e['completion'])
 old_snapshot=json.loads(f.snapshot())
 for name in chain:f.apply(name)
 new_snapshot=json.loads(f.snapshot());new_snapshot.pop('oneshot_private.native_move_cancellations')
 assert old_snapshot==new_snapshot and f.ack(legacy_abort)['ack']==legacy_result['ack']
 f.checks.append('exact RC14 archived sources with classic abort and completed receipt upgrade without rewriting any existing row or historical ACK')
 before=f.snapshot();f.ack(cancel(legacy_prepare),error='NATIVE_MOVE_ALREADY_TERMINAL');assert f.snapshot()==before
 p=prepare('LOCAL-B',revision)
 f.sql("update tables set status='maintenance' where id='CLOUD-B'");f.ack(p,error='NATIVE_MOVE_TARGET_UNAVAILABLE')
 cancelled=cancel(p)
 original=json.loads(cancelled['payload'])
 for key,value,error in [
  ('preparePayloadSha256','0'*64,'NATIVE_MOVE_CANCEL_PREPARE_MISMATCH'),('preparePayload',False,'NATIVE_MOVE_CANCEL_INVALID_PAYLOAD'),
  ('preparePayloadSha256',1,'NATIVE_MOVE_CANCEL_INVALID_PAYLOAD'),('expectedRevision',revision+1,'NATIVE_MOVE_CANCEL_PREPARE_MISMATCH'),
  ('cloudUserId','wrong','NATIVE_MOVE_INVALID_IDENTIFIER'),('extra',True,'NATIVE_LIFECYCLE_INVALID_FIELDS'),('version',2,'NATIVE_MOVE_CANCEL_INVALID_PAYLOAD')]:
  bad=copy.deepcopy(original);bad[key]=value;before=f.snapshot();f.ack(f.resign(cancelled,bad),error=error);assert f.snapshot()==before
 duplicate=copy.deepcopy(original);duplicate['preparePayload']=p['payload'][:-1]+',"moveId":'+json.dumps(json.loads(p['payload'])['moveId'])+'}';duplicate['preparePayloadSha256']=hashlib.sha256(duplicate['preparePayload'].encode()).hexdigest()
 before=f.snapshot();f.ack(f.resign(cancelled,duplicate),error='NATIVE_MOVE_CANCEL_PREPARE_MISMATCH');assert f.snapshot()==before
 fake_base=json.loads(p['payload']);fake_base['expectedRevision']=revision+1;fake_prepare=f.resign(p,fake_base);fake_cancel=cancel(fake_prepare)
 before=f.snapshot();f.ack(fake_cancel,error='NATIVE_MOVE_CANCEL_STALE_REVISION');assert f.snapshot()==before
 f.checks.append('new valid HMAC cannot change embedded exact prepare/hash/base or introduce duplicate JSON keys, invalid metadata or extra fields')
 a=f.ack(cancelled);assert a['ack']['revision']==revision+2 and a['ack']['state']=='move-cancelled';revision+=2
 assert f.sql('select count(*) from oneshot_private.native_move_operations')=='1'
 assert f.sql('select count(*) from oneshot_private.native_move_cancellations')=='1'
 assert f.sql("select status from tables where id='CLOUD-B'")=='maintenance'
 f.ack(p,error='NATIVE_MOVE_CANCELLED')
 before=f.snapshot();assert f.ack(cancelled)['ack']==a['ack'] and f.snapshot()==before
 assert f.ack(f.resign(cancelled,actor=MANAGER),MANAGER)['ack']==a['ack']
 changed=json.loads(cancelled['payload']);changed['localStaffId']='changed';before=f.snapshot();f.ack(f.resign(cancelled,changed),error='NATIVE_EVENT_IDEMPOTENCY_CONFLICT');assert f.snapshot()==before
 for mode in ['membership','key']:
  table='staff_memberships' if mode=='membership' else 'native_device_keys';column='user_id' if mode=='membership' else 'key_id';value=STAFF if mode=='membership' else f.key_id
  f.sql(f"update oneshot_private.{table} set active=false where {column}={q(value)}")
  f.ack(cancelled,error='STAFF_REQUIRED' if mode=='membership' else 'NATIVE_DEVICE_KEY_REQUIRED')
  f.sql(f"update oneshot_private.{table} set active=true where {column}={q(value)}")
 f.checks.append('exact cancellation replay remains fresh-account/device guarded and changed-payload retries cannot rewrite original ACK')
 f.checks.append('never-accepted move cancels durably at base+2 without fabricating prepare audit or touching unavailable target')
 # Accepted hold cleanup follows its immutable allocation despite changed mappings.
 p=prepare('LOCAL-C',revision);permit=f.ack(p);assert permit['ack']['revision']==revision+1
 f.sql("update oneshot_private.checkin_table_mappings set active=false,coordinator_ready=false,cloud_table_id='CLOUD-X' where native_table_id='LOCAL-C';update tables set status='maintenance' where id='CLOUD-C'")
 target_before=f.sql("select to_jsonb(t) from tables t where id='CLOUD-X'")
 cancelled=cancel(p);a=f.ack(cancelled);revision+=2;assert a['ack']['revision']==revision
 assert f.sql("select status||':'||(sessiondata is null)::text from tables where id='CLOUD-C'")=='maintenance:true'
 assert f.sql("select to_jsonb(t) from tables t where id='CLOUD-X'")==target_before
 assert f.ack(p)['ack']==permit['ack']
 assert f.sql("select count(*) from oneshot_private.active_checkin_tables where allocation_kind='move-target'")=='0'
 f.checks.append('accepted permit cancellation releases original allocation after mapping remap/deactivation while preserving maintenance and unrelated mapped table')
 # Cleanup must not overwrite a different public occupant, even if an
 # operator changed the public marker after this private hold was issued.
 p=prepare('LOCAL-X',revision);f.ack(p)
 f.sql("update tables set status='occupied',sessiondata='unrelated occupant',\"sessionData\"='unrelated occupant' where id='CLOUD-X'")
 unrelated=f.sql("select to_jsonb(t) from tables t where id='CLOUD-X'")
 cancelled=cancel(p);a=f.ack(cancelled);revision+=2
 assert f.sql("select to_jsonb(t) from tables t where id='CLOUD-X'")==unrelated
 assert f.sql("select count(*) from oneshot_private.active_checkin_tables where allocation_kind='move-target'")=='0'
 f.checks.append('accepted cancellation removes only its private hold and preserves unrelated public occupation byte-for-byte')
 # A cloud-committed move cannot be undone by signing a no-commit assertion.
 saved=(c,r,e,admitted)
 c,r=f.seed();e=f.native(c,r);admitted=f.ack(e['admission']);f.sql("update tables set status='available' where id='CLOUD-B'")
 committed_prepare=prepare('LOCAL-B',admitted['ack']['revision']);committed_permit=f.ack(committed_prepare)
 commit_body=json.loads(committed_prepare['payload']);commit_body.update(eventId=str(uuid.uuid4()),type='reservation-move-commit',expectedRevision=committed_permit['ack']['revision'])
 committed_event=f.resign(dict(committed_prepare,eventType=commit_body['type'],eventId=commit_body['eventId']),commit_body);f.ack(committed_event)
 before=f.snapshot();f.ack(cancel(committed_prepare),error='NATIVE_MOVE_POSITION_MISMATCH');assert f.snapshot()==before
 c,r,e,admitted=saved
 f.checks.append('classic-aborted and cloud-committed moves reject new no-commit cancellations without changing their original terminal or occupation')
 body=json.loads(e['completion']['payload']);body.update(version=2,expectedRevision=revision,positionSequence=0,previousPositionEventId=admitted['ack']['eventId'])
 closed=f.ack(f.resign(e['completion'],body));assert closed['ack']['revision']==revision+1
 f.checks.append('completion uses cancellation revisions without changing original table position, timer or receipt finances')
 before=f.snapshot()
 for name in chain*2:f.apply(name)
 assert f.snapshot()==before
 for statement in ['select * from oneshot_private.native_move_cancellations','delete from oneshot_private.native_move_cancellations']:
  f.sql(f.user()+statement,error='permission denied')
 f.sql('update oneshot_private.native_move_cancellations set base_revision=base_revision+1',error='CHECKIN_AUDIT_IMMUTABLE')
 f.checks.append('five-source reapply preserves cancellations and all existing rows; cancellation audit remains private and immutable')
 draft=(SOURCE/'native-reservation-move-cancel.draft.sql').read_text()
 before=f.snapshot()
 for mutation in ['alter table oneshot_private.native_move_cancellations alter prepare_payload drop not null','alter table oneshot_private.native_move_cancellations drop constraint native_move_cancellations_target_cloud_table_id_fkey','grant select(prepare_payload) on oneshot_private.native_move_cancellations to authenticated','alter table oneshot_private.native_move_cancellations drop constraint native_move_cancellations_prepare_event_id_key']:
  f.sql("begin;"+mutation+";set oneshot.secure_gateway_cutover='reviewed';"+draft,error='INCOMPATIBLE_NATIVE_MOVE_CANCEL_');assert f.snapshot()==before
 f.checks.append('weak existing cancellation schema/unique/FK/columnACL variants fail atomically and preserve every audited row')
 print(json.dumps(dict(passed=len(f.checks),checks=f.checks,liveWrites=False,sourceHashes={n:hashlib.sha256((SOURCE/n).read_bytes()).hexdigest() for n in chain},limits=['Synthetic device envelopes plus actual native admission/receipt fixtures; independent native cancellation duplex is separate.']),indent=2))
