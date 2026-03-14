import os
import base64
import json
import httpx
from openai import OpenAI

# ── clients ──────────────────────────────────────────────────────────────────
openai_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
SERPAPI_KEY   = os.environ["SERPAPI_KEY"]

# Platform configs: (name, site filter, extra query terms, url_must_contain)
PLATFORMS = [
    {
        "name":         "TikTok",
        "site":         "site:tiktok.com",
        "extra":        "video",
        "url_contains": "/video/",
    },
    {
        "name":         "Pinterest",
        "site":         "site:pinterest.com",
        "extra":        "video",
        "url_contains": "/pin/",   # Pinterest video pins are at /pin/ URLs
    },
    {
        "name":         "Amazon",
        "site":         "site:amazon.com",
        "extra":        "product video review",
        "url_contains": "/dp/",    # Amazon product pages (contain embedded videos)
    },
    {
        "name":         "Alibaba",
        "site":         "site:alibaba.com",
        "extra":        "product video",
        "url_contains": "/product-detail/",
    },
    {
        "name":         "Temu",
        "site":         "site:temu.com",
        "extra":        "video",
        "url_contains": "/goods",
    },
]


# ── step 1 : vision ───────────────────────────────────────────────────────────
def analyze_image(image_path: str, product_name: str) -> dict:
    with open(image_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode()

    ext  = image_path.rsplit(".", 1)[-1].lower()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg",
            "png": "image/png",  "webp": "image/webp"}.get(ext, "image/jpeg")

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

Rules:
- If brand or model are unknown use empty string "" not null
- search_keywords: 3-5 short terms that uniquely identify this product (include brand+model if known)
- key_features: visible physical features useful for search (color, shape, material, use case)"""

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

    raw  = response.choices[0].message.content.strip()
    raw  = raw.replace("```json", "").replace("```", "").strip()
    data = json.loads(raw)

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

    candidates = [
        product_name,
        base,
        f"{base} review",
        f"{base} unboxing",
        " ".join(keywords[:3]) if keywords else "",
    ]

    seen, unique = set(), []
    for q in candidates:
        q = q.strip()
        if q and q not in seen:
            seen.add(q)
            unique.append(q)
    return unique


# ── step 3 : SerpAPI call ─────────────────────────────────────────────────────
def serpapi_search(query: str, site: str, extra: str) -> list[dict]:
    full_query = f"{site} {query} {extra}".strip()
    params = {
        "engine":  "google",
        "q":       full_query,
        "num":     10,
        "api_key": SERPAPI_KEY,
    }
    try:
        r = httpx.get("https://serpapi.com/search", params=params, timeout=15)
        r.raise_for_status()
        return r.json().get("organic_results", [])
    except Exception as e:
        print(f"  [warn] SerpAPI error for '{full_query}': {e}")
        return []


# ── step 4 : collect, filter, deduplicate ────────────────────────────────────
def search_all_platforms(product_name: str, attrs: dict) -> list[dict]:
    queries   = build_queries(product_name, attrs)
    seen_urls = set()
    results   = []

    for p in PLATFORMS:
        print(f"\n🔍 Searching {p['name']}...")
        platform_results = []

        for query in queries[:3]:
            items = serpapi_search(query, p["site"], p["extra"])

            for item in items:
                url = item.get("link", "")
                if not url or url in seen_urls:
                    continue

                # filter: URL must contain the expected path pattern
                if p["url_contains"] and p["url_contains"] not in url:
                    continue

                seen_urls.add(url)
                platform_results.append({
                    "platform":  p["name"],
                    "title":     item.get("title", ""),
                    "url":       url,
                    "snippet":   item.get("snippet", ""),
                    "thumbnail": (item.get("thumbnail") or
                                  item.get("rich_snippet", {})
                                      .get("top", {}).get("img", "")),
                })

            if platform_results:
                break  # found good results, stop trying more queries

        results.extend(platform_results)
        print(f"   → {len(platform_results)} results")

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


# ── main ──────────────────────────────────────────────────────────────────────
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
    for i, r in enumerate(output["results"][:15], 1):
        print(f"{i:2}. [{r['platform']}] {r['title']}")
        print(f"     {r['url']}\n")
