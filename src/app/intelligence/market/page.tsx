"use client"

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { CountUp } from "../components/CountUp"
import {
  PortfolioDetailPanel,
  type PortfolioPanelInput,
} from "../components/PortfolioDetailPanel"
import { rollupCategory } from "@/lib/intel/property-types"

type Owner = {
  raw_owner_name: string
  entity_id: string | null
  entity_name: string | null
  entity_ticker: string | null
  property_count: number
  total_sqft: number | null
  total_value: number | null
  avg_sqft: number | null
}

type PortfolioOwner = {
  // Display label per /api/intelligence/market/portfolios' priority logic:
  //   entity > stem > individual > address. The page renders this verbatim;
  //   the underlying mailing-address / LLC details are still available for
  //   the expandable detail panel.
  display_name: string
  label_type: "entity" | "stem" | "individual" | "address" | "manual"
  stem: string | null
  entity_id: string | null
  entity_name: string | null
  entity_ticker: string | null
  property_count: number
  llc_count: number
  total_sqft: number | null
  total_value: number | null
  llc_names: string[]
  mailing_address: string
  mailing_city: string | null
  mailing_state: string | null
  mailing_zip: string | null
  mailing_addresses: Array<{
    address: string
    city: string | null
    state: string | null
    zip: string | null
    property_count: number
  }>
  // True when the pre-stem gov-LLC scrub pro-rated the property_count.
  // Used to mark the row with an "est." badge — the detail panel
  // re-queries with gov filtering and shows the exact figure.
  gov_adjusted: boolean
  // True when the cluster matches institutional-healthcare patterns
  // (hospital systems / medical centers). Rendered as a small badge —
  // the cluster stays visible but the user knows it's a hospital
  // campus rather than a typical commercial portfolio.
  is_healthcare_institution: boolean
}

type MarketResponse = {
  filters: {
    city: string | null
    state: string | null
    zip: string | null
    hide_gov?: boolean
    property_type?: string | null
  }
  summary: {
    total: number
    by_type: { bucket: string; count: number }[]
    by_type_rollup?: { bucket: string; count: number }[]
    ownership: { corporate: number; individual: number; unknown: number }
    ownership_raw?: { corporate: number; individual: number; unknown: number }
    corporate_pct: number
    corporate_pct_reliable?: boolean
    corporate_pct_estimated?: boolean
    matched: { matched: number; unmatched: number }
    // Data-coverage counts for the ownership panel. Null when the
    // server-side count query failed — UI renders "—" in that case.
    owner_name_count: number | null
    mailing_address_count: number | null
    // Market-sizing aggregates for the top KPI strip. Null when the
    // extended intel_market_summary migration hasn't run yet or when
    // the records in scope don't carry the value.
    total_sqft: number | null
    total_value: number | null
    avg_year_built: number | null
  }
  concentration: {
    total_market_count: number
    total_owners_count: number
    top_10_property_count: number
    top_10_pct: number
  }
  top_owners_by_count: Owner[]
  top_owners_by_sqft: Owner[]
  // portfolio_owners is now fetched from /api/intelligence/market/portfolios
  // — see the separate request kicked off in MarketPageInner.
  error?: string
}

type PortfoliosResponse = {
  portfolio_owners: PortfolioOwner[]
  portfolio_property_count?: number
  distinct_portfolio_count?: number
  error?: string
}

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
]

export default function MarketPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center text-[var(--intel-text-muted)]">
          loading…
        </div>
      }
    >
      <MarketPageInner />
    </Suspense>
  )
}

function MarketPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [search, setSearch] = useState(searchParams.get("search") || "")
  const [state, setState] = useState(searchParams.get("state") || "")
  // Hide-government toggle defaults ON. URL `?hide_gov=false` disables.
  const [hideGov, setHideGov] = useState(
    (searchParams.get("hide_gov") ?? "true").toLowerCase() !== "false"
  )
  // Property-type filter. "" = whole market. Clicking a row in the type
  // breakdown sets this and re-fetches everything scoped to that type —
  // it filters the market page in place rather than navigating away.
  const [selectedType, setSelectedType] = useState(
    searchParams.get("property_type") || ""
  )
  const [data, setData] = useState<MarketResponse | null>(null)
  // Loading starts true only when a state is already in the URL. With no
  // state we render the "Select a state" gate instead of a spinner — and
  // crucially fire zero API calls (see the fetch effect below).
  const [loading, setLoading] = useState(!!(searchParams.get("state") || ""))
  const [error, setError] = useState<string | null>(null)

  // Portfolios are loaded from a separate endpoint — heaviest GROUP BY
  // in the dashboard, kept off the critical path so the headline KPIs
  // and owner tables render without waiting on it.
  const [portfolios, setPortfolios] = useState<PortfolioOwner[]>([])
  // Headline counts derived from the full labeled portfolio set on the
  // server (NOT the top-50 display slice). Null while the portfolios
  // request is in flight — the ownership panel shows a placeholder.
  const [portfolioPropertyCount, setPortfolioPropertyCount] = useState<number | null>(null)
  const [distinctPortfolioCount, setDistinctPortfolioCount] = useState<number | null>(null)
  const [portfoliosLoading, setPortfoliosLoading] = useState(false)
  const [portfoliosError, setPortfoliosError] = useState<string | null>(null)

  const reqIdRef = useRef(0)
  const portfolioReqIdRef = useRef(0)
  const debounceRef = useRef<number | null>(null)

  // Detail panel: opened by clicking a row in either the portfolio table
  // or the legacy raw-owner tables. The panel does its own fetch against
  // /api/intelligence/portfolios/[id]; we just hand it the cluster shape.
  const [panelInput, setPanelInput] = useState<PortfolioPanelInput | null>(null)

  const fetchData = useCallback(
    async (s: string, st: string, hg: boolean, pt: string) => {
    const myReqId = ++reqIdRef.current
    setLoading(true)
    setError(null)
    const sp = new URLSearchParams()
    if (s) sp.set("search", s)
    if (st) sp.set("state", st)
    sp.set("hide_gov", hg ? "true" : "false")
    if (pt) sp.set("property_type", pt)
    try {
      const res = await fetch(`/api/intelligence/market?${sp.toString()}`)
      const json = (await res.json()) as MarketResponse
      if (myReqId !== reqIdRef.current) return
      if (json.error) setError(json.error)
      else setData(json)
    } catch (e: unknown) {
      if (myReqId !== reqIdRef.current) return
      setError(e instanceof Error ? e.message : "Failed to load")
    } finally {
      if (myReqId === reqIdRef.current) setLoading(false)
    }
  }, [])

  const fetchPortfolios = useCallback(
    async (s: string, st: string, hg: boolean, pt: string) => {
      const myReqId = ++portfolioReqIdRef.current
      setPortfoliosLoading(true)
      setPortfoliosError(null)
      setPortfolios([])
      setPortfolioPropertyCount(null)
      setDistinctPortfolioCount(null)
      const sp = new URLSearchParams()
      if (s) sp.set("search", s)
      if (st) sp.set("state", st)
      sp.set("hide_gov", hg ? "true" : "false")
      if (pt) sp.set("property_type", pt)
      try {
        const res = await fetch(`/api/intelligence/market/portfolios?${sp.toString()}`)
        const json = (await res.json()) as PortfoliosResponse
        if (myReqId !== portfolioReqIdRef.current) return
        if (json.error) setPortfoliosError(json.error)
        setPortfolios(json.portfolio_owners ?? [])
        setPortfolioPropertyCount(json.portfolio_property_count ?? null)
        setDistinctPortfolioCount(json.distinct_portfolio_count ?? null)
      } catch (e: unknown) {
        if (myReqId !== portfolioReqIdRef.current) return
        setPortfoliosError(e instanceof Error ? e.message : "Failed to load portfolios")
      } finally {
        if (myReqId === portfolioReqIdRef.current) setPortfoliosLoading(false)
      }
    },
    []
  )

  // Update URL params, debounced
  const syncUrl = useCallback(
    (s: string, st: string, hg: boolean, pt: string) => {
      const sp = new URLSearchParams()
      if (s) sp.set("search", s)
      if (st) sp.set("state", st)
      // Only persist hide_gov when it differs from the default (ON)
      if (!hg) sp.set("hide_gov", "false")
      if (pt) sp.set("property_type", pt)
      const qs = sp.toString()
      router.replace(qs ? `/intelligence/market?${qs}` : "/intelligence/market", {
        scroll: false,
      })
    },
    [router]
  )

  useEffect(() => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      // Hard requirement: a state MUST be selected before we hit either
      // endpoint. An unfiltered market query scans all ~1.1M rows and
      // trips "canceling statement due to statement timeout". With no
      // state we fire NOTHING — reset result state so a prior search
      // doesn't bleed through, sync the URL, and let the render show
      // the "Select a state" gate.
      if (!state) {
        setLoading(false)
        setError(null)
        setData(null)
        setPortfolios([])
        setPortfolioPropertyCount(null)
        setDistinctPortfolioCount(null)
        setPortfoliosLoading(false)
        setPortfoliosError(null)
        syncUrl(search, state, hideGov, selectedType)
        return
      }
      // Fire both in parallel — they're independent endpoints. The
      // page renders progressively as each lands.
      fetchData(search, state, hideGov, selectedType)
      fetchPortfolios(search, state, hideGov, selectedType)
      syncUrl(search, state, hideGov, selectedType)
    }, 300)
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    }
  }, [search, state, hideGov, selectedType, fetchData, fetchPortfolios, syncUrl])

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <FilterBar
        search={search}
        state={state}
        hideGov={hideGov}
        onSearch={setSearch}
        onState={setState}
        onHideGovChange={setHideGov}
      />

      <main className="flex-1 overflow-y-auto px-6 py-6">
        {error && (
          <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-[12px] text-red-400">
            {error}
          </div>
        )}

        {/* State gate: with no state selected we render NOTHING that
            triggers a database query — no KPIs, charts, owner tables, or
            portfolio section. An unfiltered market query times out. */}
        {!state ? (
          <SelectStatePrompt />
        ) : (
          <>
            {/* Active property-type filter banner */}
            {selectedType && (
              <TypeFilterBanner
                type={selectedType}
                count={data?.summary.total ?? null}
                loading={loading}
                propertiesHref={(() => {
                  const sp = new URLSearchParams()
                  if (state) sp.set("state", state)
                  if (search) sp.set("search", search)
                  sp.set("property_types", selectedType)
                  return `/intelligence?${sp.toString()}`
                })()}
                onClear={() => setSelectedType("")}
              />
            )}

            {/* Top KPI strip */}
            <KpiStrip data={data} loading={loading} />

            {/* Type breakdown + ownership split */}
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <TypeBreakdown
                data={data}
                loading={loading}
                selectedType={selectedType}
                onSelectType={(t) =>
                  setSelectedType((cur) => (cur === t ? "" : t))
                }
              />
              <OwnershipPanel
                data={data}
                loading={loading}
                portfolioPropertyCount={portfolioPropertyCount}
                distinctPortfolioCount={distinctPortfolioCount}
                portfoliosLoading={portfoliosLoading}
              />
            </div>

            {/* Concentration headline */}
            <ConcentrationHeadline data={data} loading={loading} />

            {/* Portfolio owners — the dashboard's primary "who actually
               owns this market" view. Loaded from a separate endpoint
               (its mailing-address GROUP BY is the heaviest query of the
               dashboard) so this section streams in while the rest is
               already interactive. Sits above the legacy raw-owner
               tables, which are now collapsed behind a toggle. */}
            <div className="mt-6">
              <PortfolioTable
                portfolios={portfolios}
                loading={portfoliosLoading}
                error={portfoliosError}
                onSelect={(p) =>
                  setPanelInput({
                    display_name: p.display_name,
                    label_type: p.label_type,
                    state,
                    primary_mailing_address: p.mailing_address,
                    mailing_addresses: (p.mailing_addresses ?? [])
                      .map((m) => m.address)
                      .filter(Boolean),
                    stem: p.stem,
                    entity_id: p.entity_id,
                    entity_name: p.entity_name,
                    entity_ticker: p.entity_ticker,
                    // Carry the active type filter so the detail panel
                    // shows only this owner's properties of that type.
                    property_type: selectedType || null,
                  })
                }
              />
            </div>

            {/* Legacy raw-owner rankings — analyst view, off by default.
               These show un-merged LLC names straight from
               intel_owners_concentration, so demo-critical operators like
               Olymbec appear split across 9 rows. Useful for forensics
               but misleading at first glance, hence the toggle. */}
            <RawOwnerTables
              data={data}
              loading={loading}
              onSelectOwner={(name) =>
                setPanelInput({
                  display_name: name,
                  label_type: "individual",
                  state,
                  owner_name: name,
                  property_type: selectedType || null,
                })
              }
            />
          </>
        )}

        <Footer />
      </main>

      {panelInput && (
        <PortfolioDetailPanel
          input={panelInput}
          onClose={() => setPanelInput(null)}
        />
      )}
    </div>
  )
}

function Header() {
  return (
    <div className="border-b border-[var(--intel-border)] bg-[var(--intel-bg-elev)]">
      <div className="flex items-center gap-4 px-6 py-3">
        <Link href="/intelligence" className="flex items-center gap-3 group">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-[var(--intel-accent)] text-[var(--intel-bg)]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 21h18" />
              <path d="M5 21V8l7-5 7 5v13" />
              <path d="M9 21v-7h6v7" />
            </svg>
          </div>
          <div className="leading-tight">
            <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--intel-text-muted)]">
              dilly intel
            </div>
            <div className="text-[13px] font-semibold text-[var(--intel-text)] group-hover:text-[var(--intel-accent)] transition-colors">
              market coverage
            </div>
          </div>
        </Link>
        <div className="ml-auto flex items-center gap-4">
          <Link
            href="/intelligence"
            className="text-[11px] uppercase tracking-widest text-[var(--intel-text-muted)] transition-colors hover:text-[var(--intel-accent)]"
          >
            ← properties
          </Link>
          <Link
            href="/ops"
            className="text-[11px] uppercase tracking-widest text-[var(--intel-text-muted)] transition-colors hover:text-[var(--intel-accent)]"
          >
            ops
          </Link>
        </div>
      </div>
    </div>
  )
}

function FilterBar({
  search,
  state,
  hideGov,
  onSearch,
  onState,
  onHideGovChange,
}: {
  search: string
  state: string
  hideGov: boolean
  onSearch: (v: string) => void
  onState: (v: string) => void
  onHideGovChange: (v: boolean) => void
}) {
  return (
    <div className="border-b border-[var(--intel-border)] bg-[var(--intel-bg)]">
      <div className="flex items-center gap-3 px-6 py-3">
        <input
          type="text"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="city, zip code, or county"
          className="w-64 rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-1.5 text-[13px] text-[var(--intel-text)] placeholder-[var(--intel-text-dim)] outline-none focus:border-[var(--intel-accent-border)]"
        />
        {/* No "All states" option — an unfiltered market query scans
            ~1.1M rows and trips the statement timeout. The empty value
            is a disabled placeholder only; the user must pick a state. */}
        <select
          value={state}
          onChange={(e) => onState(e.target.value)}
          className="rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-1.5 text-[13px] text-[var(--intel-text)] outline-none focus:border-[var(--intel-accent-border)]"
        >
          <option value="" disabled>Select a state</option>
          {US_STATES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        {/* Hide-government toggle. Default ON — government entities
            (City of, County of, ISD, housing authorities, etc.) dominate
            the top-owner lists in many markets and aren't useful targets
            for contractor outreach. */}
        <button
          type="button"
          onClick={() => onHideGovChange(!hideGov)}
          aria-pressed={hideGov}
          title={
            hideGov
              ? "Government owners hidden — click to include"
              : "Government owners visible — click to hide"
          }
          className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[11px] uppercase tracking-widest transition-colors ${
            hideGov
              ? "border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] text-[var(--intel-accent)]"
              : "border-[var(--intel-border)] bg-[var(--intel-bg-elev)] text-[var(--intel-text-muted)] hover:text-[var(--intel-text)]"
          }`}
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              hideGov ? "bg-[var(--intel-accent)]" : "bg-[var(--intel-text-dim)]"
            }`}
          />
          hide government
        </button>

        <button
          onClick={() => {
            onSearch("")
            onState("")
          }}
          className="text-[11px] uppercase tracking-widest text-[var(--intel-text-muted)] hover:text-[var(--intel-text)]"
        >
          clear
        </button>
        {(state || search) && (
          <a
            href={(() => {
              const sp = new URLSearchParams()
              if (search) sp.set("search", search)
              if (state) sp.set("state", state)
              return `/api/intelligence/properties/export?${sp.toString()}`
            })()}
            className="rounded-md border border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--intel-accent)] transition-colors hover:bg-[var(--intel-accent)] hover:text-[var(--intel-bg)]"
            title="Download up to 10,000 matching properties as CSV"
          >
            ↓ export csv
          </a>
        )}
        <div className="ml-auto text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
          live across all sources
        </div>
      </div>
    </div>
  )
}

function KpiStrip({ data, loading }: { data: MarketResponse | null; loading: boolean }) {
  // The top strip is contractor-facing market sizing: how big is this
  // market in raw count / floor area / value / vintage. The ownership
  // split (corporate vs individual, portfolio-matched, distinct owners)
  // already lives in the OwnershipPanel below with proper labels and
  // tooltips, so we don't duplicate it here.
  const total = data?.summary.total ?? 0
  const totalSqft = data?.summary.total_sqft ?? null
  const totalValue = data?.summary.total_value ?? null
  const avgYearBuilt = data?.summary.avg_year_built ?? null
  const showSkel = loading && !data

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Kpi
        label="commercial properties"
        value={total}
        loading={showSkel}
        accent
      />
      <Kpi
        label="total building sqft"
        value={totalSqft ?? 0}
        loading={showSkel}
        format={(n) => fmtSqft(n)}
        unavailable={!showSkel && totalSqft == null}
        unavailableHint="No building_sqft coverage in this market's sources"
      />
      <Kpi
        label="total est. value"
        value={totalValue ?? 0}
        loading={showSkel}
        format={(n) => fmtMoney(n)}
        unavailable={!showSkel && totalValue == null}
        unavailableHint="No estimated_value coverage in this market's sources"
      />
      <Kpi
        label="avg year built"
        value={avgYearBuilt ?? 0}
        loading={showSkel}
        format={(n) => String(Math.round(n))}
        unavailable={!showSkel && avgYearBuilt == null}
        unavailableHint="No year_built coverage in this market's sources"
      />
    </div>
  )
}

function Kpi({
  label,
  value,
  loading,
  accent,
  format,
  unavailable,
  unavailableHint,
  tag,
  tagHint,
}: {
  label: string
  value: number
  loading: boolean
  accent?: boolean
  format?: (n: number) => string
  unavailable?: boolean
  unavailableHint?: string
  tag?: string
  tagHint?: string
}) {
  return (
    <div className="rounded-lg border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] p-4">
      <div className="flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
        <span>{label}</span>
        {tag && (
          <span
            className="rounded-sm border border-[var(--intel-border)] bg-[var(--intel-bg)] px-1 py-[1px] text-[9px] font-medium tracking-wider text-[var(--intel-text-muted)]"
            title={tagHint}
          >
            {tag}
          </span>
        )}
      </div>
      <div
        data-mono
        className={`mt-1 text-3xl font-medium leading-tight ${
          unavailable
            ? "text-[var(--intel-text-dim)]"
            : accent
              ? "text-[var(--intel-accent)]"
              : "text-[var(--intel-text)]"
        }`}
        title={unavailable ? unavailableHint : undefined}
      >
        {loading ? (
          <span className="inline-block h-9 w-32 rounded intel-skeleton" />
        ) : unavailable ? (
          <span>N/A</span>
        ) : (
          <CountUp value={value} format={format} />
        )}
      </div>
      {unavailable && (
        <div className="mt-1 text-[10px] leading-snug text-[var(--intel-text-dim)]">
          insufficient ownership data
        </div>
      )}
    </div>
  )
}

function TypeBreakdown({
  data,
  loading,
  selectedType,
  onSelectType,
}: {
  data: MarketResponse | null
  loading: boolean
  selectedType: string
  onSelectType: (t: string) => void
}) {
  // Rollup view (default) groups granular PropTracer types into the
  // standard contractor-facing categories. The toggle drops back to the
  // raw PropTracer breakdown for analyst-style use.
  const [showDetailed, setShowDetailed] = useState(false)
  const rollup = data?.summary.by_type_rollup ?? []
  const detailed = data?.summary.by_type ?? []
  const types = showDetailed ? detailed : rollup
  const total = types.reduce((a, t) => a + t.count, 0)
  const max = Math.max(1, ...types.map((t) => t.count))
  const labelGridCols = showDetailed
    ? "grid-cols-[170px_1fr_56px_56px_24px]"
    : "grid-cols-[140px_1fr_56px_56px_24px]"

  // Each row resolves to a rollup category — that's what the filter
  // operates on. In detailed view we roll the raw PropTracer string up
  // first; the type-filter pipeline only knows rollup categories.
  const rowCategory = (bucket: string): string =>
    showDetailed ? rollupCategory(bucket) : bucket

  return (
    <Section
      title="Property type breakdown"
      action={
        rollup.length > 0 || detailed.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowDetailed((v) => !v)}
            className="text-[10px] uppercase tracking-widest text-[var(--intel-text-muted)] transition-colors hover:text-[var(--intel-accent)]"
          >
            {showDetailed ? "← summary view" : "show detailed types"}
          </button>
        ) : null
      }
    >
      {loading && !data ? (
        <SkeletonRows />
      ) : types.length === 0 ? (
        <Empty />
      ) : (
        <div className="space-y-1">
          {types.map((t) => {
            const pct = total > 0 ? (t.count / total) * 100 : 0
            const barWidth = (t.count / max) * 100
            const category = rowCategory(t.bucket)
            const isSelected = !!selectedType && selectedType === category
            return (
              <button
                key={t.bucket}
                type="button"
                onClick={() => onSelectType(category)}
                title={
                  isSelected
                    ? `Clear the ${prettyType(category)} filter`
                    : `Filter the market to ${prettyType(category)}`
                }
                className={`group grid w-full items-center gap-3 text-left ${labelGridCols} rounded px-1.5 py-0.5 -mx-1.5 cursor-pointer transition-colors ${
                  isSelected
                    ? "border border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)]"
                    : "border border-transparent hover:bg-[var(--intel-bg-elev-2)]"
                }`}
              >
                <div
                  className={`truncate text-[12px] ${
                    isSelected
                      ? "text-[var(--intel-accent)] font-medium"
                      : "text-[var(--intel-text)]"
                  }`}
                  title={t.bucket}
                >
                  {showDetailed ? t.bucket : prettyType(t.bucket)}
                </div>
                <div className="h-2.5 rounded bg-[var(--intel-bg)] overflow-hidden">
                  <div
                    className="h-full rounded bg-[var(--intel-accent)]/70 transition-all duration-500"
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
                <div data-mono className="text-right text-[12px] text-[var(--intel-text)]">
                  {t.count.toLocaleString()}
                </div>
                <div data-mono className="text-right text-[10px] text-[var(--intel-text-muted)]">
                  {pct.toFixed(1)}%
                </div>
                <div
                  className={`text-right text-[14px] text-[var(--intel-accent)] transition-opacity ${
                    isSelected
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  {isSelected ? "✓" : "→"}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </Section>
  )
}

function TypeFilterBanner({
  type,
  count,
  loading,
  propertiesHref,
  onClear,
}: {
  type: string
  count: number | null
  loading: boolean
  propertiesHref: string
  onClear: () => void
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] px-4 py-2.5">
      <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--intel-text-muted)]">
        filtered to
      </span>
      <span className="text-[13px] font-semibold text-[var(--intel-accent)]">
        {prettyType(type)}
      </span>
      <span data-mono className="text-[12px] text-[var(--intel-text-muted)]">
        {loading || count == null
          ? "…"
          : `${count.toLocaleString()} properties`}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="rounded border border-[var(--intel-border)] bg-[var(--intel-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--intel-text-muted)] transition-colors hover:text-[var(--intel-text)]"
      >
        clear filter
      </button>
      <Link
        href={propertiesHref}
        className="ml-auto text-[11px] font-medium text-[var(--intel-accent)] transition-colors hover:text-[var(--intel-accent-hover)]"
      >
        View all {prettyType(type)} properties →
      </Link>
    </div>
  )
}

function OwnershipPanel({
  data,
  loading,
  portfolioPropertyCount,
  distinctPortfolioCount,
  portfoliosLoading,
}: {
  data: MarketResponse | null
  loading: boolean
  portfolioPropertyCount: number | null
  distinctPortfolioCount: number | null
  portfoliosLoading: boolean
}) {
  const own = data?.summary.ownership
  const matched = data?.summary.matched
  const total = data?.summary.total ?? 0
  const ownerNameCount = data?.summary.owner_name_count ?? null
  const mailingAddressCount = data?.summary.mailing_address_count ?? null

  // Three-segment stacked bar over the inferred-ownership universe. The
  // "unknown" bucket counts owner names the inference rules couldn't
  // classify — we surface it explicitly now rather than dropping it.
  const ownTotal =
    (own?.corporate ?? 0) + (own?.individual ?? 0) + (own?.unknown ?? 0)
  const businessPct =
    ownTotal > 0 ? Math.round(((own?.corporate ?? 0) / ownTotal) * 100) : 0
  const individualPct =
    ownTotal > 0 ? Math.round(((own?.individual ?? 0) / ownTotal) * 100) : 0
  const unknownPct = Math.max(0, 100 - businessPct - individualPct)

  // Coverage percentages — null when total is 0 or the count query failed.
  const ownerNamePct =
    total > 0 && ownerNameCount != null
      ? Math.round((ownerNameCount / total) * 1000) / 10
      : null
  const mailingAddressPct =
    total > 0 && mailingAddressCount != null
      ? Math.round((mailingAddressCount / total) * 1000) / 10
      : null

  return (
    <Section title="Ownership composition">
      {loading && !data ? (
        <SkeletonRows />
      ) : (
        <div className="space-y-5">
          {/* Headline 2x2 stat grid — what we KNOW about this market */}
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <CoverageStat
              label="owner name coverage"
              valueText={
                ownerNamePct != null ? `${formatPct(ownerNamePct)}%` : "—"
              }
              subText={
                ownerNameCount != null && total > 0
                  ? `${ownerNameCount.toLocaleString()} of ${total.toLocaleString()}`
                  : undefined
              }
              accent
              infoTooltip="Properties where the owner or entity name is known from public tax records."
            />
            <CoverageStat
              label="portfolio-grouped properties"
              valueText={
                portfoliosLoading && portfolioPropertyCount == null
                  ? "…"
                  : portfolioPropertyCount != null
                    ? portfolioPropertyCount.toLocaleString()
                    : "—"
              }
              accent
              infoTooltip="Properties linked to a multi-property portfolio through shared owner mailing addresses or common entity names."
            />
            <CoverageStat
              label="distinct portfolios"
              valueText={
                portfoliosLoading && distinctPortfolioCount == null
                  ? "…"
                  : distinctPortfolioCount != null
                    ? distinctPortfolioCount.toLocaleString()
                    : "—"
              }
              infoTooltip="Unique portfolio owners identified through mailing address analysis and entity name grouping."
            />
            <CoverageStat
              label="registered entities"
              valueText={(matched?.matched ?? 0).toLocaleString()}
              infoTooltip="Properties matched to a known publicly-traded REIT or registered commercial operator in our entity database."
            />
          </div>

          {/* Three-segment ownership bar — likely business / individual /
              unknown. Inferred from owner-name suffixes when the source
              data doesn't carry an explicit corporate-flag field. */}
          <div className="border-t border-[var(--intel-border)] pt-4">
            <div className="mb-2 flex justify-between text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
              <span>likely owner type</span>
              <span data-mono className="text-[var(--intel-text-muted)]">
                {ownTotal > 0 ? `${ownTotal.toLocaleString()} owners` : ""}
              </span>
            </div>
            <div className="flex h-6 overflow-hidden rounded border border-[var(--intel-border)] bg-[var(--intel-bg)]">
              <div
                className="flex items-center justify-center bg-[var(--intel-accent)] text-[10px] font-semibold uppercase text-[var(--intel-bg)] transition-all duration-500"
                style={{ width: `${businessPct}%` }}
                title="Likely business-owned"
              >
                {businessPct >= 8 ? `${businessPct}% business` : null}
              </div>
              <div
                className="flex items-center justify-center bg-[var(--intel-bg-elev-2)] text-[10px] font-semibold uppercase text-[var(--intel-text)] transition-all duration-500"
                style={{ width: `${individualPct}%` }}
                title="Likely individual-owned"
              >
                {individualPct >= 8 ? `${individualPct}% individ.` : null}
              </div>
              <div
                className="flex items-center justify-center bg-[var(--intel-bg)] text-[10px] font-semibold uppercase text-[var(--intel-text-dim)] transition-all duration-500"
                style={{ width: `${unknownPct}%` }}
                title="Owner type could not be inferred"
              >
                {unknownPct >= 8 ? `${unknownPct}% unknown` : null}
              </div>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <Stat
                label="likely business-owned"
                value={own?.corporate ?? 0}
                infoTooltip="Inferred from owner-name suffixes (LLC, Inc, Corp, REIT, LP, etc.) when the source data doesn't carry an explicit corporate-flag field. Treat as a best-guess estimate, not a registry lookup."
              />
              <Stat
                label="likely individual-owned"
                value={own?.individual ?? 0}
                infoTooltip="Owner names that don't carry a corporate suffix and look like a personal name (1–4 words, no LLC/Inc/Corp). Sole-proprietor LLCs may be misclassified as business-owned."
              />
              <Stat
                label="unknown"
                value={own?.unknown ?? 0}
                muted
                infoTooltip="Owner name didn't match either heuristic — usually an organization/trust/partnership name that lacks a corporate suffix and isn't formatted like a person's name."
              />
            </div>
          </div>

          {/* Secondary data-coverage line. Lets users (and us) tell how
              much portfolio detection is possible in this market without
              hunting in a separate panel. */}
          <div className="border-t border-[var(--intel-border)] pt-3 text-[11px]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
                <span>mailing address coverage</span>
                <span
                  className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-[var(--intel-border)] text-[8px] text-[var(--intel-text-muted)]"
                  title="Properties with owner mailing address data, enabling portfolio detection through address clustering."
                >
                  ?
                </span>
              </div>
              <div data-mono className="text-[var(--intel-text)]">
                {mailingAddressPct != null
                  ? `${formatPct(mailingAddressPct)}%`
                  : "—"}
                {mailingAddressCount != null && total > 0 && (
                  <span className="ml-2 text-[var(--intel-text-muted)]">
                    {mailingAddressCount.toLocaleString()} of{" "}
                    {total.toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </Section>
  )
}

function CoverageStat({
  label,
  valueText,
  subText,
  accent,
  infoTooltip,
}: {
  label: string
  valueText: string
  subText?: string
  accent?: boolean
  infoTooltip?: string
}) {
  return (
    <div className="rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg)] px-3 py-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--intel-text-dim)]">
        <span>{label}</span>
        {infoTooltip && (
          <span
            className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-[var(--intel-border)] text-[8px] text-[var(--intel-text-muted)]"
            title={infoTooltip}
          >
            ?
          </span>
        )}
      </div>
      <div
        data-mono
        className={`mt-0.5 text-[18px] leading-tight ${
          accent ? "text-[var(--intel-accent)]" : "text-[var(--intel-text)]"
        }`}
      >
        {valueText}
      </div>
      {subText && (
        <div className="text-[10px] text-[var(--intel-text-muted)]">{subText}</div>
      )}
    </div>
  )
}

function formatPct(n: number): string {
  // Drop trailing ".0" so "100.0%" renders as "100%" but "99.4%" stays.
  return Number.isInteger(n) ? `${n}` : n.toFixed(1)
}

function Stat({
  label,
  value,
  accent,
  muted,
  infoTooltip,
}: {
  label: string
  value: number
  accent?: boolean
  muted?: boolean
  infoTooltip?: string
}) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--intel-text-dim)]">
        <span>{label}</span>
        {infoTooltip && (
          <span
            className="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-[var(--intel-border)] text-[8px] text-[var(--intel-text-muted)]"
            title={infoTooltip}
          >
            ?
          </span>
        )}
      </div>
      <div
        data-mono
        className={`text-[14px] ${
          accent
            ? "text-[var(--intel-accent)]"
            : muted
              ? "text-[var(--intel-text-muted)]"
              : "text-[var(--intel-text)]"
        }`}
      >
        {value.toLocaleString()}
      </div>
    </div>
  )
}

function ConcentrationHeadline({
  data,
  loading,
}: {
  data: MarketResponse | null
  loading: boolean
}) {
  if (loading && !data) {
    return (
      <div className="mt-6 rounded-lg border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] p-6">
        <div className="h-6 w-2/3 rounded intel-skeleton" />
      </div>
    )
  }
  const c = data?.concentration
  if (!c || c.total_market_count === 0) return null

  return (
    <div className="mt-6 rounded-lg border border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] p-6">
      <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--intel-text-muted)]">
        portfolio concentration
      </div>
      <div className="mt-2 text-[18px] leading-snug text-[var(--intel-text)]">
        Top 10 owners control{" "}
        <span data-mono className="text-[var(--intel-accent)] font-semibold">
          <CountUp value={c.top_10_pct} format={(n) => `${n.toFixed(1)}%`} />
        </span>{" "}
        of this market —{" "}
        <span data-mono className="font-medium">
          {c.top_10_property_count.toLocaleString()}
        </span>{" "}
        of{" "}
        <span data-mono className="font-medium">
          {c.total_market_count.toLocaleString()}
        </span>{" "}
        properties across{" "}
        <span data-mono className="font-medium">
          {c.total_owners_count.toLocaleString()}
        </span>{" "}
        distinct owners.
      </div>
    </div>
  )
}

function OwnerTable({
  title,
  owners,
  metric,
  loading,
  onSelectOwner,
}: {
  title: string
  owners: Owner[]
  metric: "count" | "sqft"
  loading: boolean
  onSelectOwner?: (name: string) => void
}) {
  return (
    <Section title={title}>
      {loading && owners.length === 0 ? (
        <SkeletonRows count={10} />
      ) : owners.length === 0 ? (
        <Empty />
      ) : (
        <div className="overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--intel-border)] text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
                <th className="py-2 pr-2 text-left font-medium w-8">#</th>
                <th className="py-2 pr-2 text-left font-medium">owner</th>
                <th className="py-2 pr-2 text-right font-medium">props</th>
                <th className="py-2 pr-2 text-right font-medium">sqft</th>
                <th className="py-2 pr-2 text-right font-medium">est. value</th>
              </tr>
            </thead>
            <tbody>
              {owners.map((o, i) => (
                <tr
                  key={`${o.raw_owner_name}-${o.entity_id ?? "x"}-${i}`}
                  onClick={
                    onSelectOwner ? () => onSelectOwner(o.raw_owner_name) : undefined
                  }
                  className={`border-b border-[var(--intel-border)]/50 transition-colors hover:bg-[var(--intel-bg-elev-2)] ${
                    onSelectOwner ? "cursor-pointer" : ""
                  }`}
                  title={onSelectOwner ? "View properties owned by this entity" : undefined}
                >
                  <td data-mono className="py-2 pr-2 text-[var(--intel-text-dim)] text-[11px]">
                    {i + 1}
                  </td>
                  <td className="py-2 pr-2">
                    <div className="truncate text-[12px] text-[var(--intel-text)] max-w-[280px]" title={o.raw_owner_name}>
                      {o.raw_owner_name}
                    </div>
                    {o.entity_name && (
                      <div className="truncate text-[10px] text-[var(--intel-accent)] max-w-[280px]" title={o.entity_name}>
                        {o.entity_name}
                        {o.entity_ticker ? ` · ${o.entity_ticker}` : ""}
                      </div>
                    )}
                  </td>
                  <td
                    data-mono
                    className={`py-2 pr-2 text-right text-[12px] ${
                      metric === "count" ? "text-[var(--intel-accent)] font-semibold" : "text-[var(--intel-text)]"
                    }`}
                  >
                    {Number(o.property_count).toLocaleString()}
                  </td>
                  <td
                    data-mono
                    className={`py-2 pr-2 text-right text-[12px] ${
                      metric === "sqft" ? "text-[var(--intel-accent)] font-semibold" : "text-[var(--intel-text)]"
                    }`}
                  >
                    {fmtSqft(o.total_sqft)}
                  </td>
                  <td data-mono className="py-2 pr-2 text-right text-[12px] text-[var(--intel-text-muted)]">
                    {fmtMoney(o.total_value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function PortfolioTable({
  portfolios,
  loading,
  error,
  onSelect,
}: {
  portfolios: PortfolioOwner[]
  loading: boolean
  error?: string | null
  onSelect: (p: PortfolioOwner) => void
}) {
  return (
    <Section
      title="Largest property portfolios"
      action={
        <div className="flex items-center gap-2">
          {loading && (
            <span className="text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
              loading…
            </span>
          )}
          <span
            className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-[var(--intel-border)] text-[10px] text-[var(--intel-text-muted)]"
            title="One real-world owner often holds dozens of properties through different LLCs at different mailing addresses. We cluster records by tax-bill mailing address, then merge clusters sharing a distinctive name stem (e.g. all 'Olymbec X LLC' entities), then label by known entity > shared stem > individual > address."
          >
            ?
          </span>
        </div>
      }
    >
      {error && !loading && (
        <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          Portfolios temporarily unavailable: {error}
        </div>
      )}
      {loading && portfolios.length === 0 ? (
        // Tight 3-row skeleton — the portfolios fetch takes 3-8 s on
        // Memphis-scale markets and an 8-row skeleton reads as a giant
        // blank space until the real rows arrive.
        <SkeletonRows count={3} />
      ) : portfolios.length === 0 ? (
        <Empty />
      ) : (
        <div className="overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--intel-border)] text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
                <th className="py-2 pr-2 text-left font-medium w-8">#</th>
                <th className="py-2 pr-2 text-left font-medium">owner</th>
                <th className="py-2 pr-2 text-right font-medium">props</th>
                <th className="py-2 pr-2 text-right font-medium">entities</th>
                <th className="py-2 pr-2 text-right font-medium">sqft</th>
                <th className="py-2 pr-2 text-right font-medium">est. value</th>
                <th className="py-2 pr-2 text-left font-medium">detail</th>
              </tr>
            </thead>
            <tbody>
              {portfolios.map((p, i) => (
                <PortfolioRowView
                  key={`${p.display_name}-${i}`}
                  index={i}
                  p={p}
                  onSelect={() => onSelect(p)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

const LABEL_BADGES: Record<PortfolioOwner["label_type"], { text: string; tone: string; hint: string }> = {
  entity: {
    text: "registered",
    tone: "border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] text-[var(--intel-accent)]",
    hint: "Matched to a REIT or operator in the entity registry.",
  },
  stem: {
    text: "name match",
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    hint: "Multiple LLCs across this portfolio share a distinctive name stem (e.g. all 'Olymbec X LLC').",
  },
  individual: {
    text: "individual",
    tone: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    hint: "Single owner name with no corporate suffix — likely a person rather than an LLC.",
  },
  address: {
    text: "shared address",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    hint: "Multiple LLCs file from the same mailing address — likely an institutional SPV portfolio.",
  },
  manual: {
    text: "curated",
    tone: "border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] text-[var(--intel-accent)]",
    hint: "Operator-verified label from the manual portfolio-label registry.",
  },
}

function PortfolioRowView({
  index,
  p,
  onSelect,
}: {
  index: number
  p: PortfolioOwner
  onSelect: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const llcs = p.llc_names ?? []
  const previewLlcs = expanded ? llcs : llcs.slice(0, 3)
  const hidden = Math.max(0, llcs.length - 3)
  const cityState = [p.mailing_city, p.mailing_state].filter(Boolean).join(", ")
  const badge = LABEL_BADGES[p.label_type]
  return (
    <tr
      onClick={onSelect}
      className="cursor-pointer border-b border-[var(--intel-border)]/50 align-top hover:bg-[var(--intel-bg-elev-2)] transition-colors"
      title="View portfolio detail"
    >
      <td data-mono className="py-2 pr-2 text-[var(--intel-text-dim)] text-[11px]">
        {index + 1}
      </td>
      <td className="py-2 pr-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <div
            className="truncate text-[13px] font-medium text-[var(--intel-text)] max-w-[280px]"
            title={p.display_name}
          >
            {p.display_name}
          </div>
          <span
            className={`shrink-0 rounded-sm border px-1 py-[1px] text-[9px] uppercase tracking-wider ${badge.tone}`}
            title={badge.hint}
          >
            {badge.text}
          </span>
          {p.is_healthcare_institution && (
            <span
              className="shrink-0 rounded-sm border border-rose-500/30 bg-rose-500/10 px-1 py-[1px] text-[9px] uppercase tracking-wider text-rose-300"
              title="Hospital system / healthcare institution — not a typical commercial portfolio."
            >
              healthcare
            </span>
          )}
        </div>
        {/* Subtitle. For address-labeled portfolios the display name
           already contains the mailing address, so duplicating it
           reads as noise — show a preview of the first 2 LLCs
           instead. For other label types the address adds info. */}
        {p.label_type === "address" ? (
          <div
            className="truncate text-[10px] text-[var(--intel-text-muted)] max-w-[320px]"
            title={(p.llc_names ?? []).join("; ")}
          >
            {(p.llc_names ?? []).slice(0, 2).join(" · ")}
            {(p.llc_names ?? []).length > 2
              ? ` · +${(p.llc_names ?? []).length - 2} more`
              : ""}
          </div>
        ) : (
          <div className="text-[10px] text-[var(--intel-text-muted)]">
            {p.mailing_address}
            {cityState ? ` · ${cityState}` : ""}
            {p.mailing_zip ? ` ${p.mailing_zip}` : ""}
          </div>
        )}
      </td>
      <td
        data-mono
        className="py-2 pr-2 text-right text-[12px] text-[var(--intel-accent)] font-semibold"
      >
        <div className="flex items-baseline justify-end gap-1">
          <span>{p.property_count.toLocaleString()}</span>
          {p.gov_adjusted && (
            <span
              className="rounded-sm border border-[var(--intel-border)] bg-[var(--intel-bg)] px-1 py-[1px] text-[8px] font-medium uppercase tracking-wider text-[var(--intel-text-muted)]"
              title="Estimate — some LLCs at this address are gov-owned and were stripped. The detail panel shows the exact count."
            >
              est.
            </span>
          )}
        </div>
      </td>
      <td data-mono className="py-2 pr-2 text-right text-[12px] text-[var(--intel-text-muted)]">
        {p.llc_count.toLocaleString()}
      </td>
      <td data-mono className="py-2 pr-2 text-right text-[12px] text-[var(--intel-text)]">
        {fmtSqft(p.total_sqft)}
      </td>
      <td
        data-mono
        className="py-2 pr-2 text-right text-[12px] text-[var(--intel-text-muted)]"
      >
        {fmtMoney(p.total_value)}
      </td>
      <td className="py-2 pr-2 text-[11px] text-[var(--intel-text-muted)]">
        <div className="flex flex-col gap-0.5 max-w-[420px]">
          {previewLlcs.map((name) => (
            <div key={name} className="truncate" title={name}>
              {name}
            </div>
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded((x) => !x)
              }}
              className="text-left text-[10px] uppercase tracking-widest text-[var(--intel-accent)] hover:text-[var(--intel-accent-hover)]"
            >
              {expanded ? "show less" : `and ${hidden} more LLC${hidden === 1 ? "" : "s"}`}
            </button>
          )}
          {expanded && p.mailing_addresses && p.mailing_addresses.length > 1 && (
            <div className="mt-2 border-t border-[var(--intel-border)] pt-2 text-[10px]">
              <div className="mb-1 uppercase tracking-widest text-[var(--intel-text-dim)]">
                mailing addresses ({p.mailing_addresses.length})
              </div>
              {p.mailing_addresses.map((a, i) => (
                <div key={`${a.address}-${i}`} className="truncate" title={a.address}>
                  {a.address}
                  {a.city ? ` — ${a.city}` : ""}
                  {a.state ? `, ${a.state}` : ""}
                  {` (${a.property_count})`}
                </div>
              ))}
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

/**
 * Legacy raw-owner view, collapsed behind a toggle. These come straight
 * from intel_owners_concentration with no portfolio clustering, so they
 * still show every LLC variant as its own row. The portfolio table above
 * is the primary view; this stays available for the analyst / forensic
 * "show me the actual filings" case.
 */
function RawOwnerTables({
  data,
  loading,
  onSelectOwner,
}: {
  data: MarketResponse | null
  loading: boolean
  onSelectOwner: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  // Container uses no top margin when closed (just the button +
  // collapsed inner) so it sits directly under the portfolio table.
  // When open it gains spacing via `mt-3` on the inner grid.
  return (
    <div className={open ? "mt-6" : "mt-3"}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-md border border-dashed border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-4 py-2.5 text-left text-[11px] uppercase tracking-widest text-[var(--intel-text-muted)] transition-colors hover:text-[var(--intel-text)]"
        aria-expanded={open}
      >
        <span>
          {open ? "−" : "+"} Show individual owner names (un-merged)
        </span>
        <span className="text-[10px] text-[var(--intel-text-dim)] normal-case tracking-normal">
          analyst view · LLCs not portfolio-clustered
        </span>
      </button>
      {open && (
        <div className="mt-3 grid gap-6 xl:grid-cols-2">
          <OwnerTable
            title="Top 20 owners by property count"
            owners={data?.top_owners_by_count ?? []}
            metric="count"
            loading={loading}
            onSelectOwner={onSelectOwner}
          />
          <OwnerTable
            title="Top 20 owners by total sqft"
            owners={data?.top_owners_by_sqft ?? []}
            metric="sqft"
            loading={loading}
            onSelectOwner={onSelectOwner}
          />
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  children,
  action,
}: {
  title: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-[var(--intel-border)] bg-[var(--intel-bg-elev)]">
      <div className="flex items-center justify-between border-b border-[var(--intel-border)] px-4 py-2.5">
        <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--intel-text-muted)]">
          {title}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-5 rounded intel-skeleton" />
      ))}
    </div>
  )
}

function Empty() {
  return (
    <div className="py-8 text-center text-[12px] text-[var(--intel-text-muted)]">
      No data for this market.
    </div>
  )
}

// Shown when no state is selected. The dashboard fires zero API calls in
// this state — an unfiltered market query times out against the full
// ~1.1M-row table, so we gate every query behind a state selection.
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
        Select a state to view market intelligence
      </div>
      <div className="mt-1 max-w-sm text-center text-[12px] text-[var(--intel-text-muted)]">
        Pick a state in the dropdown above to load KPIs, ownership breakdowns, and portfolio concentration for that market.
      </div>
    </div>
  )
}

function Footer() {
  return (
    <div className="mt-10 flex items-center justify-between border-t border-[var(--intel-border)] pt-4 text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
      <span>dilly intel · market coverage</span>
      <Link
        href="/intelligence"
        className="transition-colors hover:text-[var(--intel-accent)]"
      >
        ← back to property browser
      </Link>
    </div>
  )
}

function prettyType(s: string): string {
  return s.replace(/_/g, " ")
}

function fmtSqft(n: number | null | undefined): string {
  if (n == null) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000).toLocaleString()}k`
  return `${Math.round(n).toLocaleString()}`
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—"
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`
  return `$${Math.round(n)}`
}
