# Migration Log — Sali e Scendi Database

Storico cronologico delle migration. La fonte di verità "macchina" è
`internal.schema_migrations`; questo file è il registro leggibile.

## Migration applicate

### ⏳ 009_endgame_and_trash_toggle
- **Stato:** DA APPLICARE
- **Creata:** 2026-07-10
- **Autore:** soogiue
- **Descrizione:** `public.games`: aggiunto il valore `aborted` ai CHECK di
  `status`/`phase` (l'host può terminare la partita a metà, senza vincitore) e
  la colonna `bots_trash` (bool, default `true`) per l'interruttore in lobby dei
  bot che insultano.
- **Schemi aggiunti:** nessuno
- **Tabelle:** public.games (+bots_trash, CHECK allargati)
- **Breaking:** No — additivo; `aborted` nasce solo dalla nuova azione `end_game`.
- **Scopo:** Fine partita anticipata (host) + scelta in lobby se i bot sfottono.
- **Note:** Richiede il **redeploy della Edge Function `game`** (nuove azioni
  `end_game` e `set_trash_talk`; trashtalk condizionato a `game.bots_trash`) e il
  client aggiornato.

---

### ⏳ 008_login_by_nickname
- **Stato:** DA APPLICARE
- **Creata:** 2026-07-10
- **Autore:** soogiue
- **Descrizione:** Funzione `public.email_for_nickname(text)` `security definer`
  che ricava l'email dell'account dato il nickname (match case-insensitive).
  Abilita il login col solo nickname: il client, se l'input non contiene `@`,
  chiama la RPC per ottenere l'email e poi fa `signInWithPassword`.
- **Schemi aggiunti:** nessuno
- **Tabelle:** nessuna (solo funzione)
- **Breaking:** No — solo aggiunta; senza migration il login funziona ancora
  via email, quello via nickname mostra "Nickname o password sbagliata".
- **Scopo:** Accesso più comodo col nickname, oltre all'email.
- **Note:** `GRANT EXECUTE` ad `anon` (il lookup precede il login). Consente
  l'enumerazione nickname → email; accettabile per un gioco tra amici.
  Richiede 005 (profiles).

---

### ✅ 007_start_cards
- **Stato:** APPLICATA (2026-07-08)
- **Creata:** 2026-07-08
- **Autore:** soogiue
- **Descrizione:** Colonna `public.games.start_cards` (int, default 1,
  check 1–10): da quante carte parte la sequenza dei round, scelta dall'host
  in lobby (azione `set_start_cards`), clampata al picco in `start_game`.
- **Schemi aggiunti:** nessuno
- **Tabelle:** public.games (+start_cards)
- **Breaking:** No — default 1 = comportamento storico.
- **Scopo:** Partite più corte a scelta dell'host (es. 4 → picco → 4).

---

### ✅ 006_stats
- **Stato:** APPLICATA (2026-07-08)
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

### ✅ 005_profiles
- **Stato:** APPLICATA (2026-07-08)
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

### ✅ 004_autoplay
- **Stato:** APPLICATA (data esatta in `internal.schema_migrations`)
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

### ✅ 003_bot_players
- **Stato:** APPLICATA (data esatta in `internal.schema_migrations`)
- **Creata:** 2026-06-23
- **Autore:** soogiue
- **Descrizione:** Colonna `public.game_players.is_bot` (bool, default false)
  per i posti-bot impostati dall'host nella lobby.
- **Schemi aggiunti:** nessuno
- **Tabelle:** public.game_players (+is_bot)
- **Breaking:** No — colonna nuova con default.
- **Scopo:** Riempire le stanze con bot giocati dal server.

---

### ✅ 002_chat_messages
- **Stato:** APPLICATA (data esatta in `internal.schema_migrations`)
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

### ✅ 001_v1_game_history
- **Stato:** APPLICATA (data esatta in `internal.schema_migrations`)
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
