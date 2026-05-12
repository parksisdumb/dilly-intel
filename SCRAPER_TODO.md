# Public-Data Scraper Roadmap

Tracks the priority states still missing from `intel_properties`. Endpoints
verified May 2026; recheck before implementing — county GIS portals move
and rename services more than you'd think.

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
