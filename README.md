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

4 giocatori → 10 carte al picco · 5 → 8 · round 1…picco…1 · briscola (gerarchia Asso,3,Re,Cavallo,Fante,7…)
· picco senza briscola (tresette: 3,2,Asso,Re,…) · obbligo di rispondere al seme (no taglio obbligatorio)
· primo di mano = dopo il mazziere, senso orario · punti: +1+prese se indovini, −differenza se sbagli
· l'ultimo a dichiarare non può far combaciare la somma con le prese del round.

> Il prototipo locale "pass-and-play" resta in `../sali-e-scendi.html` (un solo telefono).
