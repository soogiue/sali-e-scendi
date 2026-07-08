-- Migration Rollback: 007_start_cards
-- Elimina la colonna start_cards: le nuove partite tornano a 1 -> picco -> 1.
-- Le partite in corso NON si rompono (rounds e' gia' materializzato).
-- ============================================================

-- STEP 1: COLONNA
alter table public.games drop column if exists start_cards;

-- STEP 2: LOG DEL ROLLBACK
insert into internal.schema_migrations_rollback (version, rolled_back_by, rolled_back_at)
values ('007_start_cards', 'soogiue', now());

-- STEP 3: VERIFICA
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'games' and column_name = 'start_cards';
