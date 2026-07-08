# Statistiche e storico per account — Design

**Data:** 2026-07-08
**Autore:** soogiue
**Stato:** approvato (design), pronto per il piano di implementazione

## Obiettivo

Dare a ogni account (sub-progetto A, `public.profiles`) una pagina **📊 Statistiche**
raggiungibile dalla home, con tre tab:

- **Le mie:** partite giocate, vinte, win rate, punteggio medio e migliore,
  piazzamento medio, **precisione dichiarazioni** (% di round in cui prendi
  esattamente quanto dichiarato).
- **Storico:** le mie ultime partite concluse (data, n. giocatori, mio punteggio,
  mio piazzamento, vincitore).
- **Classifica:** tutti i giocatori registrati ordinati per **vittorie**, a parità
  di vittorie per **win rate** (colonne: giocate, vinte, %, punti medi).

## Decisioni prese (brainstorming)

- Tutte e quattro le feature (stats, storico, classifica, precisione dichiarazioni).
- **Una sola schermata** dalla home con tre tab (niente numeri sulla home).
- Classifica: **vinte desc, win rate desc**.
- Accesso ai dati via **RPC Postgres `security definer`** (non edge function, non
  RLS diretta sulle tabelle `history`): lo schema `history` resta chiuso ai client
  (è il dataset ML), le funzioni espongono solo aggregati.

## Fonte dati: lo schema `history` esiste già

La migration 001 e `_shared/history.ts` (già cablato nella edge function) scrivono
tutto il necessario alla fine di ogni partita:

- `history.games` — `status='finished'`, `num_players`, `finished_at`, `final_scores`.
- `history.players` — per posto: `user_id`, `display_name`, `final_score`, `final_rank`.
- `history.round_outcomes` — per round/giocatore: `user_id`, `declared`, `taken`,
  `guessed` (declared == taken).

**Zero nuovo logging, zero modifiche alla edge function.**

**Caveat onesto:** le statistiche contano solo le partite concluse da quando il
logging è attivo su Supabase (la migration 001 è ancora PENDING: va applicata col
resto). Le partite precedenti non esistono nel dataset: niente backfill.

## Fuori scope (YAGNI)

Grafici, filtri per periodo, statistiche per numero di giocatori, head-to-head,
badge/achievement, paginazione dello storico oltre il limite, classifica con soglia
minima di partite, cambio nickname (resta per una futura pagina profilo).

## Architettura

```
web/index.html — renderStatsScreen() (3 tab, dalla home)
  │  supabase.rpc("get_my_stats" | "get_my_history" | "get_leaderboard")
  ▼
funzioni SQL security definer (migration 006_stats + db/setup.sql)
  │  leggono history.* e public.profiles con i privilegi del definer
  ▼
schema history (resta SENZA policy di SELECT per i client)
```

`auth.uid()` dentro le funzioni identifica il chiamante: nessun parametro
"user_id" falsificabile. `grant execute to authenticated` soltanto (niente `anon`).

## 1. Migration `006_stats` — tre funzioni RPC

Tutte `security definer`, `set search_path = public, history`, `stable`,
`grant execute ... to authenticated` e `revoke ... from public, anon`.
I bot sono esclusi ovunque (`user_id is not null` è implicito: si filtra
sempre per `user_id = auth.uid()` o si joina `profiles`).

**`public.get_my_stats()` → 1 riga:**

```sql
returns table (
  games int, wins int, win_rate numeric,       -- % 0-100, 1 decimale
  avg_score numeric, best_score int, avg_rank numeric,
  decl_rounds int, decl_exact int, decl_accuracy numeric
)
```

- Base: `history.players hp join history.games hg on hg.id = hp.game_log_id`
  con `hp.user_id = auth.uid()` e `hg.status = 'finished'`.
- `wins` = count con `hp.final_rank = 1`.
- Precisione: da `history.round_outcomes` con `user_id = auth.uid()`
  (`decl_exact` = count con `guessed`), limitata alle partite concluse
  (join a `history.rounds` → `history.games` per lo status).
- Zero partite → riga di zeri (il client mostra l'empty state).

**`public.get_my_history(p_limit int default 20)` → n righe:**

```sql
returns table (
  finished_at timestamptz, num_players int,
  my_score int, my_rank int, winner_name text
)
```

- Stessa base, ordinata `finished_at desc`, `limit p_limit` (cap server a 50).
- `winner_name` = `display_name` del compagno di partita con `final_rank = 1`
  (join di nuovo su `history.players` stesso `game_log_id`).

**`public.get_leaderboard()` → una riga per giocatore registrato:**

```sql
returns table (
  nickname text, games int, wins int, win_rate numeric, avg_score numeric
)
```

- `public.profiles p join history.players hp on hp.user_id = p.id`
  (+ join `history.games` per `status='finished'`), group by `p.id, p.nickname`.
- Ordine: `wins desc, win_rate desc, nickname asc`.
- Chi non ha mai finito una partita **non compare** (inner join): la classifica
  mostra solo chi ha giocato.

Skeleton migration standard: `migrations/006_stats/` (`up.sql`, `down.sql`,
`notes.md`, `metadata.json`) + voce in `MIGRATION_LOG.md` + mirror in
`db/setup.sql`. `down.sql` = `drop function` delle tre.

## 2. Client — schermata Statistiche (`web/index.html`)

**Stato:**

```js
let statsTab = "me";          // "me" | "history" | "board"
let statsCache = null;        // { me, history, board } caricati all'apertura
```

**Home:** sotto i due pannelli esistenti, bottone ghost `📊 Statistiche` →
`UI.openStats()`.

**`openStats()`:** carica in parallelo le tre RPC (`Promise.all`), salva in
`statsCache`, `renderStatsScreen()`. Errore RPC → `showError` e si resta in home.

**`renderStatsScreen()`:** stessa struttura a tab della vista auth (bottone attivo
senza `.ghost`), `game = null`, contenuto per tab:

- **Le mie:** griglia di coppie etichetta/valore (giocate, vinte, win rate %,
  punti medi, miglior punteggio, piazzamento medio, precisione dichiarazioni
  "X/Y (Z%)"). Zero partite → "Nessuna partita ancora: finiscine una e torna qui!".
- **Storico:** tabella `data · giocatori · punti · posto · vincitore`
  (data formattata `dd/mm`, posto come `2°`, vincitore con 🏆). Vuoto → stesso
  empty state.
- **Classifica:** tabella `# · nickname · G · V · % · punti medi`, medaglie
  🥇🥈🥉 per i primi tre, la propria riga evidenziata (`color: var(--gold)`).

Tutti i valori passano da `esc()`. "← Torna" → `render()` (home).

**Cambio tab:** solo re-render dal `statsCache` (niente nuove chiamate; i dati si
ricaricano a ogni apertura della schermata).

## 3. Migration & deploy

- `migrations/006_stats/` + `MIGRATION_LOG.md` + mirror `db/setup.sql`.
- Nessun deploy della function (non tocca `game/index.ts`).
- Ordine: dopo 001 e 005 (usa `history.*` e `profiles`). README: riga in
  "Novità (v1.2)" o sezione v1.3.

## 4. Test manuale

- [ ] `up.sql` gira senza errori dopo 001 e 005; le tre funzioni esistono.
- [ ] Account nuovo → 📊 → "Nessuna partita ancora" su Le mie e Storico;
      Classifica senza la propria riga.
- [ ] Partita completa con 2 account → entrambe le pagine si aggiornano:
      giocate=1, il vincitore ha vinte=1, lo storico mostra la partita col
      vincitore giusto, la classifica ordina il vincitore sopra.
- [ ] Precisione dichiarazioni coerente coi round giocati (contare a mano
      su una partita corta).
- [ ] I bot non compaiono in classifica.
- [ ] `anon` (senza login) non può chiamare le RPC (`revoke` verificato).
- [ ] Le tabelle `history.*` restano NON leggibili direttamente dal client.

## Criteri di completamento

Migration 006 e mirror in setup.sql; tre RPC con `auth.uid()`, definer, grant ai
soli `authenticated`; schermata a 3 tab dalla home con empty state; classifica
ordinata vinte→win rate coi bot esclusi; tutti i punti del test manuale passano.
