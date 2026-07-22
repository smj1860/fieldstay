import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypewriter } from '@/lib/hooks/use-typewriter'

describe('useTypewriter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts idle with no displayed text', () => {
    const { result } = renderHook(() => useTypewriter())

    expect(result.current.phase).toBe('idle')
    expect(result.current.displayed).toBe('')
  })

  it('walks thinking -> typing -> done, revealing chunkSize characters per tick', () => {
    const onDone = vi.fn()
    const { result } = renderHook(() =>
      useTypewriter({ thinkingDelayMs: 100, chunkSize: 3, tickDelayMs: 10 })
    )

    act(() => {
      result.current.start('hello world', onDone)
    })
    expect(result.current.phase).toBe('thinking')
    expect(result.current.displayed).toBe('')

    // Thinking delay elapses -> phase flips to typing and the first chunk
    // is revealed synchronously as part of that timeout callback.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current.phase).toBe('typing')
    expect(result.current.displayed).toBe('hel')

    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(result.current.displayed).toBe('hello ')

    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(result.current.displayed).toBe('hello wor')
    expect(result.current.phase).toBe('typing')

    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(result.current.displayed).toBe('hello world')
    expect(result.current.phase).toBe('done')
    expect(onDone).toHaveBeenCalledTimes(1)

    // No further timers pending — advancing more must not change anything.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.displayed).toBe('hello world')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('resets displayed text and re-enters thinking when start() is called again', () => {
    const { result } = renderHook(() =>
      useTypewriter({ thinkingDelayMs: 100, chunkSize: 4, tickDelayMs: 10 })
    )

    act(() => {
      result.current.start('first message')
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current.displayed).toBe('firs')
    expect(result.current.phase).toBe('typing')

    act(() => {
      result.current.start('second')
    })
    // Immediately re-enters thinking with the display cleared, discarding
    // whatever the previous run had revealed.
    expect(result.current.phase).toBe('thinking')
    expect(result.current.displayed).toBe('')

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current.displayed).toBe('seco')
  })

  it('cancels the pending timer from a previous run when start() is called again (no leaked timer)', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const onDoneFirst = vi.fn()
    const { result } = renderHook(() =>
      useTypewriter({ thinkingDelayMs: 100, chunkSize: 4, tickDelayMs: 10 })
    )

    act(() => {
      result.current.start('first message', onDoneFirst)
    })
    const callsBeforeRestart = clearTimeoutSpy.mock.calls.length
    act(() => {
      result.current.start('second')
    })
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsBeforeRestart)

    // Advancing time now only drives the *second* run — the first run's
    // onDone must never fire since it was abandoned.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onDoneFirst).not.toHaveBeenCalled()
    expect(result.current.displayed).toBe('second')
    expect(result.current.phase).toBe('done')
  })

  it('handles start() without an onDone callback', () => {
    const { result } = renderHook(() =>
      useTypewriter({ thinkingDelayMs: 10, chunkSize: 10, tickDelayMs: 10 })
    )

    act(() => {
      result.current.start('hi')
    })
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(50)
      })
    }).not.toThrow()
    expect(result.current.phase).toBe('done')
    expect(result.current.displayed).toBe('hi')
  })

  it('clears any pending timer on unmount', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { result, unmount } = renderHook(() =>
      useTypewriter({ thinkingDelayMs: 1000, chunkSize: 2, tickDelayMs: 10 })
    )

    act(() => {
      result.current.start('a long piece of text')
    })
    clearTimeoutSpy.mockClear()

    unmount()

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1)

    // The timer that was pending at unmount must never fire and mutate
    // state on the now-unmounted hook instance.
    expect(() => {
      vi.advanceTimersByTime(5000)
    }).not.toThrow()
  })

  it('applies default option values when none are passed', () => {
    const { result } = renderHook(() => useTypewriter())

    act(() => {
      result.current.start('hi')
    })
    expect(result.current.phase).toBe('thinking')

    // Default thinkingDelayMs is 1800ms
    act(() => {
      vi.advanceTimersByTime(1799)
    })
    expect(result.current.phase).toBe('thinking')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    // Default chunkSize is 4, which already covers all of 'hi' (length 2),
    // so the very first tick finishes the run in one step.
    expect(result.current.displayed).toBe('hi')
    expect(result.current.phase).toBe('done')
  })
})
