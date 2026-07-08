-- Migration: 007_start_cards
-- Author: soogiue
-- Date: 2026-07-08
-- Reason: L'host sceglie da quante carte si parte (partite piu corte).
-- Affected: public.games (+ colonna start_cards). Nient'altro.
-- Note di design:
--   * default 1 = comportamento storico (1 -> picco -> 1): NON breaking.
--   * il valore e' un DESIDERIO dell'host: il clamp al picco reale avviene
--     in start_game (es. scelto 9 ma 5 giocatori -> picco 8 -> si parte da 8).
--   * niente RLS/realtime da toccare: games e' gia' leggibile dai membri
--     e gia' in pubblicazione realtime.
-- ============================================================

alter table public.games
  add column if not exists start_cards int not null default 1
  check (start_cards between 1 and 10);

-- ------------------------------------------------------------
-- LOG DELLA MIGRATION
-- ------------------------------------------------------------
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '007_start_cards',
  'Add public.games.start_cards (int default 1): host-chosen starting hand size',
  'soogiue',
  now(),
  'applied'
)
on conflict (version) do update
  set description = excluded.description,
      applied_at  = excluded.applied_at,
      status      = excluded.status;

-- ------------------------------------------------------------
-- VERIFICA
-- ------------------------------------------------------------
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'games' and column_name = 'start_cards';
