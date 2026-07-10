-- Rollback: 008_login_by_nickname
-- Rimuove la funzione di lookup nickname -> email.
-- ============================================================

drop function if exists public.email_for_nickname(text);

update internal.schema_migrations
  set status = 'rolled_back', applied_at = now()
  where version = '008_login_by_nickname';
