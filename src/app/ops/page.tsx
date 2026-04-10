"use client"

import { useState, useEffect, useCallback } from "react"

type Stats = {
  properties: number
  entities: number
  contacts: number
  prospects: number
  lastUpdated: string | null
}

type Agent = {
  agent_name: string
  display_name: string
  description: string
  schedule: string
  enabled: boolean
  last_run_at: string | null
  last_run_status: string | null
  total_runs: number
  total_found: number
  total_inserted: number
}

type Run = {
  id: string
  agent_name: string
  run_type: string
  status: string
  started_at: string
  completed_at: string | null
  records_found: number
  records_added: number
  records_skipped: number
  error_message: string | null
}

type SourceStat = {
  source_detail: string
  count: number
  avg_confidence: number
}

const RECORD_TABS = ["properties", "entities", "contacts", "prospects"] as const
type RecordTab = (typeof RECORD_TABS)[number]

export default function OpsPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [records, setRecords] = useState<any[]>([])
  const [recordTab, setRecordTab] = useState<RecordTab>("properties")
  const [sources, setSources] = useState<SourceStat[]>([])
  const [triggerStatus, setTriggerStatus] = useState<Record<string, string>>({})

  const fetchStats = useCallback(() => {
    fetch("/api/ops/stats").then((r) => r.json()).then((d) => { if (d && !d.error) setStats(d) }).catch(() => {})
  }, [])

  const fetchAgents = useCallback(() => {
    fetch("/api/ops/agents").then((r) => r.json()).then((d) => { if (Array.isArray(d)) setAgents(d) }).catch(() => {})
  }, [])

  const fetchRuns = useCallback(() => {
    fetch("/api/ops/runs").then((r) => r.json()).then((d) => { if (Array.isArray(d)) setRuns(d) }).catch(() => {})
  }, [])

  const fetchRecords = useCallback(() => {
    fetch(`/api/ops/records?tab=${recordTab}`).then((r) => r.json()).then((d) => { if (Array.isArray(d)) setRecords(d) }).catch(() => {})
  }, [recordTab])

  const fetchSources = useCallback(() => {
    fetch("/api/ops/sources").then((r) => r.json()).then((d) => { if (Array.isArray(d)) setSources(d) }).catch(() => {})
  }, [])

  // Initial load
  useEffect(() => { fetchStats(); fetchAgents(); fetchRuns(); fetchSources() }, [fetchStats, fetchAgents, fetchRuns, fetchSources])
  useEffect(() => { fetchRecords() }, [fetchRecords])

  // Auto-refresh stats every 60s, runs every 30s
  useEffect(() => {
    const s = setInterval(fetchStats, 60000)
    const r = setInterval(() => { fetchRuns(); fetchAgents() }, 30000)
    return () => { clearInterval(s); clearInterval(r) }
  }, [fetchStats, fetchRuns, fetchAgents])

  async function toggleAgent(agent_name: string, enabled: boolean) {
    await fetch("/api/ops/agents", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_name, enabled }),
    })
    fetchAgents()
  }

  async function triggerAgent(agent_name: string) {
    setTriggerStatus((s) => ({ ...s, [agent_name]: "sending..." }))
    const res = await fetch("/api/ops/agents/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_name }),
    })
    setTriggerStatus((s) => ({
      ...s,
      [agent_name]: res.ok ? "sent" : "failed",
    }))
    setTimeout(() => setTriggerStatus((s) => ({ ...s, [agent_name]: "" })), 3000)
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-bold text-white">dilly intel ops</h1>
          <span className="text-muted text-xs">agent control & database monitor</span>
        </div>
        {stats?.lastUpdated && (
          <span className="text-muted text-xs">
            last record: {fmtTime(stats.lastUpdated)}
          </span>
        )}
      </div>

      {/* SECTION 1 — Database Stats */}
      <section>
        <SectionHeader title="database" />
        <div className="grid grid-cols-4 gap-3">
          <StatBox label="properties" value={stats?.properties} />
          <StatBox label="entities" value={stats?.entities} />
          <StatBox label="contacts" value={stats?.contacts} />
          <StatBox label="prospects" value={stats?.prospects} />
        </div>
      </section>

      {/* SECTION 2 — Agent Control */}
      <section>
        <SectionHeader title="agents" />
        <div className="border border-border rounded overflow-hidden">
          <table>
            <thead>
              <tr>
                <th>agent</th>
                <th>status</th>
                <th>schedule</th>
                <th>last run</th>
                <th>result</th>
                <th className="text-right">found</th>
                <th className="text-right">added</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.agent_name}>
                  <td>
                    <span className="text-white">{a.display_name}</span>
                    <br />
                    <span className="text-muted text-xs">{a.agent_name}</span>
                  </td>
                  <td>
                    <button
                      onClick={() => toggleAgent(a.agent_name, !a.enabled)}
                      className={`text-xs px-2 py-0.5 rounded ${
                        a.enabled
                          ? "bg-green-900/40 text-green-400"
                          : "bg-zinc-800 text-muted"
                      }`}
                    >
                      {a.enabled ? "enabled" : "disabled"}
                    </button>
                  </td>
                  <td className="text-muted text-xs font-mono">{a.schedule || "—"}</td>
                  <td className="text-xs">{a.last_run_at ? fmtTime(a.last_run_at) : "—"}</td>
                  <td>
                    <StatusBadge status={a.last_run_status} />
                  </td>
                  <td className="text-right tabular-nums">{a.total_found.toLocaleString()}</td>
                  <td className="text-right tabular-nums">{a.total_inserted.toLocaleString()}</td>
                  <td className="text-right">
                    {triggerStatus[a.agent_name] ? (
                      <span className={`text-xs ${triggerStatus[a.agent_name] === "sent" ? "text-green-400" : triggerStatus[a.agent_name] === "failed" ? "text-red-400" : "text-muted"}`}>
                        {triggerStatus[a.agent_name]}
                      </span>
                    ) : (
                      <button
                        onClick={() => triggerAgent(a.agent_name)}
                        className="text-xs text-accent hover:text-accent-hover"
                      >
                        run now
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {agents.length === 0 && (
                <tr><td colSpan={8} className="text-muted text-center py-4">no agents registered</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* SECTION 3 — Recent Runs */}
      <section>
        <SectionHeader title="recent runs" />
        <div className="border border-border rounded overflow-hidden">
          <table>
            <thead>
              <tr>
                <th>agent</th>
                <th>started</th>
                <th>duration</th>
                <th className="text-right">found</th>
                <th className="text-right">added</th>
                <th className="text-right">skipped</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="text-white">{r.agent_name}</td>
                  <td className="text-xs">{fmtTime(r.started_at)}</td>
                  <td className="text-xs tabular-nums">{fmtDuration(r.started_at, r.completed_at)}</td>
                  <td className="text-right tabular-nums">{r.records_found}</td>
                  <td className="text-right tabular-nums">{r.records_added}</td>
                  <td className="text-right tabular-nums">{r.records_skipped}</td>
                  <td><StatusBadge status={r.status} /></td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr><td colSpan={7} className="text-muted text-center py-4">no runs yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* SECTION 4 — Recent Records */}
      <section>
        <SectionHeader title="recent records" />
        <div className="flex gap-1 mb-2">
          {RECORD_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setRecordTab(tab)}
              className={`text-xs px-3 py-1 rounded ${
                recordTab === tab
                  ? "bg-accent text-white"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
        <div className="border border-border rounded overflow-x-auto">
          <table>
            <thead>
              <tr>
                {records.length > 0 &&
                  Object.keys(records[0])
                    .filter((k) => k !== "id")
                    .map((k) => <th key={k}>{k}</th>)}
              </tr>
            </thead>
            <tbody>
              {records.map((r: any) => (
                <tr key={r.id}>
                  {Object.entries(r)
                    .filter(([k]) => k !== "id")
                    .map(([k, v]) => (
                      <td key={k} className="text-xs max-w-[200px] truncate">
                        {k === "created_at" ? fmtTime(v as string) : String(v ?? "—")}
                      </td>
                    ))}
                </tr>
              ))}
              {records.length === 0 && (
                <tr><td colSpan={10} className="text-muted text-center py-4">no records</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* SECTION 5 — Source Stats */}
      <section>
        <SectionHeader title="records by source" />
        <div className="border border-border rounded overflow-hidden">
          <table>
            <thead>
              <tr>
                <th>source_detail</th>
                <th className="text-right">count</th>
                <th className="text-right">avg_confidence</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.source_detail}>
                  <td className="text-white">{s.source_detail}</td>
                  <td className="text-right tabular-nums">{s.count.toLocaleString()}</td>
                  <td className="text-right tabular-nums">{s.avg_confidence}</td>
                </tr>
              ))}
              {sources.length === 0 && (
                <tr><td colSpan={3} className="text-muted text-center py-4">no prospect data yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="text-xs text-muted uppercase tracking-widest mb-2">
      {title}
    </h2>
  )
}

function StatBox({ label, value }: { label: string; value?: number }) {
  return (
    <div className="bg-surface border border-border rounded p-4">
      <div className="text-2xl font-bold text-white tabular-nums">
        {value != null ? value.toLocaleString() : "—"}
      </div>
      <div className="text-muted text-xs mt-1">{label}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-muted text-xs">—</span>
  const colors: Record<string, string> = {
    success: "text-green-400",
    completed: "text-green-400",
    running: "text-yellow-400",
    error: "text-red-400",
    failed: "text-red-400",
  }
  return (
    <span className={`text-xs ${colors[status] || "text-muted"}`}>
      {status}
    </span>
  )
}

function fmtTime(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
  } catch {
    return ts
  }
}

function fmtDuration(start: string, end: string | null): string {
  if (!end) return "running..."
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}
