"use client"

import { useEffect, useState } from "react"
import type { Property } from "../types"

type Props = {
  property: Property
  onClose: () => void
}

export function PropertyDetailPanel({ property, onClose }: Props) {
  const p = property
  const [rawOpen, setRawOpen] = useState(false)
  const hasGeo = p.latitude != null && p.longitude != null
  const mapsUrl = hasGeo
    ? `https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`
    : null

  // Larger satellite image
  const bigSatellite = hasGeo && p.satellite_url
    ? p.satellite_url.replace("size=400x220", "size=640x360").replace("zoom=18", "zoom=19")
    : null

  // ESC to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <>
      <div
        className="intel-overlay fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="intel-panel fixed right-0 top-0 z-50 flex h-screen w-full max-w-[640px] flex-col overflow-y-auto border-l border-[var(--intel-border)] bg-[var(--intel-bg)]"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--intel-border)] bg-[var(--intel-bg)]/95 px-6 py-3 backdrop-blur">
          <div className="text-[10px] uppercase tracking-widest text-[var(--intel-text-muted)]">
            property detail
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

        {/* Image */}
        <div className="relative aspect-[64/36] w-full overflow-hidden bg-[var(--intel-bg-elev-2)]">
          {bigSatellite ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={bigSatellite} alt={`Satellite view of ${p.street_address}`} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[var(--intel-text-dim)]">
              No coordinates available
            </div>
          )}
          {mapsUrl && (
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute bottom-3 right-3 rounded bg-black/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-white backdrop-blur transition-colors hover:bg-[var(--intel-accent)] hover:text-[var(--intel-bg)]"
            >
              open in maps ↗
            </a>
          )}
        </div>

        <div className="space-y-6 px-6 py-5">
          {/* Address block */}
          <section>
            <div className="text-[18px] font-semibold text-[var(--intel-text)]">{p.street_address}</div>
            <div className="text-[13px] text-[var(--intel-text-muted)]">
              {p.city}, {p.state} {p.postal_code ?? ""}
            </div>
            {p.county && (
              <div className="text-[12px] text-[var(--intel-text-dim)]">{p.county} County</div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {p.property_type && <Pill>{p.property_type}</Pill>}
              {p.corporate_owned === true && <Pill accent>Corporate Owned</Pill>}
              {p.absentee_owner === true && <Pill>Absentee</Pill>}
              {p.entity && <Pill accent>Portfolio Match</Pill>}
            </div>
          </section>

          {/* Stats */}
          <section className="grid grid-cols-3 gap-3">
            <DetailStat label="Building" value={p.building_sqft ? `${p.building_sqft.toLocaleString()} sqft` : "—"} />
            <DetailStat label="Lot" value={p.lot_size_sqft ? `${p.lot_size_sqft.toLocaleString()} sqft` : "—"} />
            <DetailStat label="Year Built" value={p.year_built ? String(p.year_built) : "—"} />
            <DetailStat label="Est. Value" value={p.estimated_value ? fmtMoney(p.estimated_value) : "—"} accent />
            <DetailStat label="APN" value={p.apn ?? "—"} small />
            <DetailStat label="Latitude" value={p.latitude ? p.latitude.toFixed(6) : "—"} small />
          </section>

          {/* Owner */}
          <Section title="Ownership">
            <KV label="Owner Name" value={p.owner_name ?? p.raw_owner_name ?? "—"} />
            <KV
              label="Owner Type"
              value={p.corporate_owned == null ? "—" : p.corporate_owned ? "Corporate Entity" : "Individual"}
            />
            <KV
              label="Mailing Address"
              value={
                p.owner_mailing_address
                  ? `${p.owner_mailing_address}, ${p.owner_mailing_city ?? ""} ${p.owner_mailing_state ?? ""} ${p.owner_mailing_zip ?? ""}`.trim()
                  : "—"
              }
            />
            <KV label="Absentee" value={p.absentee_owner == null ? "—" : p.absentee_owner ? "Yes" : "No"} />
          </Section>

          {/* Entity */}
          <Section title="Portfolio / Entity">
            {p.entity ? (
              <>
                <KV label="Entity Name" value={p.entity.name} />
                <KV label="Type" value={p.entity.entity_type ?? "—"} />
                <KV label="Ticker" value={p.entity.ticker ?? "—"} mono />
                <KV
                  label="Total Properties"
                  value={p.entity.total_properties != null ? p.entity.total_properties.toLocaleString() : "—"}
                  mono
                />
              </>
            ) : (
              <div className="text-[12px] text-[var(--intel-text-dim)]">
                Not matched to a known portfolio. Owner name is held in <code className="text-[var(--intel-text-muted)]">raw_owner_name</code> for future matching.
              </div>
            )}
          </Section>

          {/* Sources */}
          <Section title="Source">
            <KV label="Source" value="proptracer_mapping" mono />
            <KV label="PropTracer ID" value={p.proptracer_id ?? "—"} mono />
            <KV label="Enrichment" value={p.enrichment_status ?? "—"} mono />
            <KV
              label="Last Updated"
              value={p.updated_at ? new Date(p.updated_at).toLocaleString() : "—"}
              mono
            />
          </Section>

          {/* Raw */}
          <Section title="Raw Data">
            <button
              onClick={() => setRawOpen((v) => !v)}
              className="text-[11px] uppercase tracking-widest text-[var(--intel-text-muted)] transition-colors hover:text-[var(--intel-accent)]"
            >
              {rawOpen ? "− hide" : "+ show"}
            </button>
            {rawOpen && (
              <pre
                data-mono
                className="mt-2 max-h-72 overflow-auto rounded border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] p-3 text-[10px] leading-relaxed text-[var(--intel-text-muted)]"
              >
                {JSON.stringify(p, null, 2)}
              </pre>
            )}
          </Section>
        </div>
      </div>
    </>
  )
}

function Pill({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-widest ${
        accent
          ? "border border-[var(--intel-accent-border)] bg-[var(--intel-accent-soft)] text-[var(--intel-accent)]"
          : "border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] text-[var(--intel-text-muted)]"
      }`}
    >
      {children}
    </span>
  )
}

function DetailStat({
  label,
  value,
  accent,
  small,
}: {
  label: string
  value: string
  accent?: boolean
  small?: boolean
}) {
  return (
    <div className="rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] p-3">
      <div className="text-[9px] uppercase tracking-widest text-[var(--intel-text-dim)]">{label}</div>
      <div
        data-mono
        className={`mt-1 ${small ? "text-[12px]" : "text-[15px]"} ${
          accent ? "text-[var(--intel-accent)]" : "text-[var(--intel-text)]"
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[10px] uppercase tracking-[0.2em] text-[var(--intel-text-muted)]">{title}</h3>
      <div className="rounded-md border border-[var(--intel-border)] bg-[var(--intel-bg-elev)] p-3">
        <div className="space-y-1.5">{children}</div>
      </div>
    </section>
  )
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 text-[12px]">
      <span className="text-[var(--intel-text-dim)]">{label}</span>
      <span className={`text-right text-[var(--intel-text)] ${mono ? "font-mono" : ""}`} data-mono={mono ? "" : undefined}>
        {value}
      </span>
    </div>
  )
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}k`
  return `$${Math.round(n).toLocaleString()}`
}
