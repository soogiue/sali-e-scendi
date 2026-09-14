-- Migration: 009_endgame_and_trash_toggle
-- Author: soogiue
-- Date: 2026-07-10
-- Reason: Due feature nuove.
--   (1) L'host puo' TERMINARE la partita a meta': serve lo stato 'aborted'
--       (nessun vincitore, non finalizzata nello storico).
--   (2) Interruttore in lobby per i BOT CHE INSULTANO: colonna bots_trash.
-- Affected: public.games (nuova colonna + allargati i CHECK su status/phase).
-- Note di design:
--   * 'aborted' e' distinto da 'finished': niente winner_seat, niente logGameFinished.
--   * bots_trash default TRUE = comportamento storico (i bot sfottono).
--   * Additivo e non breaking: un client vecchio ignora la colonna e non vedra'
--     mai lo stato 'aborted' (che nasce solo dalla nuova azione end_game).
-- ============================================================

-- ------------------------------------------------------------
-- (1) Nuovo valore 'aborted' per status e phase
-- ------------------------------------------------------------
alter table public.games drop constraint if exists games_status_check;
alter table public.games add constraint games_status_check
  check (status in ('lobby','playing','finished','aborted'));

alter table public.games drop constraint if exists games_phase_check;
alter table public.games add constraint games_phase_check
  check (phase in ('lobby','declaring','playing','trick_done','round_end','finished','aborted'));

-- ------------------------------------------------------------
-- (2) Interruttore trashtalking dei bot (scelto in lobby dall'host)
-- ------------------------------------------------------------
alter table public.games
  add column if not exists bots_trash boolean not null default true;

-- ------------------------------------------------------------
-- LOG DELLA MIGRATION
-- ------------------------------------------------------------
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '009_endgame_and_trash_toggle',
  'games: add status/phase value ''aborted'' (host ends game) + column bots_trash bool default true (lobby toggle for bot trashtalk)',
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
where table_schema = 'public' and table_name = 'games' and column_name = 'bots_trash';
