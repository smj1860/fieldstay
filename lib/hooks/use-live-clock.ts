'use client'

import { useEffect, useState } from 'react'

// Ticks every second and returns the current time formatted for display
// (e.g. "2:45 PM"). Extracted from DashboardShell's top-bar clock.
export function useLiveClock(): string {
  const [time, setTime] = useState('')

  useEffect(() => {
    const tick = () => {
      setTime(new Date().toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
      }))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  return time
}
