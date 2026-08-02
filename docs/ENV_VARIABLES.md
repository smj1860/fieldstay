# FieldStay — Production Environment Variables

A complete inventory of every environment variable this codebase reads, generated
from `lib/env.ts` (`ENV_SPEC`, the authoritative boot-time schema), `.env.example`,
and a full grep of `process.env` across `app/`, `lib/`, `components/`, `scripts/`,
`proxy.ts` and `instrumentation*.ts`.

_Generated 2026-08-02 for cross-referencing against the Vercel project settings._

## How to read the "Production" column

- **Required** — the deploy fails at boot without it. `instrumentation.ts` calls
  `assertServerEnv()`, which throws and names every missing variable at once when
  `VERCEL_ENV === 'production'`. These are the ones to verify first.
- **Conditional** — only required when the feature that uses it is switched on
  (Telnyx once `SMS_ENABLED="true"`; `DEMO_USER_EMAIL` once `DEMO_ENTRY_SECRET` is
  set). Half-configuring one of these is worse than leaving it off entirely.
- **Recommended** — losing it degrades the platform but breaks nothing; warns on a
  production boot.
- **Optional** — feature-gated. A missing value disables that one feature; it is
  only format-checked when present.

One rule applies across every tier: a value that is **present but malformed** is a
fatal error regardless of tier. A typo'd price ID or a `"TRUE"` instead of `"true"`
fails the boot even where the variable itself was optional.

---

## Supabase — core, app will not boot without these

| Variable | Production | What it does / what breaks without it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Required** | Every Supabase client (server, browser, service-role) is built from it. App will not boot without it in any environment. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Required** | The RLS-enforced client used by every Server Action and Route Handler. App will not boot without it. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required** | `createServiceClient()` — every Inngest step and webhook handler. App will not boot without it. Server-side only; never expose. |

## App

| Variable | Production | What it does / what breaks without it |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | **Required** | Absolute URLs in every email, Stripe redirect, owner-portal link and OAuth callback. Fatal on a production deploy. |
| `NEXT_PUBLIC_CREW_SYNC_V2` | Optional | Crew Sync v2 rollout flag (`"true"`/`"false"`). Inlined at build time — changing it needs a redeploy. Leave unset until Phase 5 rollout. |

## Stripe — billing

| Variable | Production | What it does / what breaks without it |
|---|---|---|
| `STRIPE_SECRET_KEY` | **Required** | All billing: checkout, subscriptions, Connect payouts. Must start with `sk_`. |
| `STRIPE_WEBHOOK_SECRET` | **Required** | Without it `constructEvent()` throws and EVERY platform webhook 400s, looking like a signature problem. Starts with `whsec_`. |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | **Required** | Same, for the separate Stripe Connect webhook endpoint. A different secret from the one above. |
| `STRIPE_PRICE_STARTER_MONTHLY` | **Required** | Starter monthly checkout price ID. Starts with `price_`. |
| `STRIPE_PRICE_STARTER_ANNUAL` | **Required** | Starter annual checkout price ID. |
| `STRIPE_PRICE_GROWTH_MONTHLY` | **Required** | Growth monthly checkout price ID. |
| `STRIPE_PRICE_GROWTH_ANNUAL` | **Required** | Growth annual checkout price ID. |
| `STRIPE_PRICE_PORTFOLIO_MONTHLY` | **Required** | Portfolio monthly checkout price ID. |
| `STRIPE_PRICE_PORTFOLIO_ANNUAL` | **Required** | Portfolio annual checkout price ID. |
| `STRIPE_PRICE_SPONSOR_MONTHLY` | **Required** | Guidebook sponsor subscription checkout price ID. |
| `STRIPE_PLATFORM_FEE_PCT` | Optional | Platform fee on vendor invoices, as a percent (0–100). Defaults to 0 when unset. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Optional | Currently unread — checkout is a server-side redirect to a Stripe-hosted page. Kept for a future embedded Payment Element. |

## Email (Resend)

| Variable | Production | What it does / what breaks without it |
|---|---|---|
| `RESEND_API_KEY` | **Required** | Every transactional email. Starts with `re_`. |
| `RESEND_FROM_EMAIL` | **Required** | The From address on every email. |
| `RESEND_FROM_NAME` | **Required** | Interpolated into the FROM header — unset renders the literal string `"undefined"`. |
| `COMPANY_POSTAL_ADDRESS` | Optional | CAN-SPAM physical-address line in the footer of commercial email. Unset just omits the line — but MUST be set before any commercial (drip / re-engagement / win-back) email is sent. |

## Inngest — background jobs

| Variable | Production | What it does / what breaks without it |
|---|---|---|
| `INNGEST_EVENT_KEY` | **Required** | Sending events — all background work. Read by the Inngest SDK itself, so it appears in no grep of the app code. Do not delete it as "unused". |
| `INNGEST_SIGNING_KEY` | **Required** | Verifying inbound Inngest requests. Same note as above. |

## Upstash / Vercel KV — rate limiting

> Note the non-standard lowercase variable names. These are exactly as Vercel KV
> generated them; copy them character for character.

| Variable | Production | What it does / what breaks without it |
|---|---|---|
| `upstash_fieldstay_KV_REST_API_URL` | **Required** | Every rate limiter, the SMS nudge budget, and the OwnerRez circuit breaker. |
| `upstash_fieldstay_KV_REST_API_TOKEN` | **Required** | As above. Without it `checkLimit()` short-circuits to `skipped`, so all rate limits silently disappear. |

## Mapbox — geocoding

| Variable | Production | What it does / what breaks without it |
|---|---|---|
| `MAPBOX_PUBLIC_TOKEN` | **Required** | Property and vendor geocoding on save — crew auto-assignment scores by distance. Starts with `pk.`. |

## Web push (VAPID)

| Variable | Production | What it does / what breaks without it |
|---|---|---|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | **Required** | Crew PWA push subscription (browser side). |
| `VAPID_PRIVATE_KEY` | **Required** | Signing push payloads. |
| `VAPID_EMAIL` | **Required** | VAPID contact in `lib/push/send-push.ts` — interpolated into a `mailto:`. |
| `VAPID_CONTACT_EMAIL` | **Required** | VAPID contact in `lib/push/client.ts` — interpolated into a `mailto:`. Separate variable from `VAPID_EMAIL`; both are needed. |

## Sentry — observability

| Variable | Production | What it does / what breaks without it |
|---|---|---|
| `NEXT_PUBLIC_SENTRY_DSN` | Recommended | Errors and performance traces. Unset means production runs blind, but nothing breaks. |
| `SENTRY_ORG` | Optional | Source-map upload in `next.config.ts` (build time). Set in Vercel for symbolicated stack traces. |
| `SENTRY_PROJECT` | Optional | Source-map upload in `next.config.ts` (build time). |
| `SENTRY_AUTH_TOKEN` | Optional | Source-map upload; absent just skips the upload step rather than failing the build. |
| `SENTRY_TRACES_SAMPLE_RATE` | Optional | Server trace sampling override, 0.0–1.0. Defaults to 0.1 in production. Leave unset unless investigating an incident. |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | Optional | Browser trace sampling override, 0.0–1.0. Same defaults; build-time inlined. |

## SMS (Telnyx) — gated on `SMS_ENABLED`

| Variable | Production | What it does / what breaks without it |
|---|---|---|
| `SMS_ENABLED` | **Required** | The guest-SMS master kill switch. Must be exactly `"true"` or `"false"` — a typo'd `"TRUE"` silently disables every send. Keep `"false"` until 10DLC campaign verification clears. |
| `SMS_DAILY_NUDGE_BUDGET` | Optional | Daily org-wide nudge spend ceiling (positive integer). Defaults to 500 when unset. |
| `TELNYX_API_KEY` | Conditional | Outbound guest SMS. Required once `SMS_ENABLED="true"`. |
| `TELNYX_MESSAGING_PROFILE_ID` | Conditional | Outbound guest SMS. Required once `SMS_ENABLED="true"`. |
| `TELNYX_FROM_NUMBER` | Conditional | Outbound guest SMS sender in E.164 format (leading `+`). Required once `SMS_ENABLED="true"`. |
| `TELNYX_WEBHOOK_PUBLIC_KEY` | Conditional | Inbound STOP/START. `verifyTelnyxSignature()` fails CLOSED without it — every webhook is rejected and TCPA opt-out breaks. Required once `SMS_ENABLED="true"`. |

## Third-party integrations — all feature-gated

| Variable | Production | What it does / what breaks without it |
|---|---|---|
| `KROGER_CLIENT_ID` | Optional | Kroger cart automation. Missing disables the integration. |
| `KROGER_CLIENT_SECRET` | Optional | Kroger cart automation. |
| `OWNERREZ_CLIENT_ID` | Optional | OwnerRez OAuth. |
| `OWNERREZ_CLIENT_SECRET` | Optional | OwnerRez OAuth. |
| `OWNERREZ_WEBHOOK_USER` | Optional | OwnerRez webhook basic auth — a credential you define when registering the endpoint in the OwnerRez portal. |
| `OWNERREZ_WEBHOOK_PASSWORD` | Optional | OwnerRez webhook basic auth. |
| `OWNERREZ_WEBHOOK_IP_CIDRS` | Optional | Optional source-IP allowlist for the OwnerRez webhook. |
| `HOSPITABLE_CLIENT_ID` | Optional | Hospitable OAuth. The provider code throws at runtime if called while unset. |
| `HOSPITABLE_CLIENT_SECRET` | Optional | Hospitable OAuth. |
| `HOSPITABLE_WEBHOOK_SECRET` | Optional | Hospitable webhook signature verification. |
| `TOMORROW_IO_API_KEY` | Optional | Weather signals for contextual guest SMS. Throws when called while unset. |
| `ANTHROPIC_API_KEY` | Optional | Data-plate OCR (`/api/assets/scan-data-plate`) and RepuGuard generation. Starts with `sk-ant-`. A missing key deploys silently and fails only on the first user request. |
| `REPUGUARD_MODEL` | Optional | RepuGuard model id, kept out of code so a model retirement is a config change. Falls back to a hardcoded default — set it explicitly in every environment. |
| `OPENAI_API_KEY` | Optional | Support-bot knowledge base embeddings (`text-embedding-3-small`). |

## Demo surface — all-or-nothing

| Variable | Production | What it does / what breaks without it |
|---|---|---|
| `DEMO_ENTRY_SECRET` | Optional | Gates `/demo/*`. 32+ url-safe random characters. Unset means every demo route 404s — the safe default. Set all demo vars together or none. |
| `DEMO_USER_EMAIL` | Conditional | The seeded demo account `/demo/enter` mints a session for. Required once `DEMO_ENTRY_SECRET` is set — otherwise `/demo/enter` 404s even with a matching secret. |

---

## NOT needed in Vercel

These appear in `.env.example` or in the codebase but are never read by the running
app. Adding them to Vercel does nothing; leaving them out breaks nothing.

| Variable | What it is |
|---|---|
| `DEMO_USER_PASSWORD` | Read only by `scripts/seed-demo-org.ts` when creating the demo account. The app never reads it. |
| `E2E_SUPABASE_URL` | Playwright harness. GitHub Actions secret. Must point at the dedicated E2E project, never production. |
| `E2E_SUPABASE_SERVICE_ROLE_KEY` | Playwright harness. GitHub Actions secret. |
| `E2E_PM_EMAIL` | Playwright harness — seeded PM test account. |
| `E2E_PM_PASSWORD` | Playwright harness — seeded PM test account. |
| `E2E_CREW_EMAIL` | Playwright harness — seeded crew test account. |
| `E2E_CREW_PASSWORD` | Playwright harness — seeded crew test account. |
| `E2E_BASE_URL` | Playwright target URL. Defaults to the local dev server when unset. |
| `DRY_RUN` | One-off maintenance scripts. Set inline at invocation, not in Vercel. |
| `LAUNCH_DATE` | One-off guidebook launch-email script. Set inline at invocation. |

## Platform-supplied — do not set

Injected by Node, Next.js, Vercel or GitHub Actions. Setting these manually can
break environment detection.

| Variable | What it is |
|---|---|
| `NODE_ENV` | Supplied by Node/Next. Do not set manually in Vercel. |
| `VERCEL_ENV` | Supplied by Vercel (`production` \| `preview` \| `development`). Drives which tier of validation is fatal. |
| `NEXT_PUBLIC_VERCEL_ENV` | Supplied by Vercel; distinguishes production from preview in the browser Sentry config. |
| `NEXT_RUNTIME` | Supplied by Next.js. |
| `NEXT_PHASE` | Supplied by Next.js; `phase-production-build` exempts the build from fatal env errors. |
| `CI` | Supplied by GitHub Actions. |

---

## Verifying the list stays correct

`lib/env.ts` is the single source of truth for what this app needs, and
`unit/guardrails/env-schema-coverage.test.ts` fails CI on drift in either
direction — a `process.env` read with no `ENV_SPEC` entry, or an `.env.example`
entry with no `ENV_SPEC` entry. If a variable is missing from this document, that
test is the thing that would have caught it.

**Counts:** 27 Required, 5 Conditional, 1 Recommended, 25 Optional — 58 variables
in `ENV_SPEC`, the full set the app itself reads. Plus 10 documented but not needed
in Vercel, and 6 platform-supplied.
