import { z } from 'zod'

// ============================================================================
// Boot-time environment validation.
//
// Pre-launch audit 2026-07-30, "No boot-time env validation": 52 non-null
// assertions on `process.env.*` across shipped code, and no schema anywhere.
// The failure mode is not a crash — it is a SILENT MISCONFIGURATION that
// surfaces days later as an unrelated-looking error:
//
//   - lib/stripe/client.ts built PLANS at module load from
//     `process.env.STRIPE_PRICE_*!`, so a missing price id became `undefined`
//     and reached the user as an opaque Stripe API error at checkout instead
//     of a config failure at deploy.
//   - app/api/webhooks/stripe/route.ts: a missing STRIPE_WEBHOOK_SECRET makes
//     constructEvent() throw, the handler catches it and returns 400, and
//     every webhook fails looking exactly like a signature problem.
//
// This module is the single place that says what this app needs to run. It is
// called from instrumentation.ts#register(), so a misconfigured server refuses
// to boot with a message naming every offending variable at once, rather than
// failing one feature at a time in production.
//
// ── Tiers ───────────────────────────────────────────────────────────────────
//   'always'      the app cannot function without it in ANY environment.
//                 Missing → hard error everywhere except tests.
//   'production'  required on a real production deploy. Missing → hard error
//                 when VERCEL_ENV === 'production', warning in preview/dev so
//                 a local checkout and a preview deploy still boot.
//   'recommended' losing it degrades the platform but breaks nothing. Never an
//                 error; warns on a production boot.
//   'optional'    feature-gated. Only format-checked when actually present.
//
// A value that IS present but MALFORMED is an error in every tier and every
// environment — a typo'd `sk_live_…` in STRIPE_PRICE_STARTER_MONTHLY is a bug
// regardless of whether that variable was strictly required here.
//
// ── NEXT_PUBLIC_* ───────────────────────────────────────────────────────────
// These are inlined into client bundles at BUILD time by Next.js, so a runtime
// check cannot repair a client bundle that was built without one — for the
// browser half, the value is already baked in (or baked in as `undefined`).
// They are still validated here because the SERVER reads the same variables
// from process.env (Supabase server client, absolute URLs in emails and Stripe
// redirects), and a server-side failure is the half this check can actually
// prevent. Vars whose only consumer is the browser are marked
// `clientInlinedOnly` and reported as warnings, never boot errors.
// ============================================================================

export type EnvTier = 'always' | 'production' | 'recommended' | 'optional'

export type DeployTarget = 'production' | 'preview' | 'development' | 'test'

/**
 * The environment as this module reads it: a bag of optional string values.
 *
 * Deliberately NOT `NodeJS.ProcessEnv`. Next.js augments that type so
 * `NODE_ENV` is a REQUIRED property, which means no caller can pass a literal
 * describing only the variables under test without either restating NODE_ENV
 * or casting — and a cast is exactly what would let a real drift slip through.
 * `process.env` is assignable to this, so nothing at the call sites changes.
 */
export type EnvRecord = Record<string, string | undefined>

interface VarSpec {
  tier:   EnvTier
  /** Applied only when the variable is present and non-empty. */
  schema: z.ZodType<unknown>
  /** One line: what breaks without it. Shown in the failure message. */
  why:    string
  /**
   * Promotes an 'optional' var to required when another var switches its
   * feature on (e.g. Telnyx credentials once SMS_ENABLED === 'true').
   */
  requiredWhen?: (env: EnvRecord) => boolean
  /** Read only by the browser bundle — see the NEXT_PUBLIC_* note above. */
  clientInlinedOnly?: boolean
  /** Read by the build toolchain (next.config.ts), not by the running server. */
  buildTimeOnly?: boolean
}

const nonEmpty   = z.string().min(1)
const httpUrl    = z.string().url().startsWith('http')
const email      = z.string().email()
const prefixed   = (p: string) => z.string().startsWith(p)
const boolString = z.enum(['true', 'false'])
const rate01     = z.coerce.number().min(0).max(1)
const percent    = z.coerce.number().min(0).max(100)
const posInt     = z.coerce.number().int().positive()

const smsOn = (env: EnvRecord) => env.SMS_ENABLED === 'true'
const demoOn = (env: EnvRecord) => Boolean(env.DEMO_ENTRY_SECRET)

/**
 * Every server-read environment variable in this repo, enumerated from
 * .env.example and from a grep of `process.env.` across app/, lib/,
 * components/, scripts/, middleware.ts, proxy.ts and instrumentation*.ts.
 *
 * Deliberately NOT included: E2E_* (consumed by playwright.config.ts and
 * e2e/global-setup.ts, which validate them with their own precise errors and
 * must not make the app refuse to boot), DRY_RUN / LAUNCH_DATE (one-off
 * maintenance scripts), and CI / NODE_ENV / VERCEL_ENV / NEXT_RUNTIME /
 * NEXT_PHASE (platform-supplied).
 */
export const ENV_SPEC: Readonly<Record<string, VarSpec>> = {
  // ── Supabase ──────────────────────────────────────────────────────────────
  NEXT_PUBLIC_SUPABASE_URL: {
    tier: 'always', schema: httpUrl,
    why: 'every Supabase client (server, browser, and service-role) is constructed from it',
  },
  NEXT_PUBLIC_SUPABASE_ANON_KEY: {
    tier: 'always', schema: nonEmpty,
    why: 'the RLS-enforced client used by every Server Action and Route Handler',
  },
  SUPABASE_SERVICE_ROLE_KEY: {
    tier: 'always', schema: nonEmpty,
    why: 'createServiceClient() — every Inngest step and webhook handler',
  },

  // ── App ───────────────────────────────────────────────────────────────────
  NEXT_PUBLIC_APP_URL: {
    tier: 'always', schema: httpUrl,
    why: 'absolute URLs in every email, Stripe redirect, owner-portal link and OAuth callback',
  },

  // ── Stripe ────────────────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: {
    tier: 'production', schema: prefixed('sk_'),
    why: 'all billing: checkout, subscriptions, Connect payouts',
  },
  STRIPE_WEBHOOK_SECRET: {
    tier: 'production', schema: prefixed('whsec_'),
    why: 'without it constructEvent() throws and EVERY platform webhook 400s, looking like a signature problem',
  },
  STRIPE_CONNECT_WEBHOOK_SECRET: {
    tier: 'production', schema: prefixed('whsec_'),
    why: 'same, for the separate Connect webhook endpoint',
  },
  STRIPE_PRICE_STARTER_MONTHLY:   { tier: 'production', schema: prefixed('price_'), why: 'Starter monthly checkout' },
  STRIPE_PRICE_STARTER_ANNUAL:    { tier: 'production', schema: prefixed('price_'), why: 'Starter annual checkout' },
  STRIPE_PRICE_GROWTH_MONTHLY:    { tier: 'production', schema: prefixed('price_'), why: 'Growth monthly checkout' },
  STRIPE_PRICE_GROWTH_ANNUAL:     { tier: 'production', schema: prefixed('price_'), why: 'Growth annual checkout' },
  STRIPE_PRICE_PORTFOLIO_MONTHLY: { tier: 'production', schema: prefixed('price_'), why: 'Portfolio monthly checkout' },
  STRIPE_PRICE_PORTFOLIO_ANNUAL:  { tier: 'production', schema: prefixed('price_'), why: 'Portfolio annual checkout' },
  STRIPE_PRICE_SPONSOR_MONTHLY:   { tier: 'production', schema: prefixed('price_'), why: 'guidebook sponsor subscription checkout' },
  STRIPE_PLATFORM_FEE_PCT: {
    tier: 'optional', schema: percent,
    why: 'platform fee on vendor invoices; parseFloat defaults to 0 when unset',
  },
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: {
    tier: 'optional', schema: prefixed('pk_'), clientInlinedOnly: true,
    why: 'currently unread — checkout is a server-side redirect to a Stripe-hosted page',
  },

  // ── Email ─────────────────────────────────────────────────────────────────
  RESEND_API_KEY:    { tier: 'production', schema: prefixed('re_'), why: 'every transactional email' },
  RESEND_FROM_EMAIL: { tier: 'production', schema: email,           why: 'the From address on every email' },
  RESEND_FROM_NAME:  { tier: 'production', schema: nonEmpty,        why: 'interpolated into FROM — unset renders the literal "undefined"' },

  // ── Inngest ───────────────────────────────────────────────────────────────
  // Read by the Inngest SDK itself, not by any process.env reference in this
  // repo — a grep finds nothing. Still required in production; do not delete
  // them as "unused".
  INNGEST_EVENT_KEY:   { tier: 'production', schema: nonEmpty, why: 'sending events — all background work' },
  INNGEST_SIGNING_KEY: { tier: 'production', schema: nonEmpty, why: 'verifying inbound Inngest requests' },

  // ── Rate limiting (Upstash / Vercel KV — non-standard lowercase names) ────
  upstash_fieldstay_KV_REST_API_URL: {
    tier: 'production', schema: httpUrl,
    why: 'every rate limiter, the SMS nudge budget, and the OwnerRez circuit breaker',
  },
  upstash_fieldstay_KV_REST_API_TOKEN: {
    tier: 'production', schema: nonEmpty,
    why: 'as above — checkLimit() short-circuits to `skipped` without it, so limits silently disappear',
  },

  // ── Geocoding ─────────────────────────────────────────────────────────────
  MAPBOX_PUBLIC_TOKEN: {
    tier: 'production', schema: prefixed('pk.'),
    why: 'property and vendor geocoding on save — crew auto-assignment scores by distance',
  },

  // ── Web push ──────────────────────────────────────────────────────────────
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: { tier: 'production', schema: nonEmpty, why: 'crew PWA push subscription' },
  VAPID_PRIVATE_KEY:            { tier: 'production', schema: nonEmpty, why: 'signing push payloads' },
  VAPID_EMAIL:                  { tier: 'production', schema: email,    why: 'VAPID contact in lib/push/send-push.ts — interpolated into a mailto:' },
  VAPID_CONTACT_EMAIL:          { tier: 'production', schema: email,    why: 'VAPID contact in lib/push/client.ts — interpolated into a mailto:' },

  // ── Observability ─────────────────────────────────────────────────────────
  NEXT_PUBLIC_SENTRY_DSN: {
    tier: 'recommended', schema: httpUrl,
    why: 'errors and traces; unset means production runs blind, but nothing breaks',
  },
  SENTRY_TRACES_SAMPLE_RATE:             { tier: 'optional', schema: rate01, why: 'server trace sampling override' },
  NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: { tier: 'optional', schema: rate01, why: 'browser trace sampling override', clientInlinedOnly: true },
  SENTRY_ORG:        { tier: 'optional', schema: nonEmpty, buildTimeOnly: true, why: 'source-map upload in next.config.ts' },
  SENTRY_PROJECT:    { tier: 'optional', schema: nonEmpty, buildTimeOnly: true, why: 'source-map upload in next.config.ts' },
  SENTRY_AUTH_TOKEN: { tier: 'optional', schema: nonEmpty, buildTimeOnly: true, why: 'source-map upload; absent just skips the step' },

  // ── SMS (Telnyx) ──────────────────────────────────────────────────────────
  // SMS_ENABLED is the master kill switch and must stay 'false' until 10DLC
  // clears (CLAUDE.md, Critical Security Rule #5). Requiring it to PARSE — and
  // to be exactly 'true' or 'false' — matters: lib/sms/telnyx.ts gates on
  // `!== 'true'`, so a typo'd 'TRUE' silently disables every send instead.
  SMS_ENABLED: {
    tier: 'production', schema: boolString,
    why: "the guest-SMS kill switch; must be exactly 'true' or 'false' — 'TRUE' silently disables all sends",
  },
  SMS_DAILY_NUDGE_BUDGET: {
    tier: 'optional', schema: posInt,
    why: 'daily org-wide nudge spend ceiling; defaults to 500 when unset',
  },
  TELNYX_API_KEY:              { tier: 'optional', schema: nonEmpty, requiredWhen: smsOn, why: 'outbound guest SMS' },
  TELNYX_MESSAGING_PROFILE_ID: { tier: 'optional', schema: nonEmpty, requiredWhen: smsOn, why: 'outbound guest SMS' },
  TELNYX_FROM_NUMBER:          { tier: 'optional', schema: prefixed('+'), requiredWhen: smsOn, why: 'outbound guest SMS sender (E.164)' },
  TELNYX_WEBHOOK_PUBLIC_KEY: {
    tier: 'optional', schema: nonEmpty, requiredWhen: smsOn,
    why: 'inbound STOP/START — verifyTelnyxSignature() fails CLOSED without it, rejecting every webhook and breaking TCPA opt-out',
  },

  // ── Integrations (feature-gated; a missing one disables that provider) ────
  KROGER_CLIENT_ID:       { tier: 'optional', schema: nonEmpty, why: 'Kroger cart automation' },
  KROGER_CLIENT_SECRET:   { tier: 'optional', schema: nonEmpty, why: 'Kroger cart automation' },
  OWNERREZ_CLIENT_ID:     { tier: 'optional', schema: nonEmpty, why: 'OwnerRez OAuth' },
  OWNERREZ_CLIENT_SECRET: { tier: 'optional', schema: nonEmpty, why: 'OwnerRez OAuth' },
  OWNERREZ_WEBHOOK_USER:     { tier: 'optional', schema: nonEmpty, why: 'OwnerRez webhook basic auth' },
  OWNERREZ_WEBHOOK_PASSWORD: { tier: 'optional', schema: nonEmpty, why: 'OwnerRez webhook basic auth' },
  OWNERREZ_WEBHOOK_IP_CIDRS: { tier: 'optional', schema: nonEmpty, why: 'optional source-IP allowlist for the OwnerRez webhook' },
  HOSPITABLE_CLIENT_ID:      { tier: 'optional', schema: nonEmpty, why: 'Hospitable OAuth' },
  HOSPITABLE_CLIENT_SECRET:  { tier: 'optional', schema: nonEmpty, why: 'Hospitable OAuth' },
  HOSPITABLE_WEBHOOK_SECRET: { tier: 'optional', schema: nonEmpty, why: 'Hospitable webhook signature verification' },
  TOMORROW_IO_API_KEY:       { tier: 'optional', schema: nonEmpty, why: 'weather signals for contextual guest SMS; throws when called unset' },
  ANTHROPIC_API_KEY:         { tier: 'optional', schema: prefixed('sk-ant-'), why: 'data-plate OCR and RepuGuard generation' },
  REPUGUARD_MODEL:           { tier: 'optional', schema: nonEmpty, why: 'RepuGuard model id; falls back to a hardcoded default' },
  OPENAI_API_KEY:            { tier: 'optional', schema: nonEmpty, why: 'support-bot knowledge base embeddings' },

  // ── Demo surface (all-or-nothing) ─────────────────────────────────────────
  DEMO_ENTRY_SECRET: {
    tier: 'optional', schema: z.string().min(32),
    why: 'gates /demo/*; unset means every demo route 404s, which is the safe default',
  },
  DEMO_USER_EMAIL: {
    tier: 'optional', schema: email, requiredWhen: demoOn,
    why: '/demo/enter 404s without it even when the secret matches — half-configured demo mode',
  },

  // ── Build-time feature flag ───────────────────────────────────────────────
  NEXT_PUBLIC_CREW_SYNC_V2: {
    tier: 'optional', schema: boolString, clientInlinedOnly: true,
    why: 'Crew Sync v2 rollout flag; inlined at build time, not a runtime toggle',
  },
}

export interface EnvIssue {
  name:     string
  kind:     'missing' | 'malformed'
  severity: 'error' | 'warning'
  detail:   string
}

export interface EnvValidationResult {
  target:   DeployTarget
  errors:   EnvIssue[]
  warnings: EnvIssue[]
  ok:       boolean
}

export function resolveDeployTarget(env: EnvRecord = process.env): DeployTarget {
  if (env.VERCEL_ENV === 'production') return 'production'
  if (env.VERCEL_ENV === 'preview')    return 'preview'
  if (env.NODE_ENV === 'test')         return 'test'
  if (env.NODE_ENV === 'production')   return 'production'
  return 'development'
}

/** Absent, empty, or whitespace-only all count as "not set". */
function isSet(raw: string | undefined): raw is string {
  return typeof raw === 'string' && raw.trim().length > 0
}

function requirednessOf(
  spec: VarSpec,
  target: DeployTarget,
  env: EnvRecord,
): 'error' | 'warning' | 'ignore' {
  if (target === 'test') return 'ignore'
  if (spec.requiredWhen?.(env)) return 'error'

  switch (spec.tier) {
    case 'always':
      return 'error'
    case 'production':
      // A production deploy must have it. Preview and local dev warn instead,
      // so a fresh checkout and a preview branch still boot.
      return target === 'production' ? 'error' : 'warning'
    case 'recommended':
      return target === 'production' ? 'warning' : 'ignore'
    default:
      return 'ignore'
  }
}

/**
 * Pure — takes the environment as an argument and returns issues rather than
 * throwing, so it is directly unit-testable and can be reused by a
 * `check:env` script without side effects.
 */
export function validateServerEnv(
  env: EnvRecord = process.env,
  target: DeployTarget = resolveDeployTarget(env),
): EnvValidationResult {
  const errors:   EnvIssue[] = []
  const warnings: EnvIssue[] = []

  for (const [name, spec] of Object.entries(ENV_SPEC)) {
    const raw = env[name]

    if (!isSet(raw)) {
      const requiredness = requirednessOf(spec, target, env)
      if (requiredness === 'ignore') continue

      // A build-time-only or browser-inlined var can't be repaired by the
      // running server, so never let it be the thing that blocks a boot.
      const severity =
        spec.buildTimeOnly || spec.clientInlinedOnly ? 'warning' : requiredness

      const issue: EnvIssue = { name, kind: 'missing', severity, detail: spec.why }
      if (severity === 'error') errors.push(issue)
      else warnings.push(issue)
      continue
    }

    // Present but malformed is an error in EVERY tier — a typo is a bug
    // whether or not the variable was strictly required.
    const parsed = spec.schema.safeParse(raw)
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? 'failed validation'
      const issue: EnvIssue = {
        name,
        kind:     'malformed',
        severity: target === 'test' ? 'warning' : 'error',
        detail:   `${reason} — ${spec.why}`,
      }
      if (issue.severity === 'error') errors.push(issue)
      else warnings.push(issue)
    }
  }

  return { target, errors, warnings, ok: errors.length === 0 }
}

function formatIssues(issues: EnvIssue[]): string {
  return issues
    .map((i) => `  • ${i.name} — ${i.kind === 'missing' ? 'NOT SET' : 'invalid'}: ${i.detail}`)
    .join('\n')
}

export function formatEnvReport(result: EnvValidationResult): string {
  const lines = [`FieldStay environment validation (target: ${result.target})`]
  if (result.errors.length > 0) {
    lines.push('', `${result.errors.length} FATAL problem(s):`, formatIssues(result.errors))
  }
  if (result.warnings.length > 0) {
    lines.push('', `${result.warnings.length} warning(s):`, formatIssues(result.warnings))
  }
  lines.push('', 'See .env.example for where each value comes from.')
  return lines.join('\n')
}

/**
 * Called from instrumentation.ts#register(). Throws on a fatal problem so the
 * server refuses to boot — a loud, single, complete failure at deploy time
 * instead of one feature quietly breaking per missing variable.
 *
 * `next build` is deliberately exempt from throwing: CI's `checks` job runs
 * `pnpm run build` with no secrets at all, and Next.js loads this hook during
 * the build's page-data collection pass. The report is still printed there, so
 * a genuinely misconfigured build is visible in the log — it just doesn't turn
 * an unconfigured CI runner permanently red.
 */
export function assertServerEnv(env: EnvRecord = process.env): EnvValidationResult {
  const result = validateServerEnv(env)
  const isBuildPhase = env.NEXT_PHASE === 'phase-production-build'

  if (result.errors.length > 0) {
    const report = formatEnvReport(result)
    if (isBuildPhase || result.target === 'test') {
      console.error(report)
      return result
    }
    throw new Error(report)
  }

  if (result.warnings.length > 0) console.warn(formatEnvReport(result))
  return result
}
