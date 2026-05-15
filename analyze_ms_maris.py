#!/usr/bin/env python3
"""
MARIS tier-classification analyzer (read-only — no DB writes).

Streams a MARIS shapefile and applies the multi-signal commercial
classification we settled on after the first analyzer pass:

  Tier 1 — definite commercial: ZONING starts with C, B, or I.
  Tier 2 — likely commercial:   corp suffix in OWNNAME
                                AND IMPVAL1+IMPVAL2 >= 100k
                                AND OWNNAME does NOT match the
                                timber/farm/church/etc. anti-pattern.
  Tier 3 — skip everything else.

Output sections:
  1. Tier counts (1 / 2 / 3) for the full file
  2. Tier 2 breakdown by county (top 20)
  3. 30 sample Tier 2 records
  4. 10 just-missed-Tier-2 (corp + IMPVAL between 50k and 99k)
  5. 10 anti-pattern-caught (corp + IMPVAL >= 100k but excluded)

Usage:
    python analyze_ms_maris.py <path/to/shapefile.shp>
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

import shapefile  # pyshp


# Corporate-suffix detector — same set as the first analyzer.
CORP_SUFFIX_RE = re.compile(
    r"\b("
    r"LLC|L\.L\.C\.?|"
    r"INC|INCORPORATED|"
    r"CORP|CORPORATION|"
    r"LP|L\.P\.?|"
    r"LLP|L\.L\.P\.?|"
    r"REIT|"
    r"TRUST|"
    r"HOLDINGS|"
    r"PROPERTIES|PROPERTY|"
    r"PARTNERS|PARTNERSHIP|"
    r"ASSOCIATES|ASSOCIATION|ASSOC|"
    r"CAPITAL|"
    r"INVESTMENTS|INVESTMENT|"
    r"MANAGEMENT|"
    r"DEVELOPMENT|"
    r"ENTERPRISES|ENTERPRISE|"
    r"GROUP|"
    r"VENTURES|"
    r"REALTY|"
    r"COMPANY|CO|"
    r"FOUNDATION"
    r")\b",
    re.IGNORECASE,
)

# Anti-pattern — corp-named records that are NOT commercial real estate:
# timber/farm/ranch operations, churches, cemeteries, public utility
# districts, school boards.
# Multi-word patterns work fine inside \b...\b because internal spaces
# are word chars; \b only requires word/non-word transitions at the ends.
ANTI_PATTERN_RE = re.compile(
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

IMPVAL_THRESHOLD = 100_000
JUST_MISSED_LO, JUST_MISSED_HI = 50_000, 100_000


# ---------- helpers ----------

def _str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bytes):
        try:
            v = v.decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            return ""
    return str(v).strip()


def _to_float(v) -> float:
    if v is None or v == "":
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _truncate(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


def _row(cells: list[str], widths: list[int]) -> str:
    return "  ".join(_truncate(c, w).ljust(w) for c, w in zip(cells, widths))


def classify_tier(owner: str, zoning: str, imp_val: float) -> tuple[int, str]:
    """Return (tier, reason). Tier 1/2 = keep. Tier 3 = skip."""
    z = zoning.strip().upper()
    if z and z[0] in ("C", "B", "I"):
        return (1, f"zoning={z}")

    if owner and CORP_SUFFIX_RE.search(owner):
        anti = ANTI_PATTERN_RE.search(owner)
        if anti:
            return (3, f"anti-pattern: {anti.group(0)}")
        if imp_val >= IMPVAL_THRESHOLD:
            return (2, f"corp + impval=${imp_val:,.0f}")
        return (3, f"corp but impval=${imp_val:,.0f} below ${IMPVAL_THRESHOLD:,}")

    return (3, "no commercial signal")


# ---------- main analysis ----------

def analyze(shp_path: Path) -> None:
    print(f"\n{'='*82}")
    print(f"TIER ANALYSIS: {shp_path.name}")
    print(f"Path: {shp_path}")
    print("=" * 82)

    sf = shapefile.Reader(str(shp_path))
    try:
        field_names = [f[0] for f in sf.fields[1:]]
        idx = {n: i for i, n in enumerate(field_names)}
        total = len(sf)
        print(f"Records: {total:,}")

        required = ["OWNNAME", "ZONING", "IMPVAL1", "IMPVAL2", "TOTVAL",
                    "LATDEC", "LONGDEC", "MAILADD1", "SCITY", "CNTYNAME"]
        missing = [c for c in required if c not in idx]
        if missing:
            print(f"ERROR: missing columns: {missing}")
            return

        tier1 = 0
        tier2 = 0
        tier3 = 0
        tier1_zoning_counter: Counter[str] = Counter()
        tier2_by_county: Counter[str] = Counter()
        just_missed = 0
        anti_caught = 0

        tier2_samples: list[tuple] = []
        just_missed_samples: list[tuple] = []
        anti_caught_samples: list[tuple] = []

        scanned = 0
        for rec in sf.iterRecords():
            scanned += 1
            owner = _str(rec[idx["OWNNAME"]])
            zoning = _str(rec[idx["ZONING"]])
            iv1 = _to_float(rec[idx["IMPVAL1"]])
            iv2 = _to_float(rec[idx["IMPVAL2"]])
            iv_total = iv1 + iv2
            totval = _to_float(rec[idx["TOTVAL"]])
            mail = _str(rec[idx["MAILADD1"]])
            scity = _str(rec[idx["SCITY"]])
            county = _str(rec[idx["CNTYNAME"]])
            lat = rec[idx["LATDEC"]]
            lon = rec[idx["LONGDEC"]]

            tier, _reason = classify_tier(owner, zoning, iv_total)

            if tier == 1:
                tier1 += 1
                if zoning:
                    z_u = zoning.upper()
                    tier1_zoning_counter[z_u[0] if z_u else ""] += 1
            elif tier == 2:
                tier2 += 1
                tier2_by_county[county.upper()] += 1
                if len(tier2_samples) < 30:
                    tier2_samples.append((owner, scity, county, totval, iv_total, zoning, lat, lon, mail))
            else:
                tier3 += 1

            # Just-missed-Tier-2 records (corp + no anti-pattern + IMPVAL 50-99k).
            if owner and CORP_SUFFIX_RE.search(owner) and not ANTI_PATTERN_RE.search(owner):
                if JUST_MISSED_LO <= iv_total < JUST_MISSED_HI:
                    just_missed += 1
                    if len(just_missed_samples) < 10:
                        just_missed_samples.append((owner, scity, county, totval, iv_total, zoning, lat, lon, mail))

            # Anti-pattern-caught records (corp + IMPVAL >= threshold + anti-pattern).
            if owner and CORP_SUFFIX_RE.search(owner) and iv_total >= IMPVAL_THRESHOLD:
                m = ANTI_PATTERN_RE.search(owner)
                if m:
                    anti_caught += 1
                    if len(anti_caught_samples) < 10:
                        anti_caught_samples.append((owner, scity, county, totval, iv_total, zoning, lat, lon, mail, m.group(0)))

            if scanned % 100_000 == 0:
                print(f"  ... scanned {scanned:,}/{total:,}")

        # ---- 1. Tier counts ----
        print(f"\n{'='*82}")
        print("1. TIER COUNTS")
        print("=" * 82)
        pct1 = 100.0 * tier1 / scanned if scanned else 0
        pct2 = 100.0 * tier2 / scanned if scanned else 0
        pct3 = 100.0 * tier3 / scanned if scanned else 0
        print(f"  Tier 1 (definite — ZONING C/B/I):  {tier1:>8,}  ({pct1:>5.2f}%)")
        print(f"  Tier 2 (likely  — corp + IMPVAL):  {tier2:>8,}  ({pct2:>5.2f}%)")
        print(f"  Tier 3 (skip):                     {tier3:>8,}  ({pct3:>5.2f}%)")
        print(f"  -------------------------------------------")
        print(f"  KEEP (Tier 1+2):                   {tier1+tier2:>8,}  ({pct1+pct2:.2f}%)")
        print(f"\n  Tier 1 by zoning prefix:")
        for letter, cnt in sorted(tier1_zoning_counter.items(), key=lambda kv: -kv[1]):
            label = {"C": "Commercial", "B": "Business/Office", "I": "Industrial"}.get(letter, letter)
            print(f"    {letter}-*  {cnt:>6,}  {label}")
        print(f"\n  Just-missed-Tier-2 (corp + IMPVAL 50k-99k): {just_missed:,}")
        print(f"  Anti-pattern-caught (corp + IMPVAL>=100k + excluded): {anti_caught:,}")

        # ---- 2. Tier 2 by county ----
        print(f"\n{'='*82}")
        print("2. TIER 2 BREAKDOWN BY COUNTY (top 20)")
        print("=" * 82)
        for county, cnt in tier2_by_county.most_common(20):
            pct = 100.0 * cnt / tier2 if tier2 else 0
            print(f"  {cnt:>6,}  ({pct:>5.2f}%)  {county or '(empty)'}")

        # ---- 3. Tier 2 samples ----
        print(f"\n{'='*82}")
        print("3. 30 SAMPLE TIER 2 RECORDS (likely commercial)")
        print("=" * 82)
        cols = ["OWNNAME", "SCITY", "CNTY", "TOTVAL", "IMPVAL", "ZONING", "LAT", "LON", "MAILADD1"]
        widths = [34, 14, 12, 11, 11, 8, 7, 8, 24]
        print(_row(cols, widths))
        print("-" * sum(widths) + "-" * (2 * len(widths) - 2))
        for own, scity, county, totval, iv_total, zoning, lat, lon, mail in tier2_samples:
            print(_row([
                own,
                scity,
                county,
                f"{totval:,.0f}",
                f"{iv_total:,.0f}",
                zoning,
                _fmt_coord(lat),
                _fmt_coord(lon),
                mail,
            ], widths))

        # ---- 4. Just-missed-Tier-2 ----
        print(f"\n{'='*82}")
        print("4. 10 SAMPLE JUST-MISSED-TIER-2 (corp + IMPVAL between $50k–$99k)")
        print("=" * 82)
        print(_row(cols, widths))
        print("-" * sum(widths) + "-" * (2 * len(widths) - 2))
        for own, scity, county, totval, iv_total, zoning, lat, lon, mail in just_missed_samples:
            print(_row([
                own,
                scity,
                county,
                f"{totval:,.0f}",
                f"{iv_total:,.0f}",
                zoning,
                _fmt_coord(lat),
                _fmt_coord(lon),
                mail,
            ], widths))

        # ---- 5. Anti-pattern caught ----
        print(f"\n{'='*82}")
        print("5. 10 SAMPLE ANTI-PATTERN-CAUGHT (corp + IMPVAL>=$100k + excluded)")
        print("=" * 82)
        cols2 = cols + ["MATCHED"]
        widths2 = widths + [12]
        print(_row(cols2, widths2))
        print("-" * sum(widths2) + "-" * (2 * len(widths2) - 2))
        for own, scity, county, totval, iv_total, zoning, lat, lon, mail, matched in anti_caught_samples:
            print(_row([
                own,
                scity,
                county,
                f"{totval:,.0f}",
                f"{iv_total:,.0f}",
                zoning,
                _fmt_coord(lat),
                _fmt_coord(lon),
                mail,
                matched,
            ], widths2))

        print(f"\n{'='*82}")
        print(f"Done {shp_path.name}")
        print("=" * 82)

    finally:
        sf.close()


def _fmt_coord(v) -> str:
    try:
        f = float(v) if v is not None else 0.0
        return f"{f:.4f}" if f != 0 else "—"
    except (TypeError, ValueError):
        return "—"


def main() -> int:
    parser = argparse.ArgumentParser(description="MARIS tier-classification analyzer (read-only)")
    parser.add_argument("shapefile", help="Path to a .shp file")
    args = parser.parse_args()

    shp_path = Path(args.shapefile).expanduser().resolve()
    if not shp_path.exists() or shp_path.suffix.lower() != ".shp":
        print(f"[analyze] invalid path: {shp_path}")
        return 2
    analyze(shp_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
