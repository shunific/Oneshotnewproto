#!/usr/bin/env python3
"""Exercise trusted cloud staff identity and receipt reads on disposable local PG17."""
from pathlib import Path
import json
import os
import subprocess
import tempfile
import time

pg=Path(os.environ.get('ONESHOT_TEST_PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
source=Path(__file__).parent
customer='11111111-1111-4111-8111-111111111111'
cashier='22222222-2222-4222-8222-222222222222'
manager='33333333-3333-4333-8333-333333333333'
object_id='44444444-4444-4444-8444-444444444444'
with tempfile.TemporaryDirectory(prefix='oneshot-staff-identity-') as directory:
    base=Path(directory)
    subprocess.run([str(pg/'initdb'),'-D',str(base/'db'),'-A','trust','-U','postgres','--no-locale'],check=True,stdout=subprocess.DEVNULL)
    with (base/'postgres.log').open('w') as log:
        process=subprocess.Popen([str(pg/'postgres'),'-D',str(base/'db'),'-k',str(base),'-p','54397','-h',''],stdout=log,stderr=log)
        try:
            def sql(query,ok=True,error_text=None):
                result=subprocess.run([str(pg/'psql'),'-X','-q','-v','ON_ERROR_STOP=1','-At','-h',str(base),'-p','54397','-U','postgres'],input=query,text=True,capture_output=True)
                assert (result.returncode==0)==ok,result.stderr or result.stdout
                if error_text:assert error_text in result.stderr,result.stderr
                return result.stdout.strip()
            for _ in range(100):
                if subprocess.run([str(pg/'pg_isready'),'-h',str(base),'-p','54397','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
                if process.poll() is not None:raise RuntimeError((base/'postgres.log').read_text())
                time.sleep(.05)
            else:raise RuntimeError('Disposable Postgres not ready')
            sql('''create role anon;create role authenticated;create schema auth;create schema storage;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,banned_until timestamptz,deleted_at timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
grant usage on schema auth,storage to anon,authenticated;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(bucket_id text,name text,owner_id text,metadata jsonb,primary key(bucket_id,name));
alter table storage.objects enable row level security;
grant select,insert,update,delete on storage.objects to anon,authenticated;
create policy legacy_read on storage.objects for select using(true);
create policy legacy_insert on storage.objects for insert with check(true);
create policy legacy_update on storage.objects for update using(true) with check(true);
create policy legacy_delete on storage.objects for delete using(true);
''')
            draft=(source/'staff-identity.draft.sql').read_text()
            sql(draft,False)
            for name in ['customer-identity.draft.sql','private-receipts.draft.sql','staff-identity.draft.sql']:
                sql("set oneshot.secure_gateway_cutover='reviewed';set oneshot.private_receipts_cutover='reviewed';\n"+(source/name).read_text())
            for user,label in [(customer,'customer'),(cashier,'cashier'),(manager,'manager')]:
                sql(f"insert into auth.users values ('{user}','{label}@example.invalid',now(),false,null,null);insert into auth.sessions values ('{user}','{user}',null)")
            def context(user):return f"set role authenticated;set request.jwt.claim.sub='{user}';set request.jwt.claims='{{\"session_id\":\"{user}\"}}';"
            path=f'{customer}/{object_id}.png'
            sql(context(customer)+f"insert into storage.objects values ('oneshot-receipts','{path}','{customer}','{{\"mimetype\":\"image/png\",\"contentLength\":9}}')")
            count="select count(*) from storage.objects where bucket_id='oneshot-receipts'"
            identity='select public.oneshot_staff_identity()'
            assert sql(context(customer)+count)=='1'
            assert sql(context(cashier)+count)=='0'
            sql(context(customer)+identity,False)
            sql(context(customer)+f"insert into oneshot_private.staff_memberships(user_id,role,active,approved_by) values ('{customer}','manager',true,'{customer}')",False)
            sql(context(customer)+"select * from oneshot_private.staff_memberships",False)
            spoof=context(customer)+f"set request.jwt.claims='{{\"session_id\":\"{customer}\",\"user_metadata\":{{\"isAdmin\":true,\"role\":\"manager\"}}}}';"
            sql(spoof+identity,False)
            assert sql(spoof+'select oneshot_private.verified_staff()')=='f'
            sql(f"insert into oneshot_private.staff_memberships(user_id,role) values ('{cashier}','cashier'),('{manager}','manager')")
            assert sql(context(cashier)+count)=='0'
            sql(context(cashier)+identity,False)
            sql(f"update oneshot_private.staff_memberships set active=true where user_id='{cashier}'",False)
            sql(f"update oneshot_private.staff_memberships set venue_id='other' where user_id='{cashier}'",False)
            sql(f"update oneshot_private.staff_memberships set role='superadmin' where user_id='{cashier}'",False)
            sql(f"update oneshot_private.staff_memberships set approved_by='{customer}',active=true")
            for user,role in [(cashier,'cashier'),(manager,'manager')]:
                result=json.loads(sql(context(user)+identity))
                assert result==dict(userId=user,venueId='oneshot',role=role,email=f'{role}@example.invalid')
                assert sql(context(user)+count)=='1'
                assert sql(context(user)+'select oneshot_private.verified_staff()')=='t'
                sql(context(user)+"select * from oneshot_private.staff_memberships",False)
                sql(context(user)+"update oneshot_private.staff_memberships set role='manager'",False)
                sql(context(user)+f"insert into storage.objects values ('oneshot-receipts','{customer}/55555555-5555-4555-8555-555555555555.png','{customer}','{{}}')",False)
                assert sql(context(user)+"with changed as (update storage.objects set metadata='{}' where bucket_id='oneshot-receipts' returning *)select count(*) from changed")=='0'
                assert sql(context(user)+"with removed as (delete from storage.objects where bucket_id='oneshot-receipts' returning *)select count(*) from removed")=='0'
            for update,reset in [
                (f"update auth.users set banned_until=now()+interval '1 day' where id='{cashier}'",f"update auth.users set banned_until=null where id='{cashier}'"),
                (f"update auth.users set deleted_at=now() where id='{cashier}'",f"update auth.users set deleted_at=null where id='{cashier}'"),
                (f"update auth.sessions set not_after=now()-interval '1 second' where id='{cashier}'",f"update auth.sessions set not_after=null where id='{cashier}'"),
                (f"delete from auth.sessions where id='{cashier}'",f"insert into auth.sessions values ('{cashier}','{cashier}',null)"),
                (f"update oneshot_private.staff_memberships set active=false where user_id='{cashier}'",f"update oneshot_private.staff_memberships set active=true where user_id='{cashier}'")]:
                sql(update)
                sql(context(cashier)+identity,False)
                assert sql(context(cashier)+count)=='0'
                assert sql(context(manager)+count)=='1'
                sql(reset)
            for claims in ['{}','{"session_id":"malformed"}',f'{{"session_id":"{customer}"}}']:
                denied=context(cashier)+f"set request.jwt.claims='{claims}';"
                sql(denied+identity,False)
                assert sql(denied+count)=='0'
            assert sql('set role anon;select oneshot_private.verified_staff()')=='f'
            assert sql('set role anon;'+count)=='0'
            sql('set role anon;'+identity,False)
            assert sql("select count(*) from pg_proc where pronamespace='oneshot_private'::regnamespace and proname in ('staff_role','verified_staff','staff_identity') and prosecdef and proconfig=array['search_path=\"\"']")=='3'
            assert sql("select prosecdef from pg_proc where proname='oneshot_staff_identity'")=='f'
            # Reapplication retains authoritative active AND deactivated rows.
            gated="set oneshot.secure_gateway_cutover='reviewed';"
            sql(f"update oneshot_private.staff_memberships set active=false where user_id='{cashier}'")
            member_rows="select jsonb_agg(to_jsonb(m) order by user_id)::text from oneshot_private.staff_memberships m"
            unchanged=sql(member_rows)
            sql(gated+draft);sql(gated+draft)
            assert sql(member_rows)==unchanged
            sql(context(cashier)+identity,False)
            assert json.loads(sql(context(manager)+identity))['role']=='manager'
            definition="""select jsonb_build_object('owner',c.relowner,'columns',
              (select jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull,a.attacl,a.attinhcount,a.attislocal,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
               from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
              'constraints',(select jsonb_agg(pg_get_constraintdef(k.oid) order by k.conname) from pg_constraint k where k.conrelid=c.oid),
              'inherits',(select count(*) from pg_inherits i where i.inhrelid=c.oid or i.inhparent=c.oid))::text
              from pg_class c where c.oid='oneshot_private.staff_memberships'::regclass"""
            baseline=sql(definition)
            sql('create table auth.other_users(id uuid primary key);insert into auth.other_users select id from auth.users')
            sql('create table public.leaky_staff_parent (like oneshot_private.staff_memberships including defaults)')
            sql('grant select,update on public.leaky_staff_parent to authenticated')
            sql('create table public.leaky_staff_child (like oneshot_private.staff_memberships including defaults including constraints)')
            cases=[
              ('unsafe active default',"alter table oneshot_private.staff_memberships alter column active set default true", "alter table oneshot_private.staff_memberships alter column active set default false"),
              ('changed timestamp default',"alter table oneshot_private.staff_memberships alter column created_at set default clock_timestamp()", "alter table oneshot_private.staff_memberships alter column created_at set default now()"),
              ('nullable role',"alter table oneshot_private.staff_memberships alter column role drop not null", "alter table oneshot_private.staff_memberships alter column role set not null"),
              ('wrong column type',"alter table oneshot_private.staff_memberships alter column role type varchar", "alter table oneshot_private.staff_memberships alter column role type text;alter table oneshot_private.staff_memberships drop constraint staff_memberships_role_check;alter table oneshot_private.staff_memberships add constraint staff_memberships_role_check check(role in ('cashier','manager'))"),
              ('extra column',"alter table oneshot_private.staff_memberships add column unsafe_role text", "alter table oneshot_private.staff_memberships drop column unsafe_role"),
              ('weak role check',"alter table oneshot_private.staff_memberships drop constraint staff_memberships_role_check;alter table oneshot_private.staff_memberships add constraint staff_memberships_role_check check(role in ('cashier','manager','owner'))", "alter table oneshot_private.staff_memberships drop constraint staff_memberships_role_check;alter table oneshot_private.staff_memberships add constraint staff_memberships_role_check check(role in ('cashier','manager'))"),
              ('missing approval check',"alter table oneshot_private.staff_memberships drop constraint staff_memberships_check", "alter table oneshot_private.staff_memberships add constraint staff_memberships_check check(not active or approved_by is not null)"),
              ('unvalidated role check',"alter table oneshot_private.staff_memberships drop constraint staff_memberships_role_check;alter table oneshot_private.staff_memberships add constraint staff_memberships_role_check check(role in ('cashier','manager')) not valid", "alter table oneshot_private.staff_memberships validate constraint staff_memberships_role_check"),
              ('wrong foreign target',"alter table oneshot_private.staff_memberships drop constraint staff_memberships_approved_by_fkey;alter table oneshot_private.staff_memberships add constraint staff_memberships_approved_by_fkey foreign key(approved_by) references auth.other_users(id)", "alter table oneshot_private.staff_memberships drop constraint staff_memberships_approved_by_fkey;alter table oneshot_private.staff_memberships add constraint staff_memberships_approved_by_fkey foreign key(approved_by) references auth.users(id)"),
              ('unvalidated foreign key',"alter table oneshot_private.staff_memberships drop constraint staff_memberships_approved_by_fkey;alter table oneshot_private.staff_memberships add constraint staff_memberships_approved_by_fkey foreign key(approved_by) references auth.users(id) not valid", "alter table oneshot_private.staff_memberships validate constraint staff_memberships_approved_by_fkey"),
              ('wrong primary key',"alter table oneshot_private.staff_memberships drop constraint staff_memberships_pkey;alter table oneshot_private.staff_memberships add constraint staff_memberships_pkey primary key(user_id,venue_id)", "alter table oneshot_private.staff_memberships drop constraint staff_memberships_pkey;alter table oneshot_private.staff_memberships add constraint staff_memberships_pkey primary key(user_id)"),
              ('column-level promotion grants',"grant update(active,role,approved_by) on oneshot_private.staff_memberships to authenticated", "revoke all(active,role,approved_by) on oneshot_private.staff_memberships from authenticated"),
              ('inherited accessible parent',"alter table oneshot_private.staff_memberships inherit public.leaky_staff_parent", "alter table oneshot_private.staff_memberships no inherit public.leaky_staff_parent"),
              ('untrusted inheritance child',"alter table public.leaky_staff_child inherit oneshot_private.staff_memberships", "alter table public.leaky_staff_child no inherit oneshot_private.staff_memberships"),
              ('client-owned relation',"alter table oneshot_private.staff_memberships owner to authenticated", "alter table oneshot_private.staff_memberships owner to postgres"),
            ]
            rejected=[]
            for label,weaken,restore in cases:
                sql(weaken)
                malformed=sql(definition);before_rows=sql(member_rows)
                sql(gated+draft,False,'incompatible existing staff membership')
                assert sql(definition)==malformed,(label,'Schema mutated despite rejection')
                assert sql(member_rows)==before_rows,(label,'Authoritative rows mutated despite rejection')
                sql(restore)
                # Empty explicit column ACLs are safe but are not the canonical NULL shape.
                if label=='column-level promotion grants':
                    assert sql("select count(*) from pg_attribute where attrelid='oneshot_private.staff_memberships'::regclass and attacl is not null and cardinality(attacl)>0")=='0'
                else:assert sql(definition)==baseline,(label,'Fixture schema restoration changed')
                rejected.append(label)
            # Revoke-column restores canonical NULL ACL in PostgreSQL; prove ordinary reapply again.
            sql(gated+draft)
            assert sql(member_rows)==unchanged
            print(f'PASS: reapply preserves active/revoked rows; {len(rejected)} malformed schema variants rejected before mutations: '+', '.join(rejected))
            print('PASS: gated trusted staff identity; no self-enrollment, membership reads/writes or metadata promotion; owner-approved fixed-venue cashier/manager identity and cross-customer receipt reads; no staff receipt mutation/upload by role; inactive/deactivated/banned/deleted/revoked/expired/malformed/cross-owner session denial; anonymous denial; fixed search paths and invoker wrapper.')
            print('LIMIT: disposable PostgreSQL role/JWT fixture only; no live memberships, real Supabase tokens/Storage download, staff UI login, live policy rollout or operational approval verified.')
        finally:
            process.terminate();process.wait(timeout=10)
