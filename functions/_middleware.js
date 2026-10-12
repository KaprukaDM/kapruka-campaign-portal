// functions/_middleware.js
// Site-wide gate. Replaces the old 25-hardcoded-username Basic Auth with the
// per-user session system (see functions/_lib/auth.js, functions/api/login.js).
import { readSession } from './_lib/auth.js';

const PUBLIC_PATHS = ['/login.html', '/api/login', '/api/logout'];

export const onRequest = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Static assets and the login page/API itself are always reachable.
  if (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.ico') ||
    PUBLIC_PATHS.includes(url.pathname)
  ) {
    return await next();
  }

  if (!env.SESSION_SECRET) {
    return new Response('Server not configured (missing SESSION_SECRET)', { status: 500 });
  }

  const session = await readSession(request, env.SESSION_SECRET);
  if (!session) {
    // API callers get a 401; browser navigations get redirected to the login page.
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Not logged in' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    const redirect = new URL('/login.html', url.origin);
    redirect.searchParams.set('next', url.pathname + url.search);
    return Response.redirect(redirect.toString(), 302);
  }

  const response = await next();
  response.headers.set('Cache-Control', 'no-store, must-revalidate');
  return response;
};
