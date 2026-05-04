export type Entity = {
  id: string
  name: string
  entity_type: string | null
  ticker: string | null
  total_properties: number | null
}

export type Property = {
  id: string
  street_address: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  county: string | null
  latitude: number | null
  longitude: number | null
  property_type: string | null
  property_name: string | null
  building_sqft: number | null
  lot_size_sqft: number | null
  year_built: number | null
  estimated_value: number | null
  owner_name: string | null
  raw_owner_name: string | null
  owner_mailing_address: string | null
  owner_mailing_city: string | null
  owner_mailing_state: string | null
  owner_mailing_zip: string | null
  corporate_owned: boolean | null
  absentee_owner: boolean | null
  apn: string | null
  proptracer_id: string | null
  enrichment_status: string | null
  entity: Entity | null
  satellite_url: string | null
  updated_at: string | null
}

export type Stats = {
  total: number
  corporate_count: number
  corporate_pct: number
  matched_count: number
  avg_sqft: number
}

export type ApiResponse = {
  properties: Property[]
  page: number
  per_page: number
  total: number
  pages: number
  stats: Stats
  last_updated: string | null
  error?: string
}
