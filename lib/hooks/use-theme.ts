'use client'

import { useCallback, useSyncExternalStore } from 'react'

type Theme = 'dark' | 'light'

// Module-level so every useTheme() call site shares one source of truth —
// toggling in one component should be reflected everywhere else that reads it.
const listeners = new Set<() => void>()

function getSnapshot(): Theme {
  try {
    return localStorage.getItem('fs-theme') === 'light' ? 'light' : 'dark'
  } catch {
    // localStorage unavailable (private browsing, etc.) — default to dark, no crash.
    return 'dark'
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => 'dark' as Theme)

  const toggle = useCallback(() => {
    const next: Theme = getSnapshot() === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem('fs-theme', next)
    } catch {
      // Non-fatal — theme just won't persist across reloads this session.
    }
    document.documentElement.classList.toggle('light', next === 'light')
    listeners.forEach((l) => l())
  }, [])

  return { theme, toggle }
}
