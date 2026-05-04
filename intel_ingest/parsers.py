"""
Streaming parsers for the wire formats used by the public-data sources.

iter_csv          — generic CSV / pipe-delimited / tab-delimited with header
iter_fixed_width  — HCAD's fixed-width format using a column-spec list
read_zip_member   — open a single file inside a downloaded ZIP without
                    extracting the rest

All iterators yield dicts keyed by column name. They are generators — they
never load the whole file into memory.
"""
from __future__ import annotations

import csv
import io
import zipfile
from pathlib import Path
from typing import Iterable, IO


def iter_csv(
    source: Path | IO[str],
    delimiter: str = ",",
    encoding: str = "utf-8",
    encoding_errors: str = "replace",
) -> Iterable[dict[str, str]]:
    """
    Yield dicts row-by-row from a CSV file (or any text stream). Header is
    the first row; field names are stripped. Empty fields are returned as
    empty strings (csv module default).

    Use delimiter="|" for FL DOR's pipe-delimited counties or TAD's pipe TXT.
    """
    if isinstance(source, Path):
        f = open(source, encoding=encoding, errors=encoding_errors, newline="")
        close_after = True
    else:
        f = source
        close_after = False

    try:
        reader = csv.DictReader(f, delimiter=delimiter)
        if reader.fieldnames is None:
            return
        # Normalize header names: strip whitespace
        reader.fieldnames = [name.strip() for name in reader.fieldnames]
        for row in reader:
            yield {k.strip() if k else k: (v if v is not None else "") for k, v in row.items()}
    finally:
        if close_after:
            f.close()


def iter_pipe_delimited(
    source: Path | IO[str],
    encoding: str = "utf-8",
    encoding_errors: str = "replace",
) -> Iterable[dict[str, str]]:
    """Convenience: pipe-delimited CSV (TAD, some FL counties)."""
    return iter_csv(source, delimiter="|", encoding=encoding, encoding_errors=encoding_errors)


def iter_fixed_width(
    source: Path | IO[str],
    spec: list[tuple[str, int, int]],
    encoding: str = "latin-1",
    encoding_errors: str = "replace",
) -> Iterable[dict[str, str]]:
    """
    Yield dicts from a fixed-width text file.

    `spec` is a list of (field_name, start_col_1based, end_col_1based) tuples
    matching how appraisal-district codebooks describe column ranges. End is
    inclusive. Each field is .strip()ed.

    HCAD codebook uses 1-based inclusive ranges, e.g.:
        ("ACCT", 1, 13), ("STATE_CLASS", 14, 15), ...
    """
    if isinstance(source, Path):
        f = open(source, encoding=encoding, errors=encoding_errors)
        close_after = True
    else:
        f = source
        close_after = False

    try:
        for raw in f:
            # Strip line terminator only — keep internal spaces
            line = raw.rstrip("\r\n")
            if not line:
                continue
            row: dict[str, str] = {}
            for name, start, end in spec:
                # Convert 1-based inclusive -> 0-based exclusive
                row[name] = line[start - 1:end].strip()
            yield row
    finally:
        if close_after:
            f.close()


def read_zip_member(
    zip_path: Path,
    member_name: str,
    encoding: str = "utf-8",
) -> IO[str]:
    """
    Open a single file inside a ZIP and return a text-mode file-like object.
    Caller is responsible for closing it.

    member_name can be a substring — picks the first archive entry that
    contains the substring (case-insensitive). Useful for ZIPs where the
    inner filename includes a date stamp (DCAD's `2025_appraisal_<date>.csv`).
    """
    zf = zipfile.ZipFile(zip_path, "r")
    try:
        target_name = None
        member_lower = member_name.lower()
        for name in zf.namelist():
            if member_lower in name.lower():
                target_name = name
                break
        if target_name is None:
            raise FileNotFoundError(
                f"No archive entry matching {member_name!r} in {zip_path}"
            )
        binary = zf.open(target_name)
        # Wrap in a TextIOWrapper for text-mode iteration. Holding a ref
        # to zf via the returned object's _zf attribute keeps it alive.
        text = io.TextIOWrapper(binary, encoding=encoding, errors="replace", newline="")
        text._zf = zf  # type: ignore[attr-defined]  # keep ZipFile alive
        return text
    except Exception:
        zf.close()
        raise


def list_zip_members(zip_path: Path) -> list[str]:
    """Return all filenames inside a ZIP — useful for layout discovery."""
    with zipfile.ZipFile(zip_path, "r") as zf:
        return zf.namelist()
