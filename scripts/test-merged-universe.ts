import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { getReitUniverse } from '../src/lib/intel/edgar/reit-universe'

async function main() {
  console.log('Fetching merged universe (NAREIT + REITs Across America)...')
  console.log('This may take 30-60s for SEC lookups on new names...')
  console.log()
  const reits = await getReitUniverse(true)

  const traded = reits.filter(r => r.is_traded)
  const nonTraded = reits.filter(r => !r.is_traded)

  console.log('Total universe:', reits.length)
  console.log('Publicly traded (have ticker):', traded.length)
  console.log('Non-traded/private (no ticker):', nonTraded.length)
  console.log()

  console.log('Non-traded names:')
  nonTraded.forEach(r => console.log(' -', r.name, r.cik ? `(CIK: ${r.cik})` : '(no CIK)'))
  console.log()

  const checks = [
    'Blackstone Real Estate Income Trust',
    'JLL Income Property Trust',
    'Hines Global Income Trust',
    'Plymouth Industrial',
    'Prologis',
    'Watson Land',
  ]
  console.log('Spot checks:')
  checks.forEach(n => {
    const f = reits.find(r => r.name.toLowerCase().includes(n.toLowerCase()))
    console.log(n + ':', f ? 'FOUND' + (f.ticker ? ' (' + f.ticker + ')' : ' [non-traded]') + (f.cik ? ' CIK:' + f.cik : '') : 'MISSING')
  })
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
