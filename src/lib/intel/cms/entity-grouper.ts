import type { CmsEntityGroup, CmsFacility, CmsFacilityType } from './types'

export function normalizeEntityName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[,.]/g, '')
    .replace(/\s+(LLC|L\.L\.C\.|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LP|L\.P\.|PLLC|PC|PA)\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildGroups(
  facilities: CmsFacility[],
  pickKey: (f: CmsFacility) => string | null,
  facilityType: CmsFacilityType
): CmsEntityGroup[] {
  const map = new Map<string, { displayName: string; facilities: CmsFacility[] }>()

  for (const f of facilities) {
    const rawKey = pickKey(f)
    if (!rawKey) continue
    const normalized = normalizeEntityName(rawKey)
    if (!normalized || normalized.length < 2) continue

    const existing = map.get(normalized)
    if (existing) {
      existing.facilities.push(f)
    } else {
      map.set(normalized, { displayName: rawKey.trim(), facilities: [f] })
    }
  }

  const groups: CmsEntityGroup[] = []
  for (const { displayName, facilities: groupFacilities } of map.values()) {
    const states = Array.from(
      new Set(groupFacilities.map(f => f.state).filter((s): s is string => !!s))
    )
    groups.push({
      entity_name: displayName,
      entity_type: 'healthcare_system',
      facility_type: facilityType,
      facilities: groupFacilities,
      total_count: groupFacilities.length,
      states,
    })
  }

  return groups
}

export function groupHospitals(facilities: CmsFacility[]): CmsEntityGroup[] {
  return buildGroups(facilities, f => f.ownership, 'hospital')
}

export function groupNursingHomes(facilities: CmsFacility[]): CmsEntityGroup[] {
  // Prefer chain_name, fallback to ownership_type
  return buildGroups(
    facilities,
    f => f.chain_name && f.chain_name.length > 1 ? f.chain_name : f.ownership,
    'nursing_home'
  )
}

export function groupDialysis(facilities: CmsFacility[]): CmsEntityGroup[] {
  // Prefer chain_organization, fallback to facility name (standalone centers)
  return buildGroups(
    facilities,
    f => f.chain_name && f.chain_name.length > 1 ? f.chain_name : f.name,
    'dialysis'
  )
}
