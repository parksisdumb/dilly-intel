"use client"

import { useState } from "react"
import { pushToDilly } from "./actions"

type Props = {
  icp: any
  stats: {
    propertyCount: number
    entityCount: number
    contactCount: number
    coverage: number
  }
  entities: any[]
  properties: any[]
  targetCities: string[]
}

export function DashboardClient({
  icp,
  stats,
  entities,
  properties,
  targetCities,
}: Props) {
  const [activeTab, setActiveTab] = useState<"owners" | "properties">(
    "owners"
  )
  const [slideOver, setSlideOver] = useState<{
    type: "entity" | "property"
    data: any
  } | null>(null)
  const [pushing, setPushing] = useState(false)
  const [toast, setToast] = useState("")

  const cityList = (icp.target_cities || []).join(", ")
  const isEmpty = stats.propertyCount === 0 && stats.entityCount === 0

  async function handlePush(type: "entity" | "property", data: any) {
    setPushing(true)
    const result = await pushToDilly(type, data)
    setPushing(false)

    if (result?.error) {
      setToast(`Error: ${result.error}`)
    } else {
      setToast("Pushed to Dilly!")
      setSlideOver(null)
    }

    setTimeout(() => setToast(""), 3000)
  }

  return (
    <div className="flex-1 overflow-auto">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 rounded-md px-4 py-2 text-sm font-medium shadow-lg ${
            toast.startsWith("Error")
              ? "bg-red-600 text-white"
              : "bg-green-600 text-white"
          }`}
        >
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="border-b border-gray-200 px-8 py-6">
        <h1 className="text-2xl font-bold text-gray-900">
          Your Market Intelligence
        </h1>
        <p className="text-gray-500 mt-1">
          Based on your ICP &mdash; {cityList || "All markets"}
        </p>
      </div>

      {isEmpty ? (
        <div className="px-8 py-16">
          <div className="mx-auto max-w-lg rounded-lg border border-gray-200 bg-gray-50 p-8 text-center">
            <h3 className="text-lg font-semibold text-gray-700">
              Building intelligence for {cityList || "your markets"}
            </h3>
            <p className="mt-2 text-gray-500">
              Our agents run weekly to discover commercial properties, ownership
              data, and decision maker contacts. Check back Monday.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-1 gap-4 px-8 py-6 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              value={stats.propertyCount.toLocaleString()}
              label="commercial properties identified"
            />
            <StatCard
              value={stats.entityCount.toLocaleString()}
              label="companies with territory presence"
            />
            <StatCard
              value={stats.contactCount.toLocaleString()}
              label="decision makers identified"
            />
            <StatCard
              value={`${stats.coverage}%`}
              label="ownership data coverage"
            />
          </div>

          <p className="px-8 text-xs text-gray-400 mb-6">
            Data updates weekly. Agents run automatically to discover new
            properties and contacts.
          </p>

          {/* Tabs */}
          <div className="px-8">
            <div className="flex gap-4 border-b border-gray-200">
              <button
                onClick={() => setActiveTab("owners")}
                className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "owners"
                    ? "border-accent text-accent"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Portfolio Owners ({entities.length})
              </button>
              <button
                onClick={() => setActiveTab("properties")}
                className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "properties"
                    ? "border-accent text-accent"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Properties ({properties.length})
              </button>
            </div>
          </div>

          {/* Tab content */}
          <div className="px-8 py-6">
            {activeTab === "owners" && (
              <div className="space-y-3">
                {entities.length === 0 && (
                  <p className="text-gray-400 text-center py-8">
                    No portfolio owners found yet for your territory.
                  </p>
                )}
                {entities.map((e: any) => (
                  <div
                    key={e.id}
                    className="rounded-lg border border-gray-200 bg-white p-4 hover:shadow-sm transition-shadow"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-semibold text-gray-900 text-lg">
                          {e.name}
                        </h3>
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          {e.entity_type && (
                            <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                              {e.entity_type}
                            </span>
                          )}
                          <span className="text-sm text-green-600 font-medium">
                            {e.territory_properties}{" "}
                            {e.territory_properties === 1
                              ? "property"
                              : "properties"}{" "}
                            in your territory
                          </span>
                          {e.total_properties && (
                            <span className="text-sm text-gray-400">
                              &middot; {e.total_properties} total nationally
                            </span>
                          )}
                        </div>
                        {e.hq_city && e.hq_state && (
                          <p className="text-sm text-gray-400 mt-1">
                            HQ: {e.hq_city}, {e.hq_state}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() =>
                          setSlideOver({ type: "entity", data: e })
                        }
                        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover transition-colors whitespace-nowrap"
                      >
                        View & Push
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeTab === "properties" && (
              <div className="space-y-3">
                {properties.length === 0 && (
                  <p className="text-gray-400 text-center py-8">
                    No properties found yet for your territory.
                  </p>
                )}
                {properties.map((p: any) => (
                  <div
                    key={p.id}
                    className="rounded-lg border border-gray-200 bg-white p-4 hover:shadow-sm transition-shadow"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-semibold text-gray-900">
                          {p.property_name ||
                            p.street_address ||
                            "Unknown address"}
                        </h3>
                        <p className="text-sm text-gray-500 mt-0.5">
                          {p.owner_name ||
                            p.intel_entities?.name ||
                            "Unknown owner"}
                          {p.city && ` \u00b7 ${p.city}, ${p.state}`}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-2">
                          {p.property_type && (
                            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                              {p.property_type}
                            </span>
                          )}
                          {p.sq_footage && (
                            <span className="text-xs text-gray-400">
                              {p.sq_footage.toLocaleString()} sq ft
                            </span>
                          )}
                          {p.roof_age_years && (
                            <span className="text-xs text-gray-400">
                              Roof: {p.roof_age_years} yrs
                            </span>
                          )}
                          {p.source_detail && (
                            <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                              {p.source_detail}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() =>
                          setSlideOver({ type: "property", data: p })
                        }
                        className="rounded-md border border-accent px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent hover:text-white transition-colors whitespace-nowrap"
                      >
                        + Add to Pipeline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Slide-over panel */}
      {slideOver && (
        <div className="fixed inset-0 z-40">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setSlideOver(null)}
          />
          <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-xl overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold text-gray-900">
                  {slideOver.type === "entity"
                    ? slideOver.data.name
                    : slideOver.data.property_name ||
                      slideOver.data.street_address}
                </h2>
                <button
                  onClick={() => setSlideOver(null)}
                  className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
                >
                  x
                </button>
              </div>

              {slideOver.type === "entity" && (
                <div className="space-y-4">
                  {slideOver.data.entity_type && (
                    <Detail label="Type" value={slideOver.data.entity_type} />
                  )}
                  {slideOver.data.legal_name && (
                    <Detail
                      label="Legal name"
                      value={slideOver.data.legal_name}
                    />
                  )}
                  <Detail
                    label="Territory properties"
                    value={slideOver.data.territory_properties}
                  />
                  {slideOver.data.total_properties && (
                    <Detail
                      label="Total properties"
                      value={slideOver.data.total_properties}
                    />
                  )}
                  {slideOver.data.hq_city && (
                    <Detail
                      label="HQ"
                      value={`${slideOver.data.hq_city}, ${slideOver.data.hq_state}`}
                    />
                  )}
                  {slideOver.data.website && (
                    <Detail label="Website" value={slideOver.data.website} />
                  )}
                  {slideOver.data.ticker && (
                    <Detail label="Ticker" value={slideOver.data.ticker} />
                  )}
                </div>
              )}

              {slideOver.type === "property" && (
                <div className="space-y-4">
                  {slideOver.data.street_address && (
                    <Detail
                      label="Address"
                      value={`${slideOver.data.street_address}, ${slideOver.data.city}, ${slideOver.data.state} ${slideOver.data.postal_code || ""}`}
                    />
                  )}
                  {slideOver.data.owner_name && (
                    <Detail label="Owner" value={slideOver.data.owner_name} />
                  )}
                  {slideOver.data.property_type && (
                    <Detail label="Type" value={slideOver.data.property_type} />
                  )}
                  {slideOver.data.sq_footage && (
                    <Detail
                      label="Size"
                      value={`${slideOver.data.sq_footage.toLocaleString()} sq ft`}
                    />
                  )}
                  {slideOver.data.year_built && (
                    <Detail label="Built" value={slideOver.data.year_built} />
                  )}
                  {slideOver.data.roof_type && (
                    <Detail
                      label="Roof type"
                      value={slideOver.data.roof_type}
                    />
                  )}
                  {slideOver.data.roof_age_years && (
                    <Detail
                      label="Roof age"
                      value={`${slideOver.data.roof_age_years} years`}
                    />
                  )}
                  {slideOver.data.assessed_value && (
                    <Detail
                      label="Assessed value"
                      value={`$${slideOver.data.assessed_value.toLocaleString()}`}
                    />
                  )}
                  {slideOver.data.source_detail && (
                    <Detail
                      label="Source"
                      value={slideOver.data.source_detail}
                    />
                  )}
                </div>
              )}

              <button
                onClick={() => handlePush(slideOver.type, slideOver.data)}
                disabled={pushing}
                className="mt-8 w-full rounded-md bg-accent px-4 py-3 font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors"
              >
                {pushing ? "Pushing..." : "Push to Dilly"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <p className="text-3xl font-bold text-gray-900">{value}</p>
      <p className="text-sm text-gray-500 mt-1">{label}</p>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
        {label}
      </span>
      <p className="text-gray-900 mt-0.5">{String(value)}</p>
    </div>
  )
}
