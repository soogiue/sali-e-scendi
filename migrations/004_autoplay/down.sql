-- Migration Rollback: 004_autoplay
-- ATTENZIONE: rimuove la colonna autoplay. I posti attualmente in autogame
--             tornano a essere giocati solo manualmente (il server non gioca più
--             per loro). Le partite vecchie restano valide.
-- ============================================================

alter table public.game_players drop column if exists autoplay;

-- LOG DEL ROLLBACK
insert into internal.schema_migrations_rollback (version, rolled_back_by, rolled_back_at)
values ('004_autoplay', 'soogiue', now());

-- VERIFICA
select column_name from information_schema.columns
where table_schema='public' and table_name='game_players' and column_name='autoplay';
