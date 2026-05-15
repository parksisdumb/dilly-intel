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
from dataclasses import dataclass, replace
from pathlib import Path

import requests

from intel_ingest import (
    SupabaseUpserter,
    Progress,
    classify_ar_parceltype,
    classify_oh_luc,
    classify_ga_lucode,
    classify_mo_class,
    classify_tx_state_class,
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
    # Server-side WHERE clause. Use this to skip residential / vacant /
    # empty-class records before they leave the database — pages of
    # ALL-rows-then-client-filter waste paginate budget and bloat IO.
    where: str = "1=1"
    progress_file: Path = Path()  # populated post-init
    fips_prefix: str = ""  # 2-digit state FIPS for county_fips assembly
    # ArcGIS REST geometry options. Some sources (TxGIO statewide
    # parcels) don't ship pre-computed lat/lon columns — we have to
    # extract the polygon centroid from the returned geometry. When
    # enabled, fetch_page() requests geometry and asks for it in
    # `out_sr` (typically EPSG:4326 for direct WGS84 lat/lon).
    return_geometry: bool = False
    out_sr: int | None = None


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
    # Cuyahoga County, OH (Cleveland). MyPLACE service, layer 2 = Parcel.
    # Field map is informational; the dispatcher uses map_oh_cuyahoga_feature.
    "oh_cuyahoga": StateConfig(
        state="Ohio - Cuyahoga County",
        state_abbr="OH-CUY",
        endpoint=(
            "https://gis.cuyahogacounty.us/server/rest/services/MyPLACE/"
            "Parcels_WMA_GJOIN_WGS84/MapServer/2"
        ),
        source_detail="oh_cuyahoga_public",
        page_size=1000,
        field_map={},  # custom mapper
        use_code_field="tax_luc",
        classifier="oh_luc",
        progress_file=ROOT / "progress_oh_cuyahoga.json",
        fips_prefix="39",
    ),
    # Franklin County, OH (Columbus). Tax Parcel layer 0.
    "oh_franklin": StateConfig(
        state="Ohio - Franklin County",
        state_abbr="OH-FRA",
        endpoint=(
            "https://gis.franklincountyohio.gov/hosting/rest/services/"
            "ParcelFeatures/Parcel_Features/MapServer/0"
        ),
        source_detail="oh_franklin_public",
        page_size=2000,  # service maxRecordCount=3000; stay under for safety
        field_map={},
        use_code_field="CLASSCD",
        classifier="oh_luc",
        progress_file=ROOT / "progress_oh_franklin.json",
        fips_prefix="39",
    ),
    # Fulton County, GA (Atlanta). Tax_Parcels FeatureServer layer 0.
    # No bldg sqft published — records ingest with NULL building_sqft.
    "ga_fulton": StateConfig(
        state="Georgia - Fulton County",
        state_abbr="GA-FUL",
        endpoint=(
            "https://services1.arcgis.com/AQDHTHDrZzfsFsB5/arcgis/rest/"
            "services/Tax_Parcels/FeatureServer/0"
        ),
        source_detail="ga_fulton_public",
        page_size=2000,
        field_map={},
        use_code_field="LUCode",
        classifier="ga_lucode",
        progress_file=ROOT / "progress_ga_fulton.json",
        fips_prefix="13",
    ),
    # GA-DeKalb and MO-StLouisCity were investigated 2026-05-09 but
    # their public-tier datasets either don't carry property-type data
    # (DeKalb: BLDGAREA / CLASSCD / USECD all NULL across 245k rows)
    # or use a non-statutory class-code system that defies our standard
    # commercial filter (St Louis: no PCC >= 30 found in 135k rows even
    # though the docs suggest 30-49 = commercial). See SCRAPER_TODO.md.

    # Texas TxGIO statewide parcel MapServer. Same endpoint for every
    # county — we filter by FIPS server-side and let the existing TX
    # PTAD classifier (classify_tx_state_class) bucket the results.
    # The where clause also pre-filters to commercial-prefix codes
    # (F* / B* / L* / J*) so the 1.5M-row Harris scan only ships ~89k
    # candidate records over the wire. Geometry is requested in
    # EPSG:4326 so polygon centroids come back as ready-to-use
    # WGS84 lat/lon.
    "tx_txgio_harris": StateConfig(
        state="Texas - Harris County (TxGIO)",
        state_abbr="TX-TXGIO-HRS",
        endpoint=(
            "https://feature.geographic.texas.gov/arcgis/rest/services/"
            "Parcels/stratmap_land_parcels_48_most_recent/MapServer/0"
        ),
        source_detail="tx_txgio_harris",
        # 500 (not the 2000 service max): with returnGeometry=true the
        # per-page payload at 2000 features is heavy enough that the
        # TxGIO gateway intermittently 504s. Smaller pages clear it.
        page_size=500,
        field_map={},  # custom mapper handles field layout
        use_code_field="stat_land_use",
        classifier="tx_state_class",
        where=(
            "FIPS = '48201' AND ("
            "STAT_LAND_USE LIKE 'F%' OR "
            "STAT_LAND_USE LIKE 'B%' OR "
            "STAT_LAND_USE LIKE 'L%' OR "
            "STAT_LAND_USE LIKE 'J%')"
        ),
        progress_file=ROOT / "progress_tx_txgio_harris.json",
        fips_prefix="48",
        return_geometry=True,
        out_sr=4326,
    ),
    "tx_txgio_bexar": StateConfig(
        state="Texas - Bexar County (TxGIO)",
        state_abbr="TX-TXGIO-BXR",
        endpoint=(
            "https://feature.geographic.texas.gov/arcgis/rest/services/"
            "Parcels/stratmap_land_parcels_48_most_recent/MapServer/0"
        ),
        source_detail="tx_txgio_bexar",
        page_size=500,  # see Harris note — geometry payloads at 2000 trip 504s
        field_map={},
        use_code_field="stat_land_use",
        classifier="tx_state_class",
        where=(
            "FIPS = '48029' AND ("
            "STAT_LAND_USE LIKE 'F%' OR "
            "STAT_LAND_USE LIKE 'B%' OR "
            "STAT_LAND_USE LIKE 'L%' OR "
            "STAT_LAND_USE LIKE 'J%')"
        ),
        progress_file=ROOT / "progress_tx_txgio_bexar.json",
        fips_prefix="48",
        return_geometry=True,
        out_sr=4326,
    ),
    # Travis: STAT_LAND_USE is empty across all 834k Travis CAD records
    # in the TxGIO normalized layer (verified 2026-05-12). The where
    # clause therefore returns 0 rows; the preset is wired in for
    # backward-compat / discoverability. TODO: switch to LOC_LAND_USE
    # or pull Travis from traviscad.org directly (see SCRAPER_TODO.md).
    "tx_txgio_travis": StateConfig(
        state="Texas - Travis County (TxGIO — known-empty class field)",
        state_abbr="TX-TXGIO-TRV",
        endpoint=(
            "https://feature.geographic.texas.gov/arcgis/rest/services/"
            "Parcels/stratmap_land_parcels_48_most_recent/MapServer/0"
        ),
        source_detail="tx_txgio_travis",
        page_size=500,  # see Harris note
        field_map={},
        use_code_field="stat_land_use",
        classifier="tx_state_class",
        where=(
            "FIPS = '48453' AND ("
            "STAT_LAND_USE LIKE 'F%' OR "
            "STAT_LAND_USE LIKE 'B%' OR "
            "STAT_LAND_USE LIKE 'L%' OR "
            "STAT_LAND_USE LIKE 'J%')"
        ),
        progress_file=ROOT / "progress_tx_txgio_travis.json",
        fips_prefix="48",
        return_geometry=True,
        out_sr=4326,
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


def _city_from_pstlcitystzip(s: str | None) -> str | None:
    """Franklin County ships an mail-style "COLUMBUS OH 43215" combined
    field; pull just the city portion. Trailing tokens are state + zip."""
    if not s:
        return None
    s = s.strip()
    if not s:
        return None
    parts = s.rsplit(" ", 2)
    if len(parts) >= 3 and parts[-1].replace("-", "").isdigit() and len(parts[-2]) == 2:
        return parts[0].title() or None
    return s.title()


def map_oh_cuyahoga_feature(attr: dict) -> dict | None:
    """Cuyahoga County (Cleveland), OH parcel mapper.
    Source layer fields documented at
    /server/rest/services/MyPLACE/Parcels_WMA_GJOIN_WGS84/MapServer/2."""
    parcel_id = _str(attr.get("parcel_id"))
    if not parcel_id:
        return None

    street = _str(attr.get("par_street"))
    addr_full = _str(attr.get("par_addr_all"))
    street = street or addr_full
    city = _str(attr.get("par_city"))
    if not street or not city:
        return None

    luc = _str(attr.get("tax_luc"))
    luc_desc = _str(attr.get("tax_luc_description"))
    bucket, desc, is_comm = classify_oh_luc(luc, luc_desc)
    if not is_comm:
        return None

    zip_code = _str(attr.get("par_zip"))
    bldgsf = _normalize_int(attr.get("total_square_ft"))
    market_val = _normalize_float(attr.get("certified_tax_total"))

    return {
        "external_id": f"OH-CUY-{parcel_id}",
        "source_detail": "oh_cuyahoga_public",
        "street_address": street,
        "city": city,
        "state": "OH",
        "postal_code": (zip_code or "")[:10] or None,
        "county_fips": "39035",
        "county": "Cuyahoga",
        "owner_name": _str(attr.get("parcel_owner")),
        "raw_owner_name": _str(attr.get("parcel_owner")),
        "property_type": bucket,
        "property_use_code": luc,
        "property_use_desc": luc_desc or desc,
        "building_sqft": bldgsf,
        # assessed_value is int-typed in the schema; AR convention.
        "estimated_value": market_val,
        "assessed_value": _normalize_int(attr.get("certified_tax_total")),
        "apn": parcel_id,
        "parcel_id": parcel_id,
    }


def map_oh_franklin_feature(attr: dict) -> dict | None:
    """Franklin County (Columbus), OH parcel mapper. Layer 0."""
    parcel_id = _str(attr.get("PARCELID"))
    if not parcel_id:
        return None

    street = _str(attr.get("SITEADDRESS"))
    if not street:
        return None

    city = _city_from_pstlcitystzip(_str(attr.get("PSTLCITYSTZIP")))
    if not city:
        # Default to Columbus — the bulk of Franklin County is the Columbus
        # metro and most parcels lacking PSTLCITYSTZIP are still in city.
        city = "Columbus"

    classcd = _str(attr.get("CLASSCD"))
    bucket, desc, is_comm = classify_oh_luc(classcd, None)
    if not is_comm:
        return None

    zip_code = _str(attr.get("ZIPCD"))
    bldgsf = _normalize_int(attr.get("BLDGAREA"))
    year_built = _normalize_int(attr.get("RESYRBLT"))
    market_val = _normalize_float(attr.get("TOTVALUEBASE"))

    return {
        "external_id": f"OH-FRA-{parcel_id}",
        "source_detail": "oh_franklin_public",
        "street_address": street,
        "city": city,
        "state": "OH",
        "postal_code": (zip_code or "")[:10] or None,
        "county_fips": "39049",
        "county": "Franklin",
        "owner_name": _str(attr.get("OWNERNME1")),
        "raw_owner_name": _str(attr.get("OWNERNME1")),
        "property_type": bucket,
        "property_use_code": classcd,
        "property_use_desc": desc,
        "building_sqft": bldgsf,
        "year_built": year_built,
        # assessed_value is int-typed; AR convention.
        "estimated_value": market_val,
        "assessed_value": _normalize_int(attr.get("TOTVALUEBASE")),
        "apn": parcel_id,
        "parcel_id": parcel_id,
    }


def _unused_map_ga_dekalb_feature(attr: dict) -> dict | None:  # noqa: F841
    """STAGED — not currently dispatched. DeKalb's open dataset has
    OWNERNME1 / SITEADDRESS / CNTASSDVAL but BLDGAREA / CLASSCD /
    USECD / LANDUSE are all NULL across the 245k records, so we
    can't determine commercial vs residential without owner-name
    heuristics. Revisit when a richer dataset is available."""
    """DeKalb County (east Atlanta), GA parcel mapper.
    Tyler/CAMA-style schema. PSTLCITY is the tax-mailing city (matches
    site city for owner-occupied; differs for absentee). Falls back to
    `CITY` field when PSTLCITY is empty."""
    parcel_id = _str(attr.get("PARCELID"))
    if not parcel_id:
        return None

    street = _str(attr.get("SITEADDRESS"))
    if not street:
        return None

    city = _str(attr.get("PSTLCITY")) or _str(attr.get("CITY"))
    if not city:
        # DeKalb County encompasses parts of Atlanta + Decatur + others;
        # default to "Decatur" (county seat) when unknown.
        city = "Decatur"

    classcd = _str(attr.get("CLASSCD"))
    classdsc = _str(attr.get("CLASSDSCRP"))
    usedsc = _str(attr.get("USEDSCRP"))
    bucket, desc, is_comm = classify_ga_lucode(classcd, None)
    # If the Georgia LUCode lookup didn't find commercial, try the
    # description text — DeKalb's CLASSCD doesn't always align with the
    # GA statewide code system.
    if not is_comm and (classdsc or usedsc):
        text = (classdsc or "" + " " + (usedsc or "")).lower()
        if any(k in text for k in ("commercial", "industrial", "office", "retail", "warehouse", "apartment")):
            bucket = "other_commercial"
            desc = classdsc or usedsc or "Commercial"
            is_comm = True
    if not is_comm:
        return None

    zip_code = _str(attr.get("PSTLZIP5")) or _str(attr.get("ZIP"))
    bldgsf = _normalize_int(attr.get("BLDGAREA"))
    year_built = _normalize_int(attr.get("RESYRBLT"))
    market_val = _normalize_float(attr.get("CNTASSDVAL"))

    return {
        "external_id": f"GA-DEK-{parcel_id}",
        "source_detail": "ga_dekalb_public",
        "street_address": street,
        "city": city,
        "state": "GA",
        "postal_code": (zip_code or "")[:10] or None,
        "county_fips": "13089",
        "county": "DeKalb",
        "owner_name": _str(attr.get("OWNERNME1")),
        "raw_owner_name": _str(attr.get("OWNERNME1")),
        "property_type": bucket,
        "property_use_code": classcd,
        "property_use_desc": classdsc or usedsc or desc,
        "building_sqft": bldgsf,
        "year_built": year_built,
        # assessed_value is int-typed; estimated_value is numeric.
        "estimated_value": market_val,
        "assessed_value": _normalize_int(attr.get("CNTASSDVAL")),
        "apn": parcel_id,
        "parcel_id": parcel_id,
    }


def _unused_map_mo_stlouis_city_feature(attr: dict) -> dict | None:  # noqa: F841
    """STAGED — not currently dispatched. PropertyClassCode appears to
    use a non-standard internal code system (no values >= 30 in 135k
    rows even though MO statute defines Classes 1-4). Need access to
    the assessor's code dictionary before we can classify commercial
    vs residential reliably."""
    """St Louis City (independent city), MO parcel mapper. PascalCase
    field names. ZIP is double-typed (numeric) so cast to string and
    pad to 5 digits."""
    parcel_id = _str(attr.get("ParcelId"))
    if not parcel_id:
        return None

    street = _str(attr.get("SITEADDR"))
    if not street:
        return None

    classcode = attr.get("PropertyClassCode")
    bucket, desc, is_comm = classify_mo_class(classcode)
    if not is_comm:
        return None

    # OwnerCity is the tax-mailing city (could be anywhere); for the
    # property city we hardcode "St. Louis" since this dataset is the
    # independent-city universe.
    city = "St. Louis"

    zip_raw = attr.get("ZIP")
    zip_code: str | None = None
    if zip_raw is not None:
        try:
            z = int(float(zip_raw))
            zip_code = str(z).zfill(5) if z > 0 else None
        except (ValueError, TypeError):
            zip_code = None

    bldgsf = _normalize_int(attr.get("SQFT"))
    year_built = _normalize_int(attr.get("FirstYearBuilt"))
    market_val = _normalize_float(attr.get("AsdTotal"))

    return {
        "external_id": f"MO-STL-{parcel_id}",
        "source_detail": "mo_stlouis_city_public",
        "street_address": street,
        "city": city,
        "state": "MO",
        "postal_code": zip_code,
        "county_fips": "29510",   # St Louis City independent FIPS
        "county": "St. Louis City",
        "owner_name": _str(attr.get("OwnerName")),
        "raw_owner_name": _str(attr.get("OwnerName")),
        "property_type": bucket,
        "property_use_code": str(classcode) if classcode is not None else None,
        "property_use_desc": desc,
        "building_sqft": bldgsf,
        "year_built": year_built,
        "estimated_value": market_val,
        "assessed_value": _normalize_int(attr.get("AsdTotal")),
        "apn": parcel_id,
        "parcel_id": parcel_id,
    }


def _txgio_polygon_centroid(geometry: dict | None) -> tuple[float, float] | None:
    """Mean of all vertex coordinates across all rings of an ArcGIS
    polygon. ArcGIS returns geometry as {"rings": [[[x,y],[x,y],...]]}.
    When the layer was queried with outSR=4326 the values are already
    WGS84 lon/lat — no reprojection needed.

    Returns (lat, lon) tuple, or None when geometry is missing/empty.
    """
    if not geometry:
        return None
    rings = geometry.get("rings") or []
    sx = sy = 0.0
    n = 0
    for ring in rings:
        for pt in ring:
            if pt is None or len(pt) < 2:
                continue
            try:
                sx += float(pt[0])
                sy += float(pt[1])
                n += 1
            except (TypeError, ValueError):
                continue
    if n == 0:
        return None
    return (sy / n, sx / n)  # lat, lon (ArcGIS rings are [x, y] = [lon, lat])


def map_tx_txgio_feature(
    attr: dict,
    geometry: dict | None,
    source_detail: str,
) -> dict | None:
    """
    Texas TxGIO statewide parcel mapper.

    ArcGIS REST returns attribute keys lowercased (field name, not the
    uppercase alias), so we read lowercase here. STAT_LAND_USE is the
    Texas PTAD code system — same one HCAD/DCAD/TAD use — so the
    existing classify_tx_state_class() is the classifier.

    Source detail is parameterized so the same mapper serves all three
    per-county presets (tx_txgio_harris / _bexar / _travis).
    """
    prop_id = _str(attr.get("prop_id"))
    geo_id = _str(attr.get("geo_id"))
    ext_id = prop_id or geo_id
    if not ext_id:
        return None
    # Whitespace in TX PROP_IDs is real; normalize for external_id while
    # preserving the raw value on apn/parcel_id.
    ext_id_clean = "_".join(ext_id.split())

    # Classification — STAT_LAND_USE wins; LOC_LAND_USE is the local
    # county code as a fallback (county-specific, less reliable).
    stat_code = _str(attr.get("stat_land_use"))
    loc_code = _str(attr.get("loc_land_use"))
    bucket, desc, is_comm = classify_tx_state_class(stat_code or loc_code)
    if not is_comm:
        return None

    # Site address — prefer the assembled SITUS_ADDR; fall back to
    # piecing the components together.
    street = _str(attr.get("situs_addr"))
    if not street:
        parts = [
            _str(attr.get("situs_num")),
            _str(attr.get("situs_stre")),
            _str(attr.get("situs_st_1")),
            _str(attr.get("situs_st_2")),
        ]
        parts = [p for p in parts if p]
        street = " ".join(parts) if parts else None
    if not street:
        return None

    city = _str(attr.get("situs_city"))
    if not city:
        return None

    state = _str(attr.get("situs_stat")) or "TX"
    zip_code = _str(attr.get("situs_zip"))

    mail_addr = _str(attr.get("mail_addr")) or _str(attr.get("mail_line1"))
    mail_city = _str(attr.get("mail_city"))
    mail_state = _str(attr.get("mail_stat"))
    mail_zip = _str(attr.get("mail_zip"))

    owner = _str(attr.get("owner_name"))

    fips = _str(attr.get("fips"))
    county = _str(attr.get("county"))

    mkt_value = _normalize_float(attr.get("mkt_value"))
    mkt_value_int = _normalize_int(attr.get("mkt_value"))
    imp_value = _normalize_float(attr.get("imp_value"))
    year_built = _normalize_int(attr.get("year_built"))

    # Centroid from polygon rings (already WGS84 due to outSR=4326).
    lat: float | None = None
    lon: float | None = None
    centroid = _txgio_polygon_centroid(geometry)
    if centroid is not None:
        lat_c, lon_c = centroid
        # Sanity-gate to Texas bounding box — anything outside means
        # the SR transform broke or the polygon is corrupt.
        if 25.0 <= lat_c <= 37.0 and -107.0 <= lon_c <= -93.0:
            lat, lon = lat_c, lon_c

    # Annotate the use-desc with imp_value for reviewer context — same
    # convention as the MARIS mapper.
    desc_decorated = desc
    if imp_value and imp_value > 0:
        desc_decorated = f"{desc} | IMP_VALUE ${imp_value:,.0f}"

    return {
        "external_id": f"TX-TXGIO-{ext_id_clean}",
        "source_detail": source_detail,
        "street_address": street,
        "city": city,
        "state": state,
        "postal_code": (zip_code or "")[:10] or None,
        "county_fips": fips if fips and len(fips) == 5 else None,
        "county": county.title() if county else None,
        "owner_name": owner,
        "raw_owner_name": owner,
        "owner_mailing_address": mail_addr,
        "owner_mailing_city": mail_city,
        "owner_mailing_state": mail_state,
        "owner_mailing_zip": mail_zip,
        "property_type": bucket,
        "property_use_code": stat_code or loc_code,
        "property_use_desc": desc_decorated,
        "building_sqft": None,  # not in TxGIO schema
        "year_built": year_built,
        "estimated_value": mkt_value,
        "assessed_value": mkt_value_int,
        "latitude": lat,
        "longitude": lon,
        "apn": ext_id,
        "parcel_id": ext_id,
    }


def map_ga_fulton_feature(attr: dict) -> dict | None:
    """Fulton County (Atlanta), GA parcel mapper.
    No bldg sqft / city in source — bldgsf left NULL, city defaulted
    when address parse fails."""
    parcel_id = _str(attr.get("ParcelID"))
    if not parcel_id:
        return None

    street = _str(attr.get("Address"))
    if not street:
        # Fall back to component fields if `Address` is empty.
        parts = [
            _str(attr.get("AddrNumber")),
            _str(attr.get("AddrPreDir")),
            _str(attr.get("AddrStreet")),
            _str(attr.get("AddrSuffix")),
        ]
        parts = [p for p in parts if p]
        street = " ".join(parts) if parts else None
    if not street:
        return None

    luc = _str(attr.get("LUCode"))
    classcd = _str(attr.get("ClassCode"))
    bucket, desc, is_comm = classify_ga_lucode(luc, classcd)
    if not is_comm:
        return None

    # Fulton spans Atlanta + Sandy Springs + Roswell + Alpharetta + Johns
    # Creek + Milton + Union City + College Park. We don't have a per-
    # parcel city field, so default to "Atlanta" — the dominant city —
    # and let downstream geocoding refine it later.
    city = "Atlanta"

    return {
        "external_id": f"GA-FUL-{parcel_id}",
        "source_detail": "ga_fulton_public",
        "street_address": street,
        "city": city,
        "state": "GA",
        "postal_code": None,
        "county_fips": "13121",
        "county": "Fulton",
        "owner_name": _str(attr.get("Owner")),
        "raw_owner_name": _str(attr.get("Owner")),
        "property_type": bucket,
        "property_use_code": luc,
        "property_use_desc": desc,
        # No building sqft published; stays NULL.
        "building_sqft": None,
        "apn": parcel_id,
        "parcel_id": parcel_id,
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
    "oh_luc": classify_oh_luc,
    "ga_lucode": classify_ga_lucode,
    "mo_class": classify_mo_class,
}


def fetch_page(
    session: requests.Session,
    endpoint: str,
    where: str,
    offset: int,
    page_size: int,
    return_geometry: bool = False,
    out_sr: int | None = None,
) -> dict:
    url = endpoint.rstrip("/") + "/query"
    params: dict[str, str | int] = {
        "where": where,
        "outFields": "*",
        "returnGeometry": "true" if return_geometry else "false",
        "f": "json",
        "resultOffset": offset,
        "resultRecordCount": page_size,
        "orderByFields": "OBJECTID ASC",
    }
    if return_geometry and out_sr is not None:
        # Ask the service to project geometry to the SR we want
        # (EPSG:4326 for WGS84 lat/lon) — saves us a client-side
        # reprojection step.
        params["outSR"] = out_sr
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

    # TxGIO doesn't publish building_sqft, so the upserter would always
    # see NULL and the min-sqft gate is moot. Disable it explicitly.
    enforce_sqft_min = not cfg.state_abbr.startswith("TX-TXGIO")
    upserter = SupabaseUpserter(source_detail=cfg.source_detail, enforce_sqft_min=enforce_sqft_min)
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
            data = fetch_page(
                session, cfg.endpoint, cfg.where, offset, cfg.page_size,
                return_geometry=cfg.return_geometry,
                out_sr=cfg.out_sr,
            )
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
            elif cfg.state_abbr == "OH-CUY":
                payload = map_oh_cuyahoga_feature(attr)
            elif cfg.state_abbr == "OH-FRA":
                payload = map_oh_franklin_feature(attr)
            elif cfg.state_abbr == "GA-FUL":
                payload = map_ga_fulton_feature(attr)
            elif cfg.state_abbr.startswith("TX-TXGIO"):
                payload = map_tx_txgio_feature(
                    attr,
                    feat.get("geometry"),
                    source_detail=cfg.source_detail,
                )
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
                if args.dry_run:
                    # Print the first 5 mapped payloads so the user can
                    # eyeball the output without writing to Supabase.
                    if total_kept < 5:
                        print(f"[{cfg.state_abbr.lower()}]   sample: {payload}")
                else:
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
    parser.add_argument("--dry-run", action="store_true",
                        help="apply mapper/classifier but skip the upsert; prints first 5 sample payloads")
    parser.add_argument("--no-geometry", action="store_true",
                        help="force returnGeometry=false even on presets that set return_geometry=True. "
                             "Use when an ArcGIS gateway 504s on geometry-heavy pages — the records "
                             "ingest with NULL lat/lon (backfill later via geocoder.py)")
    args = parser.parse_args()

    if args.state:
        cfg = STATE_PRESETS[args.state]
        if args.no_geometry and cfg.return_geometry:
            # Shallow-copy override so we don't mutate the shared preset.
            cfg = replace(cfg, return_geometry=False, out_sr=None)
            print(f"[{cfg.state_abbr.lower()}] --no-geometry: requesting attribute-only pages "
                  f"(lat/lon will be NULL for this run)")
        return run_state_preset(cfg, args)
    return run_custom(args)


if __name__ == "__main__":
    sys.exit(main())
