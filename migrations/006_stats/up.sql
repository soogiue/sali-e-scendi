-- Migration: 006_stats
-- Author: soogiue
-- Date: 2026-07-08
-- Reason: Statistiche/storico/classifica per account (schermata 📊 del client).
-- Affected: tre funzioni RPC in public (get_my_stats, get_my_history,
--           get_leaderboard). NESSUNA tabella nuova, NESSUNA modifica a dati.
-- Note di design:
--   * security definer: leggono history.* e public.profiles senza aprire
--     lo schema history ai client (resta il dataset ML, service_role only).
--   * auth.uid() identifica il chiamante: nessun parametro user_id falsificabile.
--   * grant execute SOLO ad authenticated (revoke da public/anon).
--   * I bot hanno user_id sintetici senza riga in profiles: esclusi ovunque
--     (filtro auth.uid() o inner join profiles).
--   * Richiede le migration 001 (schema history) e 005 (profiles).
-- ============================================================

-- ------------------------------------------------------------
-- get_my_stats() — aggregati personali (1 riga, zeri se mai giocato)
-- ------------------------------------------------------------
create or replace function public.get_my_stats()
returns table (
  games int, wins int, win_rate numeric,
  avg_score numeric, best_score int, avg_rank numeric,
  decl_rounds int, decl_exact int, decl_accuracy numeric
)
language sql stable security definer
set search_path = public, history
as $$
  with mine as (
    select hp.final_score, hp.final_rank
    from history.players hp
    join history.games hg on hg.id = hp.game_log_id
    where hp.user_id = auth.uid() and hg.status = 'finished'
  ),
  decl as (
    select count(*)::int as rounds,
           (count(*) filter (where ro.guessed))::int as exact
    from history.round_outcomes ro
    join history.rounds hr on hr.id = ro.round_log_id
    join history.games hg on hg.id = hr.game_log_id
    where ro.user_id = auth.uid() and hg.status = 'finished'
  )
  select
    count(*)::int,
    (count(*) filter (where m.final_rank = 1))::int,
    case when count(*) = 0 then 0
         else round(100.0 * (count(*) filter (where m.final_rank = 1)) / count(*), 1) end,
    coalesce(round(avg(m.final_score), 1), 0),
    coalesce(max(m.final_score), 0)::int,
    coalesce(round(avg(m.final_rank), 2), 0),
    (select rounds from decl),
    (select exact from decl),
    (select case when rounds = 0 then 0 else round(100.0 * exact / rounds, 1) end from decl)
  from mine m;
$$;

-- ------------------------------------------------------------
-- get_my_history(p_limit) — le mie ultime partite concluse (cap 50)
-- ------------------------------------------------------------
create or replace function public.get_my_history(p_limit int default 20)
returns table (
  finished_at timestamptz, num_players int,
  my_score int, my_rank int, winner_name text
)
language sql stable security definer
set search_path = public, history
as $$
  select hg.finished_at, hg.num_players,
         hp.final_score, hp.final_rank,
         w.display_name
  from history.players hp
  join history.games hg on hg.id = hp.game_log_id
  left join history.players w on w.game_log_id = hp.game_log_id and w.final_rank = 1
  where hp.user_id = auth.uid() and hg.status = 'finished'
  order by hg.finished_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- ------------------------------------------------------------
-- get_leaderboard() — una riga per giocatore registrato che ha
-- finito almeno una partita. Ordine: vinte, win rate, nickname.
-- ------------------------------------------------------------
create or replace function public.get_leaderboard()
returns table (
  nickname text, games int, wins int, win_rate numeric, avg_score numeric
)
language sql stable security definer
set search_path = public, history
as $$
  select p.nickname,
         count(*)::int,
         (count(*) filter (where hp.final_rank = 1))::int,
         round(100.0 * (count(*) filter (where hp.final_rank = 1)) / count(*), 1),
         round(avg(hp.final_score), 1)
  from public.profiles p
  join history.players hp on hp.user_id = p.id
  join history.games hg on hg.id = hp.game_log_id and hg.status = 'finished'
  group by p.id, p.nickname
  order by 3 desc, 4 desc, 1 asc;
$$;

-- ------------------------------------------------------------
-- PERMESSI: solo utenti loggati. (Le funzioni nascono con EXECUTE
-- a PUBLIC: il revoke è indispensabile.)
-- ------------------------------------------------------------
revoke all on function public.get_my_stats() from public, anon;
revoke all on function public.get_my_history(int) from public, anon;
revoke all on function public.get_leaderboard() from public, anon;
grant execute on function public.get_my_stats() to authenticated;
grant execute on function public.get_my_history(int) to authenticated;
grant execute on function public.get_leaderboard() to authenticated;

-- ------------------------------------------------------------
-- LOG DELLA MIGRATION
-- ------------------------------------------------------------
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '006_stats',
  'Add RPC get_my_stats/get_my_history/get_leaderboard (security definer over history schema, authenticated only)',
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
select routine_name from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('get_my_stats','get_my_history','get_leaderboard');
