# 009_endgame_and_trash_toggle

## Cosa fa
1. **Termina partita (host):** aggiunge il valore `aborted` ai CHECK di
   `public.games.status` e `public.games.phase`. L'azione `end_game` della Edge
   Function mette la partita in `aborted` (nessun vincitore, non finalizzata
   nello storico/statistiche).
2. **Bot che insultano (toggle lobby):** aggiunge `public.games.bots_trash`
   (bool, default `true`). L'host lo cambia in lobby con l'azione
   `set_trash_talk`; la Edge Function sfotte solo se `bots_trash` è `true`.

## Va applicata insieme a
Il **redeploy della Edge Function `game`** (nuove azioni `end_game` e
`set_trash_talk`, e trashtalk condizionato a `game.bots_trash`) e al client
aggiornato (`web/index.html`).

## Sicurezza / dati
- Additivo, **non breaking**. Un client vecchio non genera mai `aborted`.
- `bots_trash` default `true` = comportamento storico invariato.

## Rollback
`down.sql` normalizza eventuali partite `aborted` → `finished` (per non violare
i CHECK ripristinati), rimuove `bots_trash` e ristretta i CHECK. Nessuna perdita
di partite reali (le `aborted` erano comunque senza esito).
