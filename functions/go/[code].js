// functions/go/[code].js
// ============================================================================
//  WHATSAPP SHORT-LINK REDIRECTOR
//
//  Public route — deliberately excluded from the Basic Auth gate in
//  functions/_middleware.js, because this is the URL that goes out in ads
//  and posts. A customer clicking it must never see a login prompt.
//
//  /go/{code}  ->  302 redirect  ->  the real https://wa.me/... link
//
//  The {code} -> target_url mapping lives in Supabase table `short_links`
//  (same project already used elsewhere in this app — see js/supabase-api.js
//  and functions/api/posting-calendar.js). Codes are created by
//  createShortLink() in functions/api/posting-calendar.js at scheduling time.
// ============================================================================

const SUPABASE_URL = 'https://ivllhheqqiseagmctfyp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2bGxoaGVxcWlzZWFnbWN0ZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzQzMzksImV4cCI6MjA4NDE1MDMzOX0.OnkYNACtdknKDY2KqLfiGN0ORXpKaW906fD0TtSJlIk';

export async function onRequestGet(context) {
  const { params } = context;
  const code = String(params.code || '').trim();

  if (!code) {
    return new Response('Missing short link code.', { status: 400 });
  }

  let row;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/short_links?code=eq.${encodeURIComponent(code)}&select=target_url`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) throw new Error(`Supabase lookup failed: ${res.status}`);
    const rows = await res.json();
    row = rows[0];
  } catch (e) {
    return new Response('This link could not be resolved right now. Please try again shortly.', { status: 502 });
  }

  if (!row || !row.target_url) {
    return new Response('This link is invalid or has expired.', { status: 404 });
  }

  // Fire-and-forget click count — never blocks or fails the redirect itself.
  context.waitUntil(
    fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_short_link_clicks`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_code: code }),
    }).catch(() => {})
  );

  return Response.redirect(row.target_url, 302);
}
