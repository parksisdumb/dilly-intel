import { inngest } from '../client'
import { createAdminClient } from '@/lib/supabase/admin'
import { TENNESSEE_COUNTIES, filterCountiesForScope } from '@/lib/intel/proptracer/counties'
import {
  mappingQuery,
  splitBboxIntoGrid,
  decodeJwtPayload,
  ProptracerAuthError,
  PAGE_LIMIT,
} from '@/lib/intel/proptracer/proptracer-client'
import type { BoundingBox } from '@/lib/intel/proptracer/types'

const BUILDING_SIZE_MIN = 3_000
const GRID_N = 4 // 4x4 = 16 cells per dense county

export const proptracerCollectAgent = inngest.createFunction(
  {
    id: 'proptracer-collect',
    retries: 0,
    concurrency: { limit: 1 },
    timeouts: { finish: '30m' },
    triggers: [{ event: 'app/proptracer_collect.run' }],
  },
  async ({ event, step }) => {
    const supabase = createAdminClient()
    const eventData = (event.data ?? {}) as Record<string, unknown>
    const requestedScope: 'all' | 'test' = eventData.counties === 'test' ? 'test' : 'all'

    // Create run record
    const runId = await step.run('create-run', async () => {
      const { data } = await supabase
        .from('agent_runs')
        .insert({
          agent_name: 'proptracer_scraper',
          run_type: 'collect',
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single()
      return data?.id as string | undefined
    })

    // Step 1: Validate JWT
    const jwtInfo = await step.run('validate-jwt', async () => {
      const jwt = process.env.PROPTRACER_JWT
      if (!jwt) throw new Error('PROPTRACER_JWT not set in environment')

      const payload = decodeJwtPayload(jwt)
      const exp = payload && typeof payload.exp === 'number'
        ? new Date(payload.exp * 1000).toISOString() : null
      const sub = payload && typeof payload.sub === 'string' ? payload.sub : null

      // Tiny downtown Nashville test bbox
      const res = await mappingQuery(
        { minLat: 36.16, maxLat: 36.17, minLon: -86.78, maxLon: -86.77 },
        BUILDING_SIZE_MIN
      )
      // eslint-disable-next-line no-console
      console.log(`[collect] JWT valid — subject=${sub} expires=${exp} test_hits=${res.data.length}`)
      return { subject: sub, expiry: exp, test_hits: res.data.length }
    })

    // Step 2: Flat collect loop across all (or test subset) counties
    const collected = await step.run('collect-ids', async () => {
      const counties = filterCountiesForScope(TENNESSEE_COUNTIES, requestedScope)
      // eslint-disable-next-line no-console
      console.log(`[collect] starting — scope=${requestedScope}, counties=${counties.length}`)

      const allHits = new Map<string, { id: string; latitude: number; longitude: number; county: string }>()
      let totalApiCalls = 0
      let totalCredits = 0
      const perCounty: {
        name: string
        fips: string
        found: number
        api_calls: number
        credits: number
        subdivided: boolean
        duration_ms: number
      }[] = []

      for (let i = 0; i < counties.length; i++) {
        const county = counties[i]
        const t0 = Date.now()
        let calls = 0
        let credits = 0
        let subdivided = false
        const countyHits = new Map<string, { id: string; latitude: number; longitude: number }>()

        try {
          const countyBbox: BoundingBox = {
            minLat: county.minLat,
            maxLat: county.maxLat,
            minLon: county.minLon,
            maxLon: county.maxLon,
          }

          // 1. Fire one initial mapping call
          const initial = await mappingQuery(countyBbox, BUILDING_SIZE_MIN)
          calls++
          credits += initial.credits

          if (initial.resultCount < PAGE_LIMIT) {
            // Sparse — initial call has everything
            for (const h of initial.data) {
              if (!countyHits.has(h.id)) countyHits.set(h.id, h)
            }
          } else {
            // Dense — split into fixed 4x4 grid, fire 16 calls
            subdivided = true
            const cells = splitBboxIntoGrid(countyBbox, GRID_N)
            for (const cell of cells) {
              try {
                const res = await mappingQuery(cell, BUILDING_SIZE_MIN)
                calls++
                credits += res.credits
                for (const h of res.data) {
                  if (!countyHits.has(h.id)) countyHits.set(h.id, h)
                }
              } catch (err) {
                if (err instanceof ProptracerAuthError) throw err
                // eslint-disable-next-line no-console
                console.warn(`[collect] ${county.name} cell failed: ${err instanceof Error ? err.message : String(err)}`)
              }
            }
          }
        } catch (err) {
          if (err instanceof ProptracerAuthError) throw err
          // eslint-disable-next-line no-console
          console.error(`[collect] ${county.name} initial call failed: ${err instanceof Error ? err.message : String(err)}`)
        }

        // Merge into global with county tag
        for (const h of countyHits.values()) {
          if (!allHits.has(h.id)) {
            allHits.set(h.id, { ...h, county: county.name })
          }
        }

        totalApiCalls += calls
        totalCredits += credits

        const duration = Date.now() - t0
        perCounty.push({
          name: county.name,
          fips: county.fips,
          found: countyHits.size,
          api_calls: calls,
          credits,
          subdivided,
          duration_ms: duration,
        })

        // eslint-disable-next-line no-console
        console.log(
          `[collect] County ${i + 1}/${counties.length}: ${county.name} — ${countyHits.size} ids (${calls} calls${subdivided ? ', subdivided' : ''}, ${(duration / 1000).toFixed(1)}s) | total_so_far=${allHits.size}`
        )
      }

      // eslint-disable-next-line no-console
      console.log(
        `[collect] done — unique_ids=${allHits.size} total_calls=${totalApiCalls} total_credits=${totalCredits}`
      )

      return {
        hits: [...allHits.values()],
        totalApiCalls,
        totalCredits,
        perCounty,
        scope: requestedScope,
      }
    })

    // Step 3: Save pending_ids into agent_registry.config
    await step.run('save-pending-ids', async () => {
      const hits = collected.hits as { id: string; latitude: number; longitude: number; county: string }[]
      // Read existing config to preserve other fields
      const { data: regRow } = await supabase
        .from('agent_registry')
        .select('config')
        .eq('agent_name', 'proptracer_scraper')
        .single()
      const existingConfig = (regRow?.config ?? {}) as Record<string, unknown>

      const pendingIds = hits.map(h => ({ id: h.id, county: h.county, lat: h.latitude, lng: h.longitude }))

      await supabase
        .from('agent_registry')
        .update({
          config: {
            ...existingConfig,
            pending_ids: pendingIds,
            collected_at: new Date().toISOString(),
            total_ids: pendingIds.length,
            last_processed_index: 0,
            last_collect_scope: collected.scope,
          },
        })
        .eq('agent_name', 'proptracer_scraper')

      // eslint-disable-next-line no-console
      console.log(`[collect] saved ${pendingIds.length} pending_ids to agent_registry.config`)
    })

    // Step 4: Finalize run record and fire enrich event
    await step.run('finalize-collect', async () => {
      const metadata = {
        jwt: jwtInfo,
        collection: {
          scope: collected.scope,
          unique_ids: (collected.hits as { id: string }[]).length,
          total_api_calls: collected.totalApiCalls,
          total_credits: collected.totalCredits,
          per_county: collected.perCounty,
        },
      }

      if (runId) {
        await supabase
          .from('agent_runs')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            records_found: (collected.hits as { id: string }[]).length,
            records_added: 0,
            metadata,
          })
          .eq('id', runId)
      }

      await supabase
        .from('agent_registry')
        .update({
          last_run_at: new Date().toISOString(),
          last_run_status: 'collect_completed',
        })
        .eq('agent_name', 'proptracer_scraper')

      return metadata
    })

    // Chain to enrich phase
    await step.sendEvent('trigger-enrich', {
      name: 'app/proptracer_enrich.run',
      data: { triggered_by: 'proptracer_collect', scope: collected.scope },
    })

    return {
      unique_ids: (collected.hits as { id: string }[]).length,
      total_credits: collected.totalCredits,
      scope: collected.scope,
    }
  }
)
