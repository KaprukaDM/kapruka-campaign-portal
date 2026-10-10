// POST /api/unlock-tool  { tool }
// Server-side resolver for the tool cards whose real URL shouldn't sit in
// index.html's source (pcagent, seo, revenue — all raw IP:port addresses on
// the Kapruka server). Access is now based on the caller's session + their
// Supabase user_tool_access grant (see sql/users_and_tool_access.sql), not a
// shared password — the old TOOLS_PASSWORD/PRICELENS_PASSWORD scheme is
// retired. index.html only shows a card once /api/me already says the user
// has the grant, but this endpoint re-checks independently: it must never
// trust that the card was hidden client-side.
import { readSession } from '../_lib/auth.js';
import { sbSelect } from '../_lib/supabase-admin.js';

const TOOLS = {
  pcagent: [{ label: 'PC Agent', url: 'http://23.111.183.110:5011/' }],
  seo: [
    { label: '📊 Kapruka SEO Dashboard', url: 'http://23.111.183.110:8094/' },
  ],
  revenue: [{ label: 'Revenue Breakdown Report', url: 'http://23.111.183.110:8095/login' }],
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const onRequestPost = async ({ request, env }) => {
  let data;
  try { data = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const { tool } = data || {};
  if (!TOOLS[tool]) return json({ error: 'Unknown tool' }, 404);

  if (!env.SESSION_SECRET) return json({ error: 'Server not configured' }, 500);
  const session = await readSession(request, env.SESSION_SECRET);
  if (!session) return json({ error: 'Not logged in' }, 401);

  // admin/superadmin can open anything; a plain user needs an explicit grant.
  if (session.role !== 'admin' && session.role !== 'superadmin') {
    const rows = await sbSelect(
      env,
      'user_tool_access',
      `user_id=eq.${session.uid}&tool_key=eq.${encodeURIComponent(tool)}&select=tool_key&limit=1`
    );
    if (!rows.length) return json({ error: 'Not granted' }, 403);
  }

  return json({ links: TOOLS[tool] });
};
