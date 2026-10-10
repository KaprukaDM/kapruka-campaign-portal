// TEMPORARY diagnostic endpoint (no underscore prefix, so Pages routes it) —
// not linked from any UI. Exercises the exact same crypto + Supabase calls as
// login.js to isolate the real cause of the 500 on /api/login.
// DELETE THIS FILE once /api/login works.
import { verifyPassword, hashPassword, createSessionCookie, sessionExpiry } from '../_lib/auth.js';
import { sbSelect } from '../_lib/supabase-admin.js';

export const onRequestGet = async ({ env }) => {
  const steps = [];
  try {
    steps.push('start');
    const hash = await hashPassword('rajni8055');
    steps.push('hashed ok');
    const ok = await verifyPassword('rajni8055', hash);
    steps.push('verify: ' + ok);
    if (!env.SESSION_SECRET) { steps.push('NO SESSION_SECRET'); throw new Error('no secret'); }
    const cookie = await createSessionCookie({ uid: 1, username: 'fari', role: 'superadmin', exp: sessionExpiry() }, env.SESSION_SECRET);
    steps.push('cookie ok: ' + cookie.slice(0, 25));
    const rows = await sbSelect(env, 'users', 'username=eq.fari&select=id,username,role&limit=1');
    steps.push('supabase rows: ' + JSON.stringify(rows));
    return new Response(JSON.stringify({ ok: true, steps }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, steps, error: String((e && e.stack) || e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
