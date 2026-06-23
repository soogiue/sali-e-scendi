-- ============================================================
--  SALI E SCENDI — SETUP DATABASE COMPLETO (v1.1) — DA ZERO
--  Esegui TUTTO questo file nel SQL Editor di Supabase.
--
--  ATTENZIONE: ricrea le tabelle da capo -> CANCELLA le partite
--  esistenti. È pensato per ripartire pulito con le novità v1.1
--  (timer di turno: colonna turn_deadline).
--
--  È ri-eseguibile: puoi lanciarlo più volte senza errori.
--
--  Modello: lo stato di gioco è scritto SOLO dalla Edge Function
--  (service_role, bypassa la RLS). I client possono solo LEGGERE,
--  e ognuno vede solo la PROPRIA mano.
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- PULIZIA (drop da capo) ----------
-- Il drop ... cascade rimuove anche le tabelle dalla publication realtime.
drop table if exists public.round_results cascade;
drop table if exists public.hands         cascade;
drop table if exists public.game_players  cascade;
drop table if exists public.games         cascade;

-- ---------- TABELLE ----------

-- Una partita / stanza
create table public.games (
  id                uuid primary key default gen_random_uuid(),
  code              text unique not null,                 -- codice stanza (es. "ABCD")
  status            text not null default 'lobby'
                      check (status in ('lobby','playing','finished')),
  host_user         uuid not null,                        -- chi ha creato la stanza
  num_players       int,                                  -- fissato all'avvio (4 o 5)
  max_cards         int,                                  -- 10 (4 gioc.) o 8 (5 gioc.)
  rounds            int[],                                -- sequenza dei round, es. {1,2,...,8,8,...,1}
  round_index       int not null default 0,               -- indice nel vettore rounds
  phase             text not null default 'lobby'
                      check (phase in ('lobby','declaring','playing','trick_done','round_end','finished')),
  n_cards           int,                                  -- carte di QUESTO round
  dealer_seat       int,                                  -- posto del mazziere del round
  current_turn_seat int,                                  -- a chi tocca (dichiarare o giocare)
  briscola          jsonb,                                -- {seed,rank} oppure null (tresette)
  is_no_trump       boolean not null default false,       -- true nei round di picco
  trick_index       int not null default 0,               -- presa corrente nel round
  trick_lead_seat   int,                                  -- chi ha aperto la presa corrente
  trick_plays       jsonb not null default '[]'::jsonb,   -- [{seat,card}] carte sul tavolo (PUBBLICO)
  last_trick_winner int,
  winner_seat       int,                                  -- vincitore partita (a fine gioco)
  turn_deadline     timestamptz,                          -- scadenza del turno corrente (timer 15s, auto-mossa allo scadere)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- I giocatori di una partita (dati PUBBLICI ai membri: nome, punteggio, dichiarazione, prese)
create table public.game_players (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games(id) on delete cascade,
  user_id      uuid not null,
  seat         int  not null,                 -- 0..num_players-1
  display_name text not null,
  score        int  not null default 0,       -- punteggio totale partita
  declared     int,                           -- dichiarazione round corrente (null = non ancora)
  taken        int  not null default 0,       -- prese fatte nel round corrente
  connected    boolean not null default true,
  joined_at    timestamptz not null default now(),
  unique (game_id, seat),
  unique (game_id, user_id)
);

-- Le mani: PRIVATE. Ogni riga è leggibile solo dal suo proprietario (RLS sotto).
create table public.hands (
  game_id      uuid not null references public.games(id) on delete cascade,
  round_index  int  not null,
  seat         int  not null,
  user_id      uuid not null,
  cards        jsonb not null,                -- [{seed,rank}] mano CORRENTE del giocatore
  primary key (game_id, round_index, seat)
);

-- Riepilogo punti di ogni round (storico, pubblico ai membri)
create table public.round_results (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games(id) on delete cascade,
  round_index  int  not null,
  seat         int  not null,
  declared     int  not null,
  taken        int  not null,
  points       int  not null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_game_players_game  on public.game_players(game_id);
create index if not exists idx_hands_owner         on public.hands(user_id);
create index if not exists idx_round_results_game  on public.round_results(game_id, round_index);

-- ---------- FUNZIONE DI SUPPORTO (membership) ----------
-- SECURITY DEFINER: legge game_players bypassando la RLS, così le policy
-- non vanno in ricorsione infinita.
create or replace function public.is_game_member(g uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.game_players gp
    where gp.game_id = g and gp.user_id = auth.uid()
  );
$$;

-- ---------- RLS: abilita su tutte le tabelle ----------
alter table public.games          enable row level security;
alter table public.game_players   enable row level security;
alter table public.hands          enable row level security;
alter table public.round_results  enable row level security;

-- Niente policy di INSERT/UPDATE/DELETE per i client:
-- tutte le scritture passano dalla Edge Function (service_role), che bypassa la RLS.
-- Definiamo SOLO le policy di lettura (SELECT).

-- games: leggibile dai membri della partita
drop policy if exists games_select on public.games;
create policy games_select on public.games
  for select to authenticated
  using ( public.is_game_member(id) );

-- game_players: i membri vedono tutti i giocatori della propria partita
drop policy if exists game_players_select on public.game_players;
create policy game_players_select on public.game_players
  for select to authenticated
  using ( public.is_game_member(game_id) );

-- hands: ognuno vede SOLO la propria mano
drop policy if exists hands_select_own on public.hands;
create policy hands_select_own on public.hands
  for select to authenticated
  using ( user_id = auth.uid() );

-- round_results: leggibili dai membri
drop policy if exists round_results_select on public.round_results;
create policy round_results_select on public.round_results
  for select to authenticated
  using ( public.is_game_member(game_id) );

-- ---------- REALTIME ----------
-- Fa sì che i client ricevano in tempo reale le modifiche (rispettando la RLS:
-- le modifiche a 'hands' arrivano solo al proprietario della mano).
-- Aggiunge ogni tabella alla publication solo se non c'è già (ri-eseguibile).
do $$
begin
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='games') then
    alter publication supabase_realtime add table public.games;
  end if;
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='game_players') then
    alter publication supabase_realtime add table public.game_players;
  end if;
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='hands') then
    alter publication supabase_realtime add table public.hands;
  end if;
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='round_results') then
    alter publication supabase_realtime add table public.round_results;
  end if;
end $$;

-- ---------- trigger updated_at su games ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_games_touch on public.games;
create trigger trg_games_touch before update on public.games
  for each row execute function public.touch_updated_at();

-- Fine setup completo (v1.1).
