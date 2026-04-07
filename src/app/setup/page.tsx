"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { saveICP } from "./actions"

const STEPS = [
  "Markets",
  "Account Types",
  "Building Size",
  "Deal Size",
  "Roof Types",
  "Decision Makers",
  "Review",
]

const ACCOUNT_TYPES = [
  "Property Management Companies",
  "Building Owners (Direct)",
  "Facilities Management",
  "REITs / Institutional Investors",
  "General Contractors",
  "Corporate Campus Owners",
  "Government / Municipal",
  "Healthcare Facilities",
  "Industrial / Warehouse",
  "Retail Property Owners",
  "Self-Storage Operators",
  "Educational Institutions",
]

const BUILDING_SIZES = [
  { label: "No minimum", value: 0 },
  { label: "10,000+ sq ft", value: 10000 },
  { label: "25,000+ sq ft", value: 25000 },
  { label: "50,000+ sq ft", value: 50000 },
  { label: "100,000+ sq ft", value: 100000 },
]

const DEAL_SIZES = [
  { label: "Under $25K (repairs)", min: 0, max: 25000 },
  { label: "$25K - $100K", min: 25000, max: 100000 },
  { label: "$100K - $500K", min: 100000, max: 500000 },
  { label: "$500K+ (major projects)", min: 500000, max: 0 },
]

const ROOF_TYPES = [
  "TPO / Single-Ply",
  "EPDM",
  "Metal Roofing",
  "Built-Up (BUR)",
  "Modified Bitumen",
  "Spray Foam (SPF)",
  "All types",
]

const DECISION_MAKERS = [
  "Property Manager",
  "Facilities Director",
  "Asset Manager",
  "VP of Operations",
  "Director of Capital Projects",
  "Owner / Principal",
  "Building Engineer",
]

export default function SetupPage() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const [markets, setMarkets] = useState<string[]>([])
  const [marketInput, setMarketInput] = useState("")
  const [accountTypes, setAccountTypes] = useState<string[]>([])
  const [buildingSize, setBuildingSize] = useState(0)
  const [dealSizeIdx, setDealSizeIdx] = useState(0)
  const [roofTypes, setRoofTypes] = useState<string[]>([])
  const [decisionMakers, setDecisionMakers] = useState<string[]>([])

  function addMarket() {
    const trimmed = marketInput.trim()
    if (trimmed && !markets.includes(trimmed)) {
      setMarkets([...markets, trimmed])
      setMarketInput("")
    }
  }

  function removeMarket(m: string) {
    setMarkets(markets.filter((x) => x !== m))
  }

  function toggleChip(
    value: string,
    list: string[],
    setList: (v: string[]) => void
  ) {
    if (value === "All types") {
      setList(list.includes(value) ? [] : ["All types"])
      return
    }
    const filtered = list.filter((x) => x !== "All types")
    if (filtered.includes(value)) {
      setList(filtered.filter((x) => x !== value))
    } else {
      setList([...filtered, value])
    }
  }

  function canProceed() {
    if (step === 0) return markets.length > 0
    return true
  }

  async function handleSubmit() {
    setLoading(true)
    setError("")

    const cities: string[] = []
    const states: string[] = []

    markets.forEach((m) => {
      const parts = m.split(",").map((s) => s.trim())
      if (parts.length >= 2) {
        cities.push(parts[0])
        states.push(parts[1])
      } else {
        cities.push(parts[0])
      }
    })

    const dealSize = DEAL_SIZES[dealSizeIdx]

    const result = await saveICP({
      target_cities: cities,
      target_states: [...new Set(states)],
      target_metros: [],
      target_account_types: accountTypes,
      min_sq_footage: buildingSize || null,
      max_sq_footage: null,
      target_property_types: [],
      target_roof_types: roofTypes,
      min_deal_size: dealSize.min || null,
      max_deal_size: dealSize.max || null,
      target_decision_maker_titles: decisionMakers,
    })

    if (result?.error) {
      setError(result.error)
      setLoading(false)
      return
    }

    router.push("/dashboard")
  }

  return (
    <div className="min-h-full bg-[#0a0a0a] text-white">
      {/* Progress bar */}
      <div className="border-b border-zinc-800">
        <div className="mx-auto max-w-2xl px-6 py-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-zinc-500">
              Step {step + 1} of {STEPS.length}
            </span>
            <span className="text-sm text-zinc-500">{STEPS[step]}</span>
          </div>
          <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-300"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-6 py-12">
        {error && (
          <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-6">
            {error}
          </div>
        )}

        {/* STEP 0 — Markets */}
        {step === 0 && (
          <div>
            <h2 className="text-2xl font-bold mb-2">
              What markets do you serve?
            </h2>
            <p className="text-zinc-400 mb-6">
              Type a city and state, then press Enter.
            </p>

            <div className="flex gap-2 mb-4">
              <input
                value={marketInput}
                onChange={(e) => setMarketInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addMarket()
                  }
                }}
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-white placeholder-zinc-500 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="e.g. Memphis, TN"
              />
              <button
                onClick={addMarket}
                className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-600 transition-colors"
              >
                Add
              </button>
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
              {markets.map((m) => (
                <span
                  key={m}
                  className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 border border-accent/30 px-3 py-1 text-sm text-accent"
                >
                  {m}
                  <button
                    onClick={() => removeMarket(m)}
                    className="hover:text-white"
                  >
                    x
                  </button>
                </span>
              ))}
            </div>

            {markets.length === 0 && (
              <div className="flex flex-wrap gap-2">
                {["Memphis, TN", "Nashville, TN", "Dallas, TX"].map((ex) => (
                  <span
                    key={ex}
                    className="rounded-full bg-zinc-800 border border-zinc-700 px-3 py-1 text-sm text-zinc-500"
                  >
                    {ex}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* STEP 1 — Account types */}
        {step === 1 && (
          <div>
            <h2 className="text-2xl font-bold mb-2">
              What types of companies do you target?
            </h2>
            <p className="text-zinc-400 mb-6">Select all that apply.</p>
            <div className="flex flex-wrap gap-2">
              {ACCOUNT_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() =>
                    toggleChip(t, accountTypes, setAccountTypes)
                  }
                  className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                    accountTypes.includes(t)
                      ? "bg-accent border-accent text-white"
                      : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* STEP 2 — Building size */}
        {step === 2 && (
          <div>
            <h2 className="text-2xl font-bold mb-2">
              Minimum building size you target?
            </h2>
            <div className="space-y-3 mt-6">
              {BUILDING_SIZES.map((s) => (
                <label
                  key={s.value}
                  className="flex items-center gap-3 cursor-pointer"
                >
                  <input
                    type="radio"
                    name="buildingSize"
                    checked={buildingSize === s.value}
                    onChange={() => setBuildingSize(s.value)}
                    className="h-4 w-4 accent-[#E8620A]"
                  />
                  <span className="text-zinc-200">{s.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* STEP 3 — Deal size */}
        {step === 3 && (
          <div>
            <h2 className="text-2xl font-bold mb-2">Typical deal size?</h2>
            <div className="space-y-3 mt-6">
              {DEAL_SIZES.map((s, i) => (
                <label
                  key={i}
                  className="flex items-center gap-3 cursor-pointer"
                >
                  <input
                    type="radio"
                    name="dealSize"
                    checked={dealSizeIdx === i}
                    onChange={() => setDealSizeIdx(i)}
                    className="h-4 w-4 accent-[#E8620A]"
                  />
                  <span className="text-zinc-200">{s.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* STEP 4 — Roof types */}
        {step === 4 && (
          <div>
            <h2 className="text-2xl font-bold mb-2">
              Roof types you specialize in?
            </h2>
            <p className="text-zinc-400 mb-6">Select all that apply.</p>
            <div className="flex flex-wrap gap-2">
              {ROOF_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => toggleChip(t, roofTypes, setRoofTypes)}
                  className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                    roofTypes.includes(t)
                      ? "bg-accent border-accent text-white"
                      : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* STEP 5 — Decision makers */}
        {step === 5 && (
          <div>
            <h2 className="text-2xl font-bold mb-2">
              Who approves roofing work?
            </h2>
            <p className="text-zinc-400 mb-6">
              Select the titles you typically sell to.
            </p>
            <div className="flex flex-wrap gap-2">
              {DECISION_MAKERS.map((t) => (
                <button
                  key={t}
                  onClick={() =>
                    toggleChip(t, decisionMakers, setDecisionMakers)
                  }
                  className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                    decisionMakers.includes(t)
                      ? "bg-accent border-accent text-white"
                      : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* STEP 6 — Review */}
        {step === 6 && (
          <div>
            <h2 className="text-2xl font-bold mb-6">Review your targeting</h2>
            <div className="space-y-4">
              <ReviewRow label="Your markets" value={markets.join(", ")} />
              <ReviewRow label="Targeting" value={accountTypes.join(", ")} />
              <ReviewRow
                label="Building size"
                value={
                  BUILDING_SIZES.find((s) => s.value === buildingSize)?.label ||
                  "—"
                }
              />
              <ReviewRow
                label="Deal size"
                value={DEAL_SIZES[dealSizeIdx]?.label || "—"}
              />
              <ReviewRow label="Roof types" value={roofTypes.join(", ")} />
              <ReviewRow
                label="Decision makers"
                value={decisionMakers.join(", ")}
              />
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between mt-12">
          <button
            onClick={() => setStep(step - 1)}
            className={`rounded-md px-6 py-2 text-sm font-medium transition-colors ${
              step === 0
                ? "invisible"
                : "text-zinc-400 hover:text-white"
            }`}
          >
            Back
          </button>

          {step < 6 ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={!canProceed()}
              className="rounded-md bg-accent px-6 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-30 transition-colors"
            >
              Next
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={loading}
              className="rounded-md bg-accent px-8 py-3 text-base font-bold text-white hover:bg-accent-hover disabled:opacity-50 transition-colors"
            >
              {loading ? "Saving..." : "See My Market"}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 p-4">
      <span className="text-sm text-zinc-500">{label}</span>
      <p className="text-white mt-1">{value || "—"}</p>
    </div>
  )
}
