# Migration Log — Sali e Scendi Database

Storico cronologico delle migration. La fonte di verità "macchina" è
`internal.schema_migrations`; questo file è il registro leggibile.

## Migration applicate

### ⏳ 006_stats
- **Stato:** PENDING (creata, da applicare su Supabase)
- **Creata:** 2026-07-08
- **Autore:** soogiue
- **Descrizione:** Tre funzioni RPC `security definer` per la schermata 📊:
  `get_my_stats()`, `get_my_history(p_limit)`, `get_leaderboard()`. Solo
  lettura di `history.*` + `public.profiles`; execute ai soli `authenticated`.
- **Schemi aggiunti:** nessuno
- **Tabelle:** nessuna (solo funzioni)
- **Breaking:** No — solo aggiunte; il client senza migration mostra un
  errore aprendo 📊, il gioco non è toccato.
- **Scopo:** Statistiche personali, storico partite e classifica per account.
- **Note:** Richiede 001 (history) e 005 (profiles). Lo schema `history`
  resta chiuso ai client; i bot restano esclusi.

---

### ⏳ 005_profiles
- **Stato:** PENDING (creata, da applicare su Supabase)
- **Creata:** 2026-07-07
- **Autore:** soogiue
- **Descrizione:** Nuova tabella `public.profiles` (nickname unico
  case-insensitive, 3–20 caratteri) creata da un trigger su `auth.users` alla
  registrazione; RLS di SELECT pubblica (serve al check di disponibilità
  pre-signup).
- **Schemi aggiunti:** nessuno
- **Tabelle:** public.profiles
- **Breaking:** SÌ — `create_game`/`join_game` leggono il nickname da
  `profiles`: migration, function e client vanno deployati insieme; login
  anonimo dismesso (Anonymous sign-ins OFF nel dashboard).
- **Scopo:** Account veri (email+password) e identità stabile per lo storico
  e le statistiche per account (sub-progetto B).

---

### ⏳ 004_autoplay
- **Stato:** PENDING (creata, da applicare su Supabase)
- **Creata:** 2026-06-24
- **Autore:** soogiue
- **Descrizione:** Colonna `public.game_players.autoplay` (bool, default false)
  per il tasto **AUTOGAME**: un umano può delegare il proprio posto a un bot ML
  in modo reversibile.
- **Schemi aggiunti:** nessuno
- **Tabelle:** public.game_players (+autoplay)
- **Breaking:** No — colonna nuova con default.
- **Scopo:** Non bloccare la partita se un giocatore smette; il server gioca per
  lui con i modelli ML (`mlbot.ts`), e può riprendere il controllo.

---

### ⏳ 003_bot_players
- **Stato:** PENDING (creata, da applicare su Supabase)
- **Creata:** 2026-06-23
- **Autore:** soogiue
- **Descrizione:** Colonna `public.game_players.is_bot` (bool, default false)
  per i posti-bot impostati dall'host nella lobby.
- **Schemi aggiunti:** nessuno
- **Tabelle:** public.game_players (+is_bot)
- **Breaking:** No — colonna nuova con default.
- **Scopo:** Riempire le stanze con bot giocati dal server.

---

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
