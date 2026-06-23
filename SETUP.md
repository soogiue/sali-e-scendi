# Sali e Scendi — Online · Guida al setup

Questa guida elenca **tutto quello che devi creare** per far funzionare la versione online.
Tempo stimato: ~30–45 minuti la prima volta. Non serve saper programmare, solo copiare/incollare.

Riassunto di cosa creerai:

1. Un **progetto Supabase** (gratis).
2. Le **tabelle + sicurezza + realtime** (1 file SQL da incollare).
3. Il **login anonimo** (un interruttore da attivare).
4. La **Edge Function** `game` (il server che valida le mosse).
5. La **configurazione del frontend** (2 valori da incollare).
6. La **pubblicazione online** (trascinare una cartella).

---

## 1) Crea il progetto Supabase

1. Vai su https://supabase.com e registrati (puoi usare GitHub o email).
2. **New project**. Dai un nome (es. `sali-e-scendi`), scegli una **region in Europa** (es. *West EU (Ireland)* o *Frankfurt*) per avere meno lag, e imposta una password del database (salvala da qualche parte).
3. Aspetta 1–2 minuti che il progetto sia pronto.

## 2) Crea tabelle, sicurezza e realtime (file SQL)

1. Nel menu a sinistra: **SQL Editor** → **New query**.
2. Apri il file `db/setup.sql` di questo progetto, copia **tutto** il contenuto e incollalo nell'editor.
3. Premi **Run** (in basso a destra). Deve comparire *Success*.

Questo crea le tabelle `games`, `game_players`, `hands`, `round_results`, le **policy di sicurezza** (ognuno vede solo la propria mano) e attiva il **realtime**.

## 3) Attiva il login anonimo

Gli amici devono poter entrare senza registrarsi.

1. Menu a sinistra: **Authentication** → **Sign In / Providers** (o **Providers**).
2. Trova **Anonymous sign-ins** e **attivalo** (Enable). Salva.

## 4) Pubblica la Edge Function `game`

È il "cervello" che valida ogni mossa. Va caricata con la **Supabase CLI** (uno strumento da terminale).

1. Installa la CLI (scegli UNO):
   - con npm: `npm install -g supabase`
   - oppure (Windows) con **Scoop**: `scoop install supabase`
   - oppure (Mac) con **Homebrew**: `brew install supabase/tap/supabase`
2. Apri il terminale **dentro la cartella** `sali-e-scendi-online` (quella che contiene la cartella `supabase/`).
3. Accedi: `supabase login` (si apre il browser, conferma).
4. Collega il progetto: `supabase link --project-ref ABCDEFGH`
   - Il `project-ref` è la parte iniziale dell'URL del progetto: se l'URL è `https://abcd1234.supabase.co`, il ref è `abcd1234`.
5. Carica la function: `supabase functions deploy game`

Non devi impostare chiavi segrete: Supabase fornisce automaticamente alla function le variabili `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` di cui ha bisogno.

> Se vedi errori, guarda i log con: `supabase functions logs game`

## 5) Configura il frontend

1. Nel Dashboard: **Project Settings** → **API**. Copia:
   - **Project URL** (es. `https://abcd1234.supabase.co`)
   - **anon public** key (una stringa lunga che inizia con `eyJ...`)
2. Apri il file `web/config.js` e incolla i due valori:
   ```js
   SUPABASE_URL: "https://abcd1234.supabase.co",
   SUPABASE_ANON_KEY: "eyJ...la tua anon key...",
   ```

## 6) Prova in locale

Apri la cartella `web/` con un piccolo server locale (aprire il file con doppio clic può dare problemi di sicurezza del browser). Scegli UNO:

- Con Node: nel terminale, dentro `sali-e-scendi-online`, esegui `npx serve web` e apri l'indirizzo che ti dà (es. http://localhost:3000).
- Con Python: `python -m http.server 5500 --directory web` e apri http://localhost:5500.
- Con VS Code: estensione **Live Server**, click destro su `web/index.html` → *Open with Live Server*.

Per provare il multiplayer da solo: apri l'indirizzo in due schede/finestre diverse (meglio una normale e una in incognito), crea una stanza in una e usa il codice nell'altra.

## 7) Pubblica online (così giocate dal telefono ovunque)

Tutta la cartella `web/` è statica: puoi metterla online gratis. Opzioni facili:

- **Netlify Drop**: vai su https://app.netlify.com/drop e **trascina la cartella `web/`**. Ti dà subito un link pubblico.
- **Vercel** o **Cloudflare Pages**: collega una cartella/repo e pubblica.
- **GitHub Pages**: carica `web/` in un repo e attiva Pages.

Poi apri il link sul telefono, “Aggiungi a schermata Home” per averlo come un'app, crea una stanza e manda il **codice** agli amici.

---

## Cosa è stato creato — checklist

- [ ] Progetto Supabase (region EU)
- [ ] `db/setup.sql` eseguito (tabelle + RLS + realtime)
- [ ] Login anonimo attivato
- [ ] Edge Function `game` pubblicata
- [ ] `web/config.js` compilato (URL + anon key)
- [ ] Frontend pubblicato (Netlify/Vercel/…)

## Problemi comuni

- **"Non autenticato"** → il login anonimo non è attivo (passo 3).
- **"Azione sconosciuta" / errori function** → la function non è stata caricata o è in errore: `supabase functions logs game`.
- **Le carte non si vedono** → assicurati che la cartella `web/cards/` esista (è già inclusa) o aggiusta `CARD_BASE` in `config.js`.
- **Non aggiorna in tempo reale** → ricontrolla che `db/setup.sql` sia stato eseguito tutto (è lì che si attiva il realtime).
- **Lag alto** → progetto in region sbagliata; ricrealo in Europa.

> Nota: questa è la **versione 1**. Funziona per giocare tra amici. La logica delle mosse è verificata, ma il giro completo online va collaudato con Supabase attivo: se qualcosa non torna, segnamelo e lo sistemiamo.
