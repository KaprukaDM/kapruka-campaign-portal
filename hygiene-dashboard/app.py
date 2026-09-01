#!/usr/bin/env python3
"""
Kapruka Page Hygiene Dashboard - backend.

Open dashboard, no login. Only the ingest endpoint is protected:
  - ingest (POST /api/ingest, bearer DASHBOARD_INGEST_KEY) -> used only by
    scripts/hygiene_dashboard_scan.py on the daily scan machine

Storage: a single SQLite file (data.db, created next to this file). Each row is
one product on one batch_date; checklist state (has someone marked this issue
reviewed/fixed) is stored per-flag in the same row and persists across page loads.
"""
from __future__ import annotations
import hashlib, hmac, json, os, sqlite3, time
from pathlib import Path

from fastapi import FastAPI, Request, Response, HTTPException, Depends
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data.db"
STATIC = ROOT / "static"

DASHBOARD_INGEST_KEY = os.environ.get("DASHBOARD_INGEST_KEY", "")

# label: what's wrong, in plain words. why: the money reason, explained like to a
# 5-year-old - one short sentence, no jargon. Kept in sync with scripts/hygiene_dashboard_flags.py.
FLAGS = {
    "heading_desc_mismatch":         {"label": "Page heading doesn't match the description", "why": "Shopper feels tricked and leaves without buying."},
    "name_incomplete":               {"label": "Product name is cut off", "why": "Shopper can't tell what it is, so they skip it."},
    "poor_image_quality":            {"label": "Photos are blurry", "why": "Blurry photos look untrustworthy, so people don't buy."},
    "single_image_important":        {"label": "Only one photo on a popular product", "why": "People want to see it from more angles before buying."},
    "minimal_description_important": {"label": "Barely any description on a popular product", "why": "Not enough info means shoppers don't feel safe buying."},
    "description_illegible_chunk":   {"label": "Description is one giant wall of text", "why": "Nobody reads a big block of text, so they leave."},
    "oos_events_high":               {"label": "Marked out of stock, but people keep visiting it", "why": "People want it but can't buy it - that's a lost sale."},
}

app = FastAPI(title="Kapruka Page Hygiene Dashboard")


def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    con = db()
    con.execute("""
    CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_date TEXT NOT NULL,
        url TEXT NOT NULL,
        product_id TEXT,
        name TEXT,
        category TEXT,
        title TEXT,
        meta_description TEXT,
        description_text TEXT,
        image_count INTEGER,
        low_res_count INTEGER,
        availability TEXT,
        active_users INTEGER,
        views INTEGER,
        impressions INTEGER,
        clicks INTEGER,
        important INTEGER,
        flags TEXT,
        flag_reasons TEXT,
        needs_manual_review INTEGER,
        checklist TEXT,
        created_at TEXT,
        UNIQUE(batch_date, url)
    )
    """)
    con.execute("CREATE INDEX IF NOT EXISTS idx_scans_date ON scans(batch_date)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_scans_category ON scans(category)")
    con.commit()
    con.close()


init_db()


# ---------------------------------------------------------------- auth
def require_ingest_key(request: Request):
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer ") or not DASHBOARD_INGEST_KEY:
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = auth.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(token, DASHBOARD_INGEST_KEY):
        raise HTTPException(status_code=401, detail="bad ingest key")


# ---------------------------------------------------------------- ingest (bearer)
@app.post("/api/ingest")
async def ingest(request: Request, _=Depends(require_ingest_key)):
    body = await request.json()
    batch_date = body.get("batch_date")
    items = body.get("items", [])
    if not batch_date or not isinstance(items, list):
        raise HTTPException(status_code=400, detail="batch_date + items required")

    con = db()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    n = 0
    for it in items:
        url = it.get("url")
        # Carry the checklist forward from this URL's most recent scan (a new
        # batch_date is a brand-new row, so without this every daily re-scan
        # would silently wipe out anyone's "fixed" checkmarks).
        prev = con.execute(
            "SELECT checklist FROM scans WHERE url=? ORDER BY created_at DESC, id DESC LIMIT 1",
            (url,),
        ).fetchone()
        prev_checklist = prev["checklist"] if prev else "{}"
        con.execute("""
        INSERT INTO scans (batch_date, url, product_id, name, category, title, meta_description,
                            description_text, image_count, low_res_count, availability,
                            active_users, views, impressions, clicks, important, flags, flag_reasons,
                            needs_manual_review, checklist, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(batch_date, url) DO UPDATE SET
            product_id=excluded.product_id, name=excluded.name, category=excluded.category,
            title=excluded.title, meta_description=excluded.meta_description,
            description_text=excluded.description_text, image_count=excluded.image_count,
            low_res_count=excluded.low_res_count, availability=excluded.availability,
            active_users=excluded.active_users, views=excluded.views,
            impressions=excluded.impressions, clicks=excluded.clicks, important=excluded.important,
            flags=excluded.flags, flag_reasons=excluded.flag_reasons,
            needs_manual_review=excluded.needs_manual_review, created_at=excluded.created_at
        """, (
            batch_date, url, it.get("product_id"), it.get("name"), it.get("category"),
            it.get("title"), it.get("meta_description"), it.get("description_text"),
            it.get("image_count", 0), it.get("low_res_count", 0), it.get("availability"),
            it.get("active_users", 0), it.get("views", 0), it.get("impressions", 0),
            it.get("clicks", 0), int(bool(it.get("important"))),
            json.dumps(it.get("flags", [])), json.dumps(it.get("flag_reasons", {})),
            int(bool(it.get("needs_manual_review"))), prev_checklist, now,
        ))
        n += 1
    con.commit()
    con.close()
    return {"ok": True, "inserted": n, "batch_date": batch_date}


# ---------------------------------------------------------------- read API
def _row_to_dict(r: sqlite3.Row) -> dict:
    flags = json.loads(r["flags"] or "[]")
    checklist = json.loads(r["checklist"] or "{}")
    # A checked box only means "someone marked this fixed" - the daily re-scan is
    # what actually proves it. If the flag is still in this latest scan's flags,
    # the fix didn't take; still_flagged tells the UI to surface that mismatch
    # instead of trusting the checkbox.
    for flag_key, entry in checklist.items():
        if isinstance(entry, dict):
            entry["still_flagged"] = flag_key in flags
    return {
        "id": r["id"], "batch_date": r["batch_date"], "url": r["url"],
        "product_id": r["product_id"], "name": r["name"], "category": r["category"],
        "title": r["title"], "meta_description": r["meta_description"],
        "description_text": r["description_text"], "image_count": r["image_count"],
        "low_res_count": r["low_res_count"], "availability": r["availability"],
        "active_users": r["active_users"], "views": r["views"],
        "impressions": r["impressions"], "clicks": r["clicks"], "important": bool(r["important"]),
        "flags": flags, "flag_reasons": json.loads(r["flag_reasons"] or "{}"),
        "needs_manual_review": bool(r["needs_manual_review"]),
        "checklist": checklist, "created_at": r["created_at"],
    }


@app.get("/api/flags")
async def flags_meta():
    return FLAGS


# No date filter, by design: this is a running checklist of current issues, not
# per-day snapshots someone has to page through. A product scanned on multiple
# days keeps only its MOST RECENT row (via the ROW_NUMBER window below) so a
# fixed/re-scanned product doesn't leave a stale duplicate in the list.
_LATEST_PER_URL = """
    SELECT * FROM scans WHERE id IN (
        SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY url ORDER BY created_at DESC, id DESC) rn
            FROM scans
        ) WHERE rn = 1
    )
"""


@app.get("/api/categories")
async def categories():
    con = db()
    rows = con.execute(f"SELECT DISTINCT category FROM ({_LATEST_PER_URL}) ORDER BY category").fetchall()
    con.close()
    return [r["category"] for r in rows if r["category"]]


@app.get("/api/products")
async def products(category: str | None = None, flag: str | None = None,
                    only_flagged: bool = True):
    con = db()
    q = f"SELECT * FROM ({_LATEST_PER_URL})"
    params = []
    if category:
        q += " WHERE category=?"
        params.append(category)
    rows = con.execute(q, params).fetchall()
    con.close()
    all_items = [_row_to_dict(r) for r in rows]
    total_scanned = len(all_items)
    pending_review = sum(1 for p in all_items if p["needs_manual_review"])

    # Addressed/fixed/needs-recheck are counted per checked flag (not per product),
    # over every scanned page in this category - not just the ones currently
    # visible under the flag/only_flagged filter below.
    marked_done = 0
    verified_fixed = 0
    recheck_items = []
    for p in all_items:
        for flag_key, entry in p["checklist"].items():
            if not isinstance(entry, dict) or not entry.get("checked"):
                continue
            marked_done += 1
            if entry.get("still_flagged"):
                recheck_items.append({
                    "row_id": p["id"], "url": p["url"],
                    "name": p["name"] or p["title"] or p["url"],
                    "category": p["category"], "flag": flag_key,
                    "label": FLAGS.get(flag_key, {}).get("label", flag_key),
                    "checked_at": entry.get("at"),
                })
            else:
                verified_fixed += 1
    recheck_items.sort(key=lambda x: x["checked_at"] or "", reverse=True)

    out = all_items
    if flag:
        out = [p for p in out if flag in p["flags"]]
    elif only_flagged:
        # needs_manual_review alone (no OPENAI_API_KEY -> flag #1 can't run for
        # ANYONE) must NOT pull an otherwise-clean page into the issues list - that
        # drowned every real flag in noise. Only actual mechanical flags qualify;
        # the pending-review count is surfaced as a single dashboard stat instead.
        out = [p for p in out if p["flags"]]
    out.sort(key=lambda p: -(p["active_users"] or 0))
    return {"count": len(out), "items": out,
            "total_scanned": total_scanned, "pending_review": pending_review,
            "marked_done": marked_done, "verified_fixed": verified_fixed,
            "needs_recheck": len(recheck_items), "recheck_items": recheck_items}


@app.post("/api/checklist/{row_id}")
async def toggle_checklist(row_id: int, request: Request):
    body = await request.json()
    flag_key = body.get("flag")
    checked = bool(body.get("checked"))
    if flag_key not in FLAGS:
        raise HTTPException(status_code=400, detail="unknown flag")
    con = db()
    row = con.execute("SELECT checklist FROM scans WHERE id=?", (row_id,)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="not found")
    checklist = json.loads(row["checklist"] or "{}")
    checklist[flag_key] = {"checked": checked, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    con.execute("UPDATE scans SET checklist=? WHERE id=?", (json.dumps(checklist), row_id))
    con.commit()
    con.close()
    return {"ok": True, "checklist": checklist}


# ---------------------------------------------------------------- static frontend
@app.get("/")
async def index():
    return HTMLResponse((STATIC / "index.html").read_text(encoding="utf-8"))


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


@app.get("/app.js")
async def app_js():
    return Response((STATIC / "app.js").read_text(encoding="utf-8"), media_type="application/javascript")


@app.get("/style.css")
async def style_css():
    return Response((STATIC / "style.css").read_text(encoding="utf-8"), media_type="text/css")
