-- Migration Rollback: 001_v1_game_history
-- ATTENZIONE: elimina lo schema `history` e TUTTI i dati di cronologia!
--             Usare solo in emergenza e dopo aver esportato il dataset.
-- ============================================================

-- STEP 1: VISTE
drop view if exists history.ml_play_samples;
drop view if exists history.ml_declaration_samples;

-- STEP 2: TABELLE (in ordine inverso per le FK)
drop table if exists history.round_outcomes;
drop table if exists history.tricks;
drop table if exists history.plays;
drop table if exists history.declarations;
drop table if exists history.deals;
drop table if exists history.rounds;
drop table if exists history.players;
drop table if exists history.games;

-- STEP 3: SCHEMA history
drop schema if exists history;

-- NOTA: lo schema `internal` (schema_migrations) NON viene rimosso:
--       è infrastruttura condivisa dalle future migration.

-- STEP 4: LOG DEL ROLLBACK
insert into internal.schema_migrations_rollback (version, rolled_back_by, rolled_back_at)
values ('001_v1_game_history', 'soogiue', now());

-- STEP 5: VERIFICA
select schema_name from information_schema.schemata where schema_name = 'history';
