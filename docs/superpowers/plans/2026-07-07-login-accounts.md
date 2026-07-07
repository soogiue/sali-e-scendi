# Account e pagina di login — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire il login anonimo con account email+password e nickname unico, letto dal server (mai dal client).

**Architecture:** Nuova tabella `public.profiles` creata da un trigger su `auth.users` (migration 005 + mirror in `db/setup.sql`). La Edge Function `game` ricava il nickname da `profiles` in `create_game`/`join_game` (il client non manda più `displayName`). Il client aggiunge una vista "auth" (login/registrazione/recupero password) prima della home, tutta dentro `web/index.html` come il resto dell'app.

**Tech Stack:** Supabase (Postgres + Auth + trigger plpgsql), Edge Function Deno/TS, client vanilla JS senza build.

**Spec:** `docs/superpowers/specs/2026-07-07-login-accounts-design.md`

**Nota sui test:** il progetto non ha infrastruttura di test per Edge Function e client (solo l'engine ha test, e qui non si tocca). Come per le feature precedenti (chat, bot) la verifica è: SQL idempotente ricontrollato, typecheck della function se Deno è disponibile, e la checklist manuale finale (Task 7) con Supabase attivo.

---

### Task 1: Migration `005_profiles`

**Files:**
- Create: `migrations/005_profiles/up.sql`
- Create: `migrations/005_profiles/down.sql`
- Create: `migrations/005_profiles/metadata.json`
- Create: `migrations/005_profiles/notes.md`
- Modify: `migrations/MIGRATION_LOG.md` (nuova voce in cima a "## Migration applicate")

- [ ] **Step 1: Crea `migrations/005_profiles/up.sql`**

```sql
-- Migration: 005_profiles
-- Author: soogiue
-- Date: 2026-07-07
-- Reason: Account veri (email+password) con nickname unico; fine del login anonimo.
-- Affected: nuova tabella public.profiles + trigger su auth.users.
--           NESSUNA modifica alle tabelle esistenti.
-- Note di design:
--   * Il profilo lo crea un trigger alla registrazione (nickname passato nei
--     metadata del signUp): niente race lato client, niente utenti senza profilo.
--   * Nickname unico case-insensitive (indice su lower(nickname)), 3-20 caratteri.
--   * SELECT anche per anon: serve il pre-check di disponibilita PRIMA del login.
--     La tabella espone solo id/nickname/created_at, nessun dato sensibile.
--   * Nessuna policy di INSERT/UPDATE/DELETE: scrive solo il trigger.
-- ============================================================

-- ------------------------------------------------------------
-- public.profiles — un profilo per account
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  nickname   text not null,
  created_at timestamptz not null default now(),
  constraint nickname_len check (char_length(nickname) between 3 and 20)
);

-- Unicita case-insensitive: "Gio" e "gio" sono lo stesso nickname.
create unique index if not exists idx_profiles_nickname on public.profiles (lower(nickname));

-- ------------------------------------------------------------
-- Trigger: il profilo nasce col signup. Se l'insert fallisce
-- (nickname duplicato o fuori misura) fallisce l'INTERA
-- registrazione: nessun utente orfano.
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, trim(new.raw_user_meta_data->>'nickname'));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- RLS: nickname pubblici (anche anon, per il check in registrazione).
-- ------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to anon, authenticated using (true);

-- ------------------------------------------------------------
-- LOG DELLA MIGRATION
-- ------------------------------------------------------------
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '005_profiles',
  'Add public.profiles (unique nickname) + signup trigger on auth.users + public SELECT RLS',
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
where table_schema = 'public' and table_name = 'profiles';
```

- [ ] **Step 2: Crea `migrations/005_profiles/down.sql`**

```sql
-- Migration Rollback: 005_profiles
-- ATTENZIONE: elimina la tabella public.profiles e TUTTI i nickname.
-- Gli account auth.users restano ma senza profilo: create_game/join_game
-- risponderanno 403 finche la migration non viene riapplicata.
-- ============================================================

-- STEP 1: TRIGGER + FUNZIONE
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- STEP 2: TABELLA (policy e indice cadono con la tabella)
drop table if exists public.profiles;

-- STEP 3: LOG DEL ROLLBACK
insert into internal.schema_migrations_rollback (version, rolled_back_by, rolled_back_at)
values ('005_profiles', 'soogiue', now());

-- STEP 4: VERIFICA
select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'profiles';
```

- [ ] **Step 3: Crea `migrations/005_profiles/metadata.json`**

```json
{
  "version": "005_profiles",
  "description": "Add public.profiles (unique case-insensitive nickname) created by a trigger on auth.users signup; public SELECT RLS for pre-signup availability check",
  "author": "soogiue",
  "created_at": "2026-07-07",
  "applied_at": null,
  "status": "pending",
  "breaking": true,
  "schemas_added": [],
  "tables_affected": ["public.profiles"],
  "views_added": [],
  "reason": "Account veri (email+password) al posto del login anonimo; il nickname unico e la base per storico e statistiche per account",
  "notes": "Il profilo lo crea il trigger handle_new_user (nickname nei metadata del signUp). Nessuna policy di scrittura client. BREAKING: create_game/join_game leggono il nickname da profiles, quindi client e function vanno deployati insieme a questa migration; gli account anonimi esistenti smettono di funzionare (vanno disabilitati gli Anonymous sign-ins nel dashboard)."
}
```

- [ ] **Step 4: Crea `migrations/005_profiles/notes.md`**

```markdown
# 005_profiles — Note

## Cosa fa

- Crea `public.profiles` (id = auth.users.id, nickname unico case-insensitive
  3-20 caratteri, created_at).
- Trigger `on_auth_user_created` su `auth.users`: alla registrazione inserisce il
  profilo col nickname preso da `raw_user_meta_data->>'nickname'` (passato dal
  client in `signUp(..., options.data.nickname)`).
- RLS: SELECT per `anon` e `authenticated` (i nickname sono pubblici; il check di
  disponibilita avviene PRIMA del login). Nessuna policy di scrittura: scrive
  solo il trigger.

## Perche breaking

- La Edge Function `game` (da questa versione) ricava il nickname da `profiles`
  in `create_game`/`join_game` e ignora `displayName` dal client: senza questa
  migration risponde 403 "Profilo mancante".
- Ordine di deploy: 1) questa migration, 2) `supabase functions deploy game`,
  3) pubblicare il client aggiornato, 4) dashboard: Email provider ON senza
  conferma, Anonymous sign-ins OFF, Redirect URL dell'app (vedi SETUP.md).

## Rollback

`down.sql` elimina trigger, funzione e tabella. Gli utenti auth restano ma senza
profilo: il gioco torna utilizzabile solo ripristinando anche function+client
precedenti (o riapplicando `up.sql`).
```

- [ ] **Step 5: Aggiungi la voce in `migrations/MIGRATION_LOG.md`**

Subito sotto la riga `## Migration applicate` (prima della voce `004_autoplay`):

```markdown
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
```

- [ ] **Step 6: Commit**

```bash
git add migrations/005_profiles migrations/MIGRATION_LOG.md
git commit -m "feat(db): migration 005 profiles (nickname unico + trigger signup)"
```

---

### Task 2: Mirror in `db/setup.sql` (installazioni nuove)

**Files:**
- Modify: `db/setup.sql` (nuovo blocco dopo la tabella `chat_messages`, che inizia alla riga ~85)

- [ ] **Step 1: Aggiungi il blocco `profiles` a `db/setup.sql`**

Dopo il blocco `create table if not exists public.chat_messages (...)` e il suo indice, aggiungi:

```sql
-- ------------------------------------------------------------
-- public.profiles — un profilo per account (nickname unico).
-- Creata dal trigger alla registrazione (v1.2, niente login anonimo).
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  nickname   text not null,
  created_at timestamptz not null default now(),
  constraint nickname_len check (char_length(nickname) between 3 and 20)
);

create unique index if not exists idx_profiles_nickname on public.profiles (lower(nickname));

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, trim(new.raw_user_meta_data->>'nickname'));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to anon, authenticated using (true);
```

**Attenzione:** `profiles` NON va aggiunta a `supabase_realtime` (nessun bisogno di realtime sui nickname) — non toccare le righe `alter publication` in fondo al file.

- [ ] **Step 2: Verifica idempotenza a occhio**

Ogni statement del blocco deve poter girare due volte senza errori (`if not exists`, `create or replace`, `drop ... if exists` prima di `create`). È lo stesso stile del resto di `setup.sql`.

- [ ] **Step 3: Commit**

```bash
git add db/setup.sql
git commit -m "feat(db): profiles anche in setup.sql (installazioni nuove)"
```

---

### Task 3: Edge Function — nickname da `profiles`

**Files:**
- Modify: `supabase/functions/game/index.ts` (header commenti righe 7–8, `createGame` righe 92–94, `joinGame` righe 114–117 e 125–131, `cleanName` riga 795)

- [ ] **Step 1: Aggiorna il contratto nei commenti in testa al file**

Righe 7–8, da:

```ts
//   - create_game { displayName }            -> { gameId, code, seat }
//   - join_game   { code, displayName }       -> { gameId, code, seat }
```

a:

```ts
//   - create_game {}                          -> { gameId, code, seat }   (nickname da profiles)
//   - join_game   { code }                    -> { gameId, code, seat }   (nickname da profiles)
```

- [ ] **Step 2: Aggiungi l'helper `nicknameOf` sopra `createGame`**

```ts
// Il nome del giocatore viene SEMPRE dal profilo (identita non falsificabile).
async function nicknameOf(db: any, userId: string): Promise<string | null> {
  const { data } = await db.from("profiles").select("nickname")
    .eq("id", userId).maybeSingle();
  return data?.nickname ?? null;
}
```

- [ ] **Step 3: `createGame` legge il nickname dal profilo**

Sostituisci le righe:

```ts
  const displayName = cleanName(body.displayName);
  if (!displayName) return json({ error: "Inserisci il tuo nome" }, 400);
```

con:

```ts
  const displayName = await nicknameOf(db, userId);
  if (!displayName) return json({ error: "Profilo mancante: registrati di nuovo" }, 403);
```

(il parametro `body` di `createGame` resta: il router lo passa comunque.)

- [ ] **Step 4: `joinGame` idem**

Sostituisci le righe:

```ts
  const code = String(body.code ?? "").toUpperCase().trim();
  const displayName = cleanName(body.displayName);
  if (!displayName) return json({ error: "Inserisci il tuo nome" }, 400);
```

con:

```ts
  const code = String(body.code ?? "").toUpperCase().trim();
  const displayName = await nicknameOf(db, userId);
  if (!displayName) return json({ error: "Profilo mancante: registrati di nuovo" }, 403);
```

Il ramo "già dentro" (aggiorna `display_name` e ritorna il seat) resta identico: ora fa da refresh dello snapshot se il nickname è cambiato nel frattempo.

- [ ] **Step 5: Elimina `cleanName` se non è più usata**

```bash
grep -n "cleanName" supabase/functions/game/index.ts
```

Se le uniche occorrenze rimaste sono la definizione (riga ~795), eliminala. Se qualcos'altro la usa ancora (es. nomi dei bot), lasciala.

- [ ] **Step 6: Typecheck (se Deno è installato)**

```bash
deno check supabase/functions/game/index.ts
```

Expected: nessun errore. Se `deno` non è installato, salta (la verifica vera è il deploy + Task 7).

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/game/index.ts
git commit -m "feat(edge): create_game/join_game leggono il nickname da profiles"
```

---

### Task 4: Client — vista auth (login / registrazione / recupero)

**Files:**
- Modify: `web/index.html` — blocco `init()` (righe ~281–296), nuove funzioni auth accanto a `renderHome()` (riga ~559), export `window.UI` (riga ~341)

- [ ] **Step 1: Nuovo stato e `init()` senza `signInAnonymously`**

Aggiungi vicino alle altre `let` di stato:

```js
let authMode = "login";   // "login" | "signup" | "reset"
let myNickname = "";
```

Sostituisci il corpo di `init()` (righe ~287–295), da:

```js
  let { data:{ session } } = await supabase.auth.getSession();
  if(!session){
    const { data, error } = await supabase.auth.signInAnonymously();
    if(error){ app.innerHTML='<div class="panel">Errore login: '+esc(error.message)+'<p class="tiny">Hai abilitato "Anonymous sign-ins" in Supabase → Authentication → Providers?</p></div>'; return; }
    session = data.session;
  }
  myUserId = session.user.id;
  setInterval(tickTimer, 200); // timer del turno (lato client)
  render();
```

a:

```js
  // il link "recupero password" riapre l'app con un token: supabase-js lo
  // processa e emette PASSWORD_RECOVERY → vista "nuova password"
  supabase.auth.onAuthStateChange((event)=>{ if(event==="PASSWORD_RECOVERY") renderRecovery(); });
  setInterval(tickTimer, 200); // timer del turno (lato client)
  const { data:{ session } } = await supabase.auth.getSession();
  if(!session){ renderAuth(); return; }
  await startAuthedApp(session);
```

- [ ] **Step 2: Aggiungi le funzioni auth (subito prima di `renderHome()`)**

```js
// ---- account (v1.2) ----
async function startAuthedApp(session){
  if(!session){ renderAuth(); return; }
  myUserId = session.user.id;
  const { data: prof } = await supabase.from("profiles").select("nickname").eq("id", myUserId).maybeSingle();
  myNickname = prof ? prof.nickname : "";
  render();
}

function mapAuthError(msg){
  const m = String(msg||"");
  if(m.indexOf("Invalid login credentials")>=0) return "Email o password sbagliata";
  if(m.indexOf("User already registered")>=0) return "Email già registrata";
  if(m.indexOf("Database error saving new user")>=0) return "Nickname già in uso, provane un altro";
  if(m.toLowerCase().indexOf("password")>=0 && m.indexOf("6")>=0) return "La password deve avere almeno 6 caratteri";
  return m;
}

function renderAuth(){
  game = null;
  const tab = (m,label)=>'<button class="'+(authMode===m?'':'ghost')+'" style="width:auto;padding:8px 16px;margin:0 4px" onclick="UI.authTab(\''+m+'\')">'+label+'</button>';
  let form = "";
  if(authMode==="login"){
    form = '<label>Email</label><input id="au-email" type="email" autocomplete="email">'+
      '<label>Password</label><input id="au-pass" type="password" autocomplete="current-password">'+
      '<button onclick="UI.doLogin()">Accedi</button>'+
      '<p class="tiny" style="margin-top:10px;text-align:center"><a href="#" style="color:var(--gold)" onclick="UI.authTab(\'reset\');return false">Password dimenticata?</a></p>';
  } else if(authMode==="signup"){
    form = '<label>Nickname <span style="opacity:.7">(3–20 caratteri, unico)</span></label>'+
      '<input id="au-nick" maxlength="20" placeholder="Es. Gio77">'+
      '<label>Email</label><input id="au-email" type="email" autocomplete="email">'+
      '<label>Password <span style="opacity:.7">(min 6)</span></label>'+
      '<input id="au-pass" type="password" autocomplete="new-password">'+
      '<button onclick="UI.doSignup()">Registrati</button>';
  } else { // reset
    form = '<label>Email dell\'account</label><input id="au-email" type="email" autocomplete="email">'+
      '<button onclick="UI.doSendReset()">Invia email di recupero</button>'+
      '<p class="tiny" style="margin-top:10px;text-align:center"><a href="#" style="color:var(--gold)" onclick="UI.authTab(\'login\');return false">Torna al login</a></p>';
  }
  app.innerHTML = '<h1>🂡 Sali e Scendi</h1><p class="sub">Accedi per giocare online con gli amici</p>'+
    '<div class="panel"><div style="display:flex;justify-content:center;margin-bottom:12px">'+
    tab("login","Accedi")+tab("signup","Registrati")+'</div>'+form+'</div>';
}

function authTab(m){ authMode = m; renderAuth(); }

async function doLogin(){
  const email = (document.getElementById("au-email").value||"").trim();
  const pass  = document.getElementById("au-pass").value||"";
  if(!email || !pass){ showError("Inserisci email e password"); return; }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
  if(error){ showError(mapAuthError(error.message)); return; }
  await startAuthedApp(data.session);
}

async function doSignup(){
  const nick  = (document.getElementById("au-nick").value||"").trim();
  const email = (document.getElementById("au-email").value||"").trim();
  const pass  = document.getElementById("au-pass").value||"";
  if(nick.length<3 || nick.length>20){ showError("Il nickname deve avere 3–20 caratteri"); return; }
  if(!email){ showError("Inserisci l'email"); return; }
  if(pass.length<6){ showError("La password deve avere almeno 6 caratteri"); return; }
  // pre-check disponibilità (il vincolo unico sul DB resta la rete di sicurezza
  // contro le race; qui serve solo un errore leggibile). Escape di %/_ per ilike.
  const pat = nick.replace(/[\\%_]/g, function(ch){ return "\\"+ch; });
  const { data: taken } = await supabase.from("profiles").select("id").ilike("nickname", pat).maybeSingle();
  if(taken){ showError("Nickname già in uso, provane un altro"); return; }
  const { data, error } = await supabase.auth.signUp({ email, password: pass, options:{ data:{ nickname: nick } } });
  if(error){ showError(mapAuthError(error.message)); return; }
  await startAuthedApp(data.session);
}

async function doSendReset(){
  const email = (document.getElementById("au-email").value||"").trim();
  if(!email){ showError("Inserisci l'email"); return; }
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if(error){ showError(mapAuthError(error.message)); return; }
  showError("Email inviata: apri il link per scegliere la nuova password");
}

function renderRecovery(){
  game = null;
  app.innerHTML = '<h1>🂡 Sali e Scendi</h1><p class="sub">Scegli la nuova password</p>'+
    '<div class="panel"><label>Nuova password <span style="opacity:.7">(min 6)</span></label>'+
    '<input id="au-pass" type="password" autocomplete="new-password">'+
    '<label>Ripeti password</label><input id="au-pass2" type="password" autocomplete="new-password">'+
    '<button onclick="UI.doRecover()">Salva e gioca</button></div>';
}

async function doRecover(){
  const p1 = document.getElementById("au-pass").value||"";
  const p2 = document.getElementById("au-pass2").value||"";
  if(p1.length<6){ showError("La password deve avere almeno 6 caratteri"); return; }
  if(p1!==p2){ showError("Le password non coincidono"); return; }
  const { error } = await supabase.auth.updateUser({ password: p1 });
  if(error){ showError(mapAuthError(error.message)); return; }
  const { data:{ session } } = await supabase.auth.getSession();
  await startAuthedApp(session);
}

async function doLogout(){
  await supabase.auth.signOut();
  myUserId = null; myNickname = ""; game = null; gameId = null;
  authMode = "login";
  renderAuth();
}
```

- [ ] **Step 3: Esporta le nuove azioni in `window.UI` (riga ~341)**

```js
window.UI = { doCreate, doJoin, doStart, doDeclare, doPlay, doContinue, doSetBots, doToggleAutoplay, doClaimAll,
              authTab, doLogin, doSignup, doSendReset, doRecover, doLogout };
```

- [ ] **Step 4: Verifica sintassi**

Apri `web/index.html` nel browser (anche senza Supabase configurato): la console non deve mostrare SyntaxError. Con `config.js` configurato e nessuna sessione deve comparire la vista login.

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "feat(web): vista auth (login/registrazione/recupero password), via login anonimo"
```

---

### Task 5: Client — home col nickname, niente più campo nome

**Files:**
- Modify: `web/index.html` — `renderHome()` (righe ~559–569), `doCreate()`/`doJoin()` (righe ~310–323)

- [ ] **Step 1: `renderHome()` senza `#nm`, con saluto e "Esci"**

Sostituisci l'intera `renderHome()` con:

```js
function renderHome(){
  game=null;
  app.innerHTML =
  '<h1>🂡 Sali e Scendi</h1><p class="sub">Ciao, <b style="color:var(--gold)">'+esc(myNickname||"?")+'</b> — gioca online con gli amici</p>'+
  '<div class="panel"><button onclick="UI.doCreate()">Crea una stanza</button></div>'+
  '<div class="panel"><label>Oppure entra con un codice</label>'+
    '<input id="code" class="code" maxlength="4" placeholder="ABCD">'+
    '<button class="ghost" onclick="UI.doJoin()">Entra nella stanza</button></div>'+
  '<p class="tiny" style="text-align:center;margin-top:14px"><a href="#" style="color:inherit;opacity:.7" onclick="UI.doLogout();return false">Esci</a></p>';
}
```

- [ ] **Step 2: `doCreate()`/`doJoin()` senza nome**

Sostituisci le due funzioni (righe ~310–323) con:

```js
async function doCreate(){
  const res = await invoke("create_game", {});
  if(res){ gameId=res.gameId; myCode=res.code; mySeat=res.seat; await enterGame(); }
}
async function doJoin(){
  const code = (document.getElementById("code").value||"").trim().toUpperCase();
  if(code.length<4){ showError("Inserisci il codice stanza"); return; }
  const res = await invoke("join_game", { code });
  if(res){ gameId=res.gameId; myCode=res.code; mySeat=res.seat; await enterGame(); }
}
```

- [ ] **Step 3: Verifica che `#nm` non sia usato altrove**

```bash
grep -n '"nm"' web/index.html
```

Expected: nessuna occorrenza rimasta.

- [ ] **Step 4: Commit**

```bash
git add web/index.html
git commit -m "feat(web): home col nickname del profilo, rimosso campo nome"
```

---

### Task 6: Documentazione — `SETUP.md` e `README.md`

**Files:**
- Modify: `SETUP.md` (nuova sezione in fondo)
- Modify: `README.md` (nuova sezione "Novità (v1.2)" dopo "Novità (v1.1)")

- [ ] **Step 1: Aggiungi la sezione account a `SETUP.md`**

In fondo al file:

```markdown
## Account (v1.2) — passi nel dashboard Supabase

Dalla v1.2 il login anonimo è dismesso: si gioca con account email+password e
nickname unico. Tre passi una-tantum nel dashboard:

1. **Authentication → Providers → Email:** ON, con **"Confirm email" OFF**
   (registrazione → si gioca subito, niente attesa della mail).
2. **Authentication → Providers → Anonymous sign-ins:** **OFF**.
3. **Authentication → URL Configuration → Redirect URLs:** aggiungi l'URL dove
   pubblichi l'app (serve al link "Password dimenticata?").

Poi, in ordine: esegui `migrations/005_profiles/up.sql` nel SQL Editor (le
installazioni nuove hanno già tutto in `db/setup.sql`), ri-pubblica la function
(`supabase functions deploy game`) e ri-pubblica il frontend. I tre pezzi vanno
aggiornati insieme: la function nuova senza migration risponde
"Profilo mancante".

> Nota: il link di recupero password non funziona aprendo l'app da file locale
> (`file://`): serve l'app pubblicata a un URL registrato nei Redirect URLs.
```

- [ ] **Step 2: Aggiungi "Novità (v1.2)" a `README.md`**

Dopo la sezione "Novità (v1.1)":

```markdown
## Novità (v1.2)

- **Account veri**: login/registrazione con email e password, niente più accesso
  anonimo. **Nickname unico** scelto alla registrazione, usato in ogni partita
  (il campo "nome" è sparito). Recupero password via email e logout dalla home.
- Il nickname lo legge **il server** dal profilo (`public.profiles`): il client
  non manda più nomi.

> ⚠️ Se avevi il setup della v1.1: esegui `migrations/005_profiles/up.sql`,
> ri-pubblica la function e il frontend, e sistema i 3 toggle del dashboard
> descritti in SETUP.md (sezione "Account (v1.2)").
```

- [ ] **Step 3: Commit**

```bash
git add SETUP.md README.md
git commit -m "docs: setup account v1.2 (dashboard, migration, deploy)"
```

---

### Task 7: Collaudo manuale (serve Supabase attivo)

**Prerequisiti (a carico dell'utente, dal dashboard):** i 3 passi di SETUP.md §Account, `up.sql` della 005 eseguito, function deployata, frontend pubblicato/servito.

- [ ] Senza sessione → si vede la vista login, non la home.
- [ ] Registrazione con nickname nuovo → si entra subito, la home saluta col nickname.
- [ ] Registrazione con nickname già preso (anche "GIO" vs "gio") → "Nickname già in uso", nessun account creato (verifica in Authentication → Users).
- [ ] Registrazione con email già registrata → "Email già registrata".
- [ ] Crea stanza → al tavolo compare il nickname dell'account.
- [ ] Secondo account da un altro browser → join → entrambi i nickname corretti.
- [ ] Logout → vista login; login di nuovo → si rientra.
- [ ] Refresh da loggati → niente login, dritti alla home (sessione persistita).
- [ ] "Password dimenticata?" → email → link → vista nuova password → login con la nuova password.
- [ ] `create_game` con un utente senza profilo (caso teorico: utente creato a mano nel dashboard senza nickname nei metadata... il trigger fallirebbe: in pratica basta verificare che l'errore 403 "Profilo mancante" esista nel codice) — check di codice, non di runtime.
- [ ] `grep -n "signInAnonymously" web/index.html` → nessuna occorrenza.

Se tutto passa: la feature è completa secondo i criteri dello spec.
