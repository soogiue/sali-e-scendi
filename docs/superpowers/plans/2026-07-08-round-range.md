# Scelta delle carte di partenza — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L'host sceglie in lobby da quante carte si parte (1..picco); la partita gioca `[start..picco, picco..start]` invece del fisso `1..picco..1`.

**Architecture:** Colonna `games.start_cards` (default 1, non-breaking) impostata da una nuova azione host-only `set_start_cards`; `roundsSequence` prende un secondo parametro con default; `startGame` clampa al picco reale. La lobby mostra a tutti la riga "Round: X → Y → X (N mani)" e all'host i bottoni di scelta. In partita zero modifiche (tutto legge già `games.rounds`).

**Tech Stack:** Postgres (migration 007), Deno/TS edge function + engine (con primo `deno test` del repo), client vanilla JS.

**Spec:** `docs/superpowers/specs/2026-07-08-round-range-design.md`
**Branch:** `round-range`

---

### Task 1: Migration `007_start_cards` + mirror `db/setup.sql`

**Files:**
- Create: `migrations/007_start_cards/up.sql`
- Create: `migrations/007_start_cards/down.sql`
- Create: `migrations/007_start_cards/metadata.json`
- Create: `migrations/007_start_cards/notes.md`
- Modify: `migrations/MIGRATION_LOG.md` (voce in cima, prima di `### ⏳ 006_stats`)
- Modify: `db/setup.sql` (colonna nella definizione di `games` + alter di comodo)
- Modify: `migrations/DATABASE_STRUCTURE.md` (riga colonna in `public.games`)

- [ ] **Step 1: Crea `migrations/007_start_cards/up.sql`**

```sql
-- Migration: 007_start_cards
-- Author: soogiue
-- Date: 2026-07-08
-- Reason: L'host sceglie da quante carte si parte (partite piu corte).
-- Affected: public.games (+ colonna start_cards). Nient'altro.
-- Note di design:
--   * default 1 = comportamento storico (1 -> picco -> 1): NON breaking.
--   * il valore e' un DESIDERIO dell'host: il clamp al picco reale avviene
--     in start_game (es. scelto 9 ma 5 giocatori -> picco 8 -> si parte da 8).
--   * niente RLS/realtime da toccare: games e' gia' leggibile dai membri
--     e gia' in pubblicazione realtime.
-- ============================================================

alter table public.games
  add column if not exists start_cards int not null default 1
  check (start_cards between 1 and 10);

-- ------------------------------------------------------------
-- LOG DELLA MIGRATION
-- ------------------------------------------------------------
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '007_start_cards',
  'Add public.games.start_cards (int default 1): host-chosen starting hand size',
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
where table_schema = 'public' and table_name = 'games' and column_name = 'start_cards';
```

> Nota: `add column if not exists ... check (...)` — se la colonna esiste già il
> check non viene ri-aggiunto, coerente con lo stile idempotente del repo.

- [ ] **Step 2: Crea `migrations/007_start_cards/down.sql`**

```sql
-- Migration Rollback: 007_start_cards
-- Elimina la colonna start_cards: le nuove partite tornano a 1 -> picco -> 1.
-- Le partite in corso NON si rompono (rounds e' gia' materializzato).
-- ============================================================

-- STEP 1: COLONNA
alter table public.games drop column if exists start_cards;

-- STEP 2: LOG DEL ROLLBACK
insert into internal.schema_migrations_rollback (version, rolled_back_by, rolled_back_at)
values ('007_start_cards', 'soogiue', now());

-- STEP 3: VERIFICA
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'games' and column_name = 'start_cards';
```

- [ ] **Step 3: Crea `migrations/007_start_cards/metadata.json`**

```json
{
  "version": "007_start_cards",
  "description": "Add public.games.start_cards (int not null default 1, check 1-10): host-chosen starting hand size, clamped to the real peak at start_game",
  "author": "soogiue",
  "created_at": "2026-07-08",
  "applied_at": null,
  "status": "pending",
  "breaking": false,
  "schemas_added": [],
  "tables_affected": ["public.games"],
  "views_added": [],
  "reason": "Partite piu corte: l'host sceglie in lobby da quante carte si parte (es. 4 -> picco -> 4)",
  "notes": "Default 1 = comportamento storico, non breaking. Impostata dalla nuova azione set_start_cards (host-only, lobby-only). Il clamp al picco reale (maxCardsFor(n)) avviene in start_game. Nessuna modifica a RLS o realtime."
}
```

- [ ] **Step 4: Crea `migrations/007_start_cards/notes.md`**

```markdown
# 007_start_cards — Note

## Cosa fa

Aggiunge `public.games.start_cards` (int, default 1, check 1–10): da quante
carte parte la sequenza dei round. La sequenza resta `[start..picco, picco..start]`
(picco due volte, come oggi); con `start = picco` degenera in `[picco, picco]`.

## Flusso

1. L'host la imposta in lobby con l'azione `set_start_cards` (host-only,
   lobby-only, 1–10); il realtime la mostra a tutti.
2. `start_game` la clampa al picco reale del tavolo (`maxCardsFor(n)`:
   10 con 4 giocatori, 8 con 5) e materializza `games.rounds`.
3. Da lì in poi tutto legge `rounds`: nessun'altra parte del sistema cambia
   (contatore mani, dealing, punteggi, e il futuro riprendi-partita).

## Compatibilità

- Default 1 → chi non tocca nulla gioca come prima: NON breaking.
- Function vecchia + colonna nuova: la colonna viene ignorata, ok.
- Function nuova + colonna mancante: `game.start_cards` è undefined →
  `?? 1` nel codice → comportamento storico, nessun errore.

## Rollback

`down.sql` droppa la colonna. Le partite già iniziate non si rompono
(`rounds` è già materializzato); le nuove tornano a 1 → picco → 1.
```

- [ ] **Step 5: Voce in `migrations/MIGRATION_LOG.md`** (in cima, prima di `### ⏳ 006_stats`):

```markdown
### ⏳ 007_start_cards
- **Stato:** PENDING (creata, da applicare su Supabase)
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
```

- [ ] **Step 6: `db/setup.sql`** — nella definizione di `create table if not exists public.games (...)`, aggiungi DOPO la riga `rounds            int[],  -- sequenza dei round, ...`:

```sql
  start_cards       int not null default 1
                      check (start_cards between 1 and 10), -- da quante carte si parte (scelta host, v1.4)
```

e, accanto all'alter di comodo esistente (`alter table public.games add column if not exists turn_deadline timestamptz;`), aggiungi:

```sql
alter table public.games add column if not exists start_cards int not null default 1;
```

- [ ] **Step 7: `migrations/DATABASE_STRUCTURE.md`** — nella sezione `### public.games`, aggiungi `start_cards` all'elenco colonne (dopo `rounds int[]`), con nota `(migration 007: partenza scelta dall'host)`.

- [ ] **Step 8: Commit**

```bash
git add migrations/007_start_cards migrations/MIGRATION_LOG.md db/setup.sql migrations/DATABASE_STRUCTURE.md
git commit -m "feat(db): migration 007 start_cards (partenza scelta dall'host)"
```

---

### Task 2: Engine — `roundsSequence` parametrica + primo deno test

**Files:**
- Modify: `supabase/functions/_shared/engine.ts` (funzione `roundsSequence`, riga ~56)
- Create: `supabase/functions/_shared/engine_test.ts`

- [ ] **Step 1: Scrivi il test PRIMA (`engine_test.ts`)**

```ts
// Primo test del repo: deno test supabase/functions/_shared/engine_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { roundsSequence, maxCardsFor } from "./engine.ts";

Deno.test("roundsSequence storica: 1..max, max..1 (picco doppio)", () => {
  const seq = roundsSequence(10);
  assertEquals(seq.length, 20);
  assertEquals(seq[0], 1);
  assertEquals(seq[9], 10);
  assertEquals(seq[10], 10);
  assertEquals(seq[19], 1);
});

Deno.test("roundsSequence con partenza: 4 -> 10 -> 4", () => {
  const seq = roundsSequence(10, 4);
  assertEquals(seq, [4,5,6,7,8,9,10,10,9,8,7,6,5,4]);
  assertEquals(seq.length, 2 * (10 - 4 + 1));
});

Deno.test("roundsSequence partenza == picco: [picco, picco]", () => {
  assertEquals(roundsSequence(8, 8), [8, 8]);
});

Deno.test("roundsSequence clampa input fuori range", () => {
  assertEquals(roundsSequence(8, 99), [8, 8]);        // sopra il picco
  assertEquals(roundsSequence(8, 0), roundsSequence(8)); // sotto 1
});

Deno.test("maxCardsFor: 4 -> 10, 5 -> 8 (invariata)", () => {
  assertEquals(maxCardsFor(4), 10);
  assertEquals(maxCardsFor(5), 8);
});
```

- [ ] **Step 2: Esegui il test → deve FALLIRE**

```bash
deno test supabase/functions/_shared/engine_test.ts
```

Expected: il test "con partenza" fallisce (la firma attuale ignora il secondo argomento → TS error o sequenza sbagliata). Se `deno` non è installato, salta le esecuzioni e segnalalo nel report.

- [ ] **Step 3: Modifica `roundsSequence` in `engine.ts`** — da:

```ts
// Sequenza dei round: [1..max, max..1] (il picco compare due volte)
export function roundsSequence(maxCards: number): number[] {
  const seq: number[] = [];
  for (let i = 1; i <= maxCards; i++) seq.push(i);
  for (let i = maxCards; i >= 1; i--) seq.push(i);
  return seq;
}
```

a:

```ts
// Sequenza dei round: [start..max, max..start] (il picco compare due volte).
// startCards ha default 1 (comportamento storico) e viene clampato a 1..max.
export function roundsSequence(maxCards: number, startCards = 1): number[] {
  const from = Math.min(Math.max(1, startCards), maxCards);
  const seq: number[] = [];
  for (let i = from; i <= maxCards; i++) seq.push(i);
  for (let i = maxCards; i >= from; i--) seq.push(i);
  return seq;
}
```

- [ ] **Step 4: Esegui i test → tutti verdi**

```bash
deno test supabase/functions/_shared/engine_test.ts
deno check supabase/functions/_shared/engine.ts supabase/functions/game/index.ts
```

Expected: 5 test PASS, typecheck pulito.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/engine.ts supabase/functions/_shared/engine_test.ts
git commit -m "feat(engine): roundsSequence con partenza parametrica + primi deno test"
```

---

### Task 3: Edge Function — azione `set_start_cards` + clamp in `start_game`

**Files:**
- Modify: `supabase/functions/game/index.ts` (contratto in testa, router, `startGame` righe ~161-162, nuova funzione accanto a `setBots` riga ~341)

- [ ] **Step 1: Contratto in testa al file** — dopo la riga `//   - set_bots    { gameId, count }            (host/lobby: imposta quanti bot)` aggiungi:

```ts
//   - set_start_cards { gameId, value }        (host/lobby: da quante carte si parte, 1..10)
```

- [ ] **Step 2: Router** — dopo `case "set_bots": ...` aggiungi:

```ts
      case "set_start_cards": return await setStartCards(db, user.id, body);
```

- [ ] **Step 3: Nuova funzione** subito PRIMA di `async function setBots(...)` (stile identico):

```ts
// Host: da quante carte si parte (solo in lobby). Il clamp al picco reale
// del tavolo avviene in startGame (qui il numero di giocatori puo' ancora cambiare).
async function setStartCards(db: any, userId: string, body: any) {
  const { data: game } = await db.from("games").select("*").eq("id", body.gameId).single();
  if (!game) return json({ error: "Partita non trovata" }, 404);
  if (game.host_user !== userId) return json({ error: "Solo l'host può scegliere la partenza" }, 403);
  if (game.status !== "lobby") return json({ error: "La partenza si sceglie prima dell'inizio" }, 400);

  const value = Number(body.value);
  if (!Number.isInteger(value) || value < 1 || value > 10)
    return json({ error: "Partenza non valida (1–10)" }, 400);

  const { error } = await db.from("games").update({ start_cards: value }).eq("id", game.id);
  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
}
```

- [ ] **Step 4: Clamp in `startGame`** — sostituisci:

```ts
  const maxCards = E.maxCardsFor(n);
  const rounds = E.roundsSequence(maxCards);
```

con:

```ts
  const maxCards = E.maxCardsFor(n);
  const startCards = Math.min(game.start_cards ?? 1, maxCards); // clamp al picco reale
  const rounds = E.roundsSequence(maxCards, startCards);
```

- [ ] **Step 5: Typecheck**

```bash
deno check supabase/functions/game/index.ts
```

Expected: pulito. (Se deno manca, segnala e salta.)

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/game/index.ts
git commit -m "feat(edge): azione set_start_cards + clamp della partenza in start_game"
```

---

### Task 4: Client — lobby con scelta partenza + riga Round

**Files:**
- Modify: `web/index.html` — `doSetBots` area (riga ~329), `window.UI` (riga ~342), `renderWaiting()` (righe ~761-793)

- [ ] **Step 1: Azione client** — dopo `async function doSetBots(count){ ... }` aggiungi:

```js
async function doSetStartCards(v){ await invoke("set_start_cards", { gameId, value:v }); }
```

- [ ] **Step 2: `window.UI`** — aggiungi `doSetStartCards` alla lista (nessun export rimosso).

- [ ] **Step 3: Sostituisci `renderWaiting()` per intero** con:

```js
function renderWaiting(){
  const isHost = game.host_user===myUserId;
  const humans = players.filter(p=>!p.is_bot).length;
  const bots = players.filter(p=>p.is_bot).length;
  const n = players.length;
  const maxBots = 5 - humans;

  // picco previsto: col tavolo incompleto (<4) si assume 4 giocatori (picco 10)
  const peak = Math.floor(40 / Math.max(4, n));
  const startRaw = game.start_cards || 1;
  const start = Math.min(startRaw, peak);           // specchio del clamp server
  const hands = 2 * (peak - start + 1);
  const roundLine = '<p class="tiny" style="margin-top:10px">Round: <b style="color:var(--gold)">'+
    start+' → '+peak+' → '+start+'</b> ('+hands+' mani)</p>';

  let botCtrl = "";
  let startCtrl = "";
  if(isHost){
    let btns="";
    for(let k=0;k<=maxBots;k++){
      btns+='<button class="'+(k===bots?'':'ghost')+'" style="width:auto;margin:0 4px 4px 0;padding:8px 14px" data-bots="'+k+'">'+k+'</button>';
    }
    botCtrl = '<p class="tiny" style="margin-top:12px">Aggiungi bot 🤖 (per riempire i posti)</p>'+
      '<div style="display:flex;flex-wrap:wrap;justify-content:center">'+btns+'</div>';

    let sbtns="";
    for(let k=1;k<=peak;k++){
      sbtns+='<button class="'+(k===start?'':'ghost')+'" style="width:auto;margin:0 4px 4px 0;padding:8px 12px" data-startc="'+k+'">'+k+'</button>';
    }
    startCtrl = '<p class="tiny" style="margin-top:12px">Parti da 🃏 (1 = partita completa)</p>'+
      '<div style="display:flex;flex-wrap:wrap;justify-content:center">'+sbtns+'</div>';
  }

  app.innerHTML =
  '<h1>Stanza creata</h1><p class="sub">Condividi questo codice con gli amici</p>'+
  '<div class="panel center"><div class="big-code">'+esc(myCode)+'</div>'+
    '<p class="tiny">Giocatori ('+n+'/5):</p><div class="scores" style="justify-content:center">'+
    players.map(p=>'<span class="chip">'+esc(p.display_name)+
      (p.user_id===game.host_user?" 👑":"")+(p.is_bot?" 🤖":"")+'</span>').join("")+'</div>'+
    roundLine+
    startCtrl+
    botCtrl+
    (isHost
      ? (n>=4 ? '<button onclick="UI.doStart()">Inizia partita ('+n+' giocatori)</button>'
              : '<p class="waitmsg">Servono almeno 4 giocatori (max 5). Aggiungi amici o bot.</p>')
      : '<p class="waitmsg">In attesa che l\'host inizi…</p>')+
  '</div>';

  if(isHost) document.querySelectorAll("[data-bots]")
    .forEach(b=>b.onclick=()=>UI.doSetBots(parseInt(b.dataset.bots,10)));
  if(isHost) document.querySelectorAll("[data-startc]")
    .forEach(b=>b.onclick=()=>UI.doSetStartCards(parseInt(b.dataset.startc,10)));
}
```

(differenze rispetto all'attuale: le costanti `peak/start/hands` + `roundLine`, il blocco `startCtrl` per l'host, `roundLine+startCtrl+` nell'HTML, e il secondo `querySelectorAll` per `[data-startc]`. Tutto il resto è identico.)

- [ ] **Step 4: Syntax check**

```bash
node -e "const fs=require('fs');const html=fs.readFileSync('web/index.html','utf8');const m=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];m.forEach((x,i)=>{const src=x[1].replace(/^\s*import .*$/gm,'');try{new Function(src);console.log('script',i,'OK')}catch(e){console.log('script',i,'FAIL',e.message);process.exit(1)}})"
```

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "feat(web): lobby con scelta della partenza (host) e riga Round per tutti"
```

---

### Task 5: Docs — README

**Files:**
- Modify: `README.md` (sezione dopo "## Novità (v1.3)"; aggiorna anche la riga delle regole)

- [ ] **Step 1: Nuova sezione**

```markdown
## Novità (v1.4)

- **Partite più corte**: in lobby l'host sceglie **da quante carte si parte**
  (es. 4 → 10 → 4 invece di 1 → 10 → 1). Il picco resta automatico dal numero
  di giocatori; tutti vedono la scelta in tempo reale. Default: 1 (come prima).

> ⚠️ Per attivarla: esegui `migrations/007_start_cards/up.sql`, ri-pubblica la
> function (`supabase functions deploy game`) e il frontend.
```

- [ ] **Step 2: Riga regole** — in "## Regole implementate", cambia `round 1…picco…1` in `round 1…picco…1 (o partenza scelta dall'host, v1.4)`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: novità v1.4 (scelta carte di partenza)"
```

---

### Task 6: Collaudo manuale (serve Supabase attivo)

**Prerequisiti:** migration 007 applicata, function deployata, frontend pubblicato.

- [ ] `deno test supabase/functions/_shared/engine_test.ts` → 5 PASS.
- [ ] Lobby: host vede "Parti da 🃏" con bottoni 1..10 (4 giocatori attesi); gli altri vedono solo la riga Round.
- [ ] Host sceglie 4 → per tutti "Round: 4 → 10 → 4 (14 mani)" in tempo reale.
- [ ] Start → prima mano da 4 carte, contatore "mano 1/14", partita finisce dopo 14 mani.
- [ ] 5 giocatori + scelta 9 → riga Round mostra 8 → 8 → 8... (clamp visivo) e la partita parte da 8 senza errori.
- [ ] Non-host: `set_start_cards` → 403 (da console). A partita iniziata → 400.
- [ ] Partita senza toccare la scelta → 1 → picco → 1 identica a prima.
- [ ] Stats (v1.3): la partita corta conclusa compare nello storico normalmente.
