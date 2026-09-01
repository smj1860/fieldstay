import { describe, it, expect } from 'vitest'
import { readCode, collectSourceFiles, rel } from './scan'

// ============================================================================
// RECORD_GUARANTEE_IMPLEMENTATION.md Workstream 2.1: lib/guarantee.ts is the
// ONLY place any FieldStay Record Guarantee number may be typed as a literal.
// A drift here is not a copy inconsistency the way a stale price used to be
// (see lib/stripe/brackets.ts's header) — it is a conflicting legal
// representation, so this guardrail checks two things a reviewer skimming
// prose easily misses:
//
//   1. Every file that names the guarantee ("FieldStay Record Guarantee")
//      imports GUARANTEE_NAME from lib/guarantee.ts rather than re-typing the
//      phrase — the structural backstop for "the name never travels alone"
//      (section 2.3).
//   2. The published policy page (app/guarantee/page.tsx) states every
//      guarantee number via interpolation of the module's own exports, never
//      as a bare literal alongside "day(s)"/"month(s)"/"credit(s)".
// ============================================================================

const DIRS = ['app', 'lib', 'components']

describe('guardrail: guarantee numbers come only from lib/guarantee.ts', () => {
  it('every file naming "FieldStay Record Guarantee" imports GUARANTEE_NAME, rather than re-typing the phrase', () => {
    const files = collectSourceFiles(DIRS).filter((f) => !f.endsWith('lib/guarantee.ts'))
    const offenders: string[] = []

    for (const file of files) {
      const src = readCode(file)
      if (!src.includes('FieldStay Record Guarantee')) continue
      if (!/from\s+['"]@\/lib\/guarantee['"]/.test(src) || !/\bGUARANTEE_NAME\b/.test(src)) {
        offenders.push(rel(file))
      }
    }

    expect(offenders, [
      'These files spell out "FieldStay Record Guarantee" without importing',
      'GUARANTEE_NAME from lib/guarantee.ts — a future rename of the guarantee',
      'would silently miss them:',
      ...offenders,
    ].join('\n')).toEqual([])
  })

  it('app/guarantee/page.tsx imports every numeric guarantee constant', () => {
    const src = readCode('app/guarantee/page.tsx')
    for (const name of [
      'RESPONSE_WINDOW_BUSINESS_DAYS',
      'COVERED_PERIOD_MONTHS',
      'CLAIM_WINDOW_DAYS',
      'CREDITS_PER_BILLING_PERIOD',
      'CHANGE_NOTICE_DAYS',
    ]) {
      expect(src, `app/guarantee/page.tsx does not import/use ${name} from lib/guarantee.ts`).toMatch(new RegExp(`\\b${name}\\b`))
    }
  })

  it('app/guarantee/page.tsx states no day/month/credit figure as a bare literal outside a { } interpolation', () => {
    const rawSrc = readCode('app/guarantee/page.tsx')
    // Strip every {ident} / {ident-expression} JSX interpolation — what
    // remains is exactly the static prose a reader (or a future editor
    // hand-typing a number into it) would see.
    const prose = rawSrc.replace(/\{[^{}]*\}/g, '')

    const bareNumber = /\b\d+[\s-]*(?:business\s+)?days?\b|\b\d+[\s-]*months?\b|\b\d+\s*credits?\b/i
    const match = bareNumber.exec(prose)

    expect(
      match,
      `Found a bare numeric guarantee figure in app/guarantee/page.tsx's static prose: "${match?.[0]}". ` +
      'Every day/month/credit count on this page must come from lib/guarantee.ts via interpolation, ' +
      'never hand-typed.',
    ).toBeNull()
  })
})
