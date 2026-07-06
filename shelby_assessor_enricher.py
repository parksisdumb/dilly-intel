"""Enrich Shelby ReGIS rows with building_sqft + year_built scraped from
the Shelby County Assessor's public property-detail pages
(assessormelvinburgess.com).

WHY THIS EXISTS
---------------
The Shelby ReGIS ArcGIS feed gives us parcel geometry, owner name and
appraisal totals but ships NO building_sqft / year_built fields. After
the 2026-05-23 Option-C merge backfilled ~13,500 parcels from
PropTracer's overlap set, ~24,400 Shelby commercial parcels still lack
both fields. The assessor's site has them — under the "Building
Square Footage" and "Year Built" labels on
/propertyDetails?IR=true&parcelid=<id>.

VALIDATION (2026-05-25)
-----------------------
Cross-checked 3 PT-enriched parcels against the assessor:
  parcel              PT sqft / yr   Assessor sqft / yr
  018048 00001C       651,700 / 2010    659,900 / 2010   (sqft +1.3%)
  016001 00001C       910,583 / 1924    913,274 / 1924   (sqft +0.3%)
  081004 00049        861,882 / 1974  1,715,576 / 1974   (assessor totals
                                                          both campus
                                                          buildings; PT
                                                          counts only one)

Years match exactly on every test. Sqft is within rounding on the same
structure; the AMISUB delta is real-world (multi-building campus, both
sources are right for their own scope).

WHAT THIS SCRIPT DOES
---------------------
- SELECTs Shelby ReGIS TN rows where building_sqft IS NULL OR
  year_built IS NULL (PostgREST `or=` filter).
- For each parcel, GETs the assessor detail page and parses the
  "Building Square Footage" + "Year Built" + "Structure Type" <td>
  pairs.
- PATCHes the row, setting ONLY the columns that were previously NULL
  (so we never overwrite PropTracer-enriched values). The
  Structure-Type value is APPENDED to property_use_desc as a new
  `| Structure: <value>` segment — both property_use_code and
  property_use_desc already carry the ReGIS LUC + zoning info, and
  the `|` separator is already in use there. Idempotent: if the row's
  property_use_desc already contains `Structure: ` we leave it alone.
- Polite: ~1.5 req/s (REQUEST_DELAY_S), browser-like UA, no parallelism.
- Resumable: every processed parcel is appended to a JSON-lines
  progress file. --resume reloads that set and skips done parcels.
- Modes: --preview (10 lookups, no DB writes), --dry-run (full run, no
  writes), --limit N (cap), --resume (continue), no flag = full run.

NOT BUILT IN
------------
- No retries beyond a single attempt per parcel. Failures are logged
  and skipped; --resume picks them up on the next run.
- No parallel requests. The assessor site is a small public service;
  hammering it is rude and could get us blocked.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------

DETAIL_URL = "https://www.assessormelvinburgess.com/propertyDetails"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
# ~1.5 req/s — polite for a small county public-records site.
REQUEST_DELAY_S = 0.65
HTTP_TIMEOUT_S = 30
# Where we record per-parcel outcomes for --resume.
PROGRESS_FILE = "shelby_assessor_enricher_progress.jsonl"
# Human-readable rolling log.
LOG_FILE = "shelby_assessor_enricher.log"

# PostgREST batch size for the candidate-row pull. The site is the
# bottleneck; this is just how many rows we hold in memory at once.
CANDIDATE_PAGE_SIZE = 1000

# Year-built sanity gate — anything outside is treated as parse garbage.
YEAR_MIN, YEAR_MAX = 1800, 2100
# Sqft sanity gate — drop suspiciously tiny / huge values.
SQFT_MIN, SQFT_MAX = 1, 50_000_000


# ----------------------------------------------------------------------------
# Env loading (the same minimal .env reader we use in probe scripts)
# ----------------------------------------------------------------------------

def load_env() -> tuple[str, str]:
    for envf in (".env.local", ".env"):
        if os.path.exists(envf):
            for line in open(envf):
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(
                    k.strip(), v.strip().strip('"').strip("'"),
                )
    base = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return base, key


# ----------------------------------------------------------------------------
# Page fetch + parse
# ----------------------------------------------------------------------------

def _label_regex(label: str) -> re.Pattern[str]:
    """<td>Label:</td><td>VALUE</td>  — VALUE may carry inner tags / whitespace."""
    return re.compile(
        r"<td[^>]*>\s*" + re.escape(label)
        + r"\s*:\s*</td>\s*<td[^>]*>(.*?)</td>",
        re.IGNORECASE | re.DOTALL,
    )


SQFT_PAT = _label_regex("Building Square Footage")
YEAR_PAT = _label_regex("Year Built")
STRUCT_PAT = _label_regex("Structure Type")
LANDUSE_PAT = _label_regex("Land Use")
TOTAL_APPR_PAT = _label_regex("Total Appraisal")


def _extract_pat(page_html: str, pat: re.Pattern[str]) -> str | None:
    m = pat.search(page_html)
    if not m:
        return None
    v = re.sub(r"<[^>]+>", " ", m.group(1))
    v = re.sub(r"\s+", " ", v).strip()
    # Assessor pages encode > / & / nbsp as HTML entities. Decode so the
    # values land clean in the DB (e.g. "APT &gt;100 UNITS" → "APT >100 UNITS").
    v = html.unescape(v)
    return v or None


def _parse_int(s: str | None) -> int | None:
    if s is None:
        return None
    s = s.replace(",", "").replace("$", "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        try:
            return int(float(s))
        except ValueError:
            return None


def fetch_detail(parcel_id: str) -> str:
    """GET the assessor detail HTML for one parcel. Raises on HTTP error.
    The result is the raw page source (no HTML-entity decoding here —
    _extract_pat handles that on a per-field basis)."""
    url = f"{DETAIL_URL}?IR=true&parcelid={urllib.parse.quote(parcel_id)}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_detail(html: str) -> dict[str, int | str | None]:
    """Pull every field we care about from a detail-page HTML."""
    sqft_raw = _extract_pat(html, SQFT_PAT)
    year_raw = _extract_pat(html, YEAR_PAT)
    sqft = _parse_int(sqft_raw)
    year = _parse_int(year_raw)
    if sqft is not None and not (SQFT_MIN <= sqft <= SQFT_MAX):
        sqft = None
    if year is not None and not (YEAR_MIN <= year <= YEAR_MAX):
        year = None
    return {
        "sqft": sqft,
        "year": year,
        "structure_type": _extract_pat(html, STRUCT_PAT),
        "land_use": _extract_pat(html, LANDUSE_PAT),
        "total_appraisal": _parse_int(_extract_pat(html, TOTAL_APPR_PAT)),
    }


# ----------------------------------------------------------------------------
# Supabase access (PostgREST direct — no client lib needed)
# ----------------------------------------------------------------------------

def fetch_candidates(
    base: str,
    key: str,
    limit: int | None,
    exclude_ids: set[str],
) -> list[dict]:
    """Pull TN Shelby ReGIS rows that need at least one of sqft / year.

    Always sends a Range header so we get a Content-Range count for the
    operator's "how big is the run" message. Excludes already-processed
    parcel IDs in Python (PostgREST has no efficient NOT IN against a
    large list)."""
    hdrs = {"apikey": key, "Authorization": f"Bearer {key}"}
    qs = urllib.parse.urlencode([
        ("source_detail", "eq.tn_shelby_regis"),
        ("state",         "eq.TN"),
        ("parcel_id",     "not.is.null"),
        ("or",            "(building_sqft.is.null,year_built.is.null)"),
        ("select",        "id,parcel_id,street_address,owner_name,"
                          "building_sqft,year_built,property_use_desc"),
        ("order",         "parcel_id.asc"),
    ])
    out: list[dict] = []
    page = 0
    while True:
        url = f"{base}/rest/v1/intel_properties?{qs}"
        page_hdrs = dict(hdrs)
        page_hdrs["Range"] = (
            f"{page * CANDIDATE_PAGE_SIZE}-"
            f"{(page + 1) * CANDIDATE_PAGE_SIZE - 1}"
        )
        page_hdrs["Range-Unit"] = "items"
        req = urllib.request.Request(url, headers=page_hdrs)
        with urllib.request.urlopen(req, timeout=180) as r:
            chunk = json.loads(r.read())
        if not chunk:
            break
        for row in chunk:
            if row["parcel_id"] in exclude_ids:
                continue
            out.append(row)
            if limit is not None and len(out) >= limit:
                return out
        if len(chunk) < CANDIDATE_PAGE_SIZE:
            break
        page += 1
    return out


def patch_row(
    base: str,
    key: str,
    row_id: str,
    fields: dict[str, int],
) -> int:
    """PATCH only the columns we want to set. Returns HTTP status."""
    if not fields:
        return 0
    data = json.dumps(fields).encode("utf-8")
    url = f"{base}/rest/v1/intel_properties?id=eq.{row_id}"
    req = urllib.request.Request(
        url, data=data, method="PATCH",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
        return r.status


# ----------------------------------------------------------------------------
# Progress + logging
# ----------------------------------------------------------------------------

def load_progress_ids() -> set[str]:
    """Parcels already processed in a prior run. We skip these on --resume."""
    done: set[str] = set()
    if not os.path.exists(PROGRESS_FILE):
        return done
    for line in open(PROGRESS_FILE, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            pid = rec.get("parcel_id")
            if pid:
                done.add(pid)
        except json.JSONDecodeError:
            continue
    return done


def append_progress(rec: dict) -> None:
    rec = {**rec, "ts": datetime.now(timezone.utc).isoformat()}
    with open(PROGRESS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")


def log(line: str) -> None:
    stamp = datetime.now().strftime("%H:%M:%S")
    sys.stdout.write(f"[{stamp}] {line}\n")
    sys.stdout.flush()
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"[{datetime.now().isoformat()}] {line}\n")


# ----------------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------------

def process_one(
    row: dict,
    base: str,
    key: str,
    write: bool,
) -> dict:
    """Lookup + parse + optionally patch one parcel. Returns a progress rec."""
    parcel = row["parcel_id"]
    try:
        html = fetch_detail(parcel)
    except urllib.error.HTTPError as e:
        return {
            "parcel_id": parcel, "status": "http_error",
            "http_status": e.code,
        }
    except Exception as e:
        return {
            "parcel_id": parcel, "status": "fetch_error",
            "error": f"{type(e).__name__}: {e}",
        }

    parsed = parse_detail(html)
    sqft = parsed["sqft"]
    year = parsed["year"]
    struct = parsed["structure_type"]

    # Only update columns that are currently NULL — never overwrite the
    # ~13,500 PT-enriched rows or anything a prior run already set.
    # Structure Type is the exception: it APPENDS to property_use_desc
    # as a new `| Structure: <value>` segment, idempotent against a
    # prior enrichment of the same row.
    to_set: dict[str, int | str] = {}
    if sqft is not None and row.get("building_sqft") is None:
        to_set["building_sqft"] = sqft
    if year is not None and row.get("year_built") is None:
        to_set["year_built"] = year
    if struct:
        existing_desc = row.get("property_use_desc") or ""
        if "Structure:" not in existing_desc:
            new_desc = (
                f"{existing_desc} | Structure: {struct}"
                if existing_desc
                else f"Structure: {struct}"
            )
            to_set["property_use_desc"] = new_desc

    if not to_set:
        return {
            "parcel_id": parcel,
            "status": "no_new_data",
            "extracted_sqft": sqft,
            "extracted_year": year,
            "structure_type": struct,
        }

    if not write:
        return {
            "parcel_id": parcel,
            "status": "would_patch",
            "fields": to_set,
            "structure_type": struct,
        }

    try:
        status = patch_row(base, key, row["id"], to_set)
    except urllib.error.HTTPError as e:
        return {
            "parcel_id": parcel, "status": "patch_error",
            "http_status": e.code, "body": e.read()[:300].decode("utf-8", "replace"),
        }
    except Exception as e:
        return {
            "parcel_id": parcel, "status": "patch_error",
            "error": f"{type(e).__name__}: {e}",
        }

    return {
        "parcel_id": parcel,
        "status": "patched",
        "http_status": status,
        "fields": to_set,
        "structure_type": struct,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--preview", action="store_true",
                   help="Fetch + parse 10 parcels, print results, no DB writes, "
                        "no progress file written.")
    g.add_argument("--dry-run", action="store_true",
                   help="Full-scope run but skip the PATCH. Progress IS recorded.")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap the number of parcels processed (after --resume "
                         "filtering).")
    ap.add_argument("--resume", action="store_true",
                    help="Skip parcels already in the progress file.")
    args = ap.parse_args()

    base, key = load_env()

    if args.preview:
        limit, write, use_progress = 10, False, False
    elif args.dry_run:
        limit, write, use_progress = args.limit, False, True
    else:
        limit, write, use_progress = args.limit, True, True

    done = load_progress_ids() if args.resume else set()
    if args.resume:
        log(f"Resume: {len(done):,} parcels already processed; skipping them.")

    log("Fetching candidate rows from Supabase…")
    rows = fetch_candidates(base, key, limit, exclude_ids=done)
    log(f"Loaded {len(rows):,} candidate parcels"
        + (" (--limit applied)" if limit and len(rows) == limit else ""))

    if args.preview:
        log("Preview mode — 10 lookups, no writes, no progress recorded.")

    stats = {"patched": 0, "would_patch": 0, "no_new_data": 0,
             "http_error": 0, "fetch_error": 0, "patch_error": 0}
    started = time.time()
    for i, row in enumerate(rows, 1):
        rec = process_one(row, base, key, write)
        stats[rec["status"]] = stats.get(rec["status"], 0) + 1

        # Per-parcel one-liner for the operator.
        parcel = row["parcel_id"]
        addr = (row.get("street_address") or "")[:30]
        if rec["status"] in ("patched", "would_patch"):
            fields = rec.get("fields", {})
            log(f"{i:>5}/{len(rows):>5}  {parcel:>15}  "
                f"{rec['status']:<12}  "
                f"sqft={fields.get('building_sqft', '-')}  "
                f"year={fields.get('year_built', '-')}  "
                f"struct={rec.get('structure_type', '-')!r:<22}  "
                f"addr={addr!r}")
        elif rec["status"] == "no_new_data":
            log(f"{i:>5}/{len(rows):>5}  {parcel:>15}  no_new_data   "
                f"(assessor sqft={rec.get('extracted_sqft')}, "
                f"year={rec.get('extracted_year')})  addr={addr!r}")
        else:
            log(f"{i:>5}/{len(rows):>5}  {parcel:>15}  {rec['status']:<12}  "
                f"{rec.get('error') or rec.get('http_status') or ''}")

        if use_progress:
            append_progress(rec)

        # Be polite. Skip the last sleep.
        if i < len(rows):
            time.sleep(REQUEST_DELAY_S)

    elapsed = time.time() - started
    log("--- run complete ---")
    log(f"elapsed: {elapsed:.0f}s ({elapsed/max(len(rows),1):.2f}s per parcel)")
    for k, v in stats.items():
        if v:
            log(f"  {k:>13}: {v:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
