# Segnapunti per carte vere — Design

**Data:** 2026-07-08
**Autore:** soogiue
**Stato:** approvato (design), pronto per il piano di implementazione

## Obiettivo

Una pagina **standalone** per segnare i punti quando si gioca con le carte vere:
un telefono al tavolo fa da segnapunti. Niente login, niente Supabase, niente
`config.js`: funziona anche offline, aperta da file o dall'app pubblicata.

## Decisioni prese (brainstorming)

- **Smart score pad**: conosce la formula dei punti (`dichiarate == fatte →
  +1+fatte`, altrimenti `−|dichiarate−fatte|`) ma NON la sequenza dei round:
  le mani si registrano liberamente.
- **Pagina separata**: `web/segnapunti.html`, linkata dalla schermata di login
  dell'app ("🃏 Giochi con le carte vere? Apri il segnapunti").
- Giocatori in **ordine di tavolo** (nessun riordino automatico).
- **Undo dell'ultima mano** (al tavolo si sbaglia).
- **localStorage**: refresh/chiusura non perdono nulla.

## Fuori scope (YAGNI)

Sequenza round automatica, rotazione mazziere, vincitore/podio animato,
condivisione/export, multi-partita salvate, PWA/manifest dedicato, qualunque
integrazione con account o statistiche online.

## Architettura

Un solo file, `web/segnapunti.html`: CSS (sottoinsieme del tema feltro/oro
dell'app, copiato — la pagina deve restare autonoma), markup minimo, JS vanilla.

```
stato = { players: ["Gio","Ana",...], hands: [ [ {d,f,pts}, ... ], ... ] }
   │ ogni modifica → localStorage("segnapunti")
   ▼
3 viste (stesso pattern innerHTML dell'app):
  setup  → nomi giocatori (2–8)
  board  → totali per giocatore + [Nuova mano] [Annulla ultima] [Nuova partita]
  hand   → per ogni giocatore: stepper Dichiarate / Fatte (0–10) + [Conferma]
```

## 1. Logica punti

```js
function handPoints(d, f){ return d === f ? 1 + f : -Math.abs(d - f); }
```

Totale giocatore = somma dei `pts` di tutte le mani. Regola identica al server
(`+1+prese se indovini, −differenza se sbagli`).

**Self-check inline** (in coda allo script, gratis a ogni apertura):

```js
console.assert(handPoints(3,3) === 4,  "esatto: 1+3");
console.assert(handPoints(0,0) === 1,  "zero esatto: 1");
console.assert(handPoints(2,5) === -3, "sbagliato: -diff");
console.assert(handPoints(5,2) === -3, "sbagliato simmetrico");
```

## 2. Viste e interazioni

- **Setup**: 2 campi nome precompilati vuoti + "aggiungi giocatore" (max 8,
  min 2 non vuoti per iniziare); "Inizia" → board. I nomi non sono modificabili
  dopo (YAGNI: "Nuova partita" per ricominciare).
- **Board**: tabella `giocatore · totale` (totale in oro, negativo in rosso),
  numero mani giocate; bottoni: **Nuova mano** (→ hand), **Annulla ultima
  mano** (visibile solo se `hands.length > 0`, con `confirm()`), **Nuova
  partita** (con `confirm()`, svuota stato e torna a setup).
- **Hand**: per ogni giocatore una riga `nome · Dichiarate [−][n][+] · Fatte
  [−][n][+]` (0–10, default 0); **Conferma mano** calcola i punti, appende a
  `hands`, salva, torna al board; **Annulla** torna al board senza salvare.
  Nessuna validazione di coerenza col mazzo (carte vere: la realtà vince).
- **Storico** (nel board, sotto i totali): righe compatte `Mano N: Gio +4 ·
  Ana −2 · ...` in ordine inverso (ultima in alto).

## 3. Persistenza

`localStorage["segnapunti"]` = JSON dello stato, scritto a ogni mutazione;
all'avvio, se presente e valido → board, altrimenti setup. "Nuova partita"
rimuove la chiave. Parse fallito → si riparte da setup senza errori.

## 4. Link dalla schermata di login

In `web/index.html`, in fondo a `renderAuth()` (fuori dal panel):

```html
<p class="tiny" style="text-align:center;margin-top:14px">
  <a href="segnapunti.html" style="color:inherit;opacity:.7">🃏 Giochi con le carte vere? Apri il segnapunti</a>
</p>
```

Unico tocco all'app esistente.

## 5. Deploy e docs

Nessuna migration, nessun deploy della function: si ripubblica solo il
frontend (il file nuovo viaggia con la cartella `web/`). README: riga nelle
novità v1.4 (stessa release).

## 6. Test manuale

- [ ] Apertura di `web/segnapunti.html` da file locale, senza rete: funziona.
- [ ] Console browser: nessun `console.assert` fallito.
- [ ] Setup con 4 nomi → board a zero; "Inizia" con meno di 2 nomi → bloccato.
- [ ] Mano: 3 dichiarate / 3 fatte → +4; 0/0 → +1; 2 dichiarate / 5 fatte → −3.
- [ ] Totali e storico aggiornati; negativo in rosso.
- [ ] Refresh della pagina → tutto ancora lì (localStorage).
- [ ] Annulla ultima mano → totali tornano indietro; il bottone sparisce a 0 mani.
- [ ] Nuova partita → conferma → setup pulito.
- [ ] Dalla schermata di login dell'app il link apre il segnapunti (senza sessione).

## Criteri di completamento

`web/segnapunti.html` autonomo con le tre viste, punti calcolati con la regola
reale, undo, localStorage e self-check; link dalla vista auth; tutti i punti
del test manuale passano.
