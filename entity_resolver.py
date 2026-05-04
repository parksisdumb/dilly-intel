#!/usr/bin/env python3
"""
Bulk entity re-resolution against intel_properties.

Mirrors src/lib/intel/proptracer/entity-resolver.ts as a standalone
Python batch job. Scans all rows where enrichment_status = 'unmatched',
runs the 3-tier matcher (exact -> normalized -> subsidiary), and writes
back entity_id + new status when matched.

Tier 1: exact case-insensitive match against intel_entities.name
Tier 2: normalized form (LLC/LP/INC/etc stripped, punctuation removed)
Tier 3: subsidiary match — same normalization against any string in
        intel_entities.subsidiary_names (the array we just populated
        with edgar_subsidiaries.py)

Setup:
    pip install requests supabase python-dotenv

Usage:
    python entity_resolver.py                # full re-run
    python entity_resolver.py --max=5000     # smoke test
    python entity_resolver.py --resume       # continue from cursor
    python entity_resolver.py --reset
    python entity_resolver.py --dry-run      # don't write, just count
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from intel_ingest.progress import Progress
from intel_ingest.supabase_io import make_client

ROOT = Path(__file__).parent
PROGRESS_FILE = ROOT / "progress_resolver.json"

BATCH_SIZE = 1000
LOG_INTERVAL = 5_000
UPDATE_WORKERS = 20  # parallel UPDATEs per batch — Supabase tolerates this


# Suffix-stripping regex — keep in sync with TS resolver.
_NORMALIZE_SUFFIX_RE = re.compile(
    r",?\s+("
    r"llc|l\.l\.c\.|"
    r"lp|l\.p\.|"
    r"llp|l\.l\.p\.|"
    r"inc|incorporated|"
    r"corp|corporation|"
    r"co|company|"
    r"trust|reit|"
    r"holdings|properties|property|realty|"
    r"ltd|limited|"
    r"pllc|pc|pa|"
    r"association|assoc"
    r")\.?$",
    re.IGNORECASE,
)
_PUNCT_RE = re.compile(r"[.,'\"]")
_WS_RE = re.compile(r"\s+")


def normalize_owner_name(name: str) -> str:
    if not name:
        return ""
    s = name.lower()
    s = _NORMALIZE_SUFFIX_RE.sub("", s)
    s = _PUNCT_RE.sub("", s)
    s = _WS_RE.sub(" ", s)
    return s.strip()


class EntityIndex:
    """Three-tier in-memory lookup index."""
    __slots__ = ("exact", "normalized", "subsidiary", "size")

    def __init__(self) -> None:
        self.exact: dict[str, str] = {}        # lowercase name -> entity_id
        self.normalized: dict[str, str] = {}   # normalized name -> entity_id
        self.subsidiary: dict[str, str] = {}   # normalized sub name -> entity_id
        self.size = 0


def build_entity_index(db) -> EntityIndex:
    """Page through all entities and build the index."""
    idx = EntityIndex()
    page_size = 1000
    offset = 0
    while True:
        res = (
            db.table("intel_entities")
            .select("id, name, subsidiary_names")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = res.data or []
        if not rows:
            break
        for r in rows:
            name = r.get("name")
            ent_id = r.get("id")
            if not name or not ent_id:
                continue
            lower = name.lower().strip()
            norm = normalize_owner_name(name)
            if lower and lower not in idx.exact:
                idx.exact[lower] = ent_id
            if norm and norm not in idx.normalized:
                idx.normalized[norm] = ent_id
            for sub in (r.get("subsidiary_names") or []):
                if not isinstance(sub, str):
                    continue
                s_norm = normalize_owner_name(sub)
                if s_norm and s_norm not in idx.subsidiary:
                    idx.subsidiary[s_norm] = ent_id
            idx.size += 1
        if len(rows) < page_size:
            break
        offset += page_size
    return idx


def resolve(name: str, idx: EntityIndex) -> tuple[str | None, int, str]:
    """Returns (entity_id_or_None, level, status)."""
    if not name:
        return None, 0, "unmatched"
    key = name.strip()
    if not key:
        return None, 0, "unmatched"

    lower = key.lower()
    e1 = idx.exact.get(lower)
    if e1:
        return e1, 1, "matched"

    norm = normalize_owner_name(key)
    if norm:
        e2 = idx.normalized.get(norm)
        if e2:
            return e2, 2, "fuzzy_matched"
        e3 = idx.subsidiary.get(norm)
        if e3:
            return e3, 3, "subsidiary_matched"

    return None, 0, "unmatched"


def update_one(db, row_id: str, entity_id: str, level: int, status: str) -> bool:
    try:
        db.table("intel_properties").update({
            "entity_id": entity_id,
            "enrichment_status": status,
            "enrichment_level": level,
        }).eq("id", row_id).execute()
        return True
    except Exception:  # noqa: BLE001
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Bulk entity resolver")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--max", type=int, default=0,
                        help="cap rows scanned (smoke test)")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--dry-run", action="store_true",
                        help="don't write updates; just count what would match")
    args = parser.parse_args()

    progress = Progress(PROGRESS_FILE)
    if args.reset:
        progress.reset()
        print("[resolver] progress reset.")
        return 0

    db = make_client()

    print("[resolver] building entity index...")
    t0 = time.time()
    idx = build_entity_index(db)
    print(
        f"[resolver] index built in {time.time()-t0:.1f}s: "
        f"{idx.size:,} entities, {len(idx.exact):,} exact, "
        f"{len(idx.normalized):,} normalized, {len(idx.subsidiary):,} subsidiary"
    )

    cursor = progress.get("last_id") if args.resume else None
    if args.resume and cursor:
        print(f"[resolver] resume from cursor {cursor}")
    else:
        progress["last_id"] = None
        progress.save()

    seen = 0
    matched_l1 = 0
    matched_l2 = 0
    matched_l3 = 0
    update_failed = 0

    while True:
        if args.max and seen >= args.max:
            print(f"[resolver] hit --max={args.max}")
            break

        res = db.rpc("intel_resolver_pending", {
            "p_cursor_id": cursor,
            "p_batch_size": args.batch_size,
        }).execute()
        rows = res.data or []
        if not rows:
            print("[resolver] no more pending rows")
            break

        # Resolve in-memory first, collect updates to apply in parallel.
        updates: list[tuple[str, str, int, str]] = []  # (row_id, entity_id, level, status)
        for r in rows:
            seen += 1
            ent_id, level, status = resolve(r.get("raw_owner_name") or "", idx)
            if ent_id:
                if level == 1: matched_l1 += 1
                elif level == 2: matched_l2 += 1
                elif level == 3: matched_l3 += 1
                updates.append((r["id"], ent_id, level, status))

        # Apply updates in parallel
        if updates and not args.dry_run:
            with ThreadPoolExecutor(max_workers=UPDATE_WORKERS) as ex:
                results = list(ex.map(
                    lambda u: update_one(db, *u),
                    updates,
                ))
            update_failed += sum(1 for ok in results if not ok)

        cursor = rows[-1]["id"]
        progress["last_id"] = cursor
        progress["records_processed"] = matched_l1 + matched_l2 + matched_l3
        progress.save()

        if seen % LOG_INTERVAL == 0 or len(rows) < args.batch_size:
            total_match = matched_l1 + matched_l2 + matched_l3
            pct = 100.0 * total_match / seen if seen else 0.0
            print(
                f"[resolver] seen={seen:,} matched={total_match:,} ({pct:.1f}%) "
                f"L1={matched_l1:,} L2={matched_l2:,} L3={matched_l3:,} "
                f"failed_writes={update_failed}"
            )

    total_match = matched_l1 + matched_l2 + matched_l3
    pct = 100.0 * total_match / seen if seen else 0.0
    print(
        f"\n[resolver] DONE - seen={seen:,} matched={total_match:,} ({pct:.1f}%) "
        f"L1={matched_l1:,} L2={matched_l2:,} L3={matched_l3:,} "
        f"failed_writes={update_failed}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
