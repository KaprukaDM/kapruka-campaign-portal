import os
import base64
import json
import httpx
from openai import OpenAI

# ── clients ──────────────────────────────────────────────────────────────────
openai_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
SERPAPI_KEY   = os.environ["SERPAPI_KEY"]

PLATFORMS = [
    ("TikTok",    "site:tiktok.com"),
    ("Pinterest", "site:pinterest.com"),
    ("Amazon",    "site:amazon.com"),
    ("Alibaba",   "site:alibaba.com"),
    ("Temu",      "site:temu.com"),
]

# ── step 1 : vision ───────────────────────────────────────────────────────────
def analyze_image(image_path: str, product_name: str) -> dict:
    with open(image_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode()

    ext = image_path.rsplit(".", 1)[-1].lower()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg",
            "png": "image/png", "webp": "image/webp"}.get(ext, "image/jpeg")

    prompt = f"""You are a product identification expert.
Product name provided by user: "{product_name}"

Analyze the image and return ONLY valid JSON (no markdown, no explanation):
{{
  "brand": "...",
  "model": "...",
  "category": "...",
  "color": "...",
  "key_features": ["...", "..."],
  "search_keywords": ["...", "..."]
}}

If brand or model are unknown, use empty string "" not null.
search_keywords should be 3-5 concise terms that best identify this product for video search."""

    response = openai_client.chat.completions.create(
        model="gpt-4o",
        max_tokens=400,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{img_b64}"}},
                {"type": "text", "text": prompt}
            ]
        }]
    )

    raw = response.choices[0].message.content.strip()
    raw = raw.replace("```json", "").replace("```", "").strip()
    data = json.loads(raw)

    # ensure no None values for string fields
    for key in ("brand", "model", "category", "color"):
        if not data.get(key):
            data[key] = ""
    if not isinstance(data.get("search_keywords"), list):
        data["search_keywords"] = []
    if not isinstance(data.get("key_features"), list):
        data["key_features"] = []

    return data


# ── step 2 : build queries ────────────────────────────────────────────────────
def build_queries(product_name: str, attrs: dict) -> list[str]:
    brand    = attrs.get("brand") or ""
    model    = attrs.get("model") or ""
    keywords = attrs.get("search_keywords") or []

    base = f"{brand} {model}".strip() or product_name

    queries = [
        product_name,
        base,
        f"{base} review",
        f"{base} unboxing",
    ]
    if keywords:
        queries.append(" ".join(keywords[:3]))

    seen, unique = set(), []
    for q in queries:
        q = q.strip()
        if q and q not in seen:
            seen.add(q)
            unique.append(q)
    return unique


# ── step 3 : search via SerpAPI ───────────────────────────────────────────────
def serpapi_search(query: str, site_filter: str) -> list[dict]:
    full_query = f"{site_filter} {query} video"
    params = {
        "engine":  "google",
        "q":       full_query,
        "num":     5,
        "api_key": SERPAPI_KEY,
    }
    try:
        r = httpx.get("https://serpapi.com/search", params=params, timeout=15)
        r.raise_for_status()
        data = r.json()
        return data.get("organic_results", [])
    except Exception as e:
        print(f"  [warn] SerpAPI error for '{full_query}': {e}")
        return []


# ── step 4 : collect + deduplicate ────────────────────────────────────────────
def search_all_platforms(product_name: str, attrs: dict) -> list[dict]:
    queries   = build_queries(product_name, attrs)
    seen_urls = set()
    results   = []

    for platform, site_filter in PLATFORMS:
        print(f"\n🔍 Searching {platform}...")
        for query in queries[:3]:
            items = serpapi_search(query, site_filter)
            for item in items:
                url = item.get("link", "")
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    results.append({
                        "platform":  platform,
                        "title":     item.get("title", ""),
                        "url":       url,
                        "snippet":   item.get("snippet", ""),
                        "thumbnail": (item.get("thumbnail") or
                                      item.get("rich_snippet", {}).get("top", {}).get("img", "")),
                    })
            if items:
                break

    return results


# ── step 5 : rank ─────────────────────────────────────────────────────────────
def rank_results(results: list[dict], product_name: str, attrs: dict) -> list[dict]:
    keywords  = [product_name.lower()]
    keywords += [(attrs.get("brand") or "").lower()]
    keywords += [(attrs.get("model") or "").lower()]
    keywords += [k.lower() for k in (attrs.get("search_keywords") or [])]
    keywords  = [k for k in keywords if k]

    def score(r):
        text  = ((r.get("title") or "") + " " + (r.get("snippet") or "")).lower()
        hits  = sum(1 for k in keywords if k in text)
        bonus = 2 if any(w in text for w in ["review", "unboxing", "demo", "video"]) else 0
        return hits + bonus

    return sorted(results, key=score, reverse=True)


# ── main entry ────────────────────────────────────────────────────────────────
def find_product_videos(image_path: str, product_name: str) -> dict:
    print(f"\n🖼  Analyzing image with GPT-4o Vision...")
    attrs = analyze_image(image_path, product_name)
    print(f"   Brand   : {attrs.get('brand')}")
    print(f"   Model   : {attrs.get('model')}")
    print(f"   Category: {attrs.get('category')}")
    print(f"   Keywords: {attrs.get('search_keywords')}")

    raw    = search_all_platforms(product_name, attrs)
    ranked = rank_results(raw, product_name, attrs)

    return {
        "product_name": product_name,
        "attributes":   attrs,
        "total_found":  len(ranked),
        "results":      ranked,
    }


# ── CLI ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python searcher.py <image_path> '<product name>'")
        sys.exit(1)

    output = find_product_videos(sys.argv[1], sys.argv[2])

    print(f"\n✅ Found {output['total_found']} results\n")
    for i, r in enumerate(output["results"][:10], 1):
        print(f"{i:2}. [{r['platform']}] {r['title']}")
        print(f"     {r['url']}\n")
