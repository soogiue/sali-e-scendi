# 004_autoplay — Notes

## Cosa aggiunge

Una colonna **`public.game_players.autoplay`** (`boolean`, default `false`). Serve
al tasto **AUTOGAME**: un giocatore umano può delegare il proprio posto a un bot
(che usa i **modelli ML allenati**) senza bloccare la partita, e può **riprendere
il controllo** quando vuole (reversibile).

## Differenza con `is_bot`

- `is_bot = true` → posto creato come bot dall'host nella lobby.
- `autoplay = true` → posto di un **umano** temporaneamente giocato dal server.

In `advanceBots` il server gioca per i posti con `is_bot` **oppure** `autoplay`,
usando `mlbot.ts` (modelli allenati) con fallback all'euristica di `engine.ts`.

## Azione lato Edge Function

`toggle_autoplay { gameId, on }` — imposta `autoplay` sul **proprio** posto
(solo il giocatore stesso può attivarlo/disattivarlo). Dopo l'attivazione il
server chiama `advanceBots`, così se è già il tuo turno il bot gioca subito.

## Compatibilità

- ✅ Retro-compatibile: colonna nuova con default, nessuna modifica distruttiva.
- RLS invariata.

## Come applicarla

1. SQL Editor di Supabase → esegui `up.sql`.
2. Deploy della Edge Function `game` aggiornata (`supabase functions deploy game`).
3. Pubblica il frontend aggiornato (`web/`).

## Checklist test manuale

- [ ] In partita, un giocatore preme AUTOGAME → da quel momento il server gioca
      dichiarazioni e carte per lui con i modelli ML.
- [ ] Lo stesso giocatore preme di nuovo AUTOGAME (riprendi) → torna a giocare a mano.
- [ ] La partita non si blocca mai sui posti in autogame.
