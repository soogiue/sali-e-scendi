-- Rollback: 009_endgame_and_trash_toggle
-- Rimuove bots_trash e riporta i CHECK di status/phase senza 'aborted'.
-- ATTENZIONE: se esistono partite con status/phase = 'aborted' il ripristino
-- dei CHECK fallirebbe; le normalizziamo a 'finished' prima.
-- ============================================================

update public.games set status = 'finished' where status = 'aborted';
update public.games set phase  = 'finished' where phase  = 'aborted';

alter table public.games drop constraint if exists games_status_check;
alter table public.games add constraint games_status_check
  check (status in ('lobby','playing','finished'));

alter table public.games drop constraint if exists games_phase_check;
alter table public.games add constraint games_phase_check
  check (phase in ('lobby','declaring','playing','trick_done','round_end','finished'));

alter table public.games drop column if exists bots_trash;

update internal.schema_migrations
  set status = 'rolled_back', applied_at = now()
  where version = '009_endgame_and_trash_toggle';
