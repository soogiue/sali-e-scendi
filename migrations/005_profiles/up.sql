-- Migration: 005_profiles
-- Author: soogiue
-- Date: 2026-07-07
-- Reason: Account veri (email+password) con nickname unico; fine del login anonimo.
-- Affected: nuova tabella public.profiles + trigger su auth.users.
--           NESSUNA modifica alle tabelle esistenti.
-- Note di design:
--   * Il profilo lo crea un trigger alla registrazione (nickname passato nei
--     metadata del signUp): niente race lato client, niente utenti senza profilo.
--   * Nickname unico case-insensitive (indice su lower(nickname)), 3-20 caratteri.
--   * SELECT anche per anon: serve il pre-check di disponibilita PRIMA del login.
--     La tabella espone solo id/nickname/created_at, nessun dato sensibile.
--   * Nessuna policy di INSERT/UPDATE/DELETE: scrive solo il trigger.
-- ============================================================

-- ------------------------------------------------------------
-- public.profiles — un profilo per account
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  nickname   text not null,
  created_at timestamptz not null default now(),
  constraint nickname_len check (char_length(nickname) between 3 and 20)
);

-- Unicita case-insensitive: "Gio" e "gio" sono lo stesso nickname.
create unique index if not exists idx_profiles_nickname on public.profiles (lower(nickname));

-- ------------------------------------------------------------
-- Trigger: il profilo nasce col signup. Se l'insert fallisce
-- (nickname duplicato o fuori misura) fallisce l'INTERA
-- registrazione: nessun utente orfano.
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nickname)
  values (new.id, trim(new.raw_user_meta_data->>'nickname'));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- RLS: nickname pubblici (anche anon, per il check in registrazione).
-- ------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to anon, authenticated using (true);

-- ------------------------------------------------------------
-- LOG DELLA MIGRATION
-- ------------------------------------------------------------
insert into internal.schema_migrations (version, description, applied_by, applied_at, status)
values (
  '005_profiles',
  'Add public.profiles (unique nickname) + signup trigger on auth.users + public SELECT RLS',
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
select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'profiles';
