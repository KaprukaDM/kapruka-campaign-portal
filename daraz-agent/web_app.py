#!/usr/bin/env python3
"""
web_app.py — Flask portal for Daraz Agent
Serves two separate pages:
  /           → landing (index.html)
  /products   → product agent UI (products.html)
  /suppliers  → supplier agent UI (suppliers.html)
  /search     → product search UI (search.html)

API:
  POST /run              → starts a run (products or suppliers)
  GET  /status           → current run status + live log lines
  POST /search/run       → starts a keyword search
  GET  /search/status    → search run status + live log lines
  GET  /report/<n>          → serve a product HTML report
  GET  /supplier-report/<n> → serve a supplier HTML report
"""

import os
import sys
import threading
import json
from datetime import datetime
from pathlib import Path
from flask import Flask, send_file, jsonify, abort, render_template, request

BASE_DIR = Path(__file__).parent
sys.path.insert(0, str(BASE_DIR))

app = Flask(__name__, template_folder="templates", static_folder="static")

REPORTS_DIR          = BASE_DIR / "reports"
SUPPLIER_REPORTS_DIR = BASE_DIR / "supplier_reports"
REPORTS_DIR.mkdir(exist_ok=True)
SUPPLIER_REPORTS_DIR.mkdir(exist_ok=True)

# ── Shared state (products + suppliers) ───────────────────────────────────────
_state = {
    "running":     False,
    "last_run":    None,
    "last_report": None,
    "error":       None,
    "status_msg":  "",
    "log_lines":   [],
}

# ── Shared state (search) ─────────────────────────────────────────────────────
_search_state = {
    "running":     False,
    "last_run":    None,
    "last_report": None,
    "error":       None,
    "status_msg":  "",
    "log_lines":   [],
}


def _log(line: str):
    _state["log_lines"].append(line)
    if len(_state["log_lines"]) > 300:
        _state["log_lines"] = _state["log_lines"][-300:]


def _search_log(line: str):
    _search_state["log_lines"].append(line)
    if len(_search_state["log_lines"]) > 300:
        _search_state["log_lines"] = _search_state["log_lines"][-300:]


def _list_reports(directory: Path) -> list[dict]:
    if not directory.exists():
        return []
    files = sorted(directory.glob("*.html"), key=lambda f: f.stat().st_mtime, reverse=True)
    return [
        {
            "name":  f.name,
            "mtime": datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M"),
        }
        for f in files[:20]
    ]


def _list_search_reports(directory: Path) -> list[dict]:
    if not directory.exists():
        return []
    files = sorted(directory.glob("daraz_*_top*.html"), key=lambda f: f.stat().st_mtime, reverse=True)
    return [
        {
            "name":  f.name,
            "mtime": datetime.fromtimestamp(f.stat().st_mtime).strftime("%b %d, %Y  %I:%M %p"),
        }
        for f in files[:20]
    ]


# ── Pages ─────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/products")
def products_page():
    return render_template("products.html",
                           product_reports=_list_reports(REPORTS_DIR))


@app.route("/suppliers")
def suppliers_page():
    return render_template("suppliers.html",
                           supplier_reports=_list_reports(SUPPLIER_REPORTS_DIR))


@app.route("/search")
def search_page():
    return render_template("search.html",
                           search_reports=_list_search_reports(REPORTS_DIR))


# ── Report file serving ───────────────────────────────────────────────────────

@app.route("/report/<path:filename>")
def serve_report(filename):
    p = REPORTS_DIR / filename
    if not p.exists() or p.suffix != ".html":
        abort(404)
    return send_file(str(p))


@app.route("/supplier-report/<path:filename>")
def serve_supplier_report(filename):
    p = SUPPLIER_REPORTS_DIR / filename
    if not p.exists() or p.suffix != ".html":
        abort(404)
    return send_file(str(p))


# ── Status API (products + suppliers) ─────────────────────────────────────────

@app.route("/status")
def status():
    return jsonify(_state)


# ── Status API (search) ───────────────────────────────────────────────────────

@app.route("/search/status")
def search_status():
    return jsonify(_search_state)


# ── Run API (products + suppliers) ────────────────────────────────────────────

@app.route("/run", methods=["POST"])
def trigger_run():
    if _state["running"]:
        return jsonify({"started": False, "message": "Agent is already running."})

    body       = request.get_json(silent=True) or {}
    agent_type = body.get("type", "products")

    _state["running"]     = True
    _state["error"]       = None
    _state["last_report"] = None
    _state["log_lines"]   = []
    _state["status_msg"]  = "Starting…"

    if agent_type == "products":
        params = {
            "top_n":         body.get("top_n", 20),
            "max_urls":      body.get("max_urls", 50),
            "min_price":     body.get("min_price", 3000),
            "reset_history": body.get("reset_history", False),
        }
        thread = threading.Thread(target=_run_product_agent, kwargs=params, daemon=True)
    else:
        params = {
            "mode":          body.get("mode", "daily"),
            "category":      body.get("category", ""),
            "top_suppliers": body.get("top_suppliers", 5),
            "reset_history": body.get("reset_history", False),
        }
        thread = threading.Thread(target=_run_supplier_agent, kwargs=params, daemon=True)

    thread.start()
    return jsonify({"started": True, "type": agent_type})


# ── Run API (search) ──────────────────────────────────────────────────────────

@app.route("/search/run", methods=["POST"])
def search_run():
    global _search_state
    if _search_state["running"]:
        return jsonify({"started": False, "message": "A search is already running."})

    body       = request.get_json(silent=True) or {}
    keyword    = body.get("keyword", "").strip()
    top_n      = int(body.get("top_n",      50))
    min_price  = int(body.get("min_price",  3000))
    min_rating = int(body.get("min_rating", 4))

    if not keyword:
        return jsonify({"started": False, "message": "No keyword provided."})

    _search_state = {
        "running":     True,
        "log_lines":   [],
        "status_msg":  f'Searching for "{keyword}"…',
        "last_report": None,
        "last_run":    None,
        "error":       None,
    }

    def run():
        global _search_state
        import logging

        class WebHandler(logging.Handler):
            def emit(self, record):
                _search_state["status_msg"] = record.getMessage()[:120]
                _search_log(self.format(record))

        from daraz_search import search, save_html, save_csv

        handler = WebHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        logging.getLogger("daraz_search").addHandler(handler)

        try:
            products = search(keyword, top_n, min_price, min_rating)
            if products:
                html_path = save_html(products, keyword, top_n, min_price, min_rating)
                save_csv(products, keyword, top_n)
                _search_state["last_report"] = f"/report/{html_path.name}"
                _search_state["last_run"]    = datetime.now().strftime("%b %d, %Y  %I:%M %p")
                _search_state["status_msg"]  = "Done! Report generated."
            else:
                _search_state["error"] = "No products found for that keyword."
        except Exception as e:
            _search_state["error"] = str(e)
            _search_log(f"[ERROR] {e}")
        finally:
            logging.getLogger("daraz_search").removeHandler(handler)
            _search_state["running"] = False
            _search_state["last_run"] = datetime.now().strftime("%b %d, %Y  %I:%M %p")

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"started": True})


# ── Agent runners ─────────────────────────────────────────────────────────────

def _run_product_agent(top_n=20, max_urls=50, min_price=3000, reset_history=False):
    try:
        import daraz_agent as da

        da.TOP_N            = top_n
        da.MAX_URLS_PER_DAY = max_urls
        da.MIN_PRICE        = min_price

        if reset_history:
            da.HISTORY_FILE.write_text('{"seen": []}', encoding="utf-8")
            _log("[INFO] History reset.")

        import logging
        class WebHandler(logging.Handler):
            def emit(self, record):
                _state["status_msg"] = record.getMessage()[:100]
                _log(self.format(record))

        handler = WebHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        da.log.addHandler(handler)

        _state["status_msg"] = "Scraping Daraz…"
        report_path = da.main()

        if report_path and report_path.exists():
            _state["last_report"] = f"/report/{report_path.name}"
        else:
            _state["error"] = "No report generated — check logs."

        da.log.removeHandler(handler)

    except Exception as e:
        _state["error"] = str(e)
        _log(f"[ERROR] {e}")
    finally:
        _state["running"]    = False
        _state["last_run"]   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _state["status_msg"] = "Done"


def _run_supplier_agent(mode="daily", category="", top_suppliers=5, reset_history=False):
    try:
        import darazpartner as dp
        import random
        from datetime import date

        dp.TOP_SUPPLIERS = top_suppliers

        if reset_history:
            dp.HISTORY_FILE.write_text('{"seen": []}', encoding="utf-8")
            _log("[INFO] History reset.")

        import logging
        class WebHandler(logging.Handler):
            def emit(self, record):
                _state["status_msg"] = record.getMessage()[:100]
                _log(self.format(record))

        handler = WebHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        dp.log.addHandler(handler)

        if mode == "category":
            keyword  = category.replace(" ", "+")
            keywords = [keyword]
            if " " not in category:
                keywords += [keyword + "+accessories", keyword + "+products", "best+" + keyword]
            _log(f"[INFO] MODE: Category Search — '{category}'")
            _log(f"[INFO] Searching keywords: {keywords}")
            _state["status_msg"] = f"Searching suppliers for '{category}'…"
            raw = dp.get_top_suppliers(keywords, seen=set(), use_dedup=False)
        else:
            seen       = dp.load_history()
            day_offset = date.today().timetuple().tm_yday
            random.seed(day_offset)
            keywords_today = random.sample(dp.DAILY_KEYWORDS, min(8, len(dp.DAILY_KEYWORDS)))
            _log(f"[INFO] MODE: Daily Auto Discovery")
            _log(f"[INFO] Today's keywords: {', '.join(keywords_today)}")
            _state["status_msg"] = "Running daily auto-discovery…"
            raw = dp.get_top_suppliers(keywords_today, seen=seen, use_dedup=True)

        _log(f"[INFO] Found {len(raw)} candidate suppliers")

        if not raw:
            _state["error"] = "No suppliers found. Try a different category."
            return

        _state["status_msg"] = "Finding contact phone numbers…"
        suppliers = dp.enrich_suppliers(raw)

        _state["status_msg"] = "Generating HTML report…"
        report_path = dp.generate_html_report(suppliers, mode=mode, category=category)

        if mode == "daily":
            seen     = dp.load_history()
            new_seen = seen | {dp.supplier_id(s["seller_name"]) for s in suppliers}
            dp.save_history(new_seen)
            _log(f"[INFO] History updated: {len(new_seen)} total seen suppliers")

        if report_path and report_path.exists():
            _state["last_report"] = f"/supplier-report/{report_path.name}"
        else:
            _state["error"] = "No report generated."

        dp.log.removeHandler(handler)

    except Exception as e:
        _state["error"] = str(e)
        _log(f"[ERROR] {e}")
    finally:
        _state["running"]    = False
        _state["last_run"]   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _state["status_msg"] = "Done"


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
