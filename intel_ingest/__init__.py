"""
Shared helpers for Dilly Intel public-data scrapers.

The scrapers (texas_cad_scraper.py, florida_dor_scraper.py, nc_onemap_scraper.py,
generic_gis_scraper.py) all need the same plumbing: streaming downloads,
chunked Supabase upserts, JSON-backed progress tracking, and property-use-code
classification.

Each scraper imports a small, focused subset:

    from intel_ingest.supabase_io import SupabaseUpserter
    from intel_ingest.http_stream import stream_download
    from intel_ingest.progress import Progress
    from intel_ingest.parsers import iter_csv, iter_pipe_delimited, iter_fixed_width
    from intel_ingest.property_codes import classify_tx_state_class, classify_fl_dor_uc, classify_nc_paruse
"""
from .supabase_io import SupabaseUpserter, MIN_BUILDING_SQFT
from .http_stream import stream_download, browser_headers
from .progress import Progress
from .property_codes import (
    classify_tx_state_class,
    classify_fl_dor_uc,
    classify_nc_paruse,
    classify_ar_parceltype,
    classify_oh_luc,
    classify_ga_lucode,
    classify_mo_class,
    classify_ms_cama,
    is_commercial_tx,
    is_commercial_fl,
    is_commercial_nc,
    is_commercial_oh,
    is_commercial_ga,
    is_commercial_mo,
    is_commercial_ms,
)

__all__ = [
    "SupabaseUpserter",
    "MIN_BUILDING_SQFT",
    "stream_download",
    "browser_headers",
    "Progress",
    "classify_tx_state_class",
    "classify_fl_dor_uc",
    "classify_nc_paruse",
    "classify_ar_parceltype",
    "classify_oh_luc",
    "classify_ga_lucode",
    "classify_mo_class",
    "classify_ms_cama",
    "is_commercial_tx",
    "is_commercial_fl",
    "is_commercial_nc",
    "is_commercial_oh",
    "is_commercial_ga",
    "is_commercial_mo",
    "is_commercial_ms",
]
