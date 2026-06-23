# Chat di stanza — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere una chat testuale persistente tra i membri di una stanza: sempre aperta in lobby, dietro un tastino con badge non-letti durante la partita.

**Architecture:** Server-autoritativa come il resto del progetto. Il client invia un messaggio chiamando una nuova azione `send_message` della Edge Function `game` (service_role), che valida e scrive in `public.chat_messages`. I client leggono via realtime (RLS: solo i membri). Il rendering della chat è disaccoppiato dal rendering del tavolo, così un nuovo messaggio non ridisegna il gioco.

**Tech Stack:** PostgreSQL/Supabase (tabella + RLS + Realtime), Deno Edge Function (TypeScript), frontend statico vanilla JS (`web/index.html`, supabase-js v2).

> **Nota sul testing:** questo progetto non ha un harness di test automatici (nessun
> `package.json`, nessun runner; il motore è "verificato" a mano e il giro online si
> collauda con Supabase attivo — vedi `README.md`). Di conseguenza la verifica di ogni
> task è **manuale e concreta** (comandi SQL, due browser, ispezione DOM). Ogni task
> resta bite-sized e termina con un commit.

**Spec di riferimento:** `docs/superpowers/specs/2026-06-23-chat-lobby-design.md`

---

## File Structure

| File | Responsabilità | Azione |
|------|----------------|--------|
| `migrations/002_chat_messages/up.sql` | Crea `public.chat_messages` + indice + RLS + policy SELECT + realtime + log migration | Create |
| `migrations/002_chat_messages/down.sql` | Rollback: drop tabella + log | Create |
| `migrations/002_chat_messages/notes.md` | Note umane sulla migration | Create |
| `migrations/002_chat_messages/metadata.json` | Metadati macchina | Create |
| `migrations/MIGRATION_LOG.md` | Registro leggibile | Modify |
| `db/setup.sql` | Schema base per installazioni nuove: aggiungere la tabella | Modify |
| `supabase/functions/game/index.ts` | Nuova azione `send_message` + registrazione nel router | Modify |
| `web/index.html` | Stato chat, realtime, componente UI `renderChat`, CSS | Modify |

---

## Task 1: Migration `002_chat_messages` (DB)

**Files:**
- Create: `migrations/002_chat_messages/up.sql`
- Create: `migrations/002_chat_messages/down.sql`
- Create: `migrations/002_chat_messages/notes.md`
- Create: `migrations/002_chat_messages/metadata.json`
- Modify: `migrations/MIGRATION_LOG.md`

- [ ] **Step 1: Scrivi `up.sql`**

Create `migrations/002_chat_messages/up.sql`:

```sql
-- Migration: 002_chat_messages
-- Author: soogiue
-- Date: 2026-06-23
-- Reason: Chat testuale tra i membri di una stanza (lobby + partita).
-- Affected: nuova tabella public.chat_messages (+ RLS, policy SELECT, realtime).
--           NESSUNA modifica alle tabelle esistenti.
-- Note di design:
--   * Scritta SOLO dalla Edge Function (service_role, bypassa la RLS). I client
--     non scrivono direttamente: niente policy di INSERT.
--   * RLS con policy di SELECT per i soli membri della partita (is_game_member).
--   * on delete cascade verso public.games: la chat vive con la stanza.
--   * display_name/seat denormalizzati = snapshot al momento dell'invio.
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- public.chat_messages — un messaggio di chat per riga
-- ------------------------------------------------------------
create table if not exists public.chat_messages (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games(id) on delete cascade,
  user_id      uuid not null,
  seat         int,                          -- posto del mittente all'invio
  display_name text not null,                -- snapshot del nome all'invio
  body         text not null,                -- testo (gia validato lato server)
  created_at   timestamptz not null default now()
);

create index if not exists idx_chat_game on public.chat_messages(game_id, created_at);

-- ------------------------------------------------------------
-- RLS: i membri leggono; nessuna scrittura lato client.
-- ------------------------------------------------------------
alter table public.chat_messages enable row level security;

drop policy if exists chat_select on public.chat_messages;
create policy chat_select on public.chat_messages
  for select to authenticated
  using ( public.is_game_member(game_id) );

-- ------------------------------------------------------------
-- Realtime: i client ricevono i nuovi messaggi in tempo reale.
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.chat_messages;

-- ------------------------------------------------------------
-- LOG DELLA MIGRATION
-- ------------------------------------------------------------
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '002_chat_messages',
  'Add public.chat_messages (room chat) + RLS select for members + realtime',
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
select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'chat_messages';
```

- [ ] **Step 2: Scrivi `down.sql`**

Create `migrations/002_chat_messages/down.sql`:

```sql
-- Migration Rollback: 002_chat_messages
-- ATTENZIONE: elimina la tabella public.chat_messages e TUTTI i messaggi.
-- ============================================================

-- STEP 1: togli dalla pubblicazione realtime (ignora l'errore se non presente)
alter publication supabase_realtime drop table public.chat_messages;

-- STEP 2: TABELLA (la policy cade con la tabella)
drop table if exists public.chat_messages;

-- STEP 3: LOG DEL ROLLBACK
insert into internal.schema_migrations_rollback (version, rolled_back_by, rolled_back_at)
values ('002_chat_messages', 'soogiue', now());

-- STEP 4: VERIFICA
select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'chat_messages';
```

- [ ] **Step 3: Scrivi `notes.md`**

Create `migrations/002_chat_messages/notes.md`:

```markdown
# 002_chat_messages — Notes

## Cosa aggiunge

La tabella **`public.chat_messages`**: una riga per messaggio di chat scambiato tra i
membri di una stanza. Usata sia in lobby (chat sempre aperta) sia durante la partita
(tastino con badge non-letti).

## Scelte di design

- **Scrittura solo lato server.** I messaggi passano dalla Edge Function `game`
  (`service_role`, bypassa la RLS) tramite l'azione `send_message`. Nessuna policy di
  INSERT per i client.
- **Lettura per i soli membri.** RLS abilitata con policy di SELECT
  `is_game_member(game_id)` (la stessa funzione usata da `games`/`game_players`).
- **`on delete cascade` verso `public.games`.** La chat vive con la stanza e sparisce
  quando la stanza viene cancellata (a differenza dello schema `history`, che invece
  deve sopravvivere).
- **`display_name`/`seat` denormalizzati.** Snapshot al momento dell'invio: il render
  non fa join e il messaggio resta leggibile anche se il giocatore cambia nome/esce.
- **Niente logging in `history`.** La chat è fuori dal dataset ML.

## Come applicarla

1. SQL Editor di Supabase → incolla ed esegui `up.sql`.
2. Verifica che la query finale elenchi `chat_messages`.
3. Ri-pubblica la Edge Function: `supabase functions deploy game`.
4. Aggiorna `applied_at`/`status` in `metadata.json` e la riga in `MIGRATION_LOG.md`.

## Checklist test manuale

- [ ] `up.sql` gira senza errori.
- [ ] Esiste `public.chat_messages` con indice `idx_chat_game`.
- [ ] RLS attiva + policy `chat_select`.
- [ ] La tabella è nella pubblicazione `supabase_realtime`.
- [ ] `down.sql` rimuove la tabella e logga il rollback.
```

- [ ] **Step 4: Scrivi `metadata.json`**

Create `migrations/002_chat_messages/metadata.json`:

```json
{
  "version": "002_chat_messages",
  "description": "Add public.chat_messages (room chat) with member-only SELECT RLS and realtime; written only by the game Edge Function",
  "author": "soogiue",
  "created_at": "2026-06-23",
  "applied_at": null,
  "status": "pending",
  "breaking": false,
  "schemas_added": [],
  "tables_affected": ["public.chat_messages"],
  "views_added": [],
  "reason": "Chat testuale tra i membri di una stanza (lobby sempre aperta + tastino in partita)",
  "notes": "Scritta solo dalla Edge Function (service_role) via azione send_message. RLS con policy di SELECT per i membri (is_game_member). on delete cascade verso public.games. display_name/seat denormalizzati. Fuori dal dataset history/ML."
}
```

- [ ] **Step 5: Aggiungi la riga in `MIGRATION_LOG.md`**

In `migrations/MIGRATION_LOG.md`, subito sotto la riga `## Migration applicate` e **sopra** il blocco `### ⏳ 001_v1_game_history`, inserisci:

```markdown
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
```

- [ ] **Step 6: Verifica (manuale, opzionale ma consigliata)**

Se hai accesso al SQL Editor di Supabase, incolla `up.sql` ed esegui. Atteso: nessun
errore e l'ultima query restituisce una riga `chat_messages`. Se non hai Supabase a
portata ora, salta: la verifica end-to-end è nel Task 6.

- [ ] **Step 7: Commit**

```bash
git add migrations/002_chat_messages migrations/MIGRATION_LOG.md
git commit -m "feat(db): migration 002 chat_messages (RLS membri + realtime)"
```

---

## Task 2: Schema base per installazioni nuove (`db/setup.sql`)

**Files:**
- Modify: `db/setup.sql`

- [ ] **Step 1: Aggiungi la tabella e l'indice**

In `db/setup.sql`, subito **dopo** il blocco della tabella `public.round_results`
(termina con la sua `);`) e **prima** della riga `create index if not exists idx_game_players_game ...`, inserisci:

```sql
-- Messaggi di chat di una stanza (PUBBLICI ai membri; scritti solo dalla Edge Function)
create table if not exists public.chat_messages (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games(id) on delete cascade,
  user_id      uuid not null,
  seat         int,
  display_name text not null,
  body         text not null,
  created_at   timestamptz not null default now()
);
```

- [ ] **Step 2: Aggiungi l'indice**

Nella sezione degli indici di `db/setup.sql` (dove ci sono gli altri `create index ...`), aggiungi in fondo al gruppo:

```sql
create index if not exists idx_chat_messages_game on public.chat_messages(game_id, created_at);
```

- [ ] **Step 3: Abilita RLS sulla nuova tabella**

In `db/setup.sql`, nel blocco `-- ---------- RLS: abilita su tutte le tabelle ----------`, aggiungi in fondo alla lista degli `alter table ... enable row level security;`:

```sql
alter table public.chat_messages enable row level security;
```

- [ ] **Step 4: Aggiungi la policy di SELECT**

In `db/setup.sql`, subito **dopo** il blocco della policy `round_results_select`, inserisci:

```sql
-- chat_messages: leggibili dai membri della partita
drop policy if exists chat_select on public.chat_messages;
create policy chat_select on public.chat_messages
  for select to authenticated
  using ( public.is_game_member(game_id) );
```

- [ ] **Step 5: Aggiungi la tabella a Realtime**

In `db/setup.sql`, nel blocco `-- ---------- REALTIME ----------`, aggiungi in fondo agli `alter publication supabase_realtime add table ...`:

```sql
alter publication supabase_realtime add table public.chat_messages;
```

- [ ] **Step 6: Commit**

```bash
git add db/setup.sql
git commit -m "feat(db): chat_messages anche in setup.sql (installazioni nuove)"
```

---

## Task 3: Azione `send_message` nella Edge Function

**Files:**
- Modify: `supabase/functions/game/index.ts`

- [ ] **Step 1: Registra l'azione nel router**

In `supabase/functions/game/index.ts`, nel blocco `switch (action)` (dentro `Deno.serve`), aggiungi un case subito **dopo** `case "timeout": ...`:

```ts
      case "send_message":  return await sendMessage(db, user.id, body);
```

- [ ] **Step 2: Aggiorna il commento dell'header con la nuova azione**

In cima al file, nel commento che elenca le azioni, aggiungi dopo la riga di `timeout`:

```ts
//   - send_message{ gameId, body }            (membro: invia un messaggio di chat)
```

- [ ] **Step 3: Implementa `sendMessage`**

In `supabase/functions/game/index.ts`, subito **dopo** la funzione `timeoutAction` (prima del blocco `// ---------------- HELPERS DI MUTAZIONE ----------------`), aggiungi:

```ts
// Invia un messaggio di chat nella stanza. Solo i membri possono scrivere.
// Validazioni: non vuoto, max 300 caratteri, anti-spam (>=1s dall'ultimo proprio msg).
async function sendMessage(db: any, userId: string, body: any) {
  const { game, me } = await loadGameAndPlayer(db, body.gameId, userId);
  if (!game) return json({ error: "Partita non trovata" }, 404);
  if (!me) return json({ error: "Non sei in questa partita" }, 403);

  let text = String(body.body ?? "").trim();
  if (!text) return json({ error: "Messaggio vuoto" }, 400);
  if (text.length > 300) text = text.slice(0, 300);

  // anti-spam: rifiuta se l'ultimo messaggio di questo utente e' < 1000ms fa
  const { data: last } = await db.from("chat_messages")
    .select("created_at").eq("game_id", game.id).eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - new Date(last.created_at).getTime() < 1000)
    return json({ error: "Aspetta un attimo prima di riscrivere" }, 400);

  const { error } = await db.from("chat_messages").insert({
    game_id: game.id,
    user_id: userId,
    seat: me.seat,
    display_name: me.display_name,
    body: text,
  });
  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
}
```

- [ ] **Step 4: Verifica statica (type-check Deno)**

Se hai la CLI Deno disponibile:

Run: `deno check supabase/functions/game/index.ts`
Expected: nessun errore di tipo. (Se Deno non è installato, salta: la verifica reale è nel deploy + Task 6.)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/game/index.ts
git commit -m "feat(edge): azione send_message (valida membro/non-vuoto/300/anti-spam)"
```

---

## Task 4: Stato + realtime + caricamento chat (client)

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Aggiungi le variabili di stato della chat**

In `web/index.html`, nel blocco `// ---- stato locale ----`, subito **dopo** la riga
`let lastTO={ key:"", at:0 };`, aggiungi:

```js
let chatMessages = [];     // messaggi della stanza, ordinati per created_at
let chatOpen = false;      // sheet aperta in partita?
let chatUnread = 0;        // contatore non letti (badge in partita)
```

- [ ] **Step 2: Sottoscrivi i messaggi e caricali in `enterGame`**

In `web/index.html`, dentro `enterGame()`, **dopo** il ciclo `for(const table of [...])`
che registra i `postgres_changes` e **prima** di `channel.subscribe();`, aggiungi
l'handler dedicato della chat (NON usa `refreshAll`):

```js
  channel.on("postgres_changes",
    { event:"INSERT", schema:"public", table:"chat_messages", filter:"game_id=eq."+gameId },
    (payload)=> onChatInsert(payload.new));
```

Poi, sempre in `enterGame()`, **dopo** `await refreshAll();`, aggiungi il caricamento
iniziale:

```js
  const c = await supabase.from("chat_messages").select("*")
    .eq("game_id", gameId).order("created_at", { ascending:true }).limit(100);
  chatMessages = c.data || [];
  chatUnread = 0;
  renderChat();
```

- [ ] **Step 3: Implementa `onChatInsert`**

In `web/index.html`, subito **dopo** la funzione `refreshAll()`, aggiungi:

```js
// Nuovo messaggio di chat dal realtime: append (con dedup) e ridisegna SOLO la chat.
function onChatInsert(row){
  if(chatMessages.some(m=>m.id===row.id)) return;
  chatMessages.push(row);
  const visible = game && (game.status==="lobby" || chatOpen);
  if(!visible && row.user_id!==myUserId) chatUnread++;
  renderChat();
}
```

- [ ] **Step 4: Verifica manuale parziale**

Apri `web/index.html` (servito, con `config.js` valido) in un browser, crea una stanza.
In console del browser, dopo l'ingresso, digita `chatMessages` → atteso: `[]` (array,
nessun errore). Conferma che non ci siano errori JS a runtime. (Il render della chat
arriva nel Task 5; ora `renderChat` non esiste ancora: ci aspettiamo un errore
"renderChat is not defined" alla chiamata in `enterGame` — è atteso e verrà risolto nel
Task 5. Se preferisci evitare l'errore intermedio, esegui Task 4 e Task 5 di seguito
prima di testare.)

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "feat(web): stato chat + realtime handler + caricamento iniziale"
```

---

## Task 5: Componente UI chat (client)

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Aggiungi il nodo radice `#chat` nel body**

In `web/index.html`, subito **dopo** `<div id="err" class="err"></div>`, aggiungi:

```html
<div id="chat"></div>
```

- [ ] **Step 2: Refactor di `render()` per disegnare sempre la chat**

In `web/index.html`, **rinomina** l'attuale funzione `render()` in `renderBody()`
(cambia solo la riga `function render(){` in `function renderBody(){`; lascia il corpo
identico). Poi, subito **sopra** `renderBody`, aggiungi il nuovo `render()`:

```js
// router principale: disegna il corpo della pagina e (sempre) la chat
function render(){
  renderBody();
  renderChat();
}
```

- [ ] **Step 3: Fai partire il primo render dalla chat anche all'avvio**

In `web/index.html`, dentro `init()`, **sostituisci** la riga finale `renderHome();`
con:

```js
  render();
```

(Con `game` ancora `null`, `render()` chiama `renderBody()` → `renderHome()` e poi
`renderChat()`, che nasconde la chat finché non si entra in una stanza.)

- [ ] **Step 4: Implementa `chatLineHTML`, `renderChat`, `wireChat`, `scrollChatToBottom`, `doSendMessage`**

In `web/index.html`, subito **dopo** la funzione `renderFinished()`, aggiungi:

```js
// ---- CHAT (componente indipendente dal render del gioco) ----
function chatLineHTML(m){
  const mine = m.user_id===myUserId;
  return '<div class="chat-line'+(mine?" mine":"")+'">'+
    '<span class="chat-nm">'+esc(m.display_name)+'</span>'+
    '<span class="chat-bd">'+esc(m.body)+'</span></div>';
}

function chatLogHTML(){
  if(!chatMessages.length) return '<div class="chat-empty">Nessun messaggio. Scrivi tu il primo!</div>';
  return chatMessages.map(chatLineHTML).join("");
}

// Disegna la chat nel nodo #chat. Preserva il testo in scrittura e il focus.
function renderChat(){
  const root = document.getElementById("chat");
  if(!root) return;
  if(!game){ root.className=""; root.innerHTML=""; return; }

  // preserva bozza + focus prima di ricostruire il DOM
  const prev = document.getElementById("chat-text");
  const draft = prev ? prev.value : "";
  const hadFocus = prev && document.activeElement===prev;

  const inLobby = game.status==="lobby";
  if(inLobby){
    root.className = "chat-dock";
    root.innerHTML =
      '<div class="chat-head">💬 Chat</div>'+
      '<div class="chat-log" id="chat-log">'+chatLogHTML()+'</div>'+
      '<div class="chat-input">'+
        '<input id="chat-text" maxlength="300" placeholder="Scrivi un messaggio…" autocomplete="off">'+
        '<button id="chat-send">Invia</button>'+
      '</div>';
  } else {
    const badge = chatUnread>0 ? '<span class="chat-badge">'+(chatUnread>99?"99+":chatUnread)+'</span>' : '';
    const sheet = chatOpen
      ? '<div class="chat-sheet">'+
          '<div class="chat-head">💬 Chat <button id="chat-close" class="chat-x" aria-label="Chiudi">✕</button></div>'+
          '<div class="chat-log" id="chat-log">'+chatLogHTML()+'</div>'+
          '<div class="chat-input">'+
            '<input id="chat-text" maxlength="300" placeholder="Scrivi un messaggio…" autocomplete="off">'+
            '<button id="chat-send">Invia</button>'+
          '</div>'+
        '</div>'
      : '';
    root.className = "chat-float";
    root.innerHTML = '<button class="chat-fab" id="chat-fab" aria-label="Chat">💬'+badge+'</button>'+sheet;
  }

  // ripristina bozza + focus
  const ta = document.getElementById("chat-text");
  if(ta){ ta.value = draft; if(hadFocus){ ta.focus(); ta.setSelectionRange(draft.length, draft.length); } }
  wireChat();
  scrollChatToBottom();
}

function wireChat(){
  const send = document.getElementById("chat-send");
  if(send) send.onclick = doSendMessage;
  const text = document.getElementById("chat-text");
  if(text) text.onkeydown = (e)=>{ if(e.key==="Enter"){ e.preventDefault(); doSendMessage(); } };
  const fab = document.getElementById("chat-fab");
  if(fab) fab.onclick = ()=>{ chatOpen=true; chatUnread=0; renderChat(); };
  const close = document.getElementById("chat-close");
  if(close) close.onclick = ()=>{ chatOpen=false; renderChat(); };
}

function scrollChatToBottom(){
  const log = document.getElementById("chat-log");
  if(log) log.scrollTop = log.scrollHeight;
}

async function doSendMessage(){
  const el = document.getElementById("chat-text");
  if(!el) return;
  const body = el.value.trim().slice(0,300);
  if(!body) return;
  el.value = "";                 // svuota subito; il messaggio arriva via realtime
  await invoke("send_message", { gameId, body });
}
```

- [ ] **Step 5: Esponi gli handler usati inline (facoltativo ma coerente)**

Gli handler chat sono agganciati via `onclick`/`onkeydown` in `wireChat` (non via
attributi inline), quindi **non** serve aggiungerli a `window.UI`. Verifica solo che
`window.UI` resti invariato. Nessuna modifica in questo step se il Task 4/5 sono stati
seguiti: serve solo come checkpoint.

- [ ] **Step 6: Verifica manuale (lobby)**

Servi `web/` e apri due browser (o due schede in incognito separato) con `config.js`
valido. In uno crea la stanza, nell'altro entra col codice. In entrambi:
- Atteso: sotto il pannello del codice compare il pannello chat sempre aperto.
- Scrivi un messaggio in uno → compare in tempo reale in entrambi.
- Atteso: niente errori JS in console.

- [ ] **Step 7: Commit**

```bash
git add web/index.html
git commit -m "feat(web): componente chat (dock in lobby, fab+sheet in partita)"
```

---

## Task 6: Stile della chat (CSS) + verifica end-to-end

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Aggiungi il CSS della chat**

In `web/index.html`, subito **prima** del tag `</style>` (quello che chiude il blocco
di stili nel `<head>`), aggiungi:

```css
  /* ===================== CHAT ===================== */
  #chat:empty{ display:none; }

  /* lobby: pannello ancorato in basso, sempre aperto */
  .chat-dock{ position:fixed; left:50%; transform:translateX(-50%); bottom:0;
    width:100%; max-width:540px; z-index:40;
    background:linear-gradient(180deg, rgba(0,0,0,.42), rgba(0,0,0,.6));
    border-top:1px solid rgba(255,255,255,.14); border-radius:16px 16px 0 0;
    box-shadow:0 -10px 30px rgba(0,0,0,.4); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
    display:flex; flex-direction:column; }
  /* lascia spazio in fondo alla pagina così il dock non copre i contenuti */
  body.has-dock #app{ padding-bottom:230px; }

  .chat-head{ font-weight:800; font-size:.9rem; padding:9px 12px;
    border-bottom:1px solid rgba(255,255,255,.10); display:flex; align-items:center; justify-content:space-between; }
  .chat-x{ width:auto; margin:0; padding:2px 9px; font-size:.9rem; border-radius:9px;
    background:rgba(255,255,255,.14); color:#fff; box-shadow:none; border:1px solid rgba(255,255,255,.25); }
  .chat-log{ flex:1; overflow-y:auto; padding:8px 12px; display:flex; flex-direction:column; gap:5px;
    max-height:34vh; }
  .chat-dock .chat-log{ max-height:150px; }
  .chat-empty{ opacity:.6; font-size:.8rem; text-align:center; padding:14px 0; }
  .chat-line{ font-size:.86rem; line-height:1.3; max-width:88%; align-self:flex-start;
    background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.08);
    border-radius:12px; padding:5px 9px; word-break:break-word; }
  .chat-line.mine{ align-self:flex-end; background:linear-gradient(180deg, rgba(243,198,75,.22), rgba(243,198,75,.12));
    border-color:rgba(243,198,75,.3); }
  .chat-nm{ display:block; font-size:.68rem; font-weight:800; color:var(--gold); opacity:.95; margin-bottom:1px; }
  .chat-line.mine .chat-nm{ color:#ffe39a; }
  .chat-bd{ display:block; }

  .chat-input{ display:flex; gap:7px; padding:9px 12px; border-top:1px solid rgba(255,255,255,.10);
    padding-bottom:calc(9px + env(safe-area-inset-bottom)); }
  .chat-input input{ flex:1; padding:10px; }
  .chat-input button{ width:auto; margin:0; padding:10px 16px; }

  /* partita: tastino flottante + sheet slide-up */
  .chat-float{ position:fixed; right:14px; bottom:14px; z-index:40; }
  .chat-fab{ width:54px; height:54px; padding:0; margin:0; border-radius:50%;
    font-size:1.5rem; box-shadow:0 6px 16px rgba(0,0,0,.45); position:relative; }
  .chat-badge{ position:absolute; top:-4px; right:-4px; min-width:20px; height:20px; padding:0 5px;
    border-radius:999px; background:#b0353a; color:#fff; font-size:.72rem; font-weight:800;
    display:flex; align-items:center; justify-content:center; border:1.5px solid rgba(255,255,255,.8); }
  .chat-sheet{ position:fixed; left:50%; transform:translateX(-50%); bottom:0;
    width:100%; max-width:540px; z-index:41;
    background:linear-gradient(180deg, rgba(0,0,0,.5), rgba(0,0,0,.72));
    border-top:1px solid rgba(255,255,255,.16); border-radius:16px 16px 0 0;
    box-shadow:0 -12px 34px rgba(0,0,0,.5); backdrop-filter:blur(7px); -webkit-backdrop-filter:blur(7px);
    display:flex; flex-direction:column; animation:chatUp .22s ease both; }
  @keyframes chatUp{ from{ transform:translate(-50%,100%);} to{ transform:translate(-50%,0);} }
  @media(prefers-reduced-motion:reduce){ .chat-sheet{ animation:none; } }
```

- [ ] **Step 2: Aggiungi/togli la classe `has-dock` sul body**

Il dock in lobby è `position:fixed` e coprirebbe il fondo pagina: aggiungiamo padding al
body solo in lobby. In `renderChat()`, **dentro** il ramo `if(inLobby){ ... }` aggiungi
in fondo al ramo (dopo aver impostato `root.innerHTML`):

```js
    document.body.classList.add("has-dock");
```

e nel ramo `else { ... }` (partita) aggiungi in fondo:

```js
    document.body.classList.remove("has-dock");
```

e nel caso iniziale `if(!game){ ... }` di `renderChat`, prima del `return`, aggiungi:

```js
    document.body.classList.remove("has-dock");
```

- [ ] **Step 3: Verifica end-to-end completa (checklist dello spec)**

Servi `web/` (es. `python -m http.server` nella cartella `web`, oppure il tuo hosting)
con `config.js` valido e la migration `002` **applicata** su Supabase + function
ri-deployata (`supabase functions deploy game`). Apri due browser. Verifica:

- [ ] Due browser stessa stanza: invio da uno → l'altro lo vede in tempo reale.
- [ ] Refresh della pagina (rientrando nella stessa stanza/partita) → lo storico c'è.
- [ ] In lobby la chat è sempre aperta in basso e non copre i contenuti (c'è il padding).
- [ ] In partita: tastino 💬 in basso a destra; messaggi mentre è chiusa → badge col
      numero; all'apertura il badge si azzera e si vede lo storico.
- [ ] Un nuovo messaggio durante la partita NON fa lampeggiare il tavolo né ri-anima le
      carte (il tavolo resta fermo).
- [ ] Scrivere mentre arriva un messaggio altrui non cancella il testo che stai digitando.
- [ ] Cap 300: incollare un testo lunghissimo → arriva troncato a 300.
- [ ] Anti-spam: due invii rapidissimi (<1s) → il secondo dà "Aspetta un attimo…".
- [ ] `<script>alert(1)</script>` come messaggio → mostrato come testo, non eseguito.

- [ ] **Step 4: Commit**

```bash
git add web/index.html
git commit -m "feat(web): stile chat (dock lobby + fab/sheet partita) + safe-area"
```

---

## Task 7: Applica la migration e finalizza i metadati

**Files:**
- Modify: `migrations/002_chat_messages/metadata.json`
- Modify: `migrations/MIGRATION_LOG.md`

> Esegui questo task **dopo** aver applicato `up.sql` su Supabase e ri-deployato la
> function, e dopo che il Task 6 è verde.

- [ ] **Step 1: Applica `up.sql` su Supabase**

SQL Editor di Supabase → incolla ed esegui `migrations/002_chat_messages/up.sql`.
Atteso: nessun errore; l'ultima query restituisce `chat_messages`.

- [ ] **Step 2: Ri-deploy della Edge Function**

Run: `supabase functions deploy game`
Expected: deploy completato senza errori.

- [ ] **Step 3: Aggiorna `metadata.json`**

In `migrations/002_chat_messages/metadata.json` cambia:

```json
  "applied_at": "2026-06-23",
  "status": "applied",
```

(usa la data effettiva di applicazione)

- [ ] **Step 4: Aggiorna `MIGRATION_LOG.md`**

In `migrations/MIGRATION_LOG.md`, nella voce `002_chat_messages`, cambia l'intestazione
e lo stato da PENDING ad applicata:

```markdown
### ✅ 002_chat_messages
- **Stato:** APPLICATA il 2026-06-23
```

(il resto della voce resta invariato)

- [ ] **Step 5: Commit**

```bash
git add migrations/002_chat_messages/metadata.json migrations/MIGRATION_LOG.md
git commit -m "chore(db): segna 002_chat_messages come applicata"
```

---

## Self-Review (eseguita)

**Spec coverage:**
- Tabella `chat_messages` + RLS + realtime → Task 1 (migration) + Task 2 (setup.sql). ✓
- Azione `send_message` con validazioni (membro, non vuoto, 300, anti-spam 1s) → Task 3. ✓
- Identità dal server (`seat`/`display_name` da `game_players`) → Task 3 (usa `me`). ✓
- Realtime handler dedicato, NON `refreshAll` → Task 4. ✓
- Caricamento ultimi ~100 → Task 4. ✓
- Componente fuori `#app`, sopravvive ai re-render, preserva bozza/focus → Task 5. ✓
- Lobby dock sempre aperto · partita fab+badge+sheet, badge azzera all'apertura → Task 5/6. ✓
- Anti-XSS `esc()` → Task 5 (`chatLineHTML`). ✓
- Stile coerente col tema (oro, pannelli scuri, blur) + reduced-motion + safe-area → Task 6. ✓
- Migration files in stile 001 + MIGRATION_LOG + setup.sql + deploy → Task 1/2/7. ✓
- Tutti i punti del test manuale dello spec → Task 6 Step 3. ✓

**Placeholder scan:** nessun TBD/TODO; ogni step ha codice o comando concreto. ✓

**Type/nomi consistenti:** `renderChat`, `wireChat`, `chatLogHTML`, `chatLineHTML`,
`scrollChatToBottom`, `doSendMessage`, `onChatInsert`, variabili `chatMessages`/
`chatOpen`/`chatUnread`, azione `send_message`, classe body `has-dock` — usati con lo
stesso nome ovunque. ✓
