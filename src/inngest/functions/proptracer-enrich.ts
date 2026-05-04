import { inngest } from '../client'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  fetchPropertyDetail,
  ProptracerAuthError,
} from '@/lib/intel/proptracer/proptracer-client'
import {
  buildEntityIndex,
  resolveEntity,
  type EntityIndex,
} from '@/lib/intel/proptracer/entity-resolver'
import type { PropTracerProperty } from '@/lib/intel/proptracer/types'

const SOURCE = 'proptracer_mapping'
const BATCH_SIZE = 50
const BATCHES_PER_RUN = 60  // 60 × 50 = 3000 properties per Inngest run
const PER_RUN_CAP = BATCHES_PER_RUN * BATCH_SIZE

// Terminal statuses
const STATUS_MATCHED = 'matched'
const STATUS_UNMATCHED = 'unmatched'
const STATUS_INCOMPLETE = 'incomplete_data'
const STATUS_FETCH_FAILED = 'detail_fetch_failed'
const STATUS_NOT_FOUND = 'detail_not_found'

type PendingId = {
  id: string
  county: string
  lat: number
  lng: number
}

function missingRequired(detail: PropTracerProperty): string[] {
  const missing: string[] = []
  if (!detail.address || detail.address.trim().length === 0) missing.push('address')
  if (!detail.city || detail.city.trim().length === 0) missing.push('city')
  if (!detail.state || detail.state.trim().length === 0) missing.push('state')
  if (!detail.zip || detail.zip.trim().length === 0) missing.push('zip')
  if (!detail.raw_owner_name || detail.raw_owner_name.trim().length === 0) missing.push('raw_owner_name')
  return missing
}

/** Module-scoped entity index cache — persists across invocations in local dev. */
let moduleCachedIndex: EntityIndex | null = null
async function getEntityIndex(supabase: ReturnType<typeof createAdminClient>): Promise<EntityIndex> {
  if (moduleCachedIndex) return moduleCachedIndex
  moduleCachedIndex = await buildEntityIndex(supabase)
  return moduleCachedIndex
}

/**
 * Single-phase PropTracer enrichment.
 *
 * Reads pending_ids from agent_registry.config plus last_processed_index.
 * Processes up to 3,000 properties per run (60 batches × 50), then saves
 * the new index and self-chains another event if work remains.
 *
 * Each property: one /v1/property/details/{id} call, one upsert with the
 * full record. No lightweight intermediate rows, no pending_detail status.
 *
 * Safe to re-run — the cursor means re-triggering picks up where we stopped.
 */
export const proptracerEnrichAgent = inngest.createFunction(
  {
    id: 'proptracer-enrich',
    retries: 0,
    concurrency: { limit: 1 },
    timeouts: { finish: '2h' },
    triggers: [{ event: 'app/proptracer_enrich.run' }],
  },
  async ({ step }) => {
    const supabase = createAdminClient()

    // Step 1: Create run record
    const runId = await step.run('create-run', async () => {
      const { data } = await supabase
        .from('agent_runs')
        .insert({
          agent_name: 'proptracer_scraper',
          run_type: 'enrich',
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single()
      return data?.id as string | undefined
    })

    // Step 2: Load state (pending_ids + cursor)
    const state = await step.run('load-state', async () => {
      const { data: reg } = await supabase
        .from('agent_registry')
        .select('config')
        .eq('agent_name', 'proptracer_scraper')
        .single()
      const config = (reg?.config ?? {}) as Record<string, unknown>
      const pending = Array.isArray(config.pending_ids) ? (config.pending_ids as PendingId[]) : []
      const startIndex = typeof config.last_processed_index === 'number'
        ? (config.last_processed_index as number) : 0
      // eslint-disable-next-line no-console
      console.log(`[enrich] pending=${pending.length} startIndex=${startIndex}`)
      return { pending, startIndex }
    })

    const pending = state.pending as PendingId[]
    const startIndex = state.startIndex as number
    const total = pending.length

    if (total === 0 || startIndex >= total) {
      // Nothing to do — clean up
      await step.run('finalize-drained', async () => {
        const { data: reg } = await supabase
          .from('agent_registry')
          .select('config')
          .eq('agent_name', 'proptracer_scraper')
          .single()
        const cfg = (reg?.config ?? {}) as Record<string, unknown>
        const cleared = { ...cfg }
        delete cleared.pending_ids
        delete cleared.last_processed_index
        cleared.last_enrich_completed_at = new Date().toISOString()

        await supabase
          .from('agent_registry')
          .update({
            config: cleared,
            last_run_at: new Date().toISOString(),
            last_run_status: 'completed',
          })
          .eq('agent_name', 'proptracer_scraper')

        if (runId) {
          await supabase
            .from('agent_runs')
            .update({
              status: 'completed',
              completed_at: new Date().toISOString(),
              records_found: total,
              records_added: 0,
            })
            .eq('id', runId)
        }

        // eslint-disable-next-line no-console
        console.log('[enrich] drained — nothing pending, cleared config')
      })
      return { skipped: true, total_pending: total, start_index: startIndex }
    }

    // Slice this run: up to PER_RUN_CAP items starting from cursor
    const endIndex = Math.min(startIndex + PER_RUN_CAP, total)
    const runCount = endIndex - startIndex
    const batchCount = Math.ceil(runCount / BATCH_SIZE)
    // eslint-disable-next-line no-console
    console.log(
      `[enrich] processing indices ${startIndex}..${endIndex - 1} of ${total} ` +
      `(${runCount} items in ${batchCount} batches of ${BATCH_SIZE})`
    )

    // Running totals aggregated across per-batch step returns
    let totalProcessed = 0
    let totalUpserted = 0
    let totalMatched = 0
    let totalFuzzy = 0
    let totalSubsidiary = 0
    let totalUnmatched = 0
    let totalIncomplete = 0
    let totalFetchFailed = 0
    let totalNotFound = 0

    // Per-batch step.run — cached per-run by Inngest, so an HTTP retry
    // during this run skips completed batches.
    for (let b = 0; b < batchCount; b++) {
      const batchStart = startIndex + b * BATCH_SIZE
      const batchEnd = Math.min(batchStart + BATCH_SIZE, endIndex)
      const batch = pending.slice(batchStart, batchEnd)

      const stats = await step.run(`enrich-batch-${b}`, async () => {
        const entityIndex = await getEntityIndex(supabase)
        const s = {
          batch: b,
          globalStart: batchStart,
          globalEnd: batchEnd,
          processed: 0,
          upserted: 0,
          matched: 0,
          fuzzy: 0,
          subsidiary: 0,
          unmatched: 0,
          incomplete: 0,
          fetch_failed: 0,
          not_found: 0,
        }
        const payloads: Record<string, unknown>[] = []
        const now = new Date().toISOString()

        for (const item of batch) {
          s.processed++

          // Fetch detail
          let detail: PropTracerProperty | null = null
          try {
            detail = await fetchPropertyDetail(item.id)
          } catch (err) {
            if (err instanceof ProptracerAuthError) throw err
            s.fetch_failed++
            // Write a stub so we can see which IDs failed
            payloads.push({
              external_id: item.id,
              source_detail: SOURCE,
              state: 'TN',
              county: item.county,
              lat: item.lat,
              lng: item.lng,
              latitude: item.lat,
              longitude: item.lng,
              proptracer_id: item.id,
              enrichment_status: STATUS_FETCH_FAILED,
              enrichment_level: 0,
              needs_assessor_data: true,
              needs_google_places: true,
              updated_at: now,
            })
            continue
          }

          if (!detail) {
            s.not_found++
            payloads.push({
              external_id: item.id,
              source_detail: SOURCE,
              state: 'TN',
              county: item.county,
              lat: item.lat,
              lng: item.lng,
              latitude: item.lat,
              longitude: item.lng,
              proptracer_id: item.id,
              enrichment_status: STATUS_NOT_FOUND,
              enrichment_level: 0,
              needs_assessor_data: true,
              needs_google_places: true,
              updated_at: now,
            })
            continue
          }

          // Required-fields check
          const missing = missingRequired(detail)
          if (missing.length > 0) {
            s.incomplete++
            payloads.push({
              external_id: item.id,
              source_detail: SOURCE,
              state: detail.state ?? 'TN',
              city: detail.city ?? null,
              postal_code: detail.zip ?? null,
              street_address: detail.address ?? null,
              county: detail.county ?? item.county,
              lat: detail.latitude || item.lat,
              lng: detail.longitude || item.lng,
              latitude: detail.latitude || item.lat,
              longitude: detail.longitude || item.lng,
              raw_owner_name: detail.raw_owner_name ?? null,
              owner_name: detail.raw_owner_name ?? null,
              property_type: detail.property_type ?? null,
              proptracer_id: item.id,
              enrichment_status: STATUS_INCOMPLETE,
              enrichment_level: 0,
              needs_assessor_data: true,
              needs_google_places: true,
              updated_at: now,
            })
            continue
          }

          // Entity resolution
          const resolved = resolveEntity(detail.raw_owner_name, entityIndex)
          let finalStatus: string
          if (resolved.level === 0) { s.unmatched++; finalStatus = STATUS_UNMATCHED }
          else {
            finalStatus = STATUS_MATCHED
            if (resolved.level === 1) s.matched++
            else if (resolved.level === 2) s.fuzzy++
            else if (resolved.level === 3) s.subsidiary++
          }

          // Build complete record payload
          payloads.push({
            external_id: item.id,
            source_detail: SOURCE,
            street_address: detail.address,
            city: detail.city,
            state: detail.state,
            postal_code: detail.zip,
            county: detail.county ?? item.county,
            lat: detail.latitude || item.lat,
            lng: detail.longitude || item.lng,
            latitude: detail.latitude || item.lat,
            longitude: detail.longitude || item.lng,
            raw_owner_name: detail.raw_owner_name,
            owner_name: detail.raw_owner_name,
            owner_mailing_address: detail.owner_mailing_address ?? null,
            owner_mailing_city: detail.owner_mailing_city ?? null,
            owner_mailing_state: detail.owner_mailing_state ?? null,
            owner_mailing_zip: detail.owner_mailing_zip ?? null,
            corporate_owned: detail.corporate_owned ?? null,
            absentee_owner: detail.absentee_owner ?? null,
            apn: detail.apn ?? null,
            parcel_id: detail.apn ?? null,
            estimated_value: detail.estimated_value ?? null,
            assessed_value: detail.estimated_value != null ? Math.round(detail.estimated_value) : null,
            building_sqft: detail.building_sqft ?? null,
            sq_footage: detail.building_sqft != null ? Math.round(detail.building_sqft) : null,
            lot_size_sqft: detail.lot_size_sqft ?? null,
            year_built: detail.year_built ?? null,
            property_type: detail.property_type ?? null,
            property_name: detail.address,
            proptracer_id: item.id,
            entity_id: resolved.entity_id,
            enrichment_status: finalStatus,
            enrichment_level: resolved.level,
            needs_assessor_data: true,
            needs_google_places: true,
            updated_at: now,
          })
        }

        // Upsert the full batch in one query
        if (payloads.length > 0) {
          const { error } = await supabase
            .from('intel_properties')
            .upsert(payloads, { onConflict: 'external_id,source_detail' })
          if (error) {
            // eslint-disable-next-line no-console
            console.error(`[enrich] upsert error batch ${b}: ${error.message}`)
          } else {
            s.upserted = payloads.length
          }
        }

        // eslint-disable-next-line no-console
        console.log(
          `[enrich] batch ${b + 1}/${batchCount} (global ${batchStart}-${batchEnd - 1}): ` +
          `upserted=${s.upserted} matched=${s.matched} fuzzy=${s.fuzzy} sub=${s.subsidiary} ` +
          `unmatched=${s.unmatched} incomplete=${s.incomplete} fetch_failed=${s.fetch_failed} not_found=${s.not_found}`
        )
        return s
      })

      totalProcessed += stats.processed
      totalUpserted += stats.upserted
      totalMatched += stats.matched
      totalFuzzy += stats.fuzzy
      totalSubsidiary += stats.subsidiary
      totalUnmatched += stats.unmatched
      totalIncomplete += stats.incomplete
      totalFetchFailed += stats.fetch_failed
      totalNotFound += stats.not_found
    }

    const hasMore = endIndex < total

    // Step N: Save cursor + finalize run. If done, clear pending_ids.
    await step.run('finalize', async () => {
      const { data: reg } = await supabase
        .from('agent_registry')
        .select('config')
        .eq('agent_name', 'proptracer_scraper')
        .single()
      const cfg = (reg?.config ?? {}) as Record<string, unknown>

      const runCounts = {
        processed: totalProcessed,
        upserted: totalUpserted,
        matched: totalMatched,
        fuzzy: totalFuzzy,
        subsidiary: totalSubsidiary,
        unmatched: totalUnmatched,
        incomplete: totalIncomplete,
        fetch_failed: totalFetchFailed,
        not_found: totalNotFound,
      }

      if (hasMore) {
        // More work remains — advance cursor
        await supabase
          .from('agent_registry')
          .update({
            config: { ...cfg, last_processed_index: endIndex, last_enrich_counts: runCounts },
            last_run_at: new Date().toISOString(),
            last_run_status: 'enrich_partial',
          })
          .eq('agent_name', 'proptracer_scraper')
      } else {
        // Drained — clear pending_ids and cursor
        const cleared: Record<string, unknown> = { ...cfg }
        delete cleared.pending_ids
        delete cleared.last_processed_index
        cleared.last_enrich_counts = runCounts
        cleared.last_enrich_completed_at = new Date().toISOString()

        await supabase
          .from('agent_registry')
          .update({
            config: cleared,
            last_run_at: new Date().toISOString(),
            last_run_status: 'completed',
          })
          .eq('agent_name', 'proptracer_scraper')
      }

      if (runId) {
        await supabase
          .from('agent_runs')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            records_found: runCount,
            records_added: totalUpserted,
            metadata: {
              run_slice: { start: startIndex, end: endIndex, total },
              counts: runCounts,
              has_more: hasMore,
            },
          })
          .eq('id', runId)
      }

      // eslint-disable-next-line no-console
      console.log(
        `[enrich] run complete — upserted=${totalUpserted}/${runCount} ` +
        `matched=${totalMatched + totalFuzzy + totalSubsidiary} unmatched=${totalUnmatched} ` +
        `incomplete=${totalIncomplete} failed=${totalFetchFailed + totalNotFound}` +
        (hasMore ? ` — chaining (next startIndex=${endIndex})` : ' — all pending drained')
      )
    })

    // Self-chain if more work remains
    if (hasMore) {
      await step.sendEvent('chain-next-run', {
        name: 'app/proptracer_enrich.run',
        data: { triggered_by: 'self_chain', next_start_index: endIndex },
      })
    }

    return {
      run_slice: { start: startIndex, end: endIndex, total },
      upserted: totalUpserted,
      matched: totalMatched + totalFuzzy + totalSubsidiary,
      unmatched: totalUnmatched,
      incomplete: totalIncomplete,
      failed: totalFetchFailed + totalNotFound,
      chained: hasMore,
    }
  }
)
