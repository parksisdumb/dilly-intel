"""
Property-use-code classifiers for each public-data source.

Each source uses its own coding system. We map raw codes to:
  1. A human-readable description (saved as `property_use_desc`)
  2. A bucket in our standard categories: office | retail | industrial |
     multifamily | healthcare | self_storage | mixed_use | hospitality |
     other_commercial | residential | agricultural | vacant | unknown
  3. A boolean is_commercial flag — controls whether we ingest the row

Buckets match the filter pills on /intelligence so codes line up across
sources without a translation layer.
"""
from __future__ import annotations

# Bucket names — keep aligned with the /intelligence page's filter
# checkbox set so cross-source filtering works.
COMMERCIAL_BUCKETS = {
    "office",
    "retail",
    "industrial",
    "multifamily",
    "healthcare",
    "self_storage",
    "mixed_use",
    "hospitality",
    "other_commercial",
}


# -------------------------------------------------------------------------
# Texas — Texas Comptroller PTAD codes (used by HCAD `state_class`,
# DCAD `LUC`, TAD `State_Use_Cd`).
#
# Code letters from PTAD Property Classification Guide:
#   A = single-family residential
#   B = multi-family residential
#   C = vacant lots / tracts
#   D = qualified open-space (ag)
#   E = rural improvements (ag with home)
#   F = commercial / industrial real
#       F1 = commercial real (retail, office)
#       F2 = industrial real
#   G = oil / gas / minerals
#   H = tangible personal vehicles
#   J = utilities
#   L = personal property (commercial / industrial)
#       L1 = commercial personal
#       L2 = industrial personal
#   M = mobile homes
#   N = intangibles
#   O = residential inventory
#   S = special inventory
#   X = exempt
# -------------------------------------------------------------------------

_TX_STATE_CLASS_BUCKETS = {
    "F1": ("retail", "Commercial real (retail/office)"),
    "F2": ("industrial", "Industrial real"),
    "B1": ("multifamily", "Multifamily 5+ units"),
    "B2": ("multifamily", "Duplex"),
    "B3": ("multifamily", "Triplex / fourplex"),
    "B4": ("multifamily", "Multifamily"),
    "L1": ("other_commercial", "Commercial personal property"),
    "L2": ("industrial", "Industrial personal property"),
    "J1": ("other_commercial", "Utility"),
    "J2": ("other_commercial", "Utility — gas"),
    "J3": ("other_commercial", "Utility — electric"),
    "J4": ("other_commercial", "Utility — telephone"),
    "J5": ("other_commercial", "Utility — railroad"),
    "J6": ("other_commercial", "Utility — pipeline"),
    "J7": ("other_commercial", "Utility — cable / other"),
    "J8": ("other_commercial", "Utility — other"),
}

# Codes we explicitly drop — residential, ag, exempt.
_TX_NON_COMMERCIAL_PREFIXES = ("A", "C", "D", "E", "G", "H", "M", "N", "O", "S", "X")


def classify_tx_state_class(code: str | None) -> tuple[str, str, bool]:
    """
    Map a TX appraisal use-code (state_class / LUC / State_Use_Cd) to
    (bucket, description, is_commercial).

    Examples:
        "F1"  -> ("retail", "Commercial real (retail/office)", True)
        "B1"  -> ("multifamily", "Multifamily 5+ units", True)
        "A1"  -> ("residential", "Single-family residential", False)
        ""    -> ("unknown", "Unknown", False)
    """
    if not code:
        return ("unknown", "Unknown", False)

    norm = code.strip().upper()
    if not norm:
        return ("unknown", "Unknown", False)

    if norm in _TX_STATE_CLASS_BUCKETS:
        bucket, desc = _TX_STATE_CLASS_BUCKETS[norm]
        return (bucket, desc, True)

    # Bare-letter codes: F is commercial, B is multifamily, L is industrial-ish.
    head = norm[0]
    if head == "F":
        return ("other_commercial", "Commercial / industrial real", True)
    if head == "B":
        return ("multifamily", "Multifamily residential", True)
    if head == "L":
        return ("other_commercial", "Commercial / industrial personal", True)
    if head == "J":
        return ("other_commercial", "Utility", True)
    if head == "A":
        return ("residential", "Single-family residential", False)
    if head == "C":
        return ("vacant", "Vacant lot", False)
    if head in {"D", "E"}:
        return ("agricultural", "Agricultural", False)
    if head == "X":
        return ("other_commercial", "Exempt", False)
    if head in _TX_NON_COMMERCIAL_PREFIXES:
        return ("residential", f"Non-commercial ({head})", False)

    return ("other_commercial", f"TX class {norm}", True)


def is_commercial_tx(code: str | None) -> bool:
    return classify_tx_state_class(code)[2]


# -------------------------------------------------------------------------
# Florida DOR — DOR_UC (3-digit code 000–099)
#
# Per FL DOR 2023 NAL/SDF/NAP User's Guide:
#   00      Vacant residential (residual)
#   01-09   Single-family / mobile / multifamily <=4 units
#   08      Multifamily <=9 units (residential)
#   10      Vacant commercial
#   11-19   Stores, retail, restaurants
#   20-27   Hotels, motels, lodging
#   28      Parking lots
#   30-38   Warehouses, distribution
#   39      Industrial — light
#   40-49   Industrial / manufacturing
#   50-59   Improved agricultural / commercial
#   60-69   Office buildings
#   70-79   Cultural, entertainment, recreation
#   80-89   Multifamily 5+ units, condos, retirement
#   90-98   Mining, petroleum, utilities, leasehold
#   99      Acreage not zoned ag (residual)
# -------------------------------------------------------------------------


def _fl_uc_int(code: str | None) -> int | None:
    if code is None:
        return None
    s = str(code).strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


_FL_BUCKETS: list[tuple[int, int, str, str]] = [
    (10, 10, "vacant", "Vacant commercial"),
    (11, 14, "retail", "Stores"),
    (15, 17, "retail", "Department / supermarkets / restaurants"),
    (18, 18, "office", "Office building (one-story)"),
    (19, 19, "retail", "Retail — parking, drive-in"),
    (20, 27, "hospitality", "Hotels / motels / lodging"),
    (28, 28, "other_commercial", "Parking lots / mobile home parks"),
    (30, 38, "industrial", "Warehouses / distribution"),
    (39, 39, "industrial", "Light industrial"),
    (40, 49, "industrial", "Manufacturing / heavy industrial"),
    (50, 59, "agricultural", "Improved agricultural"),
    (60, 69, "office", "Office building"),
    (70, 79, "other_commercial", "Cultural / entertainment / recreation"),
    (80, 89, "multifamily", "Multifamily / condo / retirement"),
    (90, 92, "other_commercial", "Leasehold / utilities"),
    (93, 96, "industrial", "Mining / petroleum"),
    (97, 98, "other_commercial", "Utilities / cooperatives"),
]


def classify_fl_dor_uc(code: str | None) -> tuple[str, str, bool]:
    """
    Map a FL DOR_UC (3-digit) to (bucket, description, is_commercial).
    Commercial = anything in our standard buckets EXCEPT residential / vacant.
    """
    n = _fl_uc_int(code)
    if n is None:
        return ("unknown", "Unknown", False)

    if n < 10:
        return ("residential", "Residential <=4 units", False)
    if n == 99:
        return ("agricultural", "Acreage not zoned ag", False)

    for lo, hi, bucket, desc in _FL_BUCKETS:
        if lo <= n <= hi:
            is_comm = bucket in COMMERCIAL_BUCKETS
            return (bucket, desc, is_comm)

    return ("other_commercial", f"FL DOR_UC {n:03d}", True)


def is_commercial_fl(code: str | None) -> bool:
    return classify_fl_dor_uc(code)[2]


# -------------------------------------------------------------------------
# NC OneMap — multi-signal classifier.
#
# NC OneMap aggregates parcels from 100 counties; each county uses its own
# CAMA coding system. Live sample (5,000 rows across 5 counties) confirms:
#   - 28% of records have `parusecode`     (3-letter codes: RES, COM, IND…)
#   - 48% have `parusedesc`                (mix of plain text + zoning codes)
#   - 26% have `parusecd2` (secondary)     (overlap with primary)
#   - 18% have `parusedsc2`
#   - 52% have NO classification data at all (skip those — too noisy to ingest)
#
# Classifier reads all four fields, applies INCLUDE / EXCLUDE substring
# patterns, then a zoning-prefix heuristic for desc fields that look like
# municipal zoning codes (R-15, B-1, C-1, I-L, R-A). Strong INCLUDE in any
# field beats EXCLUDE elsewhere — explicit "COMMERCIAL" wins over a stray
# "RES" in another column.
# -------------------------------------------------------------------------


# 3-letter / short-code substrings. Match against parusecode + parusecd2.
_NC_CODE_INCLUDE = ("COM", "IND", "MFR", "APT", "RET", "OFF", "WHS", "HSP", "HTL", "MXD", "STR")
_NC_CODE_EXCLUDE = ("RES", "RHS", "VAC", "AGR", "FRM", "FRST", "MAN-HOU", "HOA", "XMT")

# Plain-text descriptions. Match against parusedesc + parusedsc2.
_NC_DESC_INCLUDE = (
    "COMMERCIAL", "INDUSTRIAL", "OFFICE", "RETAIL", "WAREHOUSE",
    "APARTMENT", "HOTEL", "HOSPITAL", "STORAGE", "MULTIFAMILY", "SHOPPING",
)
_NC_DESC_EXCLUDE = (
    "SINGLE FAMILY", "RESIDENTIAL", "VACANT", "AGRICULTURAL", "FOREST", "MOBILE HOME",
)

# Zoning-code prefixes (parusedesc carries values like 'R-15', 'B-1', 'I-L').
# Used as a tiebreaker when no INCLUDE / EXCLUDE keyword matches.
_NC_ZONING_INCLUDE_PREFIX = ("B-", "C-", "O-", "I-")
_NC_ZONING_EXCLUDE_PREFIX = ("R-", "A-", "F-")

# Bucket-assignment table — first match wins. Tested against both code and
# desc strings (whichever channel triggered the include).
_NC_BUCKET_RULES: list[tuple[tuple[str, ...], str, str]] = [
    (("OFFICE", "OFF"), "office", "Office"),
    (("STORAGE", "STR"), "self_storage", "Self storage"),
    (("HOTEL", "HTL", "MOTEL", "LODG"), "hospitality", "Hospitality"),
    (("HOSPITAL", "HSP", "MEDICAL", "NURSING", "CLINIC", "HEALTH"), "healthcare", "Healthcare"),
    (("APARTMENT", "APT", "MULTIFAMILY", "MFR"), "multifamily", "Multifamily"),
    (("WAREHOUSE", "WHS", "INDUSTRIAL", "IND", "MANUFAC", "MFG"), "industrial", "Industrial"),
    (("MIXED", "MXD"), "mixed_use", "Mixed use"),
    (("SHOPPING", "RETAIL", "RET", "STORE", "SHOP", "MALL"), "retail", "Retail"),
    (("COMMERCIAL", "COM"), "retail", "Commercial"),
]


def _nc_bucket_for(haystack: str) -> tuple[str, str]:
    """Pick the most specific bucket that matches the include signal."""
    for keys, bucket, desc in _NC_BUCKET_RULES:
        if any(k in haystack for k in keys):
            return (bucket, desc)
    return ("other_commercial", "Commercial")


def classify_nc_paruse(
    code: str | None,
    desc: str | None = None,
    code2: str | None = None,
    desc2: str | None = None,
) -> tuple[str, str, bool]:
    """
    Multi-signal NC classifier.

    Returns (bucket, description, is_commercial).

    Single-arg call (`classify_nc_paruse(code)`) supported for back-compat
    with anything that may still be calling the old signature, but the
    scraper passes all four fields.
    """
    code_u = (code or "").strip().upper()
    desc_u = (desc or "").strip().upper()
    code2_u = (code2 or "").strip().upper()
    desc2_u = (desc2 or "").strip().upper()

    # Empty across all four -> skip entirely (52% of NC OneMap rows hit this)
    if not code_u and not desc_u and not code2_u and not desc2_u:
        return ("unknown", "No classification data", False)

    code_combined = f"{code_u} {code2_u}".strip()
    desc_combined = f"{desc_u} {desc2_u}".strip()

    # 1. Strong INCLUDE wins first — explicit commercial signal beats any
    #    stray exclude in another field.
    if any(k in code_combined for k in _NC_CODE_INCLUDE):
        bucket, dsc = _nc_bucket_for(code_combined)
        return (bucket, f"{dsc} ({code_u or code2_u})".strip(), True)
    if any(k in desc_combined for k in _NC_DESC_INCLUDE):
        bucket, dsc = _nc_bucket_for(desc_combined)
        return (bucket, dsc, True)

    # 2. EXCLUDE patterns — clear residential / ag / vacant / exempt.
    if any(k in code_combined for k in _NC_CODE_EXCLUDE):
        return ("residential", code_u or code2_u or "Residential", False)
    if any(k in desc_combined for k in _NC_DESC_EXCLUDE):
        return ("residential", desc_u or desc2_u or "Residential", False)

    # 3. Zoning-prefix heuristic (R-15, B-1, C-1, I-L, etc).
    for src in (desc_u, desc2_u):
        if not src:
            continue
        if any(src.startswith(p) for p in _NC_ZONING_INCLUDE_PREFIX):
            bucket, dsc = _nc_bucket_for(src)
            return (bucket, f"Zoning {src}", True)
        if any(src.startswith(p) for p in _NC_ZONING_EXCLUDE_PREFIX):
            return ("residential", f"Zoning {src}", False)

    # 4. Default — has data but doesn't match anything we recognize.
    #    Skip to avoid polluting commercial inventory.
    return ("unknown", f"Unrecognized: {code_u}|{desc_u}|{code2_u}|{desc2_u}".strip("|"), False)


def is_commercial_nc(
    code: str | None,
    desc: str | None = None,
    code2: str | None = None,
    desc2: str | None = None,
) -> bool:
    return classify_nc_paruse(code, desc, code2, desc2)[2]


# -------------------------------------------------------------------------
# Arkansas — gis.arkansas.gov uses `parceltype` and `taxcode`. parceltype
# is the cleanest signal: "RESIDENTIAL", "COMMERCIAL", "AGRICULTURAL",
# "EXEMPT", "MIXED USE", "VACANT", "MINERAL".
# -------------------------------------------------------------------------


def classify_ar_parceltype(parceltype: str | None) -> tuple[str, str, bool]:
    if not parceltype:
        return ("unknown", "Unknown", False)
    s = parceltype.strip().upper()
    if not s:
        return ("unknown", "Unknown", False)

    if "COMMERCIAL" in s:
        return ("retail", "Commercial", True)
    if "INDUSTRIAL" in s:
        return ("industrial", "Industrial", True)
    if "MULTI" in s or "APARTMENT" in s:
        return ("multifamily", "Multifamily", True)
    if "OFFICE" in s:
        return ("office", "Office", True)
    if "MIXED" in s:
        return ("mixed_use", "Mixed use", True)
    if "RESID" in s:
        return ("residential", "Residential", False)
    if "AGRIC" in s or "FARM" in s or "TIMBER" in s:
        return ("agricultural", "Agricultural", False)
    if "VACANT" in s:
        return ("vacant", "Vacant", False)
    if "EXEMPT" in s:
        return ("other_commercial", "Exempt", False)
    if "MINERAL" in s:
        return ("other_commercial", "Mineral", False)

    return ("other_commercial", f"AR {s}", True)
