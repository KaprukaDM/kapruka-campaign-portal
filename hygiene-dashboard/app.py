#!/usr/bin/env python3
"""
Kapruka Page Hygiene Dashboard - backend.

Two auth paths:
  - human login (POST /login, password from DASHBOARD_PASSWORD) -> signed cookie session
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
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data.db"
STATIC = ROOT / "static"

DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
DASHBOARD_INGEST_KEY = os.environ.get("DASHBOARD_INGEST_KEY", "")
SESSION_SECRET = os.environ.get("DASHBOARD_SESSION_SECRET", DASHBOARD_PASSWORD or "change-me")
SESSION_TTL = 60 * 60 * 24 * 14  # 14 days

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
def _sign(payload: str) -> str:
    return hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_session() -> str:
    exp = str(int(time.time()) + SESSION_TTL)
    return f"{exp}.{_sign(exp)}"


def valid_session(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    exp, sig = token.split(".", 1)
    if not hmac.compare_digest(sig, _sign(exp)):
        return False
    return int(exp) > time.time()


def require_session(request: Request):
    if not valid_session(request.cookies.get("session")):
        raise HTTPException(status_code=401, detail="not logged in")


def require_ingest_key(request: Request):
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer ") or not DASHBOARD_INGEST_KEY:
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = auth.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(token, DASHBOARD_INGEST_KEY):
        raise HTTPException(status_code=401, detail="bad ingest key")


@app.post("/login")
async def login(request: Request):
    body = await request.json()
    password = (body or {}).get("password", "")
    if not DASHBOARD_PASSWORD or not hmac.compare_digest(password, DASHBOARD_PASSWORD):
        raise HTTPException(status_code=401, detail="wrong password")
    resp = JSONResponse({"ok": True})
    resp.set_cookie("session", make_session(), max_age=SESSION_TTL, httponly=True, samesite="lax")
    return resp


@app.post("/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("session")
    return resp


@app.get("/api/me")
async def me(request: Request):
    return {"logged_in": valid_session(request.cookies.get("session"))}


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
            batch_date, it.get("url"), it.get("product_id"), it.get("name"), it.get("category"),
            it.get("title"), it.get("meta_description"), it.get("description_text"),
            it.get("image_count", 0), it.get("low_res_count", 0), it.get("availability"),
            it.get("active_users", 0), it.get("views", 0), it.get("impressions", 0),
            it.get("clicks", 0), int(bool(it.get("important"))),
            json.dumps(it.get("flags", [])), json.dumps(it.get("flag_reasons", {})),
            int(bool(it.get("needs_manual_review"))), json.dumps({}), now,
        ))
        n += 1
    con.commit()
    con.close()
    return {"ok": True, "inserted": n, "batch_date": batch_date}


# ---------------------------------------------------------------- read API (session)
def _row_to_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"], "batch_date": r["batch_date"], "url": r["url"],
        "product_id": r["product_id"], "name": r["name"], "category": r["category"],
        "title": r["title"], "meta_description": r["meta_description"],
        "description_text": r["description_text"], "image_count": r["image_count"],
        "low_res_count": r["low_res_count"], "availability": r["availability"],
        "active_users": r["active_users"], "views": r["views"],
        "impressions": r["impressions"], "clicks": r["clicks"], "important": bool(r["important"]),
        "flags": json.loads(r["flags"] or "[]"), "flag_reasons": json.loads(r["flag_reasons"] or "{}"),
        "needs_manual_review": bool(r["needs_manual_review"]),
        "checklist": json.loads(r["checklist"] or "{}"), "created_at": r["created_at"],
    }


@app.get("/api/flags")
async def flags_meta(_=Depends(require_session)):
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
async def categories(_=Depends(require_session)):
    con = db()
    rows = con.execute(f"SELECT DISTINCT category FROM ({_LATEST_PER_URL}) ORDER BY category").fetchall()
    con.close()
    return [r["category"] for r in rows if r["category"]]


@app.get("/api/products")
async def products(category: str | None = None, flag: str | None = None,
                    only_flagged: bool = True, _=Depends(require_session)):
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
            "total_scanned": total_scanned, "pending_review": pending_review}


@app.post("/api/checklist/{row_id}")
async def toggle_checklist(row_id: int, request: Request, _=Depends(require_session)):
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
async def index(request: Request):
    if not valid_session(request.cookies.get("session")):
        return RedirectResponse("/login.html")
    return HTMLResponse((STATIC / "index.html").read_text(encoding="utf-8"))


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


@app.get("/login.html")
async def login_page():
    return HTMLResponse((STATIC / "login.html").read_text(encoding="utf-8"))


@app.get("/app.js")
async def app_js():
    return Response((STATIC / "app.js").read_text(encoding="utf-8"), media_type="application/javascript")


@app.get("/style.css")
async def style_css():
    return Response((STATIC / "style.css").read_text(encoding="utf-8"), media_type="text/css")
