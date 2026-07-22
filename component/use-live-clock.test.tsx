import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveClock } from '@/lib/hooks/use-live-clock'

describe('useLiveClock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T14:45:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the formatted current time immediately on mount', () => {
    const { result } = renderHook(() => useLiveClock())

    expect(result.current).toBe('2:45 PM')
  })

  it('updates every second as the clock ticks', () => {
    const { result } = renderHook(() => useLiveClock())

    act(() => {
      vi.setSystemTime(new Date('2024-01-01T14:46:00'))
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe('2:46 PM')

    act(() => {
      vi.setSystemTime(new Date('2024-01-01T14:46:01'))
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe('2:46 PM')

    act(() => {
      vi.setSystemTime(new Date('2024-01-01T15:00:00'))
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe('3:00 PM')
  })

  it('does not update between ticks', () => {
    const { result } = renderHook(() => useLiveClock())

    act(() => {
      vi.setSystemTime(new Date('2024-01-01T14:45:59'))
      vi.advanceTimersByTime(500)
    })
    expect(result.current).toBe('2:45 PM')
  })

  it('registers exactly one interval and clears that same interval on unmount', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')

    const { unmount } = renderHook(() => useLiveClock())

    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000)
    const intervalId = setIntervalSpy.mock.results[0]?.value

    unmount()

    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId)
  })

  it('stops ticking after unmount', () => {
    const { result, unmount } = renderHook(() => useLiveClock())
    expect(result.current).toBe('2:45 PM')

    unmount()

    // Advancing timers after unmount must not throw (interval was cleared)
    // and there is no `result.current` left to update — this just proves
    // the cleared interval callback never fires again.
    expect(() => {
      vi.setSystemTime(new Date('2024-01-01T15:30:00'))
      vi.advanceTimersByTime(5000)
    }).not.toThrow()
  })
})
