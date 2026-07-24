import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// THE service-role invariant, structurally enforced.
//
// createServiceClient() bypasses Row Level Security. The convention is:
// prove who's asking FIRST (requireOrgMember/requireOrgRole/requireAuth/
// requireCrewMember, a webhook signature, or an opaque-token lookup), THEN
// escalate to the service client, THEN scope every query manually. All
// existing call sites follow this because their authors read CLAUDE.md —
// this test is what stops the next call site from being the one that
// doesn't. (The crew-auth variant of "everyone follows the auth pattern
// until someone doesn't" shipped as a live bug four times before its
// guardrail existed. This one exists in advance.)
//
// Scope: app/** only. lib/inngest/** runs in system context (Inngest steps
// are the intended RLS-bypass surface per CLAUDE.md Critical Security Rule
// #1), and lib/** helpers receive already-authorized clients from callers
// that this test does cover.
// ============================================================================

// Evidence of an authorization step. File-level heuristic (not
// order-of-execution proof), which is the right bar: the drift this catches
// is "author forgot the authorization step entirely" — a file that imports
// an auth gate but calls it after the query would not survive review, while
// a file with no gate at all historically has.
const PROOF_PATTERNS: RegExp[] = [
  /requireOrgMember|requireOrgRole|requireAuth|requireCrewMember/,
  /auth\.getUser\(\)/,                    // session-authenticated, self-scoped routes (account delete, GDPR export, OAuth start)
  /constructEvent/,                       // Stripe webhook signature verification
  /verify[A-Za-z]*Signature/,             // provider webhook HMAC/Ed25519 verification (e.g. Telnyx)
  /\.eq\(\s*['"][a-z_]*token['"]/,        // opaque-token lookup (owner portal, quote, guidebook, invite, completion)
  /platform_staff/,                       // staff-gated admin surfaces
]

// Files allowed to use the service client with NO authorization step, each
// with the reason the exemption is sound. Additions to this list are a
// security-review event, not a convenience.
const EXCEPTIONS: Record<string, string> = {
  'app/api/webhooks/[provider]/route.ts':
    'Generic provider webhook intake: content-hash dedup + resolution against pre-registered external connection ids; IP rate-limited in proxy.ts. No per-provider signature exists to verify.',
  'app/api/webhooks/stripe/handlers/types.ts':
    'Type-only import (ReturnType<typeof createServiceClient>) — no runtime client is created.',
  'app/g/[slug]/page.tsx':
    'Public guest guidebook by design: serves only guest-facing content for the slug-resolved property; rate-limited via guidebookLimiter in proxy.ts.',
}

describe('guardrail: service-role call sites are authorized', () => {
  const files = collectSourceFiles(['app']).filter((f) =>
    read(f).includes('createServiceClient')
  )

  it('finds the call-site population (sanity: the scan is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(30)
  })

  it.each(files.map((f) => [rel(f), f]))(
    '%s authorizes before escalating to the service client',
    (relPath, file) => {
      if (EXCEPTIONS[relPath as string]) return

      const src = read(file as string)
      const hasProof = PROOF_PATTERNS.some((p) => p.test(src))

      expect(
        hasProof,
        `${relPath} uses createServiceClient() (RLS bypassed) but contains no ` +
        `recognized authorization step (${PROOF_PATTERNS.map(String).join(', ')}). ` +
        `Authorize first — or, if this surface is genuinely public/system, add it ` +
        `to EXCEPTIONS in this test with a reason that survives security review.`
      ).toBe(true)
    }
  )

  it('every EXCEPTIONS entry still exists (prune the list when files move)', () => {
    const present = new Set(files.map(rel))
    for (const path of Object.keys(EXCEPTIONS)) {
      expect(
        present.has(path),
        `EXCEPTIONS lists ${path}, which no longer uses createServiceClient — remove the stale entry.`
      ).toBe(true)
    }
  })
})
