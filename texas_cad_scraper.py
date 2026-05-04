#!/usr/bin/env python3
"""
Texas County Appraisal District scraper.

Three counties currently supported, selected via --county:

  hcad    Harris County (Houston)
          - Fixed-width TXT files: real_acct.txt, building_res.txt,
            building_other.txt, owner.txt
          - Public, no anti-bot, year-stamped folders.
          - Use code: state_class

  dcad    Dallas County
          - ZIP of CSV files behind a ViewPDFs.aspx wrapper. We scrape
            the index page (dataproducts.aspx) for the current `id=`,
            then GET that wrapper which streams the .zip.
          - Use code: LUC

  tad     Tarrant County (Fort Worth)
          - Pipe-delimited TXT files inside a ZIP, behind a WAF that
            blocks default Python requests.
          - Browser User-Agent + Referer required on every call.
          - Use code: State_Use_Cd

Setup:
    pip install requests beautifulsoup4 supabase python-dotenv

Usage:
    python texas_cad_scraper.py --county hcad
    python texas_cad_scraper.py --county dcad
    python texas_cad_scraper.py --county tad
    python texas_cad_scraper.py --county hcad --year 2025
    python texas_cad_scraper.py --county hcad --resume
    python texas_cad_scraper.py --county dcad --reset

Each county handler downloads its file(s) into ./data/tx_cad_<county>/,
streams parsing in 10k-row log intervals, and upserts via the shared
SupabaseUpserter. Progress is checkpointed to progress_tx_<county>.json
so a Ctrl-C run can resume.
"""
from __future__ import annotations

import argparse
import io
import re
import sys
import time
import zipfile
from pathlib import Path
from typing import Iterable

import requests

from intel_ingest import (
    SupabaseUpserter,
    Progress,
    classify_tx_state_class,
    is_commercial_tx,
    browser_headers,
    stream_download,
)
from intel_ingest.parsers import iter_csv, iter_pipe_delimited, iter_fixed_width, list_zip_members

ROOT = Path(__file__).parent
DATA_ROOT = ROOT / "data"
LOG_INTERVAL = 10_000


# -------------------------------------------------------------------------
# Shared helpers
# -------------------------------------------------------------------------


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


# -------------------------------------------------------------------------
# HCAD — Harris County
# -------------------------------------------------------------------------

HCAD_BASE = "https://download.hcad.org/data"
HCAD_FALLBACK_BASE = "https://hcad.org/pdata"
HCAD_SOURCE = "tx_cad_hcad"

# Column specs — verified against HCAD Definition_help.pdf. Only the columns
# we actually use; the codebook defines many more.
# Spec format: (field_name, start_1based, end_1based)
HCAD_REAL_ACCT_SPEC = [
    ("acct", 1, 13),
    ("yr", 14, 17),
    ("mailto", 18, 117),
    ("mail_addr_1", 118, 217),
    ("mail_addr_2", 218, 317),
    ("mail_city", 318, 357),
    ("mail_state", 358, 359),
    ("mail_zip", 360, 369),
    ("str_pfx", 370, 379),
    ("str_num", 380, 389),
    ("str_num_sfx", 390, 399),
    ("str", 400, 449),
    ("str_sfx", 450, 459),
    ("str_sfx_dir", 460, 469),
    ("str_unit", 470, 479),
    ("site_addr_1", 480, 579),
    ("site_addr_2", 580, 619),
    ("site_addr_3", 620, 633),
    ("state_class", 634, 639),
    ("school_dist", 640, 645),
    ("map_facet", 646, 661),
    ("key_map", 662, 669),
    ("neighborhood_code", 670, 679),
    ("neighborhood_grp", 680, 685),
    ("market_area_1", 686, 691),
    ("market_area_1_dscr", 692, 745),
    ("market_area_2", 746, 751),
    ("market_area_2_dscr", 752, 805),
    ("econ_area", 806, 811),
    ("econ_bld_class", 812, 818),
    ("center_code", 819, 824),
    ("yr_impr", 825, 828),
    ("yr_annexed", 829, 832),
    ("splt_dt", 833, 842),
    ("dba", 843, 942),
    ("tradename", 943, 1042),
    ("prior_yr_impr", 1043, 1054),
    ("prior_yr_land", 1055, 1066),
    ("prior_yr_total", 1067, 1078),
    ("new_construction", 1079, 1090),
    ("tot_appr_val", 1091, 1102),
    ("tot_mkt_val", 1103, 1114),
    ("bld_ar", 1115, 1126),
    ("land_ar", 1127, 1138),
    ("acreage", 1139, 1150),
    ("land_val", 1151, 1162),
    ("bld_val", 1163, 1174),
    ("x_features_val", 1175, 1186),
    ("ag_val", 1187, 1198),
    ("assessed_val", 1199, 1210),
    ("tot_appraised_val", 1211, 1222),
    ("legal_dscr_1", 1223, 1262),
    ("legal_dscr_2", 1263, 1302),
    ("legal_dscr_3", 1303, 1342),
    ("legal_dscr_4", 1343, 1382),
    ("jurs", 1383, 1582),
]


def hcad_resolve_urls(year: int) -> list[tuple[str, str]]:
    """Return [(filename, url), ...] for the per-year real_acct.txt file."""
    candidates = [
        (f"real_acct.txt", f"{HCAD_BASE}/{year}/real_acct.txt"),
        (f"real_acct.zip", f"{HCAD_BASE}/{year}/real_acct.zip"),
        (f"real_acct.txt", f"{HCAD_FALLBACK_BASE}/{year}/real_acct.txt"),
        (f"Real_acct_owner.zip", f"{HCAD_BASE}/{year}/Real_acct_owner.zip"),
    ]
    return candidates


def hcad_download(year: int) -> Path:
    """
    Try each candidate URL until one streams cleanly. HCAD posts files in
    year folders; first candidate works for current-year cuts, fallbacks
    handle older or alternate paths.
    """
    dest_dir = DATA_ROOT / f"tx_cad_hcad_{year}"
    dest_dir.mkdir(parents=True, exist_ok=True)
    headers = browser_headers(referer="https://hcad.org/pdata/pdata-property-downloads.html")

    last_err: Exception | None = None
    for filename, url in hcad_resolve_urls(year):
        dest = dest_dir / filename
        try:
            stream_download(url, dest, headers=headers, resume=True)
            if dest.exists() and dest.stat().st_size > 1024:
                print(f"[hcad] downloaded {url} -> {dest} ({dest.stat().st_size:,} bytes)")
                return dest
        except requests.HTTPError as e:
            last_err = e
            if e.response is not None and e.response.status_code == 404:
                continue
            raise
        except requests.RequestException as e:
            last_err = e
            continue

    raise RuntimeError(f"All HCAD URL candidates failed. Last error: {last_err}")


def hcad_iter_real_acct(path: Path) -> Iterable[dict[str, str]]:
    """Open real_acct.txt (or its enclosing ZIP) and yield parsed rows."""
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path, "r") as zf:
            target = next(
                (n for n in zf.namelist() if n.lower().endswith("real_acct.txt")),
                None,
            )
            if target is None:
                raise FileNotFoundError(f"real_acct.txt not in {path}")
            with zf.open(target) as raw:
                text = io.TextIOWrapper(raw, encoding="latin-1", errors="replace")
                yield from iter_fixed_width(text, HCAD_REAL_ACCT_SPEC)
    else:
        yield from iter_fixed_width(path, HCAD_REAL_ACCT_SPEC)


def hcad_map_row(row: dict[str, str], year: int) -> dict | None:
    state_class = row.get("state_class") or ""
    if not is_commercial_tx(state_class):
        return None

    acct = (row.get("acct") or "").strip()
    if not acct:
        return None

    # Build site address from the parsed parts. site_addr_1 is the cleanest
    # combined field when populated; fall back to component pieces.
    site = (row.get("site_addr_1") or "").strip()
    if not site:
        parts = [
            row.get("str_num", "").strip(),
            row.get("str_pfx", "").strip(),
            row.get("str", "").strip(),
            row.get("str_sfx", "").strip(),
        ]
        site = " ".join([p for p in parts if p])

    city = (row.get("site_addr_2") or "").strip() or "Houston"

    if not site:
        return None

    bucket, desc, _ = classify_tx_state_class(state_class)

    return {
        "external_id": f"HCAD-{acct}",
        "source_detail": HCAD_SOURCE,
        "street_address": site,
        "city": city,
        "state": "TX",
        "postal_code": (row.get("site_addr_3") or "").strip()[:10] or None,
        "county": "Harris",
        "county_fips": "48201",
        "data_year": year,
        "owner_name": (row.get("mailto") or "").strip() or None,
        "raw_owner_name": (row.get("mailto") or "").strip() or None,
        "owner_mailing_address": " ".join(
            p.strip()
            for p in [row.get("mail_addr_1", ""), row.get("mail_addr_2", "")]
            if p and p.strip()
        ) or None,
        "owner_mailing_city": (row.get("mail_city") or "").strip() or None,
        "owner_mailing_state": (row.get("mail_state") or "").strip() or None,
        "owner_mailing_zip": (row.get("mail_zip") or "").strip()[:10] or None,
        "property_type": bucket,
        "property_use_code": state_class.strip() or None,
        "property_use_desc": desc,
        "year_built": _normalize_int(row.get("yr_impr")),
        "estimated_value": _normalize_float(row.get("tot_mkt_val")),
        "assessed_value": _normalize_int(row.get("assessed_val")),
        "building_sqft": _normalize_float(row.get("bld_ar")),
        "sq_footage": _normalize_int(row.get("bld_ar")),
        "lot_size_sqft": _normalize_float(row.get("land_ar")),
    }


def run_hcad(args: argparse.Namespace) -> int:
    progress = Progress(ROOT / "progress_tx_hcad.json")
    if args.reset:
        progress.reset()
        return 0

    upserter = SupabaseUpserter(source_detail=HCAD_SOURCE)
    path = hcad_download(args.year)

    seen = 0
    kept = 0
    for row in hcad_iter_real_acct(path):
        seen += 1
        payload = hcad_map_row(row, args.year)
        if payload is not None:
            upserter.add(payload)
            kept += 1
        if seen % LOG_INTERVAL == 0:
            print(
                f"[hcad] {seen:,} rows scanned, {kept:,} commercial, "
                f"upserted={upserter.upserted:,}"
            )
            progress["records_processed"] = upserter.upserted
            progress["last_offset"] = seen
            progress.save()
        if args.max_features and seen >= args.max_features:
            break

    upserter.flush()
    print(f"[hcad] DONE — seen={seen:,} kept={kept:,} stats={upserter.stats()}")
    return 0


# -------------------------------------------------------------------------
# DCAD — Dallas County
# -------------------------------------------------------------------------

DCAD_INDEX = "https://www.dallascad.org/dataproducts.aspx"
DCAD_VIEWPDFS = "https://www.dallascad.org/ViewPDFs.aspx"
DCAD_SOURCE = "tx_cad_dcad"


def dcad_resolve_zip_url(prefer_label_substr: str = "Certified", year: int | None = None) -> tuple[str, str]:
    """
    Scrape dallascad.org/dataproducts.aspx for the ZIP-wrapper id of the
    most recent Certified Appraisal Roll (or Proposed if --proposed).
    Returns (label, full_url).

    BeautifulSoup is required.
    """
    try:
        from bs4 import BeautifulSoup  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "DCAD scraping requires beautifulsoup4. Install with `pip install beautifulsoup4`."
        ) from e

    headers = browser_headers(referer="https://www.dallascad.org/")
    r = requests.get(DCAD_INDEX, headers=headers, timeout=60)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    # DCAD's `id=` is the literal Windows UNC path to the file
    # (e.g. \\DCAD.ORG\WEB\WEBDATA\WEBFORMS\DATA PRODUCTS\DCAD2025_CURRENT.ZIP),
    # not a numeric record ID. Accept any non-empty value.
    pat = re.compile(r"ViewPDFs\.aspx\?type=([^&]+)&id=([^&\"\']+)", re.I)
    candidates: list[tuple[str, str, str]] = []  # (label, type, id)

    for a in soup.find_all("a", href=True):
        href = a.get("href") or ""
        m = pat.search(href)
        if not m:
            continue
        label = (a.get_text() or "").strip()
        if not label:
            continue
        candidates.append((label, m.group(1), m.group(2)))

    if not candidates:
        raise RuntimeError("No ViewPDFs.aspx links found on DCAD index page")

    def score(c: tuple[str, str, str]) -> int:
        label = c[0].lower()
        id_path = c[2].lower()
        s = 0
        # Prefer the requested cut (Certified / Proposed) by label match
        if prefer_label_substr.lower() in label:
            s += 100
        # The yearly DCADYYYY_CURRENT.ZIP bundle is what we want — it
        # contains the full Account_Info CSV bundle with res + com.
        if "_current.zip" in id_path:
            s += 60
        if "csv" in label or "comma" in label:
            s += 30
        if year and str(year) in label:
            s += 30
        # Avoid BPP-only / ARB / appraisal-notice-mail bundles
        if any(t in id_path for t in ("bpp", "arb", "mail", "supplemental")):
            s -= 50
        return s

    candidates.sort(key=score, reverse=True)
    label, type_, id_ = candidates[0]
    # URL-encode the id (it has backslashes, spaces, etc.). requests handles
    # the actual GET, but constructing a clean URL string for logs is nicer.
    url = DCAD_VIEWPDFS + "?type=" + requests.utils.quote(type_, safe="") + "&id=" + requests.utils.quote(id_, safe="")
    return label, url


def dcad_download(prefer_label: str, year: int | None) -> Path:
    label, url = dcad_resolve_zip_url(prefer_label, year)
    print(f"[dcad] picked '{label}' -> {url}")

    dest_dir = DATA_ROOT / "tx_cad_dcad"
    dest_dir.mkdir(parents=True, exist_ok=True)
    safe_label = re.sub(r"[^A-Za-z0-9_-]+", "_", label)[:80]
    dest = dest_dir / f"{safe_label}.zip"

    headers = browser_headers(referer=DCAD_INDEX)
    stream_download(url, dest, headers=headers, resume=False)
    if not dest.exists() or dest.stat().st_size < 1024:
        raise RuntimeError(f"DCAD download empty for {url}")
    return dest


def dcad_pick_account_csv(zip_path: Path) -> str:
    """Find the Account_Info CSV inside DCAD's bundle."""
    members = list_zip_members(zip_path)
    for n in members:
        ln = n.lower()
        if ln.endswith(".csv") and ("account_info" in ln or "account info" in ln):
            return n
    # Fallback: first CSV
    for n in members:
        if n.lower().endswith(".csv"):
            return n
    raise FileNotFoundError(f"No CSV in DCAD ZIP {zip_path.name}: {members[:5]}")


# DCAD's bundle is normalized across multiple CSVs. Commercial-relevant data
# lives in COM_DETAIL.CSV (small, ~25MB) keyed by ACCOUNT_NUM; address +
# owner data lives in ACCOUNT_INFO.CSV (~350MB). We load COM_DETAIL into a
# dict first (acting as a commercial-account allowlist + attribute source),
# then stream ACCOUNT_INFO and emit payloads only for accounts in the dict.

# Map BLDG_CLASS_DESC keywords -> /intelligence buckets. The class desc is a
# rich English string (e.g. "FAST FOOD RESTAURANT", "OFFICE BUILDING LOW
# RISE", "WAREHOUSE-DISTRIBUTION") so substring match works well.
_DCAD_BUCKET_RULES = [
    (("OFFICE",), "office"),
    (("WAREHOUSE", "DISTRIBUTION", "INDUSTRIAL", "MANUFACT", "FLEX"), "industrial"),
    (("APARTMENT", "MULTIFAM", "MULTI FAM"), "multifamily"),
    (("HOSPITAL", "MEDICAL", "NURSING", "CLINIC", "HEALTH"), "healthcare"),
    (("HOTEL", "MOTEL", "LODG"), "hospitality"),
    (("STORAGE",), "self_storage"),
    (("MIXED",), "mixed_use"),
    (("RESTAURANT", "RETAIL", "STORE", "SHOPPING", "MALL", "FOOD",
      "AUTO", "GAS", "BANK", "FINANCIAL", "DEALERSHIP"), "retail"),
]


def _dcad_bucket_for(class_desc: str) -> str:
    s = (class_desc or "").upper()
    for keys, bucket in _DCAD_BUCKET_RULES:
        if any(k in s for k in keys):
            return bucket
    return "other_commercial"


def _dcad_load_com_detail(zip_path: Path) -> dict[str, dict]:
    """
    Read COM_DETAIL.CSV (commercial buildings only) into memory keyed by
    ACCOUNT_NUM. Multiple buildings can share an account (NUM_STORIES = 1
    each), so when duplicates appear we keep the largest (highest
    GROSS_BLDG_AREA) and sum sqft for storage purposes.
    """
    print("[dcad] loading COM_DETAIL.CSV (commercial-only allowlist)...")
    out: dict[str, dict] = {}
    with zipfile.ZipFile(zip_path, "r") as zf:
        with zf.open("COM_DETAIL.CSV") as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8", errors="replace", newline="")
            for row in iter_csv(text):
                acct = (row.get("ACCOUNT_NUM") or "").strip()
                if not acct:
                    continue
                # Sum sqft across multiple buildings on the same account
                sqft = _normalize_float(row.get("GROSS_BLDG_AREA")) or 0.0
                lease = _normalize_float(row.get("NET_LEASE_AREA")) or 0.0
                if acct in out:
                    existing = out[acct]
                    existing["_total_sqft"] = (existing.get("_total_sqft") or 0.0) + sqft
                    existing["_total_lease"] = (existing.get("_total_lease") or 0.0) + lease
                    # Keep the row with the bigger building as the "primary"
                    if sqft > (existing.get("_primary_sqft") or 0.0):
                        existing.update({k: v for k, v in row.items() if v})
                        existing["_primary_sqft"] = sqft
                else:
                    row["_total_sqft"] = sqft
                    row["_total_lease"] = lease
                    row["_primary_sqft"] = sqft
                    out[acct] = dict(row)
    print(f"[dcad] loaded {len(out):,} commercial accounts from COM_DETAIL")
    return out


def dcad_map_row(row: dict[str, str], year: int, com_detail: dict[str, dict]) -> dict | None:
    """
    Map one ACCOUNT_INFO row to an intel_properties payload IF the account
    appears in the commercial allowlist (com_detail dict). Otherwise None.
    """
    account = (row.get("ACCOUNT_NUM") or "").strip()
    if not account:
        return None
    com = com_detail.get(account)
    if com is None:
        return None  # not a commercial account

    # Address — concat STREET_NUM + FULL_STREET_NAME. UNIT_ID and BLDG_ID
    # appended for sub-units when present.
    parts = [
        (row.get("STREET_NUM") or "").strip(),
        (row.get("STREET_HALF_NUM") or "").strip(),
        (row.get("FULL_STREET_NAME") or "").strip(),
    ]
    site_addr = " ".join(p for p in parts if p).strip() or None
    unit = (row.get("UNIT_ID") or "").strip()
    if unit and site_addr:
        site_addr = f"{site_addr} #{unit}"
    city = (row.get("PROPERTY_CITY") or "").strip() or None
    if not site_addr or not city:
        return None

    bldg_class = (com.get("BLDG_CLASS_DESC") or "").strip() or None
    bucket = _dcad_bucket_for(bldg_class or "")

    # Owner mailing — DCAD splits owner address across up to 4 lines. Lines
    # 1 and 2 commonly hold a c/o name + the actual street; we join non-empty.
    owner_mail = " ".join(
        (row.get(k) or "").strip()
        for k in ("OWNER_ADDRESS_LINE1", "OWNER_ADDRESS_LINE2", "OWNER_ADDRESS_LINE3", "OWNER_ADDRESS_LINE4")
        if (row.get(k) or "").strip()
    ).strip() or None

    # Building size: prefer summed sqft across all buildings, fall back to
    # primary GROSS_BLDG_AREA on the COM_DETAIL row.
    sqft = com.get("_total_sqft") or _normalize_float(com.get("GROSS_BLDG_AREA"))

    return {
        "external_id": f"DCAD-{account}",
        "source_detail": DCAD_SOURCE,
        "street_address": site_addr,
        "city": city,
        "state": "TX",
        "postal_code": (row.get("PROPERTY_ZIPCODE") or "").strip()[:10] or None,
        "county": "Dallas",
        "county_fips": "48113",
        "data_year": year,
        "property_name": (com.get("PROPERTY_NAME") or row.get("BIZ_NAME") or "").strip() or None,
        "owner_name": (row.get("OWNER_NAME1") or "").strip() or None,
        "raw_owner_name": (row.get("OWNER_NAME1") or "").strip() or None,
        "owner_mailing_address": owner_mail,
        "owner_mailing_city": (row.get("OWNER_CITY") or "").strip() or None,
        "owner_mailing_state": (row.get("OWNER_STATE") or "").strip() or None,
        "owner_mailing_zip": (row.get("OWNER_ZIPCODE") or "").strip()[:10] or None,
        "property_type": bucket,
        # No standardized use code on COM_DETAIL — keep BLDG_CLASS_DESC as
        # the descriptor and reuse the abbreviation as a code.
        "property_use_code": (bldg_class or "")[:32] or None,
        "property_use_desc": bldg_class,
        "year_built": _normalize_int(com.get("YEAR_BUILT")),
        "estimated_value": _normalize_float(com.get("MKT_VAL")),
        "assessed_value": _normalize_int(com.get("MKT_VAL")),
        "building_sqft": sqft,
        "sq_footage": int(sqft) if sqft else None,
    }


def run_dcad(args: argparse.Namespace) -> int:
    progress = Progress(ROOT / "progress_tx_dcad.json")
    if args.reset:
        progress.reset()
        return 0

    label_pref = "Proposed" if args.proposed else "Certified"
    zip_path = dcad_download(label_pref, args.year)

    # Load commercial allowlist + building attributes first
    com_detail = _dcad_load_com_detail(zip_path)

    print(f"[dcad] streaming ACCOUNT_INFO.CSV (joining on ACCOUNT_NUM)")
    upserter = SupabaseUpserter(source_detail=DCAD_SOURCE)
    seen = 0
    kept = 0
    with zipfile.ZipFile(zip_path, "r") as zf:
        with zf.open("ACCOUNT_INFO.CSV") as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8", errors="replace", newline="")
            for row in iter_csv(text):
                seen += 1
                payload = dcad_map_row(row, args.year or 0, com_detail)
                if payload is not None:
                    upserter.add(payload)
                    kept += 1
                if seen % LOG_INTERVAL == 0:
                    print(
                        f"[dcad] {seen:,} rows scanned, {kept:,} commercial, "
                        f"upserted={upserter.upserted:,}"
                    )
                    progress["records_processed"] = upserter.upserted
                    progress["last_offset"] = seen
                    progress.save()
                if args.max_features and seen >= args.max_features:
                    break

    upserter.flush()
    print(f"[dcad] DONE — seen={seen:,} kept={kept:,} stats={upserter.stats()}")
    return 0


# -------------------------------------------------------------------------
# TAD — Tarrant County
# -------------------------------------------------------------------------

TAD_INDEX = "https://www.tad.org/resources/data-downloads"
TAD_REFERER = "https://www.tad.org/"
TAD_SOURCE = "tx_cad_tad"

# TAD publishes ZIPs at `/content/data-download/PropertyData*.ZIP`. We want
# the Commercial-only file when available — much smaller than the full set
# and avoids us scanning ~2M residential rows just to throw them away.
#
# Filename patterns observed on the live page (2026-04-28):
#   PropertyData(Delimited)_C.ZIP          <- current "live" stub (538 bytes,
#                                            regenerated daily; usually empty)
#   PropertyData_C_2025(Certified).ZIP     <- 5.3 MB, real Commercial roll
#   PropertyData(Delimited).ZIP            <- 79 MB current full set
#   PropertyData_2025(Certified).ZIP       <- 82 MB certified full set
#
# We HEAD-probe each candidate's Content-Length to skip stubs (anything
# < 100 KB is a placeholder, not real parcel data).
MIN_REAL_ZIP_BYTES = 100_000


def tad_resolve_zip_url(prefer_commercial: bool = True) -> str:
    try:
        from bs4 import BeautifulSoup  # type: ignore
    except ImportError as e:
        raise RuntimeError("TAD scraping requires beautifulsoup4.") from e

    headers = browser_headers(referer=TAD_REFERER)
    r = requests.get(TAD_INDEX, headers=headers, timeout=60)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    candidates: list[tuple[str, str]] = []  # (label, full_url)
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not href.lower().endswith(".zip"):
            continue
        if "/content/data-download/" not in href.lower() and "propertydata" not in href.lower():
            continue
        full_url = href if href.startswith("http") else "https://www.tad.org" + href
        label = (a.get_text() or "").strip() or href
        candidates.append((label, full_url))

    if not candidates:
        raise RuntimeError("Could not find TAD Property Data ZIP link on index page")

    def score(c: tuple[str, str]) -> int:
        url_l = c[1].lower()
        s = 0
        if prefer_commercial:
            # Year-tagged Certified Commercial — preferred (real data).
            # `propertydata_c_<year>(certified).zip` matches.
            if "propertydata_c_" in url_l and "(certified).zip" in url_l:
                s += 250
            # The "live" Commercial stub is usually empty — bias against it
            # but allow size-based fallback after HEAD probe.
            if "(delimited)_c.zip" in url_l:
                s += 80
        # Penalize supplemental cuts (incremental change-files only)
        if "supplemental" in url_l:
            s -= 100
        # Full set fallback when commercial mode is off
        if "(delimited).zip" in url_l and not prefer_commercial:
            s += 60
        # Avoid mineral / personal property / true-prodigy variants
        if any(t in url_l for t in ("propertydata_m", "propertydata_p", "_p.zip", "_m.zip", "tarrant_all_taxing")):
            s -= 200
        # Avoid residential
        if "(delimited)_r.zip" in url_l or "propertydata_r_" in url_l:
            s -= 200
        # Prefer most recent year (boost newer years marginally)
        for yr in (2026, 2025, 2024, 2023):
            if f"_{yr}(" in url_l:
                s += yr - 2020
                break
        return s

    candidates.sort(key=lambda c: score(c), reverse=True)

    # HEAD-probe the top candidates and return the first one whose payload
    # is large enough to be real data (not a regenerating stub).
    headers_head = browser_headers(referer=TAD_INDEX)
    for label, url in candidates[:6]:
        try:
            h = requests.head(url, headers=headers_head, timeout=30, allow_redirects=True)
            size = int(h.headers.get("Content-Length") or 0)
            if size >= MIN_REAL_ZIP_BYTES:
                # Stash size for caller logging.
                return url
            # else: skip stub, try next candidate
        except requests.RequestException:
            continue

    # Fallback: return the highest-scored candidate even if HEAD probing
    # failed (caller will surface the empty-file error if it really is one).
    return candidates[0][1]


def tad_download() -> Path:
    url = tad_resolve_zip_url()
    print(f"[tad] picked {url}")
    dest_dir = DATA_ROOT / "tx_cad_tad"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / Path(url.split("?", 1)[0]).name

    headers = browser_headers(referer=TAD_INDEX)
    stream_download(url, dest, headers=headers, resume=True)
    if not dest.exists() or dest.stat().st_size < 1024:
        raise RuntimeError(f"TAD download empty for {url}")
    return dest


def tad_pick_property_file(zip_path: Path) -> str:
    """TAD ships a `PropertyData.txt` (pipe-delimited) inside the ZIP."""
    members = list_zip_members(zip_path)
    for n in members:
        ln = n.lower()
        if "propertydata" in ln and (ln.endswith(".txt") or ln.endswith(".csv")):
            return n
    for n in members:
        if n.lower().endswith(".txt") or n.lower().endswith(".csv"):
            return n
    raise FileNotFoundError(f"No property file in TAD ZIP {zip_path.name}: {members[:5]}")


def tad_map_row(row: dict[str, str], year: int) -> dict | None:
    """
    Map one TAD PropertyData row to an intel_properties payload.

    The Commercial-only file (PropertyData_C_<year>(Certified).ZIP) is
    pre-filtered to RP='C' so we trust the file scope and don't re-classify.
    For State_Use_Code we still record the raw value as property_use_code
    and pick a bucket via TAD's C-letter scheme (C1/C2 = retail-class
    commercial, F1/F2 = industrial, B1+ = multifamily).
    """
    # File is already RP='C' — only classify when called with the full set
    rp = (row.get("RP") or "").strip().upper()
    if rp and rp != "C":
        return None

    acct = (row.get("Account_Num") or row.get("ACCOUNT_NUM") or "").strip()
    if not acct:
        return None

    # Address
    site_addr = _str(row.get("Situs_Address"))
    city = _str(row.get("City"))
    if not site_addr or not city:
        return None

    use_code = (row.get("State_Use_Code") or row.get("Property_Class") or "").strip()
    bucket, desc = _tad_bucket(use_code)

    # ZIP can be in Owner_Zip or a separate situs zip — TAD's commercial
    # file doesn't ship a situs zip column, so we leave postal_code null
    # for the situs and capture the owner zip instead.
    return {
        "external_id": f"TAD-{acct}",
        "source_detail": TAD_SOURCE,
        "street_address": site_addr,
        "city": city,
        "state": "TX",
        "postal_code": None,  # not present in TAD commercial file
        "county": "Tarrant",
        "county_fips": "48439",
        "data_year": year,
        "owner_name": _str(row.get("Owner_Name")),
        "raw_owner_name": _str(row.get("Owner_Name")),
        "owner_mailing_address": _str(row.get("Owner_Address")),
        # Owner_CityState is "FT WORTH, TX" — split on the last comma
        "owner_mailing_city": _split_city_state(row.get("Owner_CityState"), 0),
        "owner_mailing_state": _split_city_state(row.get("Owner_CityState"), 1),
        "owner_mailing_zip": (row.get("Owner_Zip") or "").strip()[:10] or None,
        "property_type": bucket,
        "property_use_code": use_code or None,
        "property_use_desc": desc,
        "year_built": _normalize_int(row.get("Year_Built")),
        "estimated_value": _normalize_float(row.get("Total_Value") or row.get("Appraised_Value")),
        "assessed_value": _normalize_int(row.get("Total_Value") or row.get("Appraised_Value")),
        "building_sqft": _normalize_float(row.get("Living_Area")),
        "sq_footage": _normalize_int(row.get("Living_Area")),
        "lot_size_sqft": _normalize_float(row.get("Land_SqFt")),
    }


def _split_city_state(s: str | None, idx: int) -> str | None:
    """Split TAD's Owner_CityState (e.g. 'FT WORTH, TX') into city/state."""
    if not s:
        return None
    parts = [p.strip() for p in s.rsplit(",", 1)]
    if len(parts) != 2:
        return parts[0] if idx == 0 and parts else None
    return parts[idx] or None


# TAD State_Use_Code -> (bucket, description). Letters mirror the Texas
# Comptroller PTAD scheme but TAD assigns its own subdivisions for Class C
# (commercial), Class F (industrial), Class B (multifamily).
_TAD_BUCKETS = {
    "A": ("residential", "Single-family residential"),
    "B": ("multifamily", "Multifamily residential"),
    "C": ("retail", "Commercial real (TAD class C)"),
    "D": ("agricultural", "Qualified open-space"),
    "E": ("agricultural", "Rural land with improvements"),
    "F": ("industrial", "Industrial / commercial real"),
    "G": ("other_commercial", "Oil / gas / minerals"),
    "J": ("other_commercial", "Utility"),
    "L": ("other_commercial", "Personal property"),
    "M": ("residential", "Mobile home"),
    "X": ("other_commercial", "Exempt"),
}


def _tad_bucket(code: str) -> tuple[str, str]:
    if not code:
        return ("other_commercial", "Commercial (TAD)")
    head = code.strip().upper()[:1]
    return _TAD_BUCKETS.get(head, ("other_commercial", f"TAD class {code}"))


def run_tad(args: argparse.Namespace) -> int:
    progress = Progress(ROOT / "progress_tx_tad.json")
    if args.reset:
        progress.reset()
        return 0

    zip_path = tad_download()
    member = tad_pick_property_file(zip_path)
    print(f"[tad] parsing {member}")

    upserter = SupabaseUpserter(source_detail=TAD_SOURCE)
    seen = 0
    kept = 0
    with zipfile.ZipFile(zip_path, "r") as zf:
        with zf.open(member) as raw:
            text = io.TextIOWrapper(raw, encoding="latin-1", errors="replace", newline="")
            for row in iter_pipe_delimited(text):
                seen += 1
                payload = tad_map_row(row, args.year or 0)
                if payload is not None:
                    upserter.add(payload)
                    kept += 1
                if seen % LOG_INTERVAL == 0:
                    print(
                        f"[tad] {seen:,} rows scanned, {kept:,} commercial, "
                        f"upserted={upserter.upserted:,}"
                    )
                    progress["records_processed"] = upserter.upserted
                    progress["last_offset"] = seen
                    progress.save()
                if args.max_features and seen >= args.max_features:
                    break

    upserter.flush()
    print(f"[tad] DONE — seen={seen:,} kept={kept:,} stats={upserter.stats()}")
    return 0


# -------------------------------------------------------------------------
# Entrypoint
# -------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Texas CAD scraper")
    parser.add_argument("--county", choices=["hcad", "dcad", "tad"], required=True)
    parser.add_argument("--year", type=int, default=2025)
    parser.add_argument("--proposed", action="store_true",
                        help="DCAD: pull Proposed roll instead of Certified")
    parser.add_argument("--max-features", type=int, default=0,
                        help="cap rows scanned (smoke testing)")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()

    if args.county == "hcad":
        return run_hcad(args)
    if args.county == "dcad":
        return run_dcad(args)
    if args.county == "tad":
        return run_tad(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
