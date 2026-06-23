# Architettura — Sali e Scendi Online

Spiegazione di come è fatto e perché, così sai cosa stai costruendo.

## I tre strati (e perché sono separati)

```
   ┌─────────────┐   intenzione ("gioco questa carta")   ┌──────────────────┐
   │  FRONTEND   │ ───────────────────────────────────▶ │  EDGE FUNCTION    │
   │ (browser)   │                                       │  (server, motore) │
   │  disegna    │ ◀─── stato aggiornato (Realtime) ──── │  valida + scrive  │
   └─────────────┘                                       └────────┬─────────┘
          ▲                                                       │
          │            legge (con RLS, solo ciò che può)          ▼
          └──────────────────────────────────────────────  ┌───────────┐
                                                            │ DATABASE  │
                                                            │ Postgres  │
                                                            └───────────┘
```

1. **Motore** (`supabase/functions/_shared/engine.ts`): le regole pure, senza grafica né rete. È l'unica fonte di verità delle regole, verificata con 36 test + 600 partite simulate.
2. **Server autoritativo** (`supabase/functions/game/index.ts`): riceve le *intenzioni* dei giocatori, le valida col motore e scrive lo stato nel database. **Non si fida mai del client.**
3. **Frontend** (`web/`): mostra lo stato e manda le intenzioni. Non conosce le carte degli altri.

Perché separare: in un gioco con **mani nascoste** e competizione, se la logica stesse nel browser un giocatore potative barare (vedere le carte altrui, fare mosse illegali). Mettendo regole + carte sul server, il client diventa "solo uno schermo".

## Come restano nascoste le mani

- Le mani stanno nella tabella `hands`, protetta da **Row Level Security**: la policy permette di leggere **solo** le righe dove `user_id = auth.uid()`. Quindi il database stesso si rifiuta di dare a un giocatore le carte di un altro.
- Il **Realtime** rispetta la RLS: quando il server aggiorna le mani, ogni giocatore riceve in tempo reale **solo la propria**.
- Tutto il resto (chi è di turno, carte sul tavolo, dichiarazioni, punteggi) è pubblico ai membri della stanza e viene sincronizzato a tutti.

## Modello dati (tabelle)

- **games** — una partita/stanza. Contiene lo stato pubblico: `phase` (lobby/declaring/playing/trick_done/round_end/finished), `round_index`, `n_cards`, `briscola`, `current_turn_seat`, `trick_plays` (carte sul tavolo), `last_trick_winner`, `rounds` (la sequenza 1…picco…1), ecc.
- **game_players** — i giocatori: `seat` (posto 0..n-1), `display_name`, `score`, `declared` (dichiarazione del round), `taken` (prese del round).
- **hands** — *privata*: `cards` = la mano corrente di ciascun posto (RLS per proprietario).
- **round_results** — storico dei punti per round (per i riepiloghi).

Le scritture le fa **solo** la Edge Function con la `service_role` (che bypassa la RLS). I client hanno solo policy di **lettura**.

## Il protocollo delle azioni

Il frontend chiama la function con `{ action, ... }`:

| Azione | Chi | Effetto |
|---|---|---|
| `create_game` | chiunque | crea stanza + codice, ti siede al posto 0 (host) |
| `join_game` | chiunque | entri con il codice (max 5) |
| `start_game` | host | con 4–5 giocatori: distribuisce il 1° round |
| `declare` | giocatore di turno | registra la dichiarazione (con il vincolo dell'ultimo) |
| `play_card` | giocatore di turno | valida (rispetto del seme), gioca, risolve la presa |
| `continue` | host | avanza dopo la presa conclusa / fine round |

Ogni azione ricarica lo stato → il Realtime notifica tutti → i client ridisegnano. Semplice e robusto.

## Flusso di un round

1. `start_game`/`continue` → **distribuzione**: il server crea il mazzo, lo mescola, assegna le mani (scritte in `hands`), gira la briscola (o tresette al picco), imposta il primo di mano (quello dopo il mazziere).
2. **Dichiarazioni**: in ordine; l'ultimo non può far combaciare la somma con le carte del round.
3. **Prese**: ogni giocatore gioca; il server controlla che rispetti il seme di uscita; quando il tavolo è pieno calcola il vincitore (briscola batte; altrimenti la più alta nel seme di uscita).
4. A presa conclusa: stato `trick_done` (tutti vedono l'esito), poi si riparte dal vincitore.
5. Fine round: punteggi (+1+prese se indovini, −differenza se sbagli), poi round successivo o fine partita.

## Scelte tecniche (e alternative)

- **Edge Function (Deno/TypeScript)** invece di logica in SQL: così riusiamo lo stesso motore già verificato, senza riscrivere le regole in un altro linguaggio.
- **Login anonimo**: gli amici entrano con un tap, senza account. Si può aggiungere dopo il login con email/Google per salvare statistiche.
- **Supabase Realtime** invece di un server WebSocket dedicato: questo è un gioco *a turni*, non d'azione, quindi va benissimo ed è molto più semplice da gestire.

## Cosa manca (prossimi miglioramenti)

- **Riconnessione fluida** se a qualcuno cade la linea a metà partita (ora rientra ricaricando, ma va collaudato).
- **Anti-stallo**: se l'host se ne va durante `trick_done`/`round_end` la partita si ferma; si può rendere automatico o passare il "comando" a un altro.
- **Animazioni** delle carte e suoni.
- **Icone PWA** e service worker per il vero offline/installazione.
- **Ottimistic UI**: mostrare subito la propria mossa prima della conferma del server.
- **Spettatori**, cronologia partite, classifiche.
