"use client"

import { useState } from "react"
import type { Property } from "../types"

type Props = {
  property: Property
  onViewDetails: () => void
}

export function PropertyCard({ property, onViewDetails }: Props) {
  const [imgFailed, setImgFailed] = useState(false)
  const p = property
  const hasGeo = p.latitude != null && p.longitude != null
  const mapsUrl = hasGeo
    ? `https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`
    : null

  return (
    <div className="intel-card group flex flex-col overflow-hidden rounded-lg border border-[var(--intel-border)] bg-[var(--intel-bg-elev)]">
      {/* Satellite image */}
      <div className="relative aspect-[40/22] w-full overflow-hidden bg-[var(--intel-bg-elev-2)]">
        {p.satellite_url && !imgFailed ? (
          <a href={mapsUrl ?? "#"} target="_blank" rel="noopener noreferrer" className="block h-full w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.satellite_url}
              alt={`Satellite view of ${p.street_address}`}
              loading="lazy"
              onError={() => setImgFailed(true)}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
          </a>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[var(--intel-text-dim)]">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 21h18" />
              <path d="M5 21V8l7-5 7 5v13" />
              <path d="M9 21v-7h6v7" />
            </svg>
          </div>
        )}

        {/* Corp badge */}
        {p.corporate_owned === true && (
          <div className="absolute right-2 top-2 rounded bg-[var(--intel-accent)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-[var(--intel-bg)]">
            Corp
          </div>
        )}

        {/* Property type pill */}
        {p.property_type && (
          <div className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white backdrop-blur-sm">
            {prettyPropType(p.property_type)}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-1.5 p-3.5">
        <div>
          <div className="truncate text-[13px] font-semibold text-[var(--intel-text)]" title={p.street_address ?? ""}>
            {p.street_address ?? "—"}
          </div>
          <div className="truncate text-[11px] text-[var(--intel-text-muted)]">
            {p.city}, {p.state} {p.postal_code ?? ""}
          </div>
        </div>

        <div className="space-y-0.5 pt-0.5">
          <div
            className={`truncate text-[11px] ${
              p.corporate_owned ? "text-[var(--intel-accent)]" : "text-[var(--intel-text-muted)]"
            }`}
            title={p.owner_name ?? ""}
          >
            {p.owner_name ?? "Unknown owner"}
          </div>
          <div className="truncate text-[10px]">
            {p.entity ? (
              <span className="text-[var(--intel-text)]">
                <span className="text-[var(--intel-text-dim)]">portfolio · </span>
                {p.entity.name}
                {p.entity.ticker ? (
                  <span className="ml-1 text-[var(--intel-text-dim)]" data-mono>
                    {p.entity.ticker}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-[var(--intel-text-dim)]">portfolio · unmatched</span>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="mt-2 flex items-center gap-3 border-t border-[var(--intel-border)] pt-2 text-[11px]" data-mono>
          <Stat label="sqft" value={p.building_sqft ? fmtNumber(p.building_sqft) : "—"} />
          <Stat label="built" value={p.year_built ? String(p.year_built) : "—"} />
          <Stat label="value" value={p.estimated_value ? fmtMoney(p.estimated_value) : "—"} />
        </div>

        {/* Footer */}
        <div className="mt-3 flex gap-2">
          <button
            onClick={onViewDetails}
            className="flex-1 rounded border border-[var(--intel-border-strong)] bg-transparent px-2 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--intel-text)] transition-colors hover:border-[var(--intel-accent-border)] hover:text-[var(--intel-accent)]"
          >
            view details
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              // Placeholder for Dilly V2 push
            }}
            disabled
            className="flex-1 rounded bg-[var(--intel-accent)] px-2 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--intel-bg)] transition-opacity hover:bg-[var(--intel-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            title="Push to Dilly — coming soon"
          >
            add to pipeline
          </button>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-1 flex-col leading-tight">
      <span className="text-[9px] uppercase tracking-widest text-[var(--intel-text-dim)]">{label}</span>
      <span className="text-[12px] text-[var(--intel-text)]">{value}</span>
    </div>
  )
}

function fmtNumber(n: number): string {
  return Math.round(n).toLocaleString()
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1000) return `$${Math.round(n / 1000)}k`
  return `$${Math.round(n)}`
}

function prettyPropType(t: string): string {
  return t
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

export function PropertyCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--intel-border)] bg-[var(--intel-bg-elev)]">
      <div className="aspect-[40/22] w-full intel-skeleton" />
      <div className="space-y-2 p-3.5">
        <div className="h-3.5 w-3/4 rounded intel-skeleton" />
        <div className="h-3 w-1/2 rounded intel-skeleton" />
        <div className="h-2.5 w-2/3 rounded intel-skeleton" />
        <div className="h-2.5 w-1/2 rounded intel-skeleton" />
        <div className="mt-2 flex gap-3 border-t border-[var(--intel-border)] pt-2">
          <div className="h-6 flex-1 rounded intel-skeleton" />
          <div className="h-6 flex-1 rounded intel-skeleton" />
          <div className="h-6 flex-1 rounded intel-skeleton" />
        </div>
        <div className="mt-2 flex gap-2">
          <div className="h-7 flex-1 rounded intel-skeleton" />
          <div className="h-7 flex-1 rounded intel-skeleton" />
        </div>
      </div>
    </div>
  )
}
