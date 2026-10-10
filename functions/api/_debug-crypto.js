// TEMPORARY diagnostic endpoint — not linked from any UI, safe to hit directly.
// Exercises the exact same crypto calls as login.js without touching Supabase,
// to isolate whether the 500 on /api/login is in the crypto path or the
// Supabase REST path. DELETE THIS FILE once /api/login works.
import { verifyPassword, hashPassword, createSessionCookie, sessionExpiry } from '../_lib/auth.js';

export const onRequestGet = async ({ env }) => {
  const steps = [];
  try {
    steps.push('start');
    const hash = await hashPassword('rajni8055');
    steps.push('hashed: ' + hash.slice(0, 20));
    const ok = await verifyPassword('rajni8055', hash);
    steps.push('verified: ' + ok);
    if (!env.SESSION_SECRET) { steps.push('NO SESSION_SECRET'); throw new Error('no secret'); }
    const cookie = await createSessionCookie({ uid: 1, username: 'fari', role: 'superadmin', exp: sessionExpiry() }, env.SESSION_SECRET);
    steps.push('cookie: ' + cookie.slice(0, 30));
    return new Response(JSON.stringify({ ok: true, steps }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, steps, error: String(e && e.stack || e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
