import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTheme } from '@/lib/hooks/use-theme'

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('light')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    document.documentElement.classList.remove('light')
  })

  it('defaults to dark when nothing is persisted', () => {
    const { result } = renderHook(() => useTheme())

    expect(result.current.theme).toBe('dark')
  })

  it('reads a persisted light theme on mount', () => {
    localStorage.setItem('fs-theme', 'light')

    const { result } = renderHook(() => useTheme())

    expect(result.current.theme).toBe('light')
  })

  it('treats any non-"light" stored value as dark', () => {
    localStorage.setItem('fs-theme', 'sepia')

    const { result } = renderHook(() => useTheme())

    expect(result.current.theme).toBe('dark')
  })

  it('toggle() switches dark -> light, persists it, and stamps the documentElement class', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('dark')

    act(() => {
      result.current.toggle()
    })

    expect(result.current.theme).toBe('light')
    expect(localStorage.getItem('fs-theme')).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })

  it('toggle() switches light -> dark, persists it, and removes the documentElement class', () => {
    localStorage.setItem('fs-theme', 'light')
    document.documentElement.classList.add('light')

    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('light')

    act(() => {
      result.current.toggle()
    })

    expect(result.current.theme).toBe('dark')
    expect(localStorage.getItem('fs-theme')).toBe('dark')
    expect(document.documentElement.classList.contains('light')).toBe(false)
  })

  it('persists across an unmount + fresh remount', () => {
    const { result, unmount } = renderHook(() => useTheme())
    act(() => {
      result.current.toggle()
    })
    expect(result.current.theme).toBe('light')
    unmount()

    const { result: result2 } = renderHook(() => useTheme())
    expect(result2.current.theme).toBe('light')
  })

  it('keeps every mounted instance in sync when one toggles (module-level listener fan-out)', () => {
    const { result: a } = renderHook(() => useTheme())
    const { result: b } = renderHook(() => useTheme())

    expect(a.current.theme).toBe('dark')
    expect(b.current.theme).toBe('dark')

    act(() => {
      a.current.toggle()
    })

    expect(a.current.theme).toBe('light')
    expect(b.current.theme).toBe('light')
  })

  it('unsubscribes on unmount without breaking the remaining subscribers (no leaked listener)', () => {
    const { result: a, unmount: unmountA } = renderHook(() => useTheme())
    const { result: b } = renderHook(() => useTheme())

    unmountA()

    expect(() => {
      act(() => {
        b.current.toggle()
      })
    }).not.toThrow()
    expect(b.current.theme).toBe('light')
    // `a` is unmounted so its `result.current` is frozen at the last render
    // before unmount — it must not have been mutated by b's toggle.
    expect(a.current.theme).toBe('dark')
  })

  it('does not throw when localStorage.getItem is unavailable and falls back to dark', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage disabled')
    })

    const { result } = renderHook(() => useTheme())

    expect(result.current.theme).toBe('dark')
  })

  it('does not throw when localStorage.setItem is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    const { result } = renderHook(() => useTheme())

    expect(() => {
      act(() => {
        result.current.toggle()
      })
    }).not.toThrow()
    // The DOM class still reflects the attempted toggle even though
    // persistence failed non-fatally.
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })
})
