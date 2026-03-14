#!/usr/bin/env python3
"""
Daraz Supplier Agent
- Scrapes Daraz.lk daily to find top 5 suppliers
- Extracts their shop info + product categories
- Finds phone numbers via OpenAI web search, fallback to SerpAPI
- Generates a beautiful HTML report
- Deduplicates suppliers across days
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
import openai

# ─── CONFIG ───────────────────────────────────────────────────────────────────
OPENAI_API_KEY  = os.getenv("OPENAI_API_KEY", "")
SERP_API_KEY    = os.getenv("SERP_API_KEY",   "")

TOP_SUPPLIERS       = 5
HISTORY_FILE        = Path(__file__).parent / "seen_suppliers.json"
REPORTS_DIR         = Path(__file__).parent / "supplier_reports"
LOG_FILE            = str(Path(__file__).parent / "supplier_agent.log")
DELAY_BETWEEN       = 1.5

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
_file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
_file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
_console_stream = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
_console_handler = logging.StreamHandler(_console_stream)
_console_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logging.basicConfig(level=logging.INFO, handlers=[_file_handler, _console_handler])
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
def scrape_suppliers_from_keyword(keyword: str, pages: int = 2) -> list[dict]:
    """Scrape 1-2 pages of a keyword and extract sellers."""
    sellers = {}
    for page in range(1, pages + 1):
        url = BASE_URL.format(q=keyword, page=page)
        log.info(f"  Scraping: {keyword} (page {page})")
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

            if len(sellers[key]["products"]) < 3:
                sellers[key]["products"].append({
                    "name":  prod_name,
                    "price": price,
                    "url":   prod_url,
                    "sold":  sold,
                    "image": image,
                })

        time.sleep(DELAY_BETWEEN)

    for s in sellers.values():
        s["categories"] = sorted(list(s["categories"]))

    return list(sellers.values())


def get_top_suppliers(keywords: list[str], seen: set, use_dedup: bool) -> list[dict]:
    """Scrape keywords, merge sellers, return top N."""
    all_sellers = {}

    for kw in keywords:
        sellers = scrape_suppliers_from_keyword(kw, pages=2)
        for s in sellers:
            key = s["seller_name"].lower()
            sid = supplier_id(s["seller_name"])

            if use_dedup and sid in seen:
                continue

            if key not in all_sellers:
                all_sellers[key] = s
            else:
                # Merge categories and sold counts
                all_sellers[key]["categories"] = sorted(list(set(
                    all_sellers[key]["categories"] + s["categories"]
                )))
                all_sellers[key]["total_sold"]    += s["total_sold"]
                all_sellers[key]["total_reviews"] += s["total_reviews"]
                all_sellers[key]["avg_rating"]     = max(
                    all_sellers[key]["avg_rating"], s["avg_rating"]
                )
                for p in s["products"]:
                    if len(all_sellers[key]["products"]) < 3:
                        all_sellers[key]["products"].append(p)

    ranked = sorted(all_sellers.values(), key=lambda x: x["total_sold"], reverse=True)
    return ranked[:TOP_SUPPLIERS * 2]  # buffer for contact search

# ─── CONTACT FINDER ───────────────────────────────────────────────────────────
def find_phone_openai(seller_name: str) -> str:
    log.info(f"  OpenAI search: {seller_name}")
    try:
        client = openai.OpenAI(api_key=OPENAI_API_KEY)
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a research assistant. Search the web for contact phone numbers "
                        "of Sri Lankan businesses. Only return the phone number, nothing else. "
                        "If not found, return NOT_FOUND."
                    )
                },
                {
                    "role": "user",
                    "content": (
                        f'Find the Sri Lankan phone number for a Daraz.lk seller called "{seller_name}". '
                        f'Search their website, Facebook page, or any Sri Lankan business directory. '
                        f'Reply ONLY with the phone number like +94771234567 or 0771234567. '
                        f'If not found reply: NOT_FOUND'
                    )
                }
            ],
            tools=[{"type": "web_search_preview"}],
            max_tokens=50,
        )
        result = response.choices[0].message.content.strip()
        phone = extract_phone(result)
        if phone:
            log.info(f"    Found via OpenAI: {phone}")
            return phone
        return ""
    except openai.BadRequestError:
        log.info(f"    OpenAI web search unavailable, trying SerpAPI...")
        return ""
    except Exception as e:
        log.warning(f"    OpenAI failed: {e}")
        return ""

def find_phone_serpapi(seller_name: str) -> str:
    if not SERP_API_KEY or SERP_API_KEY == "YOUR_SERPAPI_KEY_HERE":
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
    """3-tier phone search: OpenAI → SerpAPI → Not found"""
    phone = ""; source = ""

    if OPENAI_API_KEY and OPENAI_API_KEY != "YOUR_OPENAI_API_KEY_HERE":
        phone = find_phone_openai(seller_name)
        if phone: source = "OpenAI"

    if not phone and SERP_API_KEY and SERP_API_KEY != "YOUR_SERPAPI_KEY_HERE":
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
        filename = f"supplier_report_{category.replace(' ','_')}_{today}_{ts}.html"
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
        for p in s.get("products", [])[:3]:
            name_short = p["name"][:65] + ("..." if len(p["name"]) > 65 else "")
            products_html += f"""
            <div class="product-row">
              <a href="{p['url']}" target="_blank">{name_short}</a>
              <span class="prod-price">Rs. {p['price']:,.0f}</span>
              <span class="prod-sold">{p['sold']:,} sold</span>
            </div>"""

        phone_class = "found" if s.get("contact_found") else "not-found"
        phone_html  = f'<span class="phone {phone_class}">{s["phone"]}</span>'
        source_html = (
            f'<span class="source-badge">{s["contact_source"]}</span>'
            if s.get("contact_found") else ""
        )
        shop_html = (
            f'<a href="{s["shop_url"]}" target="_blank" class="btn-shop">View Shop →</a>'
            if s.get("shop_url") else ""
        )

        mode_badge = (
            f'<span class="mode-tag search-tag">Category Search</span>'
            if mode == "category"
            else f'<span class="mode-tag daily-tag">Daily Pick</span>'
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
                <span>🛒 {s['total_sold']:,} total sold</span>
                <span>💬 {s['total_reviews']:,} reviews</span>
                <span>⭐ {s['avg_rating']:.1f} avg rating</span>
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
            <div class="products-label">Top Products</div>
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
      padding: 40px 48px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
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
      display: inline-block; background: rgba(52,211,153,0.1); color: #34d399;
      border: 1px solid rgba(52,211,153,0.2); padding: 2px 8px; border-radius: 10px;
      font-size: .68rem; margin-bottom: 10px;
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
      display: flex; align-items: center; gap: 12px; padding: 7px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04); font-size: .82rem;
    }}
    .product-row:last-child {{ border-bottom: none; }}
    .product-row a {{ flex: 1; color: rgba(255,255,255,0.6); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
    .product-row a:hover {{ color: #f85606; }}
    .prod-price {{ color: #f85606; font-weight: 600; white-space: nowrap; }}
    .prod-sold {{ color: rgba(255,255,255,0.3); font-size: .74rem; white-space: nowrap; }}
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
    <div class="section-title">{'Results for "' + category + '"' if mode == 'category' else "Today's Top Suppliers"}</div>
    {cards_html}
  </div>
  <footer>
    Daraz Supplier Agent &nbsp;•&nbsp; {'Category: ' + category if mode == 'category' else 'Daily Auto Mode'} &nbsp;•&nbsp;
    Contact search: OpenAI + SerpAPI &nbsp;•&nbsp; {today}
  </footer>
</body>
</html>"""

    report_path.write_text(html, encoding="utf-8")
    log.info(f"Report saved: {report_path}")
    return report_path

# ─── STARTUP PROMPT ───────────────────────────────────────────────────────────
def ask_mode() -> tuple[str, str]:
    """
    Ask user at startup:
      - Press ENTER → daily auto mode
      - Type a category → category search mode
    On non-interactive environments (Render, cron), defaults to daily mode.
    Override via SUPPLIER_CATEGORY env var.
    """
    # Support env-var override (useful for Render / cron)
    env_category = os.getenv("SUPPLIER_CATEGORY", "").strip()
    if env_category:
        return "category", env_category.lower()

    print("\n" + "═" * 55)
    print("  DARAZ SUPPLIER AGENT")
    print("═" * 55)
    print("  Press ENTER  → Run daily auto discovery (top 5 suppliers)")
    print("  Type a word  → Search suppliers for that category")
    print("═" * 55)
    try:
        import sys
        if not sys.stdin.isatty():
            # Non-interactive (Render, pipe, cron) — use daily mode
            user_input = ""
        else:
            user_input = input("\n  Category (or ENTER for daily): ").strip()
    except (EOFError, KeyboardInterrupt):
        user_input = ""

    if user_input:
        return "category", user_input.lower()
    else:
        return "daily", ""

# ─── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    log.info("=" * 60)

    # ── Determine mode ──────────────────────────────────────────
    mode, category = ask_mode()

    if mode == "category":
        log.info(f"MODE: Category Search — '{category}'")
        # Convert user input to URL-friendly keyword
        keyword = category.replace(" ", "+")
        # Use multiple related keywords for better results
        keywords = [keyword]
        # Add some variations
        if " " not in category:
            keywords += [
                keyword + "+accessories",
                keyword + "+products",
                "best+" + keyword,
            ]
        log.info(f"Searching keywords: {keywords}")
        raw_suppliers = get_top_suppliers(keywords, seen=set(), use_dedup=False)

    else:
        log.info("MODE: Daily Auto Discovery")
        seen = load_history()
        log.info(f"History: {len(seen)} suppliers already seen")
        # Rotate through DAILY_KEYWORDS based on day
        day_offset = date.today().timetuple().tm_yday
        random.seed(day_offset)
        keywords_today = random.sample(DAILY_KEYWORDS, min(8, len(DAILY_KEYWORDS)))
        log.info(f"Today's keywords: {', '.join(keywords_today)}")
        raw_suppliers = get_top_suppliers(keywords_today, seen=seen, use_dedup=True)

    log.info(f"Found {len(raw_suppliers)} candidate suppliers")

    if not raw_suppliers:
        print("\n  No suppliers found. Try a different category or reset seen_suppliers.json")
        log.warning("No suppliers found.")
        return None

    # ── Find phone numbers ──────────────────────────────────────
    log.info("Finding contact phone numbers...")
    suppliers = enrich_suppliers(raw_suppliers)

    # ── Generate report ─────────────────────────────────────────
    log.info("Generating HTML report...")
    report_path = generate_html_report(suppliers, mode, category)

    # ── Update history (only in daily mode) ────────────────────
    if mode == "daily":
        seen = load_history()
        new_seen = seen | {supplier_id(s["seller_name"]) for s in suppliers}
        save_history(new_seen)
        log.info(f"History updated: {len(new_seen)} total seen suppliers")

    # ── Done ────────────────────────────────────────────────────
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