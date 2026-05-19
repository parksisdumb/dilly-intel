import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { parseLocationInput } from "@/lib/intel/location-parse"

export const dynamic = "force-dynamic"

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
  "the", "of", "and", "for", "with", "from", "this", "that",
  "services", "service", "solutions", "systems", "consulting",
  "international", "national", "regional", "global", "worldwide",
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
}

type PortfolioOwner = {
  display_name: string
  label_type: "entity" | "stem" | "individual" | "address"
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
}

type ResponseShape = {
  filters: {
    city: string | null
    state: string | null
    zip: string | null
    county: string | null
    hide_gov: boolean
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
 * Pick the single most-distinctive stem from already-merged LLC names.
 * Used only post-merge to set the cluster's final `.stem` (which then
 * drives the display label). Returns null when no word reaches the merge
 * threshold.
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
  // ≥ 50% / ≥ 2-name bar. Length tiebreak prefers the more specific word.
  let bestWord: string | null = null
  let bestCount = 0
  for (const [w, c] of counts) {
    if (c < 2 || c / llcNames.length < 0.5) continue
    if (
      c > bestCount ||
      (c === bestCount && bestWord && w.length > bestWord.length)
    ) {
      bestCount = c
      bestWord = w
    }
  }
  return bestWord
}

function hasCorporateSuffix(name: string): boolean {
  for (const w of tokenizeForStem(name)) {
    if (CORP_SUFFIXES.has(w)) return true
  }
  return false
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
      // Prefer the most-populated stem; on a tie, prefer the longer word
      // (more specific) — same rule we use within a single cluster.
      if (
        t > bestTally ||
        (t === bestTally && best && s.length > best.length)
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
    }
    for (let i = 1; i < group.length; i++) {
      const g = group[i]
      out.property_count += g.property_count
      out.total_sqft += g.total_sqft
      out.total_value += g.total_value
      for (const a of g.addresses) out.addresses.push(a)
      for (const n of g.llc_names) out.llc_names.add(n)
    }
    // Re-extract post-merge so the displayed stem reflects the full name
    // set. Fall back to the merge key if no single stem clears the bar
    // (e.g. mixed Olymbec + Belz somehow landed together — unlikely but
    // the bucket key is at least the word that caused the merge).
    out.stem = extractStem(Array.from(out.llc_names)) ?? stem
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
  }

  // 1. Entity match — first LLC name that resolves wins.
  for (const llc of llcs) {
    const ent = entityLookup.get(normalizeForEntityMatch(llc))
    if (ent) {
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

  // 3. Individual owner — single LLC name without a corporate suffix.
  if (llcs.length === 1 && !hasCorporateSuffix(llcs[0])) {
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

  // Cache check — same (state, city, zip, county, hide_gov) triple within
  // CACHE_TTL_MS returns the previous response instantly. The RPC itself
  // takes 3-8 s on Memphis-sized markets.
  const cacheKey = JSON.stringify({
    state,
    city: city ?? "",
    zip: zip ?? "",
    county: county ?? "",
    hideGov,
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
  const [rpcRes, entityRows] = await Promise.all([
    db.rpc("intel_mailing_address_portfolios", {
      p_city: city,
      p_state: state,
      p_zip: zip,
      p_county: county,
      p_min_properties: 2,
      p_limit: 500,
    }),
    getEntities(db),
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

  // 2.5. Scrub gov LLCs BEFORE stem-merge.
  //
  // The Memphis demo case: Olymbec's 8 LLCs share a mailing address
  // with one Memphis Economic Development filing. If we leave the gov
  // LLC in the cluster, stem-merge can pull other private clusters
  // toward "economic" instead of "olymbec" — or worse, label an
  // otherwise-private cluster "Economic Portfolio" because the only
  // stem word came from the gov filer we're about to strip anyway.
  //
  // Scrub now so all downstream phases (stem, label, display) see only
  // the private LLCs. Property counts are kept as-is — we don't have
  // per-LLC property counts to back out, and the gov contribution at
  // any one address is typically a small minority.
  if (hideGov) {
    working = working
      .map((c) => {
        const kept = new Set<string>()
        for (const n of c.llc_names) if (!isGovernmentOwner(n)) kept.add(n)
        return { ...c, llc_names: kept }
      })
      .filter((c) => c.llc_names.size > 0)
  }

  //   3. Stem-merge across clusters.
  working = stemMergeClusters(working)
  //   4. Build entity lookup.
  const entityLookup = buildEntityLookup(entityRows)
  //   5. Label each cluster.
  let labeled = working.map((c) => labelCluster(c, entityLookup))

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
    filters: { city, state, zip, county, hide_gov: hideGov },
    portfolio_owners: top,
    portfolio_property_count: portfolioPropertyCount,
    distinct_portfolio_count: distinctPortfolioCount,
  }

  cache.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS })

  return NextResponse.json(value)
}
