const UA = 'DillyIntel/1.0 team@dillyos.com'

async function main() {
  // Test 1: company tickers
  console.log('--- Fetching company_tickers_exchange.json ---')
  const res1 = await fetch('https://www.sec.gov/files/company_tickers_exchange.json', {
    headers: { 'User-Agent': UA },
  })
  console.log('Status:', res1.status)
  const data1: { fields: string[]; data: (string | number)[][] } = await res1.json()
  console.log('Fields:', data1.fields)
  console.log('First 3 entries:')
  for (let i = 0; i < 3; i++) {
    console.log(' ', data1.data[i])
  }

  // Test 2: Prologis submission
  console.log('\n--- Fetching CIK0001045609.json (Prologis) ---')
  await new Promise(r => setTimeout(r, 300))
  const res2 = await fetch('https://data.sec.gov/submissions/CIK0001045609.json', {
    headers: { 'User-Agent': UA },
  })
  console.log('Status:', res2.status)
  const data2 = await res2.json() as {
    name: string
    sic: string
    filings: { recent: { form: string[]; filingDate: string[] } }
  }
  console.log('Company:', data2.name)
  console.log('SIC:', data2.sic)

  const forms = data2.filings.recent.form
  const dates = data2.filings.recent.filingDate
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] === '10-K') {
      console.log('First 10-K filing date:', dates[i])
      break
    }
  }
}

main()
