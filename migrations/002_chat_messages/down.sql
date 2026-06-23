-- Migration Rollback: 002_chat_messages
-- ATTENZIONE: elimina la tabella public.chat_messages e TUTTI i messaggi.
-- ============================================================

-- STEP 1: togli dalla pubblicazione realtime (ignora l'errore se non presente)
alter publication supabase_realtime drop table public.chat_messages;

-- STEP 2: TABELLA (la policy cade con la tabella)
drop table if exists public.chat_messages;

-- STEP 3: LOG DEL ROLLBACK
insert into internal.schema_migrations_rollback (version, rolled_back_by, rolled_back_at)
values ('002_chat_messages', 'soogiue', now());

-- STEP 4: VERIFICA
select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'chat_messages';
