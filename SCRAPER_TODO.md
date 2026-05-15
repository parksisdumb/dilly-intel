# Public-Data Scraper Roadmap

Tracks the priority states still missing from `intel_properties`. Endpoints
verified May 2026; recheck before implementing — county GIS portals move
and rename services more than you'd think.

## Statewide shapefile sources — scripts ready, awaiting download

**Strategic insight:** statewide shapefile bulk downloads deliver
**10-100x more records** than the per-county ArcGIS REST scraping pattern
we've been using. FL DOR ships ~620k commercial parcels in one file,
NC OneMap ~72k, MS MARIS ~1.7M, TX TxGIO ~10M total parcels across the
state. This is the pattern to follow for remaining gap states (look for
state DOR / GIS office / land-records portals first, before falling
back to per-county REST).

| State | Coverage | Source | Scraper | Status |
|---|---|---|---|---|
| **MS — MARIS** | All 82 counties (~1.7M parcels) | Free statewide shapefile download (East + West halves) at `https://maris.mississippi.edu/MARISdata/Parcels/MS_StatewideParcels_Aug2024/` | `mississippi_maris_scraper.py` | **READY** — download the Aug 2024 (or later) East + West zips, unzip both into one directory, run with that path |
| **TX — TxGIO / TNRIS** | 245+ counties (~10M parcels) | **REST endpoint > shapefile downloads** — `https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/0` is public, no auth, serves the same standardized schema as the shapefiles and is filterable by FIPS server-side. Ships 2025 tax year data. | `generic_gis_scraper.py` presets `tx_txgio_*` | **HARRIS + BEXAR DONE 2026-05-12** (see "Done — TxGIO REST" below). The dedicated `texas_txgio_scraper.py` (shapefile-input mirror of MARIS) is built and committable as a fallback for offline ingestion, but the REST path is preferred and supersedes the shapefile-download flow. |

Both scrapers follow the same internal pattern: pyshp streaming +
pyproj reprojection of polygon centroids to WGS84 for free lat/lon,
field auto-discovery via FIELD_ALIASES, `--preview / --dry-run /
--limit / --resume / --reset` CLI. TxGIO has no `building_sqft`
column in its standardized schema, so it runs with
`enforce_sqft_min=False`.

## Done — TxGIO REST (2026-05-12 → 2026-05-14)

| County | source_detail | FIPS | Tax year | Ingested | Coords | Status |
|---|---|---|---:|---:|---:|---|
| Harris (Houston) | `tx_txgio_harris` | 48201 | 2025 | **~88,742** of ~88,954 commercial | ~100% | **DONE** — full county ingested. (First run hit one 500-record upsert-side `failed` batch; the earlier killed run's partial upserts appear to have covered it — `with_lat` exact count = 88,742 = the completed run's `kept`.) |
| Bexar (San Antonio) | `tx_txgio_bexar` | 48029 | 2025 | **26,494** of ~36,282 commercial (73%) | 100% | **PARTIAL — BLOCKED at offset ~26,500.** The TxGIO MapServer consistently returns `504 Gateway Time-out` *and* `500 Internal Server Error` on the result-set window starting at `resultOffset=26500` for the Bexar FIPS+commercial query — independent of `page_size` (tried 2000 and 500) and independent of `returnGeometry` (fails with it on AND off). Strongly suggests a poison record (corrupt geometry/attribute) in that ~500-1000-row window that crashes the service-side query planner. **~9,800 Bexar records remain.** |
| Travis (Austin) | `tx_txgio_travis` | 48453 | 2025 | 0 — **blocked** | — | Preset wired but `STAT_LAND_USE` is empty across all 834,936 Travis CAD records in the TxGIO normalized layer. **Next move**: either map `LOC_LAND_USE` (Travis-specific local codes — would need a small code lookup), or pull Travis from `traviscad.org` directly (separate scraper) and merge by parcel_id. |

### Bexar-tail blocker — recovery options (next session)

The `resultOffset`-based pagination in `generic_gis_scraper.py` can't get past the offset-26,500 poison window. Three ways forward, in order of robustness:

1. **Keyset pagination by OBJECTID** (proper fix): replace `resultOffset=N` with `WHERE ... AND OBJECTID > <last_max_objectid>`. Each page becomes O(page-size) regardless of depth, and — critically — when a single OBJECTID's record is poison, you can see exactly which one and `OBJECTID > <poison>+1` past it. Benefits every ArcGIS REST source, not just TxGIO. ~1-2 hrs of work + re-test.
2. **Manual OBJECTID-skip**: query the OBJECTID at Bexar offset 26,500, bump the progress file's `last_offset`, or add a one-off `WHERE OBJECTID NOT BETWEEN x AND y` to skip the poison window. Fast but hacky, and loses whatever real records are in the skipped window.
3. **Split the WHERE by use-code prefix**: run Bexar as 4 sub-passes (`F%`, `B%`, `L%`, `J%`). The poison record lands in exactly one prefix bucket; the other 3 ingest clean, and the offsets stay shallower. Doesn't fully solve if the poison is in the dominant `F%` bucket.

Recommended: **option 1** — it's the durable fix and de-risks every future deep-pagination ArcGIS run (Cook universe, OH counties, etc. could hit the same wall).

**Operational notes for adding more TX counties via TxGIO REST:**
- Same MapServer URL — no per-county service to discover.
- One-line change to add a county: copy the `tx_txgio_harris` preset in `generic_gis_scraper.py`, swap FIPS in the WHERE clause, rename `source_detail`, drop in a new `progress_*.json` filename.
- `enforce_sqft_min=False` is set automatically by `state_abbr.startswith("TX-TXGIO")`.
- Geometry centroids are requested in `outSR=4326`, so polygon rings come back as WGS84 lon/lat — no reprojection needed.
- **`page_size=500`** on all TxGIO presets (not the 2000 service max) — geometry-heavy pages at 2000 reliably 504 the gateway.
- **`--no-geometry`** CLI flag added: forces `returnGeometry=false` on any preset, for when a gateway 504s on geometry payloads (records ingest with NULL lat/lon, backfill later via `geocoder.py`). Did not help the Bexar-tail blocker because that's a server-side query crash, not a payload-size problem.
- Per-county counts confirmed via `?where=FIPS='<fips>'&returnCountOnly=true`.
- Run with `python -u` — `generic_gis_scraper.py`'s progress-print volume is small enough that block-buffered stdout never flushes to a redirected file until process exit.

**Next-tier county expansion candidates (TxGIO REST, all FIPS verified):**

| County | FIPS | Total parcels (TxGIO) | Notes |
|---|---|---:|---|
| El Paso | 48141 | check via REST | Border metro, ~900k population |
| Hidalgo | 48215 | check via REST | RGV / McAllen metro |
| Collin | 48085 | check via REST | Dallas-north suburbs (Plano, Frisco, McKinney) |
| Denton | 48121 | check via REST | Dallas-north suburbs (Denton, Frisco-W) |
| Williamson | 48491 | check via REST | Austin-north metro (Round Rock, Cedar Park, Georgetown) |

Each follows the same recipe — verify `FIPS='<code>'` count and STAT_LAND_USE populated before adding, then drop in a preset.

## Pattern matrix

| State / county | API type | Difficulty | Notes |
|---|---|---|---|
| **AL — Jefferson Co (Birmingham)** | ArcGIS REST | Medium | Public portal moved as of 2026 — old `gisweb.jccal.org` refused connection. New hub is `data-jeffco-al.opendata.arcgis.com` (ArcGIS Online). Browse it for the parcel feature layer; the county adopted the ArcGIS Parcel Fabric in 2024 and remapped all 320k parcels. Field layout will be the standard Parcel Fabric (PARCEL_ID, OWNER_NAME, SITE_ADDR, etc.) — verify in next session. |
| **MO — St Louis City** | ArcGIS REST (NOT Socrata) | **Blocked on classification** | Investigated 2026-05-09. Endpoint at `maps8.stlouis-mo.gov/arcgis/rest/services/ASSESSOR/Assessor_Public_Parcels/MapServer/11`. Has owner+address+sqft+value+class. **But:** PropertyClassCode values 11-19 dominate (residential subclasses); no values >= 30 found in 135k rows even though MO statute defines Classes 1-4 with Class 3 = Commercial. The actual code system appears to be assessor-specific. **Need a code-system lookup or example commercial PCC values from the assessor before this can ship.** Field map ready (see `_unused_map_mo_stlouis_city_feature` in generic_gis_scraper.py); just blocked on the classifier. |
| **MO — St Louis County** | ArcGIS REST | Medium | Separate from the city. Try `https://maps.stlouisco.com/arcgis/rest/services` — the property layer commonly used is `Geometric/PropertyMap/MapServer`. |
| **OK — Oklahoma County** | ArcGIS REST or Open Data | Medium | `https://data.oklahomacounty.org/` is the open-data portal; underlying ArcGIS layer is what we want. The Assessor publishes parcels separately at `https://www.oklahomacounty.org/assessor`. |
| **KY — Jefferson Co (Louisville)** | ArcGIS Hub (NOT Socrata) | **Blocked at open-data tier** | Investigated 2026-05-06. The portal at `data.louisvilleky.gov` is built on ArcGIS Hub, not Socrata. The published parcels layer at `gis.lojic.org/maps/rest/services/PvaGis/CamaViewer/MapServer/26` is **geometry-only** — only `PARCELID, CLASS, BLOCK, LOT, UNIT_COUNT, etc.` are exposed. No owner_name, address, sqft, or values in the open tier. Full PVA data appears to require paid LOJIC access. **Skip until alternate source identified** (e.g., scrape the per-parcel detail pages off `apps.lojic.org/lojiconline/`). |
| **SC — Statewide (RFA)** | Possibly closed | Hard | The Revenue & Fiscal Affairs office aggregates parcel data but distribution is inconsistent. Per-county is more reliable: Charleston, Richland, Greenville. |
| **LA — Orleans Parish** | Web portal | Hard | `nolaassessor.com` — no public REST API documented. Either screen-scrape or contact for bulk export. |
| **LA — Jefferson Parish** | Web portal | Hard | Similar to Orleans — no public API. |
| **MS — Hinds County (Jackson)** | Likely none | Hard | No stable public REST endpoint found as of May 2026. The state's MARIS service has been intermittent. Park this one. |

## GA expansion findings (investigated 2026-05-09)

| County | Endpoint | Status |
|---|---|---|
| **DeKalb** (east Atlanta + Decatur) | `dcgis.dekalbcountyga.gov/hosted/rest/services/Parcels/MapServer/0` | **Blocked at open-data tier**: 245k records, owner+address+value populated but `BLDGAREA / CLASSCD / USECD / LANDUSE` are ALL NULL. Can't classify commercial vs residential without owner-name heuristics. Field map staged (`_unused_map_ga_dekalb_feature`). Revisit with owner-suffix filtering — likely yields ~50k commercial-likely records but quality will be lower than Fulton. |
| **Gwinnett** (NE Atlanta metro) | `services3.arcgis.com/RfpmnkSAQleRbndX/.../Property_and_Tax/FeatureServer/0` | **Blocked**: geometry-only on the open tier. Has PIN, ADDRESS, PARCELTYPE, ACREAGE only — no owner, sqft, year, or value fields. Equivalent to Louisville KY situation. |
| **Cobb** (NW Atlanta metro) | `geo-cobbcountyga.opendata.arcgis.com` | **Needs investigation**: hub site found but the ArcGIS Online viewer item (`e22d8c597b4e4762bcd2caa6127696e4`) doesn't expose a backing FeatureServer URL via the standard hub API. Try direct probing of `services{1..9}.arcgis.com/{orgId}/...` or contact `cobbassessor.org`. |

## Oklahoma County (investigated 2026-05-09)

`ok-county-gis-hub-ok-co.hub.arcgis.com/datasets/tax-parcels-public` — the about page didn't expose a backing FeatureServer URL via the standard hub-API path. Per the Esri case study the parcel system covers ~325k parcels via Patriot Properties CAMA. **Need either the Hub item ID resolved to a FeatureServer URL, or a working dataset-export link, before this can ship.**

## Recommended next session order

1. **KY Louisville** — Socrata, easy add to `cook_county_scraper.py` pattern (rename file/dataset). The Cook scraper already shows how to join two Socrata datasets if needed.
2. **AL Jefferson (Birmingham)** — fits straight into `generic_gis_scraper.py` as a new state preset once the layer + field map is confirmed.
3. **OK Oklahoma County** — also a `generic_gis_scraper.py` preset.
4. **MO St Louis City + County** — two presets, similar flow.
5. **SC counties (Charleston, Richland, Greenville)** — three more `generic_gis_scraper.py` presets.

## Already shipped (this session)

| State / county | source_detail | Mechanism | Notes |
|---|---|---|---|
| IL — Cook | `cook_county_il_public` | Socrata (csik-bsws + 3723-97qp join) | Dedicated `cook_county_scraper.py`. PINs are 14 digits with leading zeros. ORDER+IN combo returns 400 — sort client-side. |
| OH — Cuyahoga | `oh_cuyahoga_public` | ArcGIS MyPLACE layer 2 | Preset `oh_cuyahoga` in generic_gis_scraper. Field naming is lowercase; `tax_luc_description` text gives the cleanest bucket signal. |
| OH — Franklin | `oh_franklin_public` | ArcGIS Tax Parcel layer 0 | Preset `oh_franklin`. City pulled from `PSTLCITYSTZIP` — defaults to "Columbus" if parse fails. maxRecordCount=3000. |
| GA — Fulton | `ga_fulton_public` | ArcGIS Tax_Parcels FeatureServer/0 | Preset `ga_fulton`. **No bldg sqft published** — records ingest with NULL building_sqft. City defaults to "Atlanta" since the dataset has no per-parcel city. Geocode to refine downstream. |
| AR — statewide | `ar_gis_public` | Already shipped earlier | — |
| TX — DCAD/TAD/HCAD | `tx_cad_*` | Already shipped earlier | — |
| FL — DOR | `fl_dor_public` | Already shipped earlier | — |
| NC — OneMap | `nc_onemap_public` | Already shipped earlier | — |

## Operational notes

- **Socrata App Token**: setting `SOCRATA_APP_TOKEN` in `.env.local` raises rate limits dramatically (1k/day anonymous → much higher). Get one at https://opendata.socrata.com/profile/app_tokens. Worth it before any large Socrata-based run.
- **`assessed_value` is INTEGER-typed** in our schema; `estimated_value` is numeric. Always pass int through for the former. AR/Cook/OH all follow this convention.
- **`SupabaseUpserter` skips rows with `building_sqft < 1500`** but passes through rows where `building_sqft IS NULL`. Useful for GA-Fulton-style sources without sqft.
- **Resume + reset flags** on every scraper. Use `--reset` to clear state, `--resume` after a crash.
