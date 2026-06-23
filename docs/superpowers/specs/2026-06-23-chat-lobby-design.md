# Chat di stanza — Design

**Data:** 2026-06-23
**Autore:** soogiue
**Stato:** approvato (design), pronto per il piano di implementazione

## Obiettivo

Aggiungere una chat testuale tra i giocatori di una stanza:

- **Lobby (attesa):** chat sempre aperta, ancorata in basso, mentre si aspetta che
  l'host inizi la partita.
- **Durante la partita:** un tastino discreto (in basso a destra) con badge dei
  messaggi non letti; al tocco apre una sheet con la chat, senza disturbare il gioco.

I messaggi sono **persistenti** (salvati nel DB): reggono il refresh della pagina,
l'uscita/rientro e l'apertura del tastino a metà partita (si rivede tutto lo storico).

## Vincoli e principi

- **Server-autoritativo, come il resto del progetto.** I client non scrivono mai sul
  DB direttamente: ogni messaggio passa dalla Edge Function `game` (service_role, che
  bypassa la RLS). I client possono solo leggere (RLS di SELECT per i membri).
- **Solo i membri di una stanza** vedono e scrivono nella sua chat.
- **Identità non falsificabile:** `seat` e `display_name` del mittente li ricava il
  server da `game_players`, non il client.
- **La chat non deve disturbare il gioco:** il rendering della chat è disaccoppiato dal
  rendering del tavolo (un nuovo messaggio non ridisegna il tavolo né ri-anima le carte).

## Fuori scope (YAGNI)

Emoji picker, reazioni, messaggi privati, modifica/cancella messaggi, notifiche push,
indicatore "sta scrivendo", moderazione.

## Architettura

```
client (web/index.html)
  │  invoke("send_message", { gameId, body })
  ▼
Edge Function "game" (service_role)
  │  valida (membro · non vuoto · ≤300 · anti-spam) → insert
  ▼
public.chat_messages
  │  realtime (postgres_changes)
  ▼
tutti i client membri → append in chatMessages → ridisegna SOLO il pannello chat
```

## 1. Modello dati — `public.chat_messages`

```sql
create table if not exists public.chat_messages (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games(id) on delete cascade,
  user_id      uuid not null,
  seat         int,                          -- posto del mittente al momento dell'invio
  display_name text not null,                -- snapshot del nome al momento dell'invio
  body         text not null,                -- testo del messaggio (già validato lato server)
  created_at   timestamptz not null default now()
);
create index if not exists idx_chat_game on public.chat_messages(game_id, created_at);
```

**Note di design:**

- `display_name` e `seat` sono **denormalizzati** (snapshot all'invio): il render non ha
  bisogno di join con `game_players`, e il messaggio resta leggibile anche se il
  giocatore cambia nome o lascia la stanza.
- `on delete cascade` verso `public.games`: la chat vive con la stanza e sparisce quando
  la stanza viene cancellata (coerente con `game_players`, `hands`, `round_results`).
  (Diverso dallo schema `history`, che invece deve sopravvivere alla cancellazione.)

**RLS:**

```sql
alter table public.chat_messages enable row level security;

-- I membri della partita leggono la chat della propria stanza.
drop policy if exists chat_select on public.chat_messages;
create policy chat_select on public.chat_messages
  for select to authenticated
  using ( public.is_game_member(game_id) );
```

Nessuna policy di INSERT/UPDATE/DELETE per i client: la scrittura passa solo dalla
Edge Function (service_role).

**Realtime:**

```sql
alter publication supabase_realtime add table public.chat_messages;
```

## 2. Edge Function — nuova azione `send_message`

Aggiunta in `supabase/functions/game/index.ts`.

**Contratto:**

```
send_message { gameId, body } -> { ok: true }
```

**Validazioni (lato server):**

1. Utente autenticato (già garantito dal flusso esistente).
2. È membro della partita (`loadGameAndPlayer`): altrimenti `403`.
3. `body` ripulito (`trim`): se vuoto → `400 "Messaggio vuoto"`.
4. Lunghezza massima **300 caratteri**: troncato a 300 lato server (difesa anche se il
   client non lo fa).
5. **Anti-spam:** se l'ultimo messaggio dello stesso `user_id` in questa partita è più
   recente di **1000 ms**, rifiuta con `400 "Aspetta un attimo prima di riscrivere"`.

**Comportamento:** ricava `seat` e `display_name` da `game_players` (il record `me`),
poi `insert` in `chat_messages`. Il realtime avvisa i client. La chat è disponibile in
**ogni** fase (lobby e partita): nessun controllo su `status`/`phase`.

Registrazione nel router `switch(action)`:

```ts
case "send_message": return await sendMessage(db, user.id, body);
```

> Nota: la chat **non** viene loggata nello schema `history` (è fuori dal dataset ML).

## 3. Lettura e realtime (client `web/index.html`)

**Stato locale nuovo:**

```js
let chatMessages = [];     // ultimi messaggi della stanza, ordinati per created_at
let chatOpen = false;      // sheet aperta? (rilevante solo in partita)
let chatUnread = 0;        // contatore non letti (badge sul tastino in partita)
```

**Sottoscrizione:** in `enterGame()`, sullo stesso `channel`, aggiungere un handler per
`public.chat_messages` con filtro `game_id=eq.<gameId>`. **Non** chiama `refreshAll()`:
ha il suo handler dedicato che fa append del nuovo messaggio e ridisegna solo la chat.

```js
channel.on("postgres_changes",
  { event:"INSERT", schema:"public", table:"chat_messages", filter:"game_id=eq."+gameId },
  (payload)=> onChatInsert(payload.new));
```

**Caricamento iniziale:** in `enterGame()` (dopo la subscribe) caricare gli ultimi ~100
messaggi:

```js
const c = await supabase.from("chat_messages").select("*")
  .eq("game_id", gameId).order("created_at", { ascending:true }).limit(100);
chatMessages = c.data || [];
```

**`onChatInsert(row)`:** se `row.id` non è già presente (dedup), append a `chatMessages`;
se la chat non è visibile (in partita con sheet chiusa) incrementa `chatUnread`; poi
`renderChat()`.

## 4. UI — un solo componente chat, FUORI da `#app`

**Problema:** `render()` ricostruisce `app.innerHTML` a ogni cambiamento di stato del
gioco. Se la chat vivesse dentro `#app`, perderebbe scroll, focus dell'input e contatore
non-letti a ogni re-render.

**Soluzione:** la chat vive in un nodo dedicato `#chat`, sibling di `#app` e `#err` nel
`body`, gestito da una propria funzione `renderChat()` indipendente da `render()`.

**Due modalità, pilotate da `game` / `game.status`:**

- **Nessuna partita (home):** `#chat` nascosto.
- **Lobby (`game.status === "lobby"`):** pannello **sempre aperto**, ancorato in basso:
  lista messaggi scrollabile + input + pulsante invia. `chatUnread` ignorato (sempre
  visibile).
- **Partita (`game.status !== "lobby"`):** **tastino** flottante in basso a destra (💬)
  con badge `chatUnread` se > 0. Tap → apre una **sheet** slide-up con la lista + input +
  chiudi (✕). All'apertura: `chatOpen = true`, `chatUnread = 0`. Chiudendo: `chatOpen = false`.

**Wireframe:**

```
LOBBY (sempre aperta, in basso)        PARTITA (tastino discreto)
┌─────────────────────────┐            tavolo .........
│  Stanza ABCD   👑Gio ... │            .............. ┌──────┐
├─────────────────────────┤            .............. │ 💬 3 │ ← badge non-letti
│ Gio: ciao a tutti        │                          └──────┘
│ Ana: arrivo!             │            tap → sheet slide-up:
│ ...                      │            ┌─────────────────────┐
├─────────────────────────┤            │ chat      [chiudi ✕]│
│ [scrivi...]      [invia] │            │ Gio: bella presa     │
└─────────────────────────┘            │ [scrivi...]  [invia] │
                                        └─────────────────────┘
```

**Invio:** `doSendMessage()` legge l'input, `trim`, se vuoto non fa nulla; cap 300 lato
client (specchio del server); `invoke("send_message", { gameId, body })`; al successo
svuota l'input. Il messaggio comparirà via realtime (no inserimento ottimistico:
mantiene una sola sorgente di verità ed evita doppioni).

**Rendering messaggio:** `display_name` e `body` passati da `esc()` (anti-XSS, come già
fa il resto del client). I messaggi miei (`user_id === myUserId`) allineati/colorati
diversamente per leggibilità.

**Stile:** coerente con il tema esistente (feltro verde, oro `--gold`, pannelli scuri
translucidi, bordi arrotondati). Tastino e sheet con le stesse `box-shadow`/gradiente dei
`button`/`.panel` attuali.

## 5. Migration & deploy

- Nuova cartella `migrations/002_chat_messages/` con `up.sql`, `down.sql`, `notes.md`,
  `metadata.json`, nello stile di `001_v1_game_history` (e log in
  `migrations/MIGRATION_LOG.md`).
  - `up.sql`: crea `public.chat_messages` + indice + RLS + policy di SELECT + aggiunta a
    `supabase_realtime` + riga in `internal.schema_migrations`.
  - `down.sql`: `drop table public.chat_messages` + log del rollback.
- Aggiungere la stessa tabella (con RLS, policy, realtime) a `db/setup.sql`, così le
  installazioni **nuove** sono complete senza dover applicare la migration.
- Deploy della function: `supabase functions deploy game`.

## 6. Test manuale

- [ ] `up.sql` gira senza errori; tabella + policy + realtime presenti.
- [ ] Due browser nella stessa stanza: invio da uno → l'altro lo vede **in tempo reale**.
- [ ] Refresh della pagina → lo **storico** della chat è ancora lì.
- [ ] In lobby la chat è sempre aperta in basso.
- [ ] In partita: tastino in basso a destra; messaggi mentre è chiusa → **badge** con
      conteggio; all'apertura il badge si azzera e si vede lo storico.
- [ ] Un nuovo messaggio durante la partita **non** fa lampeggiare il tavolo né ri-anima
      le carte.
- [ ] Cap 300 caratteri rispettato (client e server).
- [ ] Anti-spam: due invii rapidissimi (<1s) → il secondo è rifiutato con messaggio.
- [ ] Messaggio `<script>alert(1)</script>` mostrato come **testo**, non eseguito.
- [ ] Un non-membro non riesce a leggere la chat (RLS).
```

## Criteri di completamento

La feature è completa quando: la tabella e la migration esistono e girano; la Edge
Function accetta `send_message` con tutte le validazioni; il client mostra la chat
sempre aperta in lobby e col tastino+badge in partita; i messaggi arrivano in realtime,
sopravvivono al refresh e non disturbano il rendering del gioco; tutti i punti del test
manuale passano.
