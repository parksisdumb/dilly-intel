#!/usr/bin/env python3
"""
Texas statewide commercial-property scraper (TxGIO / TNRIS).

TxGIO (Texas Geographic Information Office, formerly TNRIS) publishes
free per-county parcel shapefiles in a single STANDARDIZED schema
documented at cdn.tnris.org/documents/tnris-land-parcel-schema.pdf.
Every county's file carries the same column names, so we don't have to
do the county-by-county field-alias dance the MS MARIS scraper needs.

Priority counties (the metros our HCAD/DCAD/TAD CAD scrapers miss):
    Harris  (Houston)      FIPS 48201   ~600k parcels
    Travis  (Austin)       FIPS 48453   ~300k parcels
    Bexar   (San Antonio)  FIPS 48029   ~500k parcels

Download each county shapefile (zip) at data.geographic.texas.gov,
unzip into its own directory, then point this script at one or more of
those directories.

Setup:
    pip install pyshp pyproj supabase python-dotenv

Usage:
    # 1. Inspect a county file — fields, samples, STAT_LAND_USE
    #    distributions — without touching the DB. Run this once per
    #    new TxGIO download before --no-dry-run.
    python texas_txgio_scraper.py --preview path/to/harris_county/

    # 2. Real ingest, one or more counties in a single run.
    python texas_txgio_scraper.py path/to/harris path/to/travis path/to/bexar

    # 3. Smoke test on a small slice.
    python texas_txgio_scraper.py --dry-run --limit 1000 path/to/harris

    # 4. Resume / reset (resume skips per-shapefile via progress file).
    python texas_txgio_scraper.py --resume path/to/harris path/to/travis
    python texas_txgio_scraper.py --reset

Design notes:
  - TxGIO STAT_LAND_USE values are the Texas PTAD state classification
    codes (A1, F1, F2, B1, ...). Same coding system HCAD/DCAD/TAD use,
    so we just call the existing classify_tx_state_class() — no new
    classifier needed.
  - Coordinate system varies per CAD: most counties ship in a TX State
    Plane zone (NAD83, EPSG 2275-2279 for North through South), some
    ship in Web Mercator (3857) or NAD83 geographic (4269). We read
    the .prj WKT and let pyproj build the transformer. When .prj is
    missing we skip lat/lon rather than guess.
  - There is NO building_sqft in the TxGIO schema. Rows ingest with
    building_sqft=None and the SupabaseUpserter is configured with
    enforce_sqft_min=False so we don't drop everything.
"""
from __future__ import annotations

import argparse
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

import shapefile  # pyshp
from dotenv import load_dotenv
from pyproj import CRS, Transformer

from intel_ingest import (
    Progress,
    SupabaseUpserter,
    classify_tx_state_class,
)


ROOT = Path(__file__).parent
PROGRESS_FILE = ROOT / "progress_tx_txgio.json"

SOURCE_DETAIL = "tx_txgio_public"
LOG_INTERVAL = 25_000
PREVIEW_DISTRIBUTION_TOP_N = 20

WGS84_EPSG = 4326

# Texas bounding box for the post-reproject sanity gate. Anything
# outside means the source CRS was misidentified.
TX_LAT_MIN, TX_LAT_MAX = 25.5, 36.7
TX_LON_MIN, TX_LON_MAX = -107.0, -93.0

# Texas statewide FIPS prefix. Per-county FIPS is already in the FIPS
# column; this is only used to validate the value.
TX_STATE_FIPS = "48"

# Logical -> ordered list of shapefile column candidates (case-insensitive
# match). TxGIO's schema is fixed, but a few CADs ship minor variants
# (SITUS_STATE instead of SITUS_STAT), so we keep the alias list pattern.
FIELD_ALIASES: dict[str, list[str]] = {
    "prop_id":       ["PROP_ID", "PROPID"],
    "geo_id":        ["GEO_ID", "GEOID"],
    "owner_name":    ["OWNER_NAME", "OWNERNAME", "OWNER"],
    "name_care":     ["NAME_CARE", "CARE_OF", "C_O_NAME"],
    "stat_land_use": ["STAT_LAND_USE", "STATLANDUS", "STATE_USE", "STATE_CLAS"],
    "loc_land_use":  ["LOC_LAND_USE", "LOCLANDUSE", "LOCAL_USE", "LOCAL_CLAS"],
    "site_addr":     ["SITUS_ADDR", "SITUSADDR", "SITE_ADDR"],
    "situs_num":     ["SITUS_NUM", "SITUSNUM"],
    "situs_dir":     ["SITUS_STRE", "SITUS_DIR", "SITUSSTRE"],
    "situs_street":  ["SITUS_ST_1", "SITUS_STR", "SITUSST1"],
    "site_city":     ["SITUS_CITY", "SITUSCITY"],
    "site_state":    ["SITUS_STAT", "SITUS_STATE", "SITUSSTAT"],
    "site_zip":      ["SITUS_ZIP", "SITUSZIP"],
    "mail_addr":     ["MAIL_ADDR", "MAILADDR", "MAILING_AD"],
    "mail_line1":    ["MAIL_LINE1", "MAILLINE1"],
    "mail_city":     ["MAIL_CITY", "MAILCITY"],
    "mail_state":    ["MAIL_STAT", "MAIL_STATE", "MAILSTAT"],
    "mail_zip":      ["MAIL_ZIP", "MAILZIP"],
    "land_value":    ["LAND_VALUE", "LANDVALUE", "LAND_VAL"],
    "imp_value":     ["IMP_VALUE", "IMPVALUE", "IMPROV_VAL", "BLDG_VALUE"],
    "mkt_value":     ["MKT_VALUE", "MKTVALUE", "MARKET_VAL", "TOTAL_VAL"],
    "year_built":    ["YEAR_BUILT", "YEARBUILT", "YR_BUILT", "YRBLT"],
    "county_name":   ["COUNTY", "COUNTYNAME", "CO_NAME"],
    "county_fips":   ["FIPS", "FIPS_CODE", "CO_FIPS"],
    "source":        ["SOURCE", "DATA_SRC"],
}


# --- small value-cleaners --------------------------------------------------

def _str(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, bytes):
        try:
            v = v.decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            return None
    s = str(v).strip()
    return s if s else None


def _to_int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _to_float(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _clean_zip(v: Any) -> str | None:
    s = _str(v)
    if not s:
        return None
    digits = "".join(c for c in s if c.isdigit())
    if not digits:
        return None
    if len(digits) >= 5:
        return digits[:5]
    return digits


def _clean_fips(v: Any) -> str | None:
    """5-digit county FIPS. Pads short values, validates TX prefix."""
    s = _str(v)
    if not s:
        return None
    digits = "".join(c for c in s if c.isdigit())
    if not digits:
        return None
    # Some files ship just the 3-digit county part — prepend "48" when so.
    if len(digits) == 3:
        digits = TX_STATE_FIPS + digits
    if len(digits) == 4:
        digits = TX_STATE_FIPS + digits[-3:]
    if len(digits) != 5:
        return None
    if not digits.startswith(TX_STATE_FIPS):
        return None
    return digits


# --- field discovery + record access --------------------------------------

def build_field_map(shp_field_names: list[str]) -> dict[str, str | None]:
    """
    Pick the first shapefile column that satisfies each logical alias.
    Case-insensitive. Returns dict mapping logical name -> actual column.
    """
    upper_set = {name.upper(): name for name in shp_field_names}
    out: dict[str, str | None] = {}
    for logical, aliases in FIELD_ALIASES.items():
        out[logical] = None
        for alias in aliases:
            actual = upper_set.get(alias.upper())
            if actual is not None:
                out[logical] = actual
                break
    return out


def field_value(record: Any, field_index: dict[str, int], logical_to_actual: dict[str, str | None], logical: str) -> Any:
    actual = logical_to_actual.get(logical)
    if actual is None:
        return None
    idx = field_index.get(actual)
    if idx is None:
        return None
    try:
        return record[idx]
    except (IndexError, KeyError):
        return None


# --- geometry / coordinate reprojection ----------------------------------

def build_transformer_for_shapefile(shp_path: Path) -> Transformer | None:
    """
    Read the .prj sidecar and build a transformer to WGS84.

    TxGIO files come from each CAD in whatever CRS they digitize in —
    no statewide convention. So we lean entirely on the .prj WKT. If
    it's missing or unparseable, we return None and the records get
    NULL lat/lon (guessing the State Plane zone from filename would
    silently corrupt coordinates).
    """
    prj_path = shp_path.with_suffix(".prj")
    if not prj_path.exists():
        return None
    try:
        wkt = prj_path.read_text(encoding="utf-8", errors="replace")
        src_crs = CRS.from_wkt(wkt)
        return Transformer.from_crs(src_crs, f"EPSG:{WGS84_EPSG}", always_xy=True)
    except Exception as e:  # noqa: BLE001
        print(f"[tx-txgio] could not parse {prj_path.name}: {e}")
        return None


def compute_centroid(shape: Any) -> tuple[float, float] | None:
    """Vertex-mean centroid — fine for parcel-scale geocoding."""
    pts = getattr(shape, "points", None)
    if not pts:
        return None
    sx = 0.0
    sy = 0.0
    n = 0
    for p in pts:
        if p is None or len(p) < 2:
            continue
        sx += float(p[0])
        sy += float(p[1])
        n += 1
    if n == 0:
        return None
    return (sx / n, sy / n)


# --- record -> intel_properties payload -----------------------------------

def map_record(
    record: Any,
    field_index: dict[str, int],
    field_map: dict[str, str | None],
    shape: Any,
    transformer: Transformer | None,
) -> dict | None:
    """
    Build the intel_properties dict, or return None to skip.

    Skip rules:
      - No PROP_ID -> can't make external_id
      - No site address -> can't be displayed
      - Not commercial per classify_tx_state_class(STAT_LAND_USE)
    """
    def f(key: str) -> Any:
        return field_value(record, field_index, field_map, key)

    prop_id = _str(f("prop_id"))
    if not prop_id:
        return None

    site_addr = _str(f("site_addr"))
    # Some CADs leave SITUS_ADDR blank but populate SITUS_NUM + SITUS_ST_1.
    if not site_addr:
        num = _str(f("situs_num"))
        d = _str(f("situs_dir"))
        st = _str(f("situs_street"))
        parts = [p for p in (num, d, st) if p]
        if parts:
            site_addr = " ".join(parts)
    if not site_addr:
        return None

    stat_use = _str(f("stat_land_use"))
    bucket, desc, is_commercial = classify_tx_state_class(stat_use)
    if not is_commercial:
        return None

    site_city = _str(f("site_city"))
    if not site_city:
        # Fall back to mailing city only if the property is owner-occupied
        # (mail city == nothing or we just have to take what's there).
        site_city = _str(f("mail_city"))
    if not site_city:
        return None

    site_zip = _clean_zip(f("site_zip"))
    site_state = _str(f("site_state")) or "TX"

    county_fips = _clean_fips(f("county_fips"))
    county_name = _str(f("county_name"))

    mail_addr = _str(f("mail_addr"))
    if not mail_addr:
        # MAIL_LINE1 is the street portion only — use as a weaker fallback.
        mail_addr = _str(f("mail_line1"))
    mail_city = _str(f("mail_city"))
    mail_state = _str(f("mail_state"))
    mail_zip = _clean_zip(f("mail_zip"))

    owner = _str(f("owner_name"))

    # No building_sqft in TxGIO schema (per official PDF). Set explicitly
    # so the upserter knows we tried — and so a future TxGIO schema rev
    # that adds it shows up as a discovered field.
    bldg_sqft: int | None = None
    year_built = _to_int(f("year_built"))

    land_value = _to_float(f("land_value"))
    imp_value = _to_float(f("imp_value"))
    mkt_value_f = _to_float(f("mkt_value"))
    mkt_value_i = _to_int(f("mkt_value"))

    # Prefer MKT_VALUE; fall back to land + improvement when total absent.
    if mkt_value_f is None and (land_value is not None or imp_value is not None):
        mkt_value_f = (land_value or 0.0) + (imp_value or 0.0)
        mkt_value_i = int(mkt_value_f)

    # Reproject polygon centroid to WGS84 for lat/lon.
    lat: float | None = None
    lon: float | None = None
    if transformer is not None:
        centroid = compute_centroid(shape)
        if centroid is not None:
            try:
                lon, lat = transformer.transform(centroid[0], centroid[1])
                if not (TX_LAT_MIN <= lat <= TX_LAT_MAX and TX_LON_MIN <= lon <= TX_LON_MAX):
                    lat, lon = None, None
            except Exception:  # noqa: BLE001
                lat, lon = None, None

    return {
        "external_id": f"TX-TXGIO-{prop_id}",
        "source_detail": SOURCE_DETAIL,
        "street_address": site_addr,
        "city": site_city,
        "state": site_state if len(site_state) == 2 else "TX",
        "postal_code": site_zip,
        "county_fips": county_fips,
        "county": county_name.title() if county_name else None,
        "owner_name": owner,
        "raw_owner_name": owner,
        "owner_mailing_address": mail_addr,
        "owner_mailing_city": mail_city,
        "owner_mailing_state": mail_state,
        "owner_mailing_zip": mail_zip,
        "property_type": bucket,
        "property_use_code": stat_use,
        "property_use_desc": desc,
        "building_sqft": bldg_sqft,
        "year_built": year_built,
        "estimated_value": mkt_value_f,
        "assessed_value": mkt_value_i,
        "latitude": lat,
        "longitude": lon,
        "apn": prop_id,
        "parcel_id": prop_id,
    }


# --- iteration / preview / ingest -----------------------------------------

def discover_shapefiles(input_paths: list[Path]) -> list[Path]:
    """
    Expand a list of input paths into the full set of .shp files to process.

    Each input may be:
      - a single .shp file
      - a directory containing .shp files (recursive — TxGIO zips often
        nest the shapefile inside a county-named subdirectory)
    Order is preserved across inputs; within each input we sort by path.
    """
    out: list[Path] = []
    seen: set[Path] = set()
    for p in input_paths:
        if p.is_file() and p.suffix.lower() == ".shp":
            if p not in seen:
                out.append(p)
                seen.add(p)
        elif p.is_dir():
            for s in sorted(p.rglob("*.shp")):
                if s not in seen:
                    out.append(s)
                    seen.add(s)
    return out


def preview_shapefile(shp_path: Path, sample_cap: int) -> None:
    print(f"\n=== {shp_path.name} ===")
    sf = shapefile.Reader(str(shp_path))
    try:
        field_names = [f[0] for f in sf.fields[1:]]
        field_types = {f[0]: f[1:] for f in sf.fields[1:]}
        total = len(sf)
        print(f"Records: {total:,}")
        print(f"Fields:  {len(field_names)}")

        fmap = build_field_map(field_names)
        print("\nField map (logical -> column):")
        for logical, actual in fmap.items():
            marker = " OK" if actual else "MISS"
            print(f"  [{marker}] {logical:<14} -> {actual}")

        print("\nAll DBF columns (name, type, len, dec):")
        for name in field_names:
            t = field_types[name]
            print(f"   {name:<22} {t}")

        # CRS detection summary
        prj_path = shp_path.with_suffix(".prj")
        if prj_path.exists():
            try:
                wkt = prj_path.read_text(encoding="utf-8", errors="replace")
                src_crs = CRS.from_wkt(wkt)
                epsg = src_crs.to_epsg()
                print(f"\nCRS (.prj): {src_crs.name} (EPSG:{epsg})")
            except Exception as e:  # noqa: BLE001
                print(f"\nCRS (.prj): failed to parse — {e}")
        else:
            print(f"\nCRS (.prj): MISSING — lat/lon will be NULL")

        sample_limit = min(sample_cap, total) if sample_cap else total
        print(f"\nReading first {sample_limit:,} records for distributions...")

        stat_idx = field_names.index(fmap["stat_land_use"]) if fmap.get("stat_land_use") else None
        loc_idx = field_names.index(fmap["loc_land_use"]) if fmap.get("loc_land_use") else None
        county_idx = field_names.index(fmap["county_name"]) if fmap.get("county_name") else None
        fips_idx = field_names.index(fmap["county_fips"]) if fmap.get("county_fips") else None

        stat_counter: Counter = Counter()
        loc_counter: Counter = Counter()
        county_counter: Counter = Counter()
        fips_counter: Counter = Counter()
        bucket_counter: Counter = Counter()
        commercial_count = 0
        seen = 0
        samples: list[Any] = []

        for sr in sf.iterShapeRecords():
            rec = sr.record
            seen += 1
            stat = _str(rec[stat_idx]) if stat_idx is not None else None
            stat_counter[stat or "(empty)"] += 1
            if loc_idx is not None:
                loc_counter[_str(rec[loc_idx]) or "(empty)"] += 1
            if county_idx is not None:
                county_counter[(_str(rec[county_idx]) or "(empty)").upper()] += 1
            if fips_idx is not None:
                fips_counter[_str(rec[fips_idx]) or "(empty)"] += 1
            bucket, _desc, is_comm = classify_tx_state_class(stat)
            bucket_counter[bucket] += 1
            if is_comm:
                commercial_count += 1
            if len(samples) < 5:
                samples.append(rec)
            if seen >= sample_limit:
                break

        print("\nSample records (first 5):")
        for i, rec in enumerate(samples, 1):
            print(f"  [{i}]")
            for logical, actual in fmap.items():
                if not actual:
                    continue
                idx = field_names.index(actual)
                print(f"     {logical:<14} ({actual}) = {rec[idx]!r}")

        def print_dist(title: str, counter: Counter) -> None:
            if not counter:
                print(f"\n{title}: (no field mapped)")
                return
            total_c = sum(counter.values())
            print(f"\n{title} (top {PREVIEW_DISTRIBUTION_TOP_N} of {len(counter):,} unique, "
                  f"{total_c:,} obs):")
            for val, cnt in counter.most_common(PREVIEW_DISTRIBUTION_TOP_N):
                pct = (100.0 * cnt / total_c) if total_c else 0
                short = (val[:50] + "...") if len(val) > 50 else val
                print(f"    {cnt:>7,}  ({pct:5.1f}%)  {short}")

        print_dist("STAT_LAND_USE distribution", stat_counter)
        print_dist("LOC_LAND_USE distribution", loc_counter)
        print_dist("Bucket (post-classify) distribution", bucket_counter)
        print_dist("COUNTY distribution", county_counter)
        print_dist("FIPS distribution", fips_counter)

        pct = (100.0 * commercial_count / seen) if seen else 0
        print(f"\nInferred commercial: {commercial_count:,} of {seen:,} sampled ({pct:.1f}%)")
        if total > seen:
            est_total = int(round(total * commercial_count / max(seen, 1)))
            print(f"Extrapolated to full file: ~{est_total:,} commercial out of {total:,}")
    finally:
        sf.close()


def process_shapefile(
    shp_path: Path,
    upserter: SupabaseUpserter,
    limit: int,
    dry_run: bool,
    seen_counter: list[int],
    kept_counter: list[int],
) -> None:
    print(f"\n[tx-txgio] processing {shp_path}")
    sf = shapefile.Reader(str(shp_path))
    try:
        field_names = [f[0] for f in sf.fields[1:]]
        field_index = {n: i for i, n in enumerate(field_names)}
        field_map = build_field_map(field_names)
        transformer = build_transformer_for_shapefile(shp_path)
        if transformer is None:
            print(f"[tx-txgio] WARNING: no .prj — lat/lon will be NULL for {shp_path.name}")

        mapped = sum(1 for v in field_map.values() if v)
        print(f"[tx-txgio]   {mapped}/{len(field_map)} logical fields mapped from {len(field_names)} DBF columns")
        if not field_map.get("prop_id"):
            print(f"[tx-txgio]   ABORT {shp_path.name}: no PROP_ID column found — not a TxGIO file?")
            return
        if not field_map.get("stat_land_use"):
            print(f"[tx-txgio]   WARNING: no STAT_LAND_USE — every record will be skipped as non-commercial")

        for sr in sf.iterShapeRecords():
            seen_counter[0] += 1
            if limit and seen_counter[0] > limit:
                print(f"[tx-txgio] --limit={limit:,} reached")
                return

            payload = map_record(sr.record, field_index, field_map, sr.shape, transformer)
            if payload is not None:
                if dry_run:
                    if kept_counter[0] < 5:
                        print(f"[tx-txgio]   sample: {payload}")
                else:
                    upserter.add(payload)
                kept_counter[0] += 1

            if seen_counter[0] % LOG_INTERVAL == 0:
                print(f"[tx-txgio]   {shp_path.name}: seen={seen_counter[0]:,} "
                      f"commercial_kept={kept_counter[0]:,} upserted={upserter.upserted:,}")
    finally:
        sf.close()


# --- main / cli -----------------------------------------------------------


def _load_env() -> None:
    env = ROOT / ".env.local"
    if env.exists():
        load_dotenv(env)


def main() -> int:
    parser = argparse.ArgumentParser(description="Texas TxGIO statewide commercial parcel scraper")
    parser.add_argument("paths", nargs="*",
                        help="One or more directories or .shp files (TxGIO per-county downloads)")
    parser.add_argument("--preview", action="store_true",
                        help="Inspect fields + class distributions; no DB writes")
    parser.add_argument("--dry-run", action="store_true",
                        help="Apply mapper/classifier but don't upsert")
    parser.add_argument("--limit", type=int, default=0,
                        help="Cap total records scanned (smoke test)")
    parser.add_argument("--resume", action="store_true",
                        help="Skip shapefiles already marked done in progress file")
    parser.add_argument("--reset", action="store_true",
                        help="Clear progress file and exit")
    parser.add_argument("--preview-sample", type=int, default=200_000,
                        help="Records to read per file for --preview distributions")
    args = parser.parse_args()

    _load_env()
    progress = Progress(PROGRESS_FILE)
    if args.reset:
        progress.reset()
        print("[tx-txgio] progress reset.")
        return 0

    if not args.paths:
        parser.error("at least one path is required (unless --reset)")

    input_paths: list[Path] = []
    for raw in args.paths:
        p = Path(raw).expanduser().resolve()
        if not p.exists():
            print(f"[tx-txgio] path does not exist: {p}")
            return 2
        input_paths.append(p)

    shapefiles = discover_shapefiles(input_paths)
    if not shapefiles:
        print(f"[tx-txgio] no .shp files found under: {[str(p) for p in input_paths]}")
        return 2

    print(f"[tx-txgio] found {len(shapefiles)} shapefile(s):")
    for s in shapefiles:
        print(f"  - {s}")

    if args.preview:
        for s in shapefiles:
            preview_shapefile(s, args.preview_sample)
        return 0

    # Done-tracking uses full resolved path strings so .shp files with
    # the same name across counties don't collide.
    progress.setdefault("done_files", [])
    done = set(progress["done_files"])
    if args.resume:
        before = len(shapefiles)
        shapefiles = [s for s in shapefiles if str(s) not in done]
        print(f"[tx-txgio] --resume: skipping {before - len(shapefiles)} already-done file(s)")

    # TxGIO has no building_sqft column — turn off the sqft floor so
    # we don't accidentally drop perfectly good rows.
    upserter = SupabaseUpserter(source_detail=SOURCE_DETAIL, enforce_sqft_min=False)

    seen = [0]   # boxed for mutation across helper calls
    kept = [0]
    t0 = time.time()
    for s in shapefiles:
        process_shapefile(s, upserter, args.limit, args.dry_run, seen, kept)
        progress["done_files"] = sorted(set(progress["done_files"]) | {str(s)})
        progress["records_processed"] = upserter.upserted
        progress.save()
        if args.limit and seen[0] >= args.limit:
            break

    upserter.flush()
    elapsed = time.time() - t0
    print()
    print(f"[tx-txgio] DONE in {elapsed/60:.1f}m — "
          f"scanned={seen[0]:,} commercial_kept={kept[0]:,} upserted={upserter.upserted:,}")
    print(f"[tx-txgio] stats: {upserter.stats()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
