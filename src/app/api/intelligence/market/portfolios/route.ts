import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { parseLocationInput } from "@/lib/intel/location-parse"
import {
  ROLLUP_CATEGORIES,
  patternsForCategory,
  ALL_ROLLUP_PATTERNS,
} from "@/lib/intel/property-types"

export const dynamic = "force-dynamic"

/**
 * Translate a rollup category into the SQL type-filter RPC arguments.
 * Mirrors the helper in ../route.ts — a normal category resolves to its
 * ILIKE patterns; "Other" resolves to all patterns with exclude=true.
 */
function typeFilterArgs(category: string | null): {
  patterns: string[] | null
  exclude: boolean
} {
  if (!category) return { patterns: null, exclude: false }
  if (category === "Other") {
    return {
      patterns: ALL_ROLLUP_PATTERNS.map((p) => `%${p}%`),
      exclude: true,
    }
  }
  const pats = patternsForCategory(category)
  if (pats.length === 0) return { patterns: null, exclude: false }
  return { patterns: pats.map((p) => `%${p}%`), exclude: false }
}

// ----------------------------------------------------------------------------
// Pipeline overview
//
// The portfolio table is the dashboard's primary "who really owns this
// market" view. One real owner often holds dozens of properties through
// different LLCs at different mailing addresses, so a raw GROUP BY on
// owner_name or even owner_mailing_address falls short.
//
// We run a five-step pipeline on top of the intel_mailing_address_portfolios
// RPC:
//
//   1. Sanitize  — drop garbage mailing addresses ("00000", < 5 chars, city
//                  "Tax Parcel", "None", etc.).
//   2. Normalize — fold "Rd" → "Road", "Ste" → "Suite", "P.O. Box" → "PO Box",
//                  collapse whitespace, then re-cluster by normalized key so
//                  the two spellings of the same address merge.
//   3. Stem-merge — for each cluster, extract the most distinctive 4+ char
//                   word from its LLC names (after dropping corporate
//                   suffixes and a ~150-term common-word blocklist). Merge
//                   clusters that share the same distinctive stem.
//   4. Entity match — sweep through intel_entities and tag any cluster whose
//                     LLCs are a known REIT / operator's subsidiaries.
//   5. Label — pick a display_name per priority: entity > stem (≥ 50%
//              of names share it) > individual > address.
//
// Cached in-process for 5 min by (state, city, hide_gov). The RPC itself
// is the heaviest GROUP BY on intel_properties, so even with the state
// index it's a 3-8 s query — caching turns repeat loads into <50 ms.
// ----------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000

type CacheEntry = { value: ResponseShape; expiresAt: number }
const cache = new Map<string, CacheEntry>()

// Government-owner patterns. Duplicated from src/app/api/intelligence/
// market/route.ts on purpose — both endpoints filter by the same rule but
// we don't want them sharing a bundle. If you change one list, change the
// other.
const GOV_PATTERNS: string[] = [
  "city of", "county of", "state of",
  "school", "public school",
  "housing authority", "municipal",
  "board of", "department of", "dept of",
  "university", "college", "hospital district",
  "transit", "airport",
  "cdd", "mdha", " isd",
  "water manage", "port authority",
  "revenue finance", "economic dev",
  "development board", "industrial development",
  "commission", "bureau", "agency", "authority",
  "township", "borough", "parish",
  "convention center", "light gas water",
  "public works", "public service",
  "educat", "redevelop", "growth engine",
  "federal", "veterans affairs",
  "memphis housing", "shelby county", "development economic",
]

function isGovernmentOwner(name: string | null | undefined): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  for (const p of GOV_PATTERNS) {
    if (lower.includes(p)) return true
  }
  return false
}

// Institutional-healthcare patterns. Separate from GOV_PATTERNS because
// hospital campuses are NOT filtered out — contractors may still want to
// see them — but they're flagged with a "Healthcare Institution" badge
// so it's clear the cluster is a hospital system rather than a typical
// commercial portfolio.
//
// Deliberately omits bare "hospital" / "clinic" / "medical" because those
// would catch medical-office buildings and healthcare REITs (Plymouth
// Industrial REIT shouldn't get flagged), which are legitimate
// contractor targets.
const INSTITUTIONAL_HEALTHCARE_PATTERNS: string[] = [
  "medical center", "children's medical", "childrens medical",
  "health system", "healthcare system",
  "methodist hospital", "baptist hospital",
  "le bonheur", "lebonheur",
  "st jude", "st. jude", "saint jude",
  "regional hospital", "general hospital",
  "university hospital", "memorial hospital",
  "research hospital",
  "medical group", "physicians group",
  // Memphis-specific: ALSAC (American Lebanese Syrian Associated
  // Charities) is St. Jude's parent charity. Pattern catches the LLC
  // variants without false-positiving regional law firms etc.
  "lebanese syrian", "alsac",
]

function isHealthcareInstitutionName(
  name: string | null | undefined,
): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  for (const p of INSTITUTIONAL_HEALTHCARE_PATTERNS) {
    if (lower.includes(p)) return true
  }
  return false
}

/**
 * True when the cluster as a whole looks like a hospital/healthcare
 * institution — the display label hits a pattern, OR > 50% of the LLC
 * names do. Cluster-level check (not per-property) so individual
 * medical-office tenants in a mixed portfolio don't flip the badge.
 */
function isHealthcareInstitutionCluster(
  displayName: string,
  llcNames: string[],
): boolean {
  if (isHealthcareInstitutionName(displayName)) return true
  if (llcNames.length === 0) return false
  let hits = 0
  for (const n of llcNames) if (isHealthcareInstitutionName(n)) hits++
  return hits / llcNames.length > 0.5
}

// Corporate suffixes — stripped from the head and tail of LLC names so
// the distinctive stem doesn't pick them up. Kept as a Set for O(1) lookup.
const CORP_SUFFIXES = new Set([
  "llc", "l.l.c", "lllc", "lp", "llp", "lllp", "l.p", "l.l.p",
  "inc", "incorporated", "corp", "corporation", "co", "company",
  "ltd", "limited", "pllc", "pc", "pa", "plc",
  "holdings", "properties", "property", "investments", "investment",
  "management", "development", "enterprises", "group", "realty",
  "trust", "ventures", "associates", "partners", "partnership",
  "foundation", "the", "of", "and", "for", "&", "a", "an",
])

// Blocklist for distinctive-stem extraction. A word in this set is too
// generic to merge clusters by — every real-estate market has dozens of
// "Memphis X LLC" or "Plaza Y LP" filings that aren't actually one owner.
//
// Three groups: geographic terms (state/city/county/regional), real-estate
// descriptive vocabulary, and the ~120 most common US surnames. False
// positives here are safe — they just push a cluster into the address-
// fallback label instead of merging it with unrelated entities.
const COMMON_STEM_BLOCKLIST = new Set([
  // Geographic / political
  "memphis", "nashville", "knoxville", "chattanooga", "tennessee",
  "shelby", "davidson", "knox", "hamilton", "county", "state", "city",
  "national", "american", "america", "united", "states", "usa",
  "first", "second", "third", "main", "old", "new",
  "southern", "northern", "eastern", "western",
  "mid", "south", "central", "north", "east", "west",
  "southeast", "northeast", "southwest", "northwest",
  "atlantic", "pacific", "gulf", "great", "lakes", "valley", "river",
  "harris", "bexar", "travis", "dallas", "houston", "austin", "antonio",
  "miami", "tampa", "orlando", "atlanta", "fulton", "cobb", "dekalb",
  // Descriptive real-estate
  "property", "properties", "real", "estate", "land", "lands",
  "home", "homes", "house", "houses", "building", "buildings",
  "commercial", "industrial", "retail", "office", "residential",
  "park", "plaza", "center", "centre", "square", "tower", "towers",
  "place", "court", "courts", "village", "villages", "gardens",
  "ridge", "hill", "hills", "lake", "lakes", "creek", "pointe", "point",
  "crossing", "crossings", "station", "junction", "junction",
  "heights", "manor", "estates", "meadows", "woods", "grove", "groves",
  "plantation", "village", "townhomes", "condominium", "condominiums",
  "shopping", "mall", "complex", "facility", "facilities",
  // Sector / industry words that surface as accidental merge keys in
  // mid-sized markets (Memphis has 13 different banks, 5 different
  // healthcare orgs, etc. — these are too generic to fuse identities by).
  "bank", "banks", "banking", "credit", "financial", "finance",
  "health", "healthcare", "hospital", "hospitals", "medical",
  "clinic", "clinics", "wellness", "rehabilitation",
  "housing", "affordable", "tenant", "tenants",
  "economic", "education", "educational", "school", "schools",
  "religious", "church", "ministry", "ministries", "charity",
  "charities", "charitable", "foundation", "foundations",
  "communities", "community", "civic", "citizens", "members",
  "energy", "utility", "utilities", "telecom", "telecommunications",
  "logistics", "warehouse", "warehouses", "distribution",
  "automotive", "transportation", "freight",
  "stores", "store", "shops", "market", "markets", "supermarket",
  "restaurant", "restaurants", "industries", "industry",
  "products", "production", "manufacturing", "factory",
  // Generic operator vocabulary
  "management", "development", "developments", "investment", "investments",
  "capital", "trust", "trusts", "group", "groups", "partners",
  "partnership", "partnerships", "fund", "funds", "asset", "assets",
  "holdings", "holding", "ventures", "venture", "associates",
  "associate", "enterprises", "enterprise", "realty", "realtors",
  "company", "companies", "corporation", "incorporated",
  // "Tn Portfolio 1 Llc" + "Tn Portfolio 10 Llc" otherwise stem-merged
  // on "portfolio" → display "Portfolio Portfolio". Blocked.
  "portfolio", "portfolios",
  "the", "of", "and", "for", "with", "from", "this", "that",
  "services", "service", "solutions", "systems", "consulting",
  "international", "national", "regional", "global", "worldwide",
  // Ethnicity / nationality / heritage terms. These appear in the names
  // of charities, community organizations, and cultural associations
  // that are NOT the same owner — e.g. "American Lebanese Syrian Assoc
  // Charities" (ALSAC / St. Jude) was being merged with unrelated
  // Lebanese-American community orgs purely on the word "lebanese".
  "lebanese", "syrian", "african", "asian", "chinese", "japanese",
  "korean", "indian", "mexican", "italian", "irish", "german",
  "french", "british", "arab", "jewish", "christian", "muslim",
  "islamic", "hispanic", "latino", "caribbean", "european",
  "armenian", "greek", "polish", "russian", "vietnamese", "thai",
  "filipino", "brazilian", "colombian", "persian", "turkish",
  "egyptian", "nigerian", "ethiopian", "somali", "haitian", "cuban",
  "puerto", "dominican", "jamaican", "trinidadian",
  "heritage", "cultural", "ethnic",
  // Nonprofit / charity / membership-org vocabulary. Charities and
  // member organizations routinely share these words without sharing
  // an owner.
  "charity", "association", "associations", "society",
  "auxiliary", "guild", "volunteer", "volunteers", "fraternal",
  "sorority", "fraternity", "lodge", "chapter", "council", "league",
  "union", "federation", "alliance", "coalition", "alsac",
  // "assoc" is a frequent abbreviation of "association" in raw owner
  // names — block the short form too.
  "assoc",
  // Found during the 2026-05-20 Memphis merge audit — generic words
  // that fused unrelated owners the same way "plaza" / "center" /
  // "company" already do:
  //   - "commons" merged 8 different shopping centers (Westwood
  //     Commons, Winchester Commons, Hickory Commons …).
  //   - "business" merged Walmart entities with Millennium Business
  //     Center and Realty Income.
  //   - "cities" is just the plural of the already-blocked "city".
  //   - "convenience" / "parkway" are generic descriptors, not owners.
  "commons", "common", "business", "cities", "convenience",
  "parkway", "boulevard", "freeway", "expressway",
  // Common US given names — blocked because "David X" + "David Y" with
  // different surnames is almost never the same person. False positives
  // here just push real owners (David Couch, etc.) into the address-
  // fallback label, which is safer than fusing distinct individuals.
  "james", "john", "robert", "michael", "william", "david", "richard",
  "joseph", "thomas", "charles", "christopher", "daniel", "matthew",
  "anthony", "donald", "mark", "paul", "steven", "andrew", "kenneth",
  "george", "joshua", "kevin", "brian", "edward", "ronald", "timothy",
  "jason", "jeffrey", "ryan", "jacob", "gary", "nicholas", "eric",
  "stephen", "jonathan", "larry", "justin", "scott", "frank",
  "brandon", "raymond", "gregory", "samuel", "patrick", "alexander",
  "benjamin", "tyler", "aaron", "henry", "douglas", "peter", "adam",
  "nathan", "zachary", "walter", "kyle", "harold", "carl", "jeremy",
  "keith", "roger", "gerald", "ethan", "arthur", "terry", "christian",
  "sean", "lawrence", "austin", "joe", "noah", "jesse", "albert",
  "bryan", "billy", "bruce", "willie", "jordan", "dylan", "alan",
  "ralph", "gabriel", "roy", "juan", "wayne", "eugene", "logan",
  "randy", "louis", "russell", "vincent", "philip", "bobby", "johnny",
  "mary", "patricia", "jennifer", "linda", "elizabeth", "barbara",
  "susan", "jessica", "sarah", "karen", "lisa", "nancy", "betty",
  "sandra", "margaret", "ashley", "kimberly", "emily", "donna",
  "michelle", "carol", "amanda", "melissa", "deborah", "stephanie",
  "rebecca", "laura", "sharon", "cynthia", "kathleen", "amy",
  // Common US surnames (top ~120)
  "smith", "johnson", "williams", "brown", "jones", "garcia",
  "miller", "davis", "rodriguez", "martinez", "hernandez", "lopez",
  "gonzalez", "wilson", "anderson", "thomas", "taylor", "moore",
  "jackson", "martin", "lee", "perez", "thompson", "white",
  "sanchez", "clark", "ramirez", "lewis", "robinson", "walker",
  "young", "allen", "king", "wright", "scott", "torres", "nguyen",
  "hill", "flores", "green", "adams", "nelson", "baker", "hall",
  "rivera", "campbell", "mitchell", "carter", "roberts", "gomez",
  "phillips", "evans", "turner", "diaz", "parker", "cruz", "edwards",
  "collins", "reyes", "stewart", "morris", "morales", "murphy",
  "cook", "rogers", "gutierrez", "ortiz", "morgan", "cooper",
  "peterson", "bailey", "reed", "kelly", "howard", "ramos",
  "kim", "cox", "ward", "richardson", "watson", "brooks", "chavez",
  "wood", "james", "bennett", "gray", "mendoza", "ruiz", "hughes",
  "price", "alvarez", "castillo", "sanders", "patel", "myers",
  "long", "ross", "foster", "jimenez", "powell", "jenkins", "perry",
  "russell", "sullivan", "bell", "coleman", "butler", "henderson",
  "barnes", "gonzales", "fisher", "vasquez", "simmons", "romero",
  "jordan", "patterson", "alexander", "hamilton", "graham", "reynolds",
  "griffin", "wallace",
])

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

type PortfolioRow = {
  owner_mailing_address: string
  owner_mailing_city: string | null
  owner_mailing_state: string | null
  owner_mailing_zip: string | null
  property_count: number
  llc_names: string[] | null
  total_sqft: number | null
  total_value: number | null
}

type EntityRow = {
  id: string
  name: string
  ticker: string | null
  subsidiary_names: string[] | null
}

// Manual portfolio-label override row (intel_portfolio_labels).
type PortfolioLabelRow = {
  match_type: "mailing_address" | "owner_stem" | "entity_id" | "owner_name"
  match_value: string
  display_name: string
  portfolio_type: string | null
}

type AddressMeta = {
  address: string
  city: string | null
  state: string | null
  zip: string | null
  property_count: number
}

type WorkingCluster = {
  normalized_key: string
  primary: AddressMeta              // highest-count source address
  addresses: AddressMeta[]
  property_count: number
  total_sqft: number
  total_value: number
  llc_names: Set<string>
  stem: string | null
  // Set when the pre-stem gov-LLC scrub stripped some (but not all) LLCs
  // from this cluster and the property_count was pro-rated to compensate.
  // Surfaced to the UI so the user knows the count is an estimate — the
  // exact number lives behind the detail panel, which re-queries with
  // gov filtering applied.
  gov_adjusted: boolean
}

type PortfolioOwner = {
  display_name: string
  // "manual" — display_name came from an intel_portfolio_labels
  // override and should be treated as authoritative / curated.
  label_type: "entity" | "stem" | "individual" | "address" | "manual"
  stem: string | null
  entity_id: string | null
  entity_name: string | null
  entity_ticker: string | null
  property_count: number
  llc_count: number
  total_sqft: number | null
  total_value: number | null
  llc_names: string[]
  mailing_address: string
  mailing_city: string | null
  mailing_state: string | null
  mailing_zip: string | null
  mailing_addresses: AddressMeta[]
  // Property_count is a proportional estimate (gov LLCs at the same
  // mailing address were stripped but the RPC's aggregate count wasn't
  // backed out per-LLC). The detail panel re-queries with full gov
  // filtering and may report a slightly different (more accurate) total.
  gov_adjusted: boolean
  // True when the cluster matches institutional-healthcare patterns
  // (hospital systems, medical centers, etc.). Surfaced as a badge in
  // the UI — these clusters stay visible but aren't typical commercial
  // portfolios.
  is_healthcare_institution: boolean
}

type ResponseShape = {
  filters: {
    city: string | null
    state: string | null
    zip: string | null
    county: string | null
    hide_gov: boolean
    property_type: string | null
  }
  portfolio_owners: PortfolioOwner[]
  // Headline portfolio-coverage stats for the market dashboard's
  // ownership panel. Computed from the FULL labeled array, not the
  // top-50 display slice — so the dashboard headline reflects the
  // entire mapped market, not what fits on the table.
  portfolio_property_count: number
  distinct_portfolio_count: number
  cached?: boolean
  error?: string
}

// ----------------------------------------------------------------------------
// Sanitization + normalization
// ----------------------------------------------------------------------------

const BAD_CITY_TOKENS = ["tax parcel", "none", "n/a", "unknown", "null"]

function isGarbageAddress(
  addr: string | null,
  city: string | null,
): boolean {
  if (!addr) return true
  const a = addr.trim()
  if (a.length < 5) return true
  // All-zero (or all-dash / all-punctuation) addresses
  if (/^[\s0\-.,]*$/.test(a)) return true
  // City contains a known sentinel
  if (city) {
    const c = city.toLowerCase().trim()
    if (BAD_CITY_TOKENS.includes(c)) return true
    if (c.includes("tax parcel")) return true
  }
  return false
}

// Long-form replacements applied to UPPER-cased addresses. Run as
// whole-word substitutions so "ST" inside "STATELINE" stays put.
const STREET_REPLS: Array<[RegExp, string]> = [
  // Order matters — multi-token PO Box variants first.
  [/\bP\s*\.\s*O\s*\.\s*BOX\b/g, "PO BOX"],
  [/\bP\s+O\s+BOX\b/g, "PO BOX"],
  [/\bPOB\b/g, "PO BOX"],
  [/\bRD\b\.?/g, "ROAD"],
  [/\bST\b\.?/g, "STREET"],
  [/\bAVE\b\.?/g, "AVENUE"],
  [/\bBLVD\b\.?/g, "BOULEVARD"],
  [/\bDR\b\.?/g, "DRIVE"],
  [/\bLN\b\.?/g, "LANE"],
  [/\bHWY\b\.?/g, "HIGHWAY"],
  [/\bPKWY\b\.?/g, "PARKWAY"],
  [/\bCT\b\.?/g, "COURT"],
  [/\bPL\b\.?/g, "PLACE"],
  [/\bCIR\b\.?/g, "CIRCLE"],
  [/\bTRL\b\.?/g, "TRAIL"],
  [/\bSTE\b\.?/g, "SUITE"],
  [/\bAPT\b\.?/g, "APARTMENT"],
  [/\bFL\b\.?/g, "FLOOR"],
]

function normalizeAddress(s: string): string {
  let a = s.toUpperCase().trim()
  // Strip out commas, periods (after the regex replacements have run), and
  // collapse runs of whitespace.
  a = a.replace(/\s+/g, " ")
  for (const [re, rep] of STREET_REPLS) a = a.replace(re, rep)
  a = a.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim()
  return a
}

function makeNormalizedKey(p: PortfolioRow): string {
  const addr = normalizeAddress(p.owner_mailing_address)
  const city = (p.owner_mailing_city ?? "").toUpperCase().trim()
  const state = (p.owner_mailing_state ?? "").toUpperCase().trim()
  return `${addr}|${city}|${state}`
}

// ----------------------------------------------------------------------------
// Stem extraction + merging
// ----------------------------------------------------------------------------

function tokenizeForStem(name: string): string[] {
  const cleaned = name
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!cleaned) return []
  return cleaned.split(" ")
}

function isQualifyingStem(w: string): boolean {
  if (w.length < 4) return false
  if (CORP_SUFFIXES.has(w)) return false
  if (COMMON_STEM_BLOCKLIST.has(w)) return false
  if (/^\d+$/.test(w)) return false
  return true
}

/**
 * Per-cluster qualifying-word counts. The merge phase uses this to compute
 * cross-cluster tallies and decide which word is the most useful stem.
 *
 * Each word is counted once per LLC name it appears in (not once per token
 * occurrence — "Olymbec Olymbec LLC" still scores 1 for "olymbec" within
 * that name).
 */
function qualifyingWordCounts(llcNames: string[]): Map<string, number> {
  const wordCounts = new Map<string, number>()
  for (const n of llcNames) {
    const seen = new Set<string>()
    for (const w of tokenizeForStem(n)) {
      if (!isQualifyingStem(w)) continue
      if (seen.has(w)) continue
      seen.add(w)
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1)
    }
  }
  return wordCounts
}

/**
 * Merge-strength gate. A shared single-word stem only justifies fusing
 * two address-clusters into one portfolio when the word is genuinely
 * distinctive — not an incidental match buried in long entity names.
 *
 * The stem passes when ANY of:
 *   A. It's a contiguous substring of > 75% of the LLC names.
 *   B. It's at least 5 characters long (long words are unlikely to
 *      collide by accident).
 *   C. It's the leading word (first or second token) of the majority
 *      of the LLC names — owners typically front-load their distinctive
 *      name ("Olymbec Bellbrook LLC", "Belz Enterprises").
 *
 * This stops cases like "American LEBANESE Syrian Assoc Charities" —
 * where the word is mid-name and shared only because two unrelated
 * charities both happen to contain it — from triggering a merge.
 * (The ethnicity/charity blocklist additions already keep most of
 * these out; this is the structural backstop for whatever slips past.)
 */
function stemPassesMergeGate(stem: string, llcNames: string[]): boolean {
  if (llcNames.length === 0) return false
  // B. Long enough to be distinctive on its own.
  if (stem.length >= 5) return true
  // A. Contiguous substring of > 75% of names.
  let contiguous = 0
  for (const n of llcNames) {
    if (n.toLowerCase().includes(stem)) contiguous++
  }
  if (contiguous / llcNames.length > 0.75) return true
  // C. Leading word (first two tokens) of the majority of names.
  let leading = 0
  for (const n of llcNames) {
    const toks = tokenizeForStem(n)
    if (toks[0] === stem || toks[1] === stem) leading++
  }
  if (leading / llcNames.length > 0.5) return true
  return false
}

/**
 * Candidate stems this cluster could be merged under. Returned as a Set so
 * stemMergeClusters can tally how many clusters share each candidate
 * before committing.
 *
 *   Multi-name clusters: a word qualifies only if it appears in ≥ 2 names
 *                        AND ≥ 50% of the cluster's names. Below that, the
 *                        word is too rare within the cluster to call it
 *                        distinctive.
 *
 *   Single-name clusters: every qualifying word is a candidate. A single
 *                         "OLYMBEC BELLBROOK LLC" doesn't know which of
 *                         {olymbec, bellbrook} is the right merge key —
 *                         the merge phase picks whichever creates a real
 *                         bucket.
 */
function candidateStems(llcNames: string[]): Set<string> {
  if (llcNames.length === 0) return new Set()
  const counts = qualifyingWordCounts(llcNames)
  const out = new Set<string>()
  if (llcNames.length === 1) {
    for (const w of counts.keys()) out.add(w)
    return out
  }
  for (const [w, c] of counts) {
    if (c >= 2 && c / llcNames.length >= 0.5) out.add(w)
  }
  return out
}

/**
 * Levenshtein edit distance — used to detect typo-cluster signals like the
 * Memphis "Five / Fivf / Fifv" group where the source data has multiple
 * misspellings of the same root word. Quadratic in length but inputs are
 * single tokens (≤ ~15 chars), so the cost is trivial.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const dp: number[] = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) dp[j] = j
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = tmp
    }
  }
  return dp[b.length]
}

/**
 * A "typo-cluster" signal: when the top stem candidate has another
 * qualifying word in the same set that's within Levenshtein-1 of it AND
 * occurs in at least 25% of the top candidate's name set, we treat the
 * whole word as untrustworthy.
 *
 * Memphis case: "fivf" (5 names) + "five" (3 names) + "fifv" (1) all
 * within edit-distance 1 of each other. Any of these as a label is
 * misleading; the cluster falls through to phrase-stem / address.
 *
 * Olymbec case: "olymbec" (8) + "oylmbec" (1, also within ed-1). 1/8 =
 * 12.5% < 25% threshold → keep "olymbec".
 */
function hasTypoVariant(
  bestWord: string,
  bestCount: number,
  counts: Map<string, number>,
): boolean {
  if (bestWord.length < 4) return false
  for (const [w, c] of counts) {
    if (w === bestWord) continue
    if (editDistance(w, bestWord) > 1) continue
    if (c / bestCount >= 0.25) return true
  }
  return false
}

/**
 * Pick the single most-distinctive stem from already-merged LLC names.
 * Used only post-merge to set the cluster's final `.stem` (which then
 * drives the display label). Returns null when no word reaches the merge
 * threshold OR when a typo-variant conflict is detected.
 */
function extractStem(llcNames: string[]): string | null {
  if (llcNames.length === 0) return null
  const counts = qualifyingWordCounts(llcNames)
  if (counts.size === 0) return null

  if (llcNames.length === 1) {
    // Only label as a stem when the name has exactly one qualifying word —
    // otherwise we'd guess between "Acme" and "Smith" in "Acme Smith LLC".
    return counts.size === 1 ? counts.keys().next().value ?? null : null
  }

  // Multi-name: pick the word with the highest count that also clears the
  // ≥ 50% / ≥ 2-name bar. Tiebreak: prefer the alphabetically-earlier word
  // (deterministic, and "five" wins over "fivf" at equal count).
  let bestWord: string | null = null
  let bestCount = 0
  for (const [w, c] of counts) {
    if (c < 2 || c / llcNames.length < 0.5) continue
    if (
      c > bestCount ||
      (c === bestCount && (!bestWord || w < bestWord))
    ) {
      bestCount = c
      bestWord = w
    }
  }
  if (!bestWord) return null

  // Reject the stem if a typo-variant of the winner is also present in
  // meaningful numbers — we'd otherwise mislabel a typo-y cluster like
  // "Fivf/Five/Fifv" as the most-frequent (often misspelled) variant.
  if (hasTypoVariant(bestWord, bestCount, counts)) return null

  return bestWord
}

/**
 * Multi-word phrase fallback. Looks for bigrams and trigrams that appear
 * in ≥ 50% of the cluster's LLC names and ≥ 2 names. Used to label
 * clusters where every distinctive word is on the single-word blocklist
 * (e.g. "Bell Property Group Lp", "Bell Property Group Ii Lp" — "bell",
 * "property", "group" are all individually blocked, but the trigram
 * "bell property group" is the real owner identity).
 *
 * Longest qualifying phrase wins so "bell property group" beats "bell
 * property" when both qualify; ties resolved alphabetically.
 *
 * Phrases composed entirely of blocklist words are rejected — the whole
 * point of this fallback is to catch combinations that are *less* generic
 * than their parts.
 */
function extractPhraseStem(llcNames: string[]): string | null {
  if (llcNames.length < 2) return null

  // Helper: gather all qualifying (suffix-free, non-digit, length ≥ 2)
  // tokens per name for adjacency-aware n-gramming. We DON'T filter the
  // blocklist here — single-word blocked terms like "property" are fine
  // as parts of a phrase.
  function gramTokens(name: string): string[] {
    const out: string[] = []
    for (const w of tokenizeForStem(name)) {
      if (w.length < 2) continue
      if (CORP_SUFFIXES.has(w)) continue
      if (/^\d+$/.test(w)) continue
      out.push(w)
    }
    return out
  }

  const tokensByName = llcNames.map(gramTokens)

  // Per-cluster qualifying-word counts — reused to detect typo
  // conflicts in any word a candidate phrase contains. Same threshold
  // (≥ 25% of the leading word's count) as the single-stem typo check.
  const wordCounts = qualifyingWordCounts(llcNames)
  function phraseHasTypoVariant(phrase: string): boolean {
    for (const w of phrase.split(" ")) {
      if (w.length < 4) continue
      const c = wordCounts.get(w)
      if (!c) continue
      for (const [other, oc] of wordCounts) {
        if (other === w) continue
        if (other.length < 4) continue
        if (editDistance(other, w) > 1) continue
        if (oc / c >= 0.25) return true
      }
    }
    return false
  }

  for (const n of [3, 2]) {
    const phraseCounts = new Map<string, number>()
    for (const tokens of tokensByName) {
      const seen = new Set<string>()
      for (let i = 0; i + n <= tokens.length; i++) {
        const phrase = tokens.slice(i, i + n).join(" ")
        if (seen.has(phrase)) continue
        seen.add(phrase)
        phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1)
      }
    }
    let best: string | null = null
    let bestCount = 0
    for (const [p, c] of phraseCounts) {
      if (c < 2 || c / llcNames.length < 0.5) continue
      const words = p.split(" ")
      // Reject phrases that are entirely blocklist words — they wouldn't
      // be more informative than the single-word stem we already passed
      // on.
      if (words.every((w) => COMMON_STEM_BLOCKLIST.has(w))) continue
      // Reject phrases containing "portfolio"/"portfolios" — the label
      // is built as `<phrase> Portfolio`, so a phrase like "tn
      // portfolio" (from "Tn Portfolio 1 Llc" …) would render the
      // nonsensical "Tn Portfolio Portfolio". Such SPV-numbering
      // schemes carry no real owner name; let them fall to the address
      // label instead.
      if (words.some((w) => w === "portfolio" || w === "portfolios")) {
        continue
      }
      // Reject phrases whose constituent words have typo-variants in
      // the cluster ("fivf iii" wins by count but "fivf" itself has
      // "five" / "fifv" within edit-distance 1 — same root, different
      // spelling, no canonical label possible).
      if (phraseHasTypoVariant(p)) continue
      if (
        c > bestCount ||
        (c === bestCount && best && p.length > best.length) ||
        (c === bestCount && best && p.length === best.length && p < best)
      ) {
        bestCount = c
        best = p
      }
    }
    if (best) return best
  }
  return null
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")
}

// ----------------------------------------------------------------------------
// Entity matching
// ----------------------------------------------------------------------------

// Module-level cache for the entities table. It's small (low hundreds of
// rows) and changes rarely — re-fetching per request is wasteful.
let entityCache: { rows: EntityRow[]; expiresAt: number } | null = null
const ENTITY_CACHE_TTL_MS = 10 * 60 * 1000

async function getEntities(
  db: ReturnType<typeof createAdminClient>,
): Promise<EntityRow[]> {
  const now = Date.now()
  if (entityCache && entityCache.expiresAt > now) return entityCache.rows
  const res = await db
    .from("intel_entities")
    .select("id, name, ticker, subsidiary_names")
  if (res.error || !res.data) {
    return entityCache?.rows ?? []
  }
  entityCache = {
    rows: res.data as EntityRow[],
    expiresAt: now + ENTITY_CACHE_TTL_MS,
  }
  return entityCache.rows
}

function normalizeForEntityMatch(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Build a flat normalized-name → entity lookup. */
function buildEntityLookup(rows: EntityRow[]): Map<string, EntityRow> {
  const m = new Map<string, EntityRow>()
  for (const e of rows) {
    m.set(normalizeForEntityMatch(e.name), e)
    for (const sub of e.subsidiary_names ?? []) {
      m.set(normalizeForEntityMatch(sub), e)
    }
  }
  return m
}

// ----------------------------------------------------------------------------
// Manual portfolio-label overrides (intel_portfolio_labels)
// ----------------------------------------------------------------------------

// Module-level cache for the override table. Tiny and rarely changes.
let labelCache: { rows: PortfolioLabelRow[]; expiresAt: number } | null = null
const LABEL_CACHE_TTL_MS = 10 * 60 * 1000

async function getPortfolioLabels(
  db: ReturnType<typeof createAdminClient>,
): Promise<PortfolioLabelRow[]> {
  const now = Date.now()
  if (labelCache && labelCache.expiresAt > now) return labelCache.rows
  const res = await db
    .from("intel_portfolio_labels")
    .select("match_type, match_value, display_name, portfolio_type")
  if (res.error || !res.data) {
    // Table may not exist yet (migration not applied) — degrade to no
    // overrides rather than failing the whole portfolios response.
    return labelCache?.rows ?? []
  }
  labelCache = {
    rows: res.data as PortfolioLabelRow[],
    expiresAt: now + LABEL_CACHE_TTL_MS,
  }
  return labelCache.rows
}

/**
 * Find a manual label that matches this cluster, or null. Checked BEFORE
 * the auto-labeling pipeline so a curated name always wins.
 *
 *   mailing_address — match_value is a substring of any of the cluster's
 *                     normalized mailing addresses (handles "501 Saint
 *                     Jude Pl" matching "501 Saint Jude Pl, Memphis…").
 *   owner_stem      — case-insensitive equality with the cluster stem.
 *   owner_name      — case-insensitive equality with any LLC name.
 *   entity_id       — equality with the resolved entity id (passed in).
 */
function matchPortfolioLabel(
  labels: PortfolioLabelRow[],
  cluster: WorkingCluster,
  resolvedEntityId: string | null,
): PortfolioLabelRow | null {
  if (labels.length === 0) return null
  const normAddrs = cluster.addresses.map((a) => normalizeAddress(a.address))
  const stemLower = (cluster.stem ?? "").toLowerCase()
  const llcLower = Array.from(cluster.llc_names).map((n) => n.toLowerCase())

  for (const lbl of labels) {
    const v = lbl.match_value
    if (lbl.match_type === "mailing_address") {
      const target = normalizeAddress(v)
      if (target && normAddrs.some((a) => a.includes(target))) return lbl
    } else if (lbl.match_type === "owner_stem") {
      if (stemLower && stemLower === v.toLowerCase()) return lbl
    } else if (lbl.match_type === "owner_name") {
      const vl = v.toLowerCase()
      if (llcLower.some((n) => n === vl)) return lbl
    } else if (lbl.match_type === "entity_id") {
      if (resolvedEntityId && resolvedEntityId === v) return lbl
    }
  }
  return null
}

// ----------------------------------------------------------------------------
// Pipeline
// ----------------------------------------------------------------------------

function buildClustersFromRpc(rows: PortfolioRow[]): WorkingCluster[] {
  // Step 1: sanitize + normalize. Group RPC rows by normalized address key
  // so two spellings of the same place collapse here, before we even look
  // at owner names.
  const byKey = new Map<string, WorkingCluster>()

  for (const r of rows) {
    if (isGarbageAddress(r.owner_mailing_address, r.owner_mailing_city)) continue
    const key = makeNormalizedKey(r)
    const meta: AddressMeta = {
      address: r.owner_mailing_address,
      city: r.owner_mailing_city,
      state: r.owner_mailing_state,
      zip: r.owner_mailing_zip,
      property_count: Number(r.property_count) || 0,
    }
    const existing = byKey.get(key)
    const names = r.llc_names ?? []
    if (existing) {
      existing.addresses.push(meta)
      existing.property_count += meta.property_count
      existing.total_sqft += Number(r.total_sqft) || 0
      existing.total_value += Number(r.total_value) || 0
      for (const n of names) if (n) existing.llc_names.add(n)
      if (meta.property_count > existing.primary.property_count) {
        existing.primary = meta
      }
    } else {
      byKey.set(key, {
        normalized_key: key,
        primary: meta,
        addresses: [meta],
        property_count: meta.property_count,
        total_sqft: Number(r.total_sqft) || 0,
        total_value: Number(r.total_value) || 0,
        llc_names: new Set(names.filter(Boolean)),
        stem: null,
        gov_adjusted: false,
      })
    }
  }

  return Array.from(byKey.values())
}

function stemMergeClusters(clusters: WorkingCluster[]): WorkingCluster[] {
  // Step 3: stem-merge.
  //
  // Two passes. In pass one we collect every candidate stem each cluster
  // could plausibly belong to, and tally how many clusters propose each
  // stem. In pass two we commit each cluster to its most-populated stem —
  // a stem only "wins" if at least two clusters share it.
  //
  // Single-name clusters can propose multiple candidates ("OLYMBEC
  // BELLBROOK LLC" → both `olymbec` and `bellbrook`), so the tally pass
  // is what lets it correctly join the broader Olymbec bucket instead of
  // sitting alone under a useless `bellbrook` tag.

  const clusterCandidates: Set<string>[] = clusters.map((c) =>
    candidateStems(Array.from(c.llc_names)),
  )
  const stemTallies = new Map<string, number>()
  for (const cs of clusterCandidates) {
    for (const s of cs) stemTallies.set(s, (stemTallies.get(s) ?? 0) + 1)
  }

  const assignedStems: (string | null)[] = clusters.map((_, i) => {
    let best: string | null = null
    let bestTally = 0
    for (const s of clusterCandidates[i]) {
      const t = stemTallies.get(s) ?? 0
      // Prefer the most-populated stem; on a tie, prefer the
      // alphabetically-earlier word — deterministic and matches the
      // tiebreak in extractStem so the merge key and the eventual
      // display stem agree.
      if (
        t > bestTally ||
        (t === bestTally && best && s < best)
      ) {
        bestTally = t
        best = s
      }
    }
    // Need ≥ 2 clusters sharing the stem for it to actually merge anything.
    return bestTally >= 2 ? best : null
  })

  const stemBuckets = new Map<string, WorkingCluster[]>()
  const passThrough: WorkingCluster[] = []
  for (let i = 0; i < clusters.length; i++) {
    const stem = assignedStems[i]
    const c = clusters[i]
    if (stem) {
      let list = stemBuckets.get(stem)
      if (!list) {
        list = []
        stemBuckets.set(stem, list)
      }
      list.push(c)
    } else {
      passThrough.push(c)
    }
  }

  const merged: WorkingCluster[] = []
  for (const [stem, group] of stemBuckets) {
    if (group.length === 1) {
      // The tally pass guarantees ≥ 2 candidates, but only ≥ 2 *unique*
      // clusters actually appear here — so a single survivor is possible
      // if the others all got assigned to a different stem. Keep it alone.
      group[0].stem = extractStem(Array.from(group[0].llc_names))
      merged.push(group[0])
      continue
    }
    // FIX 3 — merge-strength gate. A shared stem only justifies fusing
    // multiple address-clusters when it's genuinely distinctive (long,
    // a contiguous substring of >75% of names, or a leading word).
    // Otherwise the word is an incidental mid-name collision; keep the
    // clusters separate and let each fall to its own label.
    const groupNames = group.flatMap((g) => Array.from(g.llc_names))
    if (!stemPassesMergeGate(stem, groupNames)) {
      for (const g of group) {
        g.stem = extractStem(Array.from(g.llc_names))
        merged.push(g)
      }
      continue
    }
    group.sort((a, b) => b.property_count - a.property_count)
    const head = group[0]
    const out: WorkingCluster = {
      normalized_key: `stem:${stem}`,
      primary: head.primary,
      addresses: [...head.addresses],
      property_count: head.property_count,
      total_sqft: head.total_sqft,
      total_value: head.total_value,
      llc_names: new Set(head.llc_names),
      stem: head.stem,
      // If any source cluster carried the pro-rated flag, the merged
      // total inherits the same estimate caveat.
      gov_adjusted: head.gov_adjusted,
    }
    for (let i = 1; i < group.length; i++) {
      const g = group[i]
      out.property_count += g.property_count
      out.total_sqft += g.total_sqft
      out.total_value += g.total_value
      for (const a of g.addresses) out.addresses.push(a)
      for (const n of g.llc_names) out.llc_names.add(n)
      if (g.gov_adjusted) out.gov_adjusted = true
    }
    // Re-extract post-merge so the displayed stem reflects the full
    // name set. Critically, we DO NOT fall back to the bucket key here
    // — if extractStem rejected the merged set (typo-variant conflict
    // like "Fivf/Five/Fifv"), the cluster should flow on to the
    // phrase-stem / address label paths instead of forcing the noisy
    // word back into the display.
    out.stem = extractStem(Array.from(out.llc_names))
    merged.push(out)
  }
  for (const c of passThrough) {
    c.stem = extractStem(Array.from(c.llc_names))
    merged.push(c)
  }

  return merged
}

function labelCluster(
  c: WorkingCluster,
  entityLookup: Map<string, EntityRow>,
  labels: PortfolioLabelRow[],
): PortfolioOwner {
  const llcs = Array.from(c.llc_names)

  // Sort addresses by their own property_count DESC for a deterministic
  // primary.
  const addresses = [...c.addresses].sort(
    (a, b) => b.property_count - a.property_count,
  )

  const base = {
    property_count: c.property_count,
    llc_count: llcs.length,
    total_sqft: c.total_sqft || null,
    total_value: c.total_value || null,
    llc_names: llcs,
    mailing_address: c.primary.address,
    mailing_city: c.primary.city,
    mailing_state: c.primary.state,
    mailing_zip: c.primary.zip,
    mailing_addresses: addresses,
    gov_adjusted: c.gov_adjusted,
    // Filled in post-label below — we need display_name to do the check.
    is_healthcare_institution: false,
  }

  // Resolve the entity match once up front — needed both for entity-id
  // label overrides and for the normal entity-label path below.
  let resolvedEntity: EntityRow | null = null
  for (const llc of llcs) {
    const ent = entityLookup.get(normalizeForEntityMatch(llc))
    if (ent) {
      resolvedEntity = ent
      break
    }
  }

  // 0. Manual override — intel_portfolio_labels. Checked BEFORE every
  //    auto-labeling rule so a curated name always wins.
  const override = matchPortfolioLabel(
    labels,
    c,
    resolvedEntity?.id ?? null,
  )
  if (override) {
    return {
      ...base,
      display_name: override.display_name,
      label_type: "manual",
      stem: c.stem,
      entity_id: resolvedEntity?.id ?? null,
      entity_name: resolvedEntity?.name ?? null,
      entity_ticker: resolvedEntity?.ticker ?? null,
    }
  }

  // 1. Entity match — first LLC name that resolves wins.
  if (resolvedEntity) {
    const ent = resolvedEntity
    const tickerSuffix = ent.ticker ? ` · ${ent.ticker}` : ""
    return {
      ...base,
      display_name: `${ent.name}${tickerSuffix}`,
      label_type: "entity",
      stem: c.stem,
      entity_id: ent.id,
      entity_name: ent.name,
      entity_ticker: ent.ticker,
    }
  }

  // 2. Stem — set on multi-name clusters where ≥ 50% of names share a
  //    qualifying word.
  if (c.stem && llcs.length > 1) {
    return {
      ...base,
      display_name: `${titleCase(c.stem)} Portfolio`,
      label_type: "stem",
      stem: c.stem,
      entity_id: null,
      entity_name: null,
      entity_ticker: null,
    }
  }

  // 2b. Phrase-stem fallback — for clusters where no single word stem
  //     qualifies but a 2/3-word phrase shows up in ≥ 50% of names
  //     (e.g. "Bell Property Group" — every individual word is on the
  //     surname / generic blocklist but the trigram is the actual owner
  //     identity).
  if (!c.stem && llcs.length > 1) {
    const phrase = extractPhraseStem(llcs)
    if (phrase) {
      return {
        ...base,
        display_name: `${titleCase(phrase)} Portfolio`,
        label_type: "stem",
        stem: phrase,
        entity_id: null,
        entity_name: null,
        entity_ticker: null,
      }
    }
  }

  // 3. Single-LLC cluster — use the LLC name verbatim as the display.
  //    Previously this only fired when the name lacked a corporate
  //    suffix, which left things like "GKI Infill Memphis LLC" stuck in
  //    the address-fallback bucket showing "Portfolio — 280 Park Ave"
  //    when the LLC name itself is the most informative label.
  if (llcs.length === 1) {
    return {
      ...base,
      display_name: titleCase(llcs[0]),
      label_type: "individual",
      stem: c.stem,
      entity_id: null,
      entity_name: null,
      entity_ticker: null,
    }
  }

  // 4. Address fallback. "Portfolio — 333 Texas St, Shreveport LA"
  //
  // The RPC's raw owner_mailing_address often already carries ", City,
  // State Zip" baked in — appending again would double the locality. We
  // detect that case by checking whether the address already contains
  // the city; only append when it doesn't.
  const headline = c.primary
  const addrTitled = titleCase(headline.address)
  const lowerAddr = headline.address.toLowerCase()
  const cityLower = (headline.city ?? "").toLowerCase()
  const hasCityInAddr = cityLower && lowerAddr.includes(cityLower)
  const tailParts: string[] = []
  if (!hasCityInAddr && headline.city) tailParts.push(headline.city)
  if (!hasCityInAddr && headline.state) tailParts.push(headline.state)
  const tail = tailParts.length ? `, ${tailParts.join(" ")}` : ""
  return {
    ...base,
    display_name: `Portfolio — ${addrTitled}${tail}`,
    label_type: "address",
    stem: c.stem,
    entity_id: null,
    entity_name: null,
    entity_ticker: null,
  }
}

// ----------------------------------------------------------------------------
// HTTP handler
// ----------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  const search = sp.get("search")?.trim() || null
  const parsed = parseLocationInput(search)

  const city = sp.get("city")?.trim() || parsed.city
  const zip = sp.get("zip")?.trim() || parsed.zip
  const county = sp.get("county")?.trim() || parsed.county
  const state = sp.get("state")?.trim().toUpperCase() || null

  // The mailing-address GROUP BY is the heaviest query in the dashboard —
  // an unfiltered run trips the statement timeout, so bail out before the
  // RPC call.
  if (!state) {
    return NextResponse.json(
      { error: "State parameter required" },
      { status: 400 },
    )
  }

  const hideGov = (sp.get("hide_gov") ?? "true").toLowerCase() !== "false"

  // Optional property-type filter — a rollup category label. Anything
  // outside the known taxonomy is ignored (treated as no filter).
  const propertyTypeRaw = sp.get("property_type")?.trim() || null
  const propertyType =
    propertyTypeRaw &&
    (ROLLUP_CATEGORIES as readonly string[]).includes(propertyTypeRaw)
      ? propertyTypeRaw
      : null
  const { patterns: typePatterns, exclude: typeExclude } =
    typeFilterArgs(propertyType)

  // Cache check — keyed by (state, city, zip, county, hide_gov,
  // property_type) so type-filtered and unfiltered results never mix.
  const cacheKey = JSON.stringify({
    state,
    city: city ?? "",
    zip: zip ?? "",
    county: county ?? "",
    hideGov,
    propertyType: propertyType ?? "",
  })
  const now = Date.now()
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return NextResponse.json({ ...cached.value, cached: true })
  }

  const db = createAdminClient()

  // Pull more rows than we'll return — sanitization + stem-merge collapse
  // many of them, and we need a deep enough tail to find stem-mates. The
  // RPC's GROUP BY is the same cost regardless of LIMIT (the LIMIT only
  // affects the result-set size, not the work done), so generous is free.
  const [rpcRes, entityRows, labelRows] = await Promise.all([
    db.rpc("intel_mailing_address_portfolios", {
      p_city: city,
      p_state: state,
      p_zip: zip,
      p_county: county,
      p_min_properties: 2,
      p_limit: 500,
      p_type_patterns: typePatterns,
      p_type_exclude: typeExclude,
    }),
    getEntities(db),
    getPortfolioLabels(db),
  ])

  if (rpcRes.error) {
    return NextResponse.json(
      {
        portfolio_owners: [],
        portfolio_property_count: 0,
        distinct_portfolio_count: 0,
        error: rpcRes.error.message,
      } satisfies Partial<ResponseShape>,
      { status: 200 },
    )
  }

  const rawRows = (rpcRes.data ?? []) as PortfolioRow[]

  // Pipeline:
  //   1+2. Sanitize + normalize + re-cluster by normalized address key.
  let working = buildClustersFromRpc(rawRows)

  // 2.5. Scrub gov LLCs BEFORE stem-merge, and pro-rate the aggregate
  //      counts to match.
  //
  // The Memphis demo case: Olymbec's 8 LLCs share a mailing address
  // with one Memphis Economic Development filing. If we leave the gov
  // LLC in the cluster, stem-merge can pull other private clusters
  // toward "economic" instead of "olymbec" — or worse, label an
  // otherwise-private cluster "Economic Portfolio" because the only
  // stem word came from the gov filer we're about to strip anyway.
  //
  // Count adjustment: the RPC returns one aggregate property_count per
  // mailing address with no per-LLC breakdown, so we can't back out the
  // gov-owned property contribution exactly. Instead we pro-rate the
  // count, sqft, and value by (kept_llcs / total_llcs) — equivalent to
  // assuming properties are spread roughly evenly across the LLCs at
  // each address. The detail panel re-queries with full gov filtering
  // and gives the exact number when the user clicks through; we mark
  // adjusted rows with gov_adjusted=true so the UI can flag them.
  //
  // Drop rules:
  //   - All LLCs gov (kept === 0)             → drop.
  //   - Majority gov (kept * 2 < original)    → drop. Clusters like
  //     100 Peabody Place that are 11 gov filings + 2 private records
  //     are functionally a gov address with a stray private LLC; the
  //     resulting pro-rated count is misleading and the detail panel's
  //     2-property answer doesn't justify a top-50 slot.
  if (hideGov) {
    working = working
      .map((c) => {
        const original = c.llc_names.size
        const kept = new Set<string>()
        for (const n of c.llc_names) if (!isGovernmentOwner(n)) kept.add(n)
        // Drop both all-gov and majority-gov clusters by zeroing
        // llc_names — the filter step below removes them.
        if (kept.size === 0 || kept.size * 2 < original) {
          return { ...c, llc_names: new Set<string>() }
        }
        if (kept.size === original) return { ...c, llc_names: kept }
        // Some (but not most) LLCs stripped — pro-rate the aggregates.
        const ratio = kept.size / original
        return {
          ...c,
          llc_names: kept,
          property_count: Math.max(1, Math.round(c.property_count * ratio)),
          total_sqft: c.total_sqft * ratio,
          total_value: c.total_value * ratio,
          gov_adjusted: true,
        }
      })
      .filter((c) => c.llc_names.size > 0)
  }

  //   3. Stem-merge across clusters.
  working = stemMergeClusters(working)
  //   4. Build entity lookup.
  const entityLookup = buildEntityLookup(entityRows)
  //   5. Label each cluster. Manual overrides (intel_portfolio_labels)
  //      are checked first inside labelCluster. is_healthcare_institution
  //      runs on the final display_name so an override like "ALSAC /
  //      St. Jude …" still trips the healthcare badge.
  let labeled = working.map((c) => {
    const p = labelCluster(c, entityLookup, labelRows)
    p.is_healthcare_institution = isHealthcareInstitutionCluster(
      p.display_name,
      p.llc_names,
    )
    return p
  })

  // Final gov filter: clusters whose chosen label itself reads gov
  // (e.g. an entity match landed on a gov-named record). After the
  // pre-merge scrub above, this is mostly a belt-and-suspenders pass.
  if (hideGov) {
    labeled = labeled.filter((p) => {
      if (isGovernmentOwner(p.entity_name)) return false
      if (isGovernmentOwner(p.display_name)) return false
      return true
    })
  }

  // Final sort + top-50 slice. We sort by property_count DESC; ties broken
  // by total_sqft so the more "real" portfolio surfaces above one with the
  // same count but no sqft data.
  labeled.sort((a, b) => {
    if (b.property_count !== a.property_count) {
      return b.property_count - a.property_count
    }
    return (b.total_sqft ?? 0) - (a.total_sqft ?? 0)
  })

  // Dashboard headline counts. Computed BEFORE the top-50 slice so the
  // market panel reflects the full mapped portfolio universe, not just
  // what fits in the table.
  const portfolioPropertyCount = labeled.reduce(
    (s, p) => s + (p.property_count || 0),
    0,
  )
  const distinctPortfolioCount = labeled.length

  const top = labeled.slice(0, 50)

  const value: ResponseShape = {
    filters: {
      city,
      state,
      zip,
      county,
      hide_gov: hideGov,
      property_type: propertyType,
    },
    portfolio_owners: top,
    portfolio_property_count: portfolioPropertyCount,
    distinct_portfolio_count: distinctPortfolioCount,
  }

  cache.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS })

  return NextResponse.json(value)
}
