#!/usr/bin/env python3
"""Integrated local move SQL checks; synthetic device signatures, no hosted state."""
import concurrent.futures,copy,datetime,hashlib,json,uuid
from native_lifecycle_fixture import fixture,SOURCE,STAFF,DEVICE,MANAGER,q
with fixture() as f:
 c,r=f.seed();f.apply('fixtures/rc13/staff-checkin.draft.sql');f.apply('fixtures/rc13/native-device-proof.draft.sql');f.enroll();f.apply('fixtures/rc13/native-reservation-lifecycle.draft.sql');e=f.native(c,r);admitted=f.ack(e['admission'])
 c_old,r_old=f.seed();e_old=f.native(c_old,r_old);f.ack(e_old['admission']);f.ack(e_old['completion'])
 # Snapshot actual RC13-compatible rows before the known-shape upgrade.
 old=f.snapshot()
 audit_query="select jsonb_build_object('claims',(select jsonb_agg(to_jsonb(c)) from oneshot_private.checkin_claims c),'events',(select jsonb_agg(to_jsonb(e)) from oneshot_private.native_reservation_events e),'payments',(select jsonb_agg(to_jsonb(p)) from oneshot_private.staff_payment_verifications p),'receipts',(select jsonb_agg(to_jsonb(f)) from oneshot_private.native_final_receipts f))"
 old_audit=f.sql(audit_query)
 for source in ['staff-checkin.draft.sql','native-device-proof.draft.sql','native-reservation-lifecycle.draft.sql','native-reservation-moves.draft.sql']:f.apply(source)
 assert old_audit==f.sql(audit_query)
 f.checks.append('exact archived RC13 candidate with actual admission/payment audit upgrades without rewriting any immutable row')
 assert f.sql("select count(*) from oneshot_private.native_move_upgrades")=='1'
 # Reviewed operating window encloses this test's actual clock, including midnight.
 f.sql("insert into system_settings(key_name,setting_value) select key,to_char(timezone('Asia/Manila',clock_timestamp())+case when key like '%StartTime' then interval '-8 hours' else interval '8 hours' end,'HH24:MI') from unnest(array['weekdayStartTime','weekendStartTime','weekdayEndTime','weekendEndTime']) key on conflict(key_name) do update set setting_value=excluded.setting_value")
 for label in ['B','C']:
  f.sql(f"insert into tables(id,name,status,isactive,\"isActive\") values ('CLOUD-{label}','QA target {label}','available',1,1);insert into oneshot_private.checkin_table_mappings(device_id,native_table_id,cloud_table_id,active,coordinator_ready,approved_by) values ('{DEVICE}','LOCAL-{label}','CLOUD-{label}',true,true,'{MANAGER}')")
 def event(kind,source,target,revision,seq,previous,move_id=None,prepare_id=None):
  ident=str(uuid.uuid4());body=dict(version=1,eventId=ident,type=kind,moveId=move_id or str(uuid.uuid4()),prepareEventId=prepare_id or ident,claimId=r['claim']['claimId'],reservationId=c['id'],deviceId=DEVICE,claimRequestId=c['requestId'],admissionEventId=admitted['ack']['eventId'],sourceTableId=source,targetTableId=target,positionSequence=seq,previousPositionEventId=previous,expectedRevision=revision,localStaffId='qa-native-staff',cloudUserId=STAFF,sessionStartTime=json.loads(e['admission']['payload'])['sessionStartTime'])
  envelope=dict(e['admission'],eventType=kind,eventId=ident);return f.resign(envelope,body),body
 current=c['tableId'];revision=admitted['ack']['revision'];previous=admitted['ack']['eventId'];seq=0
 # Newly signed malformed prepare bodies cannot acquire a target.
 clean,clean_body=event('reservation-move-prepare',current,'LOCAL-B',revision,1,previous)
 for key,value,error in [
  ('positionSequence',1.5,'NATIVE_LIFECYCLE_INVALID_CENTS'),('positionSequence','1','NATIVE_LIFECYCLE_INVALID_CENTS'),
  ('expectedRevision',revision-1,'NATIVE_MOVE_STALE_REVISION'),('previousPositionEventId',str(uuid.uuid4()),'NATIVE_MOVE_POSITION_MISMATCH'),
  ('admissionEventId',str(uuid.uuid4()),'NATIVE_MOVE_ADMISSION_MISMATCH'),('sourceTableId','LOCAL-C','NATIVE_MOVE_POSITION_MISMATCH'),
  ('prepareEventId',str(uuid.uuid4()),'NATIVE_MOVE_ALREADY_PREPARED'),('extra',True,'NATIVE_LIFECYCLE_INVALID_FIELDS'),
  ('targetTableId',' LOCAL-B','NATIVE_MOVE_INVALID_IDENTIFIER'),('version',2,'NATIVE_MOVE_INVALID_VERSION')]:
  bad=copy.deepcopy(clean_body);bad[key]=value;before=f.snapshot();f.ack(f.resign(clean,bad),error=error);assert f.snapshot()==before
 for column in ['active','coordinator_ready']:
  f.sql(f"update oneshot_private.checkin_table_mappings set {column}=false where native_table_id='LOCAL-B'")
  before=f.snapshot();f.ack(clean,error='CHECKIN_COORDINATOR_NOT_READY');assert f.snapshot()==before
  f.sql(f"update oneshot_private.checkin_table_mappings set {column}=true where native_table_id='LOCAL-B'")
 for status in ['maintenance','occupied','reserved','event']:
  f.sql(f"update public.tables set status={q(status)} where id='CLOUD-B'");before=f.snapshot();f.ack(clean,error='NATIVE_MOVE_TARGET_UNAVAILABLE');assert f.snapshot()==before
 f.sql("update tables set status='available' where id='CLOUD-B'")
 f.checks.append('strict types, stale position/revision, invalid identities, disabled mappings and unavailable targets fail before allocation')
 for statement,cleanup,error in [
  ("insert into closed_dates(id,closed_date,is_full_day,status) values ('QA-MOVE-CLOSED',timezone('Asia/Manila',clock_timestamp())::date,true,'active')","delete from closed_dates where id='QA-MOVE-CLOSED'",'NATIVE_MOVE_CLOSED_DATE'),
  ("insert into events(id,date,iscancelled,status) values ('QA-MOVE-EVENT',timezone('Asia/Manila',clock_timestamp())::date,0,'active')","delete from events where id='QA-MOVE-EVENT'",'NATIVE_MOVE_EVENT_ALLOCATION_REQUIRED'),
  ("insert into reservations(id,date,\"timeSlot\",\"durationHours\",\"tableId\",status) values ('QA-MOVE-CONFLICT',timezone('Asia/Manila',clock_timestamp())::date,to_char(timezone('Asia/Manila',clock_timestamp()),'HH24:MI'),1,'CLOUD-B','confirmed')","delete from reservations where id='QA-MOVE-CONFLICT'",'NATIVE_MOVE_TARGET_BOOKING_CONFLICT'),
 ]:
  f.sql(statement);before=f.snapshot();f.ack(clean,error=error);assert f.snapshot()==before;f.sql(cleanup)
 f.checks.append('reviewed operating-window checks reject full closure, active event allocation and existing target booking overlap')

 # Late accepted-event insert cannot leave a target hold or changed revision.
 f.sql("create function oneshot_private.qa_move_fail() returns trigger language plpgsql as $$begin raise exception 'QA_MOVE_LATE_FAILURE';end$$;create trigger qa_move_fail before insert on oneshot_private.active_checkin_tables for each row execute function oneshot_private.qa_move_fail()")
 before=f.snapshot();f.ack(clean,error='QA_MOVE_LATE_FAILURE');assert f.snapshot()==before
 f.sql('drop trigger qa_move_fail on oneshot_private.active_checkin_tables;drop function oneshot_private.qa_move_fail()')
 f.checks.append('late target allocation failure rolls back event, plan, revision and table projection together')
 # An irreversible no-commit abort advances revision, not position.
 first_prepare=f.ack(clean);revision=first_prepare['ack']['revision']
 assert f.sql("select status from tables where id='CLOUD-B'")=='reserved'
 before=f.snapshot();f.sql(f.user()+"delete from oneshot_private.active_checkin_tables",error='permission denied');assert f.snapshot()==before
 abort,abort_body=event('reservation-move-abort',current,'LOCAL-B',revision,1,previous,clean_body['moveId'],clean_body['prepareEventId'])
 aborted=f.ack(abort);revision=aborted['ack']['revision'];assert aborted['ack']['state']=='move-aborted'
 assert f.sql("select status from tables where id='CLOUD-B'")=='available'
 position=json.loads(f.sql('select oneshot_private.native_position('+q(r['claim']['claimId'])+'::uuid)'));assert position['positionSequence']==0 and position['positionEventId']==previous
 before=f.snapshot();assert f.ack(abort)['ack']==aborted['ack'] and f.snapshot()==before
 wrong_terminal,_=event('reservation-move-commit',current,'LOCAL-B',revision-1,1,previous,clean_body['moveId'],clean_body['prepareEventId']);f.ack(wrong_terminal,error='NATIVE_MOVE_STALE_REVISION')
 f.checks.append('abort releases only its hold, preserves position, advances revision and rejects later opposite terminal')

 for target in ['LOCAL-B','LOCAL-C',c['tableId']]:
  prepare,b=event('reservation-move-prepare',current,target,revision,seq+1,previous);p=f.ack(prepare);assert p['ack']['state']=='move-prepared';revision+=1
  assert f.sql("select count(*) from oneshot_private.active_checkin_tables where allocation_kind='move-target'")=='1'
  assert f.ack(prepare)['ack']==p['ack']
  terminal,t=event('reservation-move-commit',current,target,revision,seq+1,previous,b['moveId'],b['prepareEventId']);a=f.ack(terminal);assert a['ack']['state']=='moved';revision+=1;seq+=1;current=target;previous=t['eventId']
  assert f.sql("select count(*) from oneshot_private.active_checkin_tables")=='1'
  assert f.ack(terminal)['ack']==a['ack']
 f.checks.append('A-to-B-to-C-to-A move sequences preserve immutable initial admission and exactly one current allocation')
 # v2 completion binds the latest committed position and revised booking row.
 body=json.loads(e['completion']['payload']);body.update(version=2,expectedRevision=revision,positionSequence=seq,previousPositionEventId=previous)
 done=f.ack(f.resign(e['completion'],body));assert done['ack']['revision']==revision+1
 assert f.sql('select count(*) from oneshot_private.active_checkin_tables')=='0'
 f.checks.append('v2 completion publishes unchanged actual native financial receipt and releases latest current allocation')
 before=f.snapshot();assert f.ack(clean)['ack']==first_prepare['ack'] and f.ack(abort)['ack']==aborted['ack'];assert f.snapshot()==before
 for name in ['native_move_operations','native_move_terminals','native_move_upgrades']:
  f.sql(f.user()+f'select * from oneshot_private.{name}',error='permission denied')
  f.sql(f'update oneshot_private.{name} set '+('created_at=now()' if name!='native_move_terminals' else "event_type='reservation-move-abort'"),error='CHECKIN_AUDIT_IMMUTABLE')
 f.checks.append('old move retries after completion are immutable; all new audit tables remain private and update/delete frozen')

 # Real acknowledged booking near the JS-safe revision ceiling must not issue
 # a move permit whose terminal/completion could no longer be acknowledged.
 saved=(c,r,e,admitted)
 c,r=f.seed(revision=9007199254740986);e=f.native(c,r);admitted=f.ack(e['admission'])
 assert admitted['ack']['revision']==9007199254740989
 bound,_=event('reservation-move-prepare',c['tableId'],'LOCAL-B',admitted['ack']['revision'],1,admitted['ack']['eventId'])
 before=f.snapshot();f.ack(bound,error='NATIVE_MOVE_STALE_REVISION');assert f.snapshot()==before
 c,r=f.seed(revision=9007199254740985);e=f.native(c,r);admitted=f.ack(e['admission'])
 assert admitted['ack']['revision']==9007199254740988
 permit,pb=event('reservation-move-prepare',c['tableId'],'LOCAL-B',admitted['ack']['revision'],1,admitted['ack']['eventId']);pa=f.ack(permit)
 commit,cb=event('reservation-move-commit',c['tableId'],'LOCAL-B',pa['ack']['revision'],1,admitted['ack']['eventId'],pb['moveId'],pb['prepareEventId']);ca=f.ack(commit)
 completion=json.loads(e['completion']['payload']);completion.update(version=2,expectedRevision=ca['ack']['revision'],positionSequence=1,previousPositionEventId=cb['eventId'],checkoutTableId='LOCAL-B');completion['receipt'].update(table_id='LOCAL-B',table_name='QA target B');completion['history'].update(tableId='LOCAL-B',tableName='QA target B')
 last=f.ack(f.resign(e['completion'],completion));assert last['ack']['revision']==9007199254740991
 c,r,e,admitted=saved
 f.checks.append('near-safe-integer revision rejects insufficient headroom but accepts final safe prepare/commit/completion at MAX_SAFE exactly')
 before=f.snapshot()
 for source in ['staff-checkin.draft.sql','native-device-proof.draft.sql','native-reservation-lifecycle.draft.sql','native-reservation-moves.draft.sql']*2:f.apply(source)
 assert f.snapshot()==before
 draft=(SOURCE/'native-reservation-moves.draft.sql').read_text()
 for mutation in [
  'alter table oneshot_private.native_move_operations alter prepare_body drop not null',
  'alter table oneshot_private.native_move_terminals drop constraint native_move_terminals_event_id_key',
  'grant select(prepare_body) on oneshot_private.native_move_operations to authenticated',
  'drop index oneshot_private.checkin_one_current',
  'alter table oneshot_private.active_checkin_tables drop constraint active_checkin_tables_move_id_fkey',
 ]:
  f.sql("begin;"+mutation+";set oneshot.secure_gateway_cutover='reviewed';"+draft,error='INCOMPATIBLE_NATIVE_MOVE_');assert f.snapshot()==before
 f.checks.append('weak existing operation/terminal/registry/columnACL shapes reject atomically without changing existing rows')
 print(json.dumps(dict(passed=len(f.checks),checks=f.checks,liveWrites=False,sourceHashes={n:hashlib.sha256((SOURCE/n).read_bytes()).hexdigest() for n in ['staff-checkin.draft.sql','native-device-proof.draft.sql','native-reservation-lifecycle.draft.sql','native-reservation-moves.draft.sql']},limits=['Move phase signatures are independently generated Python HMAC fixtures until the actual native coordinator bridge is integrated.','No live activation or venue-approved overdue occupancy policy; conservative reviewed-close rule requires venue validation.']),indent=2))
