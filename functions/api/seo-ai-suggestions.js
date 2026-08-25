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
//  This is reasoning over data the caller already gathered — no scraping,
//  vision, or GSC calls happen here, so it defaults to a cheaper text-only
//  model rather than the gpt-4o default used by the vision-dependent
//  features (post-creative-strategy.js, generate-headlines.js).
//  Env: OPENAI_API_KEY (required), OPENAI_MODEL (optional, overrides the default below).
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

3. newSubcategoryIdeas — sub-categories or product types that do NOT appear anywhere in the
   scraped facet list at all (a genuine blind spot, not just a thin one). Draw on TWO sources
   for these, and use both — don't limit yourself to only what's directly visible in the data:
     a) the top search queries and general query patterns given to you, and
     b) your own general knowledge of what sub-categories/product types a category like this
        normally carries in retail/e-commerce (e.g. for a jewellery category, things like
        anklets, nose pins, cufflinks, or gemstone types are standard even if no query happens
        to be in the sample) — reason like an experienced merchandiser for this vertical, not
        just a data-matching tool.
   For each idea, mark evidenceType as one of: "keyword-demand" (a real GSC query in the given
   data suggests this), "taxonomy-gap" (inferred from a pattern in the category's OWN existing
   facets — e.g. it has facets for 4 jewellery types but not a 5th common one), or
   "industry-knowledge" (general retail/vertical knowledge, not tied to a specific query or the
   facet pattern — say plainly that this is general knowledge, not something derived from the data).

Rules:
  - For categoryRenameSuggestions and catalogGaps: base every claim ONLY on the data given.
    Never invent search volume, product/category names, or numbers not present in the input.
  - For newSubcategoryIdeas: queries and facet counts you cite must be real (from the data), but
    the idea itself may also come from your own general knowledge as described above — just
    label it correctly with evidenceType so the reader knows which is which.
  - Every item must be specific to THIS category — no generic e-commerce advice unrelated to it.
  - If the data doesn't support a group (e.g. no clear catalog gaps), return an empty array for it.
  - Return 3-8 items per group where the data supports it, ranked most-impactful first.

Respond with a single JSON object: { "categoryRenameSuggestions": [...], "catalogGaps": [...], "newSubcategoryIdeas": [...] }
  - categoryRenameSuggestions items: { "currentName": string, "suggestedName": string, "query": string, "reason": string }
  - catalogGaps items: { "facet": string, "currentCount": number|null, "issue": string, "action": string }
  - newSubcategoryIdeas items: { "name": string, "reason": string, "evidenceType": "keyword-demand"|"taxonomy-gap"|"industry-knowledge" }`;

export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    if (!env.OPENAI_API_KEY) {
      return json({ error: 'Server is missing the OPENAI_API_KEY secret — ask an admin to add it in Cloudflare Pages settings.' }, 500);
    }

    const payload = await request.json();
    if (!payload || !payload.category) return json({ error: 'Missing category data in request body' }, 400);

    const model = env.OPENAI_MODEL || 'gpt-5.6-luna';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) }
        ],
        response_format: { type: 'json_object' }
        // No `temperature` override — gpt-5.6-luna (and other reasoning-tier
        // models) only support the default value of 1 and error on anything else.
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
