// functions/api/promo/[[path]].js
// ============================================================================
//  PROMO SUGGESTIONS RELAY  /api/promo/*  ->  the Post -> Sales Monitor service
//
//  The Promo Suggestions tab (js/promo-suggestions.js) needs the service that
//  runs Claude Code. When that service is hosted on the VPS
//  (https://pricelens.lanka.info/fbpost), every teammate's browser reaches it
//  through THIS relay rather than calling the VPS directly, because:
//    - this route sits behind functions/_middleware.js, so only someone logged
//      into the portal can use it, and
//    - the service's access key is added here, server-side, so it never reaches
//      a browser (a public address must not start paid Claude runs or show
//      sales data for anyone who finds it).
//
//  Env vars (Cloudflare Pages secrets):
//    PROMO_SERVICE_URL    e.g. https://pricelens.lanka.info/fbpost   (no trailing slash)
//    PROMO_SERVICE_TOKEN  the same value as PSM_ACCESS_TOKEN in the service's .env
//  Without them it answers 503 {not_configured:true}, and the panel falls back to
//  the service on the marketing PC (http://127.0.0.1:5300) if it is running there.
// ============================================================================

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const onRequest = async ({ request, env, params }) => {
  const base = (env.PROMO_SERVICE_URL || '').replace(/\/+$/, '');
  if (!base || !env.PROMO_SERVICE_TOKEN) {
    return json({ error: 'The promo service is not configured on the portal yet.', not_configured: true }, 503);
  }
  const parts = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  if (parts.some(p => p === '..' || p.includes('/'))) return json({ error: 'Bad path' }, 400);
  const url = new URL(request.url);
  const target = `${base}/api/promo/${parts.map(encodeURIComponent).join('/')}${url.search}`;

  const init = {
    method: request.method,
    headers: { 'X-PSM-Token': env.PROMO_SERVICE_TOKEN, 'Accept': 'application/json' },
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.headers['Content-Type'] = 'application/json';
    init.body = await request.text();
  }
  try {
    const res = await fetch(target, init);
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return json({ error: `The promo service did not answer: ${e.message}`, unreachable: true }, 502);
  }
};
