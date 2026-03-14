#!/usr/bin/env python3
"""
run_agent.py — Windows entry point for Daraz Daily Agent
Saves report as HTML (+ optional PDF) and opens it in the browser.
"""

import os
import sys
from pathlib import Path

# ── Load .env if present ───────────────────────────────────────────────────
env_file = Path(__file__).parent / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[7:]          # strip Linux-style prefix if present
        if "=" in line and not line.startswith("#") and line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

sys.path.insert(0, str(Path(__file__).parent))
from daraz_agent import main as run_scraper

if __name__ == "__main__":
    print("🚀 Starting Daraz Daily Agent...")

    report_path = run_scraper()

    if report_path and report_path.exists():
        print(f"\n✅ HTML Report saved:\n   {report_path.resolve()}")

        # ── Optional: also generate PDF using WeasyPrint (if installed) ──
        try:
            from weasyprint import HTML as WP_HTML
            pdf_path = report_path.with_suffix(".pdf")
            WP_HTML(filename=str(report_path)).write_pdf(str(pdf_path))
            print(f"✅ PDF Report saved:\n   {pdf_path.resolve()}")
        except ImportError:
            print("ℹ️  (Install weasyprint to also get a PDF copy)")
        except Exception as e:
            print(f"⚠️  PDF generation failed: {e}")

        # ── Auto-open HTML in default browser ──────────────────────────
        try:
            os.startfile(str(report_path.resolve()))   # Windows only
        except Exception:
            pass

    else:
        print("⚠️  No report generated — check agent.log for details")
        sys.exit(1)
