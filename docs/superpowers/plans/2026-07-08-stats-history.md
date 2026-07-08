# Statistiche e storico per account — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Schermata 📊 dalla home con tre tab (Le mie · Storico · Classifica) alimentata da tre funzioni SQL `security definer` che leggono lo schema `history` esistente.

**Architecture:** Nessun nuovo logging e nessuna modifica alla edge function: `_shared/history.ts` scrive già `history.players` (user_id, final_score, final_rank) e `history.round_outcomes` (user_id, guessed) alla fine di ogni partita. Migration `006_stats` aggiunge 3 RPC in `public` (definer, `auth.uid()`, grant solo `authenticated`); il client le chiama con `supabase.rpc(...)` e renderizza una vista a tab nello stile della vista auth. I bot hanno user_id sintetici senza riga in `profiles`, quindi restano fuori da tutte le query.

**Tech Stack:** Postgres (funzioni `language sql stable security definer`), supabase-js `rpc`, client vanilla JS in `web/index.html`.

**Spec:** `docs/superpowers/specs/2026-07-08-stats-history-design.md`
**Branch:** `stats`

**Nota sui test:** come per i piani precedenti, niente harness SQL/client: verifica per ispezione (idempotenza, grant) + syntax-check dello script inline + collaudo manuale finale (Task 5) con Supabase attivo.

---

### Task 1: Migration `006_stats`

**Files:**
- Create: `migrations/006_stats/up.sql`
- Create: `migrations/006_stats/down.sql`
- Create: `migrations/006_stats/metadata.json`
- Create: `migrations/006_stats/notes.md`
- Modify: `migrations/MIGRATION_LOG.md` (nuova voce in cima a "## Migration applicate", prima della voce `### ⏳ 005_profiles`)

- [ ] **Step 1: Crea `migrations/006_stats/up.sql`**

```sql
-- Migration: 006_stats
-- Author: soogiue
-- Date: 2026-07-08
-- Reason: Statistiche/storico/classifica per account (schermata 📊 del client).
-- Affected: tre funzioni RPC in public (get_my_stats, get_my_history,
--           get_leaderboard). NESSUNA tabella nuova, NESSUNA modifica a dati.
-- Note di design:
--   * security definer: leggono history.* e public.profiles senza aprire
--     lo schema history ai client (resta il dataset ML, service_role only).
--   * auth.uid() identifica il chiamante: nessun parametro user_id falsificabile.
--   * grant execute SOLO ad authenticated (revoke da public/anon).
--   * I bot hanno user_id sintetici senza riga in profiles: esclusi ovunque
--     (filtro auth.uid() o inner join profiles).
--   * Richiede le migration 001 (schema history) e 005 (profiles).
-- ============================================================

-- ------------------------------------------------------------
-- get_my_stats() — aggregati personali (1 riga, zeri se mai giocato)
-- ------------------------------------------------------------
create or replace function public.get_my_stats()
returns table (
  games int, wins int, win_rate numeric,
  avg_score numeric, best_score int, avg_rank numeric,
  decl_rounds int, decl_exact int, decl_accuracy numeric
)
language sql stable security definer
set search_path = public, history
as $$
  with mine as (
    select hp.final_score, hp.final_rank
    from history.players hp
    join history.games hg on hg.id = hp.game_log_id
    where hp.user_id = auth.uid() and hg.status = 'finished'
  ),
  decl as (
    select count(*)::int as rounds,
           (count(*) filter (where ro.guessed))::int as exact
    from history.round_outcomes ro
    join history.rounds hr on hr.id = ro.round_log_id
    join history.games hg on hg.id = hr.game_log_id
    where ro.user_id = auth.uid() and hg.status = 'finished'
  )
  select
    count(*)::int,
    (count(*) filter (where m.final_rank = 1))::int,
    case when count(*) = 0 then 0
         else round(100.0 * (count(*) filter (where m.final_rank = 1)) / count(*), 1) end,
    coalesce(round(avg(m.final_score), 1), 0),
    coalesce(max(m.final_score), 0)::int,
    coalesce(round(avg(m.final_rank), 2), 0),
    (select rounds from decl),
    (select exact from decl),
    (select case when rounds = 0 then 0 else round(100.0 * exact / rounds, 1) end from decl)
  from mine m;
$$;

-- ------------------------------------------------------------
-- get_my_history(p_limit) — le mie ultime partite concluse (cap 50)
-- ------------------------------------------------------------
create or replace function public.get_my_history(p_limit int default 20)
returns table (
  finished_at timestamptz, num_players int,
  my_score int, my_rank int, winner_name text
)
language sql stable security definer
set search_path = public, history
as $$
  select hg.finished_at, hg.num_players,
         hp.final_score, hp.final_rank,
         w.display_name
  from history.players hp
  join history.games hg on hg.id = hp.game_log_id
  left join history.players w on w.game_log_id = hp.game_log_id and w.final_rank = 1
  where hp.user_id = auth.uid() and hg.status = 'finished'
  order by hg.finished_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- ------------------------------------------------------------
-- get_leaderboard() — una riga per giocatore registrato che ha
-- finito almeno una partita. Ordine: vinte, win rate, nickname.
-- ------------------------------------------------------------
create or replace function public.get_leaderboard()
returns table (
  nickname text, games int, wins int, win_rate numeric, avg_score numeric
)
language sql stable security definer
set search_path = public, history
as $$
  select p.nickname,
         count(*)::int,
         (count(*) filter (where hp.final_rank = 1))::int,
         round(100.0 * (count(*) filter (where hp.final_rank = 1)) / count(*), 1),
         round(avg(hp.final_score), 1)
  from public.profiles p
  join history.players hp on hp.user_id = p.id
  join history.games hg on hg.id = hp.game_log_id and hg.status = 'finished'
  group by p.id, p.nickname
  order by 3 desc, 4 desc, 1 asc;
$$;

-- ------------------------------------------------------------
-- PERMESSI: solo utenti loggati. (Le funzioni nascono con EXECUTE
-- a PUBLIC: il revoke è indispensabile.)
-- ------------------------------------------------------------
revoke all on function public.get_my_stats() from public, anon;
revoke all on function public.get_my_history(int) from public, anon;
revoke all on function public.get_leaderboard() from public, anon;
grant execute on function public.get_my_stats() to authenticated;
grant execute on function public.get_my_history(int) to authenticated;
grant execute on function public.get_leaderboard() to authenticated;

-- ------------------------------------------------------------
-- LOG DELLA MIGRATION
-- ------------------------------------------------------------
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '006_stats',
  'Add RPC get_my_stats/get_my_history/get_leaderboard (security definer over history schema, authenticated only)',
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
select routine_name from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('get_my_stats','get_my_history','get_leaderboard');
```

- [ ] **Step 2: Crea `migrations/006_stats/down.sql`**

```sql
-- Migration Rollback: 006_stats
-- Elimina le tre funzioni RPC delle statistiche. Nessun dato viene toccato
-- (le funzioni leggono soltanto): il client mostrerà "Errore statistiche".
-- ============================================================

-- STEP 1: FUNZIONI
drop function if exists public.get_my_stats();
drop function if exists public.get_my_history(int);
drop function if exists public.get_leaderboard();

-- STEP 2: LOG DEL ROLLBACK
insert into internal.schema_migrations_rollback (version, rolled_back_by, rolled_back_at)
values ('006_stats', 'soogiue', now());

-- STEP 3: VERIFICA
select routine_name from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('get_my_stats','get_my_history','get_leaderboard');
```

- [ ] **Step 3: Crea `migrations/006_stats/metadata.json`**

```json
{
  "version": "006_stats",
  "description": "Add RPC functions get_my_stats, get_my_history, get_leaderboard (security definer readers over the history schema, granted to authenticated only)",
  "author": "soogiue",
  "created_at": "2026-07-08",
  "applied_at": null,
  "status": "pending",
  "breaking": false,
  "schemas_added": [],
  "tables_affected": [],
  "views_added": [],
  "reason": "Statistiche personali, storico partite e classifica per la schermata 📊 del client",
  "notes": "Solo funzioni di lettura: nessuna tabella nuova, nessun nuovo logging (history.* è già scritto dalla edge function). auth.uid() dentro le funzioni: nessun parametro falsificabile. Lo schema history resta senza policy di SELECT per i client. Richiede 001 (history) e 005 (profiles). I bot (user_id sintetici, senza profilo) sono esclusi."
}
```

- [ ] **Step 4: Crea `migrations/006_stats/notes.md`**

```markdown
# 006_stats — Note

## Cosa fa

Tre funzioni RPC in `public`, tutte `security definer` + `stable` +
`set search_path = public, history`, eseguibili SOLO da `authenticated`:

- `get_my_stats()` → 1 riga: giocate, vinte, win rate, punti medi, miglior
  punteggio, piazzamento medio, precisione dichiarazioni (da
  `history.round_outcomes.guessed`). Zeri se non hai mai finito una partita.
- `get_my_history(p_limit default 20, cap 50)` → ultime partite concluse:
  data, n. giocatori, mio punteggio/piazzamento, nome del vincitore.
- `get_leaderboard()` → per ogni profilo con almeno una partita conclusa:
  giocate, vinte, win rate, punti medi. Ordine: vinte desc, win rate desc,
  nickname asc.

## Perché RPC e non RLS

Lo schema `history` è il dataset ML: RLS abilitata senza policy di SELECT,
scrive solo la edge function (service_role). La classifica richiederebbe
lettura cross-utente: aprirlo coi policy esporrebbe le mani/mosse di tutti.
Le funzioni definer espongono SOLO gli aggregati, e `auth.uid()` interno
rende impossibile chiedere i dati di un altro.

## Dipendenze e caveat

- Richiede 001 (schema history) e 005 (profiles). Applicare in ordine.
- Le statistiche partono da quando il logging è attivo: le partite precedenti
  non esistono nel dataset (nessun backfill possibile).
- I bot hanno `user_id` sintetici senza riga in `profiles`: esclusi da
  classifica (inner join) e da stats/storico (filtro `auth.uid()`).

## Rollback

`down.sql` droppa le tre funzioni. Nessun dato toccato; la schermata 📊 del
client mostrerà un errore finché non si riapplica `up.sql`.
```

- [ ] **Step 5: Aggiungi la voce in `migrations/MIGRATION_LOG.md`**

Subito sotto `## Migration applicate` (prima della voce `### ⏳ 005_profiles`):

```markdown
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
```

- [ ] **Step 6: Commit**

```bash
git add migrations/006_stats migrations/MIGRATION_LOG.md
git commit -m "feat(db): migration 006 stats (3 RPC definer su history, solo authenticated)"
```

---

### Task 2: Mirror in `db/setup.sql` + `DATABASE_STRUCTURE.md`

**Files:**
- Modify: `db/setup.sql` (nuovo blocco in FONDO al file, dopo le righe `alter publication supabase_realtime ...`)
- Modify: `migrations/DATABASE_STRUCTURE.md` (nuova sezione funzioni)

- [ ] **Step 1: Appendi a `db/setup.sql`**

In fondo al file, un blocco con divider in stile del file:

```sql
-- ------------------------------------------------------------
-- RPC statistiche (v1.3): lettori security definer sullo schema
-- history, eseguibili solo da utenti loggati. Vedi migration 006.
-- NOTA: richiede che lo schema history esista (migration 001).
-- ------------------------------------------------------------
```

seguito, IDENTICI a `migrations/006_stats/up.sql`, da:
1. le tre `create or replace function ...` (get_my_stats, get_my_history, get_leaderboard),
2. i sei statement `revoke`/`grant`.

NON copiare il blocco `insert into internal.schema_migrations` né la query di verifica (setup.sql non è una migration). Nessun'altra riga del file va toccata.

- [ ] **Step 2: Aggiungi la sezione a `migrations/DATABASE_STRUCTURE.md`**

In fondo al file:

```markdown
---

## Funzioni RPC `public` (da migration 006)

`security definer`, execute solo `authenticated`; leggono `history.*` e
`public.profiles` senza aprire lo schema `history` ai client.

| Funzione | Ritorna |
|---|---|
| `get_my_stats()` | 1 riga di aggregati personali (giocate, vinte, win rate, punti, piazzamento, precisione dichiarazioni). |
| `get_my_history(p_limit default 20)` | Ultime partite concluse del chiamante (max 50). |
| `get_leaderboard()` | Una riga per profilo con ≥1 partita conclusa; ordine vinte→win rate→nickname. |
```

- [ ] **Step 3: Verifica idempotenza a occhio**

`create or replace` + `revoke`/`grant` sono tutti ri-eseguibili. Il blocco deve stare DOPO la creazione delle tabelle (dipende solo da `profiles` per il tipo, e da `history` che però su installazioni nuove arriva dalla migration 001: la nota nel commento lo dice).

- [ ] **Step 4: Commit**

```bash
git add db/setup.sql migrations/DATABASE_STRUCTURE.md
git commit -m "feat(db): RPC statistiche anche in setup.sql + DATABASE_STRUCTURE"
```

---

### Task 3: Client — schermata 📊 Statistiche

**Files:**
- Modify: `web/index.html` — stato nuovo, funzioni stats (prima di `renderHome()`), `renderHome()` (riga ~668), export `window.UI` (riga ~340)

- [ ] **Step 1: Aggiungi lo stato** vicino a `let authMode` / `let myNickname`:

```js
let statsTab = "me";      // "me" | "history" | "board"
let statsCache = null;    // { me, history, board } caricati a ogni apertura
```

- [ ] **Step 2: Aggiungi le funzioni stats** subito PRIMA di `renderHome()` (dopo il blocco `// ---- account (v1.2) ----`):

```js
// ---- statistiche (v1.3) ----
async function openStats(){
  const [me, hist, board] = await Promise.all([
    supabase.rpc("get_my_stats"),
    supabase.rpc("get_my_history"),
    supabase.rpc("get_leaderboard"),
  ]);
  const err = me.error || hist.error || board.error;
  if(err){ showError(err.message || "Errore statistiche"); return; }
  statsCache = { me:(me.data && me.data[0]) || null, history: hist.data || [], board: board.data || [] };
  statsTab = "me";
  renderStatsScreen();
}

function statsGo(m){ statsTab = m; renderStatsScreen(); }
function closeStats(){ statsCache = null; render(); }

function fmtDate(ts){
  const d = new Date(ts);
  return String(d.getDate()).padStart(2,"0")+"/"+String(d.getMonth()+1).padStart(2,"0");
}

function renderStatsScreen(){
  game = null;
  const tab = (m,label)=>'<button class="'+(statsTab===m?'':'ghost')+'" style="width:auto;padding:8px 12px;margin:0 3px" onclick="UI.statsGo(\''+m+'\')">'+label+'</button>';
  const empty = '<p class="waitmsg">Nessuna partita ancora: finiscine una e torna qui!</p>';
  let bodyHtml = "";
  if(statsTab==="me"){
    const s = statsCache.me;
    if(!s || !s.games){ bodyHtml = empty; }
    else {
      const row = (k,v)=>'<tr><td style="opacity:.85;padding:6px 8px">'+k+'</td><td style="text-align:right;font-weight:800;padding:6px 8px">'+v+'</td></tr>';
      bodyHtml = '<table style="width:100%;border-collapse:collapse">'+
        row("Partite giocate", s.games)+
        row("Vinte", s.wins)+
        row("Win rate", esc(String(s.win_rate))+"%")+
        row("Punti medi", esc(String(s.avg_score)))+
        row("Miglior punteggio", s.best_score)+
        row("Piazzamento medio", esc(String(s.avg_rank)))+
        row("Dichiarazioni esatte", s.decl_exact+"/"+s.decl_rounds+" ("+esc(String(s.decl_accuracy))+"%)")+
        '</table>';
    }
  } else if(statsTab==="history"){
    const h = statsCache.history;
    if(!h.length){ bodyHtml = empty; }
    else {
      bodyHtml = '<table style="width:100%;border-collapse:collapse;font-size:.85rem">'+
        '<tr style="opacity:.7"><th>Data</th><th>Gioc.</th><th>Punti</th><th>Posto</th><th>Vincitore</th></tr>'+
        h.map(g=>'<tr style="text-align:center">'+
          '<td style="padding:5px">'+fmtDate(g.finished_at)+'</td>'+
          '<td>'+g.num_players+'</td>'+
          '<td>'+g.my_score+'</td>'+
          '<td>'+g.my_rank+'°</td>'+
          '<td>'+(g.my_rank===1?"🏆 ":"")+esc(g.winner_name||"?")+'</td>'+
        '</tr>').join("")+'</table>';
    }
  } else {
    const b = statsCache.board;
    if(!b.length){ bodyHtml = empty; }
    else {
      const medals = ["🥇","🥈","🥉"];
      bodyHtml = '<table style="width:100%;border-collapse:collapse;font-size:.85rem">'+
        '<tr style="opacity:.7"><th>#</th><th style="text-align:left">Nickname</th><th>G</th><th>V</th><th>%</th><th>Punti medi</th></tr>'+
        b.map((r,i)=>'<tr style="text-align:center'+(r.nickname===myNickname?';color:var(--gold);font-weight:800':'')+'">'+
          '<td style="padding:5px">'+(medals[i]||(i+1))+'</td>'+
          '<td style="text-align:left">'+esc(r.nickname)+'</td>'+
          '<td>'+r.games+'</td><td>'+r.wins+'</td>'+
          '<td>'+esc(String(r.win_rate))+'</td>'+
          '<td>'+esc(String(r.avg_score))+'</td>'+
        '</tr>').join("")+'</table>';
    }
  }
  app.innerHTML = '<h1>📊 Statistiche</h1>'+
    '<div class="panel"><div style="display:flex;justify-content:center;margin-bottom:10px">'+
    tab("me","Le mie")+tab("history","Storico")+tab("board","Classifica")+'</div>'+bodyHtml+'</div>'+
    '<button class="ghost" onclick="UI.closeStats()">← Torna</button>';
}
```

- [ ] **Step 3: Aggiorna `renderHome()`** — sostituiscila per intero con:

```js
function renderHome(){
  game=null;
  app.innerHTML =
  '<h1>🂡 Sali e Scendi</h1><p class="sub">Ciao, <b style="color:var(--gold)">'+esc(myNickname||"?")+'</b> — gioca online con gli amici</p>'+
  '<div class="panel"><button onclick="UI.doCreate()">Crea una stanza</button></div>'+
  '<div class="panel"><label>Oppure entra con un codice</label>'+
    '<input id="code" class="code" maxlength="4" placeholder="ABCD">'+
    '<button class="ghost" onclick="UI.doJoin()">Entra nella stanza</button></div>'+
  '<button class="ghost" onclick="UI.openStats()">📊 Statistiche</button>'+
  '<p class="tiny" style="text-align:center;margin-top:14px"><a href="#" style="color:inherit;opacity:.7" onclick="UI.doLogout();return false">Esci</a></p>';
}
```

(unica differenza rispetto alla versione attuale: la riga del bottone `📊 Statistiche` prima del link Esci.)

- [ ] **Step 4: Estendi `window.UI`** (riga ~340) aggiungendo `openStats, statsGo, closeStats` alla lista esistente (NON rimuovere export esistenti).

- [ ] **Step 5: Syntax check**

```bash
node -e "const fs=require('fs');const html=fs.readFileSync('web/index.html','utf8');const m=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];m.forEach((x,i)=>{const src=x[1].replace(/^\s*import .*$/gm,'');try{new Function(src);console.log('script',i,'OK')}catch(e){console.log('script',i,'FAIL',e.message);process.exit(1)}})"
```

Expected: tutti `OK`.

- [ ] **Step 6: Commit**

```bash
git add web/index.html
git commit -m "feat(web): schermata statistiche a 3 tab (le mie / storico / classifica)"
```

---

### Task 4: Docs — README

**Files:**
- Modify: `README.md` (nuova sezione dopo "## Novità (v1.2)")

- [ ] **Step 1: Aggiungi la sezione**

```markdown
## Novità (v1.3)

- **📊 Statistiche** dalla home: le tue medie (partite, vittorie, win rate,
  precisione dichiarazioni), lo **storico** delle partite concluse e la
  **classifica** di tutti i giocatori (vinte, poi win rate). I bot sono esclusi.
- I numeri partono dalle partite concluse **dopo** l'attivazione del logging
  (migration 001): niente retroattività.

> ⚠️ Per attivarla: esegui `migrations/006_stats/up.sql` (dopo la 001 e la 005)
> e ri-pubblica il frontend. La function di gioco non cambia.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: novità v1.3 (statistiche, storico, classifica)"
```

---

### Task 5: Collaudo manuale (serve Supabase attivo)

**Prerequisiti:** migration 001, 005 e 006 applicate in ordine; function `game` deployata (versione accounts); frontend pubblicato; 2+ account registrati.

- [ ] Le tre funzioni esistono (query di verifica della 006 le restituisce tutte).
- [ ] Account nuovo → 📊 → "Nessuna partita ancora" su Le mie e Storico; la Classifica non ha la sua riga.
- [ ] Partita completa con 2 account (+ bot per riempire) → 📊 aggiornato per entrambi: giocate=1; il vincitore ha vinte=1 e sta sopra in classifica; lo storico mostra data/giocatori/punti/posto/vincitore giusti.
- [ ] Precisione dichiarazioni: su una partita corta, contare a mano i round `guessed` e confrontare con "Dichiarazioni esatte X/Y".
- [ ] I bot NON compaiono in classifica.
- [ ] Da console browser SENZA login: `supabase.rpc("get_leaderboard")` → errore di permesso (revoke ad anon verificato).
- [ ] Da console browser CON login: `supabase.from("history.games").select()` e simili → nessun dato (schema history ancora chiuso).
- [ ] Cambio tab non rifà chiamate (Network tab: 3 RPC solo all'apertura di 📊).
- [ ] "← Torna" riporta alla home; il resto del gioco è intatto.

Se tutto passa: feature completa secondo i criteri dello spec.
