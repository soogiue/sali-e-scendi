-- Migration: 001_v1_game_history
-- Author: soogiue
-- Date: 2026-06-23
-- Reason: Tracciare TUTTI i dati di ogni partita a livello di evento
--         (ogni dichiarazione e ogni carta giocata, con lo stato visto dal
--         giocatore al momento della scelta) per costruire un dataset di
--         training "stato -> azione -> esito" con cui addestrare dei bot ML.
-- Affected: nuovo schema `history` (+ infrastruttura `internal` per il log
--           delle migration, in stile jolo). NESSUNA modifica alle tabelle
--           live esistenti (public.games, game_players, hands, round_results).
-- Note di design:
--   * Le tabelle di history sono APPEND-ONLY e scritte SOLO dalla Edge
--     Function (service_role, che bypassa la RLS). I client non scrivono.
--   * NON hanno FK in cascade verso public.games: la cronologia deve
--     SOPRAVVIVERE alla cancellazione/pulizia delle stanze di gioco.
--   * RLS abilitata SENZA policy di SELECT per i client: l'export del
--     dataset si fa con la service_role. (Le mani altrui restano private.)
-- ============================================================

create extension if not exists "pgcrypto";

-- ============================================================
-- STEP 0: INFRASTRUTTURA MIGRATION (in stile jolo: schema `internal`)
-- ============================================================
create schema if not exists internal;

create table if not exists internal.schema_migrations (
  version     text primary key,
  description text,
  applied_by  text,
  applied_at  timestamptz not null default now(),
  status      text not null default 'applied'
);

create table if not exists internal.schema_migrations_rollback (
  id             bigserial primary key,
  version        text not null,
  rolled_back_by text,
  rolled_back_at timestamptz not null default now()
);

-- ============================================================
-- STEP 1: SCHEMA DEDICATO ALLA CRONOLOGIA / DATASET ML
-- ============================================================
create schema if not exists history;

-- ------------------------------------------------------------
-- history.games — uno snapshot immutabile per ogni partita conclusa
-- (sopravvive alla cancellazione della stanza in public.games)
-- ------------------------------------------------------------
create table if not exists history.games (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid,                       -- riferimento "soft" a public.games.id (NO cascade)
  code          text,
  num_players   int  not null,
  max_cards     int  not null,
  rounds        int[] not null,             -- sequenza dei round, es. {1,2,...,picco,...,1}
  host_user     uuid,
  ruleset       text,                       -- es. 'sali-e-scendi/v1' (per riproducibilità)
  engine_version text,                      -- versione del motore usato
  rng_seed      text,                       -- seed RNG se disponibile (riproducibilità mazzi)
  status        text not null default 'finished'
                  check (status in ('finished','abandoned')),
  winner_seat   int,
  final_scores  jsonb,                      -- [{seat,user_id,display_name,score,rank}]
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------
-- history.players — identità denormalizzata dei giocatori della partita
-- ------------------------------------------------------------
create table if not exists history.players (
  id           uuid primary key default gen_random_uuid(),
  game_log_id  uuid not null references history.games(id) on delete cascade,
  game_id      uuid,
  seat         int  not null,
  user_id      uuid,
  display_name text,
  final_score  int,
  final_rank   int,                          -- piazzamento 1..num_players
  created_at   timestamptz not null default now(),
  unique (game_log_id, seat)
);

-- ------------------------------------------------------------
-- history.rounds — un record per round di ogni partita (contesto)
-- ------------------------------------------------------------
create table if not exists history.rounds (
  id           uuid primary key default gen_random_uuid(),
  game_log_id  uuid not null references history.games(id) on delete cascade,
  game_id      uuid,
  round_index  int  not null,
  n_cards      int  not null,                -- carte di questo round
  dealer_seat  int  not null,
  first_seat   int  not null,                -- primo a giocare (dopo il mazziere)
  is_no_trump  boolean not null,             -- true = picco (tresette, niente briscola)
  hierarchy    text not null                 -- 'briscola' | 'tresette'
                  check (hierarchy in ('briscola','tresette')),
  briscola     jsonb,                        -- {seed,rank} oppure null
  created_at   timestamptz not null default now(),
  unique (game_log_id, round_index)
);

-- ------------------------------------------------------------
-- history.deals — la mano COMPLETA distribuita a ogni giocatore a inizio round
-- (feature chiave per il ML: cosa aveva in mano prima di dichiarare)
-- ------------------------------------------------------------
create table if not exists history.deals (
  id                uuid primary key default gen_random_uuid(),
  round_log_id      uuid not null references history.rounds(id) on delete cascade,
  game_id           uuid,
  round_index       int  not null,
  seat              int  not null,
  user_id           uuid,
  dealt_hand        jsonb not null,          -- [{seed,rank}] mano iniziale completa
  declaration_order int  not null,           -- 0 = primo a dichiarare nel round
  is_last_declarer  boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (round_log_id, seat)
);

-- ------------------------------------------------------------
-- history.declarations — ogni evento di dichiarazione (azione + stato visto)
-- ------------------------------------------------------------
create table if not exists history.declarations (
  id                 uuid primary key default gen_random_uuid(),
  round_log_id       uuid not null references history.rounds(id) on delete cascade,
  game_id            uuid,
  round_index        int  not null,
  seat               int  not null,
  user_id            uuid,
  declaration_order  int  not null,          -- posizione nell'ordine di dichiarazione
  declared           int  not null,          -- quante prese ha dichiarato
  hand_at_declaration jsonb not null,        -- [{seed,rank}] mano vista al momento
  prior_declarations jsonb not null default '[]'::jsonb, -- [{seat,declared}] già dichiarate prima
  sum_prior          int  not null default 0,-- somma delle dichiarazioni precedenti
  is_last_declarer   boolean not null default false,
  forbidden_value    int,                    -- per l'ultimo: valore vietato (n_cards - sum_prior)
  created_at         timestamptz not null default now(),
  unique (round_log_id, seat)
);

-- ------------------------------------------------------------
-- history.plays — ogni carta giocata (il log delle AZIONI, cuore del dataset)
-- ------------------------------------------------------------
create table if not exists history.plays (
  id            uuid primary key default gen_random_uuid(),
  round_log_id  uuid not null references history.rounds(id) on delete cascade,
  game_id       uuid,
  round_index   int  not null,
  trick_index   int  not null,               -- presa corrente nel round
  play_order    int  not null,               -- ordine dentro la presa (0 = chi apre)
  seat          int  not null,
  user_id       uuid,
  card          jsonb not null,              -- {seed,rank} carta giocata (AZIONE)
  hand_before   jsonb not null,              -- [{seed,rank}] mano prima di giocare (STATO)
  legal_moves   jsonb not null,              -- [{seed,rank}] mosse legali in quel momento (SPAZIO AZIONI)
  table_before  jsonb not null default '[]'::jsonb, -- [{seat,card}] carte già sul tavolo
  lead_seat     int,                         -- chi ha aperto la presa
  lead_suit     text,                        -- seme di uscita
  is_lead       boolean not null default false,
  won_trick     boolean,                     -- valorizzato quando la presa si chiude
  created_at    timestamptz not null default now(),
  unique (round_log_id, trick_index, seat)
);

-- ------------------------------------------------------------
-- history.tricks — una riga per presa chiusa (riepilogo della presa)
-- ------------------------------------------------------------
create table if not exists history.tricks (
  id            uuid primary key default gen_random_uuid(),
  round_log_id  uuid not null references history.rounds(id) on delete cascade,
  game_id       uuid,
  round_index   int  not null,
  trick_index   int  not null,
  lead_seat     int  not null,
  lead_suit     text,
  winner_seat   int  not null,
  plays         jsonb not null,              -- [{seat,card,play_order}] presa completa
  created_at    timestamptz not null default now(),
  unique (round_log_id, trick_index)
);

-- ------------------------------------------------------------
-- history.round_outcomes — esito per giocatore per round (dichiarato/preso/punti)
-- (versione persistente di public.round_results, arricchita per il ML)
-- ------------------------------------------------------------
create table if not exists history.round_outcomes (
  id            uuid primary key default gen_random_uuid(),
  round_log_id  uuid not null references history.rounds(id) on delete cascade,
  game_id       uuid,
  round_index   int  not null,
  seat          int  not null,
  user_id       uuid,
  declared      int  not null,
  taken         int  not null,
  points        int  not null,
  score_after   int,                         -- punteggio cumulato dopo il round
  guessed       boolean not null,            -- declared == taken
  created_at    timestamptz not null default now(),
  unique (round_log_id, seat)
);

-- ============================================================
-- STEP 2: INDICI (export del dataset & query analitiche veloci)
-- ============================================================
create index if not exists idx_hist_games_game_id     on history.games(game_id);
create index if not exists idx_hist_games_finished_at  on history.games(finished_at);
create index if not exists idx_hist_players_game       on history.players(game_log_id);
create index if not exists idx_hist_players_user       on history.players(user_id);
create index if not exists idx_hist_rounds_game        on history.rounds(game_log_id, round_index);
create index if not exists idx_hist_deals_round        on history.deals(round_log_id);
create index if not exists idx_hist_decl_round         on history.declarations(round_log_id);
create index if not exists idx_hist_plays_round        on history.plays(round_log_id, trick_index, play_order);
create index if not exists idx_hist_plays_seat         on history.plays(seat);
create index if not exists idx_hist_tricks_round       on history.tricks(round_log_id, trick_index);
create index if not exists idx_hist_outcomes_round     on history.round_outcomes(round_log_id);

-- ============================================================
-- STEP 3: SICUREZZA (RLS) — solo la service_role legge/scrive
-- Abilitiamo RLS senza policy: i client (authenticated/anon) NON
-- possono leggere la cronologia; l'export ML usa la service_role.
-- ============================================================
alter table history.games          enable row level security;
alter table history.players        enable row level security;
alter table history.rounds         enable row level security;
alter table history.deals          enable row level security;
alter table history.declarations   enable row level security;
alter table history.plays          enable row level security;
alter table history.tricks         enable row level security;
alter table history.round_outcomes enable row level security;

-- ============================================================
-- STEP 4: VISTE COMODE PER L'ESTRAZIONE DEL DATASET ML
-- ============================================================

-- Campioni a livello di MOSSA: una riga per carta giocata, con tutto il
-- contesto della partita/round. Pronto per esportare in CSV/parquet.
create or replace view history.ml_play_samples as
select
  p.id            as play_id,
  g.game_id,
  g.num_players,
  g.max_cards,
  r.round_index,
  r.n_cards,
  r.is_no_trump,
  r.hierarchy,
  r.briscola,
  r.dealer_seat,
  r.first_seat,
  p.trick_index,
  p.play_order,
  p.seat,
  p.user_id,
  p.is_lead,
  p.lead_seat,
  p.lead_suit,
  p.hand_before,
  p.legal_moves,
  p.table_before,
  p.card          as action_card,
  p.won_trick,
  d.declared,
  o.taken         as round_taken,
  o.points        as round_points,
  o.guessed       as round_guessed
from history.plays p
join history.rounds r        on r.id = p.round_log_id
join history.games  g        on g.id = r.game_log_id
left join history.declarations d
       on d.round_log_id = p.round_log_id and d.seat = p.seat
left join history.round_outcomes o
       on o.round_log_id = p.round_log_id and o.seat = p.seat;

-- Campioni a livello di DICHIARAZIONE: una riga per dichiarazione, con la
-- mano vista, lo stato delle dichiarazioni precedenti e l'esito del round.
create or replace view history.ml_declaration_samples as
select
  d.id            as declaration_id,
  g.game_id,
  g.num_players,
  r.round_index,
  r.n_cards,
  r.is_no_trump,
  r.hierarchy,
  r.briscola,
  d.seat,
  d.user_id,
  d.declaration_order,
  d.is_last_declarer,
  d.hand_at_declaration,
  d.prior_declarations,
  d.sum_prior,
  d.forbidden_value,
  d.declared      as action_declared,
  o.taken         as round_taken,
  o.points        as round_points,
  o.guessed       as round_guessed
from history.declarations d
join history.rounds r on r.id = d.round_log_id
join history.games  g on g.id = r.game_log_id
left join history.round_outcomes o
       on o.round_log_id = d.round_log_id and o.seat = d.seat;

-- ============================================================
-- STEP 5: LOG DELLA MIGRATION
-- ============================================================
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '001_v1_game_history',
  'Add history schema (games, players, rounds, deals, declarations, plays, tricks, round_outcomes) + ML views + internal.schema_migrations infra for event-level game logging',
  'soogiue',
  now(),
  'applied'
)
on conflict (version) do update
  set description = excluded.description,
      applied_at  = excluded.applied_at,
      status      = excluded.status;

-- ============================================================
-- STEP 6: VERIFICA
-- ============================================================
select table_name
from information_schema.tables
where table_schema = 'history'
order by table_name;

select table_name
from information_schema.views
where table_schema = 'history'
order by table_name;
