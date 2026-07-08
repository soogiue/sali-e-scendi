-- Migration Rollback: 006_stats
-- Elimina le tre funzioni RPC delle statistiche. Nessun dato viene toccato
-- (le funzioni leggono soltanto): il client mostrerà "Errore statistiche".
-- ============================================================

-- STEP 1: FUNZIONI
drop function if exists public.get_my_stats();
drop function if exists public.get_my_history(int);
drop function if exists public.get_leaderboard();

-- STEP 2: LOG DEL ROLLBACK
insert into internal.schema_migrations_rollback (version, rolled_back_by, rolled_back_at)
values ('006_stats', 'soogiue', now());

-- STEP 3: VERIFICA
select routine_name from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('get_my_stats','get_my_history','get_leaderboard');
