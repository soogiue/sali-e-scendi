# 007_start_cards — Note

## Cosa fa

Aggiunge `public.games.start_cards` (int, default 1, check 1–10): da quante
carte parte la sequenza dei round. La sequenza resta `[start..picco, picco..start]`
(picco due volte, come oggi); con `start = picco` degenera in `[picco, picco]`.

## Flusso

1. L'host la imposta in lobby con l'azione `set_start_cards` (host-only,
   lobby-only, 1–10); il realtime la mostra a tutti.
2. `start_game` la clampa al picco reale del tavolo (`maxCardsFor(n)`:
   10 con 4 giocatori, 8 con 5) e materializza `games.rounds`.
3. Da lì in poi tutto legge `rounds`: nessun'altra parte del sistema cambia
   (contatore mani, dealing, punteggi, e il futuro riprendi-partita).

## Compatibilità

- Default 1 → chi non tocca nulla gioca come prima: NON breaking.
- Function vecchia + colonna nuova: la colonna viene ignorata, ok.
- Function nuova + colonna mancante: `game.start_cards` è undefined →
  `?? 1` nel codice → comportamento storico, nessun errore.

## Rollback

`down.sql` droppa la colonna. Le partite già iniziate non si rompono
(`rounds` è già materializzato); le nuove tornano a 1 → picco → 1.
