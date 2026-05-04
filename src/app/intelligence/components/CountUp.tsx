"use client"

import { useEffect, useRef, useState } from "react"

type Props = {
  value: number
  duration?: number
  format?: (n: number) => string
  className?: string
}

export function CountUp({ value, duration = 800, format, className }: Props) {
  const [display, setDisplay] = useState(value)
  const fromRef = useRef(0)
  const startedRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    fromRef.current = display
    startedRef.current = null
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)

    const target = value
    const from = fromRef.current
    if (from === target) {
      setDisplay(target)
      return
    }

    const tick = (ts: number) => {
      if (startedRef.current == null) startedRef.current = ts
      const elapsed = ts - startedRef.current
      const t = Math.min(1, elapsed / duration)
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3)
      const current = from + (target - from) * eased
      setDisplay(current)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        setDisplay(target)
      }
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration])

  const rendered = format ? format(display) : Math.round(display).toLocaleString()
  return <span className={className}>{rendered}</span>
}
