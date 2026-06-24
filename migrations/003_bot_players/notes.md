# 003_bot_players — Notes

## Cosa aggiunge

Una colonna **`public.game_players.is_bot`** (`boolean`, default `false`). È tutto
ciò che serve a livello di database per la feature "gioca con i bot".

## Come funziona la feature (lato codice)

- **Lobby:** l'host chiama l'azione `set_bots { gameId, count }` (Edge Function).
  Il server crea/rimuove righe `game_players` con `is_bot=true` e un `user_id`
  sintetico (uuid), ricompattando i posti così da restare contigui `0..n-1`.
- **In partita:** quando tocca a un bot (fase `declaring`/`playing`), la Edge
  Function gioca per lui con l'euristica `botDeclare`/`botPlay` di `engine.ts`
  (`advanceBots`), incatenando eventuali turni-bot consecutivi nella stessa
  richiesta. Le pause `trick_done`/`round_end` restano guidate dal client host
  (come già avviene oggi).

## Perché i bot sono righe normali

Tenendoli come `game_players` con `user_id` sintetico, i vincoli
`unique(game_id, seat)` e `unique(game_id, user_id)` continuano a valere senza
modifiche, la RLS non cambia (i membri vedono tutti i giocatori, bot inclusi) e
il motore non ha bisogno di sapere "chi è bot": gli servono solo posti `0..n-1`.

## Compatibilità

- ✅ Retro-compatibile: colonna nuova con default, nessuna modifica distruttiva.
- Le partite e i log `history` esistenti restano validi (i bot avranno un
  `user_id` sintetico anche nello storico — utile per distinguerli nel dataset).

## Come applicarla

1. SQL Editor di Supabase → esegui `up.sql`.
2. Deploy della Edge Function `game` aggiornata (`supabase functions deploy game`).
3. Pubblica il frontend aggiornato (`web/`).

## Checklist test manuale

- [ ] In lobby, l'host imposta 2 bot in una stanza con 2 umani → 4 giocatori.
- [ ] Avvio partita: i bot dichiarano e giocano da soli quando è il loro turno.
- [ ] Le prese si chiudono e i round avanzano normalmente.
- [ ] A fine partita lo storico `history` contiene anche le mosse dei bot.
- [ ] Riducendo il numero di bot in lobby i posti restano contigui.
