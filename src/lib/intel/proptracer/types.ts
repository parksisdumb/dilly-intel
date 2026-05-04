export interface BoundingBox {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

export interface TennesseeCounty {
  name: string
  fips: string
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

export interface PropTracerMappingHit {
  id: string
  latitude: number
  longitude: number
}

export interface PropTracerMappingResponse {
  data: PropTracerMappingHit[]
  /** True total count in bbox (capped returned data at 350, but resultCount is unlimited). */
  resultCount: number
  /** Returned row count (<= 350). */
  recordCount: number
  /** Credits consumed by this call (one per returned row). */
  credits: number
}

export interface PropTracerProperty {
  id: string
  latitude: number
  longitude: number
  address?: string | null          // street line only
  city?: string | null
  state?: string | null
  zip?: string | null
  county?: string | null
  raw_owner_name?: string | null
  owner_mailing_address?: string | null
  owner_mailing_city?: string | null
  owner_mailing_state?: string | null
  owner_mailing_zip?: string | null
  apn?: string | null
  estimated_value?: number | null
  year_built?: number | null
  lot_size_sqft?: number | null
  building_sqft?: number | null
  property_type?: string | null
  property_use_code?: number | null
  corporate_owned?: boolean | null
  absentee_owner?: boolean | null
}

export type EnrichmentStatus =
  | 'matched'
  | 'fuzzy_matched'
  | 'subsidiary_matched'
  | 'unmatched'

export interface EntityResolveResult {
  entity_id: string | null
  confidence: number
  level: 0 | 1 | 2 | 3
  status: EnrichmentStatus
}
