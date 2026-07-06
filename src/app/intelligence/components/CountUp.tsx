"use client"

import { useEffect, useRef, useState } from "react"

type Props = {
  value: number
  duration?: number
  format?: (n: number) => string
  className?: string
}

/**
 * Animated number that tweens to `value` on change.
 *
 * Each animation generation keeps its requestAnimationFrame id and start
 * timestamp in effect-LOCAL variables — never shared refs. The previous
 * version stored both in component refs, so when a filter change started
 * a new tween before the old one's frame was cancelled, the two tick
 * loops clobbered each other's shared start time and neither ever
 * reached `t = 1`. The number froze partway (e.g. showing 8,485 on an
 * 11,230 → 2,636 change). `displayRef` mirrors the on-screen value so a
 * mid-flight retarget tweens from the real current number.
 */
export function CountUp({ value, duration = 800, format, className }: Props) {
  const [display, setDisplay] = useState(value)
  const displayRef = useRef(value)

  useEffect(() => {
    const from = displayRef.current
    const target = value
    if (from === target) return

    // Effect-local — a new generation can't be corrupted by a stale
    // tick from a previous one, and cleanup cancels exactly this raf.
    let rafId = 0
    let start: number | null = null

    const tick = (ts: number) => {
      if (start === null) start = ts
      const t = Math.min(1, (ts - start) / duration)
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3)
      const next = t >= 1 ? target : from + (target - from) * eased
      displayRef.current = next
      setDisplay(next)
      if (t < 1) rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(rafId)
  }, [value, duration])

  const rendered = format
    ? format(display)
    : Math.round(display).toLocaleString()
  return <span className={className}>{rendered}</span>
}
