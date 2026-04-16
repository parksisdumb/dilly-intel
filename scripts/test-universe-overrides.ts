import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { getReitUniverse } from '../src/lib/intel/edgar/reit-universe'

async function main() {
  const reits = await getReitUniverse(true)
  console.log('Total:', reits.length)

  const mustHave = [
    'Plymouth', 'Medical Properties', 'Alexander & Baldwin',
    'Prologis', 'Public Storage', 'Simon Property',
  ]
  console.log('--- Must-have check ---')
  mustHave.forEach(n => {
    const f = reits.find(r => r.name.toLowerCase().includes(n.toLowerCase()))
    console.log(n + ':', f ? 'FOUND (' + f.ticker + ' / CIK ' + f.cik + ')' : 'MISSING')
  })

  console.log('Total universe size:', reits.length)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
