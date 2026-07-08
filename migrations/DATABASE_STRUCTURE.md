# Database Structure — Sali e Scendi

Mappa della struttura del database (Supabase / PostgreSQL). Aggiornare a ogni
migration applicata.

## Schema `public` — stato di gioco LIVE (da `db/setup.sql`)

Lo stato di gioco è scritto **solo dalla Edge Function** (service_role, bypassa la
RLS). I client possono solo **leggere**, e ognuno vede solo la propria mano.

### `public.games`
Una partita / stanza. Colonne principali: `id`, `code` (unique), `status`
(`lobby`|`playing`|`finished`), `host_user`, `num_players`, `max_cards`,
`rounds int[]`, `start_cards int` (migration 007: partenza scelta dall'host), `round_index`, `phase`, `n_cards`, `dealer_seat`,
`current_turn_seat`, `briscola jsonb`, `is_no_trump`, `trick_index`,
`trick_lead_seat`, `trick_plays jsonb`, `last_trick_winner`, `winner_seat`,
`created_at`, `updated_at`.

### `public.game_players`
Giocatori di una partita (dati pubblici ai membri). `id`, `game_id`→games,
`user_id`, `seat`, `display_name`, `score`, `declared`, `taken`, `connected`,
`joined_at`, `is_bot` (migration 003: posto-bot della lobby), `autoplay`
(migration 004: posto umano in AUTOGAME, giocato dal server). Unique:
`(game_id, seat)`, `(game_id, user_id)`.

### `public.hands`
Le mani, **private** (RLS: ognuno vede solo la propria). `game_id`,
`round_index`, `seat`, `user_id`, `cards jsonb`. PK `(game_id, round_index, seat)`.

### `public.round_results`
Riepilogo punti di ogni round (pubblico ai membri). `id`, `game_id`,
`round_index`, `seat`, `declared`, `taken`, `points`, `created_at`.

### `public.profiles` (migration 005)
Un profilo per account: `id`→auth.users (cascade), `nickname` (unique
case-insensitive su `lower(nickname)`, 3–20 caratteri), `created_at`. Scritta
**solo dal trigger** `on_auth_user_created` alla registrazione (nickname da
`raw_user_meta_data->>'nickname'`). RLS: SELECT per `anon`+`authenticated`
(serve al pre-check di disponibilità prima del login). **No realtime.**

**Sicurezza:** RLS attiva su tutte; solo policy di SELECT per i client; scrittura
via service_role. Realtime attivo su tutte e quattro le tabelle.

---

## Schema `history` — cronologia EVENT-LEVEL per ML (da migration 001)

Append-only, scritto solo dalla Edge Function (service_role). **Niente FK in
cascade verso `public.games`**: la cronologia sopravvive alla pulizia delle
stanze. RLS abilitata **senza** policy di SELECT per i client → l'export del
dataset usa la service_role.

| Tabella | Descrizione |
|---|---|
| `history.games` | Snapshot immutabile per partita: config, `winner_seat`, `final_scores`, tempi, `ruleset`/`engine_version`/`rng_seed`. |
| `history.players` | Identità per posto: `display_name`, `final_score`, `final_rank`. |
| `history.rounds` | Contesto round: `n_cards`, `dealer_seat`, `first_seat`, `is_no_trump`, `hierarchy`, `briscola`. |
| `history.deals` | Mano completa distribuita a inizio round + `declaration_order`, `is_last_declarer`. |
| `history.declarations` | Ogni dichiarazione: `declared`, `hand_at_declaration`, `prior_declarations`, `sum_prior`, `forbidden_value`. |
| `history.plays` | Ogni carta giocata: `card`, `hand_before`, `legal_moves`, `table_before`, `lead_*`, `won_trick`. |
| `history.tricks` | Riepilogo presa chiusa: `lead_seat`, `winner_seat`, `plays`. |
| `history.round_outcomes` | Per giocatore/round: `declared`, `taken`, `points`, `score_after`, `guessed`. |

### Viste ML
- `history.ml_play_samples` — una riga per carta giocata, con tutto il contesto
  (per imitation learning / RL offline a livello di mossa).
- `history.ml_declaration_samples` — una riga per dichiarazione, con mano vista,
  dichiarazioni precedenti, valore vietato ed esito.

---

## Schema `internal` — infrastruttura migration (da migration 001)

| Tabella | Descrizione |
|---|---|
| `internal.schema_migrations` | Registro delle migration applicate (`version`, `description`, `applied_by`, `applied_at`, `status`). |
| `internal.schema_migrations_rollback` | Registro dei rollback effettuati. |

---

## Funzioni RPC `public` (da migration 006)

`security definer`, execute solo `authenticated`; leggono `history.*` e
`public.profiles` senza aprire lo schema `history` ai client.

| Funzione | Ritorna |
|---|---|
| `get_my_stats()` | 1 riga di aggregati personali (giocate, vinte, win rate, punti, piazzamento, precisione dichiarazioni). |
| `get_my_history(p_limit default 20)` | Ultime partite concluse del chiamante (max 50). |
| `get_leaderboard()` | Una riga per profilo con ≥1 partita conclusa; ordine vinte→win rate→nickname. |
