# 005_profiles — Note

## Cosa fa

- Crea `public.profiles` (id = auth.users.id, nickname unico case-insensitive
  3-20 caratteri, created_at).
- Trigger `on_auth_user_created` su `auth.users`: alla registrazione inserisce il
  profilo col nickname preso da `raw_user_meta_data->>'nickname'` (passato dal
  client in `signUp(..., options.data.nickname)`).
- RLS: SELECT per `anon` e `authenticated` (i nickname sono pubblici; il check di
  disponibilita avviene PRIMA del login). Nessuna policy di scrittura: scrive
  solo il trigger.
- ⚠️ Eventuali provider futuri (OAuth, magic link, phone) devono passare
  `nickname` in `raw_user_meta_data`, altrimenti il trigger blocca la loro
  registrazione.

## Perche breaking

- La Edge Function `game` (da questa versione) ricava il nickname da `profiles`
  in `create_game`/`join_game` e ignora `displayName` dal client: senza questa
  migration risponde 403 "Profilo mancante".
- Ordine di deploy: 1) questa migration, 2) `supabase functions deploy game`,
  3) pubblicare il client aggiornato, 4) dashboard: Email provider ON senza
  conferma, Anonymous sign-ins OFF, Redirect URL dell'app (vedi SETUP.md).

## Rollback

`down.sql` elimina trigger, funzione e tabella. Gli utenti auth restano ma senza
profilo: il gioco torna utilizzabile solo ripristinando anche function+client
precedenti (o riapplicando `up.sql`).
