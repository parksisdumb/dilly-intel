import { edgarIntelligenceAgent } from './functions/edgar-intelligence'
import { edgarBulkSeed } from './functions/edgar-bulk-seed'

export const functions = [edgarIntelligenceAgent, edgarBulkSeed]
