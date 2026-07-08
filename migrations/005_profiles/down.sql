-- Migration Rollback: 005_profiles
-- ATTENZIONE: elimina la tabella public.profiles e TUTTI i nickname.
-- Gli account auth.users restano ma senza profilo: create_game/join_game
-- risponderanno 403 finche la migration non viene riapplicata.
-- ============================================================

-- STEP 1: TRIGGER + FUNZIONE
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- STEP 2: TABELLA (policy e indice cadono con la tabella)
drop table if exists public.profiles;

-- STEP 3: LOG DEL ROLLBACK
insert into internal.schema_migrations_rollback (version, rolled_back_by, rolled_back_at)
values ('005_profiles', 'soogiue', now());

-- STEP 4: VERIFICA
select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'profiles';
