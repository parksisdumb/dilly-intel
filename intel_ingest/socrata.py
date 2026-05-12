"""
Socrata client for the open-data scrapers.

Most municipal open-data portals (Cook County IL, Louisville KY, NYC, etc.)
sit on the Socrata stack. The HTTP API is consistent enough that one
helper handles all of them:

    https://<host>/resource/<dataset_id>.json

Common pagination is `$limit` + `$offset`. SoQL filters via `$where`,
field selection via `$select`, ordering via `$order`. We use ordering on
a stable column (e.g. row_id) so resume-from-offset works after a crash.

Auth: we send a Socrata App Token if SOCRATA_APP_TOKEN is set in the env
— it's not strictly required for read-only access but raises the rate
limit ceiling considerably (1k/day anonymous vs much higher with a
token). Set it in .env.local for production runs.
"""
from __future__ import annotations

import os
import time
from typing import Any, Iterator
from urllib.parse import quote

import requests

DEFAULT_TIMEOUT = (15, 120)  # connect, read
DEFAULT_PAGE_SIZE = 1000     # Socrata's recommended max for $limit
DEFAULT_RETRIES = 3
DEFAULT_RETRY_SLEEP = 2.0
USER_AGENT = "DillyIntel/1.0 team@dillyos.com"


def _app_token_header() -> dict[str, str]:
    """X-App-Token header if available; raises rate-limit ceiling."""
    token = os.environ.get("SOCRATA_APP_TOKEN")
    return {"X-App-Token": token} if token else {}


def base_headers() -> dict[str, str]:
    h = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    h.update(_app_token_header())
    return h


def fetch_page(
    host: str,
    dataset_id: str,
    *,
    offset: int = 0,
    limit: int = DEFAULT_PAGE_SIZE,
    where: str | None = None,
    select: str | None = None,
    order: str | None = None,
    session: requests.Session | None = None,
) -> list[dict[str, Any]]:
    """
    Fetch one page of rows. Retries transient network errors. Raises
    requests.HTTPError on permanent 4xx/5xx.

    `host` is the bare hostname like "datacatalog.cookcountyil.gov".
    """
    s = session or requests
    url = f"https://{host}/resource/{dataset_id}.json"
    params: dict[str, Any] = {"$limit": limit, "$offset": offset}
    if where:
        params["$where"] = where
    if select:
        params["$select"] = select
    if order:
        params["$order"] = order

    for attempt in range(DEFAULT_RETRIES):
        try:
            r = s.get(url, params=params, headers=base_headers(), timeout=DEFAULT_TIMEOUT)
            r.raise_for_status()
            return r.json()
        except (requests.ConnectionError, requests.Timeout) as e:
            if attempt == DEFAULT_RETRIES - 1:
                raise
            time.sleep(DEFAULT_RETRY_SLEEP * (attempt + 1))
        except requests.HTTPError as e:
            # 5xx is worth retrying; 4xx isn't.
            if 500 <= (e.response.status_code if e.response is not None else 0) < 600 and attempt < DEFAULT_RETRIES - 1:
                time.sleep(DEFAULT_RETRY_SLEEP * (attempt + 1))
                continue
            raise
    return []  # unreachable but quiets lint


def stream_rows(
    host: str,
    dataset_id: str,
    *,
    where: str | None = None,
    select: str | None = None,
    order: str | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    start_offset: int = 0,
    on_page: Any = None,
) -> Iterator[dict[str, Any]]:
    """
    Yield every matching row as a dict, paginating with $limit/$offset.

    `on_page(offset, returned_count)` is called once per fetched page so
    the caller can persist resume cursors.
    """
    session = requests.Session()
    offset = start_offset
    while True:
        rows = fetch_page(
            host, dataset_id,
            offset=offset, limit=page_size,
            where=where, select=select, order=order,
            session=session,
        )
        if not rows:
            return
        for r in rows:
            yield r
        if on_page:
            on_page(offset, len(rows))
        if len(rows) < page_size:
            return
        offset += len(rows)


def lookup_by_keys(
    host: str,
    dataset_id: str,
    *,
    key_field: str,
    keys: list[str],
    select: str | None = None,
    chunk_size: int = 100,
) -> dict[str, dict[str, Any]]:
    """
    Bulk lookup helper. Returns {key_value: row} for each key found.

    Internally splits `keys` into chunks of `chunk_size` and queries with
    a SoQL `IN ('a','b',...)` clause. Useful for joining a primary
    dataset (e.g. Commercial Valuation Data) against a secondary one
    (Parcel Addresses) on PIN.

    Quotes are escaped by doubling them — Socrata SoQL uses single
    quotes for string literals and accepts '' as an embedded quote.
    """
    out: dict[str, dict[str, Any]] = {}
    session = requests.Session()
    for i in range(0, len(keys), chunk_size):
        batch = keys[i : i + chunk_size]
        # Escape single quotes by doubling and wrap each value.
        quoted = ",".join("'" + k.replace("'", "''") + "'" for k in batch if k)
        if not quoted:
            continue
        where = f"{key_field} in ({quoted})"
        rows = fetch_page(
            host, dataset_id,
            offset=0, limit=chunk_size,
            where=where, select=select,
            session=session,
        )
        for r in rows:
            k = r.get(key_field)
            if k is not None:
                out[str(k)] = r
    return out


def encode_where(where: str) -> str:
    """URL-encode a SoQL where clause for use outside this module
    (e.g. building debug URLs). Internally the requests library handles
    encoding for us; this is exported for logging."""
    return quote(where, safe="")
