#!/usr/bin/env python3
"""Exercise the review SQL against a disposable Postgres fixture, never a remote DB."""
from pathlib import Path
import os
import subprocess
import tempfile
import time

pg_bin = Path(os.environ.get('ONESHOT_TEST_PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
for binary in ('initdb', 'postgres', 'pg_isready', 'psql'):
    if not (pg_bin / binary).exists():
        raise SystemExit(f'Missing local PostgreSQL binary: {pg_bin / binary}')
script = Path(__file__).with_name('cloud-containment.draft.sql').read_text()
tables = ['activities', 'announcements', 'closed_dates', 'cms', 'e_receipts', 'events', 'feedback', 'inventory', 'lost_and_found', 'promo_codes', 'queue', 'reservations', 'session_history', 'system_settings', 'system_status', 'tables', 'watchlist']
owner = '11111111-1111-1111-1111-111111111111'
other = '22222222-2222-2222-2222-222222222222'
with tempfile.TemporaryDirectory(prefix='oneshot-policy-') as directory:
    base = Path(directory)
    subprocess.run([str(pg_bin / 'initdb'), '-D', str(base / 'db'), '-A', 'trust', '-U', 'postgres', '--no-locale'], check=True, stdout=subprocess.DEVNULL)
    with (base / 'postgres.log').open('w') as log:
        server = subprocess.Popen([str(pg_bin / 'postgres'), '-D', str(base / 'db'), '-k', str(base), '-p', '54389', '-h', ''], stdout=log, stderr=log)
        try:
            for _ in range(100):
                ready = subprocess.run([str(pg_bin / 'pg_isready'), '-h', str(base), '-p', '54389', '-U', 'postgres'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if ready.returncode == 0:
                    break
                if server.poll() is not None:
                    raise RuntimeError((base / 'postgres.log').read_text())
                time.sleep(.05)
            else:
                raise RuntimeError('Local disposable Postgres did not become ready')
            def sql(query, expected_success=True):
                result = subprocess.run([str(pg_bin / 'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-h', str(base), '-p', '54389', '-U', 'postgres'], input=query, text=True, capture_output=True)
                if (result.returncode == 0) != expected_success:
                    raise AssertionError(result.stderr or result.stdout)
                return result.stdout.strip()
            sql('create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),is_anonymous boolean default false,banned_until timestamptz,deleted_at timestamptz); create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz); create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting(\'request.jwt.claims\',true),\'\'),\'{}\')::jsonb$$; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting(\'request.jwt.claim.sub\', true),\'\')::uuid $$; grant usage on schema auth to public; grant execute on function auth.uid() to public;')
            for table in tables:
                columns = 'id text primary key'
                if table == 'tables': columns += ', name text, status text, isactive integer, "isActive" integer, "sessionData" text'
                if table == 'announcements': columns += ',title text,content text,type text,expiresat timestamptz,createdat timestamptz,isactive integer'
                if table == 'reservations': columns += ',"customerName" text'
                sql(f'create table public.{table} ({columns}); grant all on public.{table} to anon,authenticated;')
            sql('alter table reservations enable row level security; create policy "allow public reservation select" on reservations for select to anon using(true); create policy "Allow public reservation inserts" on reservations for insert to anon with check(true); create policy "Public can view billiard tables" on tables for select to anon,authenticated using(true); create policy "Public read access" on announcements for select using(true);')
            assert 'Stop: deploy' in subprocess.run([str(pg_bin / 'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-h', str(base), '-p', '54389', '-U', 'postgres'], input=script, text=True, capture_output=True).stderr
            sql("set oneshot.secure_gateway_cutover='reviewed';\n" + Path(__file__).with_name('customer-identity.draft.sql').read_text())
            sql("set oneshot.secure_gateway_cutover='reviewed';\n" + script)
            sql(f"insert into auth.users(id) values ('{owner}'),('{other}'); insert into reservations values ('QA-OWNER','Owner','{owner}'),('QA-OTHER','Other','{other}'),('QA-LEGACY','Legacy',null);")
            sql("insert into auth.sessions select id,id,null from auth.users")
            assert sql(f"set role authenticated; set request.jwt.claim.sub='{owner}'; set request.jwt.claims='{{\"session_id\":\"{owner}\"}}'; select string_agg(id,',') from reservations;").splitlines()[-1] == 'QA-OWNER'
            assert sql(f"set role authenticated; set request.jwt.claim.sub='{other}'; set request.jwt.claims='{{\"session_id\":\"{other}\"}}'; select string_agg(id,',') from reservations;").splitlines()[-1] == 'QA-OTHER'
            sql('set role anon; select * from reservations;', False)
            sql("set role authenticated; insert into reservations(id) values ('FORGED');", False)
            sql("set role authenticated; update reservations set customer_user_id=null;", False)
            sql('set role authenticated; delete from reservations;', False)
            sql('set role anon; truncate tables;', False)
            sql('set role anon; select "sessionData" from tables;', False)
            sql('set role anon; select id,name,status,isactive,"isActive" from tables;')
            assert sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;") == '0'
            assert sql("select count(*) from information_schema.role_table_grants where table_schema='public' and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES');") == '0'
            print('PASS: gated execution, owner-only reads, legacy unclaimed, denied anon PII, denied forged writes/TRUNCATE, safe table columns, all fixture tables have RLS.')
            print('LIMIT: simplified schema fixture; no deployed gateway, real schema replay, storage, live policy rollout or concurrency booking function was verified.')
        finally:
            server.terminate()
            try: server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                raise RuntimeError('Disposable Postgres did not terminate normally')
