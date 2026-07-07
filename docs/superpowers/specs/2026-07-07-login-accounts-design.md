# Account e pagina di login — Design

**Data:** 2026-07-07
**Autore:** soogiue
**Stato:** approvato (design), pronto per il piano di implementazione

## Obiettivo

Sostituire il login anonimo con **account veri** (email + password) e un **nickname
unico** per giocatore:

- **Schermata di login/registrazione** dentro `web/index.html` (prima "vista" dell'app:
  senza sessione → login; con sessione → home come oggi).
- **Nickname scelto alla registrazione**, unico tra tutti gli account, usato in ogni
  partita (il campo "nome" per creare/entrare in stanza sparisce).
- **Recupero password** ("Password dimenticata?") via email.
- **Logout** ("Esci") dalla home.

Questa feature è la **fondazione** per storico partite e statistiche per account
(sub-progetto B, fuori da questo spec): la tabella `profiles` è il gancio a cui B si
attaccherà.

## Decisioni prese (brainstorming)

- **Metodo:** email + password (no Google OAuth, no magic link).
- **Nessuna conferma email:** registrazione → si gioca subito (toggle "Confirm email"
  OFF nel dashboard Supabase). Gioco tra amici, zero posta in gioco.
- **Nickname unico** (case-insensitive), 3–20 caratteri, scelto alla registrazione.
- **Utenti anonimi esistenti:** nessuna migrazione — le partite sono effimere, gli
  account anonimi semplicemente non servono più (disabilitare "Anonymous sign-ins"
  nel dashboard).

## Fuori scope (YAGNI)

Google/Apple OAuth, conferma email, cambio email, cambio nickname (arriverà con la
pagina profilo/statistiche del sub-progetto B), avatar caricati, eliminazione account,
rate-limiting custom (usa quello di Supabase Auth).

## Architettura

```
web/index.html (nuova vista "auth", prima di tutto il resto)
  │  signUp({ email, password, options:{ data:{ nickname } } })
  ▼
auth.users ──trigger on insert──▶ public.profiles (nickname unico)
  │                                    ▲
  │  signInWithPassword / signOut      │ Edge Function legge il nickname
  ▼                                    │ (create_game / join_game)
sessione persistita (localStorage, già gestita da supabase-js)
```

Il principio del progetto resta invariato: **identità non falsificabile**. Anzi, si
rafforza: oggi il client manda `displayName` alla function; dopo, la function ricava il
nickname da `profiles` e il client **non manda più alcun nome**.

## 1. Modello dati — `public.profiles`

```sql
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  nickname   text not null,
  created_at timestamptz not null default now(),
  constraint nickname_len check (char_length(nickname) between 3 and 20)
);
-- Unicità case-insensitive: "Gio" e "gio" sono lo stesso nickname.
create unique index if not exists idx_profiles_nickname on public.profiles (lower(nickname));
```

**Trigger di creazione** (il profilo nasce col signup, niente race lato client):

```sql
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
```

Se l'insert fallisce (nickname duplicato o fuori misura) **fallisce l'intera
registrazione**: nessun utente orfano senza profilo. Supabase in quel caso restituisce
un errore generico ("Database error saving new user"), per questo il client fa un
**pre-check di disponibilità** (vedi §3) e il vincolo DB resta solo come rete di
sicurezza contro le race.

**RLS:**

```sql
alter table public.profiles enable row level security;

-- I nickname sono pubblici (servono anche PRIMA del login, per il check di
-- disponibilità in fase di registrazione) → select anche per anon.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to anon, authenticated using (true);
```

Nessuna policy di INSERT/UPDATE/DELETE: il profilo lo crea il trigger, e finché non
esiste il cambio nickname (sub-progetto B) nessuno deve scriverci. La tabella espone
solo `id`, `nickname`, `created_at` — niente email, niente dati sensibili.

## 2. Edge Function — `create_game` / `join_game` leggono da `profiles`

In `supabase/functions/game/index.ts`:

- `create_game` e `join_game` **ignorano** `displayName` dal payload; al suo posto:

  ```ts
  const { data: prof } = await db.from("profiles").select("nickname")
    .eq("id", user.id).single();
  if (!prof) return err(403, "Profilo mancante: registrati di nuovo");
  ```

  e usano `prof.nickname` dove oggi usano `displayName`.
- `game_players.display_name` resta com'è (snapshot del nickname al join): **zero
  modifiche** a engine, rendering, chat, history — tutto continua a leggere
  `display_name`.

## 3. Client — vista "auth" in `web/index.html`

**Flusso di avvio (`init()`), al posto di `signInAnonymously`:**

```js
let { data:{ session } } = await supabase.auth.getSession();
if (!session) { renderAuth(); return; }   // ← nuova vista
myUserId = session.user.id;
render();                                  // home come oggi
```

**Vista auth — due tab:**

- **Accedi:** email + password → `signInWithPassword`. Errori inline in italiano
  ("Email o password sbagliata", …). Link "Password dimenticata?".
- **Registrati:** nickname + email + password (min 6 caratteri, il minimo di Supabase).
  1. Validazione client: nickname `trim`, 3–20 caratteri.
  2. **Pre-check disponibilità:** `select id from profiles where lower(nickname) =
     lower(:nick)` → se esiste, "Nickname già in uso" senza nemmeno tentare il signup.
  3. `signUp({ email, password, options:{ data:{ nickname } } })` → il trigger crea il
     profilo → sessione attiva → `render()` (si gioca subito).
  4. Se il signup fallisce comunque (race sul nickname, email già registrata): messaggio
     inline mappato in italiano; per l'errore generico del trigger → "Nickname già in
     uso, provane un altro".

**Recupero password:**

- "Password dimenticata?" → chiede l'email → `resetPasswordForEmail(email,
  { redirectTo: location.origin + location.pathname })`.
- Al click sul link ricevuto, supabase-js emette `onAuthStateChange` con evento
  `PASSWORD_RECOVERY` → vista "Nuova password" (campo + conferma) →
  `updateUser({ password })` → `render()`.

**Logout:** bottone "Esci" nella home (schermata crea/entra), accanto al titolo:
`signOut()` → `renderAuth()`.

**Home semplificata:** il campo "Il tuo nome" (`#nm`) sparisce da `doCreate()`/
`doJoin()`; il nickname compare nella home come saluto ("Ciao, **Gio**"), letto una
volta da `profiles` dopo il login.

**Stile:** stessa lingua visiva dell'app (pannelli scuri translucidi, oro `--gold`,
bordi arrotondati); la vista auth è un semplice `.panel` centrato con i tab in alto.
Niente framework, niente file nuovi: tutto in `index.html` come il resto.

## 4. Configurazione Supabase (dashboard, manuale)

1. **Authentication → Providers → Email:** ON, con "Confirm email" **OFF**.
2. **Authentication → Providers → Anonymous sign-ins:** **OFF**.
3. **Authentication → URL Configuration:** aggiungere l'URL dell'app ai *Redirect URLs*
   (serve al link di recupero password).

Questi passi vanno annotati in `SETUP.md` (nuova sezione "Account (v1.2)").

## 5. Migration & deploy

- Nuova cartella `migrations/005_profiles/` (`up.sql`, `down.sql`, `notes.md`,
  `metadata.json`, riga in `migrations/MIGRATION_LOG.md`), nello stile delle precedenti.
  - `up.sql`: tabella + indice unico + RLS + policy + funzione trigger + trigger + riga
    in `internal.schema_migrations`.
  - `down.sql`: drop trigger, funzione, tabella + log del rollback.
- Stessi oggetti aggiunti a `db/setup.sql` (installazioni nuove complete senza migration).
- Deploy della function: `supabase functions deploy game`.
- Aggiornare `README.md` (novità v1.2) e `SETUP.md` (passi dashboard di §4).

## 6. Test manuale

- [ ] Senza sessione → si vede la vista login, non la home.
- [ ] Registrazione con nickname nuovo → si entra subito, la home saluta col nickname.
- [ ] Registrazione con nickname già preso (anche con case diverso: "GIO" vs "gio") →
      "Nickname già in uso", nessun account creato.
- [ ] Registrazione con email già registrata → errore chiaro in italiano.
- [ ] Crea stanza: il nome al tavolo è il nickname dell'account (nessun campo nome).
- [ ] Secondo account da un altro browser → join → entrambi i nickname corretti al tavolo.
- [ ] Logout → torna alla vista login; login di nuovo → sessione ok, si rientra.
- [ ] Refresh della pagina da loggati → **niente** login, dritti alla home (sessione
      persistita).
- [ ] "Password dimenticata?" → email ricevuta → link → vista nuova password → login
      con la nuova password funziona.
- [ ] Un utente senza profilo (caso teorico) che invoca `create_game` riceve 403.
- [ ] Login anonimo: disabilitato, `signInAnonymously` non esiste più nel codice.

## Criteri di completamento

La feature è completa quando: la migration 005 gira senza errori; la registrazione crea
account + profilo con nickname unico; login, logout, recupero password e persistenza
della sessione funzionano; creare/entrare in stanza usa il nickname dal profilo (il
client non manda più nomi); tutti i punti del test manuale passano.
