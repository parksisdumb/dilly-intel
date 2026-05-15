#!/usr/bin/env python3
"""
Mississippi statewide commercial-property scraper.

MARIS (Mississippi Automated Resource Information System) publishes a
quarterly statewide cadastral framework — every parcel in all 82 MS
counties stitched together from each county's CAMA system. Two
shapefiles cover the state:

  https://maris.mississippi.edu/MARISdata/Parcels/MS_StatewideParcels_<DATE>/MS_West_Parcels_<DATE>.zip
  https://maris.mississippi.edu/MARISdata/Parcels/MS_StatewideParcels_<DATE>/MS_East_Parcels_<DATE>.zip

Download + unzip both into a directory, point this scraper at it.

Setup:
    pip install pyshp pyproj supabase python-dotenv

Usage:
    # 1. Inspect what's in the file — fields, samples, class
    #    distributions — without touching the DB. ALWAYS run this once
    #    on a new MARIS release before --no-dry-run.
    python mississippi_maris_scraper.py --preview /path/to/maris_unzipped/

    # 2. Real ingest. Stream every parcel, classify, upsert commercial.
    python mississippi_maris_scraper.py /path/to/maris_unzipped/

    # 3. Smoke test: stop after N records.
    python mississippi_maris_scraper.py --limit 5000 /path/to/maris_unzipped/

    # 4. Resume / reset (resume re-skips per-shapefile via progress file).
    python mississippi_maris_scraper.py --resume /path/to/maris_unzipped/
    python mississippi_maris_scraper.py --reset

Design notes:
  - MARIS has NO single statewide property-class system. Each county's
    CAMA values land in the `CAMA` column with county-specific meaning.
    classify_ms_cama() (intel_ingest/property_codes.py) handles this
    via multi-signal: description text wins, then short-code lookup,
    then numeric leading-digit heuristic.
  - Field discovery is automatic — the shapefile schema differs between
    counties (some carry SITEADD, some only mailing address; some carry
    BLDGSQFT, most don't). We probe FIELD_ALIASES against each file's
    columns and accept partial coverage.
  - Parcel polygons are in MS State Plane (EPSG:6507 East / 6510 West);
    we read the .prj file to build a transformer to WGS84 and emit the
    polygon centroid as lat/lon — free geocoding.
"""
from __future__ import annotations

import argparse
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Iterator

import shapefile  # pyshp
from dotenv import load_dotenv
from pyproj import CRS, Transformer

from intel_ingest import (
    Progress,
    SupabaseUpserter,
    classify_ms_cama,
)


ROOT = Path(__file__).parent
PROGRESS_FILE = ROOT / "progress_ms_maris.json"

SOURCE_DETAIL = "ms_maris_public"
LOG_INTERVAL = 25_000
PREVIEW_DISTRIBUTION_TOP_N = 20

# Mississippi State Plane EPSG codes. We try .prj first; these are the
# fallback when filename contains "east" or "west".
MS_EAST_EPSG = 6507
MS_WEST_EPSG = 6510
WGS84_EPSG = 4326

# 28 = Mississippi statewide FIPS prefix. county_fips is 5 digits =
# state_fips + county_fips. Names normalized to UPPER and stripped.
MS_STATE_FIPS = "28"
MS_COUNTY_FIPS: dict[str, str] = {
    "ADAMS": "001", "ALCORN": "003", "AMITE": "005",
    "ATTALA": "007", "BENTON": "009", "BOLIVAR": "011",
    "CALHOUN": "013", "CARROLL": "015", "CHICKASAW": "017",
    "CHOCTAW": "019", "CLAIBORNE": "021", "CLARKE": "023",
    "CLAY": "025", "COAHOMA": "027", "COPIAH": "029",
    "COVINGTON": "031", "DESOTO": "033", "FORREST": "035",
    "FRANKLIN": "037", "GEORGE": "039", "GREENE": "041",
    "GRENADA": "043", "HANCOCK": "045", "HARRISON": "047",
    "HINDS": "049", "HOLMES": "051", "HUMPHREYS": "053",
    "ISSAQUENA": "055", "ITAWAMBA": "057", "JACKSON": "059",
    "JASPER": "061", "JEFFERSON": "063", "JEFFERSON DAVIS": "065",
    "JONES": "067", "KEMPER": "069", "LAFAYETTE": "071",
    "LAMAR": "073", "LAUDERDALE": "075", "LAWRENCE": "077",
    "LEAKE": "079", "LEE": "081", "LEFLORE": "083",
    "LINCOLN": "085", "LOWNDES": "087", "MADISON": "089",
    "MARION": "091", "MARSHALL": "093", "MONROE": "095",
    "MONTGOMERY": "097", "NESHOBA": "099", "NEWTON": "101",
    "NOXUBEE": "103", "OKTIBBEHA": "105", "PANOLA": "107",
    "PEARL RIVER": "109", "PERRY": "111", "PIKE": "113",
    "PONTOTOC": "115", "PRENTISS": "117", "QUITMAN": "119",
    "RANKIN": "121", "SCOTT": "123", "SHARKEY": "125",
    "SIMPSON": "127", "SMITH": "129", "STONE": "131",
    "SUNFLOWER": "133", "TALLAHATCHIE": "135", "TATE": "137",
    "TIPPAH": "139", "TISHOMINGO": "141", "TUNICA": "143",
    "UNION": "145", "WALTHALL": "147", "WARREN": "149",
    "WASHINGTON": "151", "WAYNE": "153", "WEBSTER": "155",
    "WILKINSON": "157", "WINSTON": "159", "YALOBUSHA": "161",
    "YAZOO": "163",
}

# Logical -> ordered list of shapefile column candidates (case-insensitive
# match). First found wins. New aliases can be appended without changing
# the mapper.
FIELD_ALIASES: dict[str, list[str]] = {
    "parcel_id":     ["PARNO", "PARCEL_NO", "PARCELID", "PARCEL_ID", "PIN", "PARCEL"],
    "alt_parcel":    ["ALTPARNO", "ALT_PARCEL", "ALT_PARNO"],
    "ppin":          ["PPIN"],
    "owner_name":    ["OWNNAME", "OWNER", "OWNERNAME", "OWNER_NAME", "OWNNAME1"],
    "mail_addr":     ["MAILADD1", "MAILADDR", "MAIL_ADDR", "MAILING_AD", "MAILADDRESS"],
    "mail_city":     ["MCITY1", "MAIL_CITY", "MAILCITY"],
    "mail_state":    ["MSTATE1", "MAIL_STATE", "MAILSTATE"],
    "mail_zip":      ["MZIP1", "MAIL_ZIP", "MAILZIP", "MAIL_ZIP1"],
    "site_addr":     ["SITEADD", "SITEADDR", "PROPADDR", "PROP_ADDR", "SITUSADDR", "SITUS_ADDR"],
    # MARIS uses S{CITY,STATE,ZIP} for the site address (verified against
    # MS_East_MDEQPARCELS_2024 + MS_West_MDEQPARCELS_2024). SITECITY etc.
    # kept as fallbacks for other-state ports of the same code.
    "site_city":     ["SCITY", "SITECITY", "PROPCITY", "CITY", "SITUS_CITY"],
    "site_state":    ["SSTATE", "SITESTATE", "PROPSTATE", "ST"],
    "site_zip":      ["SZIP", "SITEZIP", "PROPZIP", "ZIP", "SITUSZIP"],
    "county_name":   ["CNTYNAME", "COUNTY", "COUNTYNAME", "COUNTY_NAM", "CO_NAME"],
    # MARIS ships a pre-computed 5-digit state+county FIPS in STCNTYFIPS,
    # plus separate CNTYFIPS (3 digits) and STFIPS (2 digits). When the
    # combined column is present, the mapper can skip its own lookup.
    "county_fips":   ["STCNTYFIPS", "GEOID", "FIPS"],
    "bldg_sqft":     ["BLDGSQFT", "BLDG_SQFT", "SQFT", "BUILDINGSF", "TOTLIVAREA", "BLDAREA"],
    "year_built":    ["YEARBUILT", "YEAR_BUILT", "YR_BUILT", "YRBLT"],
    # MARIS column is named TOTVAL — list it first so it wins over the
    # generic alias that other CAMA exports use.
    "total_value":   ["TOTVAL", "TOTALVALUE", "TOTAL_VAL", "TOTVALUE", "TOTAL_APP", "APPRTOTAL"],
    "land_value":    ["LANDVAL", "LANDVALUE", "LAND_VAL"],
    "bldg_value":    ["BLDGVALUE", "BLDG_VAL", "BLDGVAL", "IMPROVVAL", "IMPVAL"],
    # MARIS publishes building improvements as IMPVAL1 (primary) +
    # IMPVAL2 (auxiliary). The analyzer sums them as a structure-
    # presence signal; the production mapper can reuse the same fields.
    "imp_val_1":     ["IMPVAL1"],
    "imp_val_2":     ["IMPVAL2"],
    # Pre-computed centroid lat/lon in WGS84. When populated, no need to
    # reproject from MS State Plane.
    "latitude":      ["LATDEC", "LATITUDE", "LAT"],
    "longitude":     ["LONGDEC", "LONGITUDE", "LON", "LNG"],
    # Zoning + tax-status are the two extra signals we may use for
    # classification given that MARIS's `CAMA` field is actually the
    # software-vendor name (not a property class code).
    "zoning":        ["ZONING", "ZONE_CODE"],
    "tax_status":    ["TAXSTATUS", "TAX_STATUS"],
    "class_code":    ["CAMA", "CLASSCD", "CLASS_CD", "CLASS", "USECODE"],
    "class_desc":    ["CLASSDESC", "CLASS_DESC", "CAMADESC", "USEDESC", "PROP_USE", "USE_DESC", "USETYPE"],
    "acreage":       ["TOTAL_AC", "TAXACRES", "ACREAGE", "ACRES", "GIS_ACRES", "ACRES_GIS"],
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


# --- field discovery + record access --------------------------------------

def build_field_map(shp_field_names: list[str]) -> dict[str, str | None]:
    """
    Pick the first shapefile column that satisfies each logical alias.
    Case-insensitive match. Returns dict whose values are the actual
    shapefile column name (or None when no candidate is present).
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
    """Read a logical field's value from a pyshp Record, or None."""
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
    Falls back to filename detection (EPSG:6507 East / 6510 West) if
    the .prj is missing or unparseable.
    """
    prj_path = shp_path.with_suffix(".prj")
    if prj_path.exists():
        try:
            wkt = prj_path.read_text(encoding="utf-8", errors="replace")
            src_crs = CRS.from_wkt(wkt)
            return Transformer.from_crs(src_crs, f"EPSG:{WGS84_EPSG}", always_xy=True)
        except Exception as e:  # noqa: BLE001
            print(f"[ms-maris] could not parse {prj_path.name}: {e} — falling back to filename")
    # Filename heuristic.
    name = shp_path.name.lower()
    if "east" in name:
        return Transformer.from_crs(f"EPSG:{MS_EAST_EPSG}", f"EPSG:{WGS84_EPSG}", always_xy=True)
    if "west" in name:
        return Transformer.from_crs(f"EPSG:{MS_WEST_EPSG}", f"EPSG:{WGS84_EPSG}", always_xy=True)
    return None


def compute_centroid(shape: Any) -> tuple[float, float] | None:
    """
    Mean of all vertex coordinates across all rings of the polygon.
    Approximate (not area-weighted) but good enough for parcel-scale
    geocoding — drift from the true centroid is below the geocoder's
    own positional error on typical parcels.
    """
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

    Classification is multi-signal via classify_ms_cama() — Tier 1
    (ZONING prefix), Tier 2 (corp suffix + IMPVAL >= $100k +
    not anti-pattern), Tier 3 skip. See property_codes.py for the
    rationale.

    Skip rules:
      - No PARNO / parcel id  -> can't make external_id
      - No site address       -> can't be displayed
      - classify_ms_cama() returns is_commercial=False
    """
    def f(key: str) -> Any:
        return field_value(record, field_index, field_map, key)

    parcel_id_raw = _str(f("parcel_id"))
    if not parcel_id_raw:
        return None
    # PARNO commonly contains run-on whitespace ("010417        00100").
    # Collapse to single underscores for the external_id; preserve the
    # raw value on .apn/.parcel_id for display.
    parcel_id_clean = "_".join(parcel_id_raw.split())

    site_addr = _str(f("site_addr"))
    if not site_addr:
        return None

    owner = _str(f("owner_name"))
    zoning = _str(f("zoning"))
    imp_val_1 = _to_float(f("imp_val_1")) or 0.0
    imp_val_2 = _to_float(f("imp_val_2")) or 0.0
    imp_val_total = imp_val_1 + imp_val_2

    # Multi-signal classifier. Class code/desc kept as fallback but
    # MARIS doesn't populate them — Tier 1 (ZONING) or Tier 2
    # (owner+IMPVAL) almost always decides the outcome.
    class_code = _str(f("class_code"))
    class_desc = _str(f("class_desc"))
    bucket, desc, is_commercial = classify_ms_cama(
        class_code,
        class_desc,
        owner=owner,
        zoning=zoning,
        imp_val=imp_val_total,
    )
    if not is_commercial:
        return None

    site_city = _str(f("site_city"))
    site_zip = _clean_zip(f("site_zip"))
    county_name = _str(f("county_name"))

    if not site_city:
        site_city = _str(f("mail_city"))
    if not site_city:
        return None

    # Prefer the pre-computed STCNTYFIPS column; fall back to lookup by
    # county name when the file doesn't carry it.
    county_fips: str | None = None
    raw_fips = _str(f("county_fips"))
    if raw_fips:
        digits = "".join(c for c in raw_fips if c.isdigit())
        if len(digits) == 5:
            county_fips = digits
    if not county_fips and county_name:
        key = county_name.upper().strip()
        suffix = MS_COUNTY_FIPS.get(key)
        if suffix:
            county_fips = MS_STATE_FIPS + suffix

    # Mailing address (taxpayer of record) — useful for the
    # portfolio-owners clustering on /intelligence/market.
    mail_addr = _str(f("mail_addr"))
    mail_city = _str(f("mail_city"))
    mail_state = _str(f("mail_state"))
    mail_zip = _clean_zip(f("mail_zip"))

    bldg_sqft = _to_int(f("bldg_sqft"))  # NULL on MARIS — not published
    year_built = _to_int(f("year_built"))  # also NULL on MARIS
    total_value_f = _to_float(f("total_value"))
    total_value_i = _to_int(f("total_value"))

    # Lat/lon: read LATDEC/LONGDEC directly — MARIS ships 100% populated
    # WGS84 centroids, so the pyproj reprojection path is moot.
    lat_raw = _to_float(f("latitude"))
    lon_raw = _to_float(f("longitude"))
    lat: float | None = None
    lon: float | None = None
    if lat_raw != 0.0 or lon_raw != 0.0:
        # Sanity-gate to MS bounding box; reject obvious garbage.
        if 29.0 <= lat_raw <= 36.0 and -92.0 <= lon_raw <= -88.0:
            lat, lon = lat_raw, lon_raw

    # Decorate the use-desc with the IMPVAL signal so reviewers can
    # see which tier caught the row even after ingestion.
    desc_decorated = class_desc or desc
    if imp_val_total > 0 and not class_desc:
        desc_decorated = f"{desc} | IMPVAL ${imp_val_total:,.0f}"

    return {
        "external_id": f"MS-MARIS-{parcel_id_clean}",
        "source_detail": SOURCE_DETAIL,
        "street_address": site_addr,
        "city": site_city,
        "state": "MS",
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
        "property_use_code": zoning or class_code,
        "property_use_desc": desc_decorated,
        "building_sqft": bldg_sqft,    # NULL — MARIS lacks this
        "year_built": year_built,      # NULL — MARIS lacks this
        "estimated_value": total_value_f,
        "assessed_value": total_value_i,
        "latitude": lat,
        "longitude": lon,
        "apn": parcel_id_raw,
        "parcel_id": parcel_id_raw,
    }


# --- iteration / preview / ingest -----------------------------------------

def discover_shapefiles(input_path: Path) -> list[Path]:
    """
    Return all *.shp files at or under the given path. Recursive so that
    MARIS's nested archive layout (one subdirectory per .zip) Just Works
    when the user points us at the parent containing both unpacked
    halves.
    """
    if input_path.is_file() and input_path.suffix.lower() == ".shp":
        return [input_path]
    if input_path.is_dir():
        return sorted(input_path.rglob("*.shp"))
    return []


def iter_record_shapes(shp_path: Path) -> Iterator[tuple[Any, Any, list[str]]]:
    """
    Stream (record, shape, field_names) tuples for a shapefile.

    Uses pyshp's iterShapeRecords() which paginates internally and
    keeps memory bounded. Field names returned are the DBF columns
    minus the leading DeletionFlag entry.
    """
    sf = shapefile.Reader(str(shp_path))
    field_names = [f[0] for f in sf.fields[1:]]
    try:
        for sr in sf.iterShapeRecords():
            yield sr.record, sr.shape, field_names
    finally:
        sf.close()


def preview_shapefile(shp_path: Path, sample_cap: int) -> None:
    print(f"\n=== {shp_path.name} ===")
    sf = shapefile.Reader(str(shp_path))
    try:
        field_names = [f[0] for f in sf.fields[1:]]
        field_types = {f[0]: f[1:] for f in sf.fields[1:]}
        total = len(sf)
        print(f"Records: {total:,}")
        print(f"Fields:  {len(field_names)}")

        # Field map auto-discovery summary
        fmap = build_field_map(field_names)
        print("\nField map (logical -> column):")
        for logical, actual in fmap.items():
            marker = " OK" if actual else "MISS"
            print(f"  [{marker}] {logical:<14} -> {actual}")

        # Show all columns with their type/length so the user can
        # spot fields we didn't auto-map.
        print("\nAll DBF columns (name, type, len, dec):")
        for name in field_names:
            t = field_types[name]
            print(f"   {name:<22} {t}")

        # Stream a sample to gather distributions.
        sample_limit = min(sample_cap, total) if sample_cap else total
        print(f"\nReading first {sample_limit:,} records for distributions...")
        code_idx = field_names.index(fmap["class_code"]) if fmap.get("class_code") else None
        desc_idx = field_names.index(fmap["class_desc"]) if fmap.get("class_desc") else None
        county_idx = field_names.index(fmap["county_name"]) if fmap.get("county_name") else None

        code_counter: Counter = Counter()
        desc_counter: Counter = Counter()
        county_counter: Counter = Counter()
        commercial_count = 0
        seen = 0
        samples: list[Any] = []

        for sr in sf.iterShapeRecords():
            rec = sr.record
            seen += 1
            if code_idx is not None:
                code_counter[_str(rec[code_idx]) or "(empty)"] += 1
            if desc_idx is not None:
                desc_counter[_str(rec[desc_idx]) or "(empty)"] += 1
            if county_idx is not None:
                county_counter[(_str(rec[county_idx]) or "(empty)").upper()] += 1
            code = _str(rec[code_idx]) if code_idx is not None else None
            desc = _str(rec[desc_idx]) if desc_idx is not None else None
            _, _, is_comm = classify_ms_cama(code, desc)
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

        print_dist("CLASS CODE distribution", code_counter)
        print_dist("CLASS DESC distribution", desc_counter)
        print_dist("COUNTY distribution", county_counter)

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
    print(f"\n[ms-maris] processing {shp_path.name}")
    sf = shapefile.Reader(str(shp_path))
    try:
        field_names = [f[0] for f in sf.fields[1:]]
        field_index = {n: i for i, n in enumerate(field_names)}
        field_map = build_field_map(field_names)
        transformer = build_transformer_for_shapefile(shp_path)
        if transformer is None:
            print(f"[ms-maris] WARNING: no transformer (no .prj, no East/West in filename) — lat/lon will be NULL")

        # Helpful pre-flight log of what we'll be reading.
        mapped = sum(1 for v in field_map.values() if v)
        print(f"[ms-maris]   {mapped}/{len(field_map)} logical fields mapped from {len(field_names)} DBF columns")

        for sr in sf.iterShapeRecords():
            seen_counter[0] += 1
            if limit and seen_counter[0] > limit:
                print(f"[ms-maris] --limit={limit:,} reached")
                return

            payload = map_record(sr.record, field_index, field_map, sr.shape, transformer)
            if payload is not None:
                if dry_run:
                    if kept_counter[0] < 5:
                        print(f"[ms-maris]   sample: {payload}")
                else:
                    upserter.add(payload)
                kept_counter[0] += 1

            if seen_counter[0] % LOG_INTERVAL == 0:
                print(f"[ms-maris]   {shp_path.name}: seen={seen_counter[0]:,} "
                      f"commercial_kept={kept_counter[0]:,} upserted={upserter.upserted:,}")
    finally:
        sf.close()


# --- main / cli -----------------------------------------------------------


def _load_env() -> None:
    env = ROOT / ".env.local"
    if env.exists():
        load_dotenv(env)


def main() -> int:
    parser = argparse.ArgumentParser(description="Mississippi MARIS statewide commercial parcel scraper")
    parser.add_argument("shapefile_dir", nargs="?", default=None,
                        help="Directory containing the MARIS .shp files (or a single .shp path)")
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
        print("[ms-maris] progress reset.")
        return 0

    if not args.shapefile_dir:
        parser.error("shapefile_dir is required (unless --reset)")

    in_path = Path(args.shapefile_dir).expanduser().resolve()
    if not in_path.exists():
        print(f"[ms-maris] path does not exist: {in_path}")
        return 2

    shapefiles = discover_shapefiles(in_path)
    if not shapefiles:
        print(f"[ms-maris] no .shp files found at {in_path}")
        return 2

    print(f"[ms-maris] found {len(shapefiles)} shapefile(s):")
    for s in shapefiles:
        print(f"  - {s.name}")

    if args.preview:
        for s in shapefiles:
            preview_shapefile(s, args.preview_sample)
        return 0

    progress.setdefault("done_files", [])
    done = set(progress["done_files"])
    if args.resume:
        before = len(shapefiles)
        shapefiles = [s for s in shapefiles if s.name not in done]
        print(f"[ms-maris] --resume: skipping {before - len(shapefiles)} already-done file(s)")

    # enforce_sqft_min=False: MARIS does not publish a per-parcel
    # building_sqft column, so the upserter would always see NULL and
    # the check is moot. Make it explicit. Our commercial-vs-not
    # signal is the IMPVAL >= $100k threshold inside classify_ms_cama.
    upserter = SupabaseUpserter(source_detail=SOURCE_DETAIL, enforce_sqft_min=False)

    seen = [0]   # boxed to allow mutation across helper calls
    kept = [0]
    t0 = time.time()
    for s in shapefiles:
        process_shapefile(s, upserter, args.limit, args.dry_run, seen, kept)
        progress["done_files"] = sorted(set(progress["done_files"]) | {s.name})
        progress["records_processed"] = upserter.upserted
        progress.save()
        if args.limit and seen[0] >= args.limit:
            break

    upserter.flush()
    elapsed = time.time() - t0
    print()
    print(f"[ms-maris] DONE in {elapsed/60:.1f}m — "
          f"scanned={seen[0]:,} commercial_kept={kept[0]:,} upserted={upserter.upserted:,}")
    print(f"[ms-maris] stats: {upserter.stats()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
