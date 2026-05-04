"""
Chunked Supabase upserter for the public-data scrapers.

All four scrapers write to `intel_properties` with a (external_id, source_detail)
unique key. This module batches in 500-row chunks (Supabase's recommended
upper bound), retries transient network errors, and exposes simple
add()/flush() methods so callers don't have to think about batching.

Default batch size is 500 — a 10,000-row chunk is too large for a single
INSERT round-trip and risks Postgres statement_timeout on the upsert path.
The caller still streams 10k records at a time from the source file; this
class just splits each stream chunk into 20×500 upserts.
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from supabase import Client, create_client

# Cards / filtering thresholds shared across scrapers.
MIN_BUILDING_SQFT = 1501

# Conflict target — matches the unique index in the original schema.
ON_CONFLICT = "external_id,source_detail"

DEFAULT_BATCH_SIZE = 500
DEFAULT_RETRY_COUNT = 3
DEFAULT_RETRY_SLEEP = 2.0


def _load_env() -> None:
    """Load .env.local from the project root if it exists."""
    env_path = Path(__file__).parent.parent / ".env.local"
    if env_path.exists():
        load_dotenv(env_path)


def make_client() -> Client:
    """Build a Supabase service-role client. Raises if env is missing."""
    _load_env()
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(
            "Missing Supabase env. Set NEXT_PUBLIC_SUPABASE_URL and "
            "SUPABASE_SERVICE_ROLE_KEY in .env.local."
        )
    return create_client(url, key)


class SupabaseUpserter:
    """
    Chunked upserter. Caller does .add(row) for each record, .flush() at end.

    Tracks counts: queued, upserted, failed. Skips rows missing required
    fields (street_address+city+state). Optionally enforces MIN_BUILDING_SQFT.
    """

    def __init__(
        self,
        source_detail: str,
        client: Client | None = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
        enforce_sqft_min: bool = True,
        on_log: Any = print,
    ) -> None:
        self.source_detail = source_detail
        self.client = client or make_client()
        self.batch_size = batch_size
        self.enforce_sqft_min = enforce_sqft_min
        self.log = on_log

        self._buf: list[dict[str, Any]] = []
        self.queued = 0
        self.upserted = 0
        self.failed = 0
        self.skipped_missing_address = 0
        self.skipped_undersized = 0

    def add(self, row: dict[str, Any]) -> None:
        """Queue one row. Skips records missing required fields silently."""
        # Required-fields gate
        if not row.get("street_address") or not row.get("city") or not row.get("state"):
            self.skipped_missing_address += 1
            return

        if self.enforce_sqft_min:
            sqft = row.get("building_sqft")
            if sqft is not None:
                try:
                    if float(sqft) < MIN_BUILDING_SQFT:
                        self.skipped_undersized += 1
                        return
                except (TypeError, ValueError):
                    pass

        # Stamp source_detail (caller may also set it)
        row.setdefault("source_detail", self.source_detail)

        self._buf.append(row)
        self.queued += 1

        if len(self._buf) >= self.batch_size:
            self._flush_batch()

    def flush(self) -> None:
        """Force-flush whatever is buffered."""
        if self._buf:
            self._flush_batch()

    def _flush_batch(self) -> None:
        if not self._buf:
            return
        batch = self._buf
        self._buf = []

        # In-batch dedup. Postgres `ON CONFLICT DO UPDATE` rejects the entire
        # upsert if two rows in one statement target the same conflict key
        # (PG error 21000 / "command cannot affect row a second time"). NC
        # OneMap aggregates from county CAMA systems and occasionally ships
        # duplicate `(parno + cntyfips)` pairs (condo units that share a
        # parent parcel ID). Keep the LAST occurrence — likely the most
        # complete record because counties often emit a stub before
        # the detailed row.
        seen: dict[tuple, int] = {}
        for i, row in enumerate(batch):
            key = (row.get("external_id"), row.get("source_detail"))
            seen[key] = i  # last write wins
        if len(seen) < len(batch):
            dropped = len(batch) - len(seen)
            self.log(
                f"[upsert] batch had {dropped} in-batch duplicates "
                f"(same external_id+source_detail); keeping last of each"
            )
            batch = [batch[i] for i in sorted(seen.values())]

        for attempt in range(DEFAULT_RETRY_COUNT):
            try:
                self.client.table("intel_properties").upsert(
                    batch, on_conflict=ON_CONFLICT
                ).execute()
                self.upserted += len(batch)
                return
            except Exception as e:  # noqa: BLE001
                if attempt < DEFAULT_RETRY_COUNT - 1:
                    self.log(
                        f"[upsert] retry {attempt + 1}/{DEFAULT_RETRY_COUNT} "
                        f"after error: {e}"
                    )
                    time.sleep(DEFAULT_RETRY_SLEEP * (attempt + 1))
                else:
                    self.failed += len(batch)
                    self.log(
                        f"[upsert] FAILED batch of {len(batch)} after "
                        f"{DEFAULT_RETRY_COUNT} attempts: {e}"
                    )

    def stats(self) -> dict[str, int]:
        return {
            "queued": self.queued,
            "upserted": self.upserted,
            "failed": self.failed,
            "skipped_missing_address": self.skipped_missing_address,
            "skipped_undersized": self.skipped_undersized,
        }
