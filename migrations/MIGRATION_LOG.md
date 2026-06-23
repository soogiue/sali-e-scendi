# Migration Log — Sali e Scendi Database

Storico cronologico delle migration. La fonte di verità "macchina" è
`internal.schema_migrations`; questo file è il registro leggibile.

## Migration applicate

### ⏳ 002_chat_messages
- **Stato:** PENDING (creata, non ancora applicata su Supabase)
- **Creata:** 2026-06-23
- **Autore:** soogiue
- **Descrizione:** Nuova tabella `public.chat_messages` per la chat di stanza
  (lobby + partita), con RLS di SELECT per i membri e Realtime.
- **Schemi aggiunti:** nessuno
- **Tabelle:** public.chat_messages
- **Breaking:** No — solo aggiunte.
- **Scopo:** Chat testuale tra i giocatori di una stanza.
- **Note:** Scritta solo dalla Edge Function (service_role) via `send_message`.
  `on delete cascade` verso `public.games`. Fuori dal dataset ML.

---

### ⏳ 001_v1_game_history
- **Stato:** PENDING (creata, non ancora applicata su Supabase)
- **Creata:** 2026-06-23
- **Autore:** soogiue
- **Descrizione:** Nuovo schema `history` per il logging event-level di ogni
  partita (deals, declarations, plays, tricks, round/game outcomes) + viste ML
  (`ml_play_samples`, `ml_declaration_samples`) + infrastruttura
  `internal.schema_migrations`.
- **Schemi aggiunti:** `history`, `internal`
- **Tabelle:** history.games, history.players, history.rounds, history.deals,
  history.declarations, history.plays, history.tricks, history.round_outcomes,
  internal.schema_migrations, internal.schema_migrations_rollback
- **Breaking:** No — solo aggiunte, nessuna modifica alle tabelle live esistenti.
- **Scopo:** Dataset di training "stato → azione → esito" per addestrare bot ML.
- **Note:** Tabelle append-only scritte dalla Edge Function (service_role). La
  scrittura dei dati lato edge function è un passo successivo.

---

## Schema di base (non migration)

Le tabelle live del gioco sono create da `../db/setup.sql` (non è una migration
numerata): `public.games`, `public.game_players`, `public.hands`,
`public.round_results`, RLS, Realtime e funzioni di supporto.
