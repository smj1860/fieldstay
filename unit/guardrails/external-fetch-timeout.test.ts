import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// External fetch() timeout guardrail.
//
// A fetch() with no AbortSignal has NO timeout of its own. It hangs until the
// platform kills the whole function — which on a user-facing path means the
// user watches a save spin until Vercel's function timeout fires, and inside
// an Inngest step means the step burns its entire execution budget without
// ever producing a retryable error.
//
// The 2026-07-30 pre-launch audit found only three AbortSignal call sites in
// the entire repo. The worst offender was lib/geocoding.ts's Mapbox call,
// which runs synchronously inside createProperty/updateProperty. It, plus
// Tomorrow.io, Telnyx and Kroger, now carry per-service budgets from
// lib/http/timeout.ts.
//
// This is a clean-baseline ratchet, same model as tailwind-color-ratchet:
// the call sites that predate the rule are listed in BASELINE, new ones are
// forbidden outright, and a baselined file that gets fixed must leave the
// list. Never add entries — fix the call site instead.
//
// Scope: outbound calls only. A fetch to a relative path ('/api/...') is a
// same-origin call from the browser and a different problem; wrappers
// (safeFetch, adminFetch, krogerFetch, hospitableFetch) are not matched by
// name — what matters is whether the raw fetch() they wrap is bounded.
// ============================================================================

// Bare `fetch(` only: the negative lookbehind keeps safeFetch/adminFetch/
// krogerFetch/hospitableFetch/prefetch and `foo.fetch(` from matching.
const FETCH_CALL = /(?<![\w$.])fetch\s*\(/g

function callArgsText(src: string, openParenIdx: number): string {
  let depth = 0
  for (let i = openParenIdx; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return src.slice(openParenIdx + 1, i)
    }
  }
  return src.slice(openParenIdx + 1)
}

/** A relative-path first argument means same-origin, not an external service. */
function isRelativeUrl(args: string): boolean {
  return /^\s*['"`]\//.test(args)
}

/**
 * Blanks out comments so prose ABOUT fetch() ("never hand this to a bare
 * fetch()") isn't mistaken for a call. Replaced with spaces rather than
 * removed so byte offsets — and therefore the reported positions — stay true.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length))
}

function findOffenders(): string[] {
  const offenders: string[] = []
  for (const file of collectSourceFiles(['lib'])) {
    const src = stripComments(read(file))
    FETCH_CALL.lastIndex = 0
    while (FETCH_CALL.exec(src) !== null) {
      const args = callArgsText(src, FETCH_CALL.lastIndex - 1)
      if (isRelativeUrl(args)) continue
      // `signal:` anywhere in the init object counts — either a literal
      // AbortSignal.timeout(...) or one threaded through from the caller.
      if (/\bsignal\s*:/.test(args)) continue
      offenders.push(rel(file))
      break   // one entry per file — the baseline is keyed by file
    }
  }
  return offenders.sort()
}

// Snapshot taken 2026-07-30, immediately after the four audit call sites
// (geocoding, weather/tomorrow, sms/telnyx, kroger/client) were fixed.
// SHRINK-ONLY: fixing a file means deleting its line here.
const BASELINE: Record<string, string> = {
  // The four PMS provider clients (hospitable, hospitable-token, hostaway,
  // ownerrez) are GONE from this list: every raw fetch in them now carries
  // PMS_API_TIMEOUT_MS. hospitableFetch() was the one that mattered most —
  // the single wrapper every Hospitable API call goes through, with
  // hospIncrementalSync running at concurrency [{limit: 8}], so eight hung
  // requests consumed the whole budget and stalled all webhook processing.
  // The chokepoint that exists so one place needs a timeout was the one place
  // without it.
  'lib/supabase/server.ts':
    "adminFetch() is a thin pass-through to the Supabase Admin REST API and forwards init verbatim; its callers supply the signal (see resolveUserEmails in lib/inngest/helpers.ts), which is why the raw call here carries none.",
}


describe('guardrail: outbound fetch() in lib/** carries a timeout', () => {
  const offenders = findOffenders()

  it('sanity: the scan finds fetch call sites at all', () => {
    // Guards against the regex silently matching nothing after a refactor.
    expect(Object.keys(BASELINE).length).toBeGreaterThan(0)
    expect(offenders.length).toBeGreaterThan(0)
  })

  it('no NEW untimed outbound fetch()', () => {
    const added = offenders.filter((f) => !(f in BASELINE))
    expect(
      added,
      `These files issue an outbound fetch() with no AbortSignal, so the call can
hang until the platform kills the function.

Add a per-service budget from lib/http/timeout.ts:

    const res = await fetch(url, { signal: AbortSignal.timeout(MY_TIMEOUT_MS) })

and handle the timeout distinctly — isTimeoutError(err) tells "we gave up
waiting" apart from "the service returned a failure". Do NOT add an entry to
BASELINE; it only shrinks.

Offenders:\n${added.join('\n')}`,
    ).toEqual([])
  })

  it('BASELINE only shrinks — fixed files must be removed from it', () => {
    const fixed = Object.keys(BASELINE).filter((f) => !offenders.includes(f))
    expect(
      fixed,
      `These files no longer have an untimed fetch(). Delete their BASELINE
entries so the ratchet keeps tightening:\n${fixed.join('\n')}`,
    ).toEqual([])
  })
})
