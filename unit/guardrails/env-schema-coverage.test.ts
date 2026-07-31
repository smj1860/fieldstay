import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { collectSourceFiles, read, ROOT } from './scan'
import {
  ENV_SPEC,
  validateServerEnv,
  resolveDeployTarget,
  assertServerEnv,
} from '../../lib/env'

// ============================================================================
// Boot-time env schema: coverage + behaviour.
//
// lib/env.ts is only worth anything if it stays complete. The 2026-07-30
// pre-launch audit's finding was not "one variable was missing" — it was that
// NOTHING anywhere described what this app needs to run, so 52 `process.env.X!`
// assertions each independently decided that a missing value was fine. A schema
// that drifts one variable behind the code is the same failure with extra
// ceremony.
//
// Per CLAUDE.md's meta-rule, the convention ships with its guardrail. Two
// directions are checked:
//
//   1. code → schema:  every literal `process.env.X` read in app/, lib/,
//      components/, middleware.ts, proxy.ts or instrumentation*.ts is declared
//      in ENV_SPEC (or is a platform-supplied var listed below).
//   2. docs → schema:  every variable documented in .env.example is declared
//      in ENV_SPEC (or is a named non-app var: E2E harness, one-off scripts).
//
// The reverse of (1) is deliberately NOT checked: INNGEST_EVENT_KEY /
// INNGEST_SIGNING_KEY are read by the Inngest SDK itself and appear nowhere in
// a grep, and SENTRY_ORG/PROJECT/AUTH_TOKEN are read by next.config.ts at build
// time. A "declared but unreferenced" rule would delete exactly those.
// ============================================================================

/** Supplied by Node/Next/Vercel/CI — nothing for us to configure or validate. */
const PLATFORM_VARS = new Set([
  'NODE_ENV',
  'CI',
  'VERCEL_ENV',
  'NEXT_PUBLIC_VERCEL_ENV',
  'NEXT_RUNTIME',
  'NEXT_PHASE',
])

/** Documented in .env.example but never read by the running app. */
const NON_APP_VARS = new Set([
  // Playwright harness — validated by e2e/global-setup.ts with its own errors.
  'E2E_SUPABASE_URL',
  'E2E_SUPABASE_SERVICE_ROLE_KEY',
  'E2E_PM_EMAIL',
  'E2E_PM_PASSWORD',
  'E2E_CREW_EMAIL',
  'E2E_CREW_PASSWORD',
  'E2E_BASE_URL',
  // One-off maintenance scripts; set inline at invocation, not in .env.local.
  'DEMO_USER_PASSWORD',
  'DRY_RUN',
  'LAUNCH_DATE',
])

const SCAN_TARGETS = ['app', 'lib', 'components']
// Root-level files outside the scanned directories. Filtered by existence:
// this repo's auth middleware lives in proxy.ts rather than middleware.ts, and
// which of the two is present is a Next.js convention detail, not something
// this test should have an opinion about.
const SCAN_FILES = ['middleware.ts', 'proxy.ts', 'instrumentation.ts', 'instrumentation-client.ts']

/**
 * Strip comments before matching. lib/stripe/client.ts's own comment mentions
 * `process.env.STRIPE_PRICE_*!` while explaining why that pattern was removed
 * — matching prose would make this test fail on its own documentation.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function referencedVars(): Map<string, string> {
  const found = new Map<string, string>()
  const files = [
    ...collectSourceFiles(SCAN_TARGETS),
    ...SCAN_FILES.map((f) => join(ROOT, f)).filter((f) => existsSync(f)),
  ]
  for (const file of files) {
    const src = stripComments(read(file))
    for (const m of src.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!found.has(m[1]!)) found.set(m[1]!, file)
    }
  }
  return found
}

function envExampleVars(): string[] {
  const src = readFileSync(join(ROOT, '.env.example'), 'utf8')
  return [...new Set(
    src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l.trim())?.[1])
      .filter((v): v is string => Boolean(v)),
  )]
}

describe('guardrail: env schema coverage', () => {
  it('scans a non-trivial number of env references (guards against a vacuous check)', () => {
    expect(referencedVars().size).toBeGreaterThan(30)
  })

  it('every process.env read in app code is declared in ENV_SPEC', () => {
    const undeclared = [...referencedVars().entries()]
      .filter(([name]) => !PLATFORM_VARS.has(name) && !(name in ENV_SPEC))
      .map(([name, file]) => `${name} (first seen in ${file})`)

    expect(
      undeclared,
      'Add each to ENV_SPEC in lib/env.ts with a tier and a one-line "why", or to PLATFORM_VARS if the platform supplies it. An undeclared var is one the deploy will not fail on when it is missing.',
    ).toEqual([])
  })

  it('every variable documented in .env.example is declared in ENV_SPEC', () => {
    const undeclared = envExampleVars().filter(
      (name) => !PLATFORM_VARS.has(name) && !NON_APP_VARS.has(name) && !(name in ENV_SPEC),
    )
    expect(undeclared).toEqual([])
  })
})

// ── Behaviour ───────────────────────────────────────────────────────────────

/** A minimal environment that satisfies every tier, for mutation in tests. */
function fullEnv(): NodeJS.ProcessEnv {
  return {
    NEXT_PUBLIC_SUPABASE_URL:      'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY:     'service-key',
    NEXT_PUBLIC_APP_URL:           'https://app.fieldstay.app',
    STRIPE_SECRET_KEY:             'sk_test_123',
    STRIPE_WEBHOOK_SECRET:         'whsec_123',
    STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_456',
    STRIPE_PRICE_STARTER_MONTHLY:   'price_1',
    STRIPE_PRICE_STARTER_ANNUAL:    'price_2',
    STRIPE_PRICE_GROWTH_MONTHLY:    'price_3',
    STRIPE_PRICE_GROWTH_ANNUAL:     'price_4',
    STRIPE_PRICE_PORTFOLIO_MONTHLY: 'price_5',
    STRIPE_PRICE_PORTFOLIO_ANNUAL:  'price_6',
    STRIPE_PRICE_SPONSOR_MONTHLY:   'price_7',
    RESEND_API_KEY:                 're_123',
    RESEND_FROM_EMAIL:              'noreply@fieldstay.app',
    RESEND_FROM_NAME:               'FieldStay',
    INNGEST_EVENT_KEY:              'evt',
    INNGEST_SIGNING_KEY:            'sign',
    upstash_fieldstay_KV_REST_API_URL:   'https://kv.upstash.io',
    upstash_fieldstay_KV_REST_API_TOKEN: 'kv-token',
    MAPBOX_PUBLIC_TOKEN:            'pk.abc',
    NEXT_PUBLIC_VAPID_PUBLIC_KEY:   'vapid-pub',
    VAPID_PRIVATE_KEY:              'vapid-priv',
    VAPID_EMAIL:                    'hello@fieldstay.app',
    VAPID_CONTACT_EMAIL:            'admin@fieldstay.app',
    NEXT_PUBLIC_SENTRY_DSN:         'https://key@o0.ingest.sentry.io/0',
    SMS_ENABLED:                    'false',
  }
}

describe('guardrail: env validation behaviour', () => {
  it('a fully-configured production environment validates clean', () => {
    const result = validateServerEnv(fullEnv(), 'production')
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('DETECTS the original bug: a missing Stripe price id fails a production boot', () => {
    const env = fullEnv()
    delete env.STRIPE_PRICE_GROWTH_MONTHLY

    const result = validateServerEnv(env, 'production')
    expect(result.ok).toBe(false)
    expect(result.errors.map((e) => e.name)).toContain('STRIPE_PRICE_GROWTH_MONTHLY')
  })

  it('DETECTS the original bug: a missing STRIPE_WEBHOOK_SECRET fails a production boot', () => {
    const env = fullEnv()
    delete env.STRIPE_WEBHOOK_SECRET

    const result = validateServerEnv(env, 'production')
    expect(result.ok).toBe(false)
    expect(result.errors.map((e) => e.name)).toContain('STRIPE_WEBHOOK_SECRET')
  })

  it('a present-but-malformed value is an error even in development', () => {
    const env = fullEnv()
    env.STRIPE_PRICE_GROWTH_MONTHLY = 'sk_live_oops' // a key pasted into a price slot

    const result = validateServerEnv(env, 'development')
    expect(result.errors.map((e) => e.name)).toContain('STRIPE_PRICE_GROWTH_MONTHLY')
  })

  it("SMS_ENABLED='TRUE' is rejected — the gate compares against exactly 'true'", () => {
    const env = fullEnv()
    env.SMS_ENABLED = 'TRUE'

    const result = validateServerEnv(env, 'production')
    expect(result.errors.map((e) => e.name)).toContain('SMS_ENABLED')
  })

  it('turning SMS on promotes the Telnyx credentials to required', () => {
    const env = fullEnv()
    env.SMS_ENABLED = 'true'

    const names = validateServerEnv(env, 'development').errors.map((e) => e.name)
    expect(names).toContain('TELNYX_API_KEY')
    expect(names).toContain('TELNYX_WEBHOOK_PUBLIC_KEY')
  })

  it('does not break local dev or preview: production-tier vars only warn there', () => {
    const env = fullEnv()
    delete env.STRIPE_SECRET_KEY
    delete env.RESEND_API_KEY
    delete env.MAPBOX_PUBLIC_TOKEN

    for (const target of ['development', 'preview'] as const) {
      const result = validateServerEnv(env, target)
      expect(result.ok, `${target} should still boot`).toBe(true)
      expect(result.warnings.map((w) => w.name)).toContain('STRIPE_SECRET_KEY')
    }
  })

  it('core vars are fatal in EVERY non-test environment', () => {
    const env = fullEnv()
    delete env.SUPABASE_SERVICE_ROLE_KEY

    for (const target of ['development', 'preview', 'production'] as const) {
      expect(validateServerEnv(env, target).ok, target).toBe(false)
    }
  })

  it('assertServerEnv throws on a broken production environment', () => {
    const env = fullEnv()
    env.VERCEL_ENV = 'production'
    delete env.SUPABASE_SERVICE_ROLE_KEY

    expect(() => assertServerEnv(env)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('assertServerEnv reports but never throws during `next build` (CI builds have no secrets)', () => {
    const env: NodeJS.ProcessEnv = { NEXT_PHASE: 'phase-production-build', VERCEL_ENV: 'production' }
    expect(() => assertServerEnv(env)).not.toThrow()
  })

  it('resolveDeployTarget distinguishes production, preview, test and development', () => {
    expect(resolveDeployTarget({ VERCEL_ENV: 'production' })).toBe('production')
    expect(resolveDeployTarget({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe('preview')
    expect(resolveDeployTarget({ NODE_ENV: 'test' })).toBe('test')
    expect(resolveDeployTarget({ NODE_ENV: 'development' })).toBe('development')
  })
})
