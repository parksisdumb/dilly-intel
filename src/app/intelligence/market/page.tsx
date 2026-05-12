"use client"

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { CountUp } from "../components/CountUp"

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
  mailing_address: string
  mailing_city: string | null
  mailing_state: string | null
  mailing_zip: string | null
  property_count: number
  llc_names: string[]
  total_sqft: number | null
  total_value: number | null
}

type MarketResponse = {
  filters: { city: string | null; state: string | null; zip: string | null; hide_gov?: boolean }
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
  const [data, setData] = useState<MarketResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Portfolios are loaded from a separate endpoint — heaviest GROUP BY
  // in the dashboard, kept off the critical path so the headline KPIs
  // and owner tables render without waiting on it.
  const [portfolios, setPortfolios] = useState<PortfolioOwner[]>([])
  const [portfoliosLoading, setPortfoliosLoading] = useState(false)
  const [portfoliosError, setPortfoliosError] = useState<string | null>(null)

  const reqIdRef = useRef(0)
  const portfolioReqIdRef = useRef(0)
  const debounceRef = useRef<number | null>(null)

  const fetchData = useCallback(async (s: string, st: string, hg: boolean) => {
    const myReqId = ++reqIdRef.current
    setLoading(true)
    setError(null)
    const sp = new URLSearchParams()
    if (s) sp.set("search", s)
    if (st) sp.set("state", st)
    sp.set("hide_gov", hg ? "true" : "false")
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
    async (s: string, st: string, hg: boolean) => {
      const myReqId = ++portfolioReqIdRef.current
      setPortfoliosLoading(true)
      setPortfoliosError(null)
      setPortfolios([])
      const sp = new URLSearchParams()
      if (s) sp.set("search", s)
      if (st) sp.set("state", st)
      sp.set("hide_gov", hg ? "true" : "false")
      try {
        const res = await fetch(`/api/intelligence/market/portfolios?${sp.toString()}`)
        const json = (await res.json()) as PortfoliosResponse
        if (myReqId !== portfolioReqIdRef.current) return
        if (json.error) setPortfoliosError(json.error)
        setPortfolios(json.portfolio_owners ?? [])
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
    (s: string, st: string, hg: boolean) => {
      const sp = new URLSearchParams()
      if (s) sp.set("search", s)
      if (st) sp.set("state", st)
      // Only persist hide_gov when it differs from the default (ON)
      if (!hg) sp.set("hide_gov", "false")
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
      // Fire both in parallel — they're independent endpoints. The
      // page renders progressively as each lands.
      fetchData(search, state, hideGov)
      fetchPortfolios(search, state, hideGov)
      syncUrl(search, state, hideGov)
    }, 300)
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    }
  }, [search, state, hideGov, fetchData, fetchPortfolios, syncUrl])

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

        {/* Top KPI strip */}
        <KpiStrip data={data} loading={loading} />

        {/* Type breakdown + ownership split */}
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <TypeBreakdown data={data} loading={loading} />
          <OwnershipPanel data={data} loading={loading} />
        </div>

        {/* Concentration headline */}
        <ConcentrationHeadline data={data} loading={loading} />

        {/* Owner rankings */}
        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <OwnerTable
            title="Top 20 owners by property count"
            owners={data?.top_owners_by_count ?? []}
            metric="count"
            loading={loading}
          />
          <OwnerTable
            title="Top 20 owners by total sqft"
            owners={data?.top_owners_by_sqft ?? []}
            metric="sqft"
            loading={loading}
          />
        </div>

        {/* Portfolio owners — shared mailing address. Loaded from a
           separate endpoint so its slow GROUP BY doesn't block the
           rest of the dashboard. */}
        <div className="mt-6">
          <PortfolioTable
            portfolios={portfolios}
            loading={portfoliosLoading}
            error={portfoliosError}
          />
        </div>

        <Footer />
      </main>
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
        <select
          value={state}
          onChange={(e) => onState(e.target.value)}
          className="rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-1.5 text-[13px] text-[var(--intel-text)] outline-none focus:border-[var(--intel-accent-border)]"
        >
          <option value="">All states</option>
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
  const total = data?.summary.total ?? 0
  const corp = data?.summary.corporate_pct ?? 0
  // Hide the percentage when fewer than 10% of records carry an explicit
  // corporate_owned value (the rest are entirely inferred from owner names,
  // which isn't reliable enough to headline). When 10%+ have explicit data
  // but inference still moved some rows, show the value with an "est." tag.
  const corpReliable = data?.summary.corporate_pct_reliable ?? true
  const corpEstimated = data?.summary.corporate_pct_estimated ?? false
  const matched = data?.summary.matched.matched ?? 0
  const ownersCount = data?.concentration.total_owners_count ?? 0
  const showSkel = loading && !data

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Kpi label="commercial properties" value={total} loading={showSkel} accent />
      <Kpi
        label="corporate owned"
        value={corp}
        loading={showSkel}
        format={(n) => `${Math.round(n)}%`}
        unavailable={!corpReliable && !showSkel}
        unavailableHint="N/A — fewer than 10% of records in this market carry an explicit corporate-flag value (FL DOR is the main offender)"
        tag={corpEstimated && corpReliable ? "est." : undefined}
        tagHint="Some records had no explicit corporate_owned value — these are inferred from owner-name suffixes (LLC, INC, REIT, etc.)"
      />
      <Kpi label="portfolio matched" value={matched} loading={showSkel} />
      <Kpi label="distinct owners" value={ownersCount} loading={showSkel} />
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

function TypeBreakdown({ data, loading }: { data: MarketResponse | null; loading: boolean }) {
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
    ? "grid-cols-[170px_1fr_56px_56px]"
    : "grid-cols-[140px_1fr_56px_56px]"

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
        <div className="space-y-2">
          {types.map((t) => {
            const pct = total > 0 ? (t.count / total) * 100 : 0
            const barWidth = (t.count / max) * 100
            return (
              <div key={t.bucket} className={`grid items-center gap-3 ${labelGridCols}`}>
                <div className="truncate text-[12px] text-[var(--intel-text)]" title={t.bucket}>
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
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}

function OwnershipPanel({ data, loading }: { data: MarketResponse | null; loading: boolean }) {
  const own = data?.summary.ownership
  const matched = data?.summary.matched
  const corpPct = data?.summary.corporate_pct ?? 0
  const knownTotal = (own?.corporate ?? 0) + (own?.individual ?? 0)
  const indivPct = knownTotal > 0 ? Math.round(((own?.individual ?? 0) / knownTotal) * 100) : 0

  return (
    <Section title="Ownership composition">
      {loading && !data ? (
        <SkeletonRows />
      ) : (
        <div className="space-y-4">
          {/* Stacked bar: corporate / individual / unknown */}
          <div>
            <div className="mb-2 flex justify-between text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
              <span>corporate vs individual</span>
              <span data-mono className="text-[var(--intel-text-muted)]">
                {own?.unknown ? `${own.unknown.toLocaleString()} unknown excluded` : ""}
              </span>
            </div>
            <div className="flex h-6 overflow-hidden rounded border border-[var(--intel-border)] bg-[var(--intel-bg)]">
              <div
                className="flex items-center justify-center bg-[var(--intel-accent)] text-[10px] font-semibold uppercase text-[var(--intel-bg)] transition-all duration-500"
                style={{ width: `${corpPct}%` }}
              >
                {corpPct >= 8 ? `${corpPct}% business` : null}
              </div>
              <div
                className="flex items-center justify-center bg-[var(--intel-bg-elev-2)] text-[10px] font-semibold uppercase text-[var(--intel-text)] transition-all duration-500"
                style={{ width: `${indivPct}%` }}
              >
                {indivPct >= 8 ? `${indivPct}% individ.` : null}
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3 text-[11px]">
              <Stat
                label="business entity (est.)"
                value={own?.corporate ?? 0}
                infoTooltip="Inferred from owner-name suffixes (LLC, Inc, Corp, REIT, LP, etc.) when the source data doesn't carry an explicit corporate-flag field. Treat as a best-guess estimate, not a registry lookup."
              />
              <Stat
                label="individual"
                value={own?.individual ?? 0}
                infoTooltip="Owner names that don't carry a corporate-suffix and look like a personal name (1–4 words, no LLC/Inc/Corp). Sole-proprietor LLCs may be misclassified as Business Entity."
              />
            </div>
          </div>

          <div className="border-t border-[var(--intel-border)] pt-3">
            <div className="mb-2 text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
              portfolio match
            </div>
            <div className="grid grid-cols-2 gap-3 text-[11px]">
              <Stat
                label="identified portfolio"
                value={matched?.matched ?? 0}
                accent
                infoTooltip="Properties where the owner name resolves to a known REIT or operator in our entity registry — fully linked to a parent company, ticker, and subsidiary list."
              />
              <Stat
                label="unidentified owner"
                value={matched?.unmatched ?? 0}
                muted
                infoTooltip="Properties whose owner name didn't match the entity registry. Many of these are real businesses we just don't have a parent record for yet — see the Portfolio Owners table below for shared-mailing-address clusters that surface the same operator across multiple LLCs."
              />
            </div>
          </div>
        </div>
      )}
    </Section>
  )
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
}: {
  title: string
  owners: Owner[]
  metric: "count" | "sqft"
  loading: boolean
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
                  className="border-b border-[var(--intel-border)]/50 hover:bg-[var(--intel-bg-elev-2)] transition-colors"
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
}: {
  portfolios: PortfolioOwner[]
  loading: boolean
  error?: string | null
}) {
  return (
    <Section
      title="Portfolio owners"
      action={
        <div className="flex items-center gap-2">
          {loading && (
            <span className="text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
              loading…
            </span>
          )}
          <span
            className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-[var(--intel-border)] text-[10px] text-[var(--intel-text-muted)]"
            title="One real-world owner often holds many properties through different LLCs. Grouping records by tax-bill mailing address surfaces the true portfolio — even when each property is registered to a different shell entity."
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
        <SkeletonRows count={8} />
      ) : portfolios.length === 0 ? (
        <Empty />
      ) : (
        <div className="overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--intel-border)] text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
                <th className="py-2 pr-2 text-left font-medium w-8">#</th>
                <th className="py-2 pr-2 text-left font-medium">mailing address</th>
                <th className="py-2 pr-2 text-right font-medium">props</th>
                <th className="py-2 pr-2 text-right font-medium">sqft</th>
                <th className="py-2 pr-2 text-right font-medium">est. value</th>
                <th className="py-2 pr-2 text-left font-medium">llc names</th>
              </tr>
            </thead>
            <tbody>
              {portfolios.map((p, i) => (
                <PortfolioRowView key={`${p.mailing_address}-${i}`} index={i} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function PortfolioRowView({ index, p }: { index: number; p: PortfolioOwner }) {
  const [expanded, setExpanded] = useState(false)
  const llcs = p.llc_names ?? []
  const previewLlcs = expanded ? llcs : llcs.slice(0, 3)
  const hidden = Math.max(0, llcs.length - 3)
  const cityState = [p.mailing_city, p.mailing_state].filter(Boolean).join(", ")
  return (
    <tr className="border-b border-[var(--intel-border)]/50 align-top hover:bg-[var(--intel-bg-elev-2)] transition-colors">
      <td data-mono className="py-2 pr-2 text-[var(--intel-text-dim)] text-[11px]">
        {index + 1}
      </td>
      <td className="py-2 pr-2">
        <div
          className="truncate text-[12px] text-[var(--intel-text)] max-w-[280px]"
          title={p.mailing_address}
        >
          {p.mailing_address}
        </div>
        {cityState && (
          <div className="text-[10px] text-[var(--intel-text-muted)]">
            {cityState}
            {p.mailing_zip ? ` ${p.mailing_zip}` : ""}
          </div>
        )}
      </td>
      <td
        data-mono
        className="py-2 pr-2 text-right text-[12px] text-[var(--intel-accent)] font-semibold"
      >
        {p.property_count.toLocaleString()}
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
              onClick={() => setExpanded((x) => !x)}
              className="text-left text-[10px] uppercase tracking-widest text-[var(--intel-accent)] hover:text-[var(--intel-accent-hover)]"
            >
              {expanded ? "show less" : `and ${hidden} more`}
            </button>
          )}
        </div>
      </td>
    </tr>
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
