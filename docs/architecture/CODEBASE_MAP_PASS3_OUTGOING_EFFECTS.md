# Codebase Map — Pass 3: Outgoing Effects

Pass 1 mapped where data *enters* FieldStay. Pass 2 traced what happens to
it internally (the Inngest event graph). This pass closes the loop: every
place FieldStay sends something *out* to the world — email, SMS, money
movement, third-party API calls, browser push, and observability data.
Seven channels, each with a single chokepoint client and a lazy-construction
pattern to survive build-time module loading without required env vars.

---

## 1. Email — Resend

**Chokepoint:** `lib/resend/client.ts` — `resend` (lazy `Proxy`, same
pattern as the Redis/Stripe clients: constructing `new Resend()` eagerly
at module load throws on a missing API key, and this file is imported
widely enough that `next build`'s page-data-collection pass would crash
in any environment without `RESEND_API_KEY` set). `FROM` is the shared
sender identity.

**Templates**, two locations:
- `lib/resend/emails/*.tsx` — PM-facing (`pm-alert.tsx`,
  `integration-error.tsx`, `shopping-cart-ready.tsx`) and vendor-facing
  (`vendor-connect-invite.tsx`, `vendor-invoice-paid.tsx`,
  `vendor-compliance-nudge.tsx`, `work-order-vendor.tsx`)
- `emails/*.tsx` (repo root) — `team-invite`, `owner-portal`,
  `guest-pre-arrival`, `guidebook-grace-period` — sent via named helpers
  in `lib/resend/client.ts` itself (`sendTeamInviteEmail`,
  `sendOwnerPortalEmail`, etc.) rather than inline `resend.emails.send()`

**~34 call sites.** The overwhelming majority are Inngest functions
already traced in Pass 2 — every PM alert, vendor nudge, and integration
error notification in that map terminates here. Two call sites bypass
the event bus and send synchronously from the request itself:
- `app/(dashboard)/settings/actions.ts` — plan/billing changes
- `app/api/crew/feedback/route.ts` — crew feedback acknowledgment

**Idempotency:** most Inngest-originated sends pass Resend's own
`idempotencyKey` option (e.g. `work-order-invoice-paid-${invoice_id}`),
so a retried step can't double-email — this is on top of, not instead
of, the DB-level idempotency (`source_reference_id`, `ON CONFLICT`)
Pass 2 already covered for the underlying automation.

---

## 2. SMS — Telnyx

**Chokepoint:** `lib/sms/telnyx.ts`'s `sendSMS()` — the `SMS_ENABLED`
gate lives at the very top of this one function, before anything else
runs:
```typescript
if (process.env.SMS_ENABLED !== 'true') {
  console.log('[sms:disabled]', { to: `***${toE164.slice(-4)}`, bodyLength: body.length })
  return { sent: false, reason: 'SMS_ENABLED is not true' }
}
```
Because every caller goes through this one function, the gate can't be
accidentally bypassed by a new call site — it's structurally
impossible to send SMS without it, not just a convention callers have
to remember. Worth noting: the disabled-path log redacts the phone to
last-4-digits and logs body *length* only, never the message body
itself — door codes travel in SMS bodies, so this is the concrete
instance of CLAUDE.md's "never log PII" rule for this channel.

**Templates:** `lib/sms/templates.ts` (`buildDoorCodeSMS` and friends),
plus `formatOffer()` in `telnyx.ts` itself for sponsor-offer text in
guidebook nudges.

**Consumers** (all traced as chains in Pass 2 §1–§7):
`work-order-events.ts`, `work-order-vendor-assigned.ts`,
`crew-assignment.ts`, `guidebook-guest-opted-in.ts`,
`guidebook-stay-extension-handler.ts`, `guidebook-sms-morning-cron.ts`,
`guidebook-sms-evening-cron.ts`.

---

## 3. Stripe — outbound calls

Distinct from Pass 1's inbound Stripe **webhook** boundary — this is
FieldStay calling *out* to Stripe. Same lazy-`Proxy` pattern as Resend,
in `lib/stripe/client.ts` (`stripe`), plus the `PLANS`/`getPlanByPriceId`
plan-tier config used by checkout/webhook code.

Three distinct outbound shapes:

**a. Checkout session creation** — one-time payment collection:
- `app/(dashboard)/settings/actions.ts` — org subscription checkout
- `app/api/invoices/[invoiceId]/checkout/route.ts` — owner invoice payment
- `app/actions/guidebook.ts` — sponsor slot checkout

**b. Connect account setup** — vendor payout onboarding
(`stripe.accounts.create` + `stripe.accountLinks.create`):
- `lib/stripe/vendor-connect-invite.ts` (two call sites — invite +
  resend paths)
- `lib/inngest/functions/work-order-events.ts` — idempotency key on
  `stripe.accounts.create` prevents a duplicate Connect account if this
  step retries
- `app/api/vendor-connect/[token]/onboard/route.ts` — the public
  token-gated route from Pass 1 §3

**c. Subscription lifecycle management**
(`stripe.subscriptions.retrieve`/`.cancel`):
- `lib/inngest/functions/guidebook-daily-monitor.ts` — checks sponsor
  subscription state
- `app/api/webhooks/stripe/route.ts` — re-fetches subscription detail
  mid-webhook-handling (the one place a webhook handler also makes an
  outbound call, not just reacts to the inbound one)
- `app/api/account/delete/route.ts` — cancels both the org subscription
  and, if present, the separate RepuGuard subscription on account
  deletion

---

## 4. Kroger — inventory cart automation

**Chokepoint:** `lib/kroger/client.ts` — no persistent client object;
each call fetches a fresh client-credentials OAuth token
(`getClientToken()`, 30-minute expiry, re-fetched per Inngest step
rather than cached) then hits `api.kroger.com/v1` directly for product
search, store location lookup, and cart submission.

**Consumer:** `lib/inngest/functions/build-shopping-cart.ts` — the
terminal step of Pass 2 §4's inventory chain
(`inventory/cart_requested` → Kroger cart built → PM notified via
`shopping-cart-ready.tsx`, channel 1 above).

---

## 5. Mapbox — geocoding

**Chokepoint:** `lib/geocoding.ts`'s `geocodeZip()` — silently returns
`null` on any failure (missing token, non-OK response, no features) so
callers degrade to "no coordinates" rather than throwing. Also home to
the pure `haversineKm`/`distanceMiles` helpers used for crew/vendor
proximity scoring elsewhere (no network call — just math on
already-geocoded lat/lng).

**Call sites**, matching CLAUDE.md's documented "one call on save"
pattern exactly:
- `app/(dashboard)/properties/actions.ts` — property create/update when
  zip changes
- `app/(dashboard)/settings/actions.ts` — vendor create/update when zip
  changes
- `lib/inngest/functions/geocoding-backfill.ts` — the one-time manual
  bulk-backfill path from Pass 2 §5, for records that predate geocoding
  or were imported without it

---

## 6. Web Push — crew/PM browser notifications

**Chokepoint:** `lib/push/send-push.ts`'s `sendPushToUser(userId,
payload)`. VAPID keys are set lazily inside the function body (not at
module scope) for the same reason as the Redis/Stripe/Resend clients —
a missing config can't crash unrelated code that shares this module's
import graph (the comment specifically calls out message sending as an
example of collateral damage this avoids). Looks up the caller's
`crew_members` row, fans out to every registered `push_subscriptions`
row for that crew member, and prunes subscriptions the push service
reports as gone (HTTP 410) — the one channel in this pass with built-in
self-cleaning of stale endpoints.

**Consumers:**
- `lib/inngest/functions/notify-assignment-gap.ts` — crew coverage gap
- `lib/inngest/functions/flagged-turnover-wo.ts` — flagged turnover → WO
- `app/(dashboard)/messages/actions.ts` — in-app message sent (the one
  push call site that isn't an Inngest function; fires synchronously
  from the Server Action alongside the `message/sent` event Pass 2 §8
  traced to `communication_logs`)

---

## 7. Observability — Sentry

**Chokepoint:** `Sentry.init()`, called from `instrumentation.ts` (server/edge
runtime) and `instrumentation-client.ts` (browser) — `@sentry/nextjs`, added
2026-07-15. Unlike the other six channels, this isn't invoked at individual
call sites; it's a global error/trace capture layer that intercepts uncaught
exceptions and API-route/Server-Action execution automatically once
initialized. Sentry owns the OTEL tracer-provider registration for the whole
app — it replaced `@vercel/otel`, which was removed when Sentry was added, so
there is exactly one tracer-provider registration, not two. This is distinct
from Axiom (Pass 2/CLAUDE.md's observability table): Axiom is a Vercel-native
log capture for Inngest's own `logger` calls, not a trace exporter; Sentry is
the one that owns traces plus error reporting.

**Gate/safety:** standard Sentry SDK sampling config (`tracesSampleRate` etc.
in the instrumentation files) — no app-level feature flag gates it the way
`SMS_ENABLED` gates Telnyx.

---

## Summary

| Channel | Chokepoint | Gate/safety mechanism | Primarily driven by |
|---|---|---|---|
| Email (Resend) | `lib/resend/client.ts` | Resend `idempotencyKey` per send | Inngest (Pass 2 chains) |
| SMS (Telnyx) | `lib/sms/telnyx.ts` `sendSMS()` | `SMS_ENABLED` env var, structurally unbypassable | Inngest + guidebook crons |
| Stripe (outbound) | `lib/stripe/client.ts` | Idempotency key on Connect account creation | Server Actions + routes, some Inngest |
| Kroger | `lib/kroger/client.ts` | Fresh token per call (no stale-token risk) | `build-shopping-cart.ts` only |
| Mapbox | `lib/geocoding.ts` | Silent `null` on failure — never throws | Property/vendor Server Actions |
| Web Push | `lib/push/send-push.ts` | Lazy VAPID init, self-prunes dead endpoints (410) | 2 Inngest functions + 1 Server Action |
| Sentry (observability) | `instrumentation.ts` / `instrumentation-client.ts` | Sentry SDK sampling config | Automatic — any uncaught error or traced execution |

The first six channels follow the same defensive-construction idiom seen
across this codebase's external clients: build the real client lazily,
behind either a `Proxy` or a function-scoped check, so a missing
credential in one environment can't take down `next build` or unrelated
code sharing the same import graph. Sentry is the exception — it's
initialized globally at instrumentation time rather than lazily per call
site, since its whole job is catching errors *anywhere* in the app.
Combined with Pass 1 (data in) and Pass 2 (internal processing), this
closes the loop on FieldStay's full external surface area.
