import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

export async function GET() {
  const db = createAdminClient()

  // Supabase JS doesn't support GROUP BY directly, use RPC or raw
  // Fetch all prospects source_detail + confidence and aggregate client-side
  // For large tables we'd use a DB function, but this works for ops monitoring
  const { data, error } = await db
    .from("intel_prospects")
    .select("source_detail, confidence_score")

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const groups: Record<string, { count: number; totalConf: number }> = {}
  for (const row of data || []) {
    const src = row.source_detail || "unknown"
    if (!groups[src]) groups[src] = { count: 0, totalConf: 0 }
    groups[src].count++
    groups[src].totalConf += row.confidence_score || 0
  }

  const result = Object.entries(groups)
    .map(([source, { count, totalConf }]) => ({
      source_detail: source,
      count,
      avg_confidence: count > 0 ? Math.round(totalConf / count) : 0,
    }))
    .sort((a, b) => b.count - a.count)

  return NextResponse.json(result)
}
