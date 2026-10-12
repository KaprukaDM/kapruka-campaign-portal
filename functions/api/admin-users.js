// /api/admin-users — manage accounts and per-tool access grants.
// Callable only by a logged-in user with role 'admin' or 'superadmin'
// (per the user's answer: both roles can manage users/tools).
//
// GET    /api/admin-users                 → list all users with their tool grants
// POST   /api/admin-users                 → create a user { username, displayName, password, role, dashboardView? }
// PATCH  /api/admin-users?id=5            → update { displayName?, role?, active?, password?, tools?, dashboardView? }
//                                            tools, if present, REPLACES the full grant set for that user
// DELETE /api/admin-users?id=5            → remove a user
//
// `role` (user/admin/superadmin) gates the PORTAL: index.html tool cards and
// who can call this endpoint at all. `dashboardView` (none/studio_only/full)
// is unrelated — it gates admin-dashboard.html, a separate app with its own
// access shape that predates this login system. See
// sql/users_add_dashboard_view.sql for why these are kept apart.
const DASHBOARD_VIEWS = ['none', 'studio_only', 'full'];
import { readSession, hashPassword } from '../_lib/auth.js';
import { sbSelect, sbInsert, sbUpdate, sbDelete } from '../_lib/supabase-admin.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

async function requireAdmin(request, env) {
  if (!env.SESSION_SECRET) return { error: json({ error: 'Server not configured' }, 500) };
  const session = await readSession(request, env.SESSION_SECRET);
  if (!session) return { error: json({ error: 'Not logged in' }, 401) };
  if (session.role !== 'admin' && session.role !== 'superadmin') {
    return { error: json({ error: 'Forbidden' }, 403) };
  }
  return { session };
}

export const onRequestGet = async ({ request, env }) => {
  const { session, error } = await requireAdmin(request, env);
  if (error) return error;

  const [users, grants, tools] = await Promise.all([
    sbSelect(env, 'users', 'select=id,username,display_name,role,active,dashboard_view,last_login_at,created_at&order=username.asc'),
    sbSelect(env, 'user_tool_access', 'select=user_id,tool_key'),
    sbSelect(env, 'tools', 'select=key,label&order=label.asc'),
  ]);

  const grantsByUser = {};
  for (const g of grants) {
    (grantsByUser[g.user_id] ||= []).push(g.tool_key);
  }

  const result = users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    active: u.active,
    dashboardView: u.dashboard_view,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    tools: grantsByUser[u.id] || [],
  }));

  return json({ users: result, tools, currentRole: session.role });
};

export const onRequestPost = async ({ request, env }) => {
  const { error } = await requireAdmin(request, env);
  if (error) return error;

  let data;
  try { data = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

  const username = typeof data?.username === 'string' ? data.username.trim().toLowerCase() : '';
  const displayName = typeof data?.displayName === 'string' ? data.displayName.trim() : '';
  const password = typeof data?.password === 'string' ? data.password : '';
  const role = ['user', 'admin', 'superadmin'].includes(data?.role) ? data.role : 'user';
  const dashboardView = DASHBOARD_VIEWS.includes(data?.dashboardView) ? data.dashboardView : 'none';

  if (!username || !displayName || password.length < 8) {
    return json({ error: 'username, displayName and a password of 8+ characters are required' }, 400);
  }
  if (!/^[a-z0-9._-]+$/.test(username)) {
    return json({ error: 'username may only contain lowercase letters, numbers, dot, underscore, hyphen' }, 400);
  }

  const existing = await sbSelect(env, 'users', `username=eq.${encodeURIComponent(username)}&select=id`);
  if (existing.length) return json({ error: 'That username already exists' }, 409);

  const password_hash = await hashPassword(password);
  const created = await sbInsert(env, 'users', [
    { username, display_name: displayName, password_hash, role, dashboard_view: dashboardView, active: true },
  ]);

  const tools = Array.isArray(data?.tools) ? data.tools.filter((t) => typeof t === 'string') : [];
  if (tools.length) {
    await sbInsert(
      env,
      'user_tool_access',
      tools.map((tool_key) => ({ user_id: created[0].id, tool_key }))
    );
  }

  return json({ ok: true, id: created[0].id });
};

export const onRequestPatch = async ({ request, env }) => {
  const { session, error } = await requireAdmin(request, env);
  if (error) return error;

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id'), 10);
  if (!id) return json({ error: 'id query param required' }, 400);

  let data;
  try { data = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

  const patch = {};
  if (typeof data?.displayName === 'string' && data.displayName.trim()) patch.display_name = data.displayName.trim();
  if (['user', 'admin', 'superadmin'].includes(data?.role)) patch.role = data.role;
  if (DASHBOARD_VIEWS.includes(data?.dashboardView)) patch.dashboard_view = data.dashboardView;
  if (typeof data?.active === 'boolean') patch.active = data.active;
  if (typeof data?.password === 'string' && data.password.length) {
    if (data.password.length < 8) return json({ error: 'Password must be 8+ characters' }, 400);
    patch.password_hash = await hashPassword(data.password);
  }

  // Only a superadmin may grant/revoke the superadmin role itself.
  if (patch.role === 'superadmin' && session.role !== 'superadmin') {
    return json({ error: 'Only a superadmin can grant the superadmin role' }, 403);
  }

  // Block any edit that would leave zero active admin/superadmin accounts —
  // that locks everyone out of User Management with no way back in short of
  // editing Supabase directly. Covers demoting a role to 'user' and
  // deactivating an elevated account (either alone can cause the lockout).
  const demotesRole = 'role' in patch && patch.role === 'user';
  const deactivates = 'active' in patch && patch.active === false;
  if (demotesRole || deactivates) {
    const target = await sbSelect(env, 'users', `id=eq.${id}&select=role,active&limit=1`);
    const targetIsCurrentlyElevatedAndActive =
      target[0] && target[0].active && (target[0].role === 'admin' || target[0].role === 'superadmin');

    if (targetIsCurrentlyElevatedAndActive) {
      const willStillBeElevated = demotesRole ? false : (target[0].role === 'admin' || target[0].role === 'superadmin');
      const willStillBeActive = deactivates ? false : target[0].active;
      if (!(willStillBeElevated && willStillBeActive)) {
        const others = await sbSelect(
          env,
          'users',
          `id=neq.${id}&active=eq.true&role=in.(admin,superadmin)&select=id&limit=1`
        );
        if (!others.length) {
          return json({ error: 'This is the last active admin/superadmin — demote or disable another one first' }, 400);
        }
      }
    }
  }

  if (Object.keys(patch).length) {
    await sbUpdate(env, 'users', `id=eq.${id}`, patch);
  }

  if (Array.isArray(data?.tools)) {
    const tools = data.tools.filter((t) => typeof t === 'string');
    await sbDelete(env, 'user_tool_access', `user_id=eq.${id}`);
    if (tools.length) {
      await sbInsert(
        env,
        'user_tool_access',
        tools.map((tool_key) => ({ user_id: id, tool_key, granted_by: session.username }))
      );
    }
  }

  return json({ ok: true });
};

export const onRequestDelete = async ({ request, env }) => {
  const { session, error } = await requireAdmin(request, env);
  if (error) return error;

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id'), 10);
  if (!id) return json({ error: 'id query param required' }, 400);

  // Server-side guard, not just a UI check: never let someone delete the
  // account they're currently logged in as (would instantly invalidate
  // their own still-valid session and, if they're the only admin, lock
  // everyone out of user management).
  if (id === session.uid) {
    return json({ error: "You can't delete the account you're logged in as" }, 400);
  }

  await sbDelete(env, 'users', `id=eq.${id}`);
  return json({ ok: true });
};
