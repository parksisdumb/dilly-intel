#!/usr/bin/env python3
"""
US Census Geocoding API batch geocoder.

Backfills latitude/longitude on intel_properties rows that have a street
address but no coordinates. The Census batch geocoder is free, requires
no API key, accepts up to 10k addresses per request, and is the most
practical way to fill 757k+ missing coordinates across FL DOR, NC OneMap,
and the TX CADs.

Endpoint:
    POST https://geocoding.geo.census.gov/geocoder/locations/addressbatch
    Form fields:
      addressFile  CSV body, columns: id,street,city,state,zip (no header)
      benchmark    'Public_AR_Current'
      format       (ignored — Census always returns CSV regardless)

Response format (CSV, one row per input):
    "<id>","<input>","Match"|"No_Match","Exact"|"Non_Exact",
      "<matched_addr>","<lon>,<lat>","<tigerline>","<side>"

Coordinates are returned LONGITUDE FIRST. The output column is the
literal string `"lon,lat"` (one cell, comma-quoted by csv.reader).

Setup:
    pip install requests supabase python-dotenv

Usage:
    python geocoder.py                          # all sources (skips proptracer)
    python geocoder.py --source=fl_dor_public   # one source
    python geocoder.py --source=nc_onemap_public
    python geocoder.py --source=tx_cad_dcad
    python geocoder.py --source=tx_cad_tad
    python geocoder.py --source=cms_provider_data
    python geocoder.py --resume                 # continue from progress
    python geocoder.py --reset
    python geocoder.py --max-batches=2          # smoke test cap

Each batch is checkpointed to geocoder_progress.json so a Ctrl-C can
resume. We update rows in chunks of 200 ids per UPDATE call to stay under
PostgREST's URL-length cap.
"""
from __future__ import annotations

import argparse
import csv
import io
import sys
import time
from pathlib import Path
from typing import Iterable

import requests

from intel_ingest.progress import Progress
from intel_ingest.supabase_io import make_client

ROOT = Path(__file__).parent
PROGRESS_FILE = ROOT / "geocoder_progress.json"

CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
BENCHMARK = "Public_AR_Current"

# Source_details we backfill. PropTracer always ships coordinates so we
# skip it. EDGAR records are corporations, not properties — also skipped.
DEFAULT_SOURCES = (
    "fl_dor_public",
    "nc_onemap_public",
    "tx_cad_dcad",
    "tx_cad_tad",
    "tx_cad_hcad",
    "cms_provider_data",
)

BATCH_SIZE = 9_000      # below the 10k Census ceiling — keeps payload small
HTTP_TIMEOUT = (30, 600)  # connect, read — Census can take minutes
LOG_INTERVAL = 10_000

# Postgres UPDATE in chunks of 200 IDs to stay under the PostgREST URL cap
DB_UPDATE_CHUNK = 200


def fetch_batch(
    db,
    sources: tuple[str, ...],
    last_id: str | None,
    batch_size: int,
) -> list[dict]:
    """
    Pull the next chunk of rows that need geocoding. We page by id (UUID
    sort, lexicographic) rather than by created_at because there's no
    composite index on (source_detail, created_at) — id is the primary
    key and is always indexed.

    Returns list of {id, street_address, city, state, postal_code, source_detail}.
    """
    # Use the intel_geocoder_pending RPC instead of a bare PostgREST
    # query. PostgREST connection-level statement_timeout (8s) was firing
    # even with the partial index in place; the RPC has its own 60s
    # budget via ALTER FUNCTION SET. Single-source path keeps the planner
    # honest with the partial index predicate; multi-source iterates.
    if len(sources) == 1:
        res = db.rpc(
            "intel_geocoder_pending",
            {
                "p_source_detail": sources[0],
                "p_cursor_id": last_id,
                "p_batch_size": batch_size,
            },
        ).execute()
        return res.data or []

    # Multi-source: round-robin one source at a time so each RPC call
    # uses the indexed single-value predicate.
    out: list[dict] = []
    for src in sources:
        if len(out) >= batch_size:
            break
        remaining = batch_size - len(out)
        res = db.rpc(
            "intel_geocoder_pending",
            {
                "p_source_detail": src,
                "p_cursor_id": last_id,
                "p_batch_size": remaining,
            },
        ).execute()
        out.extend(res.data or [])
    return out


def build_csv(rows: list[dict]) -> tuple[str, dict[str, str]]:
    """
    Build the address-batch CSV body. Returns (csv_text, id_map) where
    id_map[batch_local_id] = original UUID. Census restricts batch IDs
    to integers in some docs but accepts strings up to ~50 chars in
    practice; we use sequential ints for safety.
    """
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_MINIMAL)
    id_map: dict[str, str] = {}
    for i, r in enumerate(rows, start=1):
        local_id = str(i)
        id_map[local_id] = r["id"]
        # Strip commas + quotes from address parts so they don't break CSV
        street = (r.get("street_address") or "").replace('"', "").replace(",", " ")
        city = (r.get("city") or "").replace('"', "").replace(",", " ")
        state = (r.get("state") or "").upper()[:2]
        zip_code = (r.get("postal_code") or "")[:5] or ""
        writer.writerow([local_id, street, city, state, zip_code])
    return buf.getvalue(), id_map


def parse_response(text: str, id_map: dict[str, str]) -> list[tuple[str, float, float]]:
    """
    Parse Census batch response. Returns [(uuid, lat, lon), ...] for each
    matched row. Skips No_Match rows.

    Census output format (per row, CSV):
      "<id>","<input>","Match|No_Match","Exact|Non_Exact",
        "<matched_addr>","<lon>,<lat>","<tigerline>","<side>"

    The `lon,lat` field is a single CSV cell containing both numbers
    separated by a literal comma. csv.reader gives us the cell as one
    string we then split.
    """
    out: list[tuple[str, float, float]] = []
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        if len(row) < 6:
            continue
        local_id = row[0]
        match = row[2]
        coord_cell = row[5] if len(row) > 5 else ""
        if match != "Match" or not coord_cell:
            continue
        # Cell looks like "-77.03,38.89" — split on first comma.
        parts = coord_cell.split(",")
        if len(parts) != 2:
            continue
        try:
            lon = float(parts[0])
            lat = float(parts[1])
        except ValueError:
            continue
        uuid = id_map.get(local_id)
        if uuid:
            out.append((uuid, lat, lon))
    return out


def geocode_batch(csv_body: str) -> str:
    """POST a batch CSV to Census and return the raw response text."""
    files = {
        "addressFile": ("addresses.csv", csv_body, "text/csv"),
        "benchmark": (None, BENCHMARK),
    }
    r = requests.post(CENSUS_URL, files=files, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.text


def update_coords(db, hits: list[tuple[str, float, float]]) -> int:
    """
    Apply lat/lon updates to intel_properties. Both the legacy
    (lat numeric / lng numeric) and the proptracer-era (latitude /
    longitude double precision) columns are kept in sync so that the
    /intelligence map and the property detail panel both work.

    PostgREST doesn't support per-row UPDATE-many in one round trip, so
    we group rows by (lat, lon) — extremely unlikely to cluster — and
    fall back to one PATCH per row. In practice each call is fast.
    """
    n = 0
    for uuid, lat, lon in hits:
        try:
            db.table("intel_properties").update({
                "latitude": lat,
                "longitude": lon,
                "lat": lat,
                "lng": lon,
            }).eq("id", uuid).execute()
            n += 1
        except Exception as e:  # noqa: BLE001
            print(f"[geocoder] update failed for {uuid}: {e}")
    return n


def main() -> int:
    parser = argparse.ArgumentParser(description="US Census Batch Geocoder")
    parser.add_argument(
        "--source", type=str, default=None,
        help="single source_detail (default: all backfill sources)",
    )
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--max-batches", type=int, default=0,
                        help="stop after N batches (smoke test)")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()

    progress = Progress(PROGRESS_FILE)
    if args.reset:
        progress.reset()
        print("[geocoder] progress reset.")
        return 0

    sources = (args.source,) if args.source else DEFAULT_SOURCES
    if args.source and args.source not in DEFAULT_SOURCES:
        print(f"[geocoder] WARN: --source={args.source} not in default backfill set")

    db = make_client()
    last_id = progress.get(f"last_id_{','.join(sources)}") if args.resume else None
    if args.resume and last_id:
        print(f"[geocoder] resume — last_id={last_id}")
    else:
        progress[f"last_id_{','.join(sources)}"] = None
        progress.save()

    total_seen = 0
    total_matched = 0
    total_updated = 0
    batches = 0

    while True:
        if args.max_batches and batches >= args.max_batches:
            print(f"[geocoder] hit --max-batches={args.max_batches}")
            break

        t0 = time.time()
        rows = fetch_batch(db, sources, last_id, args.batch_size)
        if not rows:
            print("[geocoder] no more rows to geocode")
            break

        csv_body, id_map = build_csv(rows)
        try:
            response_text = geocode_batch(csv_body)
        except requests.RequestException as e:
            print(f"[geocoder] Census batch failed: {e}")
            time.sleep(10)
            continue

        hits = parse_response(response_text, id_map)
        updated = update_coords(db, hits)

        # Advance cursor to the largest id we just processed (rows are
        # already sorted ascending by id, so the last row is the cursor).
        last_id = rows[-1]["id"]

        batches += 1
        total_seen += len(rows)
        total_matched += len(hits)
        total_updated += updated

        progress[f"last_id_{','.join(sources)}"] = last_id
        progress["records_processed"] = total_updated
        progress.save()

        elapsed = time.time() - t0
        match_pct = 100.0 * len(hits) / len(rows) if rows else 0.0
        print(
            f"[geocoder] batch {batches}: scanned={len(rows):,} "
            f"matched={len(hits):,} ({match_pct:.1f}%) updated={updated:,} "
            f"in {elapsed:.1f}s | cumulative: seen={total_seen:,} "
            f"matched={total_matched:,} updated={total_updated:,}"
        )

        # Census recommends ~1 req/sec sustained
        time.sleep(1)

    print(
        f"[geocoder] DONE - seen={total_seen:,} matched={total_matched:,} "
        f"updated={total_updated:,}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
