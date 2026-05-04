"use client"

import { useEffect, useState } from "react"

export type Filters = {
  search: string
  state: string
  county: string
  propertyTypes: string[]
  minSqft: number
  maxSqft: number
  ownerType: "all" | "corporate" | "individual"
  portfolioMatch: "all" | "matched"
  minYear: string
  maxYear: string
  // Radius search — built but UI is hidden until coordinates are
  // backfilled across all sources. Wire-only for now.
  nearAddress: string
  radiusMiles: number
}

const RADIUS_OPTIONS = [10, 25, 50, 100] as const

const PROPERTY_TYPES = [
  "Office",
  "Retail",
  "Industrial",
  "Multifamily",
  "Healthcare",
  "Self Storage",
  "Mixed Use",
  "Other",
]

const SQFT_MIN = 1500
const SQFT_MAX = 500_000

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
]

type Props = {
  initial: Filters
  onApply: (f: Filters) => void
  onSearchChange: (v: string) => void
  onClear: () => void
}

export function FilterSidebar({ initial, onApply, onSearchChange, onClear }: Props) {
  const [filters, setFilters] = useState<Filters>(initial)

  // Sync external changes (e.g. from URL on first load).
  const initialTypesKey = initial.propertyTypes.join(",")
  useEffect(() => {
    setFilters(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    initial.search,
    initial.state,
    initial.county,
    initialTypesKey,
    initial.minSqft,
    initial.maxSqft,
    initial.ownerType,
    initial.portfolioMatch,
    initial.minYear,
    initial.maxYear,
    initial.nearAddress,
    initial.radiusMiles,
  ])

  function update<K extends keyof Filters>(key: K, val: Filters[K]) {
    setFilters((f) => ({ ...f, [key]: val }))
  }

  function toggleType(t: string) {
    setFilters((f) => ({
      ...f,
      propertyTypes: f.propertyTypes.includes(t)
        ? f.propertyTypes.filter((x) => x !== t)
        : [...f.propertyTypes, t],
    }))
  }

  function clear() {
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
      nearAddress: "",
      radiusMiles: 25,
    }
    setFilters(cleared)
    onClear()
  }

  function useMyLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(5)
        const lon = pos.coords.longitude.toFixed(5)
        update("nearAddress", `${lat},${lon}`)
      },
      () => {
        // Permission denied / unsupported — no-op for now
      }
    )
  }

  return (
    <aside className="w-[320px] flex-shrink-0 border-r border-[var(--intel-border)] bg-[var(--intel-bg)]">
      <div className="sticky top-0 max-h-screen overflow-y-auto px-5 py-5">
        <div className="mb-5">
          <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--intel-text-muted)]">
            property intelligence
          </div>
          <div className="text-[13px] font-medium text-[var(--intel-text)] mt-0.5">
            filters
          </div>
        </div>

        {/* Location search — debounced live (parent debounces). Accepts:
           - "37138"            zip exact
           - "37138-1234"       zip prefix
           - "37138 Memphis"    zip + city
           - "Shelby County"    county
           - "Memphis"          city */}
        <FilterGroup label="location">
          <input
            type="text"
            placeholder="city, zip code, or county"
            value={filters.search}
            onChange={(e) => {
              update("search", e.target.value)
              onSearchChange(e.target.value)
            }}
            className="w-full rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-2 text-[13px] text-[var(--intel-text)] placeholder-[var(--intel-text-dim)] outline-none transition-colors focus:border-[var(--intel-accent-border)]"
          />
        </FilterGroup>

        {/* State */}
        <FilterGroup label="state">
          <select
            value={filters.state}
            onChange={(e) => update("state", e.target.value)}
            className="w-full rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-2 text-[13px] text-[var(--intel-text)] outline-none focus:border-[var(--intel-accent-border)]"
          >
            <option value="">All states</option>
            {US_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </FilterGroup>

        {/* County — populated on PropTracer + some public sources only */}
        <FilterGroup label="county">
          <input
            type="text"
            placeholder="e.g. Shelby, Wake, Harris"
            value={filters.county}
            onChange={(e) => update("county", e.target.value)}
            className="w-full rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-2 text-[13px] text-[var(--intel-text)] placeholder-[var(--intel-text-dim)] outline-none transition-colors focus:border-[var(--intel-accent-border)]"
          />
          <div className="mt-1.5 text-[10px] leading-snug text-[var(--intel-text-dim)]">
            County search works best for TN properties; public-data sources have partial coverage.
          </div>
        </FilterGroup>

        {/* Radius search — wired to API but UI hidden until coordinates
           are backfilled across all sources. Set the parent style to
           something other than `display:none` to enable. */}
        <FilterGroup label="near address" hidden>
          <input
            type="text"
            placeholder="address, city, or 'lat,lon'"
            value={filters.nearAddress}
            onChange={(e) => update("nearAddress", e.target.value)}
            className="w-full rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-2 text-[13px] text-[var(--intel-text)] placeholder-[var(--intel-text-dim)] outline-none focus:border-[var(--intel-accent-border)]"
          />
          <div className="mt-2 flex gap-2">
            <select
              value={filters.radiusMiles}
              onChange={(e) => update("radiusMiles", parseInt(e.target.value, 10))}
              className="flex-1 rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-1.5 text-[13px] text-[var(--intel-text)] outline-none focus:border-[var(--intel-accent-border)]"
            >
              {RADIUS_OPTIONS.map((r) => (
                <option key={r} value={r}>{r} miles</option>
              ))}
            </select>
            <button
              type="button"
              onClick={useMyLocation}
              className="rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-1.5 text-[10px] uppercase tracking-widest text-[var(--intel-text-muted)] hover:text-[var(--intel-text)]"
            >
              use my location
            </button>
          </div>
        </FilterGroup>

        {/* Property type */}
        <FilterGroup label="property type">
          <div className="grid grid-cols-2 gap-1.5">
            {PROPERTY_TYPES.map((t) => (
              <Checkbox
                key={t}
                label={t}
                checked={filters.propertyTypes.includes(t)}
                onChange={() => toggleType(t)}
              />
            ))}
          </div>
        </FilterGroup>

        {/* Building size — dual range */}
        <FilterGroup label="building size">
          <div className="flex items-baseline justify-between text-[11px] mb-2">
            <span data-mono className="text-[var(--intel-text)]">
              {fmtSqft(filters.minSqft)}
            </span>
            <span className="text-[var(--intel-text-dim)]">–</span>
            <span data-mono className="text-[var(--intel-text)]">
              {filters.maxSqft >= SQFT_MAX ? `${fmtSqft(SQFT_MAX)}+` : fmtSqft(filters.maxSqft)}
            </span>
          </div>
          <div className="space-y-1.5">
            <input
              type="range"
              min={SQFT_MIN}
              max={SQFT_MAX}
              step={500}
              value={filters.minSqft}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                update("minSqft", Math.min(v, filters.maxSqft - 500))
              }}
              className="w-full"
            />
            <input
              type="range"
              min={SQFT_MIN}
              max={SQFT_MAX}
              step={500}
              value={filters.maxSqft}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                update("maxSqft", Math.max(v, filters.minSqft + 500))
              }}
              className="w-full"
            />
          </div>
        </FilterGroup>

        {/* Owner type */}
        <FilterGroup label="owner type">
          <ToggleGroup
            value={filters.ownerType}
            onChange={(v) => update("ownerType", v as Filters["ownerType"])}
            options={[
              { value: "all", label: "All" },
              { value: "corporate", label: "Corporate" },
              { value: "individual", label: "Individual" },
            ]}
          />
        </FilterGroup>

        {/* Portfolio match */}
        <FilterGroup label="portfolio match">
          <ToggleGroup
            value={filters.portfolioMatch}
            onChange={(v) => update("portfolioMatch", v as Filters["portfolioMatch"])}
            options={[
              { value: "all", label: "All" },
              { value: "matched", label: "Matched" },
            ]}
          />
        </FilterGroup>

        {/* Year built */}
        <FilterGroup label="year built">
          <div className="flex gap-2">
            <input
              type="number"
              placeholder="From"
              value={filters.minYear}
              onChange={(e) => update("minYear", e.target.value)}
              className="w-1/2 rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-1.5 text-[13px] text-[var(--intel-text)] placeholder-[var(--intel-text-dim)] outline-none focus:border-[var(--intel-accent-border)]"
            />
            <input
              type="number"
              placeholder="To"
              value={filters.maxYear}
              onChange={(e) => update("maxYear", e.target.value)}
              className="w-1/2 rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] px-3 py-1.5 text-[13px] text-[var(--intel-text)] placeholder-[var(--intel-text-dim)] outline-none focus:border-[var(--intel-accent-border)]"
            />
          </div>
        </FilterGroup>

        <button
          onClick={() => onApply(filters)}
          className="mt-2 w-full rounded-md bg-[var(--intel-accent)] px-3 py-2.5 text-[12px] font-semibold uppercase tracking-widest text-[var(--intel-bg)] transition-colors hover:bg-[var(--intel-accent-hover)]"
        >
          apply filters
        </button>
        <button
          onClick={clear}
          className="mt-2 w-full text-center text-[11px] uppercase tracking-widest text-[var(--intel-text-muted)] transition-colors hover:text-[var(--intel-text)]"
        >
          clear all
        </button>
      </div>
    </aside>
  )
}

function FilterGroup({
  label,
  children,
  hidden,
}: {
  label: string
  children: React.ReactNode
  hidden?: boolean
}) {
  return (
    <div className="mb-5" style={hidden ? { display: "none" } : undefined}>
      <div className="mb-2 text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
        {label}
      </div>
      {children}
    </div>
  )
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-[12px] transition-colors ${
        checked
          ? "border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] text-[var(--intel-text)]"
          : "border-[var(--intel-border)] bg-[var(--intel-bg-elev)] text-[var(--intel-text-muted)] hover:border-[var(--intel-border-strong)] hover:text-[var(--intel-text)]"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="sr-only"
      />
      <span
        className={`flex h-3 w-3 flex-shrink-0 items-center justify-center rounded-sm border ${
          checked ? "border-[var(--intel-accent)] bg-[var(--intel-accent)]" : "border-[var(--intel-border-strong)]"
        }`}
      >
        {checked && (
          <svg width="8" height="8" viewBox="0 0 12 12" fill="none">
            <path d="M2 6.5L5 9L10 3" stroke="#0f1117" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      {label}
    </label>
  )
}

function ToggleGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="flex rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
            value === o.value
              ? "bg-[var(--intel-accent)] text-[var(--intel-bg)]"
              : "text-[var(--intel-text-muted)] hover:text-[var(--intel-text)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function fmtSqft(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}
