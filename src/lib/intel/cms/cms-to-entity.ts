import type { CmsEntityGroup, CmsFacility } from './types'

export type IntelEntityPayload = {
  name: string
  entity_type: string
  source_detail: string
  sector: string
  hq_state: string | null
  total_properties: number
  portfolio_summary: Record<string, unknown>
  subsidiary_names: string[]
  needs_website_scrape: boolean
  last_enriched_by: string
  updated_at: string
}

export type IntelPropertyPayload = {
  property_name: string
  street_address: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  property_type: string
  owner_name: string | null
  owner_type: string | null
  source_detail: string
  external_id: string
  entity_id?: string
  updated_at: string
}

const CMS_SOURCE = 'cms_provider_data'

function mostCommonState(facilities: CmsFacility[]): string | null {
  const counts = new Map<string, number>()
  for (const f of facilities) {
    if (!f.state) continue
    counts.set(f.state, (counts.get(f.state) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

function marketBreakdown(facilities: CmsFacility[]): Array<{ state: string; city: string | null; facility_count: number }> {
  const map = new Map<string, { state: string; city: string | null; facility_count: number }>()
  for (const f of facilities) {
    if (!f.state) continue
    const key = `${f.state}||${f.city ?? ''}`
    const existing = map.get(key)
    if (existing) {
      existing.facility_count++
    } else {
      map.set(key, { state: f.state, city: f.city, facility_count: 1 })
    }
  }
  return [...map.values()].sort((a, b) => b.facility_count - a.facility_count)
}

export function entityGroupToPayload(group: CmsEntityGroup): IntelEntityPayload {
  const now = new Date().toISOString()
  return {
    name: group.entity_name,
    entity_type: 'healthcare_system',
    source_detail: CMS_SOURCE,
    sector: 'healthcare',
    hq_state: mostCommonState(group.facilities),
    total_properties: group.total_count,
    portfolio_summary: {
      facility_type: group.facility_type,
      total_facilities: group.total_count,
      states: group.states,
      operating_markets: marketBreakdown(group.facilities),
    },
    subsidiary_names: group.facilities.map(f => f.name).slice(0, 500),
    needs_website_scrape: true,
    last_enriched_by: 'cms_intelligence',
    updated_at: now,
  }
}

export function facilityToPayload(facility: CmsFacility, entityId?: string): IntelPropertyPayload {
  const now = new Date().toISOString()
  return {
    property_name: facility.name,
    street_address: facility.address,
    city: facility.city,
    state: facility.state,
    postal_code: facility.zip,
    property_type: 'healthcare',
    owner_name: facility.chain_name ?? facility.ownership,
    owner_type: facility.ownership,
    source_detail: CMS_SOURCE,
    external_id: facility.id,
    entity_id: entityId,
    updated_at: now,
  }
}
