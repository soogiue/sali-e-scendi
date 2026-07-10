# 008_login_by_nickname

## Cosa fa
Aggiunge `public.email_for_nickname(nick text) returns text`: dato un nickname,
restituisce l'email dell'account (match case-insensitive). Serve per fare login
col solo nickname, dato che Supabase Auth accede sempre via email.

## Come si usa lato client
In `web/index.html`, `doLogin()`:
- se l'utente scrive qualcosa con `@` → e' un'email, login diretto;
- altrimenti → e' un nickname, si chiama `supabase.rpc('email_for_nickname', { nick })`,
  si ottiene l'email e si procede con `signInWithPassword`.

## Sicurezza / privacy
- `SECURITY DEFINER` + `search_path = public, auth`: legge `auth.users` (che il
  client anon non vede) e ritorna **solo** l'email.
- `GRANT EXECUTE ... to anon`: il lookup avviene prima del login.
- Consente enumerazione nickname → email a chi conosce un nickname. Accettabile
  per un gioco tra amici. Se servisse chiuderla, togliere il grant a `anon` e
  spostare il lookup in una Edge Function con rate-limiting.

## Rollback
`down.sql` fa `drop function` e marca la migration come `rolled_back`.
Non tocca dati: nessuna perdita.
