#!/usr/bin/env python3
"""
EDGAR Exhibit 21 (List of Subsidiaries) scraper for the REIT universe.

For each entity in intel_entities with entity_type='reit' and a CIK, this:
  1. Fetches /submissions/CIK<cik>.json from EDGAR
  2. Finds the most recent EX-21 / EX-21.1 filing (or 10-K + ex21 attachment fallback)
  3. Parses the HTML with BeautifulSoup + regex (no LLM, zero API cost)
  4. Writes the extracted subsidiary list to intel_entities.subsidiary_names

Setup:
    pip install requests supabase python-dotenv beautifulsoup4

Usage:
    python edgar_subsidiaries.py                  # all 200 REITs
    python edgar_subsidiaries.py --ticker=SPG     # one REIT by ticker
    python edgar_subsidiaries.py --cik=0000003499 # one REIT by CIK
    python edgar_subsidiaries.py --resume         # skip already-done UUIDs
    python edgar_subsidiaries.py --reset
    python edgar_subsidiaries.py --max=10         # smoke test
    python edgar_subsidiaries.py --skip-empty     # don't overwrite existing arrays

Compliance:
  - SEC requires a User-Agent identifying the requester.
  - SEC enforces 10 requests/sec rate limit per IP. We sleep 250ms between
    every fetch to stay well under that.
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

from intel_ingest.progress import Progress
from intel_ingest.supabase_io import make_client

ROOT = Path(__file__).parent
PROGRESS_FILE = ROOT / "progress_edgar_subs.json"

SEC_UA = "DillyIntel/1.0 team@dillyos.com"
SEC_RATE_LIMIT_S = 0.25  # 4 req/sec, safely under SEC's 10 req/sec ceiling
HTTP_TIMEOUT = (15, 60)
SUB_NAME_CAP = 200

# A few REITs file Exhibit 21 with these alternate forms / filenames.
EX21_FORMS = ("EX-21", "EX-21.1", "EX-21.2")
EX21_FILENAME_HINTS = ("ex21", "ex-21", "exhibit21", "exhibit-21", "subsidiar")


def _load_env() -> None:
    env = ROOT / ".env.local"
    if env.exists():
        load_dotenv(env)


def sec_get(url: str, accept: str = "application/json") -> requests.Response:
    """Throttled SEC fetch with the right UA. SEC rejects requests without UA."""
    time.sleep(SEC_RATE_LIMIT_S)
    return requests.get(
        url,
        headers={"User-Agent": SEC_UA, "Accept": accept},
        timeout=HTTP_TIMEOUT,
    )


def find_exhibit21_url(cik: str) -> tuple[str | None, str | None]:
    """
    Resolve the most recent EX-21 attachment URL for a CIK. Returns
    (url, filing_date) or (None, None) if none found.

    Strategy: scan /submissions/CIK<cik>.json's `filings.recent` arrays
    for any entry whose form matches EX21_FORMS. If none found, fall
    back to the latest 10-K and parse its filing-index for an ex21
    attachment — many REITs file Exhibit 21 inside the 10-K bundle
    rather than as a standalone form.
    """
    padded = cik.zfill(10)
    res = sec_get(f"https://data.sec.gov/submissions/CIK{padded}.json")
    if not res.ok:
        return None, None
    data = res.json()
    recent = (data.get("filings") or {}).get("recent") or {}
    forms = recent.get("form") or []
    accessions = recent.get("accessionNumber") or []
    primary_docs = recent.get("primaryDocument") or []
    filing_dates = recent.get("filingDate") or []

    cik_int = str(int(cik))

    # Pass 1: standalone EX-21 form
    for i, form in enumerate(forms):
        if form in EX21_FORMS:
            acc_no_dashes = accessions[i].replace("-", "")
            doc = primary_docs[i]
            url = f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_no_dashes}/{doc}"
            return url, filing_dates[i]

    # Pass 2: latest 10-K filing index, look for an ex21 attachment in
    # the bundle's index.json.
    for i, form in enumerate(forms):
        if form != "10-K":
            continue
        acc = accessions[i]
        acc_no_dashes = acc.replace("-", "")
        idx_url = f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_no_dashes}/index.json"
        try:
            idx_res = sec_get(idx_url)
            if not idx_res.ok:
                continue
            idx = idx_res.json()
            items = ((idx.get("directory") or {}).get("item") or [])
            for it in items:
                name = (it.get("name") or "").lower()
                if any(h in name for h in EX21_FILENAME_HINTS) and (
                    name.endswith(".htm") or name.endswith(".html") or name.endswith(".txt")
                ):
                    url = f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_no_dashes}/{it['name']}"
                    return url, filing_dates[i]
        except Exception:  # noqa: BLE001
            continue
        # Stop after the first 10-K — older ones are less interesting
        break

    return None, None


def strip_html(html: str) -> str:
    """Naive HTML-to-text. Public helper retained for any caller that just
    wants the plain-text body of an exhibit."""
    out = re.sub(r"<[^>]+>", " ", html)
    out = out.replace("&nbsp;", " ").replace("&amp;", "&")
    out = re.sub(r"&#\d+;", " ", out)
    out = re.sub(r"\s+", " ", out)
    return out.strip()


# ─────────────────────────────────────────────────────────────────────
# Pure-Python Exhibit 21 parser. Replaces the previous Claude Sonnet
# extractor: zero API cost, ~50× faster, deterministic, and not capped
# by the LLM context window (large filings like AMT/O have 200KB+ that
# the previous 8KB prompt window couldn't see).
# ─────────────────────────────────────────────────────────────────────

# Words that mark a line as an entity name. If none match, the line is
# probably a heading, page number, or jurisdiction label.
ENTITY_SUFFIX_RE = re.compile(
    r"\b("
    r"L\.?\s*L\.?\s*C\.?|"
    r"L\.?\s*L\.?\s*P\.?|"
    r"L\.?\s*P\.?|"
    r"Inc(?:\.|orporated)?|"
    r"Corp(?:\.|oration)?|"
    r"Company|Co\.(?!\w)|"
    r"Trust|REIT|"
    r"Ltd\.?|Limited|"
    r"Partnership|Group|"
    r"Holdings|Properties|Property|Realty|"
    r"Bank|Bancorp|"
    r"PLLC|P\.?C\.?|P\.?A\.?|"
    r"Association|Assoc\.?"
    r")\b",
    re.IGNORECASE,
)
# "Acme LLC (Delaware)" → strip the trailing parens
JURIS_PARENS_RE = re.compile(r"\s*\([^)]{1,80}\)\s*$")
# "Acme LLC, a Delaware limited partnership" → strip from ", a " onward
JURIS_TAIL_RE = re.compile(r",\s*an?\s+.*$", re.IGNORECASE)
# "1.  Acme LLC" → strip leading enumeration
LEADING_NUM_RE = re.compile(r"^\s*\d+[\.\)]\s*")
# Trailing whitespace + punctuation
TRAIL_PUNCT_RE = re.compile(r"[\s,;:]+$")
WHITESPACE_RE = re.compile(r"\s+")
# Prologis-style prose annotations:
# "Acme LLC and one hundred ten foreign subsidiaries"  → "Acme LLC"
# "Acme LP and its fifty-two domestic subsidiaries..." → "Acme LP"
AND_SUBS_RE = re.compile(
    r"\s+and\s+(?:its\s+)?"
    r"(?:[a-z\-]+\s+){0,4}"
    r"(?:domestic\s+|foreign\s+)?"
    r"subsidiar(?:y|ies)\b.*$",
    re.IGNORECASE,
)


def clean_subsidiary_name(raw: str | None) -> str | None:
    """Strip jurisdiction language, normalize whitespace, filter
    non-entity lines. Returns None to drop the candidate."""
    if not raw:
        return None
    # Normalize nbsp / em-space / thin-space to plain space
    s = raw.replace(" ", " ").replace(" ", " ").replace(" ", " ")
    s = WHITESPACE_RE.sub(" ", s).strip()
    if not s:
        return None
    s = LEADING_NUM_RE.sub("", s)
    s = JURIS_PARENS_RE.sub("", s)
    s = JURIS_TAIL_RE.sub("", s)
    s = AND_SUBS_RE.sub("", s)
    s = TRAIL_PUNCT_RE.sub("", s).strip()
    s = WHITESPACE_RE.sub(" ", s)
    if len(s) < 3:
        return None
    if not ENTITY_SUFFIX_RE.search(s):
        return None
    return s


def extract_subsidiaries(html: str) -> list[str]:
    """
    Parse subsidiary names from a SEC Exhibit 21 HTML document.

    Strategy:
      1. Try table-cell extraction first — most Exhibit 21s are tabular,
         column 1 is the entity name, column 2 is the jurisdiction.
      2. Fall back to a line-by-line scan when tables yield <3 hits
         (Prologis and a few others use prose lists instead of tables).
      3. Clean each candidate via clean_subsidiary_name.
      4. Dedupe case-insensitively, cap at SUB_NAME_CAP.
    """
    if not html or len(html) < 50:
        return []
    soup = BeautifulSoup(html, "html.parser")

    candidates: list[str] = []
    for table in soup.find_all("table"):
        for tr in table.find_all("tr"):
            cells = tr.find_all(["td", "th"])
            if not cells:
                continue
            text = cells[0].get_text(separator=" ", strip=True)
            cleaned = clean_subsidiary_name(text)
            if cleaned:
                candidates.append(cleaned)

    if len(candidates) < 3:
        for line in soup.get_text(separator="\n", strip=True).splitlines():
            cleaned = clean_subsidiary_name(line)
            if cleaned:
                candidates.append(cleaned)

    seen: set[str] = set()
    out: list[str] = []
    for n in candidates:
        key = n.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(n)
        if len(out) >= SUB_NAME_CAP:
            break
    return out


def fetch_target_reits(db, args: argparse.Namespace) -> list[dict]:
    """Pull the REIT entity universe filtered per CLI args."""
    q = (
        db.table("intel_entities")
        .select("id, name, ticker, cik, subsidiary_names")
        .eq("entity_type", "reit")
        .not_.is_("cik", "null")
        .order("name", desc=False)
    )
    if args.cik:
        q = q.eq("cik", args.cik)
    elif args.ticker:
        q = q.eq("ticker", args.ticker.upper())
    res = q.execute()
    rows = res.data or []
    if args.skip_empty:
        # In this mode we only refresh entities that already have a list
        # (e.g. to repair partials). Default behavior is the opposite —
        # refresh anything that's missing.
        rows = [r for r in rows if (r.get("subsidiary_names") or [])]
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="EDGAR Exhibit 21 scraper")
    parser.add_argument("--cik", type=str, default=None)
    parser.add_argument("--ticker", type=str, default=None)
    parser.add_argument("--max", type=int, default=0,
                        help="cap REITs scanned (smoke test)")
    parser.add_argument("--resume", action="store_true",
                        help="skip entities listed in progress.done")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--skip-empty", action="store_true",
                        help="only refresh entities with non-empty subs (repair mode)")
    parser.add_argument("--dry-run", action="store_true",
                        help="don't write to Supabase; print result instead")
    args = parser.parse_args()

    _load_env()
    progress = Progress(PROGRESS_FILE)
    if args.reset:
        progress.reset()
        print("[edgar-subs] progress reset.")
        return 0

    db = make_client()

    targets = fetch_target_reits(db, args)
    if args.max and args.max > 0:
        targets = targets[:args.max]

    progress.setdefault("done", [])
    done_ids = set(progress["done"])
    if args.resume:
        targets = [t for t in targets if t["id"] not in done_ids]

    print(f"[edgar-subs] processing {len(targets)} REIT(s)")
    print(f"[edgar-subs] dry_run={args.dry_run}  resume_skipped={'on' if args.resume else 'off'}")

    succ = 0
    nofile = 0
    failed = 0
    total_subs = 0

    for i, ent in enumerate(targets):
        cik = ent.get("cik") or ""
        name = ent.get("name") or "?"
        ticker = ent.get("ticker") or "-"

        try:
            url, filing_date = find_exhibit21_url(cik)
        except requests.RequestException as e:
            print(f"[edgar-subs] {i+1}/{len(targets)} {ticker} {name}: SEC err: {e}")
            failed += 1
            continue

        if not url:
            print(f"[edgar-subs] {i+1}/{len(targets)} {ticker} {name}: no EX-21 found")
            nofile += 1
            # Mark done so we don't retry this every run.
            progress["done"] = list(done_ids | {ent["id"]})
            done_ids.add(ent["id"])
            progress.save()
            continue

        try:
            html_res = sec_get(url, accept="text/html")
            if not html_res.ok:
                raise requests.RequestException(f"HTTP {html_res.status_code}")
        except requests.RequestException as e:
            print(f"[edgar-subs] {i+1}/{len(targets)} {ticker} {name}: download err: {e}")
            failed += 1
            continue

        # Pure-Python parser — no LLM, no API costs, no transient failures.
        subs = extract_subsidiaries(html_res.text)

        total_subs += len(subs)

        if args.dry_run:
            print(f"[edgar-subs] {i+1}/{len(targets)} {ticker} {name}: would write {len(subs)} subs (dry run)")
            if subs:
                print(f"    sample: {subs[:3]}")
        else:
            try:
                db.table("intel_entities").update({
                    "subsidiary_names": subs,
                    "last_verified_at": "now()",
                }).eq("id", ent["id"]).execute()
                print(f"[edgar-subs] {i+1}/{len(targets)} {ticker} {name}: wrote {len(subs)} subs (filing {filing_date})")
                succ += 1
            except Exception as e:  # noqa: BLE001
                print(f"[edgar-subs] {i+1}/{len(targets)} {ticker} {name}: db err: {e}")
                failed += 1
                continue

        progress["done"] = list(done_ids | {ent["id"]})
        done_ids.add(ent["id"])
        progress["records_processed"] = succ
        progress.save()

    print()
    print(f"[edgar-subs] DONE - {succ} ok, {nofile} no-EX21, {failed} failed, "
          f"{total_subs} total subsidiary names extracted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
