#!/usr/bin/env python3
"""
Cook County (Chicago) commercial expansion scraper.

Companion to `cook_county_scraper.py`. The first scraper pulls from the
curated Commercial Valuation dataset (~12k records WITH bldg sqft).
This one widens the universe by streaming the broader Parcel Universe
dataset and ingesting commercial PINs that the first pass missed —
no bldg sqft, but full count of Cook commercial inventory.

Datasets:
  * nj4t-kc8j  (Assessor - Parcel Universe). 50M+ rows, ~1.8M unique
    PINs spanning 1999-present. Filter to class IN [500..700) for
    commercial + industrial. The `class` column is text, so we use a
    range comparison rather than `LIKE '5%'` (which the API rejects).
  * 3723-97qp  (Assessor - Parcel Addresses). Address + owner_name
    per PIN. Same join as cook_county_scraper.py.

Insert-only: PINs already in intel_properties under source_detail =
'cook_county_il_public' (from the first scraper) are skipped so we
don't overwrite the curated bldg_sqft data with NULLs.

Setup:
    pip install requests supabase python-dotenv

Usage:
    python cook_county_universe_scraper.py
    python cook_county_universe_scraper.py --max=5000     # smoke test
    python cook_county_universe_scraper.py --resume
    python cook_county_universe_scraper.py --reset
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

from intel_ingest.progress import Progress
from intel_ingest.supabase_io import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_RETRY_COUNT,
    DEFAULT_RETRY_SLEEP,
    MIN_BUILDING_SQFT,
    ON_CONFLICT,
    make_client,
)
from intel_ingest import socrata

ROOT = Path(__file__).parent
PROGRESS_FILE = ROOT / "progress_cook_universe.json"

HOST = "datacatalog.cookcountyil.gov"
DATASET_UNIVERSE = "nj4t-kc8j"      # Parcel Universe
DATASET_ADDRESSES = "3723-97qp"     # Parcel Addresses
SOURCE_DETAIL = "cook_county_il_public"
COUNTY_FIPS = "17031"

# class is a text column; lexicographic range works for 3-digit zero-
# padded codes. 4xx = 6+ unit residential income (REIT-grade
# multifamily), 5xx = commercial, 6xx = industrial. We INCLUDE 4xx
# because 6+ unit apartment buildings are commercial-grade for our
# purposes (and what most multifamily REITs hold).
CLASS_LO = "400"
CLASS_HI = "700"  # exclusive upper bound

# Stream chunk size for Parcel Universe. The dataset is huge (50M rows)
# but the class filter prunes most of it server-side. Page at 1000 to
# stay well under any per-request cap.
PAGE_SIZE = 1000


def _load_env() -> None:
    env = ROOT / ".env.local"
    if env.exists():
        load_dotenv(env)


def _str(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _to_int(v) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _pad_pin(pin: str | None) -> str | None:
    if not pin:
        return None
    digits = "".join(c for c in str(pin) if c.isdigit())
    return digits.zfill(14) if digits else None


def classify_cook_class(class_code: str | None) -> tuple[str, str, bool]:
    """
    Bucket Cook County 3-digit class codes (no use-text available
    in Parcel Universe). Less precise than cook_county_scraper.py
    which has property_type_use, but enough to bucket cleanly.
    """
    code = (class_code or "").strip()
    if not code:
        return ("other_commercial", "Cook County commercial", True)
    head = code[0]
    if head == "4":
        return ("multifamily", f"Multifamily 6+ units (Cook {code})", True)
    if head == "5":
        # 5xx range covers retail, restaurants, offices, hotels.
        # Fine-grained mapping per Cook Assessor classification manual:
        try:
            n = int(code)
        except ValueError:
            return ("retail", f"Cook commercial {code}", True)
        if 510 <= n <= 519:
            return ("retail", f"Retail / store ({code})", True)
        if 520 <= n <= 529:
            return ("retail", f"Restaurant / food ({code})", True)
        if 530 <= n <= 539:
            return ("retail", f"Mixed-use commercial ({code})", True)
        if 550 <= n <= 559:
            return ("hospitality", f"Hotel / motel ({code})", True)
        if 560 <= n <= 569:
            return ("retail", f"Auto / service ({code})", True)
        if 570 <= n <= 579:
            return ("retail", f"Theater / entertainment ({code})", True)
        if 580 <= n <= 589:
            return ("retail", f"Mixed commercial ({code})", True)
        if 590 <= n <= 599:
            return ("office", f"Office building ({code})", True)
        return ("retail", f"Cook commercial {code}", True)
    if head == "6":
        return ("industrial", f"Industrial / warehouse (Cook {code})", True)
    return ("other_commercial", f"Cook class {code}", True)


class InsertOnlyUpserter:
    """Like SupabaseUpserter but uses ON CONFLICT DO NOTHING via the
    Postgrest `ignore_duplicates` flag. We need this so that PINs
    already ingested by cook_county_scraper.py (with curated
    building_sqft) don't get overwritten with our NULL sqft from the
    Universe dataset.

    Pre-loading existing PINs and filtering client-side timed out: the
    only multi-million-row partial indexes on intel_properties exclude
    cook_county_il_public, so the WHERE source_detail filter falls
    back to a sequential scan."""

    def __init__(self, source_detail: str, client=None,
                 batch_size: int = DEFAULT_BATCH_SIZE,
                 on_log=print) -> None:
        self.source_detail = source_detail
        self.client = client or make_client()
        self.batch_size = batch_size
        self.log = on_log
        self._buf: list[dict] = []
        self.queued = 0
        self.upserted = 0
        self.failed = 0
        self.skipped_missing_address = 0
        self.skipped_undersized = 0

    def add(self, row: dict) -> None:
        if not row.get("street_address") or not row.get("city") or not row.get("state"):
            self.skipped_missing_address += 1
            return
        sqft = row.get("building_sqft")
        if sqft is not None:
            try:
                if float(sqft) < MIN_BUILDING_SQFT:
                    self.skipped_undersized += 1
                    return
            except (TypeError, ValueError):
                pass
        row.setdefault("source_detail", self.source_detail)
        self._buf.append(row)
        self.queued += 1
        if len(self._buf) >= self.batch_size:
            self._flush_batch()

    def flush(self) -> None:
        if self._buf:
            self._flush_batch()

    def _flush_batch(self) -> None:
        if not self._buf:
            return
        batch = self._buf
        self._buf = []
        # In-batch dedup on conflict key.
        seen: dict[tuple, int] = {}
        for i, row in enumerate(batch):
            key = (row.get("external_id"), row.get("source_detail"))
            seen[key] = i
        if len(seen) < len(batch):
            batch = [batch[i] for i in sorted(seen.values())]

        for attempt in range(DEFAULT_RETRY_COUNT):
            try:
                # ignore_duplicates=True -> ON CONFLICT DO NOTHING.
                # Existing PINs (from cook_county_scraper.py) keep
                # their curated building_sqft.
                self.client.table("intel_properties").upsert(
                    batch, on_conflict=ON_CONFLICT, ignore_duplicates=True
                ).execute()
                self.upserted += len(batch)
                return
            except Exception as e:  # noqa: BLE001
                if attempt < DEFAULT_RETRY_COUNT - 1:
                    self.log(f"[upsert] retry {attempt + 1}/{DEFAULT_RETRY_COUNT}: {e}")
                    time.sleep(DEFAULT_RETRY_SLEEP * (attempt + 1))
                else:
                    self.failed += len(batch)
                    self.log(f"[upsert] FAILED batch of {len(batch)}: {e}")

    def stats(self) -> dict:
        return {
            "queued": self.queued,
            "upserted": self.upserted,
            "failed": self.failed,
            "skipped_missing_address": self.skipped_missing_address,
            "skipped_undersized": self.skipped_undersized,
        }


def hydrate_addresses(pins: list[str]) -> dict[str, dict]:
    """Same as cook_county_scraper.py — fetch property_address /
    property_city / property_zip / owner_name keyed by PIN. ORDER+IN
    is rejected by Socrata, so we accept the first row per PIN and
    keep the highest tax_year client-side."""
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
            rows = socrata.fetch_page(
                HOST, DATASET_ADDRESSES,
                offset=0, limit=chunk * 4,
                where=clause,
                session=session,
            )
        except requests.HTTPError as e:
            print(f"[cook-univ] address lookup error: {e}")
            continue
        for r in rows:
            p = _pad_pin(r.get("pin"))
            if not p:
                continue
            existing = out.get(p)
            if existing is None:
                out[p] = r
                continue
            # Field is `year` (not `tax_year`) on this dataset.
            try:
                if int(r.get("year") or 0) > int(existing.get("year") or 0):
                    out[p] = r
            except (TypeError, ValueError):
                pass
    return out


def build_payload(pin: str, class_code: str | None, addr_row: dict | None) -> dict | None:
    bucket, desc, is_comm = classify_cook_class(class_code)
    if not is_comm:
        return None

    # Parcel Addresses field names (verified 2026-05-06):
    #   prop_address_full          property street address
    #   prop_address_city_name     city
    #   prop_address_zipcode_1     zip
    #   owner_address_name         owner / taxpayer name (literal "EXEMPT"
    #                              for tax-exempt rows — we treat as NULL)
    street = _str(addr_row.get("prop_address_full")) if addr_row else None
    if not street:
        # Universe rows without an address join can't be displayed as
        # property cards — skip them.
        return None

    city = _str(addr_row.get("prop_address_city_name")) if addr_row else None
    zip_code = _str(addr_row.get("prop_address_zipcode_1")) if addr_row else None
    owner_raw = _str(addr_row.get("owner_address_name")) if addr_row else None
    owner_name = None if (owner_raw is None or owner_raw.upper() == "EXEMPT") else owner_raw

    if not city:
        city = "Chicago"

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
        "building_sqft": None,    # not in Parcel Universe
        "estimated_value": None,
        "assessed_value": None,
        "apn": pin,
        "parcel_id": pin,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Cook County universe expansion scraper")
    parser.add_argument("--max", type=int, default=0,
                        help="cap rows scanned (smoke test)")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--page-size", type=int, default=PAGE_SIZE)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    _load_env()
    progress = Progress(PROGRESS_FILE)
    if args.reset:
        progress.reset()
        print("[cook-univ] progress reset.")
        return 0

    offset = progress.get("last_offset", 0) if args.resume else 0
    if args.resume and offset:
        print(f"[cook-univ] resume at offset {offset:,}")
    else:
        progress["last_offset"] = 0
        progress.save()

    upserter = InsertOnlyUpserter(source_detail=SOURCE_DETAIL)

    # Server-side filter: class >= '400' AND class < '700'. The Universe
    # dataset's `class` is text — lexicographic range on 3-digit codes.
    where = f"class >= '{CLASS_LO}' AND class < '{CLASS_HI}'"

    # Per-PIN dedup buffer. Universe ships one row per PIN per tax_year
    # (multi-decade history). We keep only the highest tax_year per PIN.
    # Memory: ~150k unique commercial PINs × ~200 bytes = ~30MB.
    pin_to_class: dict[str, tuple[str | None, int | None]] = {}

    total_seen = 0
    consecutive_errors = 0

    print(f"[cook-univ] streaming Parcel Universe with WHERE {where}")
    print("[cook-univ] phase 1: server-filter + per-PIN dedup")
    while True:
        if args.max and total_seen >= args.max:
            print(f"[cook-univ] hit --max={args.max}")
            break
        try:
            rows = socrata.fetch_page(
                HOST, DATASET_UNIVERSE,
                offset=offset, limit=args.page_size,
                where=where,
            )
        except requests.HTTPError as e:
            consecutive_errors += 1
            print(f"[cook-univ] page error at offset {offset}: {e}")
            if consecutive_errors >= 5:
                print("[cook-univ] too many errors — bailing")
                break
            time.sleep(5 * consecutive_errors)
            continue
        consecutive_errors = 0

        if not rows:
            break

        for r in rows:
            total_seen += 1
            pin = _pad_pin(r.get("pin"))
            if not pin:
                continue
            cls = _str(r.get("class"))
            tax_year = _to_int(r.get("tax_year"))
            existing = pin_to_class.get(pin)
            if existing is None:
                pin_to_class[pin] = (cls, tax_year)
            else:
                _, ex_year = existing
                # Prefer the row with the highest tax_year. Ties: keep
                # whichever class we already have (idempotent).
                if (tax_year or 0) > (ex_year or 0):
                    pin_to_class[pin] = (cls, tax_year)

        offset += len(rows)
        progress["last_offset"] = offset
        progress.save()

        if total_seen % 50_000 < len(rows):
            print(f"[cook-univ] streamed {total_seen:,} rows -> {len(pin_to_class):,} unique commercial PINs")

        if len(rows) < args.page_size:
            break

    print(f"[cook-univ] phase 1 done. {total_seen:,} rows -> "
          f"{len(pin_to_class):,} unique new PINs to enrich")

    if args.dry_run:
        sample = list(pin_to_class.items())[:5]
        for pin, (cls, yr) in sample:
            print(f"[cook-univ] DRY: pin={pin} class={cls} tax_year={yr}")
        return 0

    # Phase 2: in chunks, look up address+owner from Parcel Addresses,
    # build payloads, upsert.
    pins_list = list(pin_to_class.keys())
    print(f"[cook-univ] phase 2: address lookup + upsert for "
          f"{len(pins_list):,} PINs")

    LOOKUP_CHUNK = 1000  # one address-batch per 1000 PINs (each batch
                        # internally chunks at 40 due to URL length cap)
    total_kept = 0
    for i in range(0, len(pins_list), LOOKUP_CHUNK):
        chunk_pins = pins_list[i : i + LOOKUP_CHUNK]
        addr_map = hydrate_addresses(chunk_pins)
        for pin in chunk_pins:
            cls, _ = pin_to_class[pin]
            payload = build_payload(pin, cls, addr_map.get(pin))
            if payload is None:
                continue
            upserter.add(payload)
            total_kept += 1
        print(f"[cook-univ] enriched {min(i + LOOKUP_CHUNK, len(pins_list)):,}/"
              f"{len(pins_list):,}  upserted={upserter.upserted:,} kept={total_kept:,}")

    upserter.flush()
    print(f"[cook-univ] DONE — phase1_seen={total_seen:,} unique_pins={len(pins_list):,} "
          f"kept={total_kept:,} upserted={upserter.upserted:,} stats={upserter.stats()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
