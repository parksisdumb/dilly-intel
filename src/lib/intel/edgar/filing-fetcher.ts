import { secFetch } from './sec-client'

type FilingUrls = {
  documentUrl: string | null
  exhibit21Url: string | null
  filingDate: string | null
}

type SecSubmissions = {
  filings: {
    recent: {
      form: string[]
      accessionNumber: string[]
      primaryDocument: string[]
      filingDate: string[]
    }
  }
}

export async function getFilingUrls(cik: string, _name: string): Promise<FilingUrls> {
  const paddedCik = cik.padStart(10, '0')
  const res = await secFetch(`https://data.sec.gov/submissions/CIK${paddedCik}.json`)

  if (!res.ok) {
    return { documentUrl: null, exhibit21Url: null, filingDate: null }
  }

  const data: SecSubmissions = await res.json()
  const recent = data.filings.recent

  // Find most recent 10-K
  let documentUrl: string | null = null
  let filingDate: string | null = null
  let accessionNoDashes: string | null = null

  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] === '10-K') {
      const accession = recent.accessionNumber[i]
      accessionNoDashes = accession.replace(/-/g, '')
      const primaryDoc = recent.primaryDocument[i]
      filingDate = recent.filingDate[i]
      documentUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accessionNoDashes}/${primaryDoc}`
      break
    }
  }

  // Find Exhibit 21
  let exhibit21Url: string | null = null
  for (let i = 0; i < recent.form.length; i++) {
    const form = recent.form[i]
    if (form === 'EX-21' || form === 'EX-21.1') {
      const accession = recent.accessionNumber[i]
      const noDashes = accession.replace(/-/g, '')
      const primaryDoc = recent.primaryDocument[i]
      exhibit21Url = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${noDashes}/${primaryDoc}`
      break
    }
  }

  return { documentUrl, exhibit21Url, filingDate }
}
