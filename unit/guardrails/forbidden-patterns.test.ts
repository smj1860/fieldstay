import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// String-level and cross-file invariants from CLAUDE.md's "Things That Will
// Break" table that ESLint's AST rules can't express (or that need to hold
// in places ESLint's scoping doesn't cover). AST-expressible rules live in
// eslint.config.mjs — don't duplicate them here.

describe('guardrail: single-chokepoint invariants', () => {
  it('the Telnyx API is called ONLY from lib/sms/telnyx.ts (the SMS_ENABLED gate + nudge budget chokepoint)', () => {
    const offenders = collectSourceFiles(['app', 'lib', 'components'])
      .filter((f) => rel(f) !== 'lib/sms/telnyx.ts' && read(f).includes('api.telnyx.com'))
      .map(rel)

    expect(
      offenders,
      `Direct Telnyx calls bypass the SMS_ENABLED gate and the daily nudge budget — route through sendSMS() in lib/sms/telnyx.ts.`
    ).toEqual([])
  })

  it('the service-role key string appears ONLY in lib/supabase/server.ts (belt to the ESLint AST rule\'s suspenders)', () => {
    const offenders = collectSourceFiles(['app', 'lib', 'components'])
      .filter((f) => rel(f) !== 'lib/supabase/server.ts')
      .filter((f) => {
        // Comments mentioning the key by name are fine — only flag code-like use
        const lines = read(f).split('\n').filter((l) => l.includes('SUPABASE_SERVICE_ROLE_KEY'))
        return lines.some((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      })
      .map(rel)

    expect(offenders).toEqual([])
  })
})

describe('guardrail: Inngest structure', () => {
  it('every inngest.createFunction lives under lib/inngest/functions/', () => {
    const offenders = collectSourceFiles(['app', 'lib', 'components'])
      .filter((f) => read(f).includes('inngest.createFunction'))
      .map(rel)
      .filter((p) => !p.startsWith('lib/inngest/functions/'))

    expect(
      offenders,
      'All Inngest functions live at lib/inngest/functions/ (CLAUDE.md) — files elsewhere are never registered in the serve() route.'
    ).toEqual([])
  })

  it('exactly one serve() export exists in the Inngest route', () => {
    const src = read(`${process.cwd()}/app/api/inngest/route.ts`)
    const serveCalls = src.match(/=\s*serve\(/g) ?? []
    expect(
      serveCalls.length,
      'app/api/inngest/route.ts must contain exactly ONE `export const { GET, POST, PUT } = serve({...})` — a second causes a defined-multiple-times build error.'
    ).toBe(1)
  })
})
