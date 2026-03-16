#!/usr/bin/env python3
"""
Daraz Supplier Agent — v2
- Category search: main keyword x 3-4 pages, variations x 2 pages
- Output: top sellers ranked by sales within THAT searched category only
- Phone search: Gemini AI (primary) → OpenAI (fallback) → SerpAPI (fallback)
- Deduplicates suppliers across daily runs
"""

import os
import re
import json
import time
import random
import hashlib
import logging
import sys
import io
from datetime import datetime, date
from pathlib import Path

import requests

# ─── CONFIG ───────────────────────────────────────────────────────────────────
OPENAI_API_KEY  = os.getenv("OPENAI_API_KEY", "")
GEMINI_API_KEY  = os.getenv("GEMINI_API_KEY", "")
SERP_API_KEY    = os.getenv("SERP_API_KEY",   "")

TOP_SUPPLIERS       = 5
HISTORY_FILE        = Path(__file__).parent / "seen_suppliers.json"
REPORTS_DIR         = Path(__file__).parent / "supplier_reports"
LOG_FILE            = str(Path(__file__).parent / "supplier_agent.log")
DELAY_BETWEEN       = 1.2

# Pages per keyword type
MAIN_KEYWORD_PAGES      = 4   # main keyword (e.g. "skincare") → 4 pages
VARIATION_KEYWORD_PAGES = 2   # variations (e.g. "skincare+products") → 2 pages

BASE_URL = (
    "https://www.daraz.lk/catalog/"
    "?location=Local"
    "&page={page}"
    "&price=3000-"
    "&q={q}"
    "&rating=4"
    "&sort=popularity"
    "&ajax=true"
)

DAILY_KEYWORDS = [
    "electronics", "smartphones", "laptops", "home+appliances",
    "fashion", "clothing", "shoes", "bags", "beauty", "skincare",
    "furniture", "kitchen", "cookware", "sports", "fitness",
    "baby", "toys", "automotive", "car+accessories", "pet+supplies",
    "health+wellness", "vitamins", "gaming", "cameras", "watches",
    "tools", "garden", "stationery", "groceries", "luggage",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/javascript, */*; q=0.1",
    "Referer": "https://www.daraz.lk/",
}

# ─── LOGGING ──────────────────────────────────────────────────────────────────
REPORTS_DIR.mkdir(exist_ok=True)
try:
    _file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
    _file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    _console_stream = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    _console_handler = logging.StreamHandler(_console_stream)
    _console_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[_file_handler, _console_handler])
except Exception:
    logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# ─── HISTORY ──────────────────────────────────────────────────────────────────
def load_history() -> set:
    if HISTORY_FILE.exists():
        data = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        return set(data.get("seen", []))
    return set()

def save_history(seen: set):
    HISTORY_FILE.write_text(json.dumps({"seen": list(seen)}, indent=2), encoding="utf-8")

def supplier_id(seller_name: str) -> str:
    return hashlib.md5(seller_name.lower().strip().encode()).hexdigest()

# ─── HELPERS ──────────────────────────────────────────────────────────────────
def coalesce(*args):
    for v in args:
        if v is not None and v != "":
            return v
    return ""

def clean_int(raw) -> int:
    if not raw and raw != 0: return 0
    try: return int(re.sub(r"[^\d]", "", str(raw)))
    except: return 0

def clean_price(raw) -> float:
    if not raw and raw != 0: return 0.0
    try: return float(re.sub(r"[^\d.]", "", str(raw)))
    except: return 0.0

def clean_sold(raw) -> int:
    if raw is None: return 0
    s = re.sub(r"<[^>]*>", "", str(raw)).strip()
    m = re.search(r"([\d,\.]+)\s*(k?)", s, re.IGNORECASE)
    if not m: return 0
    num = float(m.group(1).replace(",", ""))
    if m.group(2).lower() == "k": num *= 1000
    return int(num)

def fix_url(href: str) -> str:
    if not href: return ""
    if href.startswith("//"): return "https:" + href
    if href.startswith("/"): return "https://www.daraz.lk" + href
    if not href.startswith("http"): return "https://www.daraz.lk/" + href
    return href

def fetch_json(url: str, retries: int = 3):
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=20)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            log.warning(f"  Attempt {attempt+1} failed: {e}")
            time.sleep(random.uniform(2, 4))
    return None

def extract_phone(text: str) -> str:
    if not text or "NOT_FOUND" in str(text): return ""
    patterns = [
        r'\+94\s?[\d\s\-]{8,11}',
        r'0\d{2}[\s\-]?\d{3}[\s\-]?\d{4}',
        r'94\d{9}',
    ]
    for pattern in patterns:
        match = re.search(pattern, str(text))
        if match:
            return re.sub(r'[^\d+]', '', match.group(0))
    return ""

# ─── SCRAPER ──────────────────────────────────────────────────────────────────
def scrape_keyword(keyword: str, pages: int) -> list[dict]:
    """
    Scrape `pages` pages for `keyword`.
    Returns a list of seller dicts, each with their products from THIS search.
    """
    sellers = {}
    for page in range(1, pages + 1):
        url = BASE_URL.format(q=keyword, page=page)
        log.info(f"  Scraping: {keyword} (page {page}/{pages})")
        data = fetch_json(url)
        if not data:
            continue

        mods  = data.get("mods") or data.get("mainInfo") or {}
        items = mods.get("listItems") or mods.get("items") or []
        if not isinstance(items, list):
            continue

        for x in items:
            location = str(x.get("location") or "").strip().lower()
            if location == "overseas":
                continue

            seller_name = coalesce(x.get("sellerName"), x.get("shopName"), "")
            seller_id_v = coalesce(x.get("sellerId"), x.get("shopId"), "")
            if not seller_name:
                continue

            price     = clean_price(coalesce(x.get("price"), x.get("priceShow"), 0))
            sold      = clean_sold(coalesce(x.get("itemSoldCntShow"), x.get("soldCnt"), 0))
            reviews   = clean_int(coalesce(x.get("review"), x.get("reviewCount"), 0))
            rating    = float(re.sub(r"[^\d.]", "", str(x.get("ratingScore") or 0)) or 0)
            prod_url  = fix_url(coalesce(x.get("productUrl"), x.get("itemUrl"), ""))
            prod_name = coalesce(x.get("name"), x.get("productTitle"), "")
            image     = coalesce(x.get("image"), x.get("mainImage"), "")
            if image and image.startswith("//"): image = "https:" + image

            key = seller_name.lower()
            if key not in sellers:
                sellers[key] = {
                    "seller_name":   seller_name,
                    "seller_id":     str(seller_id_v),
                    "shop_url":      f"https://www.daraz.lk/shop/{seller_id_v}/" if seller_id_v else "",
                    "total_sold":    0,
                    "total_reviews": 0,
                    "avg_rating":    0.0,
                    "products":      [],
                    "categories":    set(),
                }

            sellers[key]["total_sold"]    += sold
            sellers[key]["total_reviews"] += reviews
            sellers[key]["avg_rating"]     = max(sellers[key]["avg_rating"], rating)
            sellers[key]["categories"].add(keyword.replace("+", " ").title())

            # Keep up to 5 top products per seller (sorted by sold count later)
            sellers[key]["products"].append({
                "name":   prod_name,
                "price":  price,
                "url":    prod_url,
                "sold":   sold,
                "image":  image,
                "rating": rating,
            })

        time.sleep(DELAY_BETWEEN)

    # Sort each seller's products by sold count and keep top 5
    for s in sellers.values():
        s["categories"] = sorted(list(s["categories"]))
        s["products"] = sorted(s["products"], key=lambda p: p["sold"], reverse=True)[:5]

    return list(sellers.values())


def get_top_suppliers(keywords: list[str], seen: set, use_dedup: bool,
                      main_keyword: str = "") -> list[dict]:
    """
    Scrape all keywords and return top N suppliers.

    - main_keyword scrapes MAIN_KEYWORD_PAGES pages
    - all other keywords scrape VARIATION_KEYWORD_PAGES pages

    Ranking is based only on sold counts collected within THIS search —
    not global Daraz rankings.
    """
    all_sellers: dict[str, dict] = {}

    for kw in keywords:
        pages = MAIN_KEYWORD_PAGES if kw == main_keyword else VARIATION_KEYWORD_PAGES
        sellers = scrape_keyword(kw, pages=pages)

        for s in sellers:
            key = s["seller_name"].lower()
            sid = supplier_id(s["seller_name"])

            if use_dedup and sid in seen:
                continue

            if key not in all_sellers:
                all_sellers[key] = s
            else:
                # Merge: accumulate sold/reviews, expand categories, merge products
                existing = all_sellers[key]
                existing["categories"] = sorted(list(set(
                    existing["categories"] + s["categories"]
                )))
                existing["total_sold"]    += s["total_sold"]
                existing["total_reviews"] += s["total_reviews"]
                existing["avg_rating"]     = max(existing["avg_rating"], s["avg_rating"])

                # Merge products and re-rank by sold
                combined = existing["products"] + s["products"]
                # Deduplicate by URL
                seen_urls = set()
                merged = []
                for p in combined:
                    if p["url"] not in seen_urls:
                        seen_urls.add(p["url"])
                        merged.append(p)
                existing["products"] = sorted(merged, key=lambda p: p["sold"], reverse=True)[:5]

    # Rank suppliers by their total_sold within this search
    ranked = sorted(all_sellers.values(), key=lambda x: (x["total_sold"], x["total_reviews"]), reverse=True)
    log.info(f"  Ranked {len(ranked)} unique suppliers from this search")
    return ranked[:TOP_SUPPLIERS * 3]  # buffer for contact enrichment


# ─── CONTACT FINDER ───────────────────────────────────────────────────────────

PHONE_PROMPT = (
    'Find the Sri Lankan phone number for a Daraz.lk seller called "{name}". '
    'Search their website, Facebook page, or any Sri Lankan business directory. '
    'Reply ONLY with the phone number like +94771234567 or 0771234567. '
    'If not found reply: NOT_FOUND'
)

PHONE_SYSTEM = (
    "You are a research assistant. Search the web for contact phone numbers "
    "of Sri Lankan businesses. Only return the phone number, nothing else. "
    "If not found, return NOT_FOUND."
)


def find_phone_gemini(seller_name: str) -> str:
    """Use Gemini 2.0 Flash with Google Search grounding to find phone number."""
    if not GEMINI_API_KEY:
        return ""
    log.info(f"  Gemini search: {seller_name}")
    try:
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"gemini-2.0-flash:generateContent?key={GEMINI_API_KEY}"
        )
        payload = {
            "contents": [{
                "parts": [{
                    "text": PHONE_PROMPT.format(name=seller_name)
                }]
            }],
            "tools": [{"google_search": {}}],
            "systemInstruction": {
                "parts": [{"text": PHONE_SYSTEM}]
            },
            "generationConfig": {
                "maxOutputTokens": 60,
                "temperature": 0.1,
            }
        }
        resp = requests.post(url, json=payload, timeout=20)
        resp.raise_for_status()
        data = resp.json()
        # Extract text from response
        text = ""
        for candidate in data.get("candidates", []):
            for part in candidate.get("content", {}).get("parts", []):
                text += part.get("text", "")
        phone = extract_phone(text)
        if phone:
            log.info(f"    Found via Gemini: {phone}")
            return phone
        log.info(f"    Gemini: not found")
        return ""
    except Exception as e:
        log.warning(f"    Gemini failed: {e}")
        return ""


def find_phone_openai(seller_name: str) -> str:
    """Use OpenAI with web_search_preview to find phone number."""
    if not OPENAI_API_KEY:
        return ""
    log.info(f"  OpenAI search: {seller_name}")
    try:
        import openai
        client = openai.OpenAI(api_key=OPENAI_API_KEY)
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": PHONE_SYSTEM},
                {"role": "user",   "content": PHONE_PROMPT.format(name=seller_name)},
            ],
            max_tokens=60,
        )
        result = response.choices[0].message.content.strip()
        phone = extract_phone(result)
        if phone:
            log.info(f"    Found via OpenAI: {phone}")
            return phone
        return ""
    except Exception as e:
        log.warning(f"    OpenAI failed: {e}")
        return ""


def find_phone_serpapi(seller_name: str) -> str:
    """Use SerpAPI Google search to find phone number."""
    if not SERP_API_KEY:
        return ""
    log.info(f"  SerpAPI search: {seller_name}")
    try:
        resp = requests.get(
            "https://serpapi.com/search",
            params={
                "q":       f'"{seller_name}" Sri Lanka contact phone number',
                "api_key": SERP_API_KEY,
                "engine":  "google",
                "gl":      "lk",
                "hl":      "en",
                "num":     5,
            },
            timeout=15,
        )
        data = resp.json()
        text = ""
        if "knowledge_graph" in data:
            text += str(data["knowledge_graph"].get("phone", "")) + " "
        for r in data.get("organic_results", [])[:5]:
            text += r.get("snippet", "") + " " + r.get("title", "") + " "
        phone = extract_phone(text)
        if phone:
            log.info(f"    Found via SerpAPI: {phone}")
            return phone
        return ""
    except Exception as e:
        log.warning(f"    SerpAPI failed: {e}")
        return ""


def find_phone(seller_name: str) -> dict:
    """
    3-tier phone search:
      1. Gemini 2.0 Flash with Google Search grounding (best — uses real-time web)
      2. OpenAI GPT-4o-mini (fallback)
      3. SerpAPI Google search (fallback)
    """
    phone = ""; source = ""

    # Tier 1 — Gemini
    if GEMINI_API_KEY:
        phone = find_phone_gemini(seller_name)
        if phone: source = "Gemini"

    # Tier 2 — OpenAI
    if not phone and OPENAI_API_KEY:
        phone = find_phone_openai(seller_name)
        if phone: source = "OpenAI"

    # Tier 3 — SerpAPI
    if not phone and SERP_API_KEY:
        phone = find_phone_serpapi(seller_name)
        if phone: source = "SerpAPI"

    return {"phone": phone or "Not found", "source": source or "—", "found": bool(phone)}


def enrich_suppliers(suppliers: list[dict]) -> list[dict]:
    enriched = []
    for s in suppliers[:TOP_SUPPLIERS]:
        log.info(f"Finding contact for: {s['seller_name']}")
        contact = find_phone(s["seller_name"])
        s["phone"]          = contact["phone"]
        s["contact_source"] = contact["source"]
        s["contact_found"]  = contact["found"]
        enriched.append(s)
        time.sleep(1.5)
    return enriched


# ─── REPORT ───────────────────────────────────────────────────────────────────
def generate_html_report(suppliers: list[dict], mode: str, category: str = "") -> Path:
    REPORTS_DIR.mkdir(exist_ok=True)
    today = date.today().isoformat()
    ts    = datetime.now().strftime("%H%M%S")

    if mode == "category":
        filename   = f"supplier_report_{category.replace(' ','_')}_{today}_{ts}.html"
        title_mode = f'Category Search: <span>"{category}"</span>'
        subtitle   = f'Top {TOP_SUPPLIERS} suppliers for "{category}" — {datetime.now().strftime("%B %d, %Y  •  %I:%M %p")}'
    else:
        filename   = f"supplier_report_daily_{today}.html"
        title_mode = "Daily <span>Auto</span> Discovery"
        subtitle   = f'Top {TOP_SUPPLIERS} suppliers discovered today — {datetime.now().strftime("%B %d, %Y  •  %I:%M %p")}'

    report_path = REPORTS_DIR / filename

    cards_html = ""
    for i, s in enumerate(suppliers, 1):
        categories_html = "".join(
            f'<span class="cat-tag">{c}</span>' for c in s.get("categories", [])
        )

        products_html = ""
        for p in s.get("products", [])[:5]:
            name_short = p["name"][:65] + ("..." if len(p["name"]) > 65 else "")
            rating_stars = "★" * int(p.get("rating", 0)) + "☆" * (5 - int(p.get("rating", 0)))
            products_html += f"""
            <div class="product-row">
              <a href="{p['url']}" target="_blank">{name_short}</a>
              <span class="prod-rating">{rating_stars}</span>
              <span class="prod-price">Rs. {p['price']:,.0f}</span>
              <span class="prod-sold">{p['sold']:,} sold</span>
            </div>"""

        phone_class = "found" if s.get("contact_found") else "not-found"
        phone_html  = f'<span class="phone {phone_class}">{s["phone"]}</span>'

        source_color = {
            "Gemini":  "#34d399",
            "OpenAI":  "#60a5fa",
            "SerpAPI": "#a78bfa",
        }.get(s.get("contact_source", ""), "#34d399")

        source_html = (
            f'<span class="source-badge" style="background:rgba(52,211,153,0.1);'
            f'color:{source_color};border-color:{source_color}33;">'
            f'{s["contact_source"]}</span>'
            if s.get("contact_found") else ""
        )
        shop_html = (
            f'<a href="{s["shop_url"]}" target="_blank" class="btn-shop">View Shop →</a>'
            if s.get("shop_url") else ""
        )
        mode_badge = (
            f'<span class="mode-tag search-tag">🔍 {category.title()}</span>'
            if mode == "category"
            else f'<span class="mode-tag daily-tag">🔄 Daily Pick</span>'
        )

        cards_html += f"""
        <div class="supplier-card">
          <div class="supplier-header">
            <div class="supplier-rank">#{i}</div>
            <div class="supplier-main">
              <div class="name-row">
                <div class="supplier-name">{s['seller_name']}</div>
                {mode_badge}
              </div>
              <div class="supplier-stats">
                <span>🛒 {s['total_sold']:,} sold in this search</span>
                <span>💬 {s['total_reviews']:,} reviews</span>
                <span>⭐ {s['avg_rating']:.1f} rating</span>
              </div>
              <div class="categories">{categories_html}</div>
            </div>
            <div class="contact-box">
              <div class="contact-label">Phone Number</div>
              {phone_html}
              {source_html}
              {shop_html}
            </div>
          </div>
          <div class="products-section">
            <div class="products-label">Top Selling Products in This Search</div>
            {products_html}
          </div>
        </div>"""

    found_count = sum(1 for s in suppliers if s.get("contact_found"))

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daraz Supplier Report — {today}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: 'Inter', 'Segoe UI', sans-serif; background: #0f0f13; color: #e8e8f0; min-height: 100vh; }}

    header {{
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      padding: 40px 48px; border-bottom: 1px solid rgba(255,255,255,0.08);
      position: relative; overflow: hidden;
    }}
    header::before {{
      content: ''; position: absolute; top: -50%; right: -10%;
      width: 500px; height: 500px;
      background: radial-gradient(circle, rgba(248,86,6,0.15) 0%, transparent 70%);
      pointer-events: none;
    }}
    .header-top {{ display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 16px; }}
    header h1 {{ font-size: 2rem; font-weight: 800; color: #fff; letter-spacing: -0.5px; }}
    header h1 span {{ color: #f85606; }}
    header p {{ color: rgba(255,255,255,0.55); margin-top: 8px; font-size: .88rem; }}
    .mode-pill {{
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 14px; border-radius: 20px; font-size: .78rem;
      font-weight: 600; margin-bottom: 10px;
    }}
    .mode-pill.daily {{ background: rgba(59,130,246,0.2); color: #60a5fa; border: 1px solid rgba(59,130,246,0.3); }}
    .mode-pill.search {{ background: rgba(248,86,6,0.2); color: #f85606; border: 1px solid rgba(248,86,6,0.3); }}
    .header-stats {{ display: flex; gap: 12px; flex-wrap: wrap; }}
    .stat-box {{
      background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px; padding: 14px 20px; text-align: center; min-width: 90px;
    }}
    .stat-box .num {{ font-size: 1.6rem; font-weight: 800; color: #f85606; }}
    .stat-box .lbl {{ font-size: .7rem; color: rgba(255,255,255,0.4); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }}
    .container {{ max-width: 960px; margin: 0 auto; padding: 36px 20px; }}
    .section-title {{
      font-size: .85rem; font-weight: 700; color: rgba(255,255,255,0.35);
      text-transform: uppercase; letter-spacing: 1.5px;
      margin-bottom: 20px; padding-bottom: 10px;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }}
    .supplier-card {{
      background: #1a1a2e; border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px; margin-bottom: 16px; overflow: hidden;
      transition: border-color .2s, box-shadow .2s;
    }}
    .supplier-card:hover {{
      border-color: rgba(248,86,6,0.4);
      box-shadow: 0 0 30px rgba(248,86,6,0.1);
    }}
    .supplier-header {{
      display: flex; gap: 20px; padding: 24px;
      align-items: flex-start; border-bottom: 1px solid rgba(255,255,255,0.06);
    }}
    .supplier-rank {{ font-size: 2rem; font-weight: 900; color: #f85606; min-width: 48px; padding-top: 4px; }}
    .supplier-main {{ flex: 1; }}
    .name-row {{ display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }}
    .supplier-name {{ font-size: 1.15rem; font-weight: 700; color: #fff; }}
    .mode-tag {{ padding: 2px 10px; border-radius: 12px; font-size: .7rem; font-weight: 600; }}
    .daily-tag {{ background: rgba(59,130,246,0.15); color: #60a5fa; border: 1px solid rgba(59,130,246,0.25); }}
    .search-tag {{ background: rgba(248,86,6,0.15); color: #f85606; border: 1px solid rgba(248,86,6,0.25); }}
    .supplier-stats {{
      display: flex; flex-wrap: wrap; gap: 12px;
      font-size: .8rem; color: rgba(255,255,255,0.45); margin-bottom: 12px;
    }}
    .categories {{ display: flex; flex-wrap: wrap; gap: 6px; }}
    .cat-tag {{
      background: rgba(248,86,6,0.12); color: #f85606;
      border: 1px solid rgba(248,86,6,0.25);
      padding: 3px 10px; border-radius: 20px; font-size: .72rem; font-weight: 500;
    }}
    .contact-box {{ text-align: right; min-width: 190px; }}
    .contact-label {{ font-size: .7rem; text-transform: uppercase; letter-spacing: 1px; color: rgba(255,255,255,0.3); margin-bottom: 8px; }}
    .phone {{ display: block; font-size: 1.1rem; font-weight: 700; margin-bottom: 6px; }}
    .phone.found {{ color: #34d399; }}
    .phone.not-found {{ color: rgba(255,255,255,0.2); font-size: .85rem; font-weight: 400; }}
    .source-badge {{
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: .68rem; margin-bottom: 10px; border: 1px solid;
    }}
    .btn-shop {{
      display: inline-block; background: #f85606; color: white;
      padding: 6px 14px; border-radius: 8px; text-decoration: none;
      font-size: .78rem; font-weight: 600; margin-top: 6px;
    }}
    .btn-shop:hover {{ background: #d94800; }}
    .products-section {{ padding: 16px 24px; background: rgba(0,0,0,0.2); }}
    .products-label {{ font-size: .7rem; text-transform: uppercase; letter-spacing: 1px; color: rgba(255,255,255,0.25); margin-bottom: 10px; }}
    .product-row {{
      display: flex; align-items: center; gap: 10px; padding: 8px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04); font-size: .82rem;
    }}
    .product-row:last-child {{ border-bottom: none; }}
    .product-row a {{ flex: 1; color: rgba(255,255,255,0.6); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
    .product-row a:hover {{ color: #f85606; }}
    .prod-rating {{ color: #f5a623; font-size: .72rem; white-space: nowrap; flex-shrink: 0; }}
    .prod-price {{ color: #f85606; font-weight: 600; white-space: nowrap; flex-shrink: 0; }}
    .prod-sold {{ color: rgba(255,255,255,0.3); font-size: .74rem; white-space: nowrap; flex-shrink: 0; }}
    footer {{ text-align: center; color: rgba(255,255,255,0.2); font-size: .73rem; padding: 32px; border-top: 1px solid rgba(255,255,255,0.06); }}
  </style>
</head>
<body>
  <header>
    <div class="header-top">
      <div>
        <div class="mode-pill {'search' if mode == 'category' else 'daily'}">
          {'🔍 Category Search Mode' if mode == 'category' else '🔄 Daily Auto Mode'}
        </div>
        <h1>Daraz {title_mode}</h1>
        <p>{subtitle}</p>
      </div>
      <div class="header-stats">
        <div class="stat-box"><div class="num">{len(suppliers)}</div><div class="lbl">Suppliers</div></div>
        <div class="stat-box"><div class="num">{found_count}</div><div class="lbl">Contacts</div></div>
        <div class="stat-box"><div class="num">{len(suppliers)-found_count}</div><div class="lbl">Not Found</div></div>
      </div>
    </div>
  </header>
  <div class="container">
    <div class="section-title">{'Results for "' + category + '" — ranked by sales within this search' if mode == 'category' else "Today's Top Suppliers"}</div>
    {cards_html}
  </div>
  <footer>
    Daraz Supplier Agent v2 &nbsp;•&nbsp; {'Category: ' + category if mode == 'category' else 'Daily Auto Mode'} &nbsp;•&nbsp;
    Contact search: Gemini + OpenAI + SerpAPI &nbsp;•&nbsp; {today}
  </footer>
</body>
</html>"""

    report_path.write_text(html, encoding="utf-8")
    log.info(f"Report saved: {report_path}")
    return report_path


# ─── MODE SELECTOR ────────────────────────────────────────────────────────────
def ask_mode() -> tuple[str, str]:
    env_category = os.getenv("SUPPLIER_CATEGORY", "").strip()
    if env_category:
        return "category", env_category.lower()

    print("\n" + "═" * 55)
    print("  DARAZ SUPPLIER AGENT v2")
    print("═" * 55)
    print("  Press ENTER  → Daily auto discovery")
    print("  Type a word  → Search suppliers for that category")
    print("═" * 55)
    try:
        import sys as _sys
        if not _sys.stdin.isatty():
            user_input = ""
        else:
            user_input = input("\n  Category (or ENTER for daily): ").strip()
    except (EOFError, KeyboardInterrupt):
        user_input = ""

    return ("category", user_input.lower()) if user_input else ("daily", "")


# ─── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    log.info("=" * 60)
    mode, category = ask_mode()

    if mode == "category":
        # Main keyword gets MAIN_KEYWORD_PAGES, variations get VARIATION_KEYWORD_PAGES
        main_kw  = category.replace(" ", "+")
        keywords = [main_kw]
        if " " not in category:
            keywords += [
                main_kw + "+accessories",
                main_kw + "+products",
                "best+" + main_kw,
            ]
        log.info(f"MODE: Category Search — '{category}'")
        log.info(f"Keywords: {main_kw} x{MAIN_KEYWORD_PAGES} pages + {len(keywords)-1} variations x{VARIATION_KEYWORD_PAGES} pages")
        raw = get_top_suppliers(keywords, seen=set(), use_dedup=False, main_keyword=main_kw)

    else:
        log.info("MODE: Daily Auto Discovery")
        seen = load_history()
        log.info(f"History: {len(seen)} suppliers already seen")
        day_offset = date.today().timetuple().tm_yday
        random.seed(day_offset)
        keywords_today = random.sample(DAILY_KEYWORDS, min(8, len(DAILY_KEYWORDS)))
        log.info(f"Today's keywords: {', '.join(keywords_today)}")
        # In daily mode all keywords are "equal" — use variation page count
        raw = get_top_suppliers(keywords_today, seen=seen, use_dedup=True, main_keyword="")

    log.info(f"Found {len(raw)} candidate suppliers")

    if not raw:
        log.warning("No suppliers found.")
        print("\n  No suppliers found. Try a different category.")
        return None

    log.info("Finding contact phone numbers (Gemini → OpenAI → SerpAPI)...")
    suppliers = enrich_suppliers(raw)

    log.info("Generating HTML report...")
    report_path = generate_html_report(suppliers, mode, category)

    if mode == "daily":
        seen = load_history()
        new_seen = seen | {supplier_id(s["seller_name"]) for s in suppliers}
        save_history(new_seen)
        log.info(f"History updated: {len(new_seen)} total seen suppliers")

    print(f"\n  Report saved: {report_path.resolve()}")
    log.info(f"DONE! Report: {report_path.resolve()}")

    try:
        import platform
        if platform.system() == "Windows":
            os.startfile(str(report_path.resolve()))
    except Exception:
        pass

    return report_path


if __name__ == "__main__":
    main()
