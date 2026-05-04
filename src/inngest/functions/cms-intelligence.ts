import { inngest } from '../client'
import { createAdminClient } from '@/lib/supabase/admin'
import { CmsDataset } from '@/lib/intel/cms/types'
import type { CmsEntityGroup, CmsFacility } from '@/lib/intel/cms/types'
import { fetchAllFacilities } from '@/lib/intel/cms/cms-client'
import {
  groupHospitals,
  groupNursingHomes,
  groupDialysis,
} from '@/lib/intel/cms/entity-grouper'
import {
  entityGroupToPayload,
  facilityToPayload,
} from '@/lib/intel/cms/cms-to-entity'

type DatasetStats = {
  facilities_fetched: number
  entities_upserted: number
  properties_upserted: number
  entities_failed: number
  properties_failed: number
}

type SupabaseClient = ReturnType<typeof createAdminClient>

async function ingestGroups(
  supabase: SupabaseClient,
  groups: CmsEntityGroup[]
): Promise<DatasetStats> {
  const stats: DatasetStats = {
    facilities_fetched: 0,
    entities_upserted: 0,
    properties_upserted: 0,
    entities_failed: 0,
    properties_failed: 0,
  }

  for (const group of groups) {
    stats.facilities_fetched += group.facilities.length

    // Upsert entity
    const entityPayload = entityGroupToPayload(group)
    const { data: entity, error: entityErr } = await supabase
      .from('intel_entities')
      .upsert(entityPayload, { onConflict: 'name,source_detail' })
      .select('id')
      .single()

    if (entityErr || !entity) {
      stats.entities_failed++
      continue
    }
    stats.entities_upserted++

    // Upsert all facilities as properties linked to this entity
    const propertyPayloads = group.facilities.map((f: CmsFacility) =>
      facilityToPayload(f, entity.id)
    )

    // Batch upsert in chunks of 500 for performance
    const CHUNK_SIZE = 500
    for (let i = 0; i < propertyPayloads.length; i += CHUNK_SIZE) {
      const chunk = propertyPayloads.slice(i, i + CHUNK_SIZE)
      const { error: propErr } = await supabase
        .from('intel_properties')
        .upsert(chunk, { onConflict: 'external_id,source_detail' })

      if (propErr) {
        stats.properties_failed += chunk.length
      } else {
        stats.properties_upserted += chunk.length
      }
    }
  }

  return stats
}

export const cmsIntelligenceAgent = inngest.createFunction(
  {
    id: 'cms-intelligence',
    retries: 0,
    concurrency: { limit: 1 },
    timeouts: { finish: '30m' },
    triggers: [
      { event: 'app/cms_intelligence.run' },
      { cron: '0 0 1 * *' },
    ],
  },
  async ({ step }) => {
    const supabase = createAdminClient()

    // Create run record
    const runId = await step.run('create-run', async () => {
      const { data } = await supabase
        .from('agent_runs')
        .insert({
          agent_name: 'cms_intelligence',
          run_type: 'ingest',
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single()
      return data?.id as string | undefined
    })

    // Step 1: Hospitals
    const hospitalStats = await step.run('fetch-and-group-hospitals', async () => {
      const facilities = await fetchAllFacilities(CmsDataset.HOSPITALS)
      const groups = groupHospitals(facilities)
      const stats = await ingestGroups(supabase, groups)
      return {
        ...stats,
        total_facilities: facilities.length,
        total_groups: groups.length,
      }
    })

    // Step 2: Nursing Homes
    const nursingStats = await step.run('fetch-and-group-nursing-homes', async () => {
      const facilities = await fetchAllFacilities(CmsDataset.NURSING_HOMES)
      const groups = groupNursingHomes(facilities)
      const stats = await ingestGroups(supabase, groups)
      return {
        ...stats,
        total_facilities: facilities.length,
        total_groups: groups.length,
      }
    })

    // Step 3: Dialysis
    const dialysisStats = await step.run('fetch-and-group-dialysis', async () => {
      const facilities = await fetchAllFacilities(CmsDataset.DIALYSIS)
      const groups = groupDialysis(facilities)
      const stats = await ingestGroups(supabase, groups)
      return {
        ...stats,
        total_facilities: facilities.length,
        total_groups: groups.length,
      }
    })

    // Step 4: Finalize
    await step.run('update-agent-run', async () => {
      const totalFound =
        hospitalStats.total_facilities +
        nursingStats.total_facilities +
        dialysisStats.total_facilities
      const totalAdded =
        hospitalStats.properties_upserted +
        nursingStats.properties_upserted +
        dialysisStats.properties_upserted
      const totalEntities =
        hospitalStats.entities_upserted +
        nursingStats.entities_upserted +
        dialysisStats.entities_upserted

      const metadata = {
        hospitals: hospitalStats,
        nursing_homes: nursingStats,
        dialysis: dialysisStats,
        total_entities_upserted: totalEntities,
      }

      if (runId) {
        await supabase
          .from('agent_runs')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            records_found: totalFound,
            records_added: totalAdded,
            metadata,
          })
          .eq('id', runId)
      }

      await supabase
        .from('agent_registry')
        .update({
          last_run_at: new Date().toISOString(),
          last_run_status: 'completed',
          config: {
            datasets: ['hospitals', 'nursing_homes', 'dialysis'],
            last_run_counts: {
              hospitals: hospitalStats,
              nursing_homes: nursingStats,
              dialysis: dialysisStats,
            },
          },
        })
        .eq('agent_name', 'cms_intelligence')

      return metadata
    })

    return {
      hospitals: hospitalStats,
      nursing_homes: nursingStats,
      dialysis: dialysisStats,
    }
  }
)
