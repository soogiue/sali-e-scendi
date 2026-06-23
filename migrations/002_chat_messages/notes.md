# 002_chat_messages — Notes

## Cosa aggiunge

La tabella **`public.chat_messages`**: una riga per messaggio di chat scambiato tra i
membri di una stanza. Usata sia in lobby (chat sempre aperta) sia durante la partita
(tastino con badge non-letti).

## Scelte di design

- **Scrittura solo lato server.** I messaggi passano dalla Edge Function `game`
  (`service_role`, bypassa la RLS) tramite l'azione `send_message`. Nessuna policy di
  INSERT per i client.
- **Lettura per i soli membri.** RLS abilitata con policy di SELECT
  `is_game_member(game_id)` (la stessa funzione usata da `games`/`game_players`).
- **`on delete cascade` verso `public.games`.** La chat vive con la stanza e sparisce
  quando la stanza viene cancellata (a differenza dello schema `history`, che invece
  deve sopravvivere).
- **`display_name`/`seat` denormalizzati.** Snapshot al momento dell'invio: il render
  non fa join e il messaggio resta leggibile anche se il giocatore cambia nome/esce.
- **Niente logging in `history`.** La chat è fuori dal dataset ML.

## Come applicarla

1. SQL Editor di Supabase → incolla ed esegui `up.sql`.
2. Verifica che la query finale elenchi `chat_messages`.
3. Ri-pubblica la Edge Function: `supabase functions deploy game`.
4. Aggiorna `applied_at`/`status` in `metadata.json` e la riga in `MIGRATION_LOG.md`.

## Checklist test manuale

- [ ] `up.sql` gira senza errori.
- [ ] Esiste `public.chat_messages` con indice `idx_chat_game`.
- [ ] RLS attiva + policy `chat_select`.
- [ ] La tabella è nella pubblicazione `supabase_realtime`.
- [ ] `down.sql` rimuove la tabella e logga il rollback.
