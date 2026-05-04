#!/usr/bin/env python3
"""
Generic ArcGIS REST scraper for state/county GIS portals.

Configurable via CLI flags or by selecting a pre-registered state. Built
around the FeatureServer/MapServer `/query` pattern that most states use.

Currently registered:
    --state ar    Arkansas — Planning_Cadastre/FeatureServer/6 (best ROI:
                  full statewide, owner + addr + value)

Setup:
    pip install requests supabase python-dotenv

Usage:
    python generic_gis_scraper.py --state ar
    python generic_gis_scraper.py --state ar --max-features 5000
    python generic_gis_scraper.py --state ar --resume
    python generic_gis_scraper.py --state ar --reset

    # Custom endpoint (advanced):
    python generic_gis_scraper.py \\
        --endpoint "https://example.com/arcgis/rest/services/X/FeatureServer/0" \\
        --source-detail other_state_gis_public \\
        --field-map '{"external_id":"PARCELID","street_address":"SITE_ADDR",...}' \\
        --use-code-field "LAND_USE"

Why the AR endpoint paginates at 200/page even though its catalog says more:
    The Planning_Cadastre service caps `resultRecordCount` at 200 with
    geometry, ~32k without. We always pass returnGeometry=false, but the
    feature-row endpoint enforces 200 anyway. We respect that cap and
    paginate through the whole state.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import requests

from intel_ingest import (
    SupabaseUpserter,
    Progress,
    classify_ar_parceltype,
)

ROOT = Path(__file__).parent

# -------------------------------------------------------------------------
# State registry — each preset wires endpoint, field map, classifier,
# pagination size, and source_detail.
# -------------------------------------------------------------------------


@dataclass
class StateConfig:
    state: str
    state_abbr: str  # 2-letter
    endpoint: str  # base URL ending in /FeatureServer/N or /MapServer/N
    source_detail: str
    page_size: int
    field_map: dict[str, str]
    use_code_field: str
    classifier: str  # name of classify_* function
    where: str = "1=1"
    progress_file: Path = Path()  # populated post-init
    fips_prefix: str = ""  # 2-digit state FIPS for county_fips assembly


# Arkansas Planning_Cadastre — layer 6 = PARCEL_POLYGON_CAMP
AR_FIELD_MAP = {
    "external_id": "parcelid",
    "street_address": "_addr_combine",  # custom: built from adrnum + predir + pstrnam + pstrtype
    "city": "adrcity",
    "state": "_const_AR",
    "postal_code": "adrzip5",
    "county_field": "countyfips",
    "owner_name": "ownername",
    "raw_owner_name": "ownername",
    "estimated_value": "totalvalue",
    "assessed_value": "totalvalue",
    "land_value": "landvalue",
    "improvement_value": "impvalue",
    "use_code": "parceltype",
}

STATE_PRESETS: dict[str, StateConfig] = {
    "ar": StateConfig(
        state="Arkansas",
        state_abbr="AR",
        endpoint=(
            "https://gis.arkansas.gov/arcgis/rest/services/"
            "FEATURESERVICES/Planning_Cadastre/FeatureServer/6"
        ),
        source_detail="ar_gis_public",
        page_size=200,
        field_map=AR_FIELD_MAP,
        use_code_field="parceltype",
        classifier="ar_parceltype",
        progress_file=ROOT / "progress_ar.json",
        fips_prefix="05",
    ),
}


HTTP_TIMEOUT = (15, 300)
LOG_INTERVAL = 5_000


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


def _build_ar_address(attr: dict) -> str | None:
    """AR splits street into adrnum + predir + pstrnam + pstrtype + posttype."""
    parts = [
        _str(attr.get("adrnum")),
        _str(attr.get("predir")),
        _str(attr.get("pstrnam")),
        _str(attr.get("pstrtype")),
    ]
    parts = [p for p in parts if p]
    return " ".join(parts) if parts else None


def map_ar_feature(attr: dict, fips_prefix: str) -> dict | None:
    """Map AR Planning_Cadastre row to intel_properties payload."""
    parceltype = attr.get("parceltype") or ""
    bucket, desc, is_comm = classify_ar_parceltype(parceltype)
    if not is_comm:
        return None

    parcelid = _str(attr.get("parcelid"))
    if not parcelid:
        return None

    addr = _build_ar_address(attr)
    city = _str(attr.get("adrcity"))
    if not addr or not city:
        return None

    fips_5 = _str(attr.get("countyfips"))
    if fips_5 and len(fips_5) == 5:
        county_fips = fips_5
    elif fips_5:
        # Sometimes only county portion is in this field
        county_fips = fips_prefix + fips_5.zfill(3)[-3:]
    else:
        county_fips = None

    return {
        "external_id": f"AR-{parcelid}",
        "source_detail": "ar_gis_public",
        "street_address": addr,
        "city": city,
        "state": "AR",
        "postal_code": (_str(attr.get("adrzip5")) or "")[:10] or None,
        "county_fips": county_fips,
        "owner_name": _str(attr.get("ownername")),
        "raw_owner_name": _str(attr.get("ownername")),
        "property_type": bucket,
        "property_use_code": parceltype.strip().upper() or None,
        "property_use_desc": desc,
        "estimated_value": _normalize_float(attr.get("totalvalue")),
        "assessed_value": _normalize_int(attr.get("totalvalue")),
    }


def map_generic_feature(attr: dict, cfg: dict, classifier_fn) -> dict | None:
    """
    Generic mapper for users who pass --field-map JSON. Field map keys are
    intel_properties columns; values are source attribute names. Special
    sentinel values:
        "_const_<value>"     literal string
        "_addr_combine"      build TX/AR-style multi-part address
    """
    fm = cfg["field_map"]
    use_field = cfg["use_code_field"]
    use_code = attr.get(use_field) or ""
    bucket, desc, is_comm = classifier_fn(use_code)
    if not is_comm:
        return None

    out = {"source_detail": cfg["source_detail"]}
    for col, src in fm.items():
        if isinstance(src, str) and src.startswith("_const_"):
            out[col] = src.removeprefix("_const_")
        elif src == "_addr_combine":
            # Defer to a registered combiner — for now just use raw `addr`
            out[col] = _str(attr.get("addr"))
        else:
            out[col] = _str(attr.get(src))

    if "external_id" not in out or not out["external_id"]:
        return None
    out["property_type"] = bucket
    out["property_use_desc"] = desc
    return out


# Classifier registry for the generic path.
CLASSIFIERS = {
    "ar_parceltype": classify_ar_parceltype,
}


def fetch_page(
    session: requests.Session,
    endpoint: str,
    where: str,
    offset: int,
    page_size: int,
) -> dict:
    url = endpoint.rstrip("/") + "/query"
    params = {
        "where": where,
        "outFields": "*",
        "returnGeometry": "false",
        "f": "json",
        "resultOffset": offset,
        "resultRecordCount": page_size,
        "orderByFields": "OBJECTID ASC",
    }
    r = session.get(url, params=params, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.json()


def run_state_preset(cfg: StateConfig, args: argparse.Namespace) -> int:
    progress = Progress(cfg.progress_file)
    if args.reset:
        progress.reset()
        print(f"[{cfg.state_abbr.lower()}] progress reset.")
        return 0

    offset = progress.get("last_offset", 0) if args.resume else 0
    if args.resume and offset:
        print(f"[{cfg.state_abbr.lower()}] resuming at offset {offset:,}")
    else:
        progress["last_offset"] = 0
        progress.save()

    upserter = SupabaseUpserter(source_detail=cfg.source_detail)
    session = requests.Session()
    session.headers.update({"User-Agent": "DillyIntel/1.0"})

    total_seen = 0
    total_kept = 0
    consecutive_errors = 0

    while True:
        if args.max_features and total_seen >= args.max_features:
            print(f"[{cfg.state_abbr.lower()}] --max-features cap reached")
            break

        try:
            data = fetch_page(session, cfg.endpoint, cfg.where, offset, cfg.page_size)
        except requests.RequestException as e:
            consecutive_errors += 1
            print(f"[{cfg.state_abbr.lower()}] page error at offset {offset}: {e}")
            if consecutive_errors >= 5:
                print(f"[{cfg.state_abbr.lower()}] too many errors — bailing")
                break
            time.sleep(5 * consecutive_errors)
            continue

        consecutive_errors = 0
        features = data.get("features", []) or []
        if not features:
            break

        for feat in features:
            attr = feat.get("attributes") or {}
            total_seen += 1
            if cfg.state_abbr == "AR":
                payload = map_ar_feature(attr, cfg.fips_prefix)
            else:
                fn = CLASSIFIERS.get(cfg.classifier)
                if fn is None:
                    raise RuntimeError(f"No classifier {cfg.classifier!r} registered")
                payload = map_generic_feature(
                    attr,
                    {
                        "field_map": cfg.field_map,
                        "use_code_field": cfg.use_code_field,
                        "source_detail": cfg.source_detail,
                    },
                    fn,
                )
            if payload is not None:
                upserter.add(payload)
                total_kept += 1
            if total_seen % LOG_INTERVAL == 0:
                print(
                    f"[{cfg.state_abbr.lower()}] offset~{offset + total_seen:,} "
                    f"kept={total_kept:,} upserted={upserter.upserted:,}"
                )

        exceeded = data.get("exceededTransferLimit", False)
        offset += len(features)
        progress["last_offset"] = offset
        progress["records_processed"] = upserter.upserted
        progress.save()

        if not exceeded and len(features) < cfg.page_size:
            break

    upserter.flush()
    print(
        f"[{cfg.state_abbr.lower()}] DONE — seen={total_seen:,} kept={total_kept:,} "
        f"upserted={upserter.upserted:,} stats={upserter.stats()}"
    )
    return 0


def run_custom(args: argparse.Namespace) -> int:
    if not args.endpoint or not args.source_detail or not args.field_map:
        print("[gis] --endpoint, --source-detail, and --field-map are required for custom mode")
        return 2
    try:
        field_map = json.loads(args.field_map)
    except json.JSONDecodeError as e:
        print(f"[gis] --field-map is not valid JSON: {e}")
        return 2

    progress_file = ROOT / f"progress_{args.source_detail}.json"
    cfg = StateConfig(
        state=args.source_detail,
        state_abbr=args.source_detail.upper(),
        endpoint=args.endpoint,
        source_detail=args.source_detail,
        page_size=args.page_size,
        field_map=field_map,
        use_code_field=args.use_code_field or "USE_CODE",
        classifier=args.classifier or "ar_parceltype",
        progress_file=progress_file,
    )
    return run_state_preset(cfg, args)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generic ArcGIS REST parcel scraper")
    parser.add_argument("--state", choices=list(STATE_PRESETS.keys()), default=None)
    parser.add_argument("--endpoint", type=str, default=None)
    parser.add_argument("--source-detail", type=str, default=None)
    parser.add_argument("--field-map", type=str, default=None,
                        help="JSON: {intel_col: source_attr, ...}")
    parser.add_argument("--use-code-field", type=str, default=None)
    parser.add_argument("--classifier", type=str, default=None)
    parser.add_argument("--page-size", type=int, default=1000)
    parser.add_argument("--max-features", type=int, default=0)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()

    if args.state:
        return run_state_preset(STATE_PRESETS[args.state], args)
    return run_custom(args)


if __name__ == "__main__":
    sys.exit(main())
