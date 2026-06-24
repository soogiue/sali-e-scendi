-- Migration: 003_bot_players
-- Author: soogiue
-- Date: 2026-06-23
-- Reason: Permettere di giocare con i BOT. L'host, dalla lobby, sceglie quanti
--         bot aggiungere; i bot occupano un posto come gli umani ma vengono
--         giocati dal server (Edge Function) tramite l'euristica in engine.ts.
-- Affected: public.game_players (+is_bot). NESSUNA modifica distruttiva.
-- Note di design:
--   * I bot sono righe normali di game_players con is_bot=true e un user_id
--     sintetico (uuid) generato dal server: così i vincoli unique(game_id,seat)
--     e unique(game_id,user_id) continuano a valere senza modifiche.
--   * La RLS resta invariata: i client leggono i giocatori (bot inclusi) della
--     propria partita; le scritture passano dalla Edge Function (service_role).
-- ============================================================

alter table public.game_players
  add column if not exists is_bot boolean not null default false;

-- ------------------------------------------------------------
-- LOG DELLA MIGRATION
-- ------------------------------------------------------------
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '003_bot_players',
  'Add game_players.is_bot to support server-played bot seats (host chooses how many in the lobby)',
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
select column_name from information_schema.columns
where table_schema='public' and table_name='game_players' and column_name='is_bot';
