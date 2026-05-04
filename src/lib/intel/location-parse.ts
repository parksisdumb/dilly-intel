/**
 * Single-input search parser shared by the /intelligence page and the
 * /intelligence/market page. The user types one thing into the location
 * search box and we route it to the right column:
 *
 *   "37138"           - exact zip               (postal_code = '37138')
 *   "37138-1234"      - zip prefix              (postal_code LIKE '37138%')
 *   "37138 Memphis"   - zip + city combo        (postal_code = ... AND city ilike ...)
 *   "Shelby County"   - county filter           (county ilike '%Shelby%')
 *   "Memphis"         - city                    (city ilike '%Memphis%')
 *
 * Caller can override any field with explicit ?city= / ?zip= / ?county=
 * query params for programmatic use (e.g. dashboards linking to a market
 * page with a known county).
 */

const ZIP_FULL_RE = /^\d{5}$/
const ZIP_PLUS4_RE = /^(\d{5})-?(\d{1,4})$/
const ZIP_AND_TEXT_RE = /^(\d{5})\s+(.+)$/

export type LocationFilter = {
  city: string | null
  zip: string | null
  zipPrefix: string | null
  county: string | null
}

const EMPTY: LocationFilter = { city: null, zip: null, zipPrefix: null, county: null }

export function parseLocationInput(input: string | null | undefined): LocationFilter {
  if (!input) return { ...EMPTY }
  const trimmed = input.trim()
  if (!trimmed) return { ...EMPTY }

  // 5 digits + space + text -> zip + city
  const zipText = trimmed.match(ZIP_AND_TEXT_RE)
  if (zipText) {
    return { ...EMPTY, zip: zipText[1], city: zipText[2].trim() }
  }
  // Exact 5 digits -> zip exact
  if (ZIP_FULL_RE.test(trimmed)) {
    return { ...EMPTY, zip: trimmed }
  }
  // 5+4 zip -> prefix match (we don't store the +4 suffix)
  const plus4 = trimmed.match(ZIP_PLUS4_RE)
  if (plus4) {
    return { ...EMPTY, zipPrefix: plus4[1] }
  }
  // "Shelby County" -> county filter, strip the trailing word
  if (/\bcounty\b/i.test(trimmed)) {
    const stripped = trimmed.replace(/\bcounty\b/i, "").trim()
    return { ...EMPTY, county: stripped || trimmed }
  }
  // Default -> city
  return { ...EMPTY, city: trimmed }
}
