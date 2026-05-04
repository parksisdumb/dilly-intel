#!/usr/bin/env python3
"""
Florida DOR NAL (Name, Address, Legal) scraper.

Pulls per-county CSV cuts from the Florida Department of Revenue Property
Tax Oversight data portal and upserts commercial properties into
intel_properties with source_detail='fl_dor_public'.

Florida publishes annually with two cuts: Preliminary (~July) and Final
(post-October certification). There is NO single statewide ZIP — files
are per-county (1-67) and we loop them.

Setup:
    pip install requests supabase python-dotenv

Usage:
    python florida_dor_scraper.py --year 2024 --cut final
    python florida_dor_scraper.py --year 2024 --cut prelim --counties 23,13
    python florida_dor_scraper.py --resume        # continue from progress
    python florida_dor_scraper.py --reset

Counties:
    All 67 FL counties run by 2-digit DOR CO_NO (01-67). The CO_NO / name
    map below comes from the FL DOR 2023 NAL/SDF/NAP User's Guide.

Schema mapping (NAL -> intel_properties):
    PARCEL_ID            -> external_id (prefixed with CO_NO for global uniqueness)
    PHY_ADDR1            -> street_address
    PHY_CITY             -> city
    PHY_ZIPCD            -> postal_code
    OWN_NAME             -> owner_name / raw_owner_name
    OWN_ADDR1+OWN_ADDR2  -> owner_mailing_address
    OWN_CITY/STATE/ZIP   -> owner_mailing_city / state / zip
    DOR_UC               -> property_use_code (decoded -> property_use_desc / property_type)
    JV                   -> estimated_value
    TOT_LVG_AREA         -> building_sqft
    ACT_YR_BLT           -> year_built
    LND_SQFOOT           -> lot_size_sqft (when present)

Required: street_address, city, state. State is always 'FL'. Rows missing
PHY_ADDR1 or PHY_CITY are skipped (most are vacant land or out-of-state
PO-box-only owners with no situs).
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import zipfile
from pathlib import Path
from typing import Iterable

import requests

from intel_ingest import (
    SupabaseUpserter,
    Progress,
    classify_fl_dor_uc,
    is_commercial_fl,
)
from intel_ingest.parsers import iter_csv, list_zip_members
from intel_ingest.http_stream import stream_download

ROOT = Path(__file__).parent
DATA_DIR = ROOT / "data" / "fl_dor"
PROGRESS_FILE = ROOT / "progress_florida.json"

SOURCE_DETAIL = "fl_dor_public"

# DOR CO_NO -> (county name, FIPS suffix) for the 67 FL counties.
# FIPS = "12" + suffix (e.g. Miami-Dade 12086). Source: FL DOR User's Guide.
FL_COUNTIES: dict[str, tuple[str, str]] = {
    "11": ("Alachua", "001"),
    "12": ("Baker", "003"),
    "13": ("Bay", "005"),
    "14": ("Bradford", "007"),
    "15": ("Brevard", "009"),
    "16": ("Broward", "011"),
    "17": ("Calhoun", "013"),
    "18": ("Charlotte", "015"),
    "19": ("Citrus", "017"),
    "20": ("Clay", "019"),
    "21": ("Collier", "021"),
    "22": ("Columbia", "023"),
    "23": ("Miami-Dade", "086"),
    "24": ("De Soto", "027"),
    "25": ("Dixie", "029"),
    "26": ("Duval", "031"),
    "27": ("Escambia", "033"),
    "28": ("Flagler", "035"),
    "29": ("Franklin", "037"),
    "30": ("Gadsden", "039"),
    "31": ("Gilchrist", "041"),
    "32": ("Glades", "043"),
    "33": ("Gulf", "045"),
    "34": ("Hamilton", "047"),
    "35": ("Hardee", "049"),
    "36": ("Hendry", "051"),
    "37": ("Hernando", "053"),
    "38": ("Highlands", "055"),
    "39": ("Hillsborough", "057"),
    "40": ("Holmes", "059"),
    "41": ("Indian River", "061"),
    "42": ("Jackson", "063"),
    "43": ("Jefferson", "065"),
    "44": ("Lafayette", "067"),
    "45": ("Lake", "069"),
    "46": ("Lee", "071"),
    "47": ("Leon", "073"),
    "48": ("Levy", "075"),
    "49": ("Liberty", "077"),
    "50": ("Madison", "079"),
    "51": ("Manatee", "081"),
    "52": ("Marion", "083"),
    "53": ("Martin", "085"),
    "54": ("Monroe", "087"),
    "55": ("Nassau", "089"),
    "56": ("Okaloosa", "091"),
    "57": ("Okeechobee", "093"),
    "58": ("Orange", "095"),
    "59": ("Osceola", "097"),
    "60": ("Palm Beach", "099"),
    "61": ("Pasco", "101"),
    "62": ("Pinellas", "103"),
    "63": ("Polk", "105"),
    "64": ("Putnam", "107"),
    "65": ("Saint Johns", "109"),
    "66": ("Saint Lucie", "111"),
    "67": ("Santa Rosa", "113"),
    "68": ("Sarasota", "115"),
    "69": ("Seminole", "117"),
    "70": ("Sumter", "119"),
    "71": ("Suwannee", "121"),
    "72": ("Taylor", "123"),
    "73": ("Union", "125"),
    "74": ("Volusia", "127"),
    "75": ("Wakulla", "129"),
    "76": ("Walton", "131"),
    "77": ("Washington", "133"),
}

# FL DOR hosts NAL files in a SharePoint document library. The reliable way
# to discover the current per-county filename is the SharePoint REST API,
# which returns JSON listings of every file in a given folder. The portal
# only hosts the *current* cut (older years are by-request only), so we
# don't try to predict — we list and match.
#
# Folder pattern (URL-encoded path goes in the GetFolderByServerRelativeUrl
# argument; CUT folder uses single letter F or P):
#
#   /property/dataportal/Documents/PTO Data Portal/Tax Roll Data Files/
#       NAL/{YEAR}{F|P}/
#
# Filenames inside use the FORM:
#   <County Display Name> <CO_NO> Final NAL <YEAR>.zip
#   <County Display Name> <CO_NO> Preliminary NAL <YEAR>.zip
SHAREPOINT_API = (
    "https://floridarevenue.com/property/dataportal/_api/web/"
    "GetFolderByServerRelativeUrl('{folder_path}')/Files"
)
SHAREPOINT_FOLDER_TEMPLATE = (
    "/property/dataportal/Documents/PTO Data Portal/Tax Roll Data Files/NAL/{year}{cut_letter}"
)

# Filename templates are a last resort if the SharePoint API call itself
# fails. County display name overrides handle the spelling drift between
# the User's Guide names and the actual filenames on disk.
COUNTY_NAME_OVERRIDES: dict[str, str] = {
    "23": "Dade",          # User's Guide = Miami-Dade, file = Dade
    "24": "Desoto",        # = De Soto, file = Desoto
    "65": "Saint Johns",   # OK as-is
    "66": "Saint Lucie",   # OK as-is
}


def _county_display_name(co_no: str) -> str:
    """Return the spelling that appears in the actual zip filename."""
    if co_no in COUNTY_NAME_OVERRIDES:
        return COUNTY_NAME_OVERRIDES[co_no]
    name = FL_COUNTIES[co_no][0]
    return name


CUT_LETTER = {"final": "F", "prelim": "P"}
CUT_WORD = {"final": "Final", "prelim": "Preliminary"}

# Filename fallback if SharePoint API fails — formed from the display name.
FILENAME_TEMPLATE = "{display_name} {co_no} {cut_word} NAL {year}.zip"

CHUNK_LOG_INTERVAL = 10_000


def _normalize_int(s: str | None) -> int | None:
    if s is None or s == "":
        return None
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


def _normalize_float(s: str | None) -> float | None:
    if s is None or s == "":
        return None
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _join_addr(addr1: str | None, addr2: str | None) -> str | None:
    parts = [p.strip() for p in (addr1, addr2) if p and p.strip()]
    if not parts:
        return None
    return ", ".join(parts)


def map_nal_row(
    row: dict[str, str],
    co_no: str,
    county_name: str,
    county_fips: str,
    data_year: int,
) -> dict | None:
    """
    Map one NAL row to an intel_properties payload. Returns None if the row
    is non-commercial or lacks required fields. Caller doesn't filter; this
    function does.
    """
    dor_uc = row.get("DOR_UC", "").strip()
    if not is_commercial_fl(dor_uc):
        return None

    parcel_id = row.get("PARCEL_ID", "").strip()
    if not parcel_id:
        return None

    bucket, desc, _ = classify_fl_dor_uc(dor_uc)

    street = row.get("PHY_ADDR1", "").strip() or None
    city = row.get("PHY_CITY", "").strip() or None
    if not street or not city:
        return None  # SupabaseUpserter would skip anyway, save the upsert call

    payload = {
        "external_id": f"{co_no}-{parcel_id}",
        "source_detail": SOURCE_DETAIL,
        "street_address": street,
        "city": city,
        "state": "FL",
        "postal_code": (row.get("PHY_ZIPCD") or "").strip()[:10] or None,
        "county": county_name,
        "county_fips": "12" + county_fips,
        "data_year": data_year,
        "owner_name": (row.get("OWN_NAME") or "").strip() or None,
        "raw_owner_name": (row.get("OWN_NAME") or "").strip() or None,
        "owner_mailing_address": _join_addr(row.get("OWN_ADDR1"), row.get("OWN_ADDR2")),
        "owner_mailing_city": (row.get("OWN_CITY") or "").strip() or None,
        "owner_mailing_state": (row.get("OWN_STATE") or "").strip() or None,
        "owner_mailing_zip": (row.get("OWN_ZIPCD") or "").strip()[:10] or None,
        "property_type": bucket,
        "property_use_code": dor_uc or None,
        "property_use_desc": desc,
        "estimated_value": _normalize_float(row.get("JV")),
        "assessed_value": _normalize_int(row.get("JV")),
        "building_sqft": _normalize_float(row.get("TOT_LVG_AREA")),
        "sq_footage": _normalize_int(row.get("TOT_LVG_AREA")),
        "lot_size_sqft": _normalize_float(row.get("LND_SQFOOT")),
        "year_built": _normalize_int(row.get("ACT_YR_BLT")),
    }
    return payload


def find_csv_in_zip(zip_path: Path) -> str:
    """FL DOR ZIPs contain a single NAL CSV — find its name."""
    members = list_zip_members(zip_path)
    # Prefer files named NAL*.csv or *.csv
    for name in members:
        if name.lower().endswith(".csv") and "nal" in name.lower():
            return name
    for name in members:
        if name.lower().endswith(".csv"):
            return name
    raise FileNotFoundError(
        f"No CSV inside {zip_path.name}. Members: {members[:5]}"
    )


# Cache: (year, cut) -> {co_no: full_url}. Populated lazily on first call;
# one SharePoint request lists all 67 counties at once.
_FOLDER_INDEX_CACHE: dict[tuple[int, str], dict[str, str]] = {}


def fetch_sharepoint_index(year: int, cut: str) -> dict[str, str]:
    """
    Query the SharePoint REST API for the NAL folder of (year, cut) and
    return {co_no: download_url}. Cached per (year, cut). Returns {} on
    failure — caller should try the filename fallback.
    """
    key = (year, cut)
    if key in _FOLDER_INDEX_CACHE:
        return _FOLDER_INDEX_CACHE[key]

    cut_letter = CUT_LETTER[cut]
    folder_path = SHAREPOINT_FOLDER_TEMPLATE.format(year=year, cut_letter=cut_letter)
    api_url = SHAREPOINT_API.format(folder_path=folder_path)

    headers = {
        "Accept": "application/json;odata=verbose",
        "User-Agent": "Mozilla/5.0 (compatible; DillyIntel/1.0)",
    }
    try:
        r = requests.get(api_url, headers=headers, timeout=60)
        r.raise_for_status()
        data = r.json()
    except (requests.RequestException, ValueError) as e:
        print(f"[fl] SharePoint API failed for {year}{cut_letter}: {e}")
        _FOLDER_INDEX_CACHE[key] = {}
        return {}

    files = (data.get("d", {}) or {}).get("results", []) or []
    index: dict[str, str] = {}
    base_origin = "https://floridarevenue.com"

    import re as _re
    # Match `<Display> <co_no> Final NAL <year>.zip` — the CO_NO sits between
    # the display name and the cut word.
    pat = _re.compile(r"\s(\d{2})\s+(?:Final|Preliminary)\s+NAL\b", _re.I)

    for f in files:
        name = f.get("Name") or ""
        srv = f.get("ServerRelativeUrl") or ""
        if not name.lower().endswith(".zip"):
            continue
        m = pat.search(name)
        if not m:
            continue
        co_no = m.group(1)
        # Fully-qualified URL — server-relative path needs origin prefix.
        full_url = base_origin + requests.utils.requote_uri(srv)
        index[co_no] = full_url

    _FOLDER_INDEX_CACHE[key] = index
    print(f"[fl] SharePoint index for {year}{cut_letter}: {len(index)} files cataloged")
    return index


def template_url(co_no: str, year: int, cut: str) -> str:
    """Construct a candidate download URL from the filename template."""
    display = _county_display_name(co_no)
    cut_word = CUT_WORD[cut]
    cut_letter = CUT_LETTER[cut]
    folder_path = SHAREPOINT_FOLDER_TEMPLATE.format(year=year, cut_letter=cut_letter)
    filename = FILENAME_TEMPLATE.format(
        display_name=display, co_no=co_no, cut_word=cut_word, year=year
    )
    return "https://floridarevenue.com" + requests.utils.requote_uri(f"{folder_path}/{filename}")


def download_county_zip(
    co_no: str,
    year: int,
    cut: str,
    url_template: str | None,
) -> Path | None:
    """
    Resolve the county's NAL zip URL via SharePoint REST API (preferred),
    fall back to the filename template if that fails. Stream-download to
    DATA_DIR; return Path or None on 404.

    `url_template` is honored when explicitly supplied (advanced override).
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    dest = DATA_DIR / f"{year}_{cut}_{co_no}.zip"

    if dest.exists() and dest.stat().st_size > 1024:
        return dest

    candidates: list[str] = []
    if url_template:
        # Caller-supplied — use exclusively so they can pin a specific URL.
        candidates.append(
            url_template.format(year=year, cut=cut.lower(), co_no=co_no)
        )
    else:
        index = fetch_sharepoint_index(year, cut)
        if co_no in index:
            candidates.append(index[co_no])
        # Fallback: filename-templated URL
        candidates.append(template_url(co_no, year, cut))

    headers = {"User-Agent": "Mozilla/5.0 (compatible; DillyIntel/1.0)"}
    last_err: Exception | None = None
    for url in candidates:
        try:
            stream_download(url, dest, headers=headers, resume=False)
            if dest.exists() and dest.stat().st_size > 1024:
                return dest
        except requests.HTTPError as e:
            last_err = e
            if dest.exists():
                try:
                    dest.unlink()
                except OSError:
                    pass
            if e.response is not None and e.response.status_code == 404:
                continue
            raise
        except requests.RequestException as e:
            last_err = e
            continue

    if last_err:
        print(f"[fl] county {co_no}: download failed - {last_err}")
    return None


def process_county(
    co_no: str,
    year: int,
    cut: str,
    upserter: SupabaseUpserter,
    progress: Progress,
    url_template: str | None,
) -> int:
    name, fips_suffix = FL_COUNTIES[co_no]
    print(f"[fl] {co_no} {name}: starting…")

    zip_path = download_county_zip(co_no, year, cut, url_template)
    if zip_path is None:
        progress.add_failed({"county": co_no, "name": name, "reason": "download_404"})
        progress.save()
        return 0

    try:
        csv_name = find_csv_in_zip(zip_path)
    except FileNotFoundError as e:
        progress.add_failed({"county": co_no, "name": name, "reason": str(e)})
        progress.save()
        return 0

    processed = 0
    kept = 0
    with zipfile.ZipFile(zip_path, "r") as zf:
        with zf.open(csv_name) as raw:
            import io
            text = io.TextIOWrapper(raw, encoding="utf-8", errors="replace", newline="")
            for row in iter_csv(text):
                processed += 1
                payload = map_nal_row(row, co_no, name, fips_suffix, year)
                if payload is not None:
                    upserter.add(payload)
                    kept += 1
                if processed % CHUNK_LOG_INTERVAL == 0:
                    print(
                        f"[fl] {co_no} {name}: {processed:,} rows scanned, "
                        f"{kept:,} commercial kept (upserted={upserter.upserted:,})"
                    )

    upserter.flush()
    print(
        f"[fl] {co_no} {name}: DONE — scanned={processed:,} kept={kept:,} "
        f"upserted={upserter.upserted:,} (cumulative)"
    )
    return processed


def main() -> int:
    parser = argparse.ArgumentParser(description="FL DOR NAL scraper")
    parser.add_argument(
        "--year",
        type=int,
        default=2025,
        help="tax-roll year. FL hosts only the current year publicly; older years require a request to PTOTechnology@floridarevenue.com.",
    )
    parser.add_argument("--cut", choices=["prelim", "final"], default="final")
    parser.add_argument(
        "--counties",
        type=str,
        default="",
        help="comma-separated list of CO_NO codes (default: all 67)",
    )
    parser.add_argument("--resume", action="store_true", help="skip counties already in done list")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--url-template", type=str, default=None)
    args = parser.parse_args()

    progress = Progress(PROGRESS_FILE)
    if args.reset:
        progress.reset()
        print("[fl] progress reset.")
        return 0

    progress.setdefault("done_counties", [])
    done = set(progress["done_counties"])

    if args.counties:
        counties = [c.strip() for c in args.counties.split(",") if c.strip()]
    else:
        counties = list(FL_COUNTIES.keys())

    if args.resume:
        counties = [c for c in counties if c not in done]
        print(f"[fl] resume: {len(counties)} counties remaining (skipping {len(done)} done)")

    upserter = SupabaseUpserter(source_detail=SOURCE_DETAIL)

    for co_no in counties:
        if co_no not in FL_COUNTIES:
            print(f"[fl] WARN: unknown CO_NO {co_no} — skipping")
            continue
        try:
            process_county(co_no, args.year, args.cut, upserter, progress, args.url_template)
            progress.setdefault("done_counties", []).append(co_no)
            progress["records_processed"] = upserter.upserted
            progress.save()
        except KeyboardInterrupt:
            upserter.flush()
            print("[fl] interrupted — saving progress…")
            progress.save()
            return 130
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            progress.add_failed({"county": co_no, "error": str(e)})
            progress.save()
            print(f"[fl] {co_no}: ERROR — continuing to next county")
            continue

    print("[fl] all counties processed.")
    print(f"[fl] stats: {upserter.stats()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
