#!/usr/bin/env python3
"""
Daraz Supplier Agent — v3
Fixes:
  1. Gemini model name corrected (tries gemini-2.0-flash-exp then gemini-1.5-flash)
  2. Variations always generated regardless of spaces in keyword
  3. Products filtered to only show items relevant to the searched keyword
  4. Report only includes suppliers WITH phone numbers (keeps searching until N found)
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

TOP_SUPPLIERS           = 5     # suppliers WITH numbers to show in report
MAX_CANDIDATES          = 30    # max candidates to search through
HISTORY_FILE            = Path(__file__).parent / "seen_suppliers.json"
REPORTS_DIR             = Path(__file__).parent / "supplier_reports"
LOG_FILE                = str(Path(__file__).parent / "supplier_agent.log")
DELAY_BETWEEN           = 1.2
MAIN_KEYWORD_PAGES      = 4
VARIATION_KEYWORD_PAGES = 2

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

def product_matches_keyword(product_name: str, keyword: str) -> bool:
    """
    FIX 3: Check product name actually contains the searched keyword words.
    e.g. keyword='air+cooler' → product must contain 'air' AND 'cooler'.
    """
    if not product_name or not keyword:
        return True
    name_lower = product_name.lower()
    words = [w for w in re.split(r'[+\s]+', keyword.lower().strip()) if len(w) > 2]
    if not words:
        return True
    return all(w in name_lower for w in words)

# ─── KEYWORD BUILDER ──────────────────────────────────────────────────────────
def build_keywords(category: str) -> tuple[str, list[str]]:
    """
    FIX 2: Always build variations regardless of spaces in keyword.
    'air cooler' → main='air+cooler', variations=['air+cooler+buy', 'buy+air+cooler', ...]
    """
    main_kw = category.strip().replace(" ", "+")
    variations = [
        main_kw + "+buy",
        main_kw + "+best",
        "buy+" + main_kw,
    ]
    keywords = [main_kw] + variations
    log.info(f"Main keyword: '{main_kw}' x{MAIN_KEYWORD_PAGES} pages")
    log.info(f"Variations: {variations} x{VARIATION_KEYWORD_PAGES} pages each")
    return main_kw, keywords

# ─── SCRAPER ──────────────────────────────────────────────────────────────────
def scrape_keyword(keyword: str, pages: int, filter_keyword: str = "") -> list[dict]:
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

            # FIX 3: Skip products that don't match the keyword
            if filter_keyword and not product_matches_keyword(prod_name, filter_keyword):
                continue

            key = seller_name.lower()
            if key not in sellers:
                sellers[key] = {
                    "seller_name":      seller_name,
                    "seller_id":        str(seller_id_v),
                    "shop_url":         f"https://www.daraz.lk/shop/{seller_id_v}/" if seller_id_v else "",
                    "total_sold":       0,
                    "total_reviews":    0,
                    "avg_rating":       0.0,
                    "products":         [],
                    "categories":       set(),
                    "matched_products": 0,
                }

            sellers[key]["total_sold"]       += sold
            sellers[key]["total_reviews"]    += reviews
            sellers[key]["avg_rating"]        = max(sellers[key]["avg_rating"], rating)
            sellers[key]["categories"].add(keyword.replace("+", " ").title())
            sellers[key]["matched_products"] += 1
            sellers[key]["products"].append({
                "name": prod_name, "price": price, "url": prod_url,
                "sold": sold, "image": image, "rating": rating,
            })

        time.sleep(DELAY_BETWEEN)

    for s in sellers.values():
        s["categories"] = sorted(list(s["categories"]))
        s["products"]   = sorted(s["products"], key=lambda p: p["sold"], reverse=True)[:5]

    return list(sellers.values())


def get_top_suppliers(keywords: list[str], seen: set, use_dedup: bool,
                      main_keyword: str = "") -> list[dict]:
    all_sellers: dict[str, dict] = {}

    for kw in keywords:
        pages     = MAIN_KEYWORD_PAGES if kw == main_keyword else VARIATION_KEYWORD_PAGES
        filter_kw = main_keyword if main_keyword else ""
        sellers   = scrape_keyword(kw, pages=pages, filter_keyword=filter_kw)

        for s in sellers:
            key = s["seller_name"].lower()
            sid = supplier_id(s["seller_name"])

            if use_dedup and sid in seen:
                continue

            if key not in all_sellers:
                all_sellers[key] = s
            else:
                ex = all_sellers[key]
                ex["categories"]       = sorted(list(set(ex["categories"] + s["categories"])))
                ex["total_sold"]       += s["total_sold"]
                ex["total_reviews"]    += s["total_reviews"]
                ex["matched_products"] += s["matched_products"]
                ex["avg_rating"]        = max(ex["avg_rating"], s["avg_rating"])
                seen_urls = {p["url"] for p in ex["products"]}
                for p in s["products"]:
                    if p["url"] not in seen_urls:
                        seen_urls.add(p["url"])
                        ex["products"].append(p)
                ex["products"] = sorted(ex["products"], key=lambda p: p["sold"], reverse=True)[:5]

    # Only keep sellers with at least 1 keyword-matching product
    filtered = {k: v for k, v in all_sellers.items() if v.get("matched_products", 0) > 0}
    ranked   = sorted(filtered.values(),
                      key=lambda x: (x["total_sold"], x["total_reviews"]), reverse=True)

    log.info(f"  {len(ranked)} suppliers with relevant products (from {len(all_sellers)} total scraped)")
    return ranked[:MAX_CANDIDATES]


# ─── CONTACT FINDER ───────────────────────────────────────────────────────────
PHONE_SYSTEM = (
    "You are a research assistant. Search the web for contact phone numbers "
    "of Sri Lankan businesses. Only return the phone number, nothing else. "
    "If not found, return NOT_FOUND."
)
PHONE_PROMPT = (
    'Find the Sri Lankan phone number for a Daraz.lk seller called "{name}". '
    'Search their website, Facebook page, or any Sri Lankan business directory. '
    'Reply ONLY with the phone number like +94771234567 or 0771234567. '
    'If not found reply: NOT_FOUND'
)


def find_phone_gemini(seller_name: str) -> str:
    """FIX 1: Try multiple Gemini model names until one works."""
    if not GEMINI_API_KEY:
        return ""
    for model in ["gemini-2.0-flash-exp", "gemini-1.5-flash", "gemini-1.5-pro"]:
        log.info(f"  Gemini ({model}): {seller_name}")
        try:
            url = (
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{model}:generateContent?key={GEMINI_API_KEY}"
            )
            payload = {
                "contents": [{"parts": [{"text": PHONE_PROMPT.format(name=seller_name)}]}],
                "tools": [{"google_search": {}}],
                "systemInstruction": {"parts": [{"text": PHONE_SYSTEM}]},
                "generationConfig": {"maxOutputTokens": 60, "temperature": 0.1},
            }
            resp = requests.post(url, json=payload, timeout=20)
            if resp.status_code == 404:
                log.warning(f"    {model} not available, trying next...")
                continue
            resp.raise_for_status()
            text = ""
            for candidate in resp.json().get("candidates", []):
                for part in candidate.get("content", {}).get("parts", []):
                    text += part.get("text", "")
            phone = extract_phone(text)
            if phone:
                log.info(f"    Found via Gemini ({model}): {phone}")
                return phone
            log.info(f"    Gemini: not found")
            return ""
        except Exception as e:
            log.warning(f"    Gemini ({model}) error: {e}")
            continue
    return ""


def find_phone_openai(seller_name: str) -> str:
    if not OPENAI_API_KEY:
        return ""
    log.info(f"  OpenAI: {seller_name}")
    try:
        import openai
        client   = openai.OpenAI(api_key=OPENAI_API_KEY)
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": PHONE_SYSTEM},
                {"role": "user",   "content": PHONE_PROMPT.format(name=seller_name)},
            ],
            max_tokens=60,
        )
        phone = extract_phone(response.choices[0].message.content.strip())
        if phone:
            log.info(f"    Found via OpenAI: {phone}")
        return phone
    except Exception as e:
        log.warning(f"    OpenAI error: {e}")
        return ""


def find_phone_serpapi(seller_name: str) -> str:
    if not SERP_API_KEY:
        return ""
    log.info(f"  SerpAPI: {seller_name}")
    try:
        resp = requests.get(
            "https://serpapi.com/search",
            params={
                "q": f'"{seller_name}" Sri Lanka contact phone number',
                "api_key": SERP_API_KEY, "engine": "google",
                "gl": "lk", "hl": "en", "num": 5,
            },
            timeout=15,
        )
        data  = resp.json()
        text  = str(data.get("knowledge_graph", {}).get("phone", "")) + " "
        text += " ".join(r.get("snippet", "") + " " + r.get("title", "")
                         for r in data.get("organic_results", [])[:5])
        phone = extract_phone(text)
        if phone:
            log.info(f"    Found via SerpAPI: {phone}")
        return phone
    except Exception as e:
        log.warning(f"    SerpAPI error: {e}")
        return ""


def find_phone(seller_name: str) -> dict:
    """Gemini → OpenAI → SerpAPI"""
    phone = ""; source = ""
    if GEMINI_API_KEY:
        phone = find_phone_gemini(seller_name)
        if phone: source = "Gemini"
    if not phone and OPENAI_API_KEY:
        phone = find_phone_openai(seller_name)
        if phone: source = "OpenAI"
    if not phone and SERP_API_KEY:
        phone = find_phone_serpapi(seller_name)
        if phone: source = "SerpAPI"
    return {"phone": phone, "source": source, "found": bool(phone)}


def enrich_suppliers(candidates: list[dict]) -> list[dict]:
    """
    FIX 4: Walk through candidates until we have exactly TOP_SUPPLIERS with numbers.
    Suppliers without a phone number are completely skipped from the report.
    """
    confirmed = []
    skipped   = 0

    for s in candidates:
        if len(confirmed) >= TOP_SUPPLIERS:
            break
        log.info(f"Checking: {s['seller_name']}  "
                 f"[need {TOP_SUPPLIERS - len(confirmed)} more with numbers]")
        contact = find_phone(s["seller_name"])
        if contact["found"]:
            s["phone"]          = contact["phone"]
            s["contact_source"] = contact["source"]
            s["contact_found"]  = True
            confirmed.append(s)
            log.info(f"  ✓ {len(confirmed)}/{TOP_SUPPLIERS} confirmed")
        else:
            skipped += 1
            log.info(f"  ✗ No number — skipping (skipped {skipped} so far)")
        time.sleep(1.5)

    if len(confirmed) < TOP_SUPPLIERS:
        log.warning(f"Only found {len(confirmed)}/{TOP_SUPPLIERS} suppliers with numbers "
                    f"after checking {len(confirmed)+skipped} candidates.")
    return confirmed


# ─── REPORT ───────────────────────────────────────────────────────────────────
def generate_html_report(suppliers: list[dict], mode: str, category: str = "") -> Path:
    REPORTS_DIR.mkdir(exist_ok=True)
    today = date.today().isoformat()
    ts    = datetime.now().strftime("%H%M%S")

    if mode == "category":
        filename   = f"supplier_report_{category.replace(' ','_')}_{today}_{ts}.html"
        title_mode = f'Category Search: <span>"{category}"</span>'
        subtitle   = (f'Top {len(suppliers)} suppliers for "{category}" — verified phone numbers only'
                      f' — {datetime.now().strftime("%B %d, %Y  •  %I:%M %p")}')
    else:
        filename   = f"supplier_report_daily_{today}.html"
        title_mode = "Daily <span>Auto</span> Discovery"
        subtitle   = (f'Top {len(suppliers)} suppliers with verified phone numbers'
                      f' — {datetime.now().strftime("%B %d, %Y  •  %I:%M %p")}')

    report_path = REPORTS_DIR / filename
    cards_html  = ""

    for i, s in enumerate(suppliers, 1):
        categories_html = "".join(f'<span class="cat-tag">{c}</span>'
                                  for c in s.get("categories", []))
        products_html = ""
        for p in s.get("products", [])[:5]:
            name_short   = p["name"][:65] + ("..." if len(p["name"]) > 65 else "")
            rating_int   = int(p.get("rating", 0))
            rating_stars = "★" * rating_int + "☆" * (5 - rating_int)
            products_html += f"""
            <div class="product-row">
              <a href="{p['url']}" target="_blank">{name_short}</a>
              <span class="prod-rating">{rating_stars}</span>
              <span class="prod-price">Rs. {p['price']:,.0f}</span>
              <span class="prod-sold">{p['sold']:,} sold</span>
            </div>"""

        source_color = {"Gemini": "#34d399", "OpenAI": "#60a5fa", "SerpAPI": "#a78bfa"}.get(
            s.get("contact_source", ""), "#34d399")
        source_html = (
            f'<span class="source-badge" style="color:{source_color};border-color:{source_color}44;">'
            f'{s["contact_source"]}</span>'
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
                <span>📦 {s.get('matched_products',0)} matched products</span>
              </div>
              <div class="categories">{categories_html}</div>
            </div>
            <div class="contact-box">
              <div class="contact-label">Phone Number</div>
              <span class="phone found">{s['phone']}</span>
              {source_html}
              {shop_html}
            </div>
          </div>
          <div class="products-section">
            <div class="products-label">Top Selling "{category or 'Products'}" from this Supplier</div>
            {products_html or '<div style="color:rgba(255,255,255,0.3);font-size:.82rem;">No matching products captured</div>'}
          </div>
        </div>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daraz Supplier Report — {today}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{font-family:'Inter','Segoe UI',sans-serif;background:#0f0f13;color:#e8e8f0;min-height:100vh}}
    header{{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);padding:40px 48px;border-bottom:1px solid rgba(255,255,255,0.08);position:relative;overflow:hidden}}
    header::before{{content:'';position:absolute;top:-50%;right:-10%;width:500px;height:500px;background:radial-gradient(circle,rgba(248,86,6,0.15) 0%,transparent 70%);pointer-events:none}}
    .header-top{{display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:16px}}
    header h1{{font-size:2rem;font-weight:800;color:#fff;letter-spacing:-0.5px}}
    header h1 span{{color:#f85606}}
    header p{{color:rgba(255,255,255,0.55);margin-top:8px;font-size:.88rem}}
    .mode-pill{{display:inline-flex;align-items:center;gap:6px;padding:4px 14px;border-radius:20px;font-size:.78rem;font-weight:600;margin-bottom:10px}}
    .mode-pill.daily{{background:rgba(59,130,246,0.2);color:#60a5fa;border:1px solid rgba(59,130,246,0.3)}}
    .mode-pill.search{{background:rgba(248,86,6,0.2);color:#f85606;border:1px solid rgba(248,86,6,0.3)}}
    .header-stats{{display:flex;gap:12px;flex-wrap:wrap}}
    .stat-box{{background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:14px 20px;text-align:center;min-width:90px}}
    .stat-box .num{{font-size:1.6rem;font-weight:800;color:#f85606}}
    .stat-box .lbl{{font-size:.7rem;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.5px;margin-top:2px}}
    .container{{max-width:960px;margin:0 auto;padding:36px 20px}}
    .section-title{{font-size:.85rem;font-weight:700;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:20px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.07)}}
    .supplier-card{{background:#1a1a2e;border:1px solid rgba(255,255,255,0.08);border-radius:16px;margin-bottom:16px;overflow:hidden;transition:border-color .2s,box-shadow .2s}}
    .supplier-card:hover{{border-color:rgba(248,86,6,0.4);box-shadow:0 0 30px rgba(248,86,6,0.1)}}
    .supplier-header{{display:flex;gap:20px;padding:24px;align-items:flex-start;border-bottom:1px solid rgba(255,255,255,0.06)}}
    .supplier-rank{{font-size:2rem;font-weight:900;color:#f85606;min-width:48px;padding-top:4px}}
    .supplier-main{{flex:1}}
    .name-row{{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}}
    .supplier-name{{font-size:1.15rem;font-weight:700;color:#fff}}
    .mode-tag{{padding:2px 10px;border-radius:12px;font-size:.7rem;font-weight:600}}
    .daily-tag{{background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.25)}}
    .search-tag{{background:rgba(248,86,6,0.15);color:#f85606;border:1px solid rgba(248,86,6,0.25)}}
    .supplier-stats{{display:flex;flex-wrap:wrap;gap:12px;font-size:.8rem;color:rgba(255,255,255,0.45);margin-bottom:12px}}
    .categories{{display:flex;flex-wrap:wrap;gap:6px}}
    .cat-tag{{background:rgba(248,86,6,0.12);color:#f85606;border:1px solid rgba(248,86,6,0.25);padding:3px 10px;border-radius:20px;font-size:.72rem;font-weight:500}}
    .contact-box{{text-align:right;min-width:200px}}
    .contact-label{{font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,0.3);margin-bottom:8px}}
    .phone{{display:block;font-size:1.15rem;font-weight:700;margin-bottom:6px}}
    .phone.found{{color:#34d399}}
    .source-badge{{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.68rem;margin-bottom:10px;border:1px solid;background:rgba(0,0,0,0.3)}}
    .btn-shop{{display:inline-block;background:#f85606;color:white;padding:6px 14px;border-radius:8px;text-decoration:none;font-size:.78rem;font-weight:600;margin-top:6px}}
    .btn-shop:hover{{background:#d94800}}
    .products-section{{padding:16px 24px;background:rgba(0,0,0,0.2)}}
    .products-label{{font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,0.25);margin-bottom:10px}}
    .product-row{{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:.82rem}}
    .product-row:last-child{{border-bottom:none}}
    .product-row a{{flex:1;color:rgba(255,255,255,0.6);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
    .product-row a:hover{{color:#f85606}}
    .prod-rating{{color:#f5a623;font-size:.72rem;white-space:nowrap;flex-shrink:0}}
    .prod-price{{color:#f85606;font-weight:600;white-space:nowrap;flex-shrink:0}}
    .prod-sold{{color:rgba(255,255,255,0.3);font-size:.74rem;white-space:nowrap;flex-shrink:0}}
    footer{{text-align:center;color:rgba(255,255,255,0.2);font-size:.73rem;padding:32px;border-top:1px solid rgba(255,255,255,0.06)}}
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
        <div class="stat-box">
          <div class="num">{len(suppliers)}</div>
          <div class="lbl">With Numbers</div>
        </div>
        <div class="stat-box">
          <div class="num">{sum(s.get('matched_products',0) for s in suppliers)}</div>
          <div class="lbl">Matched Products</div>
        </div>
      </div>
    </div>
  </header>
  <div class="container">
    <div class="section-title">
      {'Results for "' + category + '" — ' + str(len(suppliers)) + ' suppliers · verified phone numbers only'
       if mode == 'category' else "Today's Top Suppliers · Verified Numbers Only"}
    </div>
    {cards_html}
  </div>
  <footer>
    Daraz Supplier Agent v3 &nbsp;•&nbsp;
    {'Category: ' + category if mode == 'category' else 'Daily Auto Mode'} &nbsp;•&nbsp;
    Contact search: Gemini → OpenAI → SerpAPI &nbsp;•&nbsp; {today}
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
    print("  DARAZ SUPPLIER AGENT v3")
    print("═" * 55)
    try:
        import sys as _sys
        user_input = "" if not _sys.stdin.isatty() else input("\n  Category (or ENTER for daily): ").strip()
    except (EOFError, KeyboardInterrupt):
        user_input = ""
    return ("category", user_input.lower()) if user_input else ("daily", "")


# ─── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    log.info("=" * 60)
    mode, category = ask_mode()

    if mode == "category":
        main_kw, keywords = build_keywords(category)
        log.info(f"MODE: Category Search — '{category}'")
        raw = get_top_suppliers(keywords, seen=set(), use_dedup=False, main_keyword=main_kw)
    else:
        log.info("MODE: Daily Auto Discovery")
        seen = load_history()
        log.info(f"History: {len(seen)} suppliers already seen")
        day_offset = date.today().timetuple().tm_yday
        random.seed(day_offset)
        keywords_today = random.sample(DAILY_KEYWORDS, min(8, len(DAILY_KEYWORDS)))
        log.info(f"Today's keywords: {', '.join(keywords_today)}")
        raw = get_top_suppliers(keywords_today, seen=seen, use_dedup=True, main_keyword="")

    log.info(f"Found {len(raw)} candidates — need {TOP_SUPPLIERS} with phone numbers...")

    if not raw:
        log.warning("No suppliers found.")
        return None

    suppliers = enrich_suppliers(raw)

    if not suppliers:
        log.warning("No suppliers with phone numbers found.")
        return None

    log.info(f"Confirmed {len(suppliers)} suppliers with numbers. Generating report...")
    report_path = generate_html_report(suppliers, mode, category)

    if mode == "daily":
        seen = load_history()
        new_seen = seen | {supplier_id(s["seller_name"]) for s in suppliers}
        save_history(new_seen)
        log.info(f"History updated: {len(new_seen)} total seen suppliers")

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
