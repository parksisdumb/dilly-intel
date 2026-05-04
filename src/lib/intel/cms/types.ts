export enum CmsDataset {
  HOSPITALS = 'xubh-q36u',
  NURSING_HOMES = '4pq5-n9py',
  DIALYSIS = '23ew-n7w9',
}

export type CmsFacilityType = 'hospital' | 'nursing_home' | 'dialysis'

export interface CmsFacility {
  id: string                  // CMS certification number / facility_id
  name: string
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  phone: string | null
  ownership: string | null    // hospital_ownership / ownership_type
  chain_name: string | null   // chain_name / chain_organization (nursing/dialysis)
  facility_type: CmsFacilityType
  hospital_type?: string | null         // hospitals only
  number_of_certified_beds?: number | null  // nursing homes only
  legal_business_name?: string | null   // nursing homes only
}

export interface CmsEntityGroup {
  entity_name: string
  entity_type: string           // always 'healthcare_system'
  facility_type: CmsFacilityType
  facilities: CmsFacility[]
  total_count: number
  states: string[]              // unique states across facilities
}
