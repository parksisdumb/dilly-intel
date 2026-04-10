"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

export default function LoginGate() {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError("")

    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })

    if (res.ok) {
      router.push("/ops")
    } else {
      setError("incorrect password")
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center">
      <form onSubmit={handleSubmit} className="w-72">
        <div className="text-muted text-xs uppercase tracking-widest mb-4">
          dilly intel ops
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          autoFocus
          className="w-full bg-surface border border-border rounded px-3 py-2 text-foreground placeholder-muted focus:border-accent focus:outline-none"
        />
        {error && (
          <div className="text-red-500 text-xs mt-2">{error}</div>
        )}
        <button
          type="submit"
          disabled={loading}
          className="mt-3 w-full bg-accent rounded px-3 py-2 text-white text-sm hover:bg-accent-hover disabled:opacity-50"
        >
          {loading ? "..." : "enter"}
        </button>
      </form>
    </div>
  )
}
