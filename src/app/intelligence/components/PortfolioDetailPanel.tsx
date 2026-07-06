"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { PropertyDetailPanel } from "./PropertyDetailPanel"
import { rollupCategory } from "@/lib/intel/property-types"
import type { Property } from "../types"

// ----------------------------------------------------------------------------
// Portfolio detail slide-in.
//
// Same animation / position / overlay pattern as PropertyDetailPanel, but
// wider (it carries a property table) and renders the property panel itself
// nested on top when a row is clicked through.
//
// Entry shape is the "minimum needed to identify a cluster" — the panel
// itself does the heavy fetch against /api/intelligence/portfolios/[id].
// ----------------------------------------------------------------------------

export type PortfolioPanelInput = {
  /** Cosmetic title — comes from the upstream label pipeline. */
  display_name: string
  label_type: "entity" | "stem" | "individual" | "address" | "manual"
  /** Which state to scope the query to. Required. */
  state: string
  /** Primary mailing address (used for the URL handle). */
  primary_mailing_address?: string | null
  /** All mailing addresses contributing to the cluster. */
  mailing_addresses?: string[]
  /** Distinctive name stem when label_type === "stem". */
  stem?: string | null
  /** Used by the property-card "click owner name" entry path. */
  owner_name?: string | null
  /** Entity match metadata, if any. */
  entity_id?: string | null
  entity_name?: string | null
  entity_ticker?: string | null
  /**
   * Active market-page property-type filter (a rollup category). When
   * set, the detail panel scopes its property query to that type so it
   * shows only this owner's properties of that type.
   */
  property_type?: string | null
}

type AddressMeta = {
  address: string
  city: string | null
  state: string | null
  zip: string | null
  property_count: number
}

type LLCMeta = { name: string; property_count: number }

type TypeMeta = { bucket: string; count: number }

type DetailResponse = {
  filters: {
    state: string
    addresses: string[]
    stem: string | null
    owner: string | null
    hide_gov: boolean
  }
  summary: {
    property_count: number
    capped: boolean
    total_sqft: number | null
    sqft_coverage: number
    total_estimated_value: number | null
    value_coverage: number
    avg_year_built: number | null
    distinct_owners: number
    distinct_mailing_addresses: number
  }
  entity: {
    id: string
    name: string
    entity_type: string | null
    ticker: string | null
    total_properties: number | null
  } | null
  property_types: TypeMeta[]
  llcs: LLCMeta[]
  mailing_addresses: AddressMeta[]
  properties: Property[]
  error?: string
}

const LABEL_BADGE: Record<
  PortfolioPanelInput["label_type"],
  { text: string; tone: string }
> = {
  entity: {
    text: "Registered Entity",
    tone:
      "border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] text-[var(--intel-accent)]",
  },
  stem: {
    text: "Name Match",
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  },
  individual: {
    text: "Individual",
    tone: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  },
  address: {
    text: "Shared Address",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  },
  manual: {
    text: "Curated",
    tone:
      "border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] text-[var(--intel-accent)]",
  },
}

type SortKey = "value" | "sqft" | "year" | "type" | "address"

type Props = {
  input: PortfolioPanelInput
  onClose: () => void
}

export function PortfolioDetailPanel({ input, onClose }: Props) {
  const [data, setData] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAllLLCs, setShowAllLLCs] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>("value")
  const [sortAsc, setSortAsc] = useState(false)
  const [selectedProperty, setSelectedProperty] = useState<Property | null>(
    null,
  )

  // Client-side filters over the already-loaded property list. Cheaper
  // than re-querying the API for an in-portfolio narrowing — for
  // 100-200-property clusters a single pass through the array is
  // sub-millisecond.
  const [query, setQuery] = useState("")
  const [typeFilter, setTypeFilter] = useState<string | null>(null)

  // Build the query params once per input change.
  const params = useMemo(() => {
    const sp = new URLSearchParams()
    sp.set("state", input.state)
    const addrs = input.mailing_addresses ?? []
    for (const a of addrs) if (a) sp.append("address", a)
    if (input.stem) sp.set("stem", input.stem)
    if (input.owner_name) sp.set("owner", input.owner_name)
    if (input.property_type) sp.set("property_type", input.property_type)
    return sp
  }, [input])

  const slug = useMemo(() => {
    const base = input.primary_mailing_address ?? input.owner_name ?? input.display_name
    return encodeURIComponent(base ?? "portfolio")
  }, [input])

  const csvHref = useMemo(() => {
    const sp = new URLSearchParams(params)
    sp.set("name", input.display_name)
    return `/api/intelligence/portfolios/${slug}/export?${sp.toString()}`
  }, [params, slug, input.display_name])

  // Fetch the portfolio. Bumped on every (slug, params) change; the
  // ref-checked req id drops stale responses when the panel reopens with
  // a different cluster before the first response landed.
  const reqIdRef = useRef(0)
  const fetchPortfolio = useCallback(
    async (s: string, qs: string) => {
      const id = ++reqIdRef.current
      setLoading(true)
      setError(null)
      setData(null)
      try {
        const r = await fetch(`/api/intelligence/portfolios/${s}?${qs}`)
        const j = (await r.json()) as DetailResponse
        if (id !== reqIdRef.current) return
        if (j.error) setError(j.error)
        else setData(j)
      } catch (e: unknown) {
        if (id !== reqIdRef.current) return
        setError(e instanceof Error ? e.message : "Failed to load")
      } finally {
        if (id === reqIdRef.current) setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    fetchPortfolio(slug, params.toString())
  }, [slug, params, fetchPortfolio])

  // ESC closes the panel — falls through to the nested property panel
  // first if one is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (selectedProperty) setSelectedProperty(null)
      else onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, selectedProperty])

  const badge = LABEL_BADGE[input.label_type]

  const sortedProperties = useMemo(() => {
    if (!data) return []
    const needle = query.trim().toLowerCase()
    const filtered = data.properties.filter((p) => {
      // Text search hits address, city, and owner name. Lowercased once
      // above and each field compared as substring.
      if (needle) {
        const haystack = [
          p.street_address,
          p.city,
          p.owner_name,
          p.raw_owner_name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      // Property type filter uses the rollup categories (same labels the
      // breakdown chips render). null = no filter.
      if (typeFilter) {
        const cat = p.property_type ? rollupCategory(p.property_type) : "Other"
        if (cat !== typeFilter) return false
      }
      return true
    })
    const cmp = (a: Property, b: Property): number => {
      switch (sortKey) {
        case "sqft":
          return (a.building_sqft ?? 0) - (b.building_sqft ?? 0)
        case "year":
          return (a.year_built ?? 0) - (b.year_built ?? 0)
        case "type":
          return (a.property_type ?? "").localeCompare(b.property_type ?? "")
        case "address":
          return (a.street_address ?? "").localeCompare(b.street_address ?? "")
        case "value":
        default:
          return (a.estimated_value ?? 0) - (b.estimated_value ?? 0)
      }
    }
    filtered.sort((a, b) => (sortAsc ? cmp(a, b) : -cmp(a, b)))
    return filtered
  }, [data, sortKey, sortAsc, query, typeFilter])

  const sortBy = useCallback(
    (k: SortKey) => {
      setSortKey((prev) => {
        if (prev === k) {
          setSortAsc((a) => !a)
          return prev
        }
        // First click on a new column defaults to descending for the
        // numeric metrics, ascending for the text ones.
        setSortAsc(k === "address" || k === "type")
        return k
      })
    },
    [],
  )

  return (
    <>
      <div
        className="intel-overlay fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="intel-panel fixed right-0 top-0 z-50 flex h-screen w-full max-w-[860px] flex-col overflow-y-auto border-l border-[var(--intel-border)] bg-[var(--intel-bg)]"
      >
        {/* Sticky header */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--intel-border)] bg-[var(--intel-bg)]/95 px-6 py-3 backdrop-blur">
          <div className="text-[10px] uppercase tracking-widest text-[var(--intel-text-muted)]">
            portfolio detail
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-[var(--intel-text-muted)] transition-colors hover:bg-[var(--intel-bg-elev)] hover:text-[var(--intel-text)]"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="space-y-6 px-6 py-5">
          {/* Title + badge */}
          <section>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[20px] font-semibold leading-tight text-[var(--intel-text)]">
                  {input.display_name}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest ${badge.tone}`}
                  >
                    {badge.text}
                  </span>
                  {input.entity_ticker && (
                    <span
                      data-mono
                      className="text-[11px] text-[var(--intel-text-muted)]"
                    >
                      {input.entity_ticker}
                    </span>
                  )}
                  <span className="text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
                    scoped to {input.state}
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* Headline stats */}
          <SummaryStats loading={loading} data={data} />

          {/* Actions */}
          <ActionsBar
            csvHref={csvHref}
            disabled={loading || !data || data.summary.property_count === 0}
          />

          {/* Contact path — mailing addresses + entity */}
          <ContactPath
            input={input}
            data={data}
            loading={loading}
          />

          {/* Property type composition */}
          <PropertyTypeStrip data={data} loading={loading} />

          {/* LLC breakdown */}
          <LLCBreakdown
            data={data}
            loading={loading}
            showAll={showAllLLCs}
            onToggle={() => setShowAllLLCs((v) => !v)}
          />

          {/* Property table */}
          <PropertyTable
            data={data}
            sortedProperties={sortedProperties}
            loading={loading}
            error={error}
            sortKey={sortKey}
            sortAsc={sortAsc}
            onSortBy={sortBy}
            onSelect={setSelectedProperty}
            query={query}
            onQueryChange={setQuery}
            typeFilter={typeFilter}
            onTypeFilterChange={setTypeFilter}
          />
        </div>
      </div>

      {/* Nested property detail — slides over the portfolio panel. */}
      {selectedProperty && (
        <PropertyDetailPanel
          property={selectedProperty}
          onClose={() => setSelectedProperty(null)}
        />
      )}
    </>
  )
}

// ----------------------------------------------------------------------------
// Subcomponents
// ----------------------------------------------------------------------------

function SummaryStats({
  loading,
  data,
}: {
  loading: boolean
  data: DetailResponse | null
}) {
  const s = data?.summary
  const skel = loading && !data
  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat
        label="properties"
        value={s ? s.property_count.toLocaleString() : "—"}
        loading={skel}
        accent
      />
      <Stat
        label="total sqft"
        value={
          s
            ? // Hide the headline when fewer than 30% of properties carry a
              // building_sqft value — anything less and the sum is wildly
              // understated. TX TxGIO and MS MARIS are the main offenders.
              s.sqft_coverage < 0.3 || s.total_sqft == null
              ? "N/A"
              : fmtSqft(s.total_sqft)
            : "—"
        }
        hint={
          s && s.sqft_coverage < 0.3
            ? `Only ${Math.round(s.sqft_coverage * 100)}% of records carry a sqft value — sum hidden.`
            : undefined
        }
        loading={skel}
      />
      <Stat
        label="est. value"
        value={
          s && s.total_estimated_value != null
            ? fmtMoney(s.total_estimated_value)
            : "—"
        }
        loading={skel}
      />
      <Stat
        label="avg year built"
        value={s?.avg_year_built ? String(s.avg_year_built) : "—"}
        loading={skel}
      />
      <Stat
        label="distinct entities"
        value={s ? s.distinct_owners.toLocaleString() : "—"}
        loading={skel}
        small
      />
      <Stat
        label="mailing addresses"
        value={s ? s.distinct_mailing_addresses.toLocaleString() : "—"}
        loading={skel}
        small
      />
    </section>
  )
}

function ActionsBar({
  csvHref,
  disabled,
}: {
  csvHref: string
  disabled: boolean
}) {
  return (
    <section className="flex flex-wrap gap-2">
      <a
        href={disabled ? undefined : csvHref}
        aria-disabled={disabled}
        className={`rounded-md border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest transition-colors ${
          disabled
            ? "cursor-not-allowed border-[var(--intel-border)] bg-[var(--intel-bg-elev)] text-[var(--intel-text-dim)]"
            : "border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] text-[var(--intel-accent)] hover:bg-[var(--intel-accent)] hover:text-[var(--intel-bg)]"
        }`}
        title="Download every property in this portfolio as CSV (capped at 5,000 rows)"
      >
        ↓ export portfolio csv
      </a>
      <button
        type="button"
        disabled
        title="Coming soon — DillyV2 integration"
        className="cursor-not-allowed rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--intel-text-dim)]"
      >
        + add portfolio to pipeline
      </button>
    </section>
  )
}

function ContactPath({
  input,
  data,
  loading,
}: {
  input: PortfolioPanelInput
  data: DetailResponse | null
  loading: boolean
}) {
  // Prefer the addresses the server actually saw rows at — that's the
  // authoritative list. Fall back to the input-supplied addresses for the
  // initial render before the response lands.
  const addresses = data?.mailing_addresses ?? []
  const fallbackAddrs = (input.mailing_addresses ?? [])
    .filter(Boolean)
    .map<AddressMeta>((a) => ({
      address: a,
      city: null,
      state: null,
      zip: null,
      property_count: 0,
    }))

  const shown = addresses.length > 0 ? addresses : fallbackAddrs

  return (
    <Section title="Contact path">
      {data?.entity && (
        <div className="mb-3 rounded-md border border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-widest text-[var(--intel-text-muted)]">
            registered entity
          </div>
          <div className="mt-0.5 text-[14px] font-semibold text-[var(--intel-accent)]">
            {data.entity.name}
            {data.entity.ticker ? (
              <span data-mono className="ml-2 text-[11px] text-[var(--intel-text-muted)]">
                {data.entity.ticker}
              </span>
            ) : null}
          </div>
          {data.entity.entity_type && (
            <div className="text-[11px] text-[var(--intel-text-muted)]">
              {data.entity.entity_type}
            </div>
          )}
        </div>
      )}
      {loading && shown.length === 0 ? (
        <SkeletonRows count={2} />
      ) : shown.length === 0 ? (
        <Empty hint="No mailing address on file." />
      ) : (
        <div className="space-y-2">
          {shown.map((a, i) => {
            const full = [a.address, a.city, a.state, a.zip]
              .filter(Boolean)
              .join(", ")
            const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(full || a.address)}`
            return (
              <a
                key={`${a.address}-${i}`}
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-2 transition-colors hover:border-[var(--intel-accent-border)] hover:bg-[var(--intel-accent-soft)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-[var(--intel-text)]">
                      {a.address}
                    </div>
                    <div className="text-[11px] text-[var(--intel-text-muted)]">
                      {[a.city, a.state].filter(Boolean).join(", ")}
                      {a.zip ? ` ${a.zip}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {a.property_count > 0 && (
                      <span
                        data-mono
                        className="text-[11px] text-[var(--intel-text-muted)]"
                      >
                        {a.property_count} props
                      </span>
                    )}
                    <span className="text-[10px] uppercase tracking-widest text-[var(--intel-accent)]">
                      maps ↗
                    </span>
                  </div>
                </div>
              </a>
            )
          })}
        </div>
      )}
    </Section>
  )
}

function PropertyTypeStrip({
  data,
  loading,
}: {
  data: DetailResponse | null
  loading: boolean
}) {
  if (loading && !data) {
    return (
      <Section title="Property type composition">
        <SkeletonRows count={2} />
      </Section>
    )
  }
  const types = data?.property_types ?? []
  if (types.length === 0) return null
  const total = types.reduce((a, t) => a + t.count, 0)
  return (
    <Section title="Property type composition">
      <div className="flex flex-wrap gap-2">
        {types.map((t) => (
          <span
            key={t.bucket}
            className="rounded-full border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-2.5 py-1 text-[11px] text-[var(--intel-text)]"
            title={`${Math.round((t.count / Math.max(total, 1)) * 100)}% of portfolio`}
          >
            <span data-mono className="mr-1.5 text-[var(--intel-accent)]">
              {t.count}
            </span>
            {t.bucket}
          </span>
        ))}
      </div>
    </Section>
  )
}

function LLCBreakdown({
  data,
  loading,
  showAll,
  onToggle,
}: {
  data: DetailResponse | null
  loading: boolean
  showAll: boolean
  onToggle: () => void
}) {
  if (loading && !data) {
    return (
      <Section title="Entities in portfolio">
        <SkeletonRows count={3} />
      </Section>
    )
  }
  const llcs = data?.llcs ?? []
  if (llcs.length === 0) return null
  const preview = showAll ? llcs : llcs.slice(0, 5)
  const hiddenCount = Math.max(0, llcs.length - 5)
  return (
    <Section title={`Entities in portfolio (${llcs.length})`}>
      <ul className="space-y-1">
        {preview.map((l) => (
          <li key={l.name} className="flex items-center justify-between gap-2 text-[12px]">
            <span className="truncate text-[var(--intel-text)]" title={l.name}>
              {l.name}
            </span>
            <span data-mono className="shrink-0 text-[var(--intel-text-muted)]">
              {l.property_count} {l.property_count === 1 ? "prop" : "props"}
            </span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={onToggle}
          className="mt-2 text-[10px] uppercase tracking-widest text-[var(--intel-accent)] transition-colors hover:text-[var(--intel-accent-hover)]"
        >
          {showAll ? "show less" : `show all ${llcs.length} entities`}
        </button>
      )}
    </Section>
  )
}

function PropertyTable({
  data,
  sortedProperties,
  loading,
  error,
  sortKey,
  sortAsc,
  onSortBy,
  onSelect,
  query,
  onQueryChange,
  typeFilter,
  onTypeFilterChange,
}: {
  data: DetailResponse | null
  sortedProperties: Property[]
  loading: boolean
  error: string | null
  sortKey: SortKey
  sortAsc: boolean
  onSortBy: (k: SortKey) => void
  onSelect: (p: Property) => void
  query: string
  onQueryChange: (v: string) => void
  typeFilter: string | null
  onTypeFilterChange: (v: string | null) => void
}) {
  const total = data?.properties.length ?? 0
  const shown = sortedProperties.length
  const active = !!query || typeFilter != null
  return (
    <Section
      title={
        active
          ? `Properties (showing ${shown.toLocaleString()} of ${total.toLocaleString()})`
          : `Properties (${total.toLocaleString()})`
      }
    >
      {/* Filter row — text search across address/city/owner, plus a
         chip for each property type present in the portfolio. Both are
         client-side filters over the already-loaded list. */}
      {total > 0 && (
        <div className="mb-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="filter by address, city, or owner"
              className="flex-1 rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-1.5 text-[12px] text-[var(--intel-text)] placeholder-[var(--intel-text-dim)] outline-none focus:border-[var(--intel-accent-border)]"
            />
            {active && (
              <button
                type="button"
                onClick={() => {
                  onQueryChange("")
                  onTypeFilterChange(null)
                }}
                className="rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-2.5 py-1.5 text-[10px] uppercase tracking-widest text-[var(--intel-text-muted)] transition-colors hover:text-[var(--intel-text)]"
              >
                clear
              </button>
            )}
          </div>
          {(data?.property_types ?? []).length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {(data?.property_types ?? []).map((t) => {
                const selected = typeFilter === t.bucket
                return (
                  <button
                    key={t.bucket}
                    type="button"
                    onClick={() =>
                      onTypeFilterChange(selected ? null : t.bucket)
                    }
                    className={`rounded-full border px-2.5 py-0.5 text-[10px] transition-colors ${
                      selected
                        ? "border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] text-[var(--intel-accent)]"
                        : "border-[var(--intel-border)] bg-[var(--intel-bg-elev)] text-[var(--intel-text-muted)] hover:text-[var(--intel-text)]"
                    }`}
                  >
                    <span data-mono className="mr-1">
                      {t.count}
                    </span>
                    {t.bucket}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
          {error}
        </div>
      )}
      {loading && (!data || data.properties.length === 0) ? (
        <SkeletonRows count={8} />
      ) : sortedProperties.length === 0 ? (
        active ? (
          <Empty hint="No properties match the current filters." />
        ) : (
          <Empty />
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--intel-border)] text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
                <SortableTh label="address" col="address" current={sortKey} asc={sortAsc} onClick={onSortBy} />
                <th className="py-2 pr-2 text-left font-medium">city</th>
                <SortableTh label="type" col="type" current={sortKey} asc={sortAsc} onClick={onSortBy} />
                <SortableTh label="sqft" col="sqft" current={sortKey} asc={sortAsc} onClick={onSortBy} align="right" />
                <SortableTh label="built" col="year" current={sortKey} asc={sortAsc} onClick={onSortBy} align="right" />
                <SortableTh label="est. value" col="value" current={sortKey} asc={sortAsc} onClick={onSortBy} align="right" />
                <th className="py-2 pr-2 text-right font-medium w-8" />
              </tr>
            </thead>
            <tbody>
              {sortedProperties.map((p) => {
                const hasGeo = p.latitude != null && p.longitude != null
                const mapsUrl = hasGeo
                  ? `https://www.google.com/maps?q=${p.latitude},${p.longitude}`
                  : null
                return (
                  <tr
                    key={p.id}
                    onClick={() => onSelect(p)}
                    className="cursor-pointer border-b border-[var(--intel-border)]/50 transition-colors hover:bg-[var(--intel-bg-elev-2)]"
                  >
                    <td className="py-2 pr-2">
                      <div
                        className="truncate text-[12px] text-[var(--intel-text)] max-w-[220px]"
                        title={p.street_address ?? ""}
                      >
                        {p.street_address ?? "—"}
                      </div>
                    </td>
                    <td className="py-2 pr-2 text-[11px] text-[var(--intel-text-muted)]">
                      {p.city ?? "—"}
                    </td>
                    <td className="py-2 pr-2">
                      {p.property_type ? (
                        <span className="truncate rounded-full bg-[var(--intel-bg-elev-2)] px-2 py-0.5 text-[10px] text-[var(--intel-text)]" title={p.property_type}>
                          {prettyType(p.property_type)}
                        </span>
                      ) : (
                        <span className="text-[10px] text-[var(--intel-text-dim)]">—</span>
                      )}
                    </td>
                    <td data-mono className="py-2 pr-2 text-right text-[12px] text-[var(--intel-text)]">
                      {p.building_sqft != null ? fmtSqft(p.building_sqft) : "—"}
                    </td>
                    <td data-mono className="py-2 pr-2 text-right text-[12px] text-[var(--intel-text-muted)]">
                      {p.year_built ?? "—"}
                    </td>
                    <td data-mono className="py-2 pr-2 text-right text-[12px] text-[var(--intel-text)]">
                      {p.estimated_value != null ? fmtMoney(p.estimated_value) : "—"}
                    </td>
                    <td className="py-2 pr-2 text-right">
                      {mapsUrl ? (
                        <a
                          href={mapsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--intel-text-dim)] transition-colors hover:bg-[var(--intel-bg-elev)] hover:text-[var(--intel-accent)]"
                          title="Open in Google Maps"
                          aria-label="Open in Google Maps"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                            <circle cx="12" cy="10" r="3" />
                          </svg>
                        </a>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {data?.summary.capped && (
            <div className="mt-3 text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
              showing first {data.properties.length.toLocaleString()} — export csv for the full set
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

function SortableTh({
  label,
  col,
  current,
  asc,
  onClick,
  align,
}: {
  label: string
  col: SortKey
  current: SortKey
  asc: boolean
  onClick: (k: SortKey) => void
  align?: "right"
}) {
  const active = current === col
  const arrow = active ? (asc ? "↑" : "↓") : ""
  return (
    <th className={`py-2 pr-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onClick(col)}
        className={`flex w-full items-center gap-1 text-[10px] uppercase tracking-widest transition-colors ${
          align === "right" ? "justify-end" : "justify-start"
        } ${
          active
            ? "text-[var(--intel-accent)]"
            : "text-[var(--intel-text-dim)] hover:text-[var(--intel-text)]"
        }`}
      >
        <span>{label}</span>
        {arrow && <span>{arrow}</span>}
      </button>
    </th>
  )
}

// ----------------------------------------------------------------------------
// Atoms
// ----------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h3 className="mb-2 text-[10px] uppercase tracking-[0.2em] text-[var(--intel-text-muted)]">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Stat({
  label,
  value,
  loading,
  accent,
  small,
  hint,
}: {
  label: string
  value: string
  loading: boolean
  accent?: boolean
  small?: boolean
  hint?: string
}) {
  return (
    <div
      className="rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] p-3"
      title={hint}
    >
      <div className="text-[9px] uppercase tracking-widest text-[var(--intel-text-dim)]">
        {label}
      </div>
      <div
        data-mono
        className={`mt-1 ${small ? "text-[13px]" : "text-[17px]"} ${
          accent ? "text-[var(--intel-accent)]" : "text-[var(--intel-text)]"
        }`}
      >
        {loading ? (
          <span className="inline-block h-5 w-20 rounded intel-skeleton" />
        ) : (
          value
        )}
      </div>
    </div>
  )
}

function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-5 rounded intel-skeleton" />
      ))}
    </div>
  )
}

function Empty({ hint }: { hint?: string }) {
  return (
    <div className="py-6 text-center text-[12px] text-[var(--intel-text-muted)]">
      {hint ?? "No data for this portfolio."}
    </div>
  )
}

function prettyType(s: string): string {
  return s.replace(/_/g, " ").toLowerCase()
}

function fmtSqft(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000).toLocaleString()}k`
  return `${Math.round(n).toLocaleString()}`
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`
  return `$${Math.round(n)}`
}
