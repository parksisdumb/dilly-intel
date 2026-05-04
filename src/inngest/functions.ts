import { edgarIntelligenceAgent } from './functions/edgar-intelligence'
import { edgarBulkSeed } from './functions/edgar-bulk-seed'
import { cmsIntelligenceAgent } from './functions/cms-intelligence'
import { proptracerCollectAgent } from './functions/proptracer-collect'
import { proptracerEnrichAgent } from './functions/proptracer-enrich'

export const functions = [
  edgarIntelligenceAgent,
  edgarBulkSeed,
  cmsIntelligenceAgent,
  proptracerCollectAgent,
  proptracerEnrichAgent,
]
