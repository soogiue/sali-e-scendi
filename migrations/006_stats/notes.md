# 006_stats — Note

## Cosa fa

Tre funzioni RPC in `public`, tutte `security definer` + `stable` +
`set search_path = public, history`, eseguibili SOLO da `authenticated`:

- `get_my_stats()` → 1 riga: giocate, vinte, win rate, punti medi, miglior
  punteggio, piazzamento medio, precisione dichiarazioni (da
  `history.round_outcomes.guessed`). Zeri se non hai mai finito una partita.
- `get_my_history(p_limit default 20, cap 50)` → ultime partite concluse:
  data, n. giocatori, mio punteggio/piazzamento, nome del vincitore.
- `get_leaderboard()` → per ogni profilo con almeno una partita conclusa:
  giocate, vinte, win rate, punti medi. Ordine: vinte desc, win rate desc,
  nickname asc.

## Perché RPC e non RLS

Lo schema `history` è il dataset ML: RLS abilitata senza policy di SELECT,
scrive solo la edge function (service_role). La classifica richiederebbe
lettura cross-utente: aprirlo coi policy esporrebbe le mani/mosse di tutti.
Le funzioni definer espongono SOLO gli aggregati, e `auth.uid()` interno
rende impossibile chiedere i dati di un altro.

## Dipendenze e caveat

- Richiede 001 (schema history) e 005 (profiles). Applicare in ordine.
- Le statistiche partono da quando il logging è attivo: le partite precedenti
  non esistono nel dataset (nessun backfill possibile).
- I bot hanno `user_id` sintetici senza riga in `profiles`: esclusi da
  classifica (inner join) e da stats/storico (filtro `auth.uid()`).

## Rollback

`down.sql` droppa le tre funzioni. Nessun dato toccato; la schermata 📊 del
client mostrerà un errore finché non si riapplica `up.sql`.
