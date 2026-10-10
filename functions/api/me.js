// GET /api/me
// Returns the logged-in user's identity, role, and granted tool keys, so the
// frontend (index.html, admin-dashboard.html) knows what to render. Returns
// 401 if there's no valid session.
import { readSession } from '../_lib/auth.js';
import { sbSelect } from '../_lib/supabase-admin.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const onRequestGet = async ({ request, env }) => {
  if (!env.SESSION_SECRET) return json({ error: 'Server not configured' }, 500);

  const session = await readSession(request, env.SESSION_SECRET);
  if (!session) return json({ error: 'Not logged in' }, 401);

  // admin/superadmin see every tool card without needing explicit grants
  // (matches the same bypass in functions/api/unlock-tool.js).
  const isElevated = session.role === 'admin' || session.role === 'superadmin';

  let tools = [];
  try {
    if (isElevated) {
      const rows = await sbSelect(env, 'tools', 'select=key');
      tools = rows.map((r) => r.key);
    } else {
      const rows = await sbSelect(env, 'user_tool_access', `user_id=eq.${session.uid}&select=tool_key`);
      tools = rows.map((r) => r.tool_key);
    }
  } catch {
    // If Supabase is briefly unavailable, fail closed on tool grants rather
    // than silently granting everything, but still report identity.
    tools = [];
  }

  return json({
    username: session.username,
    role: session.role,
    tools,
  });
};
