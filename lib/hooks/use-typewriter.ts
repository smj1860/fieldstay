'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type TypewriterPhase = 'idle' | 'thinking' | 'typing' | 'done'

interface UseTypewriterOptions {
  thinkingDelayMs?: number
  chunkSize?:       number
  tickDelayMs?:     number
}

// Simulates an LLM "thinking, then streaming a response" effect: a fixed
// delay (phase 'thinking'), then the text reveals chunkSize characters at a
// time every tickDelayMs (phase 'typing'), ending at phase 'done'. Extracted
// from RepuGuardSandbox, which uses it to animate its canned demo responses.
export function useTypewriter(options?: UseTypewriterOptions) {
  const [phase, setPhase]         = useState<TypewriterPhase>('idle')
  const [displayed, setDisplayed] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const indexRef = useRef(0)

  const thinkingDelayMs = options?.thinkingDelayMs ?? 1800
  const chunkSize       = options?.chunkSize       ?? 4
  const tickDelayMs     = options?.tickDelayMs     ?? 18

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const start = useCallback((fullText: string, onDone?: () => void) => {
    clear()
    setPhase('thinking')
    setDisplayed('')
    indexRef.current = 0

    timerRef.current = setTimeout(() => {
      setPhase('typing')

      const tick = () => {
        indexRef.current += chunkSize
        const next = fullText.slice(0, indexRef.current)
        setDisplayed(next)
        if (indexRef.current < fullText.length) {
          timerRef.current = setTimeout(tick, tickDelayMs)
        } else {
          setDisplayed(fullText)
          setPhase('done')
          onDone?.()
        }
      }
      tick()
    }, thinkingDelayMs)
  }, [clear, thinkingDelayMs, chunkSize, tickDelayMs])

  useEffect(() => clear, [clear])

  return { phase, displayed, start }
}
