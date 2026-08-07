import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// Every fetch() in the crew outbox drain must carry an AbortSignal.
//
// unit/guardrails/external-fetch-timeout.test.ts and the semgrep chokepoint
// both scope themselves to EXTERNAL hosts (a literal https:// URL), so these
// six same-origin Route Handler calls were invisible to both. Same-origin is
// not the same as fast: a captive portal, a cell handoff, or a black-holing
// proxy accepts the connection and never answers, and navigator.onLine stays
// true throughout.
//
// In this loop a hang is not slow, it is PERMANENT:
//
//   pushOne() awaits uploadOne() → the fetch never settles → drain() never
//   returns → withTabLock() never returns → processOutbox()'s try never
//   reaches its finally → `isProcessing` stays true for the life of the page.
//
// Every later processOutbox() — the 30s interval, the `online` event, the kick
// enqueueMutation() fires, the bounded flush at logout — then hits
// `if (this.isProcessing) { redrainRequested = true; return }` and does
// nothing at all. The crew member's queue never moves again.
//
// It is invisible while it happens: STALLED_NETWORK_ATTEMPTS counts FAILED
// transport attempts, and a hang never fails, so networkRetryCount never
// increments. FailedSyncBanner filters on `failed`, which is never set.
//
// One of the seven fetches in this file already had the signal, with a comment
// saying "No AbortSignal meant no timeout at all: the request could hang". The
// hazard was understood and fixed once. This is the check that makes the other
// six stay fixed.
// ============================================================================

const FILES = ['lib/dexie/syncService.ts', 'lib/dexie/photo-sync.ts', 'lib/dexie/outboxEngine.ts']

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Each `fetch(` call with its argument list, brace/paren-matched. */
function fetchCalls(src: string): { index: number; text: string }[] {
  const calls: { index: number; text: string }[] = []
  for (const m of src.matchAll(/\bfetch\s*\(/g)) {
    let depth = 0
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') {
        depth--
        if (depth === 0) { calls.push({ index: m.index, text: src.slice(m.index, i + 1) }); break }
      }
    }
  }
  return calls
}

describe('guardrail: every crew-outbox fetch can time out', () => {
  it.each(FILES)('%s has no fetch without an AbortSignal', (file) => {
    const src = stripComments(readFileSync(join(process.cwd(), file), 'utf8'))
    const offenders = fetchCalls(src)
      .filter((c) => !/\bsignal\s*:/.test(c.text))
      .map((c) => `${file}:${src.slice(0, c.index).split('\n').length}`)

    expect(
      offenders,
      'A fetch() with no AbortSignal cannot time out. Inside the outbox drain ' +
      'that is not a slow request, it is a permanently wedged queue: the hang ' +
      'holds `isProcessing` true forever, so every later drain returns ' +
      'immediately and the crew member\'s work stops syncing with nothing in ' +
      'the failed-sync banner (a hang never sets `failed`). Add ' +
      'signal: AbortSignal.timeout(CREW_OUTBOX_TIMEOUT_MS).',
    ).toEqual([])
  })

  // Guards the guard: a paren-matcher that silently found nothing would make
  // the assertion above pass over a file full of bare fetches.
  it('finds the fetch calls it claims to check', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'lib/dexie/syncService.ts'), 'utf8'))
    const calls = fetchCalls(src)
    expect(calls.length, 'expected the outbox to still post to Route Handlers').toBeGreaterThanOrEqual(6)
    expect(calls.every((c) => /\bsignal\s*:/.test(c.text))).toBe(true)
  })
})
