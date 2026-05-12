#!/usr/bin/env python3
"""
Backfill canonical legal names on intel_entities from EDGAR submissions.

For every entity with a CIK, this script:
  1. GETs https://data.sec.gov/submissions/CIK<padded>.json
  2. Reads the `name` field (the current SEC-registered legal name)
  3. Updates intel_entities.name = that
  4. Preserves the old display name + ticker as synonyms inside
     subsidiary_names so the resolver's tier-3 lookup keeps matching
     property rows that referenced the previous name (e.g. "SPG" /
     "Simon Property Group, Inc." both still resolve)

Run entity_resolver.py --reset afterwards so the resolver re-indexes
against the new names.

Setup:
    pip install requests supabase python-dotenv

Usage:
    python fix_entity_names.py --dry-run --max=5    # preview 5 changes
    python fix_entity_names.py --dry-run            # preview all
    python fix_entity_names.py --ticker=SPG         # one entity
    python fix_entity_names.py                      # full run
    python fix_entity_names.py --resume             # continue after interruption
    python fix_entity_names.py --reset              # clear progress

Compliance:
  - SEC requires a User-Agent identifying the requester.
  - SEC enforces 10 req/sec per IP. We sleep 250ms between fetches.
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

from intel_ingest.progress import Progress
from intel_ingest.supabase_io import make_client

ROOT = Path(__file__).parent
PROGRESS_FILE = ROOT / "progress_entity_names.json"

SEC_UA = "DillyIntel/1.0 team@dillyos.com"
SEC_RATE_LIMIT_S = 0.25
HTTP_TIMEOUT = (15, 60)


# Tokens kept uppercase when title-casing an EDGAR name. EDGAR ships most
# names in ALL CAPS ("APARTMENT INVESTMENT & MANAGEMENT CO"); .title()
# alone produces "Apartment Investment & Management Co" but ruins
# acronyms ("PROLOGIS LP" -> "Prologis Lp"). Roman numerals II-X are
# included since legal entity names commonly use them ("Apollo Trust II").
PRESERVE_UPPERCASE: set[str] = {
    "LLC", "LP", "REIT", "INC", "CORP", "USA", "LTD",
    "CO", "NNN", "ETF", "NYSE", "NASDAQ",
    "CEO", "CFO", "COO",
    "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
}

# Word-boundary splitter that keeps the delimiter so we can rejoin
# without losing punctuation/whitespace ("INC." -> ["INC", ".", ""]).
_TOKEN_SPLIT_RE = re.compile(r"(\W+)")


def smart_title_case(s: str, ticker: str | None = None) -> str:
    """
    Title-case a name while keeping known acronyms (LLC, REIT, etc.),
    Roman numerals, and the entity's own ticker uppercase. Idempotent —
    safe to run on already-clean inputs ("Prologis, Inc." stays
    "Prologis, Inc.").

    Why ticker preservation: EDGAR canonical names like "AGNC INVESTMENT
    CORP" or "AKR REIT INC" embed the brand acronym as the leading
    word. Without this, `.capitalize()` would mangle them ("Agnc
    Investment CORP", "Akr REIT INC"). Passing the entity's ticker keeps
    "AGNC" and "AKR" uppercase while still title-casing the rest.
    """
    if not s:
        return s
    extra = {ticker.upper()} if ticker and ticker.strip() else set()
    parts = _TOKEN_SPLIT_RE.split(s)
    out: list[str] = []
    for p in parts:
        if not p:
            continue
        # Punctuation / whitespace token — pass through unchanged.
        if not p[0].isalnum():
            out.append(p)
            continue
        upper = p.upper()
        if upper in PRESERVE_UPPERCASE or upper in extra:
            out.append(upper)
        else:
            out.append(p.capitalize())
    return "".join(out)


def _load_env() -> None:
    env = ROOT / ".env.local"
    if env.exists():
        load_dotenv(env)


def fetch_edgar_name(cik: str) -> tuple[str | None, list[str]]:
    """
    Returns (canonical_name, former_names). The submissions endpoint
    exposes both the current `name` and a `formerNames` list — we treat
    every former name as another synonym worth preserving in
    subsidiary_names for the resolver's tier-3 lookups.
    """
    padded = str(cik).zfill(10)
    time.sleep(SEC_RATE_LIMIT_S)
    res = requests.get(
        f"https://data.sec.gov/submissions/CIK{padded}.json",
        headers={"User-Agent": SEC_UA, "Accept": "application/json"},
        timeout=HTTP_TIMEOUT,
    )
    if not res.ok:
        return None, []
    data = res.json()
    name = (data.get("name") or "").strip() or None
    former_raw = data.get("formerNames") or []
    former_names = [
        (item.get("name") or "").strip()
        for item in former_raw
        if isinstance(item, dict)
    ]
    former_names = [n for n in former_names if n]
    return name, former_names


def merge_synonyms(
    *,
    existing: list[str] | None,
    canonical: str,
    old_name: str | None,
    ticker: str | None,
    former_names: list[str],
) -> list[str]:
    """
    Build the new subsidiary_names array. Drops the canonical name (it's
    on `name` already), keeps the old display name, ticker, EDGAR former
    names, and whatever was in subsidiary_names previously. Case-insensitive
    dedup, preserves the first-seen casing.
    """
    candidates: list[str] = []
    if old_name and old_name.strip():
        candidates.append(old_name.strip())
    if ticker and ticker.strip():
        candidates.append(ticker.strip())
    candidates.extend(n.strip() for n in former_names if n and n.strip())
    candidates.extend(
        s.strip() for s in (existing or []) if isinstance(s, str) and s.strip()
    )

    seen: set[str] = {canonical.strip().lower()} if canonical else set()
    out: list[str] = []
    for c in candidates:
        key = c.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def fetch_targets(db, args: argparse.Namespace) -> list[dict]:
    q = (
        db.table("intel_entities")
        .select("id, name, ticker, cik, subsidiary_names")
        .not_.is_("cik", "null")
        .order("name", desc=False)
    )
    if args.ticker:
        q = q.eq("ticker", args.ticker.upper())
    elif args.cik:
        q = q.eq("cik", args.cik)
    res = q.execute()
    return res.data or []


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill canonical names from EDGAR")
    parser.add_argument("--ticker", type=str, default=None,
                        help="run for a single entity by ticker (e.g. SPG)")
    parser.add_argument("--cik", type=str, default=None,
                        help="run for a single entity by CIK")
    parser.add_argument("--max", type=int, default=0,
                        help="cap entities processed (smoke test)")
    parser.add_argument("--resume", action="store_true",
                        help="skip entities already marked done in progress file")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--dry-run", action="store_true",
                        help="don't write to Supabase; print intended changes")
    args = parser.parse_args()

    _load_env()
    progress = Progress(PROGRESS_FILE)
    if args.reset:
        progress.reset()
        print("[fix-names] progress reset.")
        return 0

    db = make_client()

    targets = fetch_targets(db, args)
    if args.max and args.max > 0:
        targets = targets[:args.max]

    progress.setdefault("done", [])
    done_ids = set(progress["done"])
    if args.resume:
        targets = [t for t in targets if t["id"] not in done_ids]

    print(f"[fix-names] processing {len(targets)} entit{'y' if len(targets) == 1 else 'ies'}")
    print(f"[fix-names] dry_run={args.dry_run}  resume_skipped={'on' if args.resume else 'off'}")

    succ = 0
    no_change = 0
    failed = 0
    no_edgar = 0

    for i, ent in enumerate(targets, 1):
        cik = ent.get("cik") or ""
        old_name = (ent.get("name") or "").strip()
        ticker = (ent.get("ticker") or "").strip() or None
        existing_subs = ent.get("subsidiary_names") or []

        try:
            canonical_raw, former_names = fetch_edgar_name(cik)
        except requests.RequestException as e:
            print(f"[fix-names] {i}/{len(targets)} {ticker or '-'} {old_name}: SEC err: {e}")
            failed += 1
            continue

        # EDGAR returns most names in ALL CAPS — pretty them up while
        # keeping acronyms (LLC, REIT, INC, etc.) and the ticker intact.
        canonical = smart_title_case(canonical_raw, ticker) if canonical_raw else None
        former_names = [smart_title_case(n, ticker) for n in former_names]

        if not canonical:
            print(f"[fix-names] {i}/{len(targets)} {ticker or '-'} {old_name}: no name in EDGAR submissions for CIK={cik}")
            no_edgar += 1
            progress["done"] = list(done_ids | {ent["id"]})
            done_ids.add(ent["id"])
            progress.save()
            continue

        if canonical == old_name:
            # Still merge ticker/former names into subsidiary_names if not
            # already present — that's the part the resolver needs.
            new_subs = merge_synonyms(
                existing=existing_subs,
                canonical=canonical,
                old_name=None,  # already on .name
                ticker=ticker,
                former_names=former_names,
            )
            if set(s.lower() for s in new_subs) == set(s.lower() for s in existing_subs):
                no_change += 1
                print(f"[fix-names] {i}/{len(targets)} {ticker or '-'} {old_name}: already canonical, no synonym change")
                progress["done"] = list(done_ids | {ent["id"]})
                done_ids.add(ent["id"])
                progress.save()
                continue
            update_payload = {"subsidiary_names": new_subs}
            change_summary = f"+{len(new_subs) - len(existing_subs)} synonym(s)"
        else:
            new_subs = merge_synonyms(
                existing=existing_subs,
                canonical=canonical,
                old_name=old_name,
                ticker=ticker,
                former_names=former_names,
            )
            update_payload = {"name": canonical, "subsidiary_names": new_subs}
            change_summary = f"name: {old_name!r} -> {canonical!r} (+{len(new_subs) - len(existing_subs)} synonym(s))"

        if args.dry_run:
            print(f"[fix-names] {i}/{len(targets)} {ticker or '-'}: WOULD UPDATE - {change_summary}")
            succ += 1
            continue

        try:
            db.table("intel_entities").update(update_payload).eq("id", ent["id"]).execute()
            print(f"[fix-names] {i}/{len(targets)} {ticker or '-'}: {change_summary}")
            succ += 1
        except Exception as e:  # noqa: BLE001
            print(f"[fix-names] {i}/{len(targets)} {ticker or '-'} {old_name}: db err: {e}")
            failed += 1
            continue

        progress["done"] = list(done_ids | {ent["id"]})
        done_ids.add(ent["id"])
        progress["records_processed"] = succ
        progress.save()

    print()
    print(
        f"[fix-names] DONE - {succ} updated, {no_change} unchanged, "
        f"{no_edgar} no-EDGAR-name, {failed} failed"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
