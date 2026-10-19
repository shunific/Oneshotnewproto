#!/usr/bin/env python3
"""Verify bounded privilege revocation against an isolated local PostgreSQL 17 fixture."""
from pathlib import Path
import os
import subprocess
import tempfile
import time

pg_bin = Path(os.environ.get('ONESHOT_TEST_PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
for binary in ('initdb', 'postgres', 'pg_isready', 'psql'):
    if not (pg_bin / binary).exists():
        raise SystemExit(f'Missing local PostgreSQL binary: {pg_bin / binary}')
script = Path(__file__).with_name('revoke-unused-privileges.sql').read_text()
tables = ['activities', 'announcements', 'closed_dates', 'cms', 'e_receipts', 'events', 'feedback', 'inventory', 'lost_and_found', 'promo_codes', 'queue', 'reservations', 'session_history', 'system_settings', 'system_status', 'tables', 'watchlist']
privileges = ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
with tempfile.TemporaryDirectory(prefix='oneshot-grants-') as directory:
    base = Path(directory)
    subprocess.run([str(pg_bin / 'initdb'), '-D', str(base / 'db'), '-A', 'trust', '-U', 'postgres', '--no-locale'], check=True, stdout=subprocess.DEVNULL)
    with (base / 'postgres.log').open('w') as log:
        server = subprocess.Popen([str(pg_bin / 'postgres'), '-D', str(base / 'db'), '-k', str(base), '-p', '54389', '-h', ''], stdout=log, stderr=log)
        try:
            for _ in range(100):
                ready = subprocess.run([str(pg_bin / 'pg_isready'), '-h', str(base), '-p', '54389', '-U', 'postgres'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if ready.returncode == 0: break
                if server.poll() is not None: raise RuntimeError((base / 'postgres.log').read_text())
                time.sleep(.05)
            else: raise RuntimeError('Disposable Postgres did not become ready')
            def sql(query, expected_success=True):
                result = subprocess.run([str(pg_bin / 'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-h', str(base), '-p', '54389', '-U', 'postgres'], input=query, text=True, capture_output=True)
                if (result.returncode == 0) != expected_success: raise AssertionError(result.stderr or result.stdout)
                return result.stdout.strip()
            sql('create role anon; create role authenticated; create role service_role;')
            for table in tables:
                sql(f'create table public.{table}(id text primary key, value integer); grant all on public.{table} to public,anon,authenticated,service_role;')
            for role in ['anon', 'authenticated']:
                for table in tables:
                    for privilege in privileges:
                        assert sql(f"select has_table_privilege('{role}','public.{table}','{privilege}');") == 't'
            # Control: references/triggers created before revocation keep working afterward.
            sql("create table public.child(parent_id text references public.activities(id)); create table public.trigger_audit(value integer); create function public.qa_record() returns trigger language plpgsql security definer set search_path='' as $$ begin insert into public.trigger_audit values(new.value); return new; end $$; create trigger qa_record after insert on public.activities for each row execute function public.qa_record();")
            sql(script)
            checks = 0
            for role in ['anon', 'authenticated']:
                for table in tables:
                    for privilege in privileges:
                        # has_table_privilege tests effective access, including PUBLIC and inherited grants.
                        assert sql(f"select has_table_privilege('{role}','public.{table}','{privilege}');") == 'f'
                        checks += 1
                    for privilege in ['SELECT', 'INSERT', 'UPDATE', 'DELETE']:
                        assert sql(f"select has_table_privilege('{role}','public.{table}','{privilege}');") == 't'
                    marker = f'{role}-{table}'
                    assert sql(f"set role {role}; insert into public.{table} values('{marker}',1); update public.{table} set value=2 where id='{marker}'; select value from public.{table} where id='{marker}';").splitlines()[-1] == '2'
                    sql(f"set role {role}; delete from public.{table} where id='{marker}';")
                    assert sql(f"select count(*) from public.{table};") == '0'
            for privilege in privileges:
                assert sql(f"select has_table_privilege('service_role','public.activities','{privilege}');") == 't'
            sql("set role anon; insert into public.activities values('qa-parent',3); reset role; insert into public.child values('qa-parent');")
            assert sql('select count(*) from trigger_audit where value=3;') == '1'
            sql('set role anon; truncate public.activities;', False)
            sql('set role authenticated; create table public.forbidden_reference(value text references public.activities(id));', False)
            assert sql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity;") == '0'
            print(f'PASS: {checks} effective excess-privilege denials; SELECT/INSERT/UPDATE/DELETE remain usable for both client roles across all 17 fixture tables.')
            print('PASS: PUBLIC-derived excess privileges removed, service_role unchanged, existing trigger/foreign key still work, no RLS policy or data rewrite.')
            print('LIMIT: PostgreSQL 17 local fixture; live application behavior and post-rollout metadata must be checked separately.')
        finally:
            server.terminate()
            try: server.wait(timeout=10)
            except subprocess.TimeoutExpired: raise RuntimeError('Disposable Postgres did not terminate normally')
