import type { createAdminClient } from '@/lib/supabase/admin'
import type { EntityResolveResult } from './types'

type SupabaseClient = ReturnType<typeof createAdminClient>

export function normalizeOwnerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/,?\s+(llc|l\.l\.c\.|lp|l\.p\.|llp|l\.l\.p\.|inc|incorporated|corp|corporation|co|company|trust|reit|holdings|properties|property|realty|ltd|limited|pllc|pc|pa|association|assoc)\.?$/gi, '')
    .replace(/[.,'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export type EntityIndex = {
  // exact lowercase match → entity_id
  exact: Map<string, string>
  // normalized name → entity_id (Level 2)
  normalized: Map<string, string>
  // normalized subsidiary name → entity_id (Level 3)
  subsidiary: Map<string, string>
  // cached raw lookups (per-run memoization)
  cache: Map<string, EntityResolveResult>
}

export async function buildEntityIndex(supabase: SupabaseClient): Promise<EntityIndex> {
  const index: EntityIndex = {
    exact: new Map(),
    normalized: new Map(),
    subsidiary: new Map(),
    cache: new Map(),
  }

  // Paginate over all entities (likely a few thousand rows)
  const pageSize = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('intel_entities')
      .select('id, name, subsidiary_names')
      .range(offset, offset + pageSize - 1)

    if (error || !data || data.length === 0) break

    for (const row of data) {
      if (!row.name) continue
      const id = row.id as string
      const name = row.name as string
      const lower = name.toLowerCase().trim()
      const norm = normalizeOwnerName(name)

      if (!index.exact.has(lower)) index.exact.set(lower, id)
      if (norm && !index.normalized.has(norm)) index.normalized.set(norm, id)

      const subs = (row.subsidiary_names as string[] | null) ?? []
      for (const s of subs) {
        if (!s || typeof s !== 'string') continue
        const sNorm = normalizeOwnerName(s)
        if (sNorm && !index.subsidiary.has(sNorm)) {
          index.subsidiary.set(sNorm, id)
        }
      }
    }

    if (data.length < pageSize) break
    offset += pageSize
  }

  return index
}

export function resolveEntity(
  rawOwnerName: string | null | undefined,
  index: EntityIndex
): EntityResolveResult {
  if (!rawOwnerName) {
    return { entity_id: null, confidence: 0, level: 0, status: 'unmatched' }
  }

  const key = rawOwnerName.trim()
  if (!key) {
    return { entity_id: null, confidence: 0, level: 0, status: 'unmatched' }
  }

  const cached = index.cache.get(key)
  if (cached) return cached

  // Level 1: exact case-insensitive
  const lower = key.toLowerCase()
  const l1 = index.exact.get(lower)
  if (l1) {
    const result: EntityResolveResult = {
      entity_id: l1,
      confidence: 100,
      level: 1,
      status: 'matched',
    }
    index.cache.set(key, result)
    return result
  }

  // Level 2: normalized
  const norm = normalizeOwnerName(key)
  if (norm) {
    const l2 = index.normalized.get(norm)
    if (l2) {
      const result: EntityResolveResult = {
        entity_id: l2,
        confidence: 90,
        level: 2,
        status: 'fuzzy_matched',
      }
      index.cache.set(key, result)
      return result
    }

    // Level 3: subsidiary
    const l3 = index.subsidiary.get(norm)
    if (l3) {
      const result: EntityResolveResult = {
        entity_id: l3,
        confidence: 75,
        level: 3,
        status: 'subsidiary_matched',
      }
      index.cache.set(key, result)
      return result
    }
  }

  // Level 4: no match
  const result: EntityResolveResult = {
    entity_id: null,
    confidence: 0,
    level: 0,
    status: 'unmatched',
  }
  index.cache.set(key, result)
  return result
}
