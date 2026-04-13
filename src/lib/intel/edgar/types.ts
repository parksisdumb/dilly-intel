export type ReitEntity = {
  cik: string      // zero-padded to 10 chars e.g. "0001045609"
  ticker: string
  name: string
}

export type ExtractedMarket = {
  city: string | null
  state: string | null
  region: string | null
  property_count: number | null
  sq_footage: number | null
  sq_footage_consolidated: number | null
  sq_footage_omm: number | null
  gross_book_value_millions: number | null
  development_acres: number | null
  development_est_sqft: number | null
  property_type: string
}

export type InvestmentVehicle = {
  name: string
  vehicle_type: 'consolidated_venture' | 'unconsolidated_venture' | 'fund' | 'other'
  sq_footage: number | null
  geography: string | null
}

export type ExtractedContact = {
  name: string
  title: string
}

export type EntityExtraction = {
  portfolio_type: 'type_a' | 'type_b' | 'unknown'
  sector: string
  hq_address: string | null
  hq_city: string | null
  hq_state: string | null
  hq_zip: string | null
  hq_phone: string | null
  ir_website: string | null
  operating_markets: ExtractedMarket[]
  investment_vehicles: InvestmentVehicle[]
  key_contacts: ExtractedContact[]
  subsidiary_names: string[]
  total_properties: number | null
  total_sq_footage: number | null
  portfolio_summary: string | null
}
