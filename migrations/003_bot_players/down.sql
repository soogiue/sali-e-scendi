-- Migration Rollback: 003_bot_players
-- ATTENZIONE: rimuove la colonna is_bot. Eventuali bot in stanze attive
--             diventano indistinguibili dagli umani (ma le partite vecchie
--             restano valide). Esegui solo se serve.
-- ============================================================

alter table public.game_players drop column if exists is_bot;

-- LOG DEL ROLLBACK
insert into internal.schema_migrations_rollback (version, rolled_back_by, rolled_back_at)
values ('003_bot_players', 'soogiue', now());

-- VERIFICA
select column_name from information_schema.columns
where table_schema='public' and table_name='game_players' and column_name='is_bot';
