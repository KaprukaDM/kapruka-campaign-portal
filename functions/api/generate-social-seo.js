// functions/api/generate-social-seo.js
// ============================================================================
//  SEARCH-RANKED POST — social search copy for cake / flowers / gift posts
//
//  Triggered by the "🔎 Search-ranked post" button on the Posting Calendar.
//  Two stages:
//    1. Vision: look at the post's image and classify it as cake, flowers,
//       gift, or other (plus product, occasion, who it's for, visible price).
//    2. Copy: build 3 post packages around ONE exact phrase each from the
//       social search keyword bank (functions/_lib/social-search-terms.js),
//       placed in the four spots the report calls for:
//         spoken hook (first 3s) · on-screen text · caption line 1 · hashtags
//
//  The server then checks the model's output against the bank: the phrase
//  must be a real search phrase, caption line 1 must contain it word for
//  word, hashtags are limited to real tags (one 10K+ and the rest 500–5K),
//  and price words like "cheap" are rejected (brand rule: show the LKR
//  price, never call Kapruka cheap).
//
//  Env: OPENAI_API_KEY (required), OPENAI_MODEL (optional, default gpt-4o).
// ============================================================================

import { SOCIAL_TERMS, SOCIAL_TERMS_COLLECTED, LARGE_TAG_MIN, isSupportedCategory } from '../_lib/social-search-terms.js';

const BANNED_PRICE_WORDS = /\bcheap(est|er)?\b|\blowest price\b|\bbudget\b|\bbargain\b|අඩු/i;

const VISION_PROMPT = `You are classifying one social media post image for Kapruka (a Sri Lankan online gifting and shopping platform).

Return a JSON object with exactly these string fields:
- category: one of "cake", "flowers", "gift", "other". Use "cake" for any cake/cupcake/dessert cake, "flowers" for bouquets, flower arrangements, flower plants or vases with flowers, "gift" for gift boxes, hampers, personalised/customised gifts, teddies, chocolates sold as a gift, or a combo where the gift (not the cake/flowers) is the hero. Anything else is "other".
- product: the specific product shown (concrete, e.g. "chocolate bento cake with 'Happy Birthday' piping").
- occasion: occasion the image suggests (birthday, anniversary, Valentine's, Christmas, Avurudu, none, ...).
- recipient: who it seems meant for if the image or text shows it (boyfriend, girlfriend, mum, kids, boys, girls, colleague, unknown).
- visible_price: any LKR price visible in the image, else "".
- visible_text: any text visible on the image, else "".

If the image does not load or is unclear, set category to "other" and say so in product.`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function extractDriveFileId(url) {
  const m = (url || '').match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || (url || '').match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Same resolution as generate-headlines.js: first item of a comma list,
// Drive links turned into a directly loadable thumbnail.
function toDirectImageUrl(mediaUrl) {
  if (!mediaUrl) return null;
  const first = mediaUrl.split(',')[0].trim();
  if (!first) return null;
  if (!/drive\.google\.com/.test(first)) return first;
  const id = extractDriveFileId(first);
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1000` : null;
}

async function openaiJson(env, messages, temperature) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-4o',
      messages,
      response_format: { type: 'json_object' },
      temperature,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || JSON.stringify(body));
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty response from the model.');
  return JSON.parse(raw);
}

async function classifyImage(env, imageUrl, hints) {
  const content = [{ type: 'text', text: VISION_PROMPT }];
  if (hints) content.push({ type: 'text', text: `Extra context from the team (may help classify): ${hints}` });
  content.push({ type: 'image_url', image_url: { url: imageUrl } });
  return openaiJson(env, [{ role: 'user', content }], 0.2);
}

function formatBank(cat) {
  const b = SOCIAL_TERMS[cat];
  const fmt = n => (n >= 1000 ? `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}K` : String(n));
  return [
    `TikTok search phrases (ranked, #1 = suggested most often):`,
    ...b.tiktok.map((p, i) => `  ${i + 1}. ${p}`),
    `Instagram hashtags (post count):`,
    ...b.instagram.map(h => `  ${h.tag} (${fmt(h.posts)}${h.posts < LARGE_TAG_MIN ? '+' : ''})`),
    `Facebook search suggestions: ${b.facebook.join(' · ')}`,
  ].join('\n');
}

async function writePackages(env, cat, analysis, existingText, productName) {
  const system = `You write social posts for Kapruka (Sri Lankan online gifting/shopping) that RANK in TikTok, Instagram Reels and Facebook search in Sri Lanka.

Category: ${SOCIAL_TERMS[cat].label}
Keyword bank (real searches typed in Sri Lanka, collected ${SOCIAL_TERMS_COLLECTED}):
${formatBank(cat)}

Rules:
1. Each package is built around ONE exact TikTok phrase copied character-for-character from the bank above (lowercase is fine). Prefer higher-ranked phrases, but pick the one that truly fits the product, occasion and recipient (e.g. a birthday cake → a "birthday cake ..." phrase; a gift for a boyfriend → "gifts for your boyfriend in colombo").
2. Put that exact phrase in: spoken_hook (said in the first 3 seconds), on_screen_text (opening frame, max ~8 words), and caption_line1 (must contain the phrase word for word, ideally leading with it).
3. Use the four themes that win search: surprise delivery; place first ("colombo cake delivery" beats "cake colombo"); who it is for (boyfriend, girlfriend, boys, girls, family); and real price. The 3 packages must use 3 DIFFERENT phrases and lean on different themes.
4. Never call Kapruka or the product cheap, low-price, budget or a bargain, in English or Sinhala (no "අඩු මිලට"). If a real LKR price is known, state it plainly (e.g. "Rs. 4,950").
5. caption_body: 1-2 short warm lines after line 1, naming the actual product, ending with a clear CTA to order on Kapruka. Brand voice: warm, short, Sri Lankan-first, one or two emojis max.
6. hashtags: 3 to 5, ONLY from the Instagram list above: one large tag (10K+ posts, or the biggest available) and the rest specific (500–5K) that match the product.
7. facebook_line: optional one-liner that echoes a Facebook suggestion naturally, or "".

Respond as JSON: {"packages":[{"phrase":"...","theme":"...","spoken_hook":"...","on_screen_text":"...","caption_line1":"...","caption_body":"...","hashtags":["#..."],"facebook_line":"..."}]} with exactly 3 packages.`;

  const user = {
    image_analysis: analysis,
    product_name_from_team: productName || null,
    existing_caption: existingText || null,
  };
  const out = await openaiJson(env, [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(user) },
  ], 0.7);
  return Array.isArray(out.packages) ? out.packages : [];
}

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Keep only real bank tags; enforce one large + specific ones, 3–5 total.
function fixHashtags(cat, proposed) {
  const bank = SOCIAL_TERMS[cat].instagram;
  const byTag = new Map(bank.map(h => [h.tag, h]));
  const picked = [];
  for (const t of proposed || []) {
    const tag = '#' + norm(t).replace(/^#+/, '').replace(/\s+/g, '');
    if (byTag.has(tag) && !picked.includes(tag)) picked.push(tag);
  }
  const maxPosts = Math.max(...bank.map(h => h.posts));
  const largeCut = maxPosts >= LARGE_TAG_MIN ? LARGE_TAG_MIN : maxPosts;
  const isLarge = t => byTag.get(t).posts >= largeCut;

  let large = picked.find(isLarge) || bank.find(h => h.posts >= largeCut).tag;
  let specific = picked.filter(t => !isLarge(t));
  for (const h of bank) {
    if (specific.length >= 2) break;
    if (h.posts < largeCut && !specific.includes(h.tag)) specific.push(h.tag);
  }
  return [large, ...specific.filter(t => t !== large)].slice(0, 5);
}

function validatePackages(cat, packages) {
  const phrases = new Map(SOCIAL_TERMS[cat].tiktok.map((p, i) => [norm(p), { phrase: p, rank: i + 1 }]));
  const seen = new Set();
  const kept = [];
  const rejected = [];

  for (const p of packages) {
    const key = norm(p.phrase);
    const hit = phrases.get(key);
    const allText = [p.spoken_hook, p.on_screen_text, p.caption_line1, p.caption_body, p.facebook_line].join(' ');
    if (!hit) { rejected.push(`"${p.phrase}" is not a phrase from the search list`); continue; }
    if (seen.has(key)) { rejected.push(`duplicate phrase "${p.phrase}"`); continue; }
    if (!norm(p.caption_line1).includes(key)) { rejected.push(`caption line 1 did not contain "${hit.phrase}"`); continue; }
    if (BANNED_PRICE_WORDS.test(allText)) { rejected.push(`package for "${hit.phrase}" used a banned price word`); continue; }
    seen.add(key);
    kept.push({
      phrase: hit.phrase,
      rank: hit.rank,
      theme: String(p.theme || ''),
      spoken_hook: String(p.spoken_hook || ''),
      on_screen_text: String(p.on_screen_text || ''),
      caption_line1: String(p.caption_line1 || '').trim(),
      caption_body: String(p.caption_body || '').trim(),
      hashtags: fixHashtags(cat, p.hashtags),
      facebook_line: String(p.facebook_line || ''),
      checks: {
        spoken: norm(p.spoken_hook).includes(key),
        on_screen: norm(p.on_screen_text).includes(key),
        caption: true,
      },
    });
  }
  return { kept, rejected };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    if (!env.OPENAI_API_KEY) return json({ error: 'Server is missing the OPENAI_API_KEY secret.' }, 500);

    let body = {};
    try { body = await request.json(); } catch (e) { /* checked below */ }
    const { mediaUrl, existingText, productName } = body;
    if (!mediaUrl) return json({ error: 'mediaUrl is required.' }, 400);

    const imageUrl = toDirectImageUrl(mediaUrl);
    if (!imageUrl) return json({ error: 'Could not resolve a usable image URL from this post\'s media.' }, 400);

    const hints = [productName, existingText].filter(Boolean).join(' | ').slice(0, 500);
    const analysis = await classifyImage(env, imageUrl, hints);
    const category = norm(analysis.category);

    if (!isSupportedCategory(category)) {
      return json({ ok: true, category: 'other', analysis, packages: [],
        message: 'This post doesn\'t look like a cake, flowers or gift post, so there are no search terms for it. Use ✍️ Copywriter instead.' });
    }

    // One retry if the model's packages all fail validation.
    let result = { kept: [], rejected: [] };
    for (let attempt = 0; attempt < 2 && result.kept.length === 0; attempt++) {
      const packages = await writePackages(env, category, analysis, existingText, productName);
      result = validatePackages(category, packages);
    }
    if (!result.kept.length) {
      return json({ error: `Could not produce copy that matches the search terms (${result.rejected.join('; ')}). Try again.` }, 502);
    }

    return json({
      ok: true,
      category,
      analysis,
      collected: SOCIAL_TERMS_COLLECTED,
      packages: result.kept,
      rejected: result.rejected,
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
