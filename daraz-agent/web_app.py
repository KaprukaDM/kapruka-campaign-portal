#!/usr/bin/env python3
"""
web_app.py — Flask portal for Daraz Agent
Serves two separate pages:
  /           → landing (index.html)
  /products   → product agent UI (products.html)
  /suppliers  → supplier agent UI (suppliers.html)

API:
  POST /run       → starts a run (products or suppliers)
  GET  /status    → current run status + live log lines
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

# ── Shared state ──────────────────────────────────────────────────────────────
_state = {
    "running":    False,
    "last_run":   None,
    "last_report": None,
    "error":      None,
    "status_msg": "",
    "log_lines":  [],
}


def _log(line: str):
    _state["log_lines"].append(line)
    if len(_state["log_lines"]) > 300:
        _state["log_lines"] = _state["log_lines"][-300:]


def _list_reports(directory: Path) -> list[dict]:
    if not directory.exists():
        return []
    files = sorted(directory.glob("*.html"), key=lambda f: f.stat().st_mtime, reverse=True)
    return [
        {
            "name": f.name,
            "mtime": datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M"),
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


# ── Status API ────────────────────────────────────────────────────────────────

@app.route("/status")
def status():
    return jsonify(_state)


# ── Run API ───────────────────────────────────────────────────────────────────

@app.route("/run", methods=["POST"])
def trigger_run():
    if _state["running"]:
        return jsonify({"started": False, "message": "Agent is already running."})

    body = request.get_json(silent=True) or {}
    agent_type = body.get("type", "products")

    _state["running"] = True
    _state["error"] = None
    _state["last_report"] = None
    _state["log_lines"] = []
    _state["status_msg"] = "Starting…"

    if agent_type == "products":
        params = {
            "top_n":          body.get("top_n", 20),
            "max_urls":       body.get("max_urls", 50),
            "min_price":      body.get("min_price", 3000),
            "reset_history":  body.get("reset_history", False),
        }
        thread = threading.Thread(target=_run_product_agent, kwargs=params, daemon=True)
    else:
        params = {
            "mode":           body.get("mode", "daily"),
            "category":       body.get("category", ""),
            "top_suppliers":  body.get("top_suppliers", 5),
            "reset_history":  body.get("reset_history", False),
        }
        thread = threading.Thread(target=_run_supplier_agent, kwargs=params, daemon=True)

    thread.start()
    return jsonify({"started": True, "type": agent_type})


# ── Agent runners ─────────────────────────────────────────────────────────────

def _run_product_agent(top_n=20, max_urls=50, min_price=3000, reset_history=False):
    try:
        import daraz_agent as da

        # Apply runtime config overrides
        da.TOP_N            = top_n
        da.MAX_URLS_PER_DAY = max_urls
        da.MIN_PRICE        = min_price

        if reset_history:
            da.HISTORY_FILE.write_text('{"seen": []}', encoding="utf-8")
            _log("[INFO] History reset.")

        # Monkey-patch the logger to also stream to our _log buffer
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
        _state["running"] = False
        _state["last_run"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
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

        # Monkey-patch logger
        import logging
        class WebHandler(logging.Handler):
            def emit(self, record):
                _state["status_msg"] = record.getMessage()[:100]
                _log(self.format(record))

        handler = WebHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        dp.log.addHandler(handler)

        if mode == "category":
            keyword = category.replace(" ", "+")
            keywords = [keyword]
            if " " not in category:
                keywords += [keyword + "+accessories", keyword + "+products", "best+" + keyword]
            _log(f"[INFO] MODE: Category Search — '{category}'")
            _log(f"[INFO] Searching keywords: {keywords}")
            _state["status_msg"] = f"Searching suppliers for '{category}'…"
            raw = dp.get_top_suppliers(keywords, seen=set(), use_dedup=False)
        else:
            seen = dp.load_history()
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
            seen = dp.load_history()
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
        _state["running"] = False
        _state["last_run"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _state["status_msg"] = "Done"


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
