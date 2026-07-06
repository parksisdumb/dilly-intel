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

import re

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
    # Parking lots / garages — relevant to paving, striping, sealcoat,
    # and concrete contractors. A standalone bucket so the UI can label
    # it "Parking" rather than folding it into generic commercial.
    "parking",
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



# -------------------------------------------------------------------------
# Ohio — Land Use Code (LUC). Ohio Dept of Taxation publishes a 3-digit
# code system used by every county auditor (Cuyahoga, Franklin, etc.).
#   100-199: agricultural
#   300-399: industrial real
#   400-499: commercial real (offices, retail, hotels, healthcare)
#   500-599: residential
#   600-699: exempt
#   700-799: utility / mineral / public utility
# We also accept a separate luc_description text field (Cuyahoga ships
# this) for richer bucketing — same idea as Cook's property_type_use.
# -------------------------------------------------------------------------

_OH_LUC_BUCKETS: list[tuple[int, int, str, str]] = [
    (300, 399, "industrial", "Industrial real"),
    (400, 419, "retail", "Commercial — retail / store"),
    (420, 429, "hospitality", "Commercial — hotel / motel / lodging"),
    (430, 439, "office", "Commercial — office"),
    (440, 449, "industrial", "Commercial — warehousing / distribution"),
    (450, 459, "retail", "Commercial — restaurant / food service"),
    (460, 469, "retail", "Commercial — automotive / service"),
    (470, 479, "office", "Commercial — financial / banking"),
    (480, 489, "healthcare", "Commercial — medical / healthcare"),
    (490, 499, "other_commercial", "Commercial — other"),
]


def classify_oh_luc(
    code: str | None,
    desc: str | None = None,
) -> tuple[str, str, bool]:
    """
    Map an Ohio LUC (3-digit) to (bucket, description, is_commercial).
    Pass `desc` from a luc-description field (Cuyahoga's tax_luc_description)
    when available — the keyword scan there finds buckets the numeric
    range misses (self_storage, multifamily within 4xx, etc.).
    """
    desc_u = (desc or "").strip().upper()

    # Prefer description signals when present — they're more specific.
    if desc_u:
        if "STORAGE" in desc_u:
            return ("self_storage", "Self storage", True)
        if "OFFICE" in desc_u:
            return ("office", "Office", True)
        if "APARTMENT" in desc_u or "MULTIFAMILY" in desc_u or "MULTI-FAMILY" in desc_u:
            return ("multifamily", "Multifamily", True)
        if "HOTEL" in desc_u or "MOTEL" in desc_u or "LODG" in desc_u:
            return ("hospitality", "Hospitality", True)
        if "MEDICAL" in desc_u or "HOSPITAL" in desc_u or "NURSING" in desc_u:
            return ("healthcare", "Healthcare", True)
        if "WAREHOUS" in desc_u or "INDUSTRIAL" in desc_u or "MANUFACT" in desc_u:
            return ("industrial", "Industrial", True)
        if "MIXED" in desc_u:
            return ("mixed_use", "Mixed use", True)
        if "RETAIL" in desc_u or "STORE" in desc_u or "SHOPPING" in desc_u:
            return ("retail", "Retail", True)
        if "RESTAURANT" in desc_u or "FOOD" in desc_u:
            return ("retail", "Restaurant", True)
        if "RESIDENTIAL" in desc_u or "SINGLE FAMILY" in desc_u:
            return ("residential", desc_u, False)
        if "AGRIC" in desc_u or "FARM" in desc_u:
            return ("agricultural", desc_u, False)
        if "VACANT" in desc_u:
            return ("vacant", desc_u, False)
        if "EXEMPT" in desc_u:
            return ("other_commercial", "Exempt", False)

    # Fallback: numeric LUC range.
    s = (code or "").strip()
    if not s:
        return ("unknown", "Unknown", False)
    try:
        n = int(s)
    except ValueError:
        return ("unknown", f"OH LUC {s}", False)

    if 500 <= n < 600:
        return ("residential", f"OH LUC {n}", False)
    if 100 <= n < 300:
        return ("agricultural", f"OH LUC {n}", False)
    if 600 <= n < 700:
        return ("other_commercial", "Exempt", False)

    for lo, hi, bucket, dsc in _OH_LUC_BUCKETS:
        if lo <= n <= hi:
            return (bucket, dsc, True)

    if 700 <= n < 800:
        return ("other_commercial", f"OH utility {n}", True)
    return ("unknown", f"OH LUC {n}", False)


def is_commercial_oh(code: str | None, desc: str | None = None) -> bool:
    return classify_oh_luc(code, desc)[2]


# -------------------------------------------------------------------------
# Georgia — Fulton County uses a "LUCode" land-use code distinct from
# the broader ClassCode. ClassCode is the 7-class statewide residential/
# commercial/agriculture grouping; LUCode is finer-grained. We classify
# off LUCode when present, ClassCode as fallback.
#
# Fulton LUCodes are messy and county-specific. The reliable signal is:
#   100s = residential
#   200s = agricultural
#   300s = commercial
#   400s = industrial
#   500s = institutional / public
#   600s = utility
# -------------------------------------------------------------------------


def classify_ga_lucode(
    code: str | None,
    class_code: str | None = None,
) -> tuple[str, str, bool]:
    """
    Map a Fulton-County (GA) LUCode to (bucket, description, is_commercial).
    Falls back to GA ClassCode when LUCode is missing.
    """
    s = (code or "").strip()
    cls = (class_code or "").strip()

    def _classify_lucode_int(n: int) -> tuple[str, str, bool]:
        if 100 <= n < 200:
            return ("residential", f"GA LUC {n}", False)
        if 200 <= n < 300:
            return ("agricultural", f"GA LUC {n}", False)
        if 300 <= n < 400:
            # 3xx commercial — split a bit by sub-range
            if 310 <= n <= 319:
                return ("retail", f"GA commercial retail ({n})", True)
            if 320 <= n <= 329:
                return ("office", f"GA commercial office ({n})", True)
            if 330 <= n <= 339:
                return ("hospitality", f"GA commercial lodging ({n})", True)
            if 340 <= n <= 349:
                return ("healthcare", f"GA commercial medical ({n})", True)
            if 350 <= n <= 359:
                return ("industrial", f"GA commercial warehouse ({n})", True)
            return ("other_commercial", f"GA commercial ({n})", True)
        if 400 <= n < 500:
            return ("industrial", f"GA industrial ({n})", True)
        if 500 <= n < 600:
            return ("other_commercial", f"GA institutional ({n})", False)
        if 600 <= n < 700:
            return ("other_commercial", f"GA utility ({n})", True)
        return ("unknown", f"GA LUC {n}", False)

    if s:
        try:
            return _classify_lucode_int(int(float(s)))
        except (ValueError, TypeError):
            pass

    # ClassCode fallback — single digit / letter.
    if cls:
        c = cls[0]
        if c == "3":
            return ("retail", "GA class 3 (commercial/industrial)", True)
        if c in {"1", "2"}:
            return ("residential", f"GA class {c}", False)
        if c == "4":
            return ("other_commercial", "GA class 4 (utility)", True)

    return ("unknown", "Unknown", False)


def is_commercial_ga(code: str | None, class_code: str | None = None) -> bool:
    return classify_ga_lucode(code, class_code)[2]



# -------------------------------------------------------------------------
# Missouri — Property Class Code (Class 1-4 statutory grouping):
#   1 = Residential
#   2 = Agricultural
#   3 = Commercial (offices, retail, hotels)
#   4 = Industrial / utility / public service / leasehold
# Some counties subdivide into 3xx/4xx ranges; we accept either form.
# -------------------------------------------------------------------------


def classify_mo_class(code) -> tuple[str, str, bool]:
    """Bucket on the leading digit so single-digit ("3"), 2-digit ("32"),
    and 3-digit ("312") codes all map to the same statutory class.
    Float-stringed inputs ("30.0") are normalized to int first."""
    if code is None:
        return ("unknown", "Unknown", False)
    s = str(code).strip()
    if not s:
        return ("unknown", "Unknown", False)
    # Strip a trailing ".0" / fractional component if any (some sources
    # ship integers as floats over JSON).
    if "." in s:
        try:
            s = str(int(float(s)))
        except (ValueError, TypeError):
            return ("unknown", f"MO class {s}", False)
    if not s or not s[0].isdigit():
        return ("unknown", f"MO class {s}", False)
    head = int(s[0])
    if head == 1:
        return ("residential", f"MO class {s}", False)
    if head == 2:
        return ("agricultural", f"MO class {s}", False)
    if head == 3:
        return ("other_commercial", f"MO commercial ({s})", True)
    if head == 4:
        return ("industrial", f"MO industrial ({s})", True)
    if head == 5:
        return ("other_commercial", f"MO misc ({s})", True)
    return ("unknown", f"MO class {s}", False)


def is_commercial_mo(code) -> bool:
    return classify_mo_class(code)[2]



# -------------------------------------------------------------------------
# Mississippi — MARIS Cadastral Framework.
#
# Two-pass investigation (2026-05-12) confirmed that the published
# MARIS schema does NOT carry a usable property-class code. The `CAMA`
# field that the metadata advertises as the classifier is actually the
# software-vendor name (only two values across 2M rows). And `CLASSDESC`
# / `USEDESC` are missing.
#
# We therefore classify by a multi-signal heuristic instead:
#
#   Tier 1 (definite): ZONING starts with C/B/I.
#     C* → retail (broad commercial)
#     B* → office (business/professional)
#     I* → industrial
#     ZONING population is sparse (~2% on West, 0 on East) but the
#     codes are crisp where present.
#
#   Tier 2 (likely): OWNNAME matches a corporate suffix
#                    AND IMPVAL1+IMPVAL2 >= $100k
#                    AND OWNNAME does NOT match the
#                    timber/farm/church/etc anti-pattern.
#     The $100k IMPVAL threshold filters out small barns/sheds on
#     corp-owned rural land (the main source of false positives), and
#     the anti-pattern set drops the timber and ag holding companies
#     that dominate corp-suffix matches in rural MS.
#
#   Tier 3: skip (returns is_commercial=False).
#
# Legacy code/desc logic remains in place as a fallback for non-MARIS
# callers that may still pass a class code + description.
# -------------------------------------------------------------------------


# Corporate-suffix detector for the MS tier-2 path. Same set as the
# analyzer + same word-boundary rules so the runtime classifier sees the
# same hits the analyzer saw.
_MS_CORP_SUFFIX_RE = re.compile(
    r"\b("
    r"LLC|L\.L\.C\.?|"
    r"INC|INCORPORATED|"
    r"CORP|CORPORATION|"
    r"LP|L\.P\.?|"
    r"LLP|L\.L\.P\.?|"
    r"REIT|TRUST|"
    r"HOLDINGS|"
    r"PROPERTIES|PROPERTY|"
    r"PARTNERS|PARTNERSHIP|"
    r"ASSOCIATES|ASSOCIATION|ASSOC|"
    r"CAPITAL|"
    r"INVESTMENTS|INVESTMENT|"
    r"MANAGEMENT|"
    r"DEVELOPMENT|"
    r"ENTERPRISES|ENTERPRISE|"
    r"GROUP|VENTURES|"
    r"REALTY|"
    r"COMPANY|CO|"
    r"FOUNDATION"
    r")\b",
    re.IGNORECASE,
)

# Anti-pattern: corp-named owners that are NOT commercial real estate —
# timber/farm/ranch holdings, churches, cemeteries, public-service
# districts, school boards. Matched anywhere in the name; \b on both
# ends means "TREEFARM" matches but "FARMSTEAD" doesn't.
_MS_ANTI_PATTERN_RE = re.compile(
    r"\b("
    r"TIMBER|"
    r"TREE\s+FARM|TREEFARM|"
    r"LAND\s+COMPANY|LAND\s+CO|"
    r"FARMS|FARMING|"
    r"RANCH|RANCHING|"
    r"CATTLE|LIVESTOCK|"
    r"HUNTING|HUNT\s+CLUB|"
    r"FORESTRY|"
    r"CHURCH|BAPTIST|METHODIST|"
    r"CEMETERY|"
    r"SCHOOL\s+DISTRICT|BOARD\s+OF\s+EDUCATION|"
    r"HOUSING\s+AUTHORITY|"
    r"WATER\s+DISTRICT|FIRE\s+DISTRICT|UTILITY\s+DISTRICT"
    r")\b",
    re.IGNORECASE,
)

MS_IMPVAL_THRESHOLD = 100_000  # Tier-2 minimum building-improvements value



_MS_DESC_COMMERCIAL_KEYWORDS = [
    ("multifamily", "multifamily", "Multifamily"),
    ("multi-family", "multifamily", "Multifamily"),
    ("apartment", "multifamily", "Apartment"),
    ("apt ", "multifamily", "Apartment"),
    ("storage", "self_storage", "Self storage"),
    ("warehouse", "industrial", "Warehouse"),
    ("manufact", "industrial", "Manufacturing"),
    ("factory", "industrial", "Factory"),
    ("industrial", "industrial", "Industrial"),
    ("hotel", "hospitality", "Hospitality"),
    ("motel", "hospitality", "Hospitality"),
    ("lodging", "hospitality", "Hospitality"),
    ("medical", "healthcare", "Healthcare"),
    ("hospital", "healthcare", "Healthcare"),
    ("clinic", "healthcare", "Healthcare"),
    ("nursing", "healthcare", "Healthcare"),
    ("dialysis", "healthcare", "Healthcare"),
    ("office", "office", "Office"),
    ("retail", "retail", "Retail"),
    ("shop", "retail", "Retail"),
    ("store", "retail", "Retail"),
    ("restaurant", "retail", "Restaurant"),
    ("commercial", "other_commercial", "Commercial"),
]

_MS_DESC_RESIDENTIAL_KEYWORDS = (
    "single family",
    "single-family",
    "residential",
    "homestead",
    "vacant residential",
)

_MS_DESC_DROP_KEYWORDS = (
    "vacant",
    "exempt",
    "tax-exempt",
    "agricultural",
    "ag land",
    "timber",
    "cropland",
    "pasture",
    "mineral",
    "right of way",
    "right-of-way",
    "easement",
)

# Common short codes seen across MS county CAMAs.
_MS_CODE_BUCKETS = {
    "COM": ("other_commercial", "Commercial"),
    "COML": ("other_commercial", "Commercial"),
    "COMM": ("other_commercial", "Commercial"),
    "C": ("other_commercial", "Commercial"),
    "IND": ("industrial", "Industrial"),
    "INDUS": ("industrial", "Industrial"),
    "I": ("industrial", "Industrial"),
    "MFR": ("multifamily", "Multifamily"),
    "APT": ("multifamily", "Apartment"),
    "RES": ("residential", "Residential"),
    "RESI": ("residential", "Residential"),
    "R": ("residential", "Residential"),
    "AGR": ("agricultural", "Agricultural"),
    "AG": ("agricultural", "Agricultural"),
    "VAC": ("vacant", "Vacant"),
    "EXM": ("other_commercial", "Exempt"),
    "EX": ("other_commercial", "Exempt"),
}


def classify_ms_cama(
    code: str | None = None,
    desc: str | None = None,
    *,
    owner: str | None = None,
    zoning: str | None = None,
    imp_val: float | int | None = None,
    imp_val_threshold: float = MS_IMPVAL_THRESHOLD,
) -> tuple[str, str, bool]:
    """
    Multi-signal Mississippi MARIS classifier.

    Returns (bucket, description, is_commercial). Designed for the
    mississippi_maris_scraper, which feeds every record through this
    and skips rows where is_commercial=False.

    Decision order:
      Tier 1 — ZONING prefix C/B/I wins outright.
      Tier 2 — corp-suffix owner + IMPVAL ≥ threshold + no anti-pattern.
      Tier 3 — legacy code/desc fallback for non-MARIS callers.
    """
    # ── Tier 1: ZONING prefix ─────────────────────────────────────────
    if zoning:
        z = zoning.strip().upper()
        if z:
            head = z[0]
            if head == "C":
                return ("retail", f"Commercial zoning ({z})", True)
            if head == "B":
                return ("office", f"Business zoning ({z})", True)
            if head == "I":
                return ("industrial", f"Industrial zoning ({z})", True)

    # ── Tier 2: corp suffix + IMPVAL + no anti-pattern ────────────────
    if owner and imp_val is not None:
        try:
            iv = float(imp_val)
        except (TypeError, ValueError):
            iv = 0.0
        if iv >= imp_val_threshold:
            if _MS_CORP_SUFFIX_RE.search(owner) and not _MS_ANTI_PATTERN_RE.search(owner):
                return (
                    "other_commercial",
                    f"Corp owner + IMPVAL ${iv:,.0f}",
                    True,
                )

    # ── Tier 3: legacy code/desc fallback (non-MARIS callers) ─────────
    desc_u = (desc or "").strip().upper()
    code_u = (code or "").strip().upper()

    if desc_u:
        for kw, bucket, label in _MS_DESC_COMMERCIAL_KEYWORDS:
            if kw.upper() in desc_u:
                return (bucket, f"{label} ({desc_u})", True)
        for kw in _MS_DESC_RESIDENTIAL_KEYWORDS:
            if kw.upper() in desc_u:
                return ("residential", desc_u, False)
        for kw in _MS_DESC_DROP_KEYWORDS:
            if kw.upper() in desc_u:
                return ("vacant", desc_u, False)

    if code_u in _MS_CODE_BUCKETS:
        bucket, label = _MS_CODE_BUCKETS[code_u]
        return (bucket, f"{label} ({code_u})", bucket in COMMERCIAL_BUCKETS)

    digits = "".join(c for c in code_u if c.isdigit())
    if digits:
        head = digits[0]
        if head == "1":
            return ("residential", f"MS code {code_u}", False)
        if head == "2":
            return ("agricultural", f"MS code {code_u}", False)
        if head == "3":
            return ("other_commercial", f"MS commercial ({code_u})", True)
        if head == "4":
            return ("industrial", f"MS industrial ({code_u})", True)
        if head == "5":
            return ("other_commercial", f"MS utility/special ({code_u})", True)

    return ("unknown", f"MS code {code_u or '(empty)'}", False)


def is_commercial_ms(code: str | None, desc: str | None = None) -> bool:
    return classify_ms_cama(code, desc)[2]


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


# -------------------------------------------------------------------------
# Tennessee — Shelby County ReGIS (Memphis assessor, CERT_Parcel layer).
#
# The endpoint carries three classification fields:
#   CLASS    — coarse one-letter R/C/E/I/F (residential / commercial /
#              exempt / industrial / farm). Too coarse: CLASS=C mixes
#              multifamily, commercial, office, vacant, parking.
#   LUC      — 114 granular numeric land-use codes, but the endpoint
#              publishes no code-book.
#   LANDUSE  — 11 clean text values, 100% populated.
#
# Preview (2026-05-22) confirmed every LUC code rolls up to exactly one
# LANDUSE, so LANDUSE is the classifier and LUC is kept only as the
# stored property_use_code.
#
# INSTITUTIONAL is the one mixed bucket (hospitals + clinics + schools +
# churches + government). We sub-classify it: an owner name carrying a
# healthcare keyword becomes "healthcare"; everything else in
# INSTITUTIONAL stays "other_commercial".
# -------------------------------------------------------------------------

# Healthcare keywords for the INSTITUTIONAL sub-classification. Matched
# (case-insensitively) anywhere in the owner name.
_SHELBY_HEALTHCARE_OWNER_KEYWORDS = (
    "HOSPITAL", "MEDICAL", "CLINIC", "NURSING",
    "METHODIST", "BAPTIST",
    "LEBONHEUR", "LE BONHEUR",
    "ST JUDE", "ST. JUDE", "SAINT JUDE",
)

# LANDUSE value -> (bucket, description). INSTITUTIONAL is handled
# separately. is_commercial is derived from COMMERCIAL_BUCKETS so the
# "parking" bucket (added to that set) counts as commercial.
_SHELBY_LANDUSE_BUCKETS: dict[str, tuple[str, str]] = {
    # COMMERCIAL is the strip-mall / store / restaurant / car-wash bucket
    # in Shelby's taxonomy. Routed to "retail" so it lands in the Retail
    # rollup category on the market dashboard rather than the catch-all
    # "Other". (Earlier emitted "other_commercial"; migration
    # 20260523000002 backfills the in-place fix.)
    "COMMERCIAL": ("retail", "Commercial"),
    "OFFICE": ("office", "Office"),
    "INDUSTRIAL": ("industrial", "Industrial"),
    "MULTI-FAMILY": ("multifamily", "Multifamily"),
    "PARKING": ("parking", "Parking"),
    # Skip categories — kept explicit so an unexpected value falls through
    # to "unknown" rather than being silently treated as one of these.
    "SINGLE-FAMILY": ("residential", "Single-family residential"),
    "VACANT": ("vacant", "Vacant"),
    "COMMON AREA LAND": ("vacant", "Common area land"),
    "RECREATION/OPEN SPACE": ("vacant", "Recreation / open space"),
}


def classify_shelby_regis(
    landuse: str | None,
    luc: str | None = None,
    owner_name: str | None = None,
) -> tuple[str, str, bool]:
    """
    Shelby County (Memphis) ReGIS classifier. Keys on LANDUSE; uses
    owner_name only for the INSTITUTIONAL healthcare sub-classification.
    `luc` is accepted for signature parity / future refinement but is not
    needed for bucketing (every LUC rolls up to one LANDUSE).

    Returns (bucket, description, is_commercial).

    Examples:
        ("COMMERCIAL", "034", "ACME LLC")        -> ("other_commercial", ...,  True)
        ("OFFICE", "068", None)                  -> ("office", "Office", True)
        ("PARKING", "001", None)                 -> ("parking", "Parking", True)
        ("INSTITUTIONAL", "008", "BAPTIST HOSP") -> ("healthcare", ...,  True)
        ("INSTITUTIONAL", "008", "CITY SCHOOL")  -> ("other_commercial", ..., True)
        ("SINGLE-FAMILY", "062", None)           -> ("residential", ...,  False)
    """
    lu = (landuse or "").strip().upper()
    if not lu:
        return ("unknown", "Unknown", False)

    if lu == "INSTITUTIONAL":
        owner_u = (owner_name or "").upper()
        if any(kw in owner_u for kw in _SHELBY_HEALTHCARE_OWNER_KEYWORDS):
            return ("healthcare", "Institutional — healthcare", True)
        return ("other_commercial", "Institutional", True)

    entry = _SHELBY_LANDUSE_BUCKETS.get(lu)
    if entry is None:
        # Unrecognized LANDUSE — skip rather than guess.
        return ("unknown", f"Shelby LANDUSE {lu}", False)

    bucket, desc = entry
    return (bucket, desc, bucket in COMMERCIAL_BUCKETS)


def is_commercial_shelby(
    landuse: str | None,
    luc: str | None = None,
    owner_name: str | None = None,
) -> bool:
    return classify_shelby_regis(landuse, luc, owner_name)[2]
