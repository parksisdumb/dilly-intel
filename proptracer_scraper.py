#!/usr/bin/env python3
"""
PropTracer scraper — async, fast, bulletproof.

Pulls all commercial properties (by property_use_code) for a state, metro,
or all of US into Supabase intel_properties. Sequential outer loop over
zip codes; aggressive parallelism within each zip via aiohttp semaphores.

Setup:
    pip install aiohttp supabase python-dotenv

Usage:
    python proptracer_scraper.py --state=TN          # all TN zips
    python proptracer_scraper.py --metro=memphis     # Memphis metro
    python proptracer_scraper.py --national          # all US zips
    python proptracer_scraper.py --zip=38138         # single zip smoke test
    python proptracer_scraper.py --reset             # clear progress.json

Auto-restarts after 30s on any unexpected crash. JWT expiration halts.
Failed zips logged to progress.json under "failed_zips" so they can be
retried with a future run after fixing whatever broke.

Data files:
    tn_zips.json  — 631 TN zips with accurate Census ZCTA bboxes
    us_zips.json  — 42,183 US zips, synthesized 0.05° bboxes from centroids
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp
from dotenv import load_dotenv
from supabase import Client, create_client

# ─────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────

ENV_PATH = Path(__file__).parent / ".env.local"
PROGRESS_FILE = Path(__file__).parent / "progress.json"
TN_ZIPS_FILE = Path(__file__).parent / "tn_zips.json"
US_ZIPS_FILE = Path(__file__).parent / "us_zips.json"

MAPPING_URL = "https://api.proptracer.com/v1/property/mapping"
DETAIL_URL = "https://api.proptracer.com/v1/property/details"

BUILDING_SIZE_MIN = 1501
PAGE_LIMIT = 350
MAX_RECURSION_DEPTH = 12
SOURCE_DETAIL = "proptracer_mapping"

# Concurrency knobs (CLI --workers overrides DETAIL_WORKERS_NORMAL).
DETAIL_WORKERS_NORMAL = 200    # parallel detail fetches per batch
MAPPING_WORKERS = 10           # parallel mapping calls during recursive subdivision
BATCH_SLEEP_NORMAL = 0.05      # 50ms between detail batches
BATCH_SLEEP_BACKOFF = 0.20     # 200ms after a 429
TCP_CONNECTOR_LIMIT = 500      # aiohttp connection pool size

def _backoff_workers(normal: int) -> int:
    """On 429, drop to half (min 25)."""
    return max(25, normal // 2)

# Failure handling
DB_UPSERT_RETRIES = 1
HTTP_RETRY_SLEEP = 1.0       # base sleep between transient HTTP retries
HTTP_MAX_RETRIES = 3
RESTART_DELAY_SECONDS = 30
HTTP_TIMEOUT_SECONDS = 60

# Commercial property use codes (offices, retail, industrial, multifamily 5+,
# healthcare, hospitality, self-storage, religious, educational, etc.)
PROPERTY_USE_CODES: list[int] = [
    357, 358, 359, 360, 361, 368, 370, 135, 136, 139, 140, 169, 170, 171, 176,
    177, 184, 295, 301, 150, 3013, 3015, 124, 125, 128, 129, 137, 141, 143, 144,
    145, 146, 148, 151, 158, 167, 178, 179, 180, 183, 185, 186, 188, 189, 190,
    194, 2013, 307, 459, 464, 127, 147, 149, 173, 2062, 2063, 2065, 2066, 2067,
    2068, 2069, 2070, 2071, 195, 196, 197, 198, 199, 202, 203, 205, 206, 207,
    208, 210, 211, 212, 213, 215, 216, 217, 218, 219, 220, 221, 224, 225, 226,
    227, 228, 229, 230, 231, 232, 234, 235, 236, 237, 238, 239, 240, 280, 161,
    130, 6003, 5021, 5022, 126, 142, 157, 192, 193, 296, 312, 133, 156, 191,
    412, 433, 458, 131, 153, 154, 155, 163, 132, 260, 293, 316, 327, 348, 410,
    259, 261, 263, 264, 267, 279, 290, 292, 332, 334, 343, 346, 4033, 4034, 175,
    328, 342, 352, 274, 3014, 152, 302, 320, 321, 339, 1115, 258, 277, 278, 283,
    310, 314, 325, 272, 276, 329, 340, 347, 353, 451, 269, 270, 271, 275, 336,
    308,
]

# Priority states: --priority runs them in this order (TN first because we
# have higher-accuracy Census ZCTA bboxes for it).
PRIORITY_STATES: list[str] = [
    "TN", "TX", "FL", "GA", "AL", "MS", "LA", "AR", "SC", "NC", "KY", "VA",
]

# Metro definitions: zip filter is by city + state
METROS: dict[str, dict[str, Any]] = {
    "memphis": {
        "states": {"TN", "MS", "AR"},
        "cities": {
            "memphis", "germantown", "collierville", "bartlett", "cordova",
            "lakeland", "arlington", "millington", "olive branch", "southaven",
            "horn lake", "walls", "hernando", "west memphis", "marion",
        },
    },
    "nashville": {
        "states": {"TN"},
        "cities": {
            "nashville", "franklin", "brentwood", "hendersonville", "goodlettsville",
            "gallatin", "mount juliet", "lebanon", "antioch", "madison",
            "old hickory", "donelson", "whites creek",
        },
    },
}

# ─────────────────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────────────────


class JwtExpiredError(Exception):
    """Halts the run — operator must update PROPTRACER_JWT."""


# ─────────────────────────────────────────────────────────────────────────
# Throttle state — single instance, mutated on 429
# ─────────────────────────────────────────────────────────────────────────


class Throttle:
    def __init__(self, normal_workers: int = DETAIL_WORKERS_NORMAL) -> None:
        self.normal_workers = normal_workers
        self.backoff_workers = _backoff_workers(normal_workers)
        self.batch_sleep = BATCH_SLEEP_NORMAL
        self.detail_workers = normal_workers
        self.detail_sem = asyncio.Semaphore(normal_workers)
        self.mapping_sem = asyncio.Semaphore(MAPPING_WORKERS)
        self.in_backoff = False

    def back_off(self) -> None:
        if self.in_backoff:
            return
        self.in_backoff = True
        self.batch_sleep = BATCH_SLEEP_BACKOFF
        self.detail_workers = self.backoff_workers
        # Replace semaphore so new acquisitions use the smaller pool.
        # Old in-flight tasks naturally drain via the previous semaphore.
        self.detail_sem = asyncio.Semaphore(self.backoff_workers)
        print(
            f"⚠ 429 — backing off from {self.normal_workers} to {self.backoff_workers} workers, "
            f"{int(BATCH_SLEEP_BACKOFF * 1000)}ms between batches"
        )


# ─────────────────────────────────────────────────────────────────────────
# Zip data
# ─────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ZipCode:
    zip: str
    city: str
    state: str
    min_lat: float
    max_lat: float
    min_lon: float
    max_lon: float
    is_po_box: bool = False


# Runtime safety: if a zip's bbox span is smaller than this in either dimension,
# treat it as a likely PO Box (single-building footprint) and skip.
MIN_BBOX_SPAN_DEGREES = 0.01


def _load_zip_file(path: Path, default_state: str = "") -> list[ZipCode]:
    if not path.exists():
        raise FileNotFoundError(f"Missing {path.name}")
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: list[ZipCode] = []
    for r in raw:
        out.append(ZipCode(
            zip=str(r["zip"]),
            city=r.get("city", ""),
            state=(r.get("state") or default_state or "").upper(),
            min_lat=float(r["minLat"]),
            max_lat=float(r["maxLat"]),
            min_lon=float(r["minLon"]),
            max_lon=float(r["maxLon"]),
            is_po_box=bool(r.get("is_po_box", False)),
        ))
    return out


def _filter_po_box(zips: list[ZipCode]) -> tuple[list[ZipCode], int]:
    """Strip is_po_box=True entries. Returns (filtered, dropped_count)."""
    kept = [z for z in zips if not z.is_po_box]
    return kept, len(zips) - len(kept)


def load_zips_for_scope(args: argparse.Namespace) -> tuple[list[ZipCode], int]:
    """Pick the right zip data file + filter for the scope flag passed in.
    Returns (zips_to_run, po_box_skipped_count). PO Box zips are skipped
    everywhere EXCEPT when --zip is used (smoke testing a specific zip)."""
    # --zip: explicit single zip — return it whether PO Box or not so user
    # can debug specific cases.
    if args.zip:
        target = args.zip.strip()
        try:
            tn = _load_zip_file(TN_ZIPS_FILE, default_state="TN")
            for z in tn:
                if z.zip == target:
                    return [z], 0
        except FileNotFoundError:
            pass
        us = _load_zip_file(US_ZIPS_FILE)
        for z in us:
            if z.zip == target:
                return [z], 0
        return [], 0

    # --state=TN uses the higher-accuracy Census-derived TN file; everything
    # else (other states, metros, national) uses us_zips.json.
    if args.state and args.state.upper() == "TN":
        zips = _load_zip_file(TN_ZIPS_FILE, default_state="TN")
        return _filter_po_box(zips)

    us = _load_zip_file(US_ZIPS_FILE)

    if args.state:
        s = args.state.upper()
        return _filter_po_box([z for z in us if z.state == s])

    if args.metro:
        key = args.metro.lower()
        if key not in METROS:
            raise ValueError(f"Unknown metro '{key}'. Known: {sorted(METROS)}")
        cfg = METROS[key]
        states: set[str] = cfg["states"]
        cities: set[str] = {c.lower() for c in cfg["cities"]}
        return _filter_po_box([
            z for z in us
            if z.state in states and z.city.lower() in cities
        ])

    if args.priority:
        # Iterate PRIORITY_STATES in order. TN uses the higher-accuracy Census
        # ZCTA file; other states use us_zips.json.
        try:
            tn = _load_zip_file(TN_ZIPS_FILE, default_state="TN")
        except FileNotFoundError:
            tn = []
        out: list[ZipCode] = []
        total_dropped = 0
        for state in PRIORITY_STATES:
            if state == "TN" and tn:
                kept, dropped = _filter_po_box(tn)
            else:
                kept, dropped = _filter_po_box([z for z in us if z.state == state])
            out.extend(kept)
            total_dropped += dropped
        return out, total_dropped

    if args.national:
        return _filter_po_box(us)

    raise ValueError("must pass --state, --metro, --national, --priority, or --zip")


# ─────────────────────────────────────────────────────────────────────────
# Entity resolver
# ─────────────────────────────────────────────────────────────────────────


_SUFFIX_PATTERN = re.compile(
    r",?\s+(llc|l\.l\.c\.|lp|l\.p\.|llp|inc|incorporated|corp|corporation|co|"
    r"company|trust|reit|holdings|properties|property|realty|ltd|limited|pllc|"
    r"pc|pa|association|assoc)\.?$",
    re.IGNORECASE,
)
_PUNCT_PATTERN = re.compile(r"[.,'\"]")
_WS_PATTERN = re.compile(r"\s+")


def normalize_owner_name(name: str) -> str:
    if not name:
        return ""
    s = name.strip().lower()
    s = _SUFFIX_PATTERN.sub("", s)
    s = _PUNCT_PATTERN.sub("", s)
    s = _WS_PATTERN.sub(" ", s)
    return s.strip()


@dataclass
class EntityIndex:
    exact: dict[str, str] = field(default_factory=dict)
    normalized: dict[str, str] = field(default_factory=dict)
    subsidiary: dict[str, str] = field(default_factory=dict)
    cache: dict[str, tuple[str | None, int]] = field(default_factory=dict)


def build_entity_index(client: Client) -> EntityIndex:
    index = EntityIndex()
    page_size = 1000
    offset = 0
    while True:
        try:
            res = (
                client.table("intel_entities")
                .select("id, name, subsidiary_names")
                .range(offset, offset + page_size - 1)
                .execute()
            )
        except Exception as exc:
            print(f"⚠ entity index page failed: {exc}")
            break
        data = res.data or []
        if not data:
            break
        for row in data:
            name = (row.get("name") or "").strip()
            ent_id = row.get("id")
            if not name or not ent_id:
                continue
            lower = name.lower()
            norm = normalize_owner_name(name)
            index.exact.setdefault(lower, ent_id)
            if norm:
                index.normalized.setdefault(norm, ent_id)
            for s in (row.get("subsidiary_names") or []):
                if not isinstance(s, str):
                    continue
                sn = normalize_owner_name(s)
                if sn:
                    index.subsidiary.setdefault(sn, ent_id)
        if len(data) < page_size:
            break
        offset += page_size
    return index


def resolve_entity(raw_name: str | None, index: EntityIndex) -> tuple[str | None, int, str]:
    if not raw_name:
        return (None, 0, "unmatched")
    key = raw_name.strip()
    if not key:
        return (None, 0, "unmatched")
    if key in index.cache:
        eid, lvl = index.cache[key]
        status = (
            "matched" if lvl == 1
            else "fuzzy_matched" if lvl == 2
            else "subsidiary_matched" if lvl == 3
            else "unmatched"
        )
        return (eid, lvl, status)

    lower = key.lower()
    if (hit := index.exact.get(lower)):
        index.cache[key] = (hit, 1)
        return (hit, 1, "matched")

    norm = normalize_owner_name(key)
    if norm:
        if (hit := index.normalized.get(norm)):
            index.cache[key] = (hit, 2)
            return (hit, 2, "fuzzy_matched")
        if (hit := index.subsidiary.get(norm)):
            index.cache[key] = (hit, 3)
            return (hit, 3, "subsidiary_matched")

    index.cache[key] = (None, 0)
    return (None, 0, "unmatched")


# ─────────────────────────────────────────────────────────────────────────
# Detail normalization
# ─────────────────────────────────────────────────────────────────────────


def _pick_str(d: dict[str, Any], *keys: str) -> str | None:
    for k in keys:
        v = d.get(k)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    return None


def _pick_num(d: dict[str, Any], *keys: str) -> float | None:
    for k in keys:
        v = d.get(k)
        if v is None or v == "":
            continue
        try:
            return float(v)
        except (TypeError, ValueError):
            continue
    return None


def _pick_bool(d: dict[str, Any], *keys: str) -> bool | None:
    for k in keys:
        v = d.get(k)
        if v is None:
            continue
        if isinstance(v, bool):
            return v
        s = str(v).lower()
        if s in ("true", "yes", "1"):
            return True
        if s in ("false", "no", "0"):
            return False
    return None


def normalize_detail(pid: str, body: dict[str, Any]) -> dict[str, Any]:
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    pinfo = data.get("propertyInfo") if isinstance(data.get("propertyInfo"), dict) else {}
    oinfo = data.get("ownerInfo") if isinstance(data.get("ownerInfo"), dict) else {}
    tinfo = data.get("taxInfo") if isinstance(data.get("taxInfo"), dict) else {}
    linfo = data.get("lotInfo") if isinstance(data.get("lotInfo"), dict) else {}
    paddr = pinfo.get("address") if isinstance(pinfo.get("address"), dict) else {}
    maddr = oinfo.get("mailAddress") if isinstance(oinfo.get("mailAddress"), dict) else {}

    street = _pick_str(paddr, "address") or _pick_str(body, "address")
    city = _pick_str(paddr, "city") or _pick_str(body, "city")
    state = _pick_str(paddr, "state") or _pick_str(body, "state")
    zip_code = _pick_str(paddr, "zip") or _pick_str(body, "zip_code")
    county = _pick_str(paddr, "county") or _pick_str(body, "county")

    lat = _pick_num(pinfo, "latitude") or _pick_num(body, "latitude") or 0.0
    lon = _pick_num(pinfo, "longitude") or _pick_num(body, "longitude") or 0.0

    est = _pick_num(tinfo, "marketValue", "estimatedValue", "assessedValue") or _pick_num(body, "estimated_value")
    yr = _pick_num(pinfo, "yearBuilt")

    return {
        "id": pid,
        "address": street,
        "city": city,
        "state": state,
        "zip": zip_code,
        "county": county,
        "latitude": lat,
        "longitude": lon,
        "raw_owner_name": _pick_str(oinfo, "owner1FullName", "companyName"),
        "owner_mailing_address": _pick_str(maddr, "label", "address"),
        "owner_mailing_city": _pick_str(maddr, "city"),
        "owner_mailing_state": _pick_str(maddr, "state"),
        "owner_mailing_zip": _pick_str(maddr, "zip"),
        "apn": _pick_str(linfo, "apn", "apnUnformatted"),
        "estimated_value": est,
        "year_built": int(yr) if yr is not None else None,
        "building_sqft": _pick_num(pinfo, "buildingSquareFeet", "livingSquareFeet"),
        "lot_size_sqft": _pick_num(pinfo, "lotSquareFeet") or _pick_num(linfo, "lotSquareFeet"),
        "property_type": _pick_str(pinfo, "propertyUse") or _pick_str(body, "property_type"),
        "corporate_owned": _pick_bool(oinfo, "corporateOwned") or _pick_bool(body, "corporate_owned"),
        "absentee_owner": _pick_bool(oinfo, "absenteeOwner") or _pick_bool(body, "absentee_owner"),
    }


def missing_required(d: dict[str, Any]) -> list[str]:
    out: list[str] = []
    if not d.get("address"): out.append("address")
    if not d.get("city"): out.append("city")
    if not d.get("state"): out.append("state")
    if not d.get("zip"): out.append("zip")
    if not d.get("raw_owner_name"): out.append("raw_owner_name")
    return out


# ─────────────────────────────────────────────────────────────────────────
# HTTP — async with retries
# ─────────────────────────────────────────────────────────────────────────


def _bbox_polygon(min_lat: float, max_lat: float, min_lon: float, max_lon: float) -> list[dict[str, float]]:
    return [
        {"lat": max_lat, "lon": min_lon},
        {"lat": max_lat, "lon": max_lon},
        {"lat": min_lat, "lon": max_lon},
        {"lat": min_lat, "lon": min_lon},
        {"lat": max_lat, "lon": min_lon},
    ]


async def fetch_mapping(
    session: aiohttp.ClientSession,
    jwt: str,
    throttle: Throttle,
    bbox: tuple[float, float, float, float],
) -> dict[str, Any] | None:
    """Single mapping call. Returns {data, resultCount, credits} or None on failure."""
    min_lat, max_lat, min_lon, max_lon = bbox
    body = {
        "size": PAGE_LIMIT,
        "and": [{"polygon": _bbox_polygon(min_lat, max_lat, min_lon, max_lon)}],
        "building_size_min": BUILDING_SIZE_MIN,
        "property_use_code": PROPERTY_USE_CODES,
    }
    headers = {"Authorization": f"Bearer {jwt}", "Content-Type": "application/json"}
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT_SECONDS)

    async with throttle.mapping_sem:
        for attempt in range(HTTP_MAX_RETRIES):
            try:
                async with session.post(MAPPING_URL, json=body, headers=headers, timeout=timeout) as res:
                    if res.status == 401:
                        raise JwtExpiredError("PROPTRACER_JWT expired — update .env.local")
                    if res.status == 429:
                        throttle.back_off()
                        await asyncio.sleep(throttle.batch_sleep * 5)
                        continue
                    if res.status >= 500:
                        await asyncio.sleep(HTTP_RETRY_SLEEP * (attempt + 1))
                        continue
                    if res.status >= 400:
                        return None
                    payload = await res.json()
                    return {
                        "data": payload.get("data") or [],
                        "resultCount": payload.get("resultCount", 0),
                        "credits": payload.get("credits", 0),
                    }
            except JwtExpiredError:
                raise
            except (asyncio.TimeoutError, aiohttp.ClientError):
                await asyncio.sleep(HTTP_RETRY_SLEEP * (attempt + 1))
                continue
            except Exception as exc:  # noqa: BLE001
                print(f"  ⚠ mapping unexpected error: {exc}")
                return None
    return None


async def fetch_detail(
    session: aiohttp.ClientSession,
    jwt: str,
    throttle: Throttle,
    pid: str,
) -> dict[str, Any] | None:
    """Single detail call. Returns parsed body or None on failure (404, error, timeout)."""
    headers = {"Authorization": f"Bearer {jwt}"}
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT_SECONDS)

    for attempt in range(HTTP_MAX_RETRIES):
        try:
            async with session.get(f"{DETAIL_URL}/{pid}", headers=headers, timeout=timeout) as res:
                if res.status == 401:
                    raise JwtExpiredError("PROPTRACER_JWT expired — update .env.local")
                if res.status == 429:
                    throttle.back_off()
                    await asyncio.sleep(throttle.batch_sleep * 5)
                    continue
                if res.status == 404:
                    return None
                if res.status >= 500:
                    await asyncio.sleep(HTTP_RETRY_SLEEP * (attempt + 1))
                    continue
                if res.status >= 400:
                    return None
                return await res.json()
        except JwtExpiredError:
            raise
        except (asyncio.TimeoutError, aiohttp.ClientError):
            await asyncio.sleep(HTTP_RETRY_SLEEP * (attempt + 1))
            continue
        except Exception as exc:  # noqa: BLE001
            print(f"  ⚠ detail {pid} unexpected error: {exc}")
            return None
    return None


# ─────────────────────────────────────────────────────────────────────────
# Async detail fetching — N parallel per batch, sleep between batches
# ─────────────────────────────────────────────────────────────────────────


async def _gated_fetch(
    session: aiohttp.ClientSession,
    jwt: str,
    throttle: Throttle,
    pid: str,
) -> dict[str, Any] | None:
    """Acquire the detail semaphore, then call fetch_detail. Catches all exceptions."""
    async with throttle.detail_sem:
        try:
            return await fetch_detail(session, jwt, throttle, pid)
        except JwtExpiredError:
            raise
        except Exception as exc:  # noqa: BLE001
            print(f"  ⚠ detail {pid} crashed: {exc}")
            return None


async def fetch_details_batched(
    session: aiohttp.ClientSession,
    jwt: str,
    throttle: Throttle,
    ids: list[str],
) -> list[tuple[str, dict[str, Any] | None]]:
    """Fetch details in parallel batches; sleep between batches."""
    results: list[tuple[str, dict[str, Any] | None]] = []
    workers = throttle.detail_workers
    for batch_start in range(0, len(ids), workers):
        if batch_start > 0:
            await asyncio.sleep(throttle.batch_sleep)
        # Re-read worker count each batch in case a 429 reduced it mid-zip
        workers = throttle.detail_workers
        batch = ids[batch_start: batch_start + workers]
        batch_out = await asyncio.gather(
            *[_gated_fetch(session, jwt, throttle, pid) for pid in batch],
            return_exceptions=True,
        )
        for pid, r in zip(batch, batch_out):
            if isinstance(r, JwtExpiredError):
                raise r
            if isinstance(r, BaseException):
                results.append((pid, None))
            else:
                results.append((pid, r))
    return results


# ─────────────────────────────────────────────────────────────────────────
# Recursive mapping collect — fans out via mapping semaphore
# ─────────────────────────────────────────────────────────────────────────


async def collect_ids(
    session: aiohttp.ClientSession,
    jwt: str,
    throttle: Throttle,
    bbox: tuple[float, float, float, float],
    depth: int = 0,
) -> tuple[list[dict[str, Any]], int, int]:
    """Returns (mapping_hits, cells_queried, total_for_root_bbox)."""
    res = await fetch_mapping(session, jwt, throttle, bbox)
    if res is None:
        return [], 1, 0

    data = res.get("data") or []
    result_count = res.get("resultCount", 0)
    initial_total = result_count if depth == 0 else 0

    if result_count <= PAGE_LIMIT or depth >= MAX_RECURSION_DEPTH:
        return data, 1, initial_total

    # Subdivide into 4 quadrants and recurse in parallel
    min_lat, max_lat, min_lon, max_lon = bbox
    mid_lat = (min_lat + max_lat) / 2
    mid_lon = (min_lon + max_lon) / 2
    quads = [
        (mid_lat, max_lat, min_lon, mid_lon),
        (mid_lat, max_lat, mid_lon, max_lon),
        (min_lat, mid_lat, min_lon, mid_lon),
        (min_lat, mid_lat, mid_lon, max_lon),
    ]

    sub_results = await asyncio.gather(
        *[collect_ids(session, jwt, throttle, q, depth + 1) for q in quads],
        return_exceptions=True,
    )

    merged: dict[str, dict[str, Any]] = {}
    cells = 1
    for r in sub_results:
        if isinstance(r, JwtExpiredError):
            raise r
        if isinstance(r, BaseException):
            continue
        sub_data, sub_cells, _ = r
        cells += sub_cells
        for hit in sub_data:
            pid = hit.get("id")
            if pid:
                merged[pid] = hit

    return list(merged.values()), cells, initial_total


# ─────────────────────────────────────────────────────────────────────────
# Process one zip
# ─────────────────────────────────────────────────────────────────────────


def _build_payload(
    pid: str,
    norm: dict[str, Any],
    mapping_hit: dict[str, Any],
    eid: str | None,
    level: int,
    status: str,
    zip_entry: ZipCode,
    now_iso: str,
) -> dict[str, Any]:
    est = norm.get("estimated_value")
    bsqft = norm.get("building_sqft")
    return {
        "external_id": pid,
        "source_detail": SOURCE_DETAIL,
        "street_address": norm["address"],
        "city": norm["city"],
        "state": norm["state"],
        "postal_code": norm["zip"] or zip_entry.zip,
        "county": norm.get("county"),
        "lat": norm["latitude"] or mapping_hit.get("latitude"),
        "lng": norm["longitude"] or mapping_hit.get("longitude"),
        "latitude": norm["latitude"] or mapping_hit.get("latitude"),
        "longitude": norm["longitude"] or mapping_hit.get("longitude"),
        "raw_owner_name": norm["raw_owner_name"],
        "owner_name": norm["raw_owner_name"],
        "owner_mailing_address": norm.get("owner_mailing_address"),
        "owner_mailing_city": norm.get("owner_mailing_city"),
        "owner_mailing_state": norm.get("owner_mailing_state"),
        "owner_mailing_zip": norm.get("owner_mailing_zip"),
        "corporate_owned": norm.get("corporate_owned"),
        "absentee_owner": norm.get("absentee_owner"),
        "apn": norm.get("apn"),
        "parcel_id": norm.get("apn"),
        "estimated_value": est,
        "assessed_value": int(round(est)) if est is not None else None,
        "building_sqft": bsqft,
        "sq_footage": int(round(bsqft)) if bsqft is not None else None,
        "lot_size_sqft": norm.get("lot_size_sqft"),
        "year_built": norm.get("year_built"),
        "property_type": norm.get("property_type"),
        "property_name": norm["address"],
        "proptracer_id": pid,
        "entity_id": eid,
        "enrichment_status": status,
        "enrichment_level": level,
        "needs_assessor_data": True,
        "needs_google_places": True,
        "updated_at": now_iso,
    }


def _upsert_with_retry(supabase: Client, payloads: list[dict[str, Any]]) -> int:
    """Sync upsert with one retry. Returns count actually upserted."""
    for attempt in range(DB_UPSERT_RETRIES + 1):
        try:
            supabase.table("intel_properties").upsert(
                payloads, on_conflict="external_id,source_detail"
            ).execute()
            return len(payloads)
        except Exception as exc:  # noqa: BLE001
            if attempt < DB_UPSERT_RETRIES:
                time.sleep(0.5)
                continue
            print(f"  ⚠ upsert failed after retry: {exc}")
            return 0
    return 0


async def process_zip(
    session: aiohttp.ClientSession,
    jwt: str,
    throttle: Throttle,
    supabase: Client,
    entity_index: EntityIndex,
    zip_entry: ZipCode,
) -> dict[str, int]:
    """End-to-end zip processing. Returns stats. Never raises (except JwtExpiredError)."""
    start = time.time()

    # Runtime safety: tiny bbox = single-building footprint = likely PO Box.
    # Catches edge cases the data-file pre-filter missed (or zips loaded
    # via --zip that bypass the PO Box filter).
    lat_span = zip_entry.max_lat - zip_entry.min_lat
    lon_span = zip_entry.max_lon - zip_entry.min_lon
    if lat_span < MIN_BBOX_SPAN_DEGREES or lon_span < MIN_BBOX_SPAN_DEGREES:
        print(
            f"[{zip_entry.state}][{zip_entry.zip} - {zip_entry.city}] "
            f"skipped — likely PO Box zip (bbox span lat={lat_span:.4f}° lon={lon_span:.4f}°)"
        )
        return {"collected": 0, "written": 0, "cells": 0, "failed": 0, "skipped": 0}

    bbox = (zip_entry.min_lat, zip_entry.max_lat, zip_entry.min_lon, zip_entry.max_lon)

    # Collect IDs (recursive subdivision if dense)
    hits, cells, proptracer_total = await collect_ids(session, jwt, throttle, bbox)

    if proptracer_total == 0 and hits:
        # Sparse zip — initial call gave us everything
        proptracer_total = len(hits)

    if not hits:
        elapsed_min = (time.time() - start) / 60
        cells_label = "cell" if cells == 1 else "cells"
        print(
            f"[{zip_entry.state}][{zip_entry.zip} - {zip_entry.city}] "
            f"0 collected / {proptracer_total} total — {cells} {cells_label} — "
            f"0 written — {elapsed_min:.1f} min"
        )
        return {"collected": 0, "written": 0, "cells": cells, "failed": 0, "skipped": 0}

    # Fetch details in parallel batches
    ids = [h["id"] for h in hits if h.get("id")]
    hit_map = {h["id"]: h for h in hits if h.get("id")}
    details = await fetch_details_batched(session, jwt, throttle, ids)

    # Normalize, validate, resolve, build payloads
    payloads: list[dict[str, Any]] = []
    skipped = 0
    failed = 0
    now_iso = datetime.now(timezone.utc).isoformat()

    for pid, body in details:
        if body is None:
            failed += 1
            continue
        try:
            norm = normalize_detail(pid, body)
        except Exception as exc:  # noqa: BLE001
            print(f"  ⚠ normalize {pid} failed: {exc}")
            failed += 1
            continue
        if missing_required(norm):
            skipped += 1
            continue
        try:
            eid, level, status = resolve_entity(norm.get("raw_owner_name"), entity_index)
        except Exception as exc:  # noqa: BLE001
            print(f"  ⚠ resolve {pid} failed: {exc}")
            eid, level, status = (None, 0, "unmatched")

        try:
            payload = _build_payload(
                pid, norm, hit_map.get(pid, {}), eid, level, status, zip_entry, now_iso
            )
            payloads.append(payload)
        except Exception as exc:  # noqa: BLE001
            print(f"  ⚠ build_payload {pid} failed: {exc}")
            failed += 1

    # Upsert in chunks of 100 — supabase blocking call run on event loop is OK
    # since we're not parallelizing across zips
    written = 0
    for chunk_start in range(0, len(payloads), 100):
        chunk = payloads[chunk_start: chunk_start + 100]
        written += _upsert_with_retry(supabase, chunk)

    elapsed_min = (time.time() - start) / 60
    pct = 100 * len(hits) / proptracer_total if proptracer_total else 100
    cells_label = "cell" if cells == 1 else "cells"
    print(
        f"[{zip_entry.state}][{zip_entry.zip} - {zip_entry.city}] "
        f"{len(hits)} collected / {proptracer_total} total ({pct:.0f}%) — "
        f"{cells} {cells_label} — {written} written — {elapsed_min:.1f} min"
    )

    return {
        "collected": len(hits),
        "written": written,
        "cells": cells,
        "failed": failed,
        "skipped": skipped,
    }


# ─────────────────────────────────────────────────────────────────────────
# Progress
# ─────────────────────────────────────────────────────────────────────────


def _new_progress() -> dict[str, Any]:
    return {
        "completed_zips": [],
        "failed_zips": [],
        "total_written": 0,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "last_updated": None,
    }


def load_progress() -> dict[str, Any]:
    if not PROGRESS_FILE.exists():
        return _new_progress()
    try:
        p = json.loads(PROGRESS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"⚠ progress.json unreadable ({e}); starting fresh")
        return _new_progress()
    p.setdefault("completed_zips", [])
    p.setdefault("failed_zips", [])
    p.setdefault("total_written", 0)
    p.setdefault("started_at", datetime.now(timezone.utc).isoformat())
    p.setdefault("last_updated", None)
    return p


def save_progress(progress: dict[str, Any]) -> None:
    progress["last_updated"] = datetime.now(timezone.utc).isoformat()
    try:
        PROGRESS_FILE.write_text(json.dumps(progress, indent=2), encoding="utf-8")
    except OSError as exc:
        print(f"⚠ couldn't save progress: {exc}")


# ─────────────────────────────────────────────────────────────────────────
# Main async — sequential outer loop over zips
# ─────────────────────────────────────────────────────────────────────────


async def main_async(args: argparse.Namespace) -> int:
    load_dotenv(ENV_PATH)
    jwt = os.environ.get("PROPTRACER_JWT")
    sb_url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    missing_env = [
        n for n, v in (
            ("PROPTRACER_JWT", jwt),
            ("NEXT_PUBLIC_SUPABASE_URL", sb_url),
            ("SUPABASE_SERVICE_ROLE_KEY", sb_key),
        ) if not v
    ]
    if missing_env:
        print(f"❌ Missing env vars: {', '.join(missing_env)} (looked in {ENV_PATH})")
        return 1

    if args.reset and PROGRESS_FILE.exists():
        PROGRESS_FILE.unlink()
        print(f"🗑  Deleted {PROGRESS_FILE.name}")

    progress = load_progress()
    completed: set[str] = set(progress.get("completed_zips") or [])
    failed: set[str] = set(progress.get("failed_zips") or [])

    try:
        zips, po_box_skipped = load_zips_for_scope(args)
    except (FileNotFoundError, ValueError) as exc:
        print(f"❌ {exc}")
        return 1

    if not zips:
        print("❌ No zip codes matched the requested scope.")
        return 1

    supabase = create_client(sb_url, sb_key)

    print("Loading entity index...")
    entity_index = build_entity_index(supabase)
    print(
        f"  exact={len(entity_index.exact):,} normalized={len(entity_index.normalized):,} "
        f"subsidiary={len(entity_index.subsidiary):,}"
    )
    if po_box_skipped > 0:
        print(f"PO Box zips filtered out: {po_box_skipped:,}")
    print(f"Scope: {len(zips):,} zip codes  (already done: {len(completed):,})")

    workers = getattr(args, "workers", DETAIL_WORKERS_NORMAL)
    print(f"Concurrency: {workers} detail workers, {MAPPING_WORKERS} mapping workers")
    throttle = Throttle(normal_workers=workers)
    # Connector pool needs at least workers + mapping_workers + headroom.
    connector_limit = max(TCP_CONNECTOR_LIMIT, workers + MAPPING_WORKERS + 100)
    connector = aiohttp.TCPConnector(limit=connector_limit, limit_per_host=connector_limit, ssl=True)
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT_SECONDS)

    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
        for i, z in enumerate(zips, start=1):
            if args.zip is None and z.zip in completed:
                continue

            try:
                stats = await process_zip(session, jwt, throttle, supabase, entity_index, z)
            except JwtExpiredError as exc:
                print(f"❌ {exc}")
                save_progress(progress)
                return 2
            except Exception as exc:  # noqa: BLE001
                # Per-zip failure: log, mark as failed, continue
                tb = traceback.format_exc()
                print(f"⚠ zip {z.zip} crashed: {exc}\n{tb}")
                failed.add(z.zip)
                progress["failed_zips"] = sorted(failed)
                save_progress(progress)
                continue

            # Success path: mark complete (even if collected=0)
            completed.add(z.zip)
            failed.discard(z.zip)
            progress["completed_zips"] = sorted(completed)
            progress["failed_zips"] = sorted(failed)
            progress["total_written"] = progress.get("total_written", 0) + stats.get("written", 0)
            save_progress(progress)

    print(f"\n✅ Run complete. total_written={progress.get('total_written', 0):,}")
    return 0


# ─────────────────────────────────────────────────────────────────────────
# Auto-restart wrapper
# ─────────────────────────────────────────────────────────────────────────


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        pass

    parser = argparse.ArgumentParser(description="PropTracer scraper (async, fast, bulletproof)")
    grp = parser.add_mutually_exclusive_group(required=False)
    grp.add_argument("--state", type=str, help="2-letter state code (e.g. TN, CA)")
    grp.add_argument("--metro", type=str, help=f"Metro name. Known: {', '.join(sorted(METROS))}")
    grp.add_argument("--national", action="store_true", help="All US zip codes")
    grp.add_argument(
        "--priority", action="store_true",
        help=f"Run priority states in order: {', '.join(PRIORITY_STATES)}",
    )
    grp.add_argument("--zip", type=str, help="Single zip code (smoke test)")
    parser.add_argument(
        "--workers", type=int, default=DETAIL_WORKERS_NORMAL,
        help=f"Concurrent detail workers (default {DETAIL_WORKERS_NORMAL}; backoff at half on 429)",
    )
    parser.add_argument("--reset", action="store_true", help="Clear progress.json and restart")
    args = parser.parse_args()

    # Ensure args.priority exists even on python <3.x quirks
    if not hasattr(args, "priority"):
        args.priority = False

    # If no scope is provided, default to --national (matches the user's original spec)
    if not (args.state or args.metro or args.national or args.zip or args.priority):
        args.national = True

    if args.workers < 1:
        print(f"❌ --workers must be >= 1 (got {args.workers})")
        return 1

    while True:
        try:
            exit_code = asyncio.run(main_async(args))
            return exit_code
        except KeyboardInterrupt:
            print("\n⚠ Interrupted — progress saved.")
            return 130
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            print(f"\n⚠ Crashed: {exc}. Restarting in {RESTART_DELAY_SECONDS}s...")
            time.sleep(RESTART_DELAY_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
