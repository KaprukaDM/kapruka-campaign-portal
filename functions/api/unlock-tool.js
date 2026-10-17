// POST /api/unlock-tool  { tool }
// Server-side resolver for EVERY portal homepage card — every card is now a
// grantable tool (see sql/users_and_tool_access.sql and
// sql/tools_add_remaining_cards.sql), checked purely against the caller's
// session + their Supabase user_tool_access grant. No per-card password
// layer anymore (that scheme — TOOLS_PASSWORD/PRICELENS_PASSWORD — is fully
// retired). index.html only shows a card once /api/me already says the user
// has the grant, but this endpoint re-checks independently: it must never
// trust that the card was hidden client-side.
import { readSession } from '../_lib/auth.js';
import { sbSelect } from '../_lib/supabase-admin.js';

const TOOLS = {
  pcagent: [{ label: 'PC Agent', url: 'https://pricelens.lanka.info/pcagent/' }],
  seo: [
    { label: '🚀 SEO Boost', url: 'https://pricelens.lanka.info/master/' },
  ],
  revenue: [{ label: 'Revenue Breakdown Report', url: 'https://pricelens.lanka.info/sales/' }],
  ads: [{ label: 'Ads Manager', url: 'https://docs.google.com/forms/d/e/1FAIpQLSfGSObGAIJz46oQd0xN3oISjS46SEkFtL0_ZGkIfh6ansvqPQ/viewform' }],
  daraz: [{ label: 'Daraz Market Agent', url: 'https://daraz-agent.onrender.com' }],
  avurudhu: [{ label: 'Season Checklist', url: 'https://kaprukadm.github.io/kapruka-campaign-portal/season_checklist.html' }],
  'campaign-booking': [{ label: 'Book Campaign Slot', url: 'campaign-booking.html' }],
  'content-calendar': [{ label: 'Content Calendar', url: 'content-calendar.html' }],
  'hot-products': [{ label: 'Hot Products', url: 'hot-products.html' }],
  'new-products': [{ label: 'Newly Added Products', url: 'new-products-performance.html' }],
  'price-checker': [
    { label: 'Price Checker', url: 'https://pricelens.lanka.info/tools/index.html' },
    // Sub-tools, all reachable from the hub above (openTool opens links[0]).
    { label: 'Checker', url: 'https://pricelens.lanka.info/tools/checker.html' },
    { label: 'Compare', url: 'https://pricelens.lanka.info/tools/compare.html' },
    { label: 'Partner Overpriced', url: 'https://pricelens.lanka.info/tools/partner-overpriced.html' },
    { label: 'All Products Overpriced', url: 'https://pricelens.lanka.info/tools/all-products-overpriced.html' },
    { label: 'UAE Compare', url: 'https://pricelens.lanka.info/tools/uae-compare/?country=UAE' },
    { label: 'Out of Stock', url: 'https://pricelens.lanka.info/tools/out-of-stock.html' },
    { label: 'Price Changes', url: 'https://pricelens.lanka.info/tools/price-changes.html' },
    { label: 'Discovered Sites', url: 'https://pricelens.lanka.info/tools/discovered-sites.html' },
  ],
  'business-scout': [{ label: 'Business Scout', url: 'https://pricelens.lanka.info/scout/' }],
  'page-hygiene': [{ label: 'Page Hygiene Dashboard', url: 'https://pricelens.lanka.info/hygiene/' }],
  'oos-dashboard': [{ label: 'Out of Stock Dashboard', url: 'https://pricelens.lanka.info/oos/' }],
  'homepage-slots': [{ label: 'Homepage Slot Manager', url: 'homepage-booking-portal.html' }],
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
