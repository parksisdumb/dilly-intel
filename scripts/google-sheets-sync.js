/**
 * Dilly Intel → Google Sheets sync
 *
 * This is Google Apps Script, NOT Node.js.
 * Paste this into Extensions > Apps Script of a Google Sheet.
 * See setup instructions at the bottom of this file.
 */

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const SUPABASE_URL = 'https://tsuukismiswxzielbshv.supabase.co'
// intel_* tables have no RLS per CLAUDE.md — service role key required
const SUPABASE_KEY = 'PASTE_YOUR_SERVICE_ROLE_KEY_HERE'

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function supabaseFetch(path) {
  const url = SUPABASE_URL + '/rest/v1/' + path
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
    },
    muteHttpExceptions: true,
  })
  const code = res.getResponseCode()
  if (code !== 200) {
    throw new Error('Supabase error ' + code + ': ' + res.getContentText().slice(0, 300))
  }
  return JSON.parse(res.getContentText())
}

function getOrCreateSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  let sheet = ss.getSheetByName(name)
  if (!sheet) sheet = ss.insertSheet(name)
  sheet.clear()
  return sheet
}

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
}

function parseJsonSafe(val) {
  if (!val) return []
  if (Array.isArray(val)) return val
  try { return JSON.parse(val) } catch (e) { return [] }
}

function fmtSqFt(val) {
  if (val == null) return ''
  const n = Number(val)
  if (isNaN(n) || n === 0) return ''
  return (n / 1000000).toFixed(1) + 'M'
}

// ─────────────────────────────────────────────
// TAB 1: Entities
// ─────────────────────────────────────────────
function syncEntities() {
  const path = 'intel_entities?select=name,ticker,sector,portfolio_type,' +
    'hq_city,hq_state,total_properties,total_sq_footage,operating_markets,' +
    'investment_vehicles,needs_website_scrape,last_10k_date,source_detail,' +
    'updated_at&entity_type=eq.reit&order=total_sq_footage.desc.nullslast&limit=500'
  const data = supabaseFetch(path)

  const sheet = getOrCreateSheet('Entities')
  const headers = [
    'name', 'ticker', 'sector', 'portfolio_type',
    'hq_city', 'hq_state', 'total_properties', 'total_sq_footage',
    'market_count', 'vehicle_count',
    'needs_website_scrape', 'last_10k_date', 'source_detail', 'updated_at',
  ]
  sheet.appendRow(headers)

  const rows = data.map(function (e) {
    return [
      e.name || '',
      e.ticker || '',
      e.sector || '',
      e.portfolio_type || '',
      e.hq_city || '',
      e.hq_state || '',
      e.total_properties || '',
      fmtSqFt(e.total_sq_footage),
      parseJsonSafe(e.operating_markets).length,
      parseJsonSafe(e.investment_vehicles).length,
      e.needs_website_scrape ? 'TRUE' : '',
      e.last_10k_date || '',
      e.source_detail || '',
      fmtDate(e.updated_at),
    ]
  })

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows)
  }
  sheet.setFrozenRows(1)
  sheet.autoResizeColumns(1, headers.length)
}

// ─────────────────────────────────────────────
// TAB 2: Agent Runs
// ─────────────────────────────────────────────
function syncAgentRuns() {
  const path = 'agent_runs?select=agent_name,status,started_at,completed_at,' +
    'records_found,records_added,records_skipped,error_message' +
    '&order=started_at.desc&limit=100'
  const data = supabaseFetch(path)

  const sheet = getOrCreateSheet('Agent Runs')
  const headers = [
    'agent_name', 'status', 'started_at', 'completed_at',
    'duration_min', 'records_found', 'records_added', 'records_skipped',
    'error_message',
  ]
  sheet.appendRow(headers)

  const rows = data.map(function (r) {
    let duration = ''
    if (r.started_at && r.completed_at) {
      const ms = new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()
      duration = (ms / 60000).toFixed(1)
    }
    return [
      r.agent_name || '',
      r.status || '',
      fmtDate(r.started_at),
      fmtDate(r.completed_at),
      duration,
      r.records_found || 0,
      r.records_added || 0,
      r.records_skipped || 0,
      (r.error_message || '').slice(0, 500),
    ]
  })

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows)
  }
  sheet.setFrozenRows(1)
  sheet.autoResizeColumns(1, headers.length)
}

// ─────────────────────────────────────────────
// TAB 3: Sources (source_detail + entity_type counts)
// ─────────────────────────────────────────────
function syncSourceBreakdown() {
  const data = supabaseFetch('intel_entities?select=source_detail,entity_type,updated_at&limit=1000')

  const groups = {}
  for (let i = 0; i < data.length; i++) {
    const r = data[i]
    const src = r.source_detail || '(unknown)'
    const type = r.entity_type || '(unknown)'
    const key = src + '||' + type
    if (!groups[key]) {
      groups[key] = { source_detail: src, entity_type: type, count: 0, last_updated: '' }
    }
    groups[key].count++
    if (r.updated_at && r.updated_at > groups[key].last_updated) {
      groups[key].last_updated = r.updated_at
    }
  }

  const rows = Object.keys(groups)
    .map(function (k) { return groups[k] })
    .sort(function (a, b) { return b.count - a.count })
    .map(function (g) {
      return [g.source_detail, g.entity_type, g.count, fmtDate(g.last_updated)]
    })

  const sheet = getOrCreateSheet('Sources')
  sheet.appendRow(['source_detail', 'entity_type', 'count', 'last_updated'])
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 4).setValues(rows)
  }
  sheet.setFrozenRows(1)
  sheet.autoResizeColumns(1, 4)
}

// ─────────────────────────────────────────────
// TAB 4: Coverage Map (entities by hq_state)
// ─────────────────────────────────────────────
function syncCoverageMap() {
  const data = supabaseFetch('intel_entities?select=hq_state,total_properties&limit=1000')

  const byState = {}
  for (let i = 0; i < data.length; i++) {
    const r = data[i]
    const state = r.hq_state || '(unknown)'
    if (!byState[state]) byState[state] = { state: state, entity_count: 0, property_owner_count: 0 }
    byState[state].entity_count++
    if (r.total_properties && Number(r.total_properties) > 0) {
      byState[state].property_owner_count++
    }
  }

  const rows = Object.keys(byState)
    .map(function (k) { return byState[k] })
    .sort(function (a, b) { return b.entity_count - a.entity_count })
    .map(function (s) { return [s.state, s.entity_count, s.property_owner_count] })

  const sheet = getOrCreateSheet('Coverage Map')
  sheet.appendRow(['state', 'entity_count', 'property_owner_count'])
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 3).setValues(rows)
  }
  sheet.setFrozenRows(1)
  sheet.autoResizeColumns(1, 3)
}

// ─────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────
function syncAll() {
  syncEntities()
  syncAgentRuns()
  syncSourceBreakdown()
  syncCoverageMap()
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Dilly Intel')
    .addItem('Sync Now', 'syncAll')
    .addToUi()
}

function setupTrigger() {
  // Remove any existing syncAll triggers to avoid duplicates
  const triggers = ScriptApp.getProjectTriggers()
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncAll') {
      ScriptApp.deleteTrigger(triggers[i])
    }
  }

  ScriptApp.newTrigger('syncAll')
    .timeBased()
    .everyHours(1)
    .create()
}

/*
SETUP INSTRUCTIONS:
1. Create a new Google Sheet
2. Go to Extensions > Apps Script
3. Delete the default code
4. Paste this entire script
5. Replace PASTE_YOUR_SERVICE_ROLE_KEY_HERE with your Supabase
   service role key from .env.local (SUPABASE_SERVICE_ROLE_KEY)
6. Click Save
7. Run setupTrigger() once (select it from the function dropdown,
   click Run) — this sets up hourly auto-refresh
8. Run syncAll() to do the first sync
9. Grant the permissions it asks for (needs external URL access)
10. The sheet will now auto-refresh every hour and you can manually
    sync anytime via the Dilly Intel menu

TABS CREATED:
- Entities: all intel_entities sorted by portfolio size
- Agent Runs: recent agent run history
- Sources: record counts grouped by source_detail + entity_type
- Coverage Map: entity counts grouped by hq_state

Add your own tabs for notes — the script only writes to its own tabs.
*/
