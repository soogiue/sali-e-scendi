-- Migration: 004_autoplay
-- Author: soogiue
-- Date: 2026-06-24
-- Reason: Tasto "AUTOGAME". Un giocatore umano che non vuole/può più giocare può
--         delegare il proprio posto a un bot (stessa logica dei modelli ML) senza
--         mandare in stallo la partita. È REVERSIBILE: può riprendere il controllo.
-- Affected: public.game_players (+autoplay). NESSUNA modifica distruttiva.
-- Note di design:
--   * autoplay è distinto da is_bot: is_bot = posto creato come bot dalla lobby;
--     autoplay = posto di un UMANO temporaneamente giocato dal server.
--   * In advanceBots il server gioca per i posti con is_bot OPPURE autoplay, con
--     la logica dei modelli allenati (mlbot.ts), fallback euristica.
--   * RLS invariata: i client leggono i giocatori (autoplay incluso); le
--     scritture passano dalla Edge Function (service_role).
-- ============================================================

alter table public.game_players
  add column if not exists autoplay boolean not null default false;

-- ------------------------------------------------------------
-- LOG DELLA MIGRATION
-- ------------------------------------------------------------
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '004_autoplay',
  'Add game_players.autoplay: a human seat can be auto-played by the server (ML bot), reversibly',
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
where table_schema='public' and table_name='game_players' and column_name='autoplay';
