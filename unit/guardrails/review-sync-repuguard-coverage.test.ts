import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// ============================================================================
// GUARDRAIL: every PMS review sync fires RepuGuard draft generation.
//
// THE DEFECT THIS ENCODES. Reviews land in `reviews` at
// response_status = 'pending'; nothing drafts a response until something
// fires `repuguard/batch_generate.requested`. Only Hospitable's WEBHOOK path
// ever did. So on 2026-08-16 three of the four review-writing paths were
// silently inert:
//
//   - Hostex (all three of its sync modes) — a whole provider with no drafts
//   - OwnerRez reviews sync — same
//   - Hospitable's historical backfill — a new customer's entire review
//     history imported with no drafts, which is the case automatic drafting
//     is worth the most for
//
// None of it looked broken. The reviews were there, the feature "worked" if
// you clicked Generate, and the only symptom was drafts that never appeared
// on their own.
//
// The check is structural rather than behavioural because the failure mode is
// an ABSENCE — no test fails when a new sync forgets to fire, since nothing
// it does is wrong. A file that writes reviews must also mention the event.
// ============================================================================

const INNGEST_FUNCTIONS = 'lib/inngest/functions'
const DRAFT_EVENT       = 'repuguard/batch_generate.requested'

/**
 * Writes to the `reviews` table. Matches the upsert/insert builder rather than
 * the string 'reviews' anywhere, so a file that merely reads reviews — or
 * names one in a comment — is not swept in.
 */
const REVIEW_WRITE = /\.from\(\s*['"]reviews['"]\s*\)\s*(?:\r?\n\s*)*\.(?:upsert|insert)\s*\(/

/**
 * Paths that write reviews WITHOUT firing the event, each with the reason.
 * Empty, and meant to stay that way — an entry here is a provider whose
 * customers get no automatic drafts.
 */
const EXCEPTIONS: Record<string, string> = {}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

describe('guardrail: every review sync triggers RepuGuard drafts', () => {
  const writers = walk(INNGEST_FUNCTIONS).filter((file) =>
    REVIEW_WRITE.test(readFileSync(file, 'utf8')),
  )

  it('finds the review-writing sync functions at all', () => {
    // A scan that matches nothing passes every assertion below while checking
    // nothing — the same self-check the other guardrails in this directory
    // carry. Three providers write reviews today.
    expect(writers.length).toBeGreaterThanOrEqual(3)
  })

  it('has every review writer fire the draft event', () => {
    const missing = writers
      .map((file) => file.replace(`${process.cwd()}/`, ''))
      .filter((file) => !EXCEPTIONS[file])
      .filter((file) => !readFileSync(file, 'utf8').includes(DRAFT_EVENT))

    expect(missing.join('\n')).toBe('')
  })

  it('keeps the exception list pruned', () => {
    const stale = Object.keys(EXCEPTIONS).filter((file) => !writers.includes(file))
    expect(stale.join('\n')).toBe('')
  })
})
