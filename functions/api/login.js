// POST /api/login  { username, password }
// Verifies against the Supabase `users` table (service role, server-side
// only) and, on success, sets a signed session cookie. See
// functions/_lib/auth.js and sql/users_and_tool_access.sql.
import { verifyPassword, createSessionCookie, sessionExpiry } from '../_lib/auth.js';
import { sbSelect, sbUpdate } from '../_lib/supabase-admin.js';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

export const onRequestPost = async ({ request, env }) => {
  let data;
  try { data = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

  const username = typeof data?.username === 'string' ? data.username.trim().toLowerCase() : '';
  const password = typeof data?.password === 'string' ? data.password : '';
  if (!username || !password) return json({ error: 'Username and password required' }, 400);

  if (!env.SESSION_SECRET) return json({ error: 'Server not configured' }, 500);

  let rows;
  try {
    rows = await sbSelect(
      env,
      'users',
      `username=eq.${encodeURIComponent(username)}&select=id,username,display_name,password_hash,role,active&limit=1`
    );
  } catch (e) {
    return json({ error: 'Login temporarily unavailable' }, 503);
  }

  const user = rows[0];
  // Always run verifyPassword, even on a missing user, against a dummy hash
  // so the response time doesn't reveal whether the username exists.
  const DUMMY_HASH = 'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);

  if (!user || !user.active || !ok) {
    return json({ error: 'Incorrect username or password' }, 401);
  }

  const cookie = await createSessionCookie(
    { uid: user.id, username: user.username, role: user.role, exp: sessionExpiry() },
    env.SESSION_SECRET
  );

  sbUpdate(env, 'users', `id=eq.${user.id}`, { last_login_at: new Date().toISOString() }).catch(() => {});

  return json(
    { ok: true, user: { username: user.username, displayName: user.display_name, role: user.role } },
    200,
    { 'Set-Cookie': cookie }
  );
};
