// functions/api/seo-ai-suggestions.js
// ============================================================================
//  Admin Dashboard "SEO Performance" tab — AI growth-opportunity scan.
//
//  Takes real GSC search data (functions/api/seo-performance.js) plus a live
//  catalog scan (functions/api/seo-category-scan.js) for one root category
//  and asks OpenAI to turn that into concrete recommendations:
//    - category/sub-category/facet rename suggestions that match real keywords
//    - facets/sub-categories with meaningful search demand but a thin catalog
//    - plausible sub-categories customers search for that don't exist as a
//      facet anywhere on the page yet
//
//  This is reasoning over data the caller already gathered — no scraping or
//  GSC calls happen here. Env: OPENAI_API_KEY (required), OPENAI_MODEL
//  (optional, defaults to gpt-4o) — both already used by post-creative-strategy.js.
//
//  POST /api/seo-ai-suggestions
//    body: {
//      category: { label, key },
//      totals: { clicks, impressions, ctr, position },
//      topQueries: [{ query, clicks, impressions, ctr, position }],
//      existingSubcategories: [{ label, clicks, impressions, pageCount }],  // from GSC
//      catalog: {
//        totalProducts, facets: [{ label, count }],
//        drilldowns: [{ facetLabel, totalProducts, facets: [{ label, count }] }]
//      }
//    }
// ============================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

const SYSTEM_PROMPT = `You are an e-commerce SEO strategist for Kapruka, a Sri Lankan online retailer. You are
given, for ONE product category on kapruka.com:
  - real Google Search Console data: total clicks/impressions/CTR/position, the top search
    queries actually driving traffic into this category, and how traffic breaks down across
    the category's existing sub-categories/brand filters (as inferred from URLs GSC has data for).
  - a live scrape of the category's real filter sidebar: total product count, and every
    facet (brand, gender, product type, etc.) shown on the site with its own product count,
    including one level of drill-down into a few of the biggest facets.

Your job is to turn this into concrete, evidence-based recommendations in three groups:

1. categoryRenameSuggestions — category, sub-category, or facet LABELS (e.g. the name shown for a
   brand/gender/product-type filter, or the root category name itself) that should be renamed to
   match how customers actually search. Cite the actual top query the current name misses, and
   explain the gap (e.g. a query has high impressions but the facet's current label doesn't use
   that phrasing, or is a brand name instead of the product type customers search for). Only
   propose a rename for a facet/category that is actually in the given data — never invent one.

2. catalogGaps — facets/sub-categories where search demand (GSC impressions, either sitewide
   queries or per-facet click share) looks meaningfully higher than what the low product count
   for that facet can satisfy. Name the specific facet, its current count, and why it's a gap.

3. newSubcategoryIdeas — sub-categories or product types that customers are plausibly searching
   for (visible in the top queries, or standard for this vertical) but that do NOT appear
   anywhere in the scraped facet list at all — a genuine blind spot, not just a thin one.
   For each, say what evidence (a specific query, or an obvious taxonomy gap vs the facets that
   DO exist) supports it, and mark evidenceType as one of: "keyword-demand" (a real GSC query
   suggests this) or "taxonomy-gap" (inferred from what's missing given the category's own facet
   pattern — no direct keyword evidence).

Rules:
  - Base every claim ONLY on the data given. Never invent search volume, product/category names, or
    numbers not present in the input.
  - Every item must be specific to THIS category's actual data — no generic e-commerce advice.
  - If the data doesn't support a group (e.g. no clear catalog gaps), return an empty array for it.
  - Return 3-8 items per group where the data supports it, ranked most-impactful first.

Respond with a single JSON object: { "categoryRenameSuggestions": [...], "catalogGaps": [...], "newSubcategoryIdeas": [...] }
  - categoryRenameSuggestions items: { "currentName": string, "suggestedName": string, "query": string, "reason": string }
  - catalogGaps items: { "facet": string, "currentCount": number|null, "issue": string, "action": string }
  - newSubcategoryIdeas items: { "name": string, "reason": string, "evidenceType": "keyword-demand"|"taxonomy-gap" }`;

export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    if (!env.OPENAI_API_KEY) {
      return json({ error: 'Server is missing the OPENAI_API_KEY secret — ask an admin to add it in Cloudflare Pages settings.' }, 500);
    }

    const payload = await request.json();
    if (!payload || !payload.category) return json({ error: 'Missing category data in request body' }, 400);

    const model = env.OPENAI_MODEL || 'gpt-4o';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4
      })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`OpenAI error: ${body.error?.message || JSON.stringify(body)}`);

    const content = body.choices?.[0]?.message?.content;
    let parsed;
    try { parsed = content ? JSON.parse(content) : {}; }
    catch { throw new Error('OpenAI returned non-JSON content'); }

    return json({
      categoryRenameSuggestions: parsed.categoryRenameSuggestions || [],
      catalogGaps: parsed.catalogGaps || [],
      newSubcategoryIdeas: parsed.newSubcategoryIdeas || []
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
