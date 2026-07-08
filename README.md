# Sali e Scendi — Online (Fase 2)

Versione online multiplayer del tuo gioco: ognuno gioca dal proprio telefono, le mani
restano nascoste, le regole sono validate da un server (anti-cheat). Stack: **Supabase**
(database + login + realtime + edge function) e un **frontend** statico senza build.

## Da dove iniziare

👉 Apri **[SETUP.md](SETUP.md)**: è la guida passo-passo con *tutto quello che devi creare*
in Supabase. Per capire com'è fatto, leggi **[ARCHITETTURA.md](ARCHITETTURA.md)**.

## Mappa dei file

```
sali-e-scendi-online/
├─ SETUP.md            ← guida passo-passo (inizia da qui)
├─ ARCHITETTURA.md     ← come funziona e perché
├─ db/
│  └─ setup.sql        ← tabelle + sicurezza (RLS) + realtime  → da incollare in Supabase
├─ supabase/functions/
│  ├─ _shared/engine.ts← motore di gioco (regole) in TypeScript, verificato
│  └─ game/index.ts    ← server autoritativo (valida e scrive lo stato)
└─ web/                ← il frontend (pubblicabile online)
   ├─ index.html       ← l'app
   ├─ config.js        ← QUI incolli URL e chiave Supabase
   ├─ manifest.json    ← PWA (installabile su telefono)
   └─ cards/           ← le tue carte (40 immagini, già incluse)
```

## Stato (cosa è verificato e cosa no)

- ✅ **Motore** (`engine.ts`): compila in strict mode; logica confermata (36 test + 600 partite simulate) e identica al prototipo già provato.
- ✅ **Frontend e function**: scritti e coerenti tra loro; ma il giro completo *online* va collaudato con Supabase attivo (qui non potevo accenderlo).
- ⚠️ Considerala una **v1 da testare insieme**: quando hai Supabase su, facciamo un giro di prova e sistemo gli intoppi.

## Regole implementate

4 giocatori → 10 carte al picco · 5 → 8 · round 1…picco…1 (o partenza scelta dall'host, v1.4) · briscola (gerarchia Asso,3,Re,Cavallo,Fante,7…)
· picco senza briscola (tresette: 3,2,Asso,Re,…) · obbligo di rispondere al seme (no taglio obbligatorio)
· primo di mano = dopo il mazziere, senso orario · punti: +1+prese se indovini, −differenza se sbagli
· l'ultimo a dichiarare non può far combaciare la somma con le prese del round.

> Il prototipo locale "pass-and-play" resta in `../sali-e-scendi.html` (un solo telefono).

## Novità (v1.1)

- **Nome obbligatorio** per creare o entrare in una stanza.
- **Interfaccia a tavolo** stile PokerStars: giocatori disposti attorno all'ovale (tu sempre in basso), avatar generati automaticamente, carte giocate spinte verso il centro.
- **Cerchietti accanto a ogni avatar**: 🟡 prese **dichiarate** nella mano corrente · 🔵 **punti totali**.
- **Timer di turno da 15 secondi** con **auto-mossa** allo scadere (il server gioca la carta legale più debole / una dichiarazione valida), così la partita non si blocca.

> ⚠️ Se avevi già fatto il setup prima della v1.1: **ri-esegui `db/setup.sql`** (aggiunge la colonna `turn_deadline`) e **ri-pubblica** la function con `supabase functions deploy game`.

## Novità (v1.2)

- **Account veri**: login/registrazione con email e password, niente più accesso
  anonimo. **Nickname unico** scelto alla registrazione, usato in ogni partita
  (il campo "nome" è sparito). Recupero password via email e logout dalla home.
- Il nickname lo legge **il server** dal profilo (`public.profiles`): il client
  non manda più nomi.

> ⚠️ Se avevi il setup della v1.1: esegui `migrations/005_profiles/up.sql`,
> ri-pubblica la function e il frontend, e sistema i 3 toggle del dashboard
> descritti in SETUP.md (sezione "Account (v1.2)").

## Novità (v1.3)

- **📊 Statistiche** dalla home: le tue medie (partite, vittorie, win rate,
  precisione dichiarazioni), lo **storico** delle partite concluse e la
  **classifica** di tutti i giocatori (vinte, poi win rate). I bot sono esclusi.
- I numeri partono dalle partite concluse **dopo** l'attivazione del logging
  (migration 001): niente retroattività.

> ⚠️ Per attivarla: esegui `migrations/006_stats/up.sql` (dopo la 001 e la 005)
> e ri-pubblica il frontend. La function di gioco non cambia.

## Novità (v1.4)

- **Partite più corte**: in lobby l'host sceglie **da quante carte si parte**
  (es. 4 → 10 → 4 invece di 1 → 10 → 1). Il picco resta automatico dal numero
  di giocatori; tutti vedono la scelta in tempo reale. Default: 1 (come prima).

> ⚠️ Per attivarla: esegui `migrations/007_start_cards/up.sql`, ri-pubblica la
> function (`supabase functions deploy game`) e il frontend.
