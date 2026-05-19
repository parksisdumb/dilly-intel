"use client"

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { StatsBar } from "./components/StatsBar"
import { FilterSidebar, type Filters } from "./components/FilterSidebar"
import { PropertyCard, PropertyCardSkeleton } from "./components/PropertyCard"
import { PropertyDetailPanel } from "./components/PropertyDetailPanel"
import {
  PortfolioDetailPanel,
  type PortfolioPanelInput,
} from "./components/PortfolioDetailPanel"
import type { ApiResponse, Property, Stats } from "./types"

const SQFT_MIN = 1500
const SQFT_MAX = 500_000
const PER_PAGE = 24
const DEFAULT_RADIUS_MILES = 25

function parseFilters(sp: URLSearchParams): Filters {
  const types = sp.get("property_types")
  return {
    search: sp.get("search") ?? "",
    state: sp.get("state") ?? "",
    county: sp.get("county") ?? "",
    propertyTypes: types ? types.split(",").filter(Boolean) : [],
    minSqft: parseIntDefault(sp.get("min_sqft"), SQFT_MIN),
    maxSqft: parseIntDefault(sp.get("max_sqft"), SQFT_MAX),
    ownerType: (sp.get("owner_type") ?? "all") as Filters["ownerType"],
    portfolioMatch: (sp.get("portfolio_match") ?? "all") as Filters["portfolioMatch"],
    minYear: sp.get("min_year") ?? "",
    maxYear: sp.get("max_year") ?? "",
    minValue: sp.get("min_value") ?? "",
    maxValue: sp.get("max_value") ?? "",
    nearAddress: sp.get("near") ?? "",
    radiusMiles: parseIntDefault(sp.get("radius_miles"), DEFAULT_RADIUS_MILES),
  }
}

function parseIntDefault(v: string | null, fallback: number): number {
  if (!v) return fallback
  const n = parseInt(v, 10)
  return isNaN(n) ? fallback : n
}

function filtersToParams(f: Filters, page: number): URLSearchParams {
  const sp = new URLSearchParams()
  if (f.search) sp.set("search", f.search)
  if (f.state) sp.set("state", f.state)
  if (f.county) sp.set("county", f.county)
  if (f.propertyTypes.length > 0) sp.set("property_types", f.propertyTypes.join(","))
  if (f.minSqft !== SQFT_MIN) sp.set("min_sqft", String(f.minSqft))
  if (f.maxSqft !== SQFT_MAX) sp.set("max_sqft", String(f.maxSqft))
  if (f.ownerType !== "all") sp.set("owner_type", f.ownerType)
  if (f.portfolioMatch !== "all") sp.set("portfolio_match", f.portfolioMatch)
  if (f.minYear) sp.set("min_year", f.minYear)
  if (f.maxYear) sp.set("max_year", f.maxYear)
  if (f.minValue) sp.set("min_value", f.minValue)
  if (f.maxValue) sp.set("max_value", f.maxValue)
  if (f.nearAddress) sp.set("near", f.nearAddress)
  if (f.radiusMiles !== DEFAULT_RADIUS_MILES) sp.set("radius_miles", String(f.radiusMiles))
  if (page > 1) sp.set("page", String(page))
  return sp
}

/**
 * Build the API call URL from filters. The `search` field is sent as-is
 * to the API which has the same parser; a literal "lat,lon" in
 * nearAddress gets unpacked into ?lat=&lon= here so the API can engage
 * the radius bounding-box pre-filter without re-geocoding.
 */
function filtersToApiParams(f: Filters, page: number): URLSearchParams {
  const sp = new URLSearchParams()
  if (f.search) sp.set("search", f.search)
  if (f.state) sp.set("state", f.state)
  if (f.county) sp.set("county", f.county)
  if (f.propertyTypes.length > 0) sp.set("property_types", f.propertyTypes.join(","))
  if (f.minSqft !== SQFT_MIN) sp.set("min_sqft", String(f.minSqft))
  if (f.maxSqft !== SQFT_MAX) sp.set("max_sqft", String(f.maxSqft))
  if (f.ownerType !== "all") sp.set("owner_type", f.ownerType)
  if (f.portfolioMatch !== "all") sp.set("portfolio_match", f.portfolioMatch)
  if (f.minYear) sp.set("min_year", f.minYear)
  if (f.maxYear) sp.set("max_year", f.maxYear)
  if (f.minValue) sp.set("min_value", f.minValue)
  if (f.maxValue) sp.set("max_value", f.maxValue)
  if (f.nearAddress) {
    // "lat,lon" form goes straight to the radius API params; otherwise
    // we'd need to geocode here (deferred until radius UI is enabled).
    const m = f.nearAddress.trim().match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/)
    if (m) {
      sp.set("lat", m[1])
      sp.set("lon", m[2])
      sp.set("radius_miles", String(f.radiusMiles))
    }
  }
  sp.set("page", String(page))
  sp.set("per_page", String(PER_PAGE))
  return sp
}

export default function IntelligencePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center text-[var(--intel-text-muted)]">
          loading…
        </div>
      }
    >
      <IntelligencePageInner />
    </Suspense>
  )
}

function IntelligencePageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // Hydrate filters + page from URL on mount and on back/forward.
  const initialFilters = useMemo(() => parseFilters(new URLSearchParams(searchParams.toString())), [searchParams])
  const initialPage = useMemo(() => parseIntDefault(searchParams.get("page"), 1), [searchParams])

  const [filters, setFilters] = useState<Filters>(initialFilters)
  const [page, setPage] = useState(initialPage)

  const [properties, setProperties] = useState<Property[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  // Loading defaults to false. We only flip it on when a state filter is
  // present and a fetch actually fires — without a state we render the
  // "Select a state" prompt instead of a spinner forever.
  const [loading, setLoading] = useState(!!initialFilters.state)
  const [error, setError] = useState<string | null>(null)

  const [detailProperty, setDetailProperty] = useState<Property | null>(null)
  // Portfolio panel: opens when the user clicks an owner name on a card.
  // We pre-fill mailing-address + owner-name so the panel's API call can
  // pull "every property at this address" without a round trip to figure
  // out which addresses to query.
  const [portfolioInput, setPortfolioInput] = useState<PortfolioPanelInput | null>(null)
  const debounceRef = useRef<number | null>(null)
  const reqIdRef = useRef(0)

  // Push filter+page state into URL.
  const syncUrl = useCallback(
    (f: Filters, p: number) => {
      const sp = filtersToParams(f, p)
      const qs = sp.toString()
      const url = qs ? `/intelligence?${qs}` : "/intelligence"
      router.replace(url, { scroll: false })
    },
    [router]
  )

  // Fetch data for current filters/page.
  const fetchData = useCallback(async (f: Filters, p: number) => {
    const myReqId = ++reqIdRef.current
    setLoading(true)
    setError(null)
    try {
      const sp = filtersToApiParams(f, p)
      const res = await fetch(`/api/intelligence/properties?${sp.toString()}`)
      const json = (await res.json()) as ApiResponse
      // Drop stale responses
      if (myReqId !== reqIdRef.current) return
      if (json.error) {
        setError(json.error)
        setProperties([])
        setStats(null)
        setTotal(0)
        setPages(1)
      } else {
        setProperties(json.properties)
        setStats(json.stats)
        setTotal(json.total)
        setPages(json.pages)
        setLastUpdated(json.last_updated)
      }
    } catch (e: unknown) {
      if (myReqId !== reqIdRef.current) return
      setError(e instanceof Error ? e.message : "Failed to load")
    } finally {
      if (myReqId === reqIdRef.current) setLoading(false)
    }
  }, [])

  // Initial + every-time-filter-or-page-changes fetch.
  //
  // Hard requirement: a state filter MUST be present before we fire the
  // /api/intelligence/properties call. Without it the API hits the
  // unfiltered 1.1M-row code path which times out on the planner-budget
  // we operate under. The UI shows the "Select a state" prompt below
  // until the user (or a URL param) provides one.
  const propertyTypesKey = filters.propertyTypes.join(",")
  useEffect(() => {
    if (!filters.state) {
      // Reset result-y state so leftovers from a prior search don't
      // bleed through into the empty-state view.
      setLoading(false)
      setProperties([])
      setStats(null)
      setTotal(0)
      setPages(1)
      setLastUpdated(null)
      setError(null)
      syncUrl(filters, page)
      return
    }
    fetchData(filters, page)
    syncUrl(filters, page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters.search,
    filters.state,
    filters.county,
    propertyTypesKey,
    filters.minSqft,
    filters.maxSqft,
    filters.ownerType,
    filters.portfolioMatch,
    filters.minYear,
    filters.maxYear,
    filters.minValue,
    filters.maxValue,
    filters.nearAddress,
    filters.radiusMiles,
    page,
  ])

  function handleApply(f: Filters) {
    setPage(1)
    setFilters(f)
  }

  function handleClear() {
    const cleared: Filters = {
      search: "",
      state: "",
      county: "",
      propertyTypes: [],
      minSqft: SQFT_MIN,
      maxSqft: SQFT_MAX,
      ownerType: "all",
      portfolioMatch: "all",
      minYear: "",
      maxYear: "",
      minValue: "",
      maxValue: "",
      nearAddress: "",
      radiusMiles: DEFAULT_RADIUS_MILES,
    }
    setPage(1)
    setFilters(cleared)
  }

  function handleSearchChange(v: string) {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      setPage(1)
      setFilters((f) => ({ ...f, search: v }))
    }, 300)
  }

  return (
    <div className="flex h-screen flex-col">
      <StatsBar stats={stats} loading={loading && !stats} lastUpdated={lastUpdated} />

      <div className="flex flex-1 overflow-hidden">
        <FilterSidebar
          initial={filters}
          onApply={handleApply}
          onSearchChange={handleSearchChange}
          onClear={handleClear}
          stateRequired
        />

        <main className="flex-1 overflow-y-auto px-6 py-5">
          <ResultsHeader
            page={page}
            perPage={PER_PAGE}
            total={total}
            loading={loading}
            stateSelected={!!filters.state}
            exportHref={
              filters.state
                ? `/api/intelligence/properties/export?${filtersToApiParams(filters, 1).toString()}`
                : null
            }
          />

          {error && (
            <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-[12px] text-red-400">
              {error}
            </div>
          )}

          {!filters.state ? (
            <SelectStatePrompt />
          ) : loading && properties.length === 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: PER_PAGE }).map((_, i) => (
                <PropertyCardSkeleton key={i} />
              ))}
            </div>
          ) : properties.length > 0 ? (
            <div
              className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 ${
                loading ? "opacity-60" : ""
              } transition-opacity`}
            >
              {properties.map((p) => (
                <PropertyCard
                  key={p.id}
                  property={p}
                  onViewDetails={() => setDetailProperty(p)}
                  onViewPortfolio={
                    p.owner_name && filters.state
                      ? () =>
                          setPortfolioInput({
                            display_name: p.entity?.name ?? p.owner_name ?? "Owner",
                            label_type: p.entity ? "entity" : "individual",
                            state: filters.state,
                            primary_mailing_address: p.owner_mailing_address,
                            mailing_addresses: p.owner_mailing_address
                              ? [p.owner_mailing_address]
                              : [],
                            owner_name: p.owner_name,
                            entity_id: p.entity?.id ?? null,
                            entity_name: p.entity?.name ?? null,
                            entity_ticker: p.entity?.ticker ?? null,
                          })
                      : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <EmptyState onClear={handleClear} />
          )}

          <Pagination
            page={page}
            pages={pages}
            onChange={(newPage) => {
              setPage(newPage)
              window.scrollTo({ top: 0, behavior: "smooth" })
            }}
          />

          <Footer />
        </main>
      </div>

      {/* Portfolio panel renders first so the property panel slides on
         top of it when the user drills from a portfolio row to one of
         its properties. The property panel takes precedence on ESC. */}
      {portfolioInput && (
        <PortfolioDetailPanel
          input={portfolioInput}
          onClose={() => setPortfolioInput(null)}
        />
      )}
      {detailProperty && (
        <PropertyDetailPanel property={detailProperty} onClose={() => setDetailProperty(null)} />
      )}
    </div>
  )
}

function ResultsHeader({
  page,
  perPage,
  total,
  loading,
  stateSelected,
  exportHref,
}: {
  page: number
  perPage: number
  total: number
  loading: boolean
  stateSelected: boolean
  exportHref: string | null
}) {
  if (total === 0) {
    return (
      <div className="mb-4 text-[11px] uppercase tracking-widest text-[var(--intel-text-muted)]">
        {!stateSelected
          ? "select a state to begin"
          : loading
            ? "loading properties…"
            : "no results"}
      </div>
    )
  }
  const from = (page - 1) * perPage + 1
  const to = Math.min(page * perPage, total)
  return (
    <div className="mb-4 flex items-baseline justify-between">
      <div className="text-[11px] uppercase tracking-widest text-[var(--intel-text-muted)]">
        showing{" "}
        <span data-mono className="text-[var(--intel-text)]">
          {from.toLocaleString()}–{to.toLocaleString()}
        </span>{" "}
        of{" "}
        <span data-mono className="text-[var(--intel-text)]">
          {total.toLocaleString()}
        </span>{" "}
        properties
      </div>
      <div className="flex items-baseline gap-4">
        {exportHref && (
          <a
            href={exportHref}
            className="rounded-md border border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--intel-accent)] transition-colors hover:bg-[var(--intel-accent)] hover:text-[var(--intel-bg)]"
            title="Download up to 10,000 matching properties as CSV"
          >
            ↓ export csv
          </a>
        )}
        <div className="text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
          sorted by building size
        </div>
      </div>
    </div>
  )
}

function Pagination({
  page,
  pages,
  onChange,
}: {
  page: number
  pages: number
  onChange: (p: number) => void
}) {
  if (pages <= 1) return null

  // Build a compact page list: 1 ... p-1 p p+1 ... last
  const items: (number | "…")[] = []
  const add = (n: number) => {
    if (!items.includes(n) && n >= 1 && n <= pages) items.push(n)
  }
  add(1)
  if (page - 2 > 2) items.push("…")
  for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) add(i)
  if (page + 2 < pages - 1) items.push("…")
  if (pages > 1) add(pages)

  return (
    <div className="mt-8 flex items-center justify-center gap-1">
      <PaginationBtn disabled={page <= 1} onClick={() => onChange(page - 1)}>
        ← Prev
      </PaginationBtn>
      {items.map((it, i) =>
        it === "…" ? (
          <span key={`e${i}`} className="px-2 text-[var(--intel-text-dim)]">
            …
          </span>
        ) : (
          <button
            key={it}
            onClick={() => onChange(it)}
            data-mono
            className={`min-w-[34px] rounded px-2.5 py-1.5 text-[12px] transition-colors ${
              it === page
                ? "bg-[var(--intel-accent)] text-[var(--intel-bg)]"
                : "text-[var(--intel-text-muted)] hover:bg-[var(--intel-bg-elev)] hover:text-[var(--intel-text)]"
            }`}
          >
            {it}
          </button>
        )
      )}
      <PaginationBtn disabled={page >= pages} onClick={() => onChange(page + 1)}>
        Next →
      </PaginationBtn>
    </div>
  )
}

function PaginationBtn({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="rounded px-3 py-1.5 text-[11px] uppercase tracking-widest text-[var(--intel-text-muted)] transition-colors hover:bg-[var(--intel-bg-elev)] hover:text-[var(--intel-text)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--intel-text-muted)]"
    >
      {children}
    </button>
  )
}

function SelectStatePrompt() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--intel-border)] bg-[var(--intel-bg-elev)] py-24">
      <div className="text-[var(--intel-text-dim)]">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      </div>
      <div className="mt-3 text-[14px] font-medium text-[var(--intel-text)]">
        Select a state to begin browsing properties
      </div>
      <div className="mt-1 max-w-sm text-center text-[12px] text-[var(--intel-text-muted)]">
        We hold ~1.1M commercial property records across the country — pick a state on the left to scope your search.
      </div>
    </div>
  )
}

function EmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--intel-border)] bg-[var(--intel-bg-elev)] py-20">
      <div className="text-[var(--intel-text-dim)]">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </div>
      <div className="mt-3 text-[14px] font-medium text-[var(--intel-text)]">No properties match these filters</div>
      <div className="mt-1 text-[12px] text-[var(--intel-text-muted)]">
        Try widening size range, removing property types, or clearing search.
      </div>
      <button
        onClick={onClear}
        className="mt-4 rounded border border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--intel-accent)] transition-colors hover:bg-[var(--intel-accent)] hover:text-[var(--intel-bg)]"
      >
        clear all filters
      </button>
    </div>
  )
}

function Footer() {
  return (
    <div className="mt-10 flex items-center justify-between border-t border-[var(--intel-border)] pt-4 text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
      <span>dilly intel · property intelligence</span>
      <Link href="/ops" className="transition-colors hover:text-[var(--intel-accent)]">
        ops dashboard →
      </Link>
    </div>
  )
}
