-- Bounded least-privilege hardening for oneshot-tester1 (olywhyaozjlkjrnsdydg), PostgreSQL 17.
-- Preserves table data, SELECT/INSERT/UPDATE/DELETE, policies, existing triggers and foreign keys.
-- Separate from cloud-containment.draft.sql; does not require or perform customer/gateway cutover.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '10s';
revoke truncate, references, trigger, maintain on table
  public.activities, public.announcements, public.closed_dates,
  public.cms, public.e_receipts, public.events, public.feedback,
  public.inventory, public.lost_and_found, public.promo_codes,
  public.queue, public.reservations, public.session_history,
  public.system_settings, public.system_status, public.tables,
  public.watchlist
from public, anon, authenticated;
commit;
