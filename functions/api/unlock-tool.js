// POST /api/unlock-tool  { tool, password }
// Server-side gate for the restricted tool cards. The password lives in the
// TOOLS_PASSWORD secret and the tool URLs are only returned on a correct match,
// so neither appears in the page source.
// Optional per-tool secret name; falls back to TOOLS_PASSWORD.
const SECRET_NAME = { pricelens: 'PRICELENS_PASSWORD' };

const TOOLS = {
  pricelens: [{ label: 'PriceLens', url: 'https://pricelens.lanka.info/' }],
  seo: [
    { label: '📊 Kapruka SEO Dashboard', url: 'http://23.111.183.110:8094/' },
    { label: '🔧 SEO Boost Tool', url: 'http://23.111.183.110:8093/' },
    { label: '🛠️ SEO Tool', url: 'http://23.111.183.110:8092/' },
    { label: '💡 Opportunity Tool', url: 'http://23.111.183.110:5002/' },
  ],
  revenue: [{ label: 'Revenue Breakdown Report', url: 'http://23.111.183.110:8095/login' }],
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export const onRequestPost = async ({ request, env }) => {
  let data;
  try { data = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const { tool, password } = data || {};
  if (!TOOLS[tool]) return json({ error: 'Unknown tool' }, 404);
  const expected = env[SECRET_NAME[tool]] || env.TOOLS_PASSWORD;
  if (!expected || typeof password !== 'string' || !(await safeEqual(password, expected))) {
    return json({ error: 'Incorrect password' }, 401);
  }
  return json({ links: TOOLS[tool] });
};
