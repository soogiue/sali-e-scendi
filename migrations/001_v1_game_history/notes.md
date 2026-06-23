# 001_v1_game_history — Notes

## Cosa aggiunge

Un nuovo schema **`history`** con il log **event-level** di ogni partita, pensato
per costruire un dataset di training "stato → azione → esito" con cui addestrare
dei bot. In più crea l'infrastruttura **`internal.schema_migrations`** (stile jolo)
per tracciare le migration future.

### Tabelle `history`

- **`games`** — uno snapshot immutabile per partita: config (`num_players`, `max_cards`,
  `rounds`), `winner_seat`, `final_scores` (jsonb), `started_at`/`finished_at`,
  `ruleset`/`engine_version`/`rng_seed` per la riproducibilità.
- **`players`** — identità denormalizzata per posto: `display_name`, `final_score`,
  `final_rank`.
- **`rounds`** — contesto di ogni round: `n_cards`, `dealer_seat`, `first_seat`,
  `is_no_trump`, `hierarchy` (`briscola`|`tresette`), `briscola` (carta o null).
- **`deals`** — la **mano completa** distribuita a ogni giocatore a inizio round +
  `declaration_order` e `is_last_declarer`. *(la feature più importante: cosa aveva
  in mano prima di dichiarare)*
- **`declarations`** — ogni dichiarazione come **azione + stato visto**: `declared`,
  `hand_at_declaration`, `prior_declarations` (chi ha già dichiarato e quanto),
  `sum_prior`, `forbidden_value` (il valore vietato all'ultimo dichiarante).
- **`plays`** — **il cuore del dataset**: ogni carta giocata come azione, con
  `hand_before` (stato), `legal_moves` (spazio delle azioni legali), `table_before`
  (carte già sul tavolo), `lead_seat`/`lead_suit`, `is_lead`, `won_trick`.
- **`tricks`** — riepilogo di ogni presa chiusa: `lead_seat`, `winner_seat`, `plays`.
- **`round_outcomes`** — per giocatore/round: `declared`, `taken`, `points`,
  `score_after`, `guessed` (versione persistente di `public.round_results`).

### Viste per il ML

- **`history.ml_play_samples`** — una riga per carta giocata con tutto il contesto
  (round, briscola, mano, mosse legali, tavolo, azione, esito del round). Pronta da
  esportare in CSV/parquet.
- **`history.ml_declaration_samples`** — una riga per dichiarazione (mano vista,
  dichiarazioni precedenti, valore vietato, dichiarato, esito).

## Perché così

Lo scopo è **imparare le decisioni mossa-per-mossa**, quindi ogni evento salva lo
**stato che il giocatore vedeva** nel momento della scelta (mano, tavolo, mosse
legali, dichiarazioni precedenti) insieme all'**azione** e all'**esito**. È lo
schema classico per imitation learning / RL offline.

## Scelte di design

- **Append-only, scrittura solo lato server.** Le tabelle vengono popolate dalla
  Edge Function (`service_role`, bypassa la RLS), come già fa il resto del gioco.
- **Niente FK in cascade verso `public.games`.** `game_id` è un riferimento "soft":
  la cronologia deve **sopravvivere** alla cancellazione/pulizia delle stanze.
- **RLS abilitata senza policy di SELECT.** I client non leggono la cronologia
  (le mani altrui restano private anche a partita finita). L'export del dataset si
  fa con la `service_role`.
- **Schema separato `history`.** Tiene la cronologia isolata dalle tabelle live e
  rende banale l'export (`select * from history.ml_play_samples`).

## Compatibilità

- ✅ Completamente retro-compatibile: **nessuna modifica** a `public.games`,
  `game_players`, `hands`, `round_results`. Solo aggiunte.
- ✅ Sicuro il rollback con `down.sql` (elimina lo schema `history`; lascia intatto
  `internal`).

## Come applicarla

1. Apri il **SQL Editor** di Supabase del progetto sali-e-scendi.
2. Incolla ed esegui tutto `up.sql`.
3. Verifica che le query finali elenchino le 8 tabelle e le 2 viste in `history`.
4. Aggiorna `applied_at`/`status` in `metadata.json` e la riga in `MIGRATION_LOG.md`.

## Passo successivo (non in questa migration)

Collegare la Edge Function (`supabase/functions/game/index.ts`) perché, durante la
partita, scriva su queste tabelle: a inizio round → `rounds` + `deals`; alla
dichiarazione → `declarations`; a ogni carta → `plays`; a presa chiusa →
`tricks` (+ `won_trick`); a fine round → `round_outcomes`; a fine partita →
`games` + `players`.

## Checklist test manuale

- [ ] `up.sql` gira senza errori nel SQL Editor.
- [ ] Esistono le 8 tabelle in `history` e le 2 viste.
- [ ] Esiste `internal.schema_migrations` con la riga `001_v1_game_history`.
- [ ] RLS attiva su tutte le tabelle `history` (i client non leggono).
- [ ] `down.sql` rimuove lo schema `history` e logga il rollback.
