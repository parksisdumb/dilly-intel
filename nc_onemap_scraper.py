#!/usr/bin/env python3
"""
NC OneMap statewide-parcels scraper.

Hits the NC1Map_Parcels FeatureServer, paginates through the polygons layer
(Layer 1 — Layer 0 is centroid points only) at 5,000 features per call,
filters to commercial use codes, and upserts to intel_properties with
source_detail='nc_onemap_public'.

Endpoint:
  https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1/query

Note the `/secure/` segment is part of the URL path — NOT auth-gated. The
service is fully public. maxRecordCount = 5,000.

Field names (from layer metadata):
  PARNO          parcel number (county-unique, not state-unique)
  OWNNAME        owner full name
  OWNFRST        owner first
  OWNLAST        owner last
  MAILADD        mailing address line
  MUNIT, MCITY,  mailing unit / city / state / zip
    MSTATE, MZIP
  SITEADD        situs street address
  SUNIT, SCITY,  situs unit / city / state / zip
    SSTATE, SZIP
  PARUSECODE     standardized parcel use class (R / C / I / M / O / A / V …)
  PARUSEDESC     description
  PARVAL         total parcel value
  LANDVAL        land value
  IMPROVVAL      improvement value
  GISACRES       acreage from polygon
  COUNTYNAME     county
  COUNTYFP       FIPS suffix (3-digit)
  EFFYEAR / YEAR built year if present (varies by county)

Setup:
    pip install requests supabase python-dotenv

Usage:
    python nc_onemap_scraper.py                  # full statewide run
    python nc_onemap_scraper.py --county "Mecklenburg"
    python nc_onemap_scraper.py --resume
    python nc_onemap_scraper.py --reset
    python nc_onemap_scraper.py --max-features 10000   # smoke test
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import requests

from intel_ingest import (
    SupabaseUpserter,
    Progress,
    classify_nc_paruse,
    is_commercial_nc,
)

ROOT = Path(__file__).parent
PROGRESS_FILE = ROOT / "progress_nc.json"
SOURCE_DETAIL = "nc_onemap_public"

QUERY_URL = (
    "https://services.nconemap.gov/secure/rest/services/"
    "NC1Map_Parcels/FeatureServer/1/query"
)
PAGE_SIZE = 5_000  # advertised maxRecordCount
HTTP_TIMEOUT = (15, 300)
LOG_INTERVAL = 10_000


def _normalize_int(v) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _normalize_float(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _str(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def map_feature(attr: dict) -> dict | None:
    """
    Map one ArcGIS feature attribute dict to an intel_properties payload.
    Returns None for non-commercial / missing-required-field rows.

    NOTE: NC OneMap layer 1 returns LOWERCASE field names. ArcGIS REST is
    case-sensitive on attribute lookups, so this function uses lowercase
    keys throughout: parusecode, parusedesc, parusecd2, parusedsc2, parno,
    cntyname, cntyfips, siteadd, scity, sstate, szip, ownname, mailadd,
    mcity, mstate, mzip, parval, gisacres, structyear.
    """
    code = attr.get("parusecode") or ""
    desc = attr.get("parusedesc") or ""
    code2 = attr.get("parusecd2") or ""
    desc2 = attr.get("parusedsc2") or ""

    if not is_commercial_nc(code, desc, code2, desc2):
        return None

    parno = _str(attr.get("parno"))
    if not parno:
        return None

    county = _str(attr.get("cntyname"))
    if not county:
        return None

    site_addr = _str(attr.get("siteadd"))
    site_city = _str(attr.get("scity"))
    if not site_addr or not site_city:
        return None

    bucket, desc_label, _ = classify_nc_paruse(code, desc, code2, desc2)

    # cntyfips is the 3-digit county portion; assemble a 5-digit state+county
    # FIPS by prefixing NC's state FIPS (37). Some rows ship the full
    # `stcntyfips` 5-digit code already — prefer it when populated.
    full_fips = _str(attr.get("stcntyfips"))
    if not full_fips:
        suffix = _str(attr.get("cntyfips"))
        full_fips = ("37" + suffix.zfill(3)) if suffix else None

    fips_suffix = (full_fips or "")[-3:] if full_fips else "NC"
    external_id = f"{fips_suffix}-{parno}"

    mail_addr = _str(attr.get("mailadd"))
    mail_city = _str(attr.get("mcity"))
    mail_state = _str(attr.get("mstate"))
    mail_zip = _str(attr.get("mzip"))

    # Acreage to lot_size_sqft (1 acre = 43560 sqft).
    acres = _normalize_float(attr.get("gisacres"))
    lot_sqft = round(acres * 43560.0, 1) if acres else None

    # Year built — `structyear` is the column for built-year on layer 1.
    year_built = _normalize_int(attr.get("structyear"))

    # Capture a raw use_code that's actually meaningful — prefer code, fall
    # back to code2, then desc.
    raw_use = (code or code2 or "").strip().upper() or None

    return {
        "external_id": external_id,
        "source_detail": SOURCE_DETAIL,
        "street_address": site_addr,
        "city": site_city,
        "state": _str(attr.get("sstate")) or "NC",
        "postal_code": (_str(attr.get("szip")) or "")[:10] or None,
        "county": county,
        "county_fips": full_fips,
        "owner_name": _str(attr.get("ownname")),
        "raw_owner_name": _str(attr.get("ownname")),
        "owner_mailing_address": mail_addr,
        "owner_mailing_city": mail_city,
        "owner_mailing_state": mail_state,
        "owner_mailing_zip": (mail_zip or "")[:10] or None,
        "property_type": bucket,
        "property_use_code": raw_use,
        "property_use_desc": desc_label,
        "estimated_value": _normalize_float(attr.get("parval")),
        "assessed_value": _normalize_int(attr.get("parval")),
        "lot_size_sqft": lot_sqft,
        "year_built": year_built,
    }


def fetch_page(
    session: requests.Session,
    where: str,
    offset: int,
    page_size: int,
) -> dict:
    """One paginated request. Caller handles retries on transient errors."""
    params = {
        "where": where,
        "outFields": "*",
        "returnGeometry": "false",
        "f": "json",
        "resultOffset": offset,
        "resultRecordCount": page_size,
        # Stable order — required for paged extraction. NC OneMap layer 1
        # uses lowercase `objectid`.
        "orderByFields": "objectid ASC",
    }
    r = session.get(QUERY_URL, params=params, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.json()


def run_debug(args, where: str) -> int:
    """
    Pull `--debug-count` records and print every field plus the classifier
    verdict. Skips Supabase entirely. Use to verify field-name mapping and
    confirm what the classifier is actually deciding.
    """
    n = max(1, args.debug_count)
    print(f"[nc] DEBUG: dumping first {n} records (no upserts)")
    print(f"[nc] DEBUG: where = {where!r}")
    session = requests.Session()
    session.headers.update({"User-Agent": "DillyIntel/1.0"})

    fetched = 0
    offset = 0
    keep_count = 0
    skip_reasons: dict[str, int] = {}

    while fetched < n:
        page = min(PAGE_SIZE, n - fetched)
        try:
            data = fetch_page(session, where, offset, page)
        except requests.RequestException as e:
            print(f"[nc] DEBUG fetch error at offset {offset}: {e}")
            return 1
        features = data.get("features", []) or []
        if not features:
            print(f"[nc] DEBUG: no more features at offset {offset}")
            break
        for feat in features:
            attr = feat.get("attributes") or {}
            _print_debug_record(fetched, attr)

            # Classifier verdict
            code = attr.get("parusecode") or ""
            desc = attr.get("parusedesc") or ""
            code2 = attr.get("parusecd2") or ""
            desc2 = attr.get("parusedsc2") or ""
            bucket, label, is_comm = classify_nc_paruse(code, desc, code2, desc2)
            verdict = "KEEP" if is_comm else "skip"
            print(f"  -> classifier: {verdict} | bucket={bucket} | desc={label!r}")

            if is_comm:
                payload = map_feature(attr)
                if payload is None:
                    reason = "missing required fields (address/city/parno/county)"
                    skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
                    print(f"  -> map_feature: SKIP — {reason}")
                else:
                    keep_count += 1
                    print(f"  -> map_feature: payload built")
            else:
                reason = f"classifier rejected ({label})"
                skip_reasons[reason] = skip_reasons.get(reason, 0) + 1

            fetched += 1
            if fetched >= n:
                break
        offset += len(features)

    print()
    print(f"[nc] DEBUG SUMMARY: fetched={fetched} kept={keep_count}")
    print(f"[nc] DEBUG skip reasons:")
    for reason, count in sorted(skip_reasons.items(), key=lambda x: -x[1]):
        print(f"  {count:5d}  {reason}")
    return 0


def _print_debug_record(idx: int, attr: dict) -> None:
    """Pretty-print one raw NC OneMap feature for the --debug flag."""
    print(f"\n=== record {idx + 1} ===")
    # Show classification-relevant fields first, then everything else.
    primary = ["parno", "cntyname", "cntyfips", "stcntyfips",
               "parusecode", "parusedesc", "parusecd2", "parusedsc2",
               "siteadd", "scity", "sstate", "szip",
               "ownname", "mailadd", "mcity", "mstate", "mzip",
               "parval", "landval", "improvval", "gisacres",
               "struct", "structyear"]
    seen = set()
    for k in primary:
        if k in attr:
            seen.add(k)
            print(f"  {k:14s} = {attr[k]!r}")
    other = sorted(k for k in attr.keys() if k not in seen)
    if other:
        print(f"  --- other ({len(other)}) ---")
        for k in other:
            print(f"  {k:14s} = {attr[k]!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description="NC OneMap parcels scraper")
    parser.add_argument("--county", type=str, default=None,
                        help='single county filter (e.g. "Mecklenburg")')
    parser.add_argument("--max-features", type=int, default=0,
                        help="stop after N features (0 = no cap)")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument(
        "--debug",
        action="store_true",
        help=(
            "Print the first 100 raw feature records (all fields) AND the "
            "classifier verdict for each. Does NOT upsert to Supabase. Use "
            "this to verify field mapping or debug the classifier."
        ),
    )
    parser.add_argument(
        "--debug-count",
        type=int,
        default=100,
        help="number of records to dump in --debug mode (default 100)",
    )
    args = parser.parse_args()

    progress = Progress(PROGRESS_FILE)
    if args.reset:
        progress.reset()
        print("[nc] progress reset.")
        return 0

    where = "1=1"
    if args.county:
        # ArcGIS field is lowercase `cntyname`. Single-quote-escape input.
        county = args.county.replace("'", "''").upper()
        where = f"UPPER(cntyname) = '{county}'"

    if args.debug:
        return run_debug(args, where)

    offset = progress.get("last_offset", 0) if args.resume else 0
    if args.resume and offset:
        print(f"[nc] resuming at offset {offset:,}")
    else:
        progress["last_offset"] = 0
        progress.save()

    upserter = SupabaseUpserter(source_detail=SOURCE_DETAIL)
    session = requests.Session()
    session.headers.update({"User-Agent": "DillyIntel/1.0"})

    total_seen = 0
    total_kept = 0
    consecutive_errors = 0

    while True:
        if args.max_features and total_seen >= args.max_features:
            print(f"[nc] hit --max-features cap ({args.max_features:,})")
            break

        try:
            data = fetch_page(session, where, offset, PAGE_SIZE)
        except requests.RequestException as e:
            consecutive_errors += 1
            print(f"[nc] page error at offset {offset}: {e}")
            if consecutive_errors >= 5:
                print("[nc] too many consecutive errors — bailing")
                break
            import time
            time.sleep(5 * consecutive_errors)
            continue

        consecutive_errors = 0
        features = data.get("features", []) or []
        if not features:
            break

        for feat in features:
            attr = feat.get("attributes") or {}
            total_seen += 1
            payload = map_feature(attr)
            if payload is not None:
                upserter.add(payload)
                total_kept += 1
            if total_seen % LOG_INTERVAL == 0:
                print(
                    f"[nc] offset~{offset + total_seen:,} kept={total_kept:,} "
                    f"upserted={upserter.upserted:,} skipped="
                    f"{upserter.skipped_missing_address:,}"
                )

        # ArcGIS exceededTransferLimit signals more pages remain.
        exceeded = data.get("exceededTransferLimit", False)
        offset += len(features)

        progress["last_offset"] = offset
        progress["records_processed"] = upserter.upserted
        progress.save()

        if not exceeded and len(features) < PAGE_SIZE:
            break

    upserter.flush()
    print(
        f"[nc] DONE — seen={total_seen:,} kept={total_kept:,} "
        f"upserted={upserter.upserted:,} stats={upserter.stats()}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
