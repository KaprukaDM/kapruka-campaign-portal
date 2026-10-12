-- Adds a dashboard_view column to users, run once in Supabase → SQL Editor.
-- Idempotent (safe to re-run).
--
-- This is intentionally separate from `role` (user/admin/superadmin), which
-- controls the PORTAL (index.html tool cards + who can manage users via
-- /api/admin-users). dashboard_view instead controls access to
-- admin-dashboard.html, a different app with its own, differently-shaped
-- access levels that predate this login system:
--   'none'        — cannot open admin-dashboard.html at all (the default;
--                    most portal users have no reason to be in there)
--   'studio_only' — sees only the Studio Calendar tab (this is what the
--                    dashboard's OLD code confusingly called "superadmin" —
--                    that name is not reused here on purpose)
--   'full'        — sees every tab (this is what the OLD code called "admin")
--
-- Keeping this separate from `role` means, for example, a portal `user` can
-- still be given `dashboard_view = 'studio_only'` without being made a
-- portal admin, and a portal `admin` isn't automatically let into the
-- Studio-management dashboard just because they can manage other users.

alter table users
  add column if not exists dashboard_view text not null default 'none';

alter table users
  drop constraint if exists users_dashboard_view_check;

alter table users
  add constraint users_dashboard_view_check
  check (dashboard_view in ('none', 'studio_only', 'full'));
