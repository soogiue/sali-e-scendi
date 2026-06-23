-- Migration: 002_chat_messages
-- Author: soogiue
-- Date: 2026-06-23
-- Reason: Chat testuale tra i membri di una stanza (lobby + partita).
-- Affected: nuova tabella public.chat_messages (+ RLS, policy SELECT, realtime).
--           NESSUNA modifica alle tabelle esistenti.
-- Note di design:
--   * Scritta SOLO dalla Edge Function (service_role, bypassa la RLS). I client
--     non scrivono direttamente: niente policy di INSERT.
--   * RLS con policy di SELECT per i soli membri della partita (is_game_member).
--   * on delete cascade verso public.games: la chat vive con la stanza.
--   * display_name/seat denormalizzati = snapshot al momento dell'invio.
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- public.chat_messages — un messaggio di chat per riga
-- ------------------------------------------------------------
create table if not exists public.chat_messages (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games(id) on delete cascade,
  user_id      uuid not null,
  seat         int,                          -- posto del mittente all'invio
  display_name text not null,                -- snapshot del nome all'invio
  body         text not null,                -- testo (gia validato lato server)
  created_at   timestamptz not null default now()
);

create index if not exists idx_chat_game on public.chat_messages(game_id, created_at);

-- ------------------------------------------------------------
-- RLS: i membri leggono; nessuna scrittura lato client.
-- ------------------------------------------------------------
alter table public.chat_messages enable row level security;

drop policy if exists chat_select on public.chat_messages;
create policy chat_select on public.chat_messages
  for select to authenticated
  using ( public.is_game_member(game_id) );

-- ------------------------------------------------------------
-- Realtime: i client ricevono i nuovi messaggi in tempo reale.
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.chat_messages;

-- ------------------------------------------------------------
-- LOG DELLA MIGRATION
-- ------------------------------------------------------------
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '002_chat_messages',
  'Add public.chat_messages (room chat) + RLS select for members + realtime',
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
select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'chat_messages';
