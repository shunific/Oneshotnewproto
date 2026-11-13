-- Restore browser (publishable key / anon role) access to the app tables.
--
-- Supabase now rejects secret keys from browsers, so the website and the
-- Electron renderer use the publishable key. Run this once in the Supabase
-- dashboard: SQL Editor -> New query -> paste -> Run.
--
-- This matches the access level the app had while it shipped a service-role
-- key to the browser (full read/write on the app tables).

do $$
declare
  t text;
begin
  foreach t in array array[
    'tables', 'e_receipts', 'cms', 'feedback', 'closed_dates', 'announcements',
    'lost_and_found', 'system_status', 'session_history', 'reservations',
    'watchlist', 'system_settings', 'events', 'inventory', 'activities',
    'queue', 'promo_codes'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists app_anon_all on public.%I', t);
    execute format('create policy app_anon_all on public.%I for all to anon using (true) with check (true)', t);
    execute format('drop policy if exists app_auth_all on public.%I', t);
    execute format('create policy app_auth_all on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end
$$;
