begin;

-- A reservation consumes a use when it is first saved with the code. Staff
-- status changes and repeated syncs of the same booking keep that single use.
lock table public.reservations, public.promo_codes in share row exclusive mode;
create schema if not exists promo_accounting;
revoke all on schema promo_accounting from public, anon, authenticated;
create table if not exists promo_accounting.redemptions (
  reservation_id text primary key,
  promo_id text not null references public.promo_codes(id) on delete cascade
);
create index if not exists redemptions_promo_id on promo_accounting.redemptions (promo_id);

create or replace function promo_accounting.booking_code(r jsonb) returns text
language sql immutable set search_path = '' as $$
  select upper(coalesce(nullif(btrim(r->>'promoCode'), ''), nullif(btrim(r->>'promocode'), ''), nullif(btrim(r->>'promo_code'), '')))
$$;

insert into promo_accounting.redemptions (reservation_id, promo_id)
select r.id, p.id from public.reservations r
join public.promo_codes p on upper(btrim(p.code)) = promo_accounting.booking_code(to_jsonb(r))
on conflict (reservation_id) do nothing;

-- Older desktop builds include a cached counter when they sync promo settings.
create or replace function promo_accounting.keep_saved_count() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and pg_trigger_depth() = 1 then
    new.usage_count := old.usage_count;
  end if;
  return new;
end $$;
drop trigger if exists keep_saved_promo_count on public.promo_codes;
update public.promo_codes p set usage_count = greatest(coalesce(p.usage_count, 0), counts.uses)
from (select promo_id, count(*)::integer as uses from promo_accounting.redemptions group by promo_id) counts
where p.id = counts.promo_id and coalesce(p.usage_count,0) < counts.uses;
create trigger keep_saved_promo_count before update of usage_count on public.promo_codes
for each row execute function promo_accounting.keep_saved_count();

create or replace function promo_accounting.record_use() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  normalized text := promo_accounting.booking_code(to_jsonb(new));
  redeemed_id text;
begin
  if normalized is null then return new; end if;
  if tg_op = 'UPDATE' and normalized is not distinct from promo_accounting.booking_code(to_jsonb(old)) then return new; end if;

  insert into promo_accounting.redemptions (reservation_id, promo_id)
  select new.id, p.id from public.promo_codes p where upper(btrim(p.code)) = normalized
  on conflict (reservation_id) do nothing returning promo_id into redeemed_id;
  if redeemed_id is not null then
    update public.promo_codes
    set usage_count = coalesce(usage_count, 0) + 1
    where id = redeemed_id and (not coalesce(is_limited_uses, false) or coalesce(usage_count, 0) < max_usage);
    if not found then raise exception 'This promo code has reached its use limit.'; end if;
  end if;
  return new;
end $$;
revoke all on all functions in schema promo_accounting from public, anon, authenticated;
drop trigger if exists count_booking_promo on public.reservations;
create trigger count_booking_promo after insert or update on public.reservations
for each row execute function promo_accounting.record_use();
commit;
