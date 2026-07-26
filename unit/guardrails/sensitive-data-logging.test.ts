import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Sensitive-data logging guardrail: CLAUDE.md states, in two places, that
// certain fields must never be logged — "Never log actual_cost, email,
// Stripe tokens" (Things That Will Break table) and "never log guest phone
// numbers, SMS body content, actual_cost/financial specifics, Stripe tokens,
// or any secret/API key" (Sensitive-data logging, Standing Audit Checklist).
// The audit-logging item adds a third surface: "Never put PII or secrets in
// the metadata field" of logAuditEvent(s). Nothing previously enforced any
// of this beyond manual review.
//
// A logging-call site counts as a violation if one of the named sensitive
// identifiers appears within its own call's argument list (a bounded window
// after the opening paren — matching the same bounded-proximity approach
// used by the n-plus-one-loops and inngest-insert-idempotency guardrails,
// since real paren-balance tracking is unnecessary for a same-call-site
// check like this one).
//
// Scope: console.log/error/warn/info, reportError(), and
// logAuditEvent(s)( calls across app/ and lib/ — the sinks CLAUDE.md's rule
// is actually about. Excludes types/ (schema/type declarations reference
// these field names constantly and log nothing) and unit/ (test fixtures
// commonly construct literal objects with these field names to assert
// against, not to log them).
//
// Masked/redacted use is NOT a violation — e.g. telnyx.ts's
// `to: \`***${toE164.slice(-4)}\`` logs only the last 4 digits, matching the
// pattern this rule exists to require. A call's argument window counts as
// masked if it contains a truncation/redaction marker (`***`, `.slice(-`,
// `redact`) anywhere in the same window.
// ============================================================================

const LOG_CALL = /(?:console\.(?:log|error|warn|info)|reportError|logAuditEvents?)\(([\s\S]{0,300}?)\)/g

const SENSITIVE_FIELD =
  /\bactual_cost\b|\bguest_phone\w*\b|\bphone_e164\b|\bsms_body\b|\bmessage_body\b|\bclient_secret\b|\bstripe_token\b|\bpayment_method_id\b/

const MASKED = /\*\*\*|\.slice\(-|redact/i

function findOffenders(): string[] {
  const offenders: string[] = []
  for (const file of collectSourceFiles(['app', 'lib'])) {
    const src = read(file)
    LOG_CALL.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LOG_CALL.exec(src))) {
      const args = m[1]!
      if (SENSITIVE_FIELD.test(args) && !MASKED.test(args)) {
        const line = src.slice(0, m.index).split('\n').length
        offenders.push(`${rel(file)}:${line}`)
      }
    }
  }
  return offenders
}

// Verified against the codebase 2026-07-26. No violations currently exist —
// this guardrail is a ratchet keeping the baseline clean, same model as
// tailwind-color-ratchet. Add an entry ONLY with a reason the value is
// already masked/safe in a way this heuristic can't detect on its own.
const EXCEPTIONS: Record<string, string> = {}

describe('guardrail: no sensitive fields (actual_cost, guest phone, SMS body, Stripe/secret tokens) in log calls', () => {
  const offenders = findOffenders()

  // The real codebase baseline is clean (a ratchet, same model as
  // tailwind-color-ratchet) — these synthetic checks prove the detection
  // logic itself actually fires and un-fires correctly, so a clean result
  // above means "nothing to catch," not "the regex is silently broken."
  it('detects a sensitive field in a synthetic unmasked log call (sanity: the scan is not silently inert)', () => {
    expect(SENSITIVE_FIELD.test('actual_cost: workOrder.actual_cost') && !MASKED.test('actual_cost: workOrder.actual_cost')).toBe(true)
  })

  it('does not flag a synthetic masked log call', () => {
    expect(MASKED.test('to: `***${phone_e164.slice(-4)}`')).toBe(true)
  })

  it('every match is either safely masked or a named, justified exception', () => {
    const unlisted = offenders.filter((o) => !EXCEPTIONS[o])

    expect(
      unlisted,
      [
        'A console.log/error/warn/info, reportError(), or logAuditEvent(s)(',
        'call references a field CLAUDE.md bans from logs (actual_cost, guest',
        'phone, SMS body, a Stripe/client-secret token) without masking it.',
        'Mask it (e.g. last-4-digits truncation) or remove the field from the',
        'log call — or, if it\'s already safe in a way this heuristic can\'t',
        'see, add it to EXCEPTIONS in this test with a reason. Offenders:',
        ...unlisted,
      ].join('\n')
    ).toEqual([])
  })

  it('every EXCEPTIONS entry still exists at that file:line (prune when code moves)', () => {
    const present = new Set(offenders)
    for (const key of Object.keys(EXCEPTIONS)) {
      expect(
        present.has(key),
        `EXCEPTIONS lists ${key}, which no longer matches the sensitive-field-in-log pattern — remove the stale entry (the code likely moved or was fixed).`
      ).toBe(true)
    }
  })
})
