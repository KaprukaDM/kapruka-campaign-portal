#!/usr/bin/env python3
"""
Daraz Product Search Agent
- Enter any keyword → builds Daraz AJAX search URL
- Scrapes multiple pages (auto-scales to hit your target count)
- Filters: Local sellers, configurable min price, min rating
- Ranks by sold count + reviews + rating
- Supports Top 50 / 100 / 200 / 300 / 500
- Saves HTML report + CSV
"""

import os
import re
import csv
import json
import time
import random
import logging
import sys
import io
from datetime import datetime
from pathlib import Path

import requests

# ─── CONFIG ────────────────────────────────────────────────────────────────────
MIN_PRICE     = 3000          # minimum price in Rs.
MIN_RATING    = 4             # minimum star rating (0 = any)
DELAY         = 0.8           # seconds between requests
REPORTS_DIR   = Path(__file__).parent / "reports"
LOG_FILE      = str(Path(__file__).parent / "daraz_search.log")

# ── Top-N presets ──────────────────────────────────────────────────────────────
# Products per page on Daraz is ~40. Pages needed = ceil(TOP_N / 40) + buffer
TOP_N_OPTIONS = {
    50:  3,    # 3 pages  (~120 raw products)
    100: 4,    # 4 pages  (~160 raw products)
    200: 7,    # 7 pages  (~280 raw products)
    300: 10,   # 10 pages (~400 raw products)
    500: 15,   # 15 pages (~600 raw products)
}

BASE_URL = (
    "https://www.daraz.lk/catalog/"
    "?location=Local"
    "&page={page}"
    "&price={min_price}-"
    "&q={q}"
    "&rating={rating}"
    "&sort=popularity"
    "&ajax=true"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/javascript, */*; q=0.1",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.daraz.lk/",
}

# ─── LOGGING ───────────────────────────────────────────────────────────────────
_fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
_fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
_ch = logging.StreamHandler(io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace"))
_ch.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logging.basicConfig(level=logging.INFO, handlers=[_fh, _ch])
log = logging.getLogger(__name__)

# ─── HELPERS ───────────────────────────────────────────────────────────────────
def coalesce(*args):
    for v in args:
        if v is not None and v != "":
            return v
    return ""

def clean_sold(raw) -> int:
    if raw is None:
        return 0
    s = re.sub(r"<[^>]*>", "", str(raw)).strip()
    m = re.search(r"([\d,\.]+)\s*(k?)", s, re.IGNORECASE)
    if not m:
        return 0
    num = float(m.group(1).replace(",", ""))
    if m.group(2).lower() == "k":
        num *= 1000
    return int(num)

def clean_price(raw) -> float:
    if not raw and raw != 0:
        return 0.0
    s = re.sub(r"[^\d.]", "", str(raw))
    try:
        return float(s)
    except ValueError:
        return 0.0

def clean_float(raw) -> float:
    if not raw and raw != 0:
        return 0.0
    try:
        return float(re.sub(r"[^\d.]", "", str(raw)))
    except ValueError:
        return 0.0

def clean_int(raw) -> int:
    if not raw and raw != 0:
        return 0
    try:
        return int(re.sub(r"[^\d]", "", str(raw)))
    except ValueError:
        return 0

def fix_url(href: str) -> str:
    if not href:
        return ""
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        return "https://www.daraz.lk" + href
    if not href.startswith("http"):
        return "https://www.daraz.lk/" + href
    return href

def score_product(p: dict) -> float:
    sold_score   = min(p.get("sold",    0) / 1000, 1.0)
    review_score = min(p.get("reviews", 0) / 1000, 1.0)
    rating_score = p.get("rating", 0) / 5.0
    return (0.50 * sold_score) + (0.30 * review_score) + (0.20 * rating_score)

# ─── FETCH ─────────────────────────────────────────────────────────────────────
def fetch_page(keyword: str, page: int, min_price: int, min_rating: int) -> dict | None:
    q = keyword.strip().replace(" ", "+")
    url = BASE_URL.format(q=q, page=page, min_price=min_price, rating=min_rating)
    log.info(f"  Fetching page {page}: {url[:90]}...")
    for attempt in range(3):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=20)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.JSONDecodeError:
            log.warning(f"    Not JSON (attempt {attempt+1})")
        except Exception as e:
            log.warning(f"    Error attempt {attempt+1}: {e}")
        time.sleep(random.uniform(2, 4))
    return None

# ─── PARSE ─────────────────────────────────────────────────────────────────────
def parse_items(data: dict, min_price: int) -> list[dict]:
    if not data:
        return []
    mods  = data.get("mods") or data.get("mainInfo") or {}
    items = mods.get("listItems") or mods.get("items") or []
    if not isinstance(items, list):
        return []

    products = []
    for x in items:
        try:
            name     = coalesce(x.get("name"), x.get("productTitle"), "")
            price    = clean_price(coalesce(x.get("price"), x.get("priceShow"), 0))
            sold     = clean_sold(coalesce(x.get("itemSoldCntShow"), x.get("soldCnt"), 0))
            reviews  = clean_int(coalesce(x.get("review"), x.get("reviewCount"), 0))
            rating   = clean_float(coalesce(
                x.get("ratingScore"),
                (x.get("rating") or {}).get("average"),
                0
            ))
            seller   = coalesce(x.get("sellerName"), x.get("shopName"), "")
            url      = fix_url(coalesce(x.get("productUrl"), x.get("itemUrl"), ""))
            location = str(x.get("location") or "").strip().lower()
            image    = coalesce(x.get("image"), x.get("mainImage"), "")
            if image and image.startswith("//"):
                image = "https:" + image

            if location == "overseas":
                continue
            if not name or price < min_price:
                continue

            products.append({
                "title":   name,
                "url":     url,
                "price":   price,
                "sold":    sold,
                "reviews": reviews,
                "rating":  rating,
                "seller":  seller,
                "image":   image,
            })
        except Exception as e:
            log.debug(f"Parse error: {e}")
    return products

# ─── SEARCH ────────────────────────────────────────────────────────────────────
def search(keyword: str, top_n: int, min_price: int = MIN_PRICE, min_rating: int = MIN_RATING) -> list[dict]:
    pages_needed = TOP_N_OPTIONS.get(top_n, max(TOP_N_OPTIONS.values()))
    log.info(f"Searching '{keyword}' | Top {top_n} | Pages: {pages_needed} | Min Rs.{min_price} | Min {min_rating}★")

    all_products = []
    for page in range(1, pages_needed + 1):
        data  = fetch_page(keyword, page, min_price, min_rating)
        items = parse_items(data, min_price)
        all_products.extend(items)
        log.info(f"    Page {page}: +{len(items)} products (total raw: {len(all_products)})")
        if not items:
            log.info("    Empty page — stopping early.")
            break
        time.sleep(DELAY + random.uniform(0, 0.5))

    # Deduplicate by title (keep highest scored duplicate)
    unique = {}
    for p in all_products:
        key = p["title"].lower()[:60]
        if key not in unique or score_product(p) > score_product(unique[key]):
            unique[key] = p

    ranked = sorted(unique.values(), key=score_product, reverse=True)
    log.info(f"Deduped: {len(unique)} unique | Returning top {min(top_n, len(ranked))}")
    return ranked[:top_n]

# ─── SAVE CSV ──────────────────────────────────────────────────────────────────
def save_csv(products: list[dict], keyword: str, top_n: int) -> Path:
    REPORTS_DIR.mkdir(exist_ok=True)
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = re.sub(r"[^\w]+", "_", keyword.lower().strip())
    path = REPORTS_DIR / f"daraz_{slug}_top{top_n}_{ts}.csv"

    fieldnames = ["rank", "title", "price", "rating", "sold", "reviews", "seller", "score", "url"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for i, p in enumerate(products, 1):
            writer.writerow({
                "rank":    i,
                "title":   p["title"],
                "price":   f"{p['price']:.0f}",
                "rating":  f"{p['rating']:.1f}",
                "sold":    p["sold"],
                "reviews": p["reviews"],
                "seller":  p["seller"],
                "score":   f"{score_product(p)*100:.0f}",
                "url":     p["url"],
            })
    log.info(f"CSV saved: {path}")
    return path

# ─── SAVE HTML ─────────────────────────────────────────────────────────────────
def save_html(products: list[dict], keyword: str, top_n: int) -> Path:
    REPORTS_DIR.mkdir(exist_ok=True)
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = re.sub(r"[^\w]+", "_", keyword.lower().strip())
    path = REPORTS_DIR / f"daraz_{slug}_top{top_n}_{ts}.html"

    cards = ""
    for i, p in enumerate(products, 1):
        stars     = "★" * int(p["rating"]) + "☆" * (5 - int(p["rating"]))
        score_pct = int(score_product(p) * 100)
        img_tag   = (
            f'<img src="{p["image"]}" alt="" onerror="this.style.display=\'none\'">'
            if p.get("image") else '<div class="no-img">📦</div>'
        )
        cards += f"""
        <div class="card">
          <div class="rank">#{i}</div>
          <div class="thumb">{img_tag}</div>
          <div class="info">
            <a href="{p['url']}" target="_blank" class="title">{p['title']}</a>
            <div class="meta">
              <span class="pill price">Rs. {p['price']:,.0f}</span>
              <span class="pill">⭐ {stars} {p['rating']}</span>
              <span class="pill">🛒 {p['sold']:,} sold</span>
              <span class="pill">💬 {p['reviews']:,} reviews</span>
              <span class="pill">🏪 {p['seller']}</span>
            </div>
            <div class="bar-wrap">
              <div class="bar"><div class="fill" style="width:{score_pct}%"></div></div>
              <span class="bar-label">Score {score_pct}/100</span>
            </div>
            <a href="{p['url']}" target="_blank" class="btn">View on Daraz →</a>
          </div>
        </div>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daraz Search: {keyword} — Top {top_n}</title>
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{font-family:'Segoe UI',sans-serif;background:#f4f6fb;color:#222}}
    header{{background:linear-gradient(135deg,#f85606,#ff9f00);color:#fff;padding:28px 36px}}
    header h1{{font-size:1.7rem}}
    header p{{opacity:.9;margin-top:5px;font-size:.9rem}}
    .badges{{margin-top:10px;display:flex;gap:7px;flex-wrap:wrap}}
    .badge{{background:rgba(255,255,255,.25);border-radius:20px;padding:2px 12px;font-size:.78rem}}
    .container{{max-width:900px;margin:0 auto;padding:28px 18px}}
    .section-title{{font-size:1.05rem;font-weight:700;color:#f85606;margin:0 0 12px;border-left:4px solid #f85606;padding-left:10px}}
    .card{{background:#fff;border-radius:12px;padding:14px;display:flex;gap:12px;align-items:flex-start;margin-bottom:10px;box-shadow:0 2px 8px rgba(0,0,0,.06);transition:transform .15s}}
    .card:hover{{transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,.1)}}
    .rank{{font-size:1.4rem;font-weight:900;color:#f85606;min-width:38px;text-align:center;padding-top:3px}}
    .thumb img{{width:80px;height:80px;object-fit:contain;border-radius:8px;border:1px solid #eee}}
    .no-img{{width:80px;height:80px;background:#fef3ea;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:1.6rem;flex-shrink:0}}
    .info{{flex:1;min-width:0}}
    .title{{font-size:.95rem;font-weight:600;color:#222;text-decoration:none;display:block;margin-bottom:7px}}
    .title:hover{{color:#f85606}}
    .meta{{display:flex;flex-wrap:wrap;gap:6px;font-size:.78rem;color:#666;margin-bottom:8px}}
    .pill{{background:#f5f5f5;padding:2px 9px;border-radius:20px}}
    .price{{background:#fff4e5;color:#c45500;font-weight:700}}
    .bar-wrap{{display:flex;align-items:center;gap:7px;margin:6px 0}}
    .bar{{flex:1;background:#f0f0f0;border-radius:20px;height:7px;overflow:hidden}}
    .fill{{background:linear-gradient(90deg,#f85606,#ff9f00);height:100%;border-radius:20px}}
    .bar-label{{font-size:.7rem;color:#999;white-space:nowrap}}
    .btn{{display:inline-block;background:#f85606;color:#fff;padding:5px 16px;border-radius:20px;text-decoration:none;font-size:.78rem;font-weight:600;margin-top:4px}}
    .btn:hover{{background:#d94800}}
    footer{{text-align:center;color:#aaa;font-size:.72rem;padding:28px;border-top:1px solid #eee;margin-top:16px}}
  </style>
</head>
<body>
  <header>
    <h1>Daraz Search: "{keyword}"</h1>
    <p>Top {top_n} products — local sellers, Rs.{MIN_PRICE:,}+, {min_rating}★+, ranked by popularity</p>
    <div class="badges">
      <span class="badge">{datetime.now().strftime('%B %d, %Y  •  %I:%M %p')}</span>
      <span class="badge">{len(products)} results</span>
    </div>
  </header>
  <div class="container">
    <div class="section-title">Top {top_n} Results for "{keyword}"</div>
    {cards}
  </div>
  <footer>Daraz Search Agent • Local sellers only • Min {min_rating}★ rating • Prices in Sri Lankan Rupees</footer>
</body>
</html>"""

    path.write_text(html, encoding="utf-8")
    log.info(f"HTML saved: {path}")
    return path

# ─── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    print("\n" + "=" * 55)
    print("  Daraz Product Search Agent")
    print("=" * 55)

    # --- Keyword input ---
    keyword = input("\nEnter search keyword: ").strip()
    if not keyword:
        print("No keyword entered. Exiting.")
        return

    # --- Top-N selection ---
    print("\nHow many top products do you want?")
    print("  1. Top 50")
    print("  2. Top 100")
    print("  3. Top 200")
    print("  4. Top 300")
    print("  5. Top 500")
    choice = input("Enter choice [1-5] (default 1): ").strip() or "1"
    top_n_map = {"1": 50, "2": 100, "3": 200, "4": 300, "5": 500}
    top_n = top_n_map.get(choice, 50)

    # --- Optional overrides ---
    try:
        mp = input(f"\nMin price in Rs. (default {MIN_PRICE}): ").strip()
        min_price = int(mp) if mp else MIN_PRICE
    except ValueError:
        min_price = MIN_PRICE

    try:
        mr = input(f"Min rating stars (default {MIN_RATING}, 0=any): ").strip()
        min_rating = int(mr) if mr else MIN_RATING
    except ValueError:
        min_rating = MIN_RATING

    # --- Run search ---
    print(f"\nSearching '{keyword}' | Top {top_n} | Rs.{min_price:,}+ | {min_rating}★+\n")
    products = search(keyword, top_n, min_price, min_rating)

    if not products:
        print("No products found. Try a different keyword or lower filters.")
        return

    # --- Print summary to console ---
    print(f"\n{'─'*55}")
    print(f"  Top {len(products)} results for '{keyword}'")
    print(f"{'─'*55}")
    for i, p in enumerate(products, 1):
        score_pct = int(score_product(p) * 100)
        print(
            f"  #{i:<4} {p['title'][:45]:<45} "
            f"Rs.{p['price']:>8,.0f}  "
            f"⭐{p['rating']:.1f}  "
            f"Sold:{p['sold']:>6,}  "
            f"Score:{score_pct}"
        )
    print(f"{'─'*55}\n")

    # --- Save files ---
    html_path = save_html(products, keyword, top_n)
    csv_path  = save_csv(products, keyword, top_n)

    print(f"\nFiles saved:")
    print(f"  HTML report : {html_path.resolve()}")
    print(f"  CSV data    : {csv_path.resolve()}")
    print()

if __name__ == "__main__":
    main()
