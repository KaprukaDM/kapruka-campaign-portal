// POST /api/logout — clears the session cookie.
import { clearSessionCookie } from '../_lib/auth.js';

export const onRequestPost = async () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': clearSessionCookie(),
    },
  });
