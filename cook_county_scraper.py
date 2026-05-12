#!/usr/bin/env python3
"""
Cook County (Chicago) commercial property scraper.

Cook County publishes its data on Socrata at
datacatalog.cookcountyil.gov. No single dataset has everything we need
so we join two:

  * Assessor - Commercial Valuation Data (csik-bsws)
        Already filtered to commercial-only. Has bldgsf, address,
        property class, market value, property_type_use.

  * Assessor - Parcel Addresses (3723-97qp)
        Adds property_city, property_zip, owner_name (taxpayer mailing
        name). Joined on PIN.

Setup:
    pip install requests supabase python-dotenv

Usage:
    python cook_county_scraper.py
    python cook_county_scraper.py --max=1000        # smoke test
    python cook_county_scraper.py --resume          # continue after crash
    python cook_county_scraper.py --reset
    python cook_county_scraper.py --year=2025       # tax year filter

Compliance:
    Cook County Open Data is public; no API key required, though
    setting SOCRATA_APP_TOKEN raises rate limits.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

from intel_ingest.progress import Progress
from intel_ingest.supabase_io import SupabaseUpserter
from intel_ingest import socrata

ROOT = Path(__file__).parent
PROGRESS_FILE = ROOT / "progress_cook.json"

HOST = "datacatalog.cookcountyil.gov"
DATASET_COMMERCIAL = "csik-bsws"   # Assessor - Commercial Valuation Data
DATASET_ADDRESSES = "3723-97qp"    # Assessor - Parcel Addresses
SOURCE_DETAIL = "cook_county_il_public"
COUNTY_FIPS = "17031"               # Cook County, IL

# Cook County class codes (3 digits) — bucket by leading digit.
# Source: Cook County Assessor classification manual.
#   5xx = commercial (retail, office, mixed-use)
#   6xx = industrial / warehouses
#   3xx-4xx = multifamily 7+ units (4-99 = 6+ unit residential income)
#   8xx = special (utilities, rail, vacant commercial)
#   9xx = condominiums (commercial-condos appear here too)
def classify_cook_class(class_code: str | None, ptype: str | None) -> tuple[str, str, bool]:
    """
    Returns (bucket, description, is_commercial). Mirrors the bucket set
    used by the rest of intel_ingest (office, retail, industrial,
    multifamily, healthcare, hospitality, self_storage, mixed_use,
    other_commercial).
    """
    code = (class_code or "").strip().upper()
    pt = (ptype or "").strip().lower()

    # Property-use text from the Commercial Valuation dataset is the
    # cleanest signal when present.
    if pt:
        if "office" in pt:
            return ("office", f"Office ({pt})", True)
        if "retail" in pt or "shopping" in pt or "store" in pt or "restaurant" in pt:
            return ("retail", f"Retail ({pt})", True)
        if "industrial" in pt or "warehouse" in pt or "manufactur" in pt or "flex" in pt:
            return ("industrial", f"Industrial ({pt})", True)
        if "apartment" in pt or "multi" in pt or "residential income" in pt:
            return ("multifamily", f"Multifamily ({pt})", True)
        if "hotel" in pt or "motel" in pt or "lodging" in pt:
            return ("hospitality", f"Hospitality ({pt})", True)
        if "medical" in pt or "hospital" in pt or "nursing" in pt or "clinic" in pt:
            return ("healthcare", f"Healthcare ({pt})", True)
        if "storage" in pt:
            return ("self_storage", f"Self storage ({pt})", True)
        if "mixed" in pt:
            return ("mixed_use", f"Mixed use ({pt})", True)

    # Fallback: leading digit of class code.
    if code:
        head = code[0]
        if head == "5":
            return ("retail", f"Cook class {code}", True)  # ambiguous but commercial
        if head == "6":
            return ("industrial", f"Cook class {code}", True)
        if head in {"3", "4"}:
            return ("multifamily", f"Cook class {code}", True)
        if head == "8":
            return ("other_commercial", f"Cook class {code}", True)
        if head == "9":
            return ("other_commercial", f"Condominium ({code})", True)

    return ("other_commercial", "Cook County commercial", True)


def _load_env() -> None:
    env = ROOT / ".env.local"
    if env.exists():
        load_dotenv(env)


def _to_int(v) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _to_float(v) -> float | None:
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


def _pad_pin(pin: str | None) -> str | None:
    """Cook PINs are 14 digits; some Socrata responses drop leading zeros."""
    if not pin:
        return None
    digits = "".join(c for c in str(pin) if c.isdigit())
    if not digits:
        return None
    return digits.zfill(14)


def build_payload(cv_row: dict, addr_row: dict | None) -> dict | None:
    """Combine a Commercial Valuation row + (optional) Parcel Addresses
    row into the intel_properties payload shape."""
    pin = _pad_pin(cv_row.get("keypin"))
    if not pin:
        return None

    # Address: prefer the Commercial Valuation `address`; fall back to
    # Parcel Addresses property_address.
    street = _str(cv_row.get("address")) or (
        _str(addr_row.get("property_address")) if addr_row else None
    )
    if not street:
        return None

    # City + zip come from Parcel Addresses (CV doesn't carry city).
    # Parcel Addresses fields: prop_address_city_name, prop_address_zipcode_1,
    # owner_address_name. (The schema docs name them differently; the API
    # returns these — verified 2026-05-06.)
    city = None
    zip_code = None
    owner_name = None
    if addr_row:
        city = _str(addr_row.get("prop_address_city_name"))
        zip_code = _str(addr_row.get("prop_address_zipcode_1"))
        owner_raw = _str(addr_row.get("owner_address_name"))
        # "EXEMPT" is a placeholder for tax-exempt parcels — not a real
        # owner. Treat as NULL so it doesn't pollute the owner roll-ups.
        owner_name = None if (owner_raw is None or owner_raw.upper() == "EXEMPT") else owner_raw

    if not city:
        # Cook County is overwhelmingly Chicago; better to default than drop.
        city = "Chicago"

    class_code = _str(cv_row.get("class")) or _str(cv_row.get("classes"))
    ptype_use = _str(cv_row.get("property_type_use"))
    bucket, desc, is_comm = classify_cook_class(class_code, ptype_use)
    if not is_comm:
        return None

    bldgsf = _to_int(cv_row.get("bldgsf"))
    market_val = _to_float(cv_row.get("finalmarketvalue"))
    market_val_int = _to_int(cv_row.get("finalmarketvalue"))

    return {
        "external_id": f"COOK-{pin}",
        "source_detail": SOURCE_DETAIL,
        "street_address": street,
        "city": city,
        "state": "IL",
        "postal_code": (zip_code or "")[:10] or None,
        "county_fips": COUNTY_FIPS,
        "county": "Cook",
        "owner_name": owner_name,
        "raw_owner_name": owner_name,
        "property_type": bucket,
        "property_use_code": class_code,
        "property_use_desc": desc,
        "building_sqft": bldgsf,
        # estimated_value is numeric; assessed_value is integer-typed
        # in our schema. AR scraper sets the same convention.
        "estimated_value": market_val,
        "assessed_value": market_val_int,
        "apn": pin,
        "parcel_id": pin,
    }


def hydrate_addresses(pins: list[str], year: int | None) -> dict[str, dict]:
    """Bulk-lookup Parcel Addresses for the given PINs.

    NOTE: We intentionally do NOT filter by tax_year here. The Addresses
    dataset trails the Commercial Valuation dataset by ~1 year (CV ships
    2025 while Addresses' latest is often 2024). Filtering by year
    causes the join to fall through. We instead let `setdefault` below
    keep whichever row Socrata returns first for each PIN.

    Chunk size: 40 PINs. Larger chunks (100+) approach 8KB URL length
    once the SoQL `IN` clause is URL-encoded — some Socrata edges
    return 400 Bad Request rather than 414 URI Too Long.
    """
    out: dict[str, dict] = {}
    session = requests.Session()
    chunk = 40
    for i in range(0, len(pins), chunk):
        batch = [p for p in pins[i : i + chunk] if p]
        if not batch:
            continue
        quoted = ",".join("'" + p + "'" for p in batch)
        clause = f"pin in ({quoted})"
        try:
            # Socrata returns 400 when ORDER BY is combined with this
            # WHERE...IN payload, so we accept whichever year happens
            # to come back. We dedup per-PIN below by keeping the row
            # with the highest tax_year client-side.
            rows = socrata.fetch_page(
                HOST, DATASET_ADDRESSES,
                offset=0, limit=chunk * 4,  # may return multiple years per PIN
                where=clause,
                session=session,
            )
        except requests.HTTPError as e:
            print(f"[cook] address lookup error: {e}")
            continue
        for r in rows:
            p = _pad_pin(r.get("pin"))
            if not p:
                continue
            existing = out.get(p)
            if existing is None:
                out[p] = r
                continue
            # Field is named `year` on this dataset (not tax_year).
            try:
                if int(r.get("year") or 0) > int(existing.get("year") or 0):
                    out[p] = r
            except (TypeError, ValueError):
                pass
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Cook County (IL) commercial scraper")
    parser.add_argument("--max", type=int, default=0,
                        help="cap total rows scanned (smoke test)")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--year", type=int, default=None,
                        help="filter to a specific tax year (default: latest)")
    parser.add_argument("--page-size", type=int, default=1000)
    parser.add_argument("--dry-run", action="store_true",
                        help="don't write to Supabase; print what would be added")
    args = parser.parse_args()

    _load_env()
    progress = Progress(PROGRESS_FILE)
    if args.reset:
        progress.reset()
        print("[cook] progress reset.")
        return 0

    offset = progress.get("last_offset", 0) if args.resume else 0
    if args.resume and offset:
        print(f"[cook] resume at offset {offset:,}")
    else:
        progress["last_offset"] = 0
        progress.save()

    upserter = SupabaseUpserter(source_detail=SOURCE_DETAIL)

    # Year filter: pin to a single tax_year in the Commercial Valuation
    # dataset so we don't double-count multi-year duplicates of the same
    # PIN. If the user didn't specify, we discover the latest available
    # year from the first page.
    target_year = args.year
    if target_year is None:
        sample = socrata.fetch_page(
            HOST, DATASET_COMMERCIAL,
            offset=0, limit=1,
            select="year",
            order="year DESC",
        )
        if sample:
            try:
                target_year = int(sample[0]["year"])
            except (KeyError, ValueError, TypeError):
                target_year = None
    print(f"[cook] tax_year filter: {target_year if target_year else 'all'}")

    where = f"year={target_year}" if target_year else None
    total_seen = 0
    total_kept = 0
    consecutive_errors = 0

    while True:
        if args.max and total_seen >= args.max:
            print(f"[cook] hit --max={args.max}")
            break

        try:
            cv_rows = socrata.fetch_page(
                HOST, DATASET_COMMERCIAL,
                offset=offset, limit=args.page_size,
                where=where,
                order="keypin ASC",
            )
        except requests.HTTPError as e:
            consecutive_errors += 1
            print(f"[cook] page error at offset {offset}: {e}")
            if consecutive_errors >= 5:
                print("[cook] too many errors — bailing")
                break
            time.sleep(5 * consecutive_errors)
            continue
        consecutive_errors = 0

        if not cv_rows:
            print("[cook] no more rows")
            break

        # Bulk-fetch addresses for this page's PINs.
        pins = [_pad_pin(r.get("keypin")) for r in cv_rows]
        pins = [p for p in pins if p]
        addr_map = hydrate_addresses(pins, year=target_year)

        page_kept = 0
        for cv in cv_rows:
            total_seen += 1
            pin = _pad_pin(cv.get("keypin"))
            payload = build_payload(cv, addr_map.get(pin) if pin else None)
            if payload is None:
                continue
            if args.dry_run:
                if total_kept < 5:
                    print(f"[cook] sample: {payload}")
            else:
                upserter.add(payload)
            total_kept += 1
            page_kept += 1

        offset += len(cv_rows)
        progress["last_offset"] = offset
        progress["records_processed"] = upserter.upserted
        progress.save()

        print(
            f"[cook] offset~{offset:,} page_seen={len(cv_rows)} "
            f"page_kept={page_kept} total_kept={total_kept:,} "
            f"upserted={upserter.upserted:,}"
        )

        if len(cv_rows) < args.page_size:
            break

    upserter.flush()
    print(
        f"[cook] DONE — seen={total_seen:,} kept={total_kept:,} "
        f"upserted={upserter.upserted:,} stats={upserter.stats()}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
