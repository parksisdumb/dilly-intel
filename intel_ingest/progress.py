"""
JSON-backed progress tracker for the public-data scrapers.

Each scraper writes to a single progress file (e.g. progress_florida.json)
that records:
  - records_processed: cumulative count
  - last_offset / last_county / last_keyset: source-specific resume cursor
  - failed: list of items (URLs, county codes, parcel IDs) that errored
  - started_at, last_updated_at: timestamps
  - any other arbitrary keys the scraper cares about

The class exposes a thin dict-like interface plus atomic save() that writes
through a tempfile to avoid corrupting the file on Ctrl-C mid-write.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class Progress:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.data: dict[str, Any] = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {
                "started_at": datetime.now(timezone.utc).isoformat(),
                "last_updated_at": datetime.now(timezone.utc).isoformat(),
                "records_processed": 0,
                "failed": [],
            }
        try:
            with open(self.path, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            # Corrupt file — start fresh but keep the bad copy for forensics
            corrupt = self.path.with_suffix(self.path.suffix + ".corrupt")
            try:
                self.path.replace(corrupt)
            except OSError:
                pass
            return {
                "started_at": datetime.now(timezone.utc).isoformat(),
                "last_updated_at": datetime.now(timezone.utc).isoformat(),
                "records_processed": 0,
                "failed": [],
            }

    # Dict-style access
    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.data[key] = value

    def __contains__(self, key: str) -> bool:
        return key in self.data

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    def setdefault(self, key: str, default: Any) -> Any:
        return self.data.setdefault(key, default)

    def add_failed(self, item: Any) -> None:
        self.data.setdefault("failed", []).append(item)

    def save(self) -> None:
        """Atomic write: tmp -> fsync -> rename."""
        self.data["last_updated_at"] = datetime.now(timezone.utc).isoformat()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix=self.path.name + ".",
            suffix=".tmp",
            dir=str(self.path.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=2, default=str)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_name, self.path)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def reset(self) -> None:
        """Clear everything and re-init."""
        self.data = {
            "started_at": datetime.now(timezone.utc).isoformat(),
            "last_updated_at": datetime.now(timezone.utc).isoformat(),
            "records_processed": 0,
            "failed": [],
        }
        self.save()
