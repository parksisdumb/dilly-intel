import { inngest } from '../client'
import { createAdminClient } from '@/lib/supabase/admin'
import Anthropic from '@anthropic-ai/sdk'
import { getReitUniverse } from '@/lib/intel/edgar/reit-universe'
import { getFilingUrls } from '@/lib/intel/edgar/filing-fetcher'
import { extractEntityIntelligence } from '@/lib/intel/edgar/item2-extractor'
import { extractSubsidiaries } from '@/lib/intel/edgar/exhibit21-parser'

export const edgarBulkSeed = inngest.createFunction(
  {
    id: 'edgar-bulk-seed',
    retries: 0,
    concurrency: { limit: 1 },
    timeouts: { finish: '3h' },
    triggers: [{ event: 'app/edgar_bulk_seed.run' }],
  },
  async ({ step }) => {
    const supabase = createAdminClient()
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    // Step 1: Create run record and load universe
    const { runId, universe } = await step.run('setup', async () => {
      const { data: run } = await supabase
        .from('agent_runs')
        .insert({
          agent_name: 'edgar_intelligence',
          run_type: 'bulk_seed',
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single()

      const reits = await getReitUniverse(false)
      return { runId: run?.id, universe: reits }
    })

    // Step 2: Process all REITs
    const results = await step.run('process-all', async () => {
      const stats = { processed: 0, enriched: 0, stubbed: 0, failed: 0, skipped: 0 }
      const log: string[] = []
      log.push(`Starting bulk seed of ${universe.length} REITs`)

      for (const reit of universe) {
        try {
          // Null CIK — store as stub only
          if (!reit.cik) {
            await supabase.from('intel_entities').upsert({
              name: reit.name,
              ticker: reit.ticker ?? null,
              entity_type: 'reit',
              source_detail: 'reitsacrossamerica',
              needs_website_scrape: true,
              portfolio_type: 'unknown',
              updated_at: new Date().toISOString(),
            }, { onConflict: 'name' })
            stats.stubbed++
            log.push(`STUB: ${reit.name} — no CIK`)
            continue
          }

          // Get filing URLs
          const filing = await getFilingUrls(reit.cik, reit.name)

          if (!filing.documentUrl) {
            // Store basic entity record even without 10-K
            await supabase.from('intel_entities').upsert({
              name: reit.name,
              ticker: reit.ticker ?? null,
              cik: reit.cik,
              entity_type: 'reit',
              source_detail: 'edgar_10k',
              needs_website_scrape: true,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'cik' })
            stats.skipped++
            log.push(`NO 10-K: ${reit.name}`)
            continue
          }

          // Extract entity intelligence
          const extraction = await extractEntityIntelligence(
            filing.documentUrl,
            reit.name,
            anthropic
          )

          // Extract subsidiaries if exhibit 21 exists
          const subsidiaries = filing.exhibit21Url
            ? await extractSubsidiaries(filing.exhibit21Url, anthropic)
            : []

          // Build upsert payload
          const payload: Record<string, unknown> = {
            name: reit.name,
            ticker: reit.ticker ?? null,
            cik: reit.cik,
            entity_type: 'reit',
            source_detail: 'edgar_10k',
            last_10k_date: filing.filingDate,
            updated_at: new Date().toISOString(),
          }

          if (extraction) {
            payload.sector = extraction.sector
            payload.portfolio_type = extraction.portfolio_type
            payload.hq_address = extraction.hq_address
            payload.hq_city = extraction.hq_city
            payload.hq_state = extraction.hq_state
            payload.hq_zip = extraction.hq_zip
            payload.hq_phone = extraction.hq_phone
            payload.ir_website = extraction.ir_website
            payload.operating_markets = extraction.operating_markets
            payload.key_contacts = extraction.key_contacts
            payload.total_properties = extraction.total_properties
            payload.total_sq_footage = extraction.total_sq_footage && extraction.total_sq_footage > 10_000_000_000 ? null : extraction.total_sq_footage
            payload.portfolio_summary = extraction.portfolio_summary
            payload.needs_website_scrape = extraction.portfolio_type === 'type_b'
            payload.investment_vehicles = extraction.investment_vehicles ?? []
          }

          if (subsidiaries.length > 0) {
            payload.subsidiary_names = subsidiaries
          }

          await supabase.from('intel_entities').upsert(payload, { onConflict: 'cik' })

          stats.enriched++
          log.push(`OK: ${reit.name} (${reit.ticker}) — ${extraction?.sector ?? 'unknown'} ${extraction?.portfolio_type ?? ''}`)

          // 300ms delay between REITs to respect SEC rate limits
          await new Promise(r => setTimeout(r, 300))

        } catch (err) {
          stats.failed++
          const msg = err instanceof Error ? err.message : String(err)
          log.push(`ERROR: ${reit.name} — ${msg}`)
          // Never let one REIT crash the whole run
        }

        stats.processed++
      }

      log.push(`Bulk seed complete: ${stats.enriched} enriched, ${stats.stubbed} stubbed, ${stats.skipped} skipped, ${stats.failed} failed`)
      return { stats, log }
    })

    // Step 3: Finalize
    await step.run('finalize', async () => {
      await supabase.from('agent_runs').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        records_found: results.stats.processed,
        records_added: results.stats.enriched,
        records_skipped: results.stats.skipped + results.stats.stubbed,
        metadata: { log: results.log, stats: results.stats },
      }).eq('id', runId)

      await supabase.from('agent_registry').update({
        last_run_at: new Date().toISOString(),
        last_run_status: 'completed',
        config: {
          last_processed_cik: null,
          universe_refreshed_at: null,
          batch_size: 25,
        },
      }).eq('agent_name', 'edgar_intelligence')
    })

    return results.stats
  }
)
