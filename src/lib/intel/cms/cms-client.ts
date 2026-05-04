import type { CmsFacility, CmsFacilityType } from './types'
import { CmsDataset } from './types'

const CMS_BASE = 'https://data.cms.gov/provider-data/api/1/datastore/query'
const USER_AGENT = 'DillyIntel/1.0 team@dillyos.com'
const PAGE_SIZE = 1000

type CmsQueryResponse = {
  results?: Record<string, unknown>[]
  count?: number
}

export async function cmsFetch(
  datasetId: string,
  offset: number,
  limit: number
): Promise<Record<string, unknown>[]> {
  const url = `${CMS_BASE}/${datasetId}/0?limit=${limit}&offset=${offset}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) {
    throw new Error(`CMS fetch failed for ${datasetId}: ${res.status} ${res.statusText}`)
  }
  const data: CmsQueryResponse = await res.json()
  return data.results ?? []
}

function facilityTypeFor(datasetId: string): CmsFacilityType {
  if (datasetId === CmsDataset.HOSPITALS) return 'hospital'
  if (datasetId === CmsDataset.NURSING_HOMES) return 'nursing_home'
  return 'dialysis'
}

function pickStr(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = row[key]
    if (v != null && String(v).trim() !== '') return String(v).trim()
  }
  return null
}

function pickInt(row: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = row[key]
    if (v == null || String(v).trim() === '') continue
    const n = parseInt(String(v), 10)
    if (!isNaN(n)) return n
  }
  return null
}

function normalizeRow(row: Record<string, unknown>, type: CmsFacilityType): CmsFacility | null {
  let id: string | null = null
  let name: string | null = null
  let address: string | null = null
  let ownership: string | null = null
  let chainName: string | null = null
  let hospitalType: string | null = null
  let beds: number | null = null
  let legalName: string | null = null

  if (type === 'hospital') {
    id = pickStr(row, 'facility_id', 'provider_id', 'ccn')
    name = pickStr(row, 'facility_name', 'hospital_name')
    address = pickStr(row, 'address', 'street_address')
    ownership = pickStr(row, 'hospital_ownership', 'ownership_type')
    hospitalType = pickStr(row, 'hospital_type')
  } else if (type === 'nursing_home') {
    id = pickStr(row, 'cms_certification_number_ccn', 'federal_provider_number', 'ccn')
    name = pickStr(row, 'provider_name', 'facility_name')
    address = pickStr(row, 'provider_address', 'address')
    ownership = pickStr(row, 'ownership_type')
    chainName = pickStr(row, 'chain_name')
    beds = pickInt(row, 'number_of_certified_beds')
    legalName = pickStr(row, 'legal_business_name')
  } else {
    id = pickStr(row, 'cms_certification_number_ccn', 'provider_number', 'ccn')
    name = pickStr(row, 'facility_name', 'provider_name')
    address = pickStr(row, 'address_line_1', 'provider_address', 'address')
    chainName = pickStr(row, 'chain_organization', 'chain_name')
  }

  if (!id || !name) return null

  return {
    id,
    name,
    address,
    city: pickStr(row, 'citytown', 'city', 'provider_city'),
    state: pickStr(row, 'state', 'provider_state'),
    zip: pickStr(row, 'zip_code', 'zip', 'provider_zip_code'),
    phone: pickStr(row, 'telephone_number', 'phone_number'),
    ownership,
    chain_name: chainName,
    facility_type: type,
    hospital_type: hospitalType,
    number_of_certified_beds: beds,
    legal_business_name: legalName,
  }
}

export async function fetchAllFacilities(datasetId: string): Promise<CmsFacility[]> {
  const type = facilityTypeFor(datasetId)
  const all: CmsFacility[] = []
  let offset = 0

  while (true) {
    const rows = await cmsFetch(datasetId, offset, PAGE_SIZE)
    if (rows.length === 0) break

    for (const row of rows) {
      const f = normalizeRow(row, type)
      if (f) all.push(f)
    }

    if (rows.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return all
}
