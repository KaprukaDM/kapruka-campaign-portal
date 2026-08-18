// functions/api/generate-headlines.js
// ============================================================================
//  COPYWRITER — AI headline generator for the Posting Calendar
//
//  Triggered by the "✍️ Copywriter" button on a scheduled item. Two-stage
//  pipeline, in this order on purpose (the button scans the image BEFORE
//  writing anything):
//    1. Vision analysis of the post's actual product image: what the
//       product is, its target market (Gen Z vs. non-Gen Z), the problem
//       it solves, and the desire it fulfills.
//    2. Headline generation — 4-5 options, each with a keyword — grounded
//       in COPYWRITER.md (this repo's house copywriting guidelines) and
//       stage 1's findings. The picked headline gets written back to the
//       sheet's Primary Text column via the existing PATCH endpoint on
//       /api/posting-calendar (see its primaryText handling).
//
//  Runs server-side as a Cloudflare Pages Function so the OpenAI key never
//  touches the browser. Sits behind functions/_middleware.js's Basic Auth
//  like the rest of /api/*.
//
//  Env vars required:
//    OPENAI_API_KEY — same secret already used by post-creative-strategy.js
//  Optional:
//    OPENAI_MODEL — defaults to 'gpt-4o' (needs vision support for stage 1)
// ============================================================================

const COPYWRITER_MD_URL = 'https://raw.githubusercontent.com/KaprukaDM/kapruka-campaign-portal/main/COPYWRITER.md';

// Used only if the GitHub fetch fails (rate limit, network blip, file
// moved) — keeps the feature working with the core rules instead of
// failing outright.
const COPYWRITER_FALLBACK = `Kapruka copywriter guidelines (fallback — could not fetch the full COPYWRITER.md from GitHub):
- Warm, short (under ~12 words), one concrete anchor (product/category/benefit) per headline — never mood alone.
- Match register to target market: Gen Z gets playful/POV/meme-aware hooks; non-Gen Z gets direct benefit + trust/occasion framing.
- Every headline should implicitly answer both the problem it removes and the desire it satisfies.
- Include one natural keyword (product/category/occasion) per headline, never hashtag-stuffed.`;

const VISION_ANALYSIS_PROMPT = `You are analyzing a single product image for Kapruka (a Sri Lankan e-commerce/gifting platform) to prepare for headline copywriting. Look carefully at the image and determine:

- product: the specific product shown (be concrete — name what it actually is, not "item" or "product")
- target_market: one of "Gen Z", "non-Gen Z", or "both" — based on who would actually buy/care about this specific product, not the price alone
- target_market_reasoning: one sentence on why
- problem_solved: the concrete problem/friction this product removes for a buyer
- desire_fulfilled: the emotional payoff/desire this product satisfies (distinct from the problem above)
- visual_notes: what's actually in the image (composition, setting, any visible text)

If the image fails to load or its content is unclear, say so plainly in "product" rather than guessing.

Respond as a single JSON object with exactly those six string fields.`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function extractDriveFileId(url) {
  const m = (url || '').match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || (url || '').match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Sheet's Media URL column can hold a Drive "view" page link (not directly
// image-loadable) or a comma-separated multi-image list (Studio folder
// submissions) — take the first item and resolve to a direct-loadable URL,
// same thumbnail pattern already used elsewhere in this app's own <img>
// tags (posting-calendar.html).
function toDirectImageUrl(mediaUrl) {
  if (!mediaUrl) return null;
  const first = mediaUrl.split(',')[0].trim();
  if (!first) return null;
  if (!/drive\.google\.com/.test(first)) return first;
  const id = extractDriveFileId(first);
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1000` : null;
}

async function fetchCopywriterGuidelines() {
  try {
    const res = await fetch(COPYWRITER_MD_URL);
    if (!res.ok) return COPYWRITER_FALLBACK;
    const text = await res.text();
    return text && text.length > 200 ? text : COPYWRITER_FALLBACK;
  } catch (e) {
    return COPYWRITER_FALLBACK;
  }
}

async function analyzeProductImage(env, imageUrl) {
  const model = env.OPENAI_MODEL || 'gpt-4o';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_ANALYSIS_PROMPT },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || JSON.stringify(body));
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) throw new Error('No image analysis returned.');
  return JSON.parse(raw);
}

async function generateHeadlines(env, analysis, guidelines, existingText) {
  const model = env.OPENAI_MODEL || 'gpt-4o';
  const systemPrompt = `You are Kapruka's headline copywriter. Follow these house guidelines exactly:

${guidelines}

Generate 4 to 5 distinct headline options for the product/analysis you're given. Each headline must pass the structure checklist in section 7 of the guidelines above. Vary the formula used across the options (don't submit multiple variations of the same formula) — draw from the different formulas in section 2, matched to the identified target_market per section 4.

Respond as a single JSON object: {"headlines": [{"headline": "...", "keyword": "...", "formula": "which section-2 formula this uses"}, ...]}, with 4 to 5 items in the array.`;

  const userPayload = {
    product_analysis: analysis,
    existing_caption_for_context: existingText || null,
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || JSON.stringify(body));
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) throw new Error('No headlines returned.');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.headlines) || !parsed.headlines.length) throw new Error('Malformed headline response.');
  return parsed.headlines;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    if (!env.OPENAI_API_KEY) return json({ error: 'Server is missing the OPENAI_API_KEY secret.' }, 500);

    let body = {};
    try { body = await request.json(); } catch (e) { /* handled by the mediaUrl check below */ }
    const { mediaUrl, existingText } = body;
    if (!mediaUrl) return json({ error: 'mediaUrl is required.' }, 400);

    const imageUrl = toDirectImageUrl(mediaUrl);
    if (!imageUrl) return json({ error: 'Could not resolve a usable image URL from this post\'s media.' }, 400);

    const [analysis, guidelines] = await Promise.all([
      analyzeProductImage(env, imageUrl),
      fetchCopywriterGuidelines(),
    ]);

    const headlines = await generateHeadlines(env, analysis, guidelines, existingText);

    return json({ ok: true, analysis, headlines });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
