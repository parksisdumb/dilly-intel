"""
Streaming HTTP downloader for large public-data files (TX CADs and FL DOR
ship 100MB-2GB ZIPs). Loads no more than ~1MB into RAM at a time, supports
HTTP Range resume on partially-downloaded files, and exposes a single
browser-style header builder for endpoints that block default User-Agents
(TAD's WAF in particular).
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

import requests

CHUNK_SIZE = 1024 * 1024  # 1 MiB
DEFAULT_TIMEOUT = (15, 300)  # connect, read

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


def browser_headers(referer: str | None = None) -> dict[str, str]:
    """
    Headers that mimic a real browser. TAD blocks anything with the Python
    `requests` default UA; HCAD/DCAD work with anything but it doesn't hurt.
    Pass a referer for sites that check it (TAD).
    """
    h = {
        "User-Agent": BROWSER_UA,
        "Accept": (
            "text/html,application/xhtml+xml,application/xml;q=0.9,"
            "image/avif,image/webp,*/*;q=0.8"
        ),
        "Accept-Language": "en-US,en;q=0.9",
        # Skip brotli — `requests` only auto-decompresses gzip/deflate. With
        # `br` advertised, Cloudflare-fronted sites (TAD especially) return
        # Brotli payloads we can't decode, leaving 12kb of binary in r.text.
        "Accept-Encoding": "gzip, deflate",
    }
    if referer:
        h["Referer"] = referer
    return h


def stream_download(
    url: str,
    dest: Path,
    headers: dict[str, str] | None = None,
    resume: bool = True,
    on_progress: callable | None = None,
) -> Path:
    """
    Download `url` to `dest` in 1MB chunks. If `resume=True` and `dest`
    already has bytes, sends a Range header to continue from where we left
    off. `on_progress(bytes_received, total_size_or_none)` is called once
    per chunk if provided.

    Returns the destination Path. Raises requests.HTTPError on non-2xx.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    headers = dict(headers or {})

    existing = dest.stat().st_size if (resume and dest.exists()) else 0
    if existing > 0:
        headers["Range"] = f"bytes={existing}-"

    with requests.get(url, headers=headers, stream=True, timeout=DEFAULT_TIMEOUT) as r:
        # Server may ignore Range and send the full file: detect via 200 vs 206
        if existing > 0 and r.status_code == 200:
            existing = 0  # server didn't honor range; restart
            mode = "wb"
        elif r.status_code == 206:
            mode = "ab"
        elif r.status_code == 200:
            mode = "wb"
        else:
            r.raise_for_status()
            return dest  # unreachable but quiets lint

        total = r.headers.get("Content-Length")
        total_bytes = (int(total) + existing) if total else None

        received = existing
        with open(dest, mode) as f:
            for chunk in r.iter_content(chunk_size=CHUNK_SIZE):
                if not chunk:
                    continue
                f.write(chunk)
                received += len(chunk)
                if on_progress:
                    on_progress(received, total_bytes)

    return dest


def iter_url_lines(
    url: str,
    headers: dict[str, str] | None = None,
    encoding: str = "utf-8",
) -> Iterable[str]:
    """
    Yield decoded lines from a streamed HTTP response without buffering the
    whole body to disk. Used for FL DOR's smaller per-county CSV files when
    we don't need on-disk caching.
    """
    with requests.get(url, headers=headers, stream=True, timeout=DEFAULT_TIMEOUT) as r:
        r.raise_for_status()
        for raw_line in r.iter_lines(decode_unicode=False):
            if raw_line is None:
                continue
            try:
                yield raw_line.decode(encoding)
            except UnicodeDecodeError:
                # Some county exports use latin-1 / cp1252
                yield raw_line.decode("latin-1", errors="replace")
