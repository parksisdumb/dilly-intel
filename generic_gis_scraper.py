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
from collections import Counter
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
    classify_shelby_regis,
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
    # OBJECTID keyset pagination. resultOffset paging degrades and
    # silently skips/duplicates rows on some flaky ArcGIS servers; keyset
    # paging (WHERE OBJECTID > last_max, ORDER BY OBJECTID) is stable.
    # Opt-in per preset so the established offset-paged presets are
    # untouched.
    use_keyset: bool = False
    # When False the SupabaseUpserter's min-building-sqft gate is
    # disabled — for sources whose layer carries no building_sqft field.
    enforce_sqft_min: bool = True


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
    # Shelby County, TN (Memphis) — ReGIS CERT_Parcel layer. County
    # assessor data with proper classification fields (LANDUSE), fresh
    # (TAXYR 2026). Coexists with PropTracer Memphis data under a
    # distinct source_detail.
    #
    # The server-side WHERE pre-filters 353k all-type parcels down to
    # ~35k commercial before they leave the database. The endpoint is
    # load-balanced and flaky (some nodes return 0 for valid queries),
    # so this preset uses keyset pagination + the resilient fetch
    # wrapper and a small page_size.
    "tn_shelby_regis": StateConfig(
        state="Tennessee - Shelby County (Memphis ReGIS)",
        state_abbr="TN-SHELBY",
        endpoint=(
            "https://gis.shelbycountytn.gov/arcgis/rest/services/"
            "Parcel/CERT_Parcel/MapServer/0"
        ),
        source_detail="tn_shelby_regis",
        # 500 — the endpoint's maxRecordCount is 1000 but it's flaky;
        # smaller pages reduce the blast radius of a bad node.
        page_size=500,
        field_map={},  # custom mapper handles the field layout
        use_code_field="LANDUSE",
        classifier="shelby_regis",
        where=(
            "LANDUSE IN ('COMMERCIAL','OFFICE','INDUSTRIAL',"
            "'MULTI-FAMILY','INSTITUTIONAL','PARKING')"
        ),
        progress_file=ROOT / "progress_tn_shelby_regis.json",
        fips_prefix="47",
        return_geometry=True,
        out_sr=4326,
        use_keyset=True,
        enforce_sqft_min=False,  # no building_sqft field on this layer
    ),
}


HTTP_TIMEOUT = (15, 300)
LOG_INTERVAL = 5_000

# Resilient-fetch tuning for flaky load-balanced endpoints (Shelby ReGIS).
# A 200 response with 0 features is ambiguous — a bad backend node, or
# the genuine end of data. We retry; if every retry is still empty the
# caller treats it as end-of-data.
ZERO_RESULT_RETRIES = 3       # retries on a 0-feature 200 response
ZERO_RESULT_DELAY = 5         # seconds between 0-result retries
MAX_HTTP_RETRIES = 5          # retries on a transient HTTP error
HTTP_RETRY_STATUSES = {500, 502, 503, 504}
# Keyset paging: when a page exhausts its 0-result retries we confirm
# end-of-data with a returnCountOnly probe. If the probe says rows still
# remain, the page was just flaky and we retry it. This cap stops an
# infinite loop if the endpoint stays down — bail and let --resume pick
# up from the saved OBJECTID cursor.
MAX_FLAKY_PAGE_STREAK = 8


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


def _polygon_centroid(geometry: dict | None) -> tuple[float, float] | None:
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
    centroid = _polygon_centroid(geometry)
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


# -------------------------------------------------------------------------
# Shelby County, TN (Memphis ReGIS) — CERT_Parcel layer.
# Attribute keys come back with the exact field-name casing (UPPERCASE
# for most, mixed-case for Latitude/Longitude) — confirmed via the
# 2026-05-22 preview.
# -------------------------------------------------------------------------

# Shelby's lat/lon (and polygon centroids) must land inside this box —
# Memphis / Shelby County. Anything outside means a bad coordinate.
_SHELBY_LAT_RANGE = (34.8, 35.5)
_SHELBY_LON_RANGE = (-90.3, -89.5)


def _shelby_adrno(v) -> str | None:
    """OWN_ADRNO / PAR_ADRNO are Double-typed street numbers (369.0).
    Render as a plain integer string; drop zero / negative placeholders."""
    n = _normalize_int(v)
    return str(n) if n is not None and n > 0 else None


def _assemble_shelby_street(attr: dict, prefix: str) -> str | None:
    """Assemble a street address from Shelby component fields.
    `prefix` is 'PAR_' (situs) or 'OWN_' (owner mailing)."""
    parts = [
        _shelby_adrno(attr.get(f"{prefix}ADRNO")),
        _str(attr.get(f"{prefix}ADRPREDIR")),
        _str(attr.get(f"{prefix}ADRSTR")),
        _str(attr.get(f"{prefix}ADRSUF")),
        _str(attr.get(f"{prefix}ADRPOSTDIR")),
    ]
    street = " ".join(p for p in parts if p).strip()
    return street or None


def _assemble_shelby_owner_mailing(attr: dict) -> str | None:
    """Owner mailing street address. OWN_ADDR1 is near-empty (0.2%), so
    we assemble from the OWN_ADR* components and append any unit, then
    fall back to OWN_ADDR1 only if assembly produced nothing."""
    street = _assemble_shelby_street(attr, "OWN_")
    unit = " ".join(
        p for p in (
            _str(attr.get("OWN_UNITDESC")),
            _str(attr.get("OWN_UNITNO")),
        ) if p
    ).strip()
    if street and unit:
        street = f"{street} {unit}"
    elif unit and not street:
        street = unit
    return street or _str(attr.get("OWN_ADDR1"))


def _shelby_coords(
    attr: dict, geometry: dict | None
) -> tuple[float | None, float | None]:
    """Latitude/Longitude (already WGS84) with a Shelby-bbox sanity gate;
    polygon-centroid fallback when the columns are missing/invalid."""
    lat = _normalize_float(attr.get("Latitude"))
    lon = _normalize_float(attr.get("Longitude"))

    def _in_box(la: float | None, lo: float | None) -> bool:
        return (
            la is not None and lo is not None
            and _SHELBY_LAT_RANGE[0] <= la <= _SHELBY_LAT_RANGE[1]
            and _SHELBY_LON_RANGE[0] <= lo <= _SHELBY_LON_RANGE[1]
        )

    if _in_box(lat, lon):
        return (lat, lon)

    centroid = _polygon_centroid(geometry)
    if centroid is not None:
        cla, clo = centroid
        if _in_box(cla, clo):
            return (cla, clo)
    return (None, None)


def map_tn_shelby_regis_feature(
    attr: dict, geometry: dict | None
) -> dict | None:
    """Shelby County (Memphis) ReGIS CERT_Parcel mapper.

    Classification is LANDUSE-driven via classify_shelby_regis(); the
    server-side WHERE already restricts the universe to commercial
    LANDUSE values, so the is_comm gate here mostly catches the rare
    null/unknown LANDUSE row.
    """
    landuse = _str(attr.get("LANDUSE"))
    luc = _str(attr.get("LUC"))
    owner = _str(attr.get("OWNER"))
    bucket, desc, is_comm = classify_shelby_regis(landuse, luc, owner)
    if not is_comm:
        return None

    # PARID has variable internal whitespace (fixed-width padding, e.g.
    # 'D0217   00225'). Collapse it once and use the normalized form for
    # external_id / apn / parcel_id alike.
    parid_raw = _str(attr.get("PARID"))
    if not parid_raw:
        return None
    parid = " ".join(parid_raw.split())

    # Situs address — PAR_ADDR1 is 100% populated; component assembly is
    # a belt-and-suspenders fallback only.
    street = _str(attr.get("PAR_ADDR1")) or _assemble_shelby_street(attr, "PAR_")
    if not street:
        return None

    # Owner name — append OWNER_EXT (extended/secondary name) when present.
    owner_ext = _str(attr.get("OWNER_EXT"))
    if owner and owner_ext:
        owner_name = f"{owner} / {owner_ext}"
    else:
        owner_name = owner or owner_ext

    muni = _str(attr.get("MUNI"))
    city = muni.title() if muni else None

    lat, lon = _shelby_coords(attr, geometry)

    # ZONING has no dedicated column — fold it into property_use_desc
    # alongside the LANDUSE-derived description for reviewer context.
    zoning = _str(attr.get("ZONING"))
    use_desc = f"{desc} | Zoning: {zoning}" if zoning else desc

    return {
        "external_id": f"TN-SHELBY-{parid}",
        "source_detail": "tn_shelby_regis",
        "street_address": street,
        "city": city,
        "state": "TN",
        "county": "Shelby",
        "county_fips": "47157",
        "postal_code": (_str(attr.get("PAR_ZIP")) or "")[:10] or None,
        "owner_name": owner_name,
        "raw_owner_name": owner,
        # OWN_ADDR1 is near-empty — assemble from components (see helper).
        "owner_mailing_address": _assemble_shelby_owner_mailing(attr),
        "owner_mailing_city": _str(attr.get("OWN_CITY")),
        "owner_mailing_state": _str(attr.get("OWN_STATE")),
        "owner_mailing_zip": (_str(attr.get("OWN_ZIP")) or "")[:10] or None,
        "property_type": bucket,
        "property_use_code": luc,
        "property_use_desc": use_desc,
        # CERT_Parcel layer carries no sqft / year-built / value fields.
        "building_sqft": None,
        "year_built": None,
        "estimated_value": None,
        "assessed_value": None,
        "latitude": lat,
        "longitude": lon,
        "apn": parid,
        "parcel_id": parid,
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
    keyset_oid: int | None = None,
) -> dict:
    """Fetch one ArcGIS /query page.

    Offset paging (default) sends resultOffset. Keyset paging — used when
    `keyset_oid` is not None — instead appends `AND OBJECTID > keyset_oid`
    to the WHERE and relies on the OBJECTID ASC order, which is stable
    even on flaky servers where resultOffset drifts.
    """
    url = endpoint.rstrip("/") + "/query"
    if keyset_oid is not None:
        effective_where = f"({where}) AND OBJECTID > {keyset_oid}"
    else:
        effective_where = where
    params: dict[str, str | int] = {
        "where": effective_where,
        "outFields": "*",
        "returnGeometry": "true" if return_geometry else "false",
        "f": "json",
        "resultRecordCount": page_size,
        "orderByFields": "OBJECTID ASC",
    }
    if keyset_oid is None:
        params["resultOffset"] = offset
    if return_geometry and out_sr is not None:
        # Ask the service to project geometry to the SR we want
        # (EPSG:4326 for WGS84 lat/lon) — saves us a client-side
        # reprojection step.
        params["outSR"] = out_sr
    r = session.get(url, params=params, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    return r.json()


def fetch_page_resilient(
    session: requests.Session,
    cfg: StateConfig,
    *,
    offset: int = 0,
    keyset_oid: int | None = None,
) -> tuple[dict, bool]:
    """Fetch one page with retry, for flaky load-balanced endpoints.

    Returns (data, exhausted). `exhausted` is True when a 200 response
    came back with 0 features even after ZERO_RESULT_RETRIES retries —
    the caller decides whether that means end-of-data.

    Transient HTTP errors (500/502/503/504) and network errors retry
    with exponential backoff up to MAX_HTTP_RETRIES; a hard failure
    after that re-raises.
    """
    http_fails = 0
    zero_results = 0
    while True:
        try:
            data = fetch_page(
                session, cfg.endpoint, cfg.where, offset, cfg.page_size,
                return_geometry=cfg.return_geometry, out_sr=cfg.out_sr,
                keyset_oid=keyset_oid,
            )
        except requests.HTTPError as e:
            status = getattr(e.response, "status_code", None)
            http_fails += 1
            if status in HTTP_RETRY_STATUSES and http_fails <= MAX_HTTP_RETRIES:
                delay = min(2 ** http_fails, 60)
                print(f"  [warn] HTTP {status} — backoff {delay}s "
                      f"({http_fails}/{MAX_HTTP_RETRIES})")
                time.sleep(delay)
                continue
            raise
        except requests.RequestException as e:
            http_fails += 1
            if http_fails <= MAX_HTTP_RETRIES:
                delay = min(2 ** http_fails, 60)
                print(f"  [warn] {type(e).__name__}: {e} — backoff {delay}s "
                      f"({http_fails}/{MAX_HTTP_RETRIES})")
                time.sleep(delay)
                continue
            raise

        features = data.get("features") or []
        if features:
            return data, False

        # 200 OK but 0 features — flaky node, or the genuine end of data.
        zero_results += 1
        if zero_results > ZERO_RESULT_RETRIES:
            return data, True
        print(f"  [warn] 0 results — retry {zero_results}/{ZERO_RESULT_RETRIES} "
              f"after {ZERO_RESULT_DELAY}s")
        time.sleep(ZERO_RESULT_DELAY)


def _map_feature(cfg: StateConfig, feat: dict) -> dict | None:
    """Dispatch one ArcGIS feature to the right per-source mapper."""
    attr = feat.get("attributes") or {}
    if cfg.state_abbr == "AR":
        return map_ar_feature(attr, cfg.fips_prefix)
    if cfg.state_abbr == "OH-CUY":
        return map_oh_cuyahoga_feature(attr)
    if cfg.state_abbr == "OH-FRA":
        return map_oh_franklin_feature(attr)
    if cfg.state_abbr == "GA-FUL":
        return map_ga_fulton_feature(attr)
    if cfg.state_abbr == "TN-SHELBY":
        return map_tn_shelby_regis_feature(attr, feat.get("geometry"))
    if cfg.state_abbr.startswith("TX-TXGIO"):
        return map_tx_txgio_feature(
            attr, feat.get("geometry"), source_detail=cfg.source_detail
        )
    fn = CLASSIFIERS.get(cfg.classifier)
    if fn is None:
        raise RuntimeError(f"No classifier {cfg.classifier!r} registered")
    return map_generic_feature(
        attr,
        {
            "field_map": cfg.field_map,
            "use_code_field": cfg.use_code_field,
            "source_detail": cfg.source_detail,
        },
        fn,
    )


def _run_keyset(
    cfg: StateConfig,
    args: argparse.Namespace,
    progress: Progress,
    upserter: SupabaseUpserter,
    session: requests.Session,
) -> int:
    """OBJECTID-keyset pagination loop for flaky endpoints (Shelby ReGIS).
    Each page is `WHERE (base) AND OBJECTID > last_oid ORDER BY OBJECTID`;
    the cursor advances to the page's max OBJECTID."""
    last_oid = progress.get("last_oid", 0) if args.resume else 0
    if args.resume and last_oid:
        print(f"[{cfg.state_abbr.lower()}] resuming after OBJECTID {last_oid:,}")
    else:
        progress["last_oid"] = 0
        progress.save()

    total_seen = 0
    total_kept = 0
    flaky_streak = 0

    while True:
        if args.max_features and total_seen >= args.max_features:
            print(f"[{cfg.state_abbr.lower()}] --max-features cap reached")
            break

        try:
            data, exhausted = fetch_page_resilient(
                session, cfg, keyset_oid=last_oid
            )
        except requests.RequestException as e:
            print(f"[{cfg.state_abbr.lower()}] fatal fetch error after retries "
                  f"at OBJECTID>{last_oid}: {e} — bailing (resume with --resume)")
            break

        if exhausted:
            # A 0-result page is ambiguous: genuine end of data, or a run
            # of bad load-balancer nodes. Confirm with a lighter, hard-
            # retried returnCountOnly probe before deciding — this is what
            # stops a flaky page mid-stream from silently truncating the
            # ingest.
            remaining = _arcgis_count(
                session, cfg.endpoint,
                f"({cfg.where}) AND OBJECTID > {last_oid}",
            )
            if remaining <= 0:
                print(f"[{cfg.state_abbr.lower()}] 0-result page + count probe "
                      f"confirms 0 rows past OBJECTID {last_oid:,} — "
                      f"end of data")
                break
            flaky_streak += 1
            print(f"[{cfg.state_abbr.lower()}] [warn] 0-result page but count "
                  f"probe says {remaining:,} rows remain past OBJECTID "
                  f"{last_oid:,} — flaky node, retrying page "
                  f"({flaky_streak}/{MAX_FLAKY_PAGE_STREAK})")
            if flaky_streak >= MAX_FLAKY_PAGE_STREAK:
                print(f"[{cfg.state_abbr.lower()}] {MAX_FLAKY_PAGE_STREAK} "
                      f"consecutive flaky pages — bailing; rerun with "
                      f"--resume to continue from OBJECTID {last_oid:,}")
                break
            time.sleep(ZERO_RESULT_DELAY)
            continue

        flaky_streak = 0
        features = data.get("features") or []
        page_oids: list[int] = []
        for feat in features:
            total_seen += 1
            oid = (feat.get("attributes") or {}).get("OBJECTID")
            if isinstance(oid, int):
                page_oids.append(oid)
            payload = _map_feature(cfg, feat)
            if payload is not None:
                if args.dry_run:
                    if total_kept < 5:
                        print(f"[{cfg.state_abbr.lower()}]   sample: {payload}")
                else:
                    upserter.add(payload)
                total_kept += 1
            if total_seen % LOG_INTERVAL == 0:
                print(f"[{cfg.state_abbr.lower()}] seen={total_seen:,} "
                      f"kept={total_kept:,} upserted={upserter.upserted:,} "
                      f"OBJECTID~{last_oid:,}")

        if not page_oids:
            # No OBJECTIDs to advance the cursor — stop rather than spin.
            print(f"[{cfg.state_abbr.lower()}] page carried no OBJECTID — stopping")
            break
        last_oid = max(page_oids)
        progress["last_oid"] = last_oid
        progress["records_processed"] = upserter.upserted
        progress.save()

        if (len(features) < cfg.page_size
                and not data.get("exceededTransferLimit", False)):
            break

    upserter.flush()
    print(
        f"[{cfg.state_abbr.lower()}] DONE — seen={total_seen:,} kept={total_kept:,} "
        f"upserted={upserter.upserted:,} stats={upserter.stats()}"
    )
    return 0


def run_state_preset(cfg: StateConfig, args: argparse.Namespace) -> int:
    progress = Progress(cfg.progress_file)
    if args.reset:
        progress.reset()
        print(f"[{cfg.state_abbr.lower()}] progress reset.")
        return 0

    # TxGIO and Shelby ReGIS layers carry no building_sqft, so the
    # upserter's min-sqft gate would reject every row — disable it.
    enforce_sqft_min = (
        cfg.enforce_sqft_min and not cfg.state_abbr.startswith("TX-TXGIO")
    )
    upserter = SupabaseUpserter(
        source_detail=cfg.source_detail, enforce_sqft_min=enforce_sqft_min
    )
    session = requests.Session()
    session.headers.update({"User-Agent": "DillyIntel/1.0"})

    # Keyset-paged presets (Shelby ReGIS) use the resilient OBJECTID loop.
    if cfg.use_keyset:
        return _run_keyset(cfg, args, progress, upserter, session)

    offset = progress.get("last_offset", 0) if args.resume else 0
    if args.resume and offset:
        print(f"[{cfg.state_abbr.lower()}] resuming at offset {offset:,}")
    else:
        progress["last_offset"] = 0
        progress.save()

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
            total_seen += 1
            payload = _map_feature(cfg, feat)
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


# -------------------------------------------------------------------------
# Preview mode — STEP-1-style sanity check of a preset (currently Shelby
# ReGIS). Reads metadata + a sample, runs everything through the real
# mapper/classifier, ingests nothing.
# -------------------------------------------------------------------------


def _arcgis_count(
    session: requests.Session, endpoint: str, where: str, tries: int = 12
) -> int:
    """returnCountOnly with retry — flaky Shelby nodes return 0 for valid
    queries, so keep retrying until a non-zero count comes back."""
    url = endpoint.rstrip("/") + "/query"
    best = 0
    for _ in range(tries):
        try:
            r = session.get(
                url,
                params={"where": where, "returnCountOnly": "true",
                        "f": "json"},
                timeout=HTTP_TIMEOUT,
            )
            r.raise_for_status()
            best = max(best, r.json().get("count", 0) or 0)
        except (requests.RequestException, ValueError):
            best = max(best, 0)
        if best > 0:
            return best
        time.sleep(0.5)
    return best


def _arcgis_groupby(
    session: requests.Session, endpoint: str, where: str, field: str,
    tries: int = 12,
) -> list[tuple]:
    """groupBy-count statistics query with retry."""
    url = endpoint.rstrip("/") + "/query"
    outstat = json.dumps([{
        "statisticType": "count",
        "onStatisticField": "OBJECTID",
        "outStatisticFieldName": "cnt",
    }])
    for _ in range(tries):
        try:
            r = session.get(
                url,
                params={
                    "where": where,
                    "groupByFieldsForStatistics": field,
                    "outStatistics": outstat,
                    "orderByFields": "cnt DESC",
                    "f": "json",
                },
                timeout=HTTP_TIMEOUT,
            )
            r.raise_for_status()
            feats = r.json().get("features", []) or []
        except (requests.RequestException, ValueError):
            feats = []
        if feats:
            return [
                (f["attributes"].get(field), f["attributes"].get("cnt"))
                for f in feats
            ]
        time.sleep(0.5)
    return []


def preview_shelby_regis(cfg: StateConfig) -> int:
    """Preview the Shelby ReGIS preset: distributions, address assembly,
    coordinates, and sample mapped records. Ingests nothing."""
    session = requests.Session()
    session.headers.update({"User-Agent": "DillyIntel/1.0"})

    print("=" * 72)
    print("Shelby County ReGIS — scraper preview (NO INGEST)")
    print("=" * 72)
    print(f"endpoint : {cfg.endpoint}")
    print(f"where    : {cfg.where}")
    print(f"page_size: {cfg.page_size}   keyset: {cfg.use_keyset}   "
          f"geometry: {cfg.return_geometry}")

    total = _arcgis_count(session, cfg.endpoint, cfg.where)
    print(f"\ncommercial parcels matching WHERE: {total:,}")

    print("\nLANDUSE distribution (within the WHERE filter):")
    for val, c in _arcgis_groupby(session, cfg.endpoint, cfg.where, "LANDUSE"):
        print(f"   {str(val):26s} {c:>8,}")

    print("\nTAXYR distribution (freshness check — expect 2026):")
    for val, c in _arcgis_groupby(session, cfg.endpoint, cfg.where, "TAXYR"):
        print(f"   {val}: {c:,}")

    # Sample via the real keyset loop, run through the real mapper.
    sample_pages = 6
    raw: list[dict] = []
    mapped: list[dict] = []
    last_oid = 0
    for _ in range(sample_pages):
        data, exhausted = fetch_page_resilient(session, cfg, keyset_oid=last_oid)
        if exhausted:
            break
        feats = data.get("features") or []
        for feat in feats:
            raw.append(feat)
            payload = map_tn_shelby_regis_feature(
                feat.get("attributes") or {}, feat.get("geometry")
            )
            if payload is not None:
                mapped.append(payload)
        oids = [o for o in
                ((f.get("attributes") or {}).get("OBJECTID") for f in feats)
                if isinstance(o, int)]
        if not oids:
            break
        last_oid = max(oids)
        if len(feats) < cfg.page_size:
            break

    print(f"\nsampled {len(raw):,} raw records (keyset paging); "
          f"mapper kept {len(mapped):,}")
    if not mapped:
        print("!! mapper kept nothing — check field mapping / classifier")
        return 1

    buckets = Counter(p["property_type"] for p in mapped)
    print("\nproperty_type distribution (mapped sample):")
    for b, c in buckets.most_common():
        print(f"   {b:18s} {c:>6,}  ({100.0 * c / len(mapped):5.1f}%)")
    keep_rate = len(mapped) / len(raw) if raw else 0.0
    print(f"\nmapper keep-rate: {keep_rate * 100:.1f}%  ->  extrapolated "
          f"commercial across {total:,}: ~{int(total * keep_rate):,}")

    print("\nowner mailing address assembly (10 samples — OWN_ADDR1 is empty,"
          " assembled from components):")
    shown = 0
    for feat in raw:
        if shown >= 10:
            break
        attr = feat.get("attributes") or {}
        assembled = _assemble_shelby_owner_mailing(attr)
        if not assembled:
            continue
        shown += 1
        comps = (f"ADRNO={attr.get('OWN_ADRNO')!r} "
                 f"PREDIR={attr.get('OWN_ADRPREDIR')!r} "
                 f"STR={attr.get('OWN_ADRSTR')!r} "
                 f"SUF={attr.get('OWN_ADRSUF')!r} "
                 f"POSTDIR={attr.get('OWN_ADRPOSTDIR')!r}")
        print(f"   [{shown}] {comps}")
        print(f"       -> {assembled!r}  |  "
              f"{attr.get('OWN_CITY')}, {attr.get('OWN_STATE')} "
              f"{attr.get('OWN_ZIP')}")

    with_xy = sum(1 for p in mapped
                  if p["latitude"] is not None and p["longitude"] is not None)
    print(f"\ncoordinates: {with_xy:,}/{len(mapped):,} mapped records carry a "
          f"valid in-Shelby lat/lon "
          f"({100.0 * with_xy / len(mapped):.1f}%)")

    print("\n20 sample commercial records (full field mapping):")
    for i, payload in enumerate(mapped[:20], 1):
        print(f"\n--- sample {i} ---")
        for k, v in payload.items():
            print(f"   {k:22s}: {v!r}")

    print("\n" + "=" * 72)
    print("PREVIEW COMPLETE — nothing ingested.")
    print("=" * 72)
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
    parser.add_argument("--preview", action="store_true",
                        help="rich preview: distributions, address assembly, coordinates, "
                             "and 20 sample mapped records — ingests nothing. "
                             "(implemented for --state tn_shelby_regis)")
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
        if args.preview:
            if cfg.state_abbr == "TN-SHELBY":
                return preview_shelby_regis(cfg)
            print(f"[{cfg.state_abbr.lower()}] --preview is only implemented for "
                  f"tn_shelby_regis; use --dry-run for a generic sample dump")
            return 2
        return run_state_preset(cfg, args)
    return run_custom(args)


if __name__ == "__main__":
    sys.exit(main())
