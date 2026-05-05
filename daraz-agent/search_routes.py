# ─── Add these routes to your existing app.py ────────────────────────────────
# Make sure daraz_search.py is in the same folder as app.py

import threading
from pathlib import Path
from datetime import datetime
from flask import request, jsonify, render_template

# Shared state for the search agent
search_state = {
    "running":     False,
    "log_lines":   [],
    "status_msg":  "",
    "last_report": None,
    "last_run":    None,
    "error":       None,
}


@app.route("/search")
def search_page():
    reports_dir = Path("reports")
    search_reports = []
    if reports_dir.exists():
        files = sorted(reports_dir.glob("daraz_*_top*.html"), key=lambda f: f.stat().st_mtime, reverse=True)
        for f in files[:20]:
            search_reports.append({
                "name":  f.name,
                "mtime": datetime.fromtimestamp(f.stat().st_mtime).strftime("%b %d, %Y  %I:%M %p"),
            })
    return render_template("search.html", search_reports=search_reports)


@app.route("/search/run", methods=["POST"])
def search_run():
    global search_state
    if search_state["running"]:
        return jsonify({"started": False, "message": "A search is already running."})

    data       = request.get_json()
    keyword    = data.get("keyword", "").strip()
    top_n      = int(data.get("top_n",      50))
    min_price  = int(data.get("min_price",  3000))
    min_rating = int(data.get("min_rating", 4))

    if not keyword:
        return jsonify({"started": False, "message": "No keyword provided."})

    # Reset state
    search_state = {
        "running":     True,
        "log_lines":   [],
        "status_msg":  f'Searching for "{keyword}"…',
        "last_report": None,
        "last_run":    None,
        "error":       None,
    }

    def run():
        global search_state
        import logging

        # Capture logs into state
        class StateHandler(logging.Handler):
            def emit(self, record):
                search_state["log_lines"].append(self.format(record))
                search_state["status_msg"] = record.getMessage()[:120]

        from daraz_search import search, save_html, save_csv

        handler = StateHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        logging.getLogger().addHandler(handler)

        try:
            products = search(keyword, top_n, min_price, min_rating)
            if products:
                html_path = save_html(products, keyword, top_n)
                save_csv(products, keyword, top_n)
                search_state["last_report"] = f"/report/{html_path.name}"
                search_state["last_run"]    = datetime.now().strftime("%b %d, %Y  %I:%M %p")
                search_state["status_msg"]  = "Done! Report generated."
            else:
                search_state["error"] = "No products found for that keyword."
        except Exception as e:
            search_state["error"] = str(e)
        finally:
            logging.getLogger().removeHandler(handler)
            search_state["running"] = False

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"started": True})


@app.route("/search/status")
def search_status():
    return jsonify({
        "running":     search_state["running"],
        "log_lines":   search_state["log_lines"],
        "status_msg":  search_state["status_msg"],
        "last_report": search_state["last_report"],
        "last_run":    search_state["last_run"],
        "error":       search_state["error"],
    })
