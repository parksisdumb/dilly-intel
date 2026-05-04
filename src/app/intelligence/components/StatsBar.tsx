"use client"

import Link from "next/link"
import { CountUp } from "./CountUp"

type Stats = {
  total: number
  corporate_count: number
  corporate_pct: number
  // True when explicit corporate_owned values cover >50% of the filtered
  // set. Below that threshold, the percentage is unreliable (FL DOR rows
  // mostly have NULL) and the StatsBar shows "N/A" instead.
  corporate_pct_reliable?: boolean
  matched_count: number
  avg_sqft: number
}

type Props = {
  stats: Stats | null
  loading: boolean
  lastUpdated: string | null
}

export function StatsBar({ stats, loading, lastUpdated }: Props) {
  return (
    <div className="border-b border-[var(--intel-border)] bg-[var(--intel-bg-elev)]">
      <div className="flex items-center gap-8 px-6 py-3">
        <Brand />
        <div className="h-6 w-px bg-[var(--intel-border)]" />
        <Stat
          label="properties"
          value={stats?.total ?? 0}
          loading={loading}
          accent
        />
        <Stat
          label="corporate owned"
          value={stats?.corporate_pct ?? 0}
          loading={loading}
          format={(n) => `${Math.round(n)}%`}
          unavailable={stats != null && stats.corporate_pct_reliable === false}
        />
        <Stat
          label="portfolio matched"
          value={stats?.matched_count ?? 0}
          loading={loading}
        />
        <Stat
          label="avg sqft"
          value={stats?.avg_sqft ?? 0}
          loading={loading}
        />
        <div className="ml-auto flex items-center gap-4">
          <Link
            href="/intelligence/market"
            className="text-[11px] uppercase tracking-widest text-[var(--intel-text-muted)] transition-colors hover:text-[var(--intel-accent)]"
          >
            market coverage →
          </Link>
          <div className="text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
            {lastUpdated ? `updated ${fmtRelative(lastUpdated)}` : "live"}
          </div>
        </div>
      </div>
    </div>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-7 w-7 items-center justify-center rounded bg-[var(--intel-accent)] text-[var(--intel-bg)]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 21h18" />
          <path d="M5 21V8l7-5 7 5v13" />
          <path d="M9 21v-7h6v7" />
        </svg>
      </div>
      <div className="leading-tight">
        <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--intel-text-muted)]">
          dilly intel
        </div>
        <div className="text-[13px] font-semibold text-[var(--intel-text)]">
          property intelligence
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  loading,
  accent,
  format,
  unavailable,
}: {
  label: string
  value: number
  loading: boolean
  accent?: boolean
  format?: (n: number) => string
  unavailable?: boolean
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-[var(--intel-text-dim)]">
        {label}
      </div>
      <div
        data-mono
        title={unavailable ? "insufficient ownership data" : undefined}
        className={`text-lg font-medium ${
          unavailable
            ? "text-[var(--intel-text-dim)]"
            : accent
              ? "text-[var(--intel-accent)]"
              : "text-[var(--intel-text)]"
        }`}
      >
        {loading && value === 0 ? (
          <span className="inline-block h-[22px] w-20 rounded intel-skeleton" />
        ) : unavailable ? (
          <span>N/A</span>
        ) : (
          <CountUp value={value} format={format} />
        )}
      </div>
    </div>
  )
}

function fmtRelative(iso: string): string {
  try {
    const t = new Date(iso).getTime()
    const diff = Date.now() - t
    if (diff < 60_000) return "just now"
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return `${Math.floor(diff / 86_400_000)}d ago`
  } catch {
    return ""
  }
}
