'use client'

import { useCallback, useEffect, useState } from 'react'

type Theme = 'dark' | 'light'

export function useTheme() {
  const [theme, setTheme] = useState<Theme>('dark')

  useEffect(() => {
    try {
      const stored = localStorage.getItem('fs-theme') as Theme | null
      if (stored === 'light') setTheme('light')
    } catch {
      // localStorage unavailable (private browsing, etc.) — default to dark, no crash.
    }
  }, [])

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem('fs-theme', next)
      } catch {
        // Non-fatal — theme just won't persist across reloads this session.
      }
      document.documentElement.classList.toggle('light', next === 'light')
      return next
    })
  }, [])

  return { theme, toggle }
}
