# Page Hygiene Dashboard

Source backup — the running instance is deployed separately (like `daraz-agent/`),
not served through this Cloudflare Pages site.

**Live:** http://23.111.183.110:8090 (password-gated)
**Runs on:** the same VPS as this portal, its own port (8090), own folder
(`C:\apps\kapruka-hygiene-dashboard` on the VPS), own scheduled task. Does not
touch the campaign-portal IIS site on port 80.

Daily audit of Kapruka product pages (up to 200/day) for 7 CVR issues: blurry
photos, incomplete names, thin/illegible descriptions, heading/description
mismatches (OpenAI-verified), and out-of-stock pages that still get real
traffic. Importance is weighted by GA4 + Search Console signals. Results land
in a filterable dashboard with a persistent per-issue checklist.

Run locally:
```
pip install -r requirements.txt
set DASHBOARD_PASSWORD=... & set DASHBOARD_INGEST_KEY=... & set DASHBOARD_SESSION_SECRET=...
python -m uvicorn app:app --port 8090
```

Daily scan is driven from `scripts/hygiene_dashboard_scan.py` in the SEO Agent
project (separate repo), which POSTs results to `/api/ingest`.
