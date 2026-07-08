# Scelta delle carte di partenza — Design

**Data:** 2026-07-08
**Autore:** soogiue
**Stato:** approvato (design), pronto per il piano di implementazione

## Obiettivo

Partite più corte a scelta dell'host: invece del fisso `1 → picco → 1`, l'host può
scegliere **da quante carte si parte** (es. 4 → picco → 4). Il picco resta
automatico dal numero di giocatori (4 → 10 carte, 5 → 8).

## Decisioni prese (brainstorming)

- Sceglie **l'host, nella lobby** (accanto al selettore bot); tutti vedono la
  scelta in tempo reale.
- Si sceglie **solo la partenza** (1..picco); il picco non si tocca.
- Il picco compare **due volte** anche oggi (`[1..max, max..1]`): con
  `start == picco` la sequenza degenera correttamente in `[picco, picco]`,
  nessun caso speciale.
- Se la scelta supera il picco effettivo al momento dello start (es. scelto 9,
  poi si gioca in 5 → picco 8), il server **clampa** senza errori.

## Fuori scope (YAGNI)

Scelta del picco, sequenze arbitrarie, preset "partita veloce", modifica del
prototipo locale `sali-e-scendi.html` (legacy, resta 1→picco→1).

## Architettura

```
lobby (host) — bottoni "Parti da: 1..8"
  │  invoke("set_start_cards", { gameId, value })     (host-only, lobby-only)
  ▼
public.games.start_cards (int, default 1)  ──realtime──▶ tutti vedono
  │  start_game: clamp a maxCardsFor(n) → roundsSequence(max, start)
  ▼
games.rounds int[] = [start..max, max..start]   (tutto il resto è invariato:
round_index, contatore "mano X/Y", dealing, punteggi leggono già rounds[])
```

Nota per il futuro sub-progetto C (interrompi/riprendi): la sequenza vive in
`games.rounds`, quindi il resume funziona da solo con qualsiasi partenza.

## 1. DB — migration `007_start_cards`

```sql
alter table public.games
  add column if not exists start_cards int not null default 1
  check (start_cards between 1 and 10);
```

- Default 1 = comportamento attuale: **non breaking**.
- Nessuna modifica RLS (i membri leggono già `games`), niente realtime da
  toccare (`games` è già in pubblicazione).
- Skeleton standard: `migrations/007_start_cards/` + voce `MIGRATION_LOG.md` +
  mirror in `db/setup.sql` (colonna nella definizione della tabella `games`).

## 2. Engine — `roundsSequence(maxCards, startCards = 1)`

```ts
export function roundsSequence(maxCards: number, startCards = 1): number[] {
  const from = Math.min(Math.max(1, startCards), maxCards);
  const seq: number[] = [];
  for (let i = from; i <= maxCards; i++) seq.push(i);
  for (let i = maxCards; i >= from; i--) seq.push(i);
  return seq;
}
```

Parametro con default = i chiamanti esistenti non cambiano. Il clamp interno
(`1..maxCards`) rende la funzione totale anche con input strani.

**Test (nuovo file `supabase/functions/_shared/engine_test.ts`, `deno test`):**

- `roundsSequence(10)` → lunghezza 20, inizia 1, picco doppio, finisce 1
  (comportamento storico intatto).
- `roundsSequence(10, 4)` → `[4..10, 10..4]`, lunghezza 14.
- `roundsSequence(8, 8)` → `[8, 8]`.
- `roundsSequence(8, 99)` → clamp → `[8, 8]`; `roundsSequence(8, 0)` → come `(8)`.

## 3. Edge Function — `set_start_cards` + clamp in `start_game`

**Nuova azione** (router + funzione, sullo stile di `set_bots`):

```
set_start_cards { gameId, value } -> { ok: true }
```

Validazioni: partita esistente (404) · solo host (403) · solo `status='lobby'`
(400) · `value` intero 1..10 (400). Poi
`update games set start_cards = value` → il realtime aggiorna tutti.

**In `startGame`** (righe ~161-162), da:

```ts
const maxCards = E.maxCardsFor(n);
const rounds = E.roundsSequence(maxCards);
```

a:

```ts
const maxCards = E.maxCardsFor(n);
const startCards = Math.min(game.start_cards ?? 1, maxCards); // clamp al picco reale
const rounds = E.roundsSequence(maxCards, startCards);
```

Contratto in testa al file aggiornato con la nuova azione.

## 4. Client — lobby (`renderWaiting`)

- **Riga informativa per tutti** (host incluso), sotto l'elenco giocatori:
  `Round: 4 → 10 → 4 (14 mani)` — calcolata da `game.start_cards` e dal picco
  del numero di giocatori attuale (`Math.floor(40/n)`, con n min 4 per il
  calcolo in lobby); conteggio mani = `2*(picco-start+1)`.
- **Controllo host** (solo host, come il selettore bot): etichetta
  "Parti da 🃏" + bottoni numerici `1..picco`, bottone attivo senza `.ghost`;
  tap → `UI.doSetStartCards(k)` → invoke. I bottoni oltre il picco corrente non
  vengono mostrati; se la scelta salvata supera il picco (cambio giocatori), la
  riga informativa mostra il valore clampato.
- Realtime: l'UPDATE su `games` passa già da `refreshAll()` → la lobby si
  ridisegna da sola per tutti.
- In partita nessuna modifica: il contatore "mano X/Y" legge già `rounds[]`.

## 5. Migration & deploy

- `migrations/007_start_cards/` + `MIGRATION_LOG.md` + mirror `db/setup.sql`.
- `supabase functions deploy game` (engine + index cambiano).
- Frontend ripubblicato. README: sezione v1.4 (o accodata alle novità correnti).
- Ordine: 007 prima del deploy della function (la function legge la colonna;
  senza colonna `game.start_cards` è `undefined` → `?? 1` → comunque safe).

## 6. Test manuale

- [ ] `deno test supabase/functions/_shared/engine_test.ts` verde.
- [ ] Lobby: l'host vede i bottoni 1..picco; gli altri NO ma vedono la riga Round.
- [ ] Host sceglie 4 → tutti vedono "Round: 4 → 10 → 4 (14 mani)" in tempo reale.
- [ ] Start con 4 giocatori e partenza 4 → la prima mano dà 4 carte; il contatore
      dice "mano 1/14"; la partita finisce dopo 14 mani.
- [ ] Scelta 9 con 5 giocatori (picco 8) → si parte da 8 senza errori ([8,8]).
- [ ] Non-host che invoca `set_start_cards` → 403; a partita iniziata → 400.
- [ ] Partita senza toccare nulla → identica a prima (1 → picco → 1).

## Criteri di completamento

Colonna e migration 007; `roundsSequence` con partenza parametrica e test deno
verdi; azione `set_start_cards` validata; lobby con controllo host e riga
informativa live; clamp allo start; tutti i punti del test manuale passano.
