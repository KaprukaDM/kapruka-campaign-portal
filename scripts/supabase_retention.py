#!/usr/bin/env python3
"""
Supabase retention for the SEO Agent project: keeps Storage and the database from filling the free plan again.

  DRY RUN (default - changes nothing, prints what it WOULD do):
    python scripts/supabase_retention.py --keep-days 14 --payload-days 14
  APPLY:
    python scripts/supabase_retention.py --keep-days 14 --payload-days 14 --apply

Credentials (never hard-code them, never commit them):
    SEO_SUPABASE_URL=https://<ref>.supabase.co     SEO_SUPABASE_SERVICE_KEY=<service_role key>
    (or --key-file path/to/file containing only the service_role key; the URL is read from the key)

What it does
  1. STORAGE  bucket 'seo-agent-data' (override with --bucket)
       - `latest/` is never touched.
       - In `snapshots/<date>/...`, a file whose content (hash) is identical to the same file's previous snapshot is a
         pure repeat and is deleted - nothing is lost, the earlier identical copy stays.
       - Snapshot days older than --keep-days are deleted entirely (0 = keep all history).
  2. DATABASE  table comparison_runs (each row stores a payload of 10-380 KB)
       - For rows older than --payload-days, the big `payload` column is set to NULL. The summary columns
         (matched, kapruka_higher, ...) stay, so history/trends still work.
       - The newest run of every partner is always kept intact, whatever its age.
       - Skip with --payload-days 0.
Deleted storage files and nulled payloads cannot be recovered. Always read the dry run first.
"""
import argparse, base64, collections, datetime as dt, json, os, sys, time, urllib.request, urllib.error

ap = argparse.ArgumentParser()
ap.add_argument("--bucket", default="seo-agent-data")
ap.add_argument("--keep-days", type=int, default=14)
ap.add_argument("--payload-days", type=int, default=14)
ap.add_argument("--key-file")
ap.add_argument("--apply", action="store_true")
a = ap.parse_args()

KEY = open(a.key_file).read().strip() if a.key_file else os.environ.get("SEO_SUPABASE_SERVICE_KEY", "")
if not KEY:
    sys.exit("No service key: set SEO_SUPABASE_SERVICE_KEY or use --key-file")
URL = os.environ.get("SEO_SUPABASE_URL")
if not URL:
    pl = KEY.split(".")[1]; pl += "=" * (-len(pl) % 4)
    URL = "https://%s.supabase.co" % json.loads(base64.urlsafe_b64decode(pl))["ref"]
H = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json"}
MB = 1024 * 1024
TODAY = dt.date.today()


def call(method, path, body=None, extra=None):
    for i in range(3):
        try:
            r = urllib.request.urlopen(urllib.request.Request(URL + path, json.dumps(body).encode() if body is not None else None,
                                                              {**H, **(extra or {})}, method=method), timeout=90)
            return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()[:200]
        except Exception:  # noqa: BLE001
            time.sleep(2)
    return 0, "network error"


print(("APPLYING" if a.apply else "DRY RUN (nothing will be changed)"), "| project:", URL)

# ---------------------------------------------------------------- 1. storage
files = {}
def walk(prefix=""):
    off = 0
    while True:
        st, rows = call("POST", f"/storage/v1/object/list/{a.bucket}", {"prefix": prefix, "limit": 1000, "offset": off, "sortBy": {"column": "name", "order": "asc"}})
        if st != 200:
            sys.exit(f"storage listing failed: {st} {rows}")
        for r in rows:
            full = (prefix + "/" if prefix else "") + r["name"]
            if r.get("id") is None:
                walk(full)
            else:
                m = r.get("metadata") or {}
                files[full] = {"size": int(m.get("size") or 0), "etag": (m.get("eTag") or "").strip('"')}
        if len(rows) < 1000:
            return
        off += 1000
walk()
snap = collections.defaultdict(dict)                      # rel path -> {day: file}
for p, f in files.items():
    parts = p.split("/", 2)
    if parts[0] == "snapshots" and len(parts) == 3:
        snap[parts[2]][parts[1]] = (p, f)
doomed, why = [], {}
for rel, days in snap.items():
    prev_etag = None
    for day in sorted(days):
        p, f = days[day]
        if f["etag"] and f["etag"] == prev_etag:
            doomed.append(p); why[p] = "repeat of previous day"
        else:
            prev_etag = f["etag"]
        if a.keep_days and (TODAY - dt.date.fromisoformat(day)).days > a.keep_days and p not in why:
            doomed.append(p); why[p] = f"older than {a.keep_days} days"
doomed = sorted(set(doomed))
dsize = sum(files[p]["size"] for p in doomed)
cur = sum(f["size"] for f in files.values())
print(f"\nSTORAGE  now {cur/MB:,.0f} MB in {len(files)} files")
for reason in sorted(set(why.values())):
    ps = [p for p in doomed if why[p] == reason]
    print(f"  {reason:28} {len(ps):4} files  {sum(files[p]['size'] for p in ps)/MB:7,.0f} MB")
print(f"  -> would free {dsize/MB:,.0f} MB, leaving {(cur-dsize)/MB:,.0f} MB (free limit 1,024 MB)")
if a.apply and doomed:
    for i in range(0, len(doomed), 50):
        st, res = call("DELETE", f"/storage/v1/object/{a.bucket}", {"prefixes": doomed[i:i + 50]})
        if st != 200:
            sys.exit(f"delete failed: {st} {res}")
    print(f"  deleted {len(doomed)} files")

# ---------------------------------------------------------------- 2. database payloads
if a.payload_days:
    rows, last = [], 0
    while True:                                           # keyset paging: no OFFSET, no timeouts on 8k+ rows
        st, part = call("GET", f"/rest/v1/comparison_runs?select=id,partner_id,created_at&id=gt.{last}&order=id.asc&limit=1000")
        if st != 200:
            sys.exit(f"comparison_runs read failed: {st} {part}")
        rows += part
        if len(part) < 1000:
            break
        last = part[-1]["id"]
    newest = {}
    for r in rows:
        if r["partner_id"] not in newest or r["id"] > newest[r["partner_id"]]:
            newest[r["partner_id"]] = r["id"]
    keep_ids = set(newest.values())
    cutoff = (dt.datetime.now() - dt.timedelta(days=a.payload_days)).isoformat()
    old = [r["id"] for r in rows if r["created_at"] < cutoff and r["id"] not in keep_ids]
    print(f"\nDATABASE comparison_runs: {len(rows)} runs from {len(newest)} partners")
    print(f"  runs older than {a.payload_days} days whose payload would be emptied: {len(old)} ({100*len(old)//max(1,len(rows))}%); "
          f"newest run of each partner ({len(keep_ids)}) stays intact")
    if a.apply and old:
        for i in range(0, len(old), 100):
            ids = ",".join(str(x) for x in old[i:i + 100])
            st, res = call("PATCH", f"/rest/v1/comparison_runs?id=in.({ids})", {"payload": None}, {"Prefer": "return=minimal"})
            if st not in (200, 204):
                sys.exit(f"payload update failed: {st} {res}")
        print(f"  emptied the payload of {len(old)} runs")
print("\nDone." if a.apply else "\nThis was a dry run. Add --apply to make these changes.")
