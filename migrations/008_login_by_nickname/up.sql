-- Migration: 008_login_by_nickname
-- Author: soogiue
-- Date: 2026-07-10
-- Reason: Permettere il login anche col solo nickname (oltre all'email).
--         Supabase Auth accede sempre via email, quindi serve una funzione
--         che, dato il nickname, restituisca l'email dell'account.
-- Affected: nuova funzione public.email_for_nickname(text).
--           NESSUNA modifica a tabelle o RLS esistenti.
-- Note di design:
--   * SECURITY DEFINER: gira coi privilegi del proprietario, cosi puo leggere
--     auth.users (il client anon non vi accede direttamente). Ritorna SOLO
--     l'email, nient'altro.
--   * search_path fisso a public, auth per evitare hijack del path.
--   * GRANT a anon: il lookup avviene PRIMA del login (come il pre-check del
--     nickname in registrazione).
--   * Privacy: espone la corrispondenza nickname -> email a chi conosce il
--     nickname (enumerazione). Accettabile per un gioco tra amici; se un giorno
--     servisse, si puo togliere il grant a anon e spostare il lookup in una
--     Edge Function con rate-limiting.
-- ============================================================

-- ------------------------------------------------------------
-- public.email_for_nickname — ricava l'email dato il nickname
-- (match case-insensitive, coerente con l'unicita dei nickname).
-- ------------------------------------------------------------
create or replace function public.email_for_nickname(nick text)
returns text
language sql
security definer
set search_path = public, auth
as $$
  select u.email::text
  from public.profiles p
  join auth.users u on u.id = p.id
  where lower(p.nickname) = lower(trim(nick))
  limit 1;
$$;

grant execute on function public.email_for_nickname(text) to anon, authenticated;

-- ------------------------------------------------------------
-- LOG DELLA MIGRATION
-- ------------------------------------------------------------
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '008_login_by_nickname',
  'Add public.email_for_nickname(text) security definer: resolve nickname -> account email for username login',
  'soogiue',
  now(),
  'applied'
)
on conflict (version) do update
  set description = excluded.description,
      applied_at  = excluded.applied_at,
      status      = excluded.status;

-- ------------------------------------------------------------
-- VERIFICA
-- ------------------------------------------------------------
select proname from pg_proc
where proname = 'email_for_nickname';
