/**
 * Property-type rollup. PropTracer ships extremely granular categories
 * ("Auto Repair, Garage", "Bar, Tavern", "Car Wash - Self-Serve") that
 * are great for analytics but unhelpful for a contractor who just wants
 * to know "are these office buildings or warehouses".
 *
 * This module is the single source of truth for both:
 *   - Server-side rollup of the market dashboard's by-type chart.
 *   - Client-side filter checkboxes on the property browser, which
 *     translate to ILIKE patterns when the API route fans the filter
 *     out into a SQL OR clause.
 *
 * Pattern lists are evaluated in order — first match wins. Order matters
 * because some PropTracer strings contain multiple bucket-relevant
 * keywords (e.g. "Mini-Warehouse, Storage" must hit Self Storage before
 * Industrial's "warehouse"; "Light Industrial (10% Improved Office
 * Space)" must hit Industrial before Office's "office").
 */

export const ROLLUP_CATEGORIES = [
  "Office",
  "Retail",
  "Industrial",
  "Multifamily",
  "Hospitality",
  "Healthcare",
  "Restaurant/Food",
  "Automotive",
  "Self Storage",
  "Parking",
  "Religious/Nonprofit",
  "Other",
] as const

export type RollupCategory = (typeof ROLLUP_CATEGORIES)[number]

/**
 * Substring patterns (lowercase) per rollup category.
 *
 * Used in two places:
 *   1. rollupCategory(rawType) — server-side classification of the raw
 *      property_type string returned by intel_market_summary's
 *      by_type group.
 *   2. The properties API route's filter logic — when the user checks
 *      "Office", we OR all the Office patterns into ILIKE clauses.
 *
 * If you change a category's patterns here, both behaviors update
 * automatically. Keep more-specific patterns earlier in each array if
 * the category is also a substring of itself (rare).
 */
export const ROLLUP_PATTERNS: Array<{
  category: RollupCategory
  patterns: string[]
}> = [
  // Self Storage — must precede Industrial. "Mini-Warehouse, Storage"
  // contains "warehouse" but should be Self Storage, not Industrial.
  {
    category: "Self Storage",
    patterns: ["mini-warehouse", "self storage", "self-storage"],
  },

  // Religious/Nonprofit. Fraternities/sororities and community centers
  // grouped here per spec, even though they're residential-adjacent.
  {
    category: "Religious/Nonprofit",
    patterns: [
      "religious",
      "church",
      "synagogue",
      "temple",
      "worship",
      "parsonage",
      "fraternity",
      "sorority",
      "community center",
      "clubs, lodge",
      "professional association",
    ],
  },

  // Hospitality. "Hotel" / "Motel" / "Lodging" only — distinct from
  // "Hospital" which goes to Healthcare. Substring "hotel" does NOT
  // match "hospital" so order doesn't matter between these two.
  {
    category: "Hospitality",
    patterns: ["hotel", "motel", "lodging"],
  },

  // Healthcare. "Hospital - Private", "Medical Clinic", veterinary.
  // Note: "Homes (Retired/Nursing)" is intentionally NOT here — per
  // user spec those go to Multifamily (income-property style).
  {
    category: "Healthcare",
    patterns: [
      "hospital",
      "medical clinic",
      "medical center",
      "veterinary",
      "animal hospital",
      "dialysis",
      "rehabilitation",
    ],
  },

  // Restaurant / Food. Must precede Retail since "Fast Food Restaurant /
  // Drive-Thru" doesn't contain a Retail keyword anyway, but we want
  // Restaurant matches before any future Retail "food" pattern.
  {
    category: "Restaurant/Food",
    patterns: [
      "restaurant",
      "fast food",
      "drive-thru",
      "drive thru",
      "bar, tavern",
      "tavern",
    ],
  },

  // Automotive. "Auto Repair, Garage", "Car Wash - Self-Serve",
  // "Vehicle Sales, Vehicle Rentals", "Service Station".
  {
    category: "Automotive",
    patterns: [
      "auto repair",
      "garage",
      "vehicle sales",
      "vehicle rental",
      "service station",
      "car wash",
      "auto/truck",
      "automotive",
    ],
  },

  // Multifamily. Apartments + retirement/nursing homes (per spec) +
  // dormitories. "Garden Apt, Court Apt (5+ Units)" needs "apt" matched
  // — we use specific compound forms so we don't false-match other
  // strings that happen to contain "apt" as a non-word fragment.
  {
    category: "Multifamily",
    patterns: [
      "apartments",
      "apartment",
      "garden apt",
      "court apt",
      "high-rise apt",
      "multifamily",
      "multi-family",
      "dormitory",
      "group quarters",
      "homes (retired",
      "homes (rest",
      "homes (convalescent",
      "homes (nursing",
      "homes (handicap",
    ],
  },

  // Industrial. Warehouse, mill, factory, lumberyard, light industrial.
  // "Cold Storage" goes here (industrial refrigerated, not self-serve
  // mini-storage).
  {
    category: "Industrial",
    patterns: [
      "warehouse",
      "mill (",
      "factory",
      "industrial loft",
      "light industrial",
      "lumberyard",
      "food packing",
      "packing plant",
      "chemical",
      "cold storage",
      "industrial,",
    ],
  },

  // Retail. Shopping centers, convenience stores, "Store/Office (Mixed
  // Use)" goes here per spec. Wholesale, grocery, supermarket.
  {
    category: "Retail",
    patterns: [
      "retail",
      "shopping center",
      "convenience store",
      "store/office",
      "wholesale outlet",
      "wholesale,",
      "grocery",
      "supermarket",
      "neighborhood: shopping",
      "regional: shopping",
      "discount store",
      "department store",
    ],
  },

  // Office. Last because "office" is also a substring of "Light
  // Industrial (10% Improved Office Space)" — Industrial catches that
  // earlier via "light industrial".
  {
    category: "Office",
    patterns: [
      "office building",
      "professional building",
      "condominium office",
      "office/residential",
      "financial building",
    ],
  },

  // Parking — lots / garages / decks. Its own category (not folded into
  // Industrial or Other) so paving / striping / sealcoat contractors can
  // target it directly. The Shelby ReGIS classifier emits
  // property_type = "parking"; PropTracer's granular "Parking Garage" /
  // "Parking Lot" strings also land here.
  {
    category: "Parking",
    patterns: [
      "parking",
    ],
  },
]


export function rollupCategory(rawType: string | null | undefined): RollupCategory {
  if (!rawType) return "Other"
  const lower = rawType.toLowerCase()
  for (const { category, patterns } of ROLLUP_PATTERNS) {
    for (const p of patterns) {
      if (lower.includes(p)) return category
    }
  }
  return "Other"
}


/**
 * Flat list of all patterns across all categories — used by the
 * properties route to express "Other" as "matches none of the known
 * patterns".
 */
export const ALL_ROLLUP_PATTERNS: string[] = ROLLUP_PATTERNS.flatMap(
  (r) => r.patterns
)


/**
 * Lookup the patterns for a single rollup category. Returns [] for
 * unknown names — callers should also handle "Other" separately.
 */
export function patternsForCategory(category: string): string[] {
  const entry = ROLLUP_PATTERNS.find((r) => r.category === category)
  return entry ? entry.patterns : []
}
