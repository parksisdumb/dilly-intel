import { inngest } from '@/inngest/client'
import { createAdminClient } from '@/lib/supabase/admin'
import Anthropic from '@anthropic-ai/sdk'
import { getReitUniverse } from '@/lib/intel/edgar/reit-universe'
import { getFilingUrls } from '@/lib/intel/edgar/filing-fetcher'
import { extractEntityIntelligence } from '@/lib/intel/edgar/item2-extractor'
import { extractSubsidiaries } from '@/lib/intel/edgar/exhibit21-parser'
import type { ReitEntity } from '@/lib/intel/edgar/types'

const BATCH_SIZE = 25
const MAX_ENTITIES_PER_RUN = 50

export const edgarIntelligenceAgent = inngest.createFunction(
  {
    id: 'edgar-intelligence',
    retries: 1,
    concurrency: { limit: 1 },
    timeouts: { finish: '15m' },
    triggers: [
      { event: 'app/edgar_intelligence.run' },
      { cron: '0 2 1 * *' },
    ],
  },
  async ({ step }) => {
    // Step 1: Setup
    const { runId } = await step.run('setup', async () => {
      const db = createAdminClient()

      const { data: run, error } = await db
        .from('agent_runs')
        .insert({
          agent_name: 'edgar_intelligence',
          status: 'running',
          run_type: 'discovery',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single()

      if (error || !run) {
        throw new Error(`Failed to create agent run: ${error?.message}`)
      }

      return { runId: run.id as string }
    })

    // Step 2: Load universe
    const { universeCount } = await step.run('load-universe', async () => {
      const universe = await getReitUniverse()
      return { universeCount: universe.length }
    })

    // Step 3: Process batch
    let batchResult: { processed: number; log: string[]; tradedCount: number; nonTradedCount: number; stubCount: number }

    try {
      batchResult = await step.run('process-batch', async () => {
        const db = createAdminClient()
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
        const log: string[] = []

        log.push(`Universe size: ${universeCount}`)

        // Load config
        const { data: registryRow } = await db
          .from('agent_registry')
          .select('config')
          .eq('agent_name', 'edgar_intelligence')
          .single()

        const config = (registryRow?.config ?? {}) as Record<string, unknown>
        const lastIdx = (config.last_processed_idx as number | null) ?? null

        // Get universe
        const universe: ReitEntity[] = await getReitUniverse()

        if (universe.length === 0) {
          log.push('Empty universe — nothing to process')
          return { processed: 0, log, tradedCount: 0, nonTradedCount: 0, stubCount: 0 }
        }

        // Find start index
        const startIdx = lastIdx != null && lastIdx + 1 < universe.length
          ? lastIdx + 1
          : 0

        const batch = universe.slice(startIdx, startIdx + BATCH_SIZE)

        if (batch.length === 0) {
          log.push('Universe exhausted — resetting cursor')
          await db
            .from('agent_registry')
            .update({ config: { ...config, last_processed_idx: null } })
            .eq('agent_name', 'edgar_intelligence')
          return { processed: 0, log, tradedCount: 0, nonTradedCount: 0, stubCount: 0 }
        }

        log.push(`Processing batch: index ${startIdx}..${startIdx + batch.length - 1} of ${universe.length}`)

        let processed = 0
        let tradedCount = 0
        let nonTradedCount = 0
        let stubCount = 0
        const updateCursor = async (idx: number) => {
          await db
            .from('agent_registry')
            .update({ config: { ...config, last_processed_idx: startIdx + idx } })
            .eq('agent_name', 'edgar_intelligence')
        }

        for (let i = 0; i < batch.length; i++) {
          const reit = batch[i]
          if (processed >= MAX_ENTITIES_PER_RUN) {
            log.push(`Hit max entities per run (${MAX_ENTITIES_PER_RUN})`)
            break
          }

          const prefix = !reit.is_traded ? '[NON-TRADED] ' : ''
          log.push(`--- ${prefix}${reit.name} (CIK: ${reit.cik ?? 'none'}, ticker: ${reit.ticker ?? 'none'}) ---`)

          try {
            // Case 1: No CIK — stub entry, no 10-K available
            if (!reit.cik) {
              log.push(`  STUB: ${reit.name} — no CIK, stored as website scrape target`)
              await db
                .from('intel_entities')
                .upsert({
                  name: reit.name,
                  entity_type: 'reit',
                  source_detail: 'reitsacrossamerica',
                  portfolio_type: 'unknown',
                  needs_website_scrape: true,
                  enabled: true,
                  updated_at: new Date().toISOString(),
                }, { onConflict: 'name' })
              stubCount++
              await updateCursor(i)
              continue
            }

            // Case 2 & 3: Have CIK — fetch 10-K and extract
            const { documentUrl, exhibit21Url, filingDate } = await getFilingUrls(reit.cik, reit.name)

            if (!documentUrl) {
              log.push(`  No 10-K found, skipping`)
              await updateCursor(i)
              continue
            }

            log.push(`  10-K found: ${filingDate}`)

            // Extract entity intelligence
            const extraction = await extractEntityIntelligence(documentUrl, reit.name, anthropic)

            if (!extraction) {
              log.push(`  Extraction failed, skipping`)
              await updateCursor(i)
              continue
            }

            log.push(`  Extracted: sector=${extraction.sector}, type=${extraction.portfolio_type}, markets=${extraction.operating_markets.length}`)

            // Extract subsidiaries
            const subsidiaries = await extractSubsidiaries(exhibit21Url, anthropic)
            log.push(`  Subsidiaries: ${subsidiaries.length}`)

            // Merge subsidiary names with any existing
            const { data: existing } = await db
              .from('intel_entities')
              .select('subsidiary_names')
              .eq('cik', reit.cik)
              .single()

            const existingSubs: string[] = (existing?.subsidiary_names as string[]) ?? []
            const mergedSubs = [...new Set([...existingSubs, ...subsidiaries])].slice(0, 200)

            // Upsert
            const { error: upsertError } = await db
              .from('intel_entities')
              .upsert(
                {
                  name: reit.name,
                  ticker: reit.ticker,
                  cik: reit.cik,
                  entity_type: 'reit',
                  source_detail: 'edgar_10k',
                  last_10k_date: filingDate,
                  sector: extraction.sector,
                  portfolio_type: extraction.portfolio_type,
                  hq_address: extraction.hq_address,
                  hq_city: extraction.hq_city,
                  hq_state: extraction.hq_state,
                  hq_zip: extraction.hq_zip,
                  hq_phone: extraction.hq_phone,
                  ir_website: extraction.ir_website,
                  operating_markets: extraction.operating_markets,
                  investment_vehicles: extraction.investment_vehicles ?? [],
                  key_contacts: extraction.key_contacts,
                  subsidiary_names: mergedSubs,
                  total_properties: extraction.total_properties,
                  total_sq_footage: extraction.total_sq_footage,
                  portfolio_summary: extraction.portfolio_summary,
                  needs_website_scrape: extraction.portfolio_type === 'type_b',
                  updated_at: new Date().toISOString(),
                },
                { onConflict: 'cik' }
              )

            if (upsertError) {
              log.push(`  Upsert error: ${upsertError.message}`)
            } else {
              log.push(`  Upserted successfully`)
              processed++
              if (reit.is_traded) tradedCount++
              else nonTradedCount++
            }

            await updateCursor(i)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            log.push(`  Error: ${msg}`)
            await updateCursor(i)
          }
        }

        log.push(`Batch complete: ${processed} entities processed (traded: ${tradedCount}, non-traded: ${nonTradedCount}, stubs: ${stubCount})`)
        return { processed, log, tradedCount, nonTradedCount, stubCount }
      })
    } catch (err: unknown) {
      // Finalize with error
      const errorMsg = err instanceof Error ? err.message : String(err)
      await step.run('finalize-error', async () => {
        const db = createAdminClient()

        await db
          .from('agent_runs')
          .update({
            status: 'error',
            completed_at: new Date().toISOString(),
            error_message: errorMsg,
          })
          .eq('id', runId)

        await db
          .from('agent_registry')
          .update({
            last_run_at: new Date().toISOString(),
            last_run_status: 'error',
          })
          .eq('agent_name', 'edgar_intelligence')
      })

      throw err
    }

    // Step 4: Finalize success
    await step.run('finalize', async () => {
      const db = createAdminClient()
      const { processed, log, tradedCount, nonTradedCount, stubCount } = batchResult

      await db
        .from('agent_runs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          records_found: processed + stubCount,
          records_added: processed,
          metadata: { log, tradedCount, nonTradedCount, stubCount },
        })
        .eq('id', runId)

      // Use RPC-style increment via raw update
      const { data: registry } = await db
        .from('agent_registry')
        .select('total_runs, total_found, total_inserted')
        .eq('agent_name', 'edgar_intelligence')
        .single()

      await db
        .from('agent_registry')
        .update({
          last_run_at: new Date().toISOString(),
          last_run_status: 'completed',
          total_runs: (registry?.total_runs ?? 0) + 1,
          total_found: (registry?.total_found ?? 0) + processed,
          total_inserted: (registry?.total_inserted ?? 0) + processed,
        })
        .eq('agent_name', 'edgar_intelligence')

      return { processed, logLines: log.length }
    })

    return { success: true, processed: batchResult.processed }
  }
)
