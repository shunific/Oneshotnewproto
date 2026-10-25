#!/usr/bin/env python3
"""Run the private receipt draft in a disposable PG fixture; no remote connections."""
from pathlib import Path
import os
import subprocess
import tempfile
import time

pg = Path(os.environ.get('ONESHOT_TEST_PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
script = Path(__file__).with_name('private-receipts.draft.sql').read_text()
owner = '11111111-1111-4111-8111-111111111111'
other = '22222222-2222-4222-8222-222222222222'
unverified = '44444444-4444-4444-8444-444444444444'
anonymous = '55555555-5555-4555-8555-555555555555'
object_id = '33333333-3333-4333-8333-333333333333'
with tempfile.TemporaryDirectory(prefix='oneshot-private-receipts-') as directory:
    base = Path(directory)
    subprocess.run([str(pg/'initdb'),'-D',str(base/'db'),'-A','trust','-U','postgres','--no-locale'], check=True, stdout=subprocess.DEVNULL)
    with (base/'postgres.log').open('w') as log:
        server = subprocess.Popen([str(pg/'postgres'),'-D',str(base/'db'),'-k',str(base),'-p','54387','-h',''],stdout=log,stderr=log)
        try:
            for _ in range(100):
                if subprocess.run([str(pg/'pg_isready'),'-h',str(base),'-p','54387','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0: break
                if server.poll() is not None: raise RuntimeError((base/'postgres.log').read_text())
                time.sleep(.05)
            else: raise RuntimeError('Disposable Postgres not ready')
            def sql(query,success=True):
                result = subprocess.run([str(pg/'psql'),'-X','-q','-v','ON_ERROR_STOP=1','-At','-h',str(base),'-p','54387','-U','postgres'],input=query,text=True,capture_output=True)
                if (result.returncode == 0) != success: raise AssertionError(result.stderr or result.stdout)
                return result.stdout.strip()
            sql('''create role anon; create role authenticated; create schema auth; create schema storage;
            create table auth.users(id uuid primary key,email_confirmed_at timestamptz,is_anonymous boolean,banned_until timestamptz,deleted_at timestamptz);
            create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
            create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
            create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
            grant usage on schema auth,storage to anon,authenticated; grant execute on function auth.uid() to public;
            create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
            create table storage.objects(bucket_id text,name text,owner_id text,metadata jsonb,primary key(bucket_id,name));
            alter table storage.objects enable row level security;
            grant select,insert,update,delete on storage.objects to anon,authenticated;
            create policy legacy_public_select on storage.objects for select using(true);
            create policy legacy_public_insert on storage.objects for insert with check(true);
            create policy legacy_public_update on storage.objects for update using(true) with check(true);
            create policy legacy_public_delete on storage.objects for delete using(true);
            insert into storage.buckets values ('oneshot-assets','oneshot-assets',true,31457280,null);
            insert into storage.objects values ('oneshot-assets','existing-public.jpg',null,'{}');''')
            sql(script,False)
            assert sql("select count(*) from storage.buckets where id='oneshot-receipts'") == '0'
            identity=Path(__file__).with_name('customer-identity.draft.sql').read_text()
            sql(identity,False)
            sql("set oneshot.secure_gateway_cutover='reviewed';\n"+identity)
            sql("set oneshot.private_receipts_cutover='reviewed';\n"+script)
            sql(f"insert into auth.users(id,email_confirmed_at,is_anonymous) values ('{owner}',now(),false),('{other}',now(),false),('{unverified}',null,false),('{anonymous}',now(),true)")
            sql("insert into auth.sessions select id,id,null from auth.users")
            def as_user(uid): return f"set role authenticated;set request.jwt.claim.sub='{uid}';set request.jwt.claims='{{\"session_id\":\"{uid}\"}}';"
            def insert(uid,name=None,actual_owner=None,metadata=None):
                name = name or f'{uid}/{object_id}.png'
                actual_owner = actual_owner or uid
                metadata = metadata or '{"mimetype":"image/png","size":9}'
                return f"insert into storage.objects values ('oneshot-receipts','{name}','{actual_owner}','{metadata}')"
            sql(as_user(owner)+insert(owner))
            assert sql(as_user(owner)+"select count(*) from storage.objects where bucket_id='oneshot-receipts'") == '1'
            assert sql(as_user(other)+"select count(*) from storage.objects where bucket_id='oneshot-receipts'") == '0'
            assert sql("set role anon;select count(*) from storage.objects where bucket_id='oneshot-receipts'") == '0'
            sql("set role anon;"+insert(other),False)
            sql(as_user(unverified)+insert(unverified),False)
            sql(as_user(anonymous)+insert(anonymous),False)
            sql(as_user(other)+insert(owner),False)
            sql(as_user(owner)+insert(owner,name=f'{owner}/../bad.png'),False)
            sql(as_user(other)+insert(other,actual_owner=owner),False)
            # Real Storage authorizeUpload probes INSERT before final metadata.size exists.
            # RLS checks ownership/session/path; MIME/size are Storage bucket API limits.
            sql('begin;'+as_user(other)+insert(other,metadata='{"mimetype":"image/png","contentLength":9}')+';rollback;')
            sql(as_user(owner)+insert(owner),False)
            assert sql(as_user(owner)+"with updated as (update storage.objects set metadata='{}' where bucket_id='oneshot-receipts' returning *) select count(*) from updated") == '0'
            assert sql(as_user(owner)+"with deleted as (delete from storage.objects where bucket_id='oneshot-receipts' returning *) select count(*) from deleted") == '0'
            # A broad legacy UPDATE cannot move an unrelated public asset into this bucket.
            sql(as_user(owner)+f"update storage.objects set bucket_id='oneshot-receipts',name='{owner}/66666666-6666-4666-8666-666666666666.png',owner_id='{owner}' where bucket_id='oneshot-assets'",False)
            assert sql("set role anon;select count(*) from storage.objects where bucket_id='oneshot-assets'") == '1'
            assert sql("select public::text||':'||file_size_limit||':'||array_to_string(allowed_mime_types,',') from storage.buckets where id='oneshot-receipts'") == 'false:5242880:image/jpeg,image/png'
            # Client-controlled metadata cannot grant verification or a staff role.
            assert sql(as_user(unverified)+"set request.jwt.claims='{\"user_metadata\":{\"isAdmin\":true,\"email_verified\":true}}';select oneshot_private.verified_receipt_customer()") == 'f'
            for update,reset in [("update auth.users set banned_until=now()+interval '1 day'", "update auth.users set banned_until=null"),("update auth.users set deleted_at=now()", "update auth.users set deleted_at=null"),("update auth.sessions set not_after=now()-interval '1 second'", "update auth.sessions set not_after=null")]:
                sql(update)
                assert sql(as_user(owner)+"select count(*) from storage.objects where bucket_id='oneshot-receipts'") == '0'
                sql(as_user(other)+insert(other),False)
                sql(reset)
            for claims in ['{}','{"session_id":"malformed"}',f'{{"session_id":"{other}"}}','{"user_metadata":{"isAdmin":true,"email_verified":true}}']:
                context=as_user(owner)+f"set request.jwt.claims='{claims}';"
                assert sql(context+"select oneshot_private.verified_customer()") == 'f'
                assert sql(context+"select count(*) from storage.objects where bucket_id='oneshot-receipts'") == '0'
            sql("delete from auth.sessions")
            assert sql(as_user(owner)+"select oneshot_private.verified_customer()") == 'f'
            assert sql(as_user(owner)+"select count(*) from storage.objects where bucket_id='oneshot-receipts'") == '0'
            sql(as_user(other)+insert(other),False)
            sql("insert into auth.sessions select id,id,null from auth.users")
            assert sql(as_user(owner)+"select oneshot_private.verified_customer()") == 't'
            assert sql("set role anon;select oneshot_private.verified_customer()") == 'f'
            print('PASS: banned/deleted/revoked/missing/malformed/cross-owner/expired sessions deny private reads and writes; metadata cannot impersonate a valid session.')
            print('PASS: draft gate, exact private bucket JPEG/PNG 5MB configuration, real initial Storage permission-probe metadata accepted, verified owner insert/read, cross-owner/anon/unverified/anonymous denial, owner path guard, immutable update/delete, no legacy policy bypass, existing public assets unchanged.')
            print('LIMIT: local PostgreSQL policy fixture only. Bucket MIME/size configuration asserted; actual Storage API limit enforcement/upload/signing, content scanner, staff review gateway, leaked public-object migration and CDN revocation unverified.')
        finally:
            server.terminate()
            server.wait(timeout=10)
