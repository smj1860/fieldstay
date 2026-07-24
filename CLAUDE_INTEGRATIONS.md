# FieldStay — Integrations & Operations Reference
# Read alongside CLAUDE.md. Together they are complete.

---

## Environment Variables — Full List

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=          # server/Inngest only — never client

# Inngest
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=

# Resend
RESEND_API_KEY=
RESEND_FROM_EMAIL=                  # e.g. "noreply@fieldstay.app"
RESEND_FROM_NAME=                   # e.g. "FieldStay"

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_PLATFORM_FEE_PCT=
STRIPE_PRICE_STARTER_MONTHLY= / _ANNUAL=
STRIPE_PRICE_GROWTH_MONTHLY= / _ANNUAL=
STRIPE_PRICE_PORTFOLIO_MONTHLY= / _ANNUAL=

# Kroger (OAuth2 — see Integration Registry below)
KROGER_CLIENT_ID=
KROGER_CLIENT_SECRET=

# OwnerRez (OAuth2 for connect/callback; Basic Auth for inbound webhooks)
OWNERREZ_CLIENT_ID=
OWNERREZ_CLIENT_SECRET=
OWNERREZ_WEBHOOK_USER=
OWNERREZ_WEBHOOK_PASSWORD=

# Hostaway (API key — not OAuth)
# Hospitable (OAuth2) — HOSPITABLE_CLIENT_ID / HOSPITABLE_CLIENT_SECRET /
# HOSPITABLE_WEBHOOK_SECRET ARE global env vars (see .env.example); every
# org's OAuth flow uses the same registered app. lib/integrations/providers/
# hospitable-token.ts and hospitable.ts both throw at runtime if unset.
# See Integration Registry below for how per-org tokens are then stored.

# Mapbox (geocoding — properties and vendors)
MAPBOX_PUBLIC_TOKEN=

# Telnyx (guidebook guest SMS — gated by SMS_ENABLED, see CLAUDE.md)
TELNYX_API_KEY=
TELNYX_MESSAGING_PROFILE_ID=
TELNYX_FROM_NUMBER=
TELNYX_WEBHOOK_PUBLIC_KEY=          # Ed25519 public key, verifies inbound webhooks
SMS_ENABLED=                        # 'true' | 'false' — false until 10DLC verified

# Tomorrow.io (weather — contextual guest SMS signals)
TOMORROW_IO_API_KEY=

# Support bot (lib/support/*) — classification, generation, KB embeddings
ANTHROPIC_API_KEY=
OPENAI_API_KEY=                     # text-embedding-3-small for KB chunk embeddings

# Upstash Redis (rate limiting — lib/rate-limit.ts)
# Note non-standard lowercase Vercel KV integration var names
upstash_fieldstay_KV_REST_API_URL=
upstash_fieldstay_KV_REST_API_TOKEN=

# Web Push (VAPID — PWA push notifications)
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_EMAIL=
VAPID_CONTACT_EMAIL=

# App
NEXT_PUBLIC_APP_URL=                # https://app.fieldstay.app
```

**Dead — do not add back:** `NEXT_PUBLIC_CRISP_WEBSITE_ID` (Crisp live chat, replaced by
the in-house support bot at `lib/support/*`) and `NEXT_PUBLIC_POWERSYNC_URL` (PowerSync,
replaced by Dexie — see CLAUDE.md's Dexie section). Neither is referenced anywhere in
the codebase; if you see either mentioned in old docs or comments it is stale.

---

## Integration Registry — Single Source of Truth for OwnerRez / Kroger / Hostaway / Hospitable

All third-party PMS and retailer integrations (OwnerRez, Kroger, Hostaway, Hospitable)
go through one generic pattern. **There are no bespoke `/api/kroger/*` or
`/api/ownerrez/*` routes** — that was an earlier design, since replaced.

```
lib/integrations/
  registry.ts            — providers Map<id, IntegrationProvider>. getProvider(id) /
                            listProviders() / listOAuthProviders()
  types.ts                — IntegrationProvider interface (authType, getAuthorizationUrl,
                            validateWebhook, etc.)
  vault.ts                 — the ONLY token storage gateway (see below)
  providers/
    ownerrez.ts / ownerrez-api.ts
    kroger.ts / kroger-token.ts
    hostaway.ts             — authType: 'api_key', not OAuth
    hospitable.ts / hospitable-token.ts

app/api/integrations/[provider]/
  connect/route.ts        — OAuth Step 1: generic for ANY registered oauth2 provider.
                            Adding a new OAuth integration never requires touching this file.
  callback/route.ts       — OAuth Step 2: exchanges code, stores tokens via vault.ts

app/api/webhooks/[provider]/route.ts
  — Single inbound webhook handler for ALL providers. Validates via
    providerAdapter.validateWebhook(), handles the generic "authorization revoked"
    event universally, delegates everything else to the provider adapter.
```

To register a new integration: create `lib/integrations/providers/your-provider.ts`,
add one line to the `providers` map in `registry.ts`, and add one row to the
`integration_providers` DB table (`is_active` gates whether the UI offers it — the DB
row and the registry entry must agree; a provider `is_active=true` in the DB with no
matching registry adapter will 404 when a user tries to connect).

**Guesty is NOT active.** `integration_providers.guesty.is_active = false` and there is
no `lib/integrations/providers/guesty.ts` — flip `is_active` back to `true` in the same
commit that ships the adapter, not before.

### Token Storage — Vault RPCs ONLY, never plaintext columns

`lib/integrations/vault.ts` is the single controlled gateway to Supabase Vault. It is
server-only (imports `SUPABASE_SERVICE_ROLE_KEY`) and never logs a token.

```typescript
import { storeIntegrationToken, readIntegrationToken, revokeIntegrationToken,
         storeIntegrationRefreshToken, readIntegrationRefreshToken } from '@/lib/integrations/vault'

// Storing a token — creates or updates the integration_connections row and the
// underlying Vault secret. Returns the Vault secret UUID (for audit, never the token).
const secretId = await storeIntegrationToken({
  userId, providerId, accessToken, externalUserId,
  scope: 'cart.basic:write profile.compact',   // optional
  metadata: { location_id, location_name },     // optional
})

// Reading a token — use immediately, do not persist beyond the current request
const token = await readIntegrationToken(userId, providerId)

// Providers whose access tokens expire (Kroger, Hospitable) also get a refresh token
await storeIntegrationRefreshToken({ userId, providerId, refreshToken, expiresAt })
```

The `integration_connections` table itself has **no `access_token`/`refresh_token`
columns** — only `vault_secret_id` and `refresh_token_vault_secret_id` (opaque
references). Never write `access_token`/`refresh_token` directly to that table; it will
fail (the columns don't exist) or, if you're tempted to add them back, will reintroduce
a plaintext-credential-storage vulnerability that's already been fixed once.

`integration_connections` is unique on both `(user_id, provider_id)` and
`(org_id, provider_id)` — it started life user-keyed and had `org_id` retrofitted.
When resolving which org a connection belongs to (e.g. a user in multiple orgs),
resolve deterministically — do not add a new unordered `LIMIT 1` on
`organization_members`; follow the pattern used elsewhere of ordering by
`created_at ASC` so the result is stable.

### Webhook Contract — Dedup and Revocation

`app/api/webhooks/[provider]/route.ts` handles every provider's inbound webhooks:

1. Resolve the provider via `getProvider(providerId)` (404 if unknown).
2. `providerAdapter.validateWebhook(request.clone())` — provider-specific signature/
   auth check. **Fail closed**: if validation throws or returns false, reject with 401.
3. Dedup: insert into `processed_webhooks` keyed
   `"<provider>:<sha256(JSON.stringify(payload))>"` — a content hash, not the
   provider's own `payload.id` (see CLAUDE_HOSPITABLE_DEXIE_AUDIT_FIXES_1.md
   Task 1 for why `payload.id`'s semantics can't be trusted uniformly across
   event types). A `23505` unique-violation means it's a duplicate delivery
   — return early. Any other insert error is logged and processing continues
   (never let a dedup-table hiccup silently drop a real webhook). Rows are
   TTL-cleaned after 72h via `cleanup_webhook_dedup()` (fired
   probabilistically on ~5% of requests — not a cron).
4. The generic `authorization_revoked` event is handled centrally: marks the
   connection `revoked` via `revokeIntegrationToken()` and writes an `integration.revoked`
   audit event via `logAuditEvent()`. **PM-facing email notification on webhook-driven
   revocation is a separate step from this** — check `lib/inngest/functions/` for a
   `integration/connection-revoked` handler before assuming it doesn't exist; if you're
   adding a new revocation path, follow the existing proactive-refresh-triggered
   revocation email pattern in `lib/inngest/functions/cron/integration-token-refresh-handler.ts`.
5. Everything else delegates to the provider adapter.
6. Always return 200 quickly — never make the provider wait on downstream processing;
   dispatch an Inngest event for anything non-trivial.

Provider auth schemes are genuinely different (Basic Auth, HMAC, Ed25519, Stripe's own
signature format) and are NOT forced through one algorithm — but every scheme's
verification result now goes through the same shared contract:
`lib/integrations/webhook-verification.ts` exports `WebhookVerificationResult`
(`{ valid: boolean; reason?: string }`), `ok()`/`fail(reason)` constructors,
`timingSafeEqual()`, and `isTimestampFresh(timestampSeconds, toleranceSeconds = 300)`.
`IntegrationProvider.validateWebhook()` returns `WebhookVerificationResult` — a
rejection always carries a reason, logged by the generic route handler.

Not every scheme has a timestamp to check for freshness:
- **OwnerRez** — HTTP Basic Auth, no timestamp concept at all.
- **Hospitable** — HMAC-SHA256 over the raw body only, no timestamp mixed in.
- **Telnyx** (`app/api/webhooks/telnyx/route.ts`) — Ed25519 over `timestamp|body`
  DOES include one, and `verifyTelnyxSignature()` calls `isTimestampFresh()` before
  accepting a signature — without it, a captured valid signature would stay
  replayable forever.
- **Stripe** (`app/api/webhooks/stripe/route.ts`) — `stripe.webhooks.constructEvent()`
  already enforces its own tolerance window internally (same 300s default), so
  `isTimestampFresh()` isn't called there — it would be redundant.

For every scheme without a timestamp, replay protection comes entirely from the
`processed_webhooks` dedup table, not from the signature check itself.

Stripe and Telnyx deliberately keep dedicated routes rather than being forced through
the generic `[provider]` adapter pattern — their SDKs/schemes are meaningfully
different (Stripe's SDK already does more than a generic adapter method reasonably
could), and reimplementing that would be worse, not better.

---

## Integration Health — Single Surface

Status was previously scattered across three shapes that don't agree with each other:
`integration_connections.status`, `integration_connections.metadata.last_sync_status`
(free-form jsonb, set by whichever sync function last ran), and `ical_feeds
.last_sync_status` (a separate per-property mechanism for manually-pasted calendar
URLs — not an OAuth connection, but answers the same "is this healthy?" question).

`lib/integrations/health.ts` → `getIntegrationHealth(orgId)` normalizes both into one
shape (`{ kind, id, providerId, label, status, lastSyncAt, detail }`, status one of
`healthy | never_synced | needs_attention | needs_reconnect`), exposed at
`GET /api/integrations/health`. `org_milestones` is deliberately NOT part of this — it's
a one-time onboarding/celebration flag mechanism, not ongoing health (see the Inngest
section above). The Settings → Integrations page currently derives its own view
directly from the same tables rather than this endpoint; it's not required to switch,
but new health-surfacing code (ops tooling, alerts, a future dashboard) should use
`getIntegrationHealth()` instead of re-deriving status logic again.

---

## Uplisting — NOT IMPLEMENTED

`booking_source` includes `'uplisting'` as an enum value, and it may come up in
discussion, but **there is no Uplisting code anywhere in this codebase**: no
`lib/uplisting/*`, no `app/api/webhooks/uplisting/*`, no registry entry, and
`organizations.uplisting_api_key` **does not exist as a column**. Do not write code
that assumes any of this exists. If asked to build Uplisting support, it needs to be
built from scratch following the Integration Registry pattern above (API key auth
like Hostaway, not OAuth) — do not resurrect any old plaintext-column design.

---

## Kroger Integration

Registered as a standard OAuth2 provider in the registry
(`lib/integrations/providers/kroger.ts`, `kroger-token.ts`) — connect/callback go
through the generic `/api/integrations/kroger/{connect,callback}` routes, tokens live
in Vault via `integration_connections`, same as every other OAuth provider. There is
no bespoke `/api/kroger/*` route and no `organizations.kroger_customer_token` /
`kroger_refresh_token` column (dropped — they held plaintext tokens and were
unpopulated dead weight once the Vault migration completed).

- **Client credentials** → product search and location lookup (no user needed)
- **Customer OAuth** → adding to cart (`cart.basic:write` scope)
- PM connects their personal Kroger account once via `/api/integrations/kroger/connect`
- Token refresh: `lib/inngest/functions/cron/integration-token-refresh.ts` runs every
  2 hours, checks `integration_connections` for Kroger/Hospitable connections expiring
  within 60 minutes, and dispatches refresh via
  `lib/inngest/functions/cron/integration-token-refresh-handler.ts` — which calls
  `refreshKrogerToken()` from `lib/integrations/providers/kroger-token.ts`, and on
  terminal failure marks the connection `revoked` and sends a reconnect-required email
  via Resend (deduped by `reconnect_email_sent_at`).

### Kroger Developer Portal Scopes Required
- `product.compact` — product search
- `cart.basic:write` — add items to customer cart
- `profile.compact` — verify connected account
- Redirect URI: `https://app.fieldstay.app/api/integrations/kroger/callback`

---

## OwnerRez Integration

A full property management system; FieldStay uses it for booking revenue
auto-population in the owner portal and for turnover-triggering calendar sync.
OAuth 2.0 via the generic registry pattern above.
Initial/incremental sync: `lib/inngest/functions/ownerrez/{initial-sync,incremental-sync}.ts`.
Reviews sync: `lib/inngest/functions/ownerrez/ownerrez-reviews-sync.ts`.

### Marketplace install (no FieldStay account yet)

A user arriving from a provider's marketplace (e.g. Hospitable's "Get Started"
button, or "Connect FieldStay" inside OwnerRez) hits a callback with a valid
authorization `code` but no FieldStay session and no account.

⚠️ **The code is NOT exchanged at this point — deliberately.** An earlier
version exchanged immediately and held the exchanged tokens for post-signup
claim. Hospitable's partner team flagged the consequence (2026-07-22): the
token exchange is what registers the connection on the provider's side, so
their UI showed the user as "Connected" before any FieldStay account existed —
and an abandoned signup left that dangling Connected state (plus an unrevoked
refresh token in an expired pending row) forever. The exchange is now deferred
until after the user actively authenticates:

1. `holdPendingOAuthCode()` (`lib/integrations/vault.ts`) stores the raw,
   unexchanged authorization code in Vault under a random claim token and
   inserts a row into `pending_oauth_authorizations` (30 min TTL, single-use,
   RLS-enabled/no-policies like `oauth_states`), along with the exact
   `redirect_uri` the authorization was issued against (replayed on the
   deferred exchange for providers that enforce it). The callback route
   redirects to `/signup?provider=X&next=/connect/finish?pending_link=<token>`.
2. `app/(auth)/signup/signup-form.tsx` threads `next` through **both** signup paths:
   Google (via the existing `fs-oauth-next` cookie mechanism, same as before) and
   email/password (embedded directly in `emailRedirectTo`'s query string — a cookie
   doesn't survive an email-confirmation click that can happen on a different
   device/much later; query params on `emailRedirectTo` do, mirroring the existing
   `invite_token` pattern). If the project has email confirmation disabled, `signUp()`
   already returns a session and the client-side redirect honors `next` immediately too.
3. `app/connect/finish/route.ts` requires an authenticated session (`requireAuth()` —
   not `requireOrgMember()`, since the user may not have completed onboarding/org
   creation yet), calls `claimPendingOAuthCode()` (single-use — the Vault secret
   and pending row are destroyed in the claiming transaction), performs the
   code→token exchange **here**, and finalizes via
   `finalizeIntegrationConnection()` (`lib/integrations/finalize-connection.ts`,
   shared with the standard callback: Vault storage, org linking, initial-sync
   event gated on a real org_id).
4. **Expired-code fallback:** provider codes are single-use and short-lived
   (~10 min typically) while email-confirmation signup can take longer. If the
   provider rejects the code at exchange time, `/connect/finish` redirects into
   the standard `/api/integrations/[provider]/connect` flow — the user is
   authenticated by then, and a provider re-authorizing an already-granted app
   bounces straight back without re-prompting. Never a dead end.
5. Expired/already-claimed pending links (or a user who lands here with no
   `pending_link` at all) redirect to Settings → Integrations where they can connect
   normally — never a dead end.

Never store a raw authorization code in `pending_oauth_authorizations` directly —
`code_vault_secret_id` only; the code is a credential, same
zero-plaintext-at-rest rule as `integration_connections` tokens.

The legacy exchanged-token holding area (`pending_integration_links` +
`create/claim_pending_integration_link`) is no longer written to as of
2026-07-22; its DB objects are kept through the deploy window and should be
dropped in a follow-up migration. TTL cleanup for both tables runs
probabilistically via `cleanupExpiredPendingIntegrationArtifacts()` from the
oneclick callback and `/connect/finish` routes.

---

## Hostaway Integration

API-key auth (not OAuth) — `authType: 'api_key'` in the registry.
`lib/integrations/providers/hostaway.ts`, initial sync in
`lib/inngest/functions/hostaway/initial-sync.ts`.

## Hospitable Integration

OAuth2, same generic pattern. `lib/integrations/providers/hospitable.ts` /
`hospitable-token.ts`. Sync functions in `lib/inngest/functions/hospitable/`
(`initial-sync.ts`, `incremental-sync.ts`, plus its own token-refresh cron/handler
pair mirroring Kroger's).

---

## Inngest

**File location:** every Inngest function lives at `lib/inngest/functions/`
(subdirectories per provider are fine, e.g. `lib/inngest/functions/hospitable/`).
There is no `inngest/functions/` directory in this repo — do not create one.

### Registering New Functions
```typescript
// app/api/inngest/route.ts — exactly ONE serve() call in this file
import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import { buildShoppingCart } from '@/lib/inngest/functions/build-shopping-cart'
import { autoAssignTurnover } from '@/lib/inngest/functions/auto-assign-turnover'
// ... import every function here

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    buildShoppingCart,
    autoAssignTurnover,
    // add every new function to this array
  ],
})
```

Every event name used in `inngest.send()` or a function's trigger must first be added
to `lib/inngest/events.ts` (`FieldStayEvents` type) — see CLAUDE.md for the exact
pattern and why the build fails without it.

### Sending Events from Server Actions
```typescript
import { inngest } from '@/lib/inngest/client'

await inngest.send({
  name: 'turnover/completed',
  data: { org_id: membership.org_id, turnover_id: turnover.id, property_id: turnover.property_id },
})
```

### Surfacing Async Job Results to the UI

There is no PowerSync in this codebase. Inngest steps write progress/results to
`org_milestones` (a key-value store per org), and the PM dashboard reads it directly
via Supabase in Server Components — e.g. `app/(dashboard)/layout.tsx` queries
`org_milestones` on every navigation to find undismissed milestones. There is no
client-side realtime sync layer for this; it's a plain server-rendered read.

```typescript
// Inside an Inngest step — write progress/result for UI
await supabase.from('org_milestones').upsert({
  org_id,
  key: 'cart_build_status',
  value: { status: 'complete', matched: 14, cart_url: '...', completed_at: new Date().toISOString() },
}, { onConflict: 'org_id,key' })
```

```typescript
// app/(dashboard)/layout.tsx (Server Component) — direct Supabase read, no sync layer
const { data: pendingMilestone } = await supabase
  .from('org_milestones')
  .select('milestone, achieved_at')
  .eq('org_id', membership.org_id)
  .eq('dismissed', false)
  .is('prompted_at', null)
  .limit(1)
```

The crew PWA (`app/crew/*`) is different — it uses Dexie/IndexedDB, never reads
`org_milestones` or any other Supabase table directly. See CLAUDE.md's Dexie section.

### Idempotency Pattern for owner_transactions
```typescript
const { data: existing } = await supabase
  .from('owner_transactions')
  .select('id')
  .eq('source_reference_id', sourceRecordId)
  .eq('source', sourceType)
  .single()

if (existing) return { skipped: true }

await supabase.from('owner_transactions').insert({ ... })
```

---

## Resend / React Email

### File Locations
```
lib/resend/
  client.ts
  emails/
    shopping-cart-ready.tsx
    turnover-assigned.tsx
    wo-aging-alert.tsx
    compliance-expiring.tsx
    asset-health-alert.tsx
    capex-forecast-ready.tsx
```

### Sending Pattern (from Inngest steps — never from Server Actions directly)
```typescript
import { Resend } from 'resend'
import { ShoppingCartReadyEmail } from '@/lib/resend/emails/shopping-cart-ready'

const resend = new Resend(process.env.RESEND_API_KEY)

await resend.emails.send({
  from: process.env.RESEND_FROM_EMAIL!,
  to: recipientEmail,
  subject: 'Your Kroger cart is ready',
  react: ShoppingCartReadyEmail({ cartResult, locationName }),
})
```

### Getting PM Email in Inngest Steps
```typescript
import { getPmEmail } from '@/lib/...'   // see CLAUDE.md Canonical Patterns section
const email = await getPmEmail(supabase, orgId)   // supabase client FIRST — returns string | null directly
```

---

## Telnyx (Guest SMS)

Guidebook guest messaging — door code delivery, morning/evening nudges, weather
signals from Tomorrow.io. All sends gated on `SMS_ENABLED` — see CLAUDE.md's Critical
Security Rules. Inbound webhook: `app/api/webhooks/telnyx/route.ts`, verified against
`TELNYX_WEBHOOK_PUBLIC_KEY` (Ed25519), not the generic `[provider]` webhook handler.

## Support Bot (Anthropic + OpenAI)

FieldStay's own support chat agent (`lib/support/*`), replacing the earlier Crisp
live-chat widget (fully removed — no code references remain). Classification and
response generation via `lib/support/classify.ts` / `lib/support/anthropic-client.ts`
(`ANTHROPIC_API_KEY`). Knowledge-base chunk embeddings via `lib/support/embed.ts`
(`OPENAI_API_KEY`, `text-embedding-3-small`), retrieved via the `match_kb_chunks()`
Postgres function (`lib/support/retrieve.ts`). RepuGuard review-response generation
(`lib/repuguard/generate-response.ts`) also uses the Anthropic client.

## Upstash (Rate Limiting)

`lib/rate-limit.ts` — `@upstash/ratelimit` + `@upstash/redis`. Env vars use
non-standard lowercase names from the Vercel KV integration
(`upstash_fieldstay_KV_REST_API_URL` / `_TOKEN`) — do not rename them to the usual
`UPSTASH_REDIS_REST_URL` convention, the Vercel integration writes them lowercase.

---

## Mapbox Geocoding

### Pattern (called on property save and vendor save)
```typescript
// lib/geocoding.ts
export async function geocodeZip(zip: string): Promise<{ lat: number; lng: number } | null> {
  const token = process.env.MAPBOX_PUBLIC_TOKEN
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/`
            + `${encodeURIComponent(zip)}.json?country=US&types=postcode&limit=1&access_token=${token}`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = await res.json()
  const [lng, lat] = data.features?.[0]?.center ?? []
  return (lat && lng) ? { lat, lng } : null
}
```

One call per save (`createProperty`/`updateProperty` when zip changes,
`createVendor`/`updateVendor` when service_zip changes). Never geocode in a loop or on
every render.

---

## Supabase Storage (Vendor Compliance Documents)

Bucket: `compliance-documents`, private (signed URLs only — never public).

```typescript
import { createServerClient } from '@/lib/supabase/server'

export async function uploadComplianceDocument(vendorId: string, file: File, docType: string) {
  const { membership } = await requireOrgMember()
  const supabase = createServerClient()
  const ext = file.name.split('.').pop()
  const path = `${membership.org_id}/${vendorId}/${docType}-${Date.now()}.${ext}`
  const { error } = await supabase.storage.from('compliance-documents').upload(path, file, { upsert: false })
  if (error) return { error: error.message }
  return { path }   // store in vendor_compliance_documents.document_url
}

// Generating a signed URL for display
const { data } = await supabase.storage.from('compliance-documents').createSignedUrl(document.document_url, 3600)
```

---

## Stripe

Webhook handler: `app/api/webhooks/stripe/route.ts` (dedicated route, not the generic
`[provider]` handler). Always verify signature first — see CLAUDE.md's Critical
Security Rules for the exact pattern. Vendor-side Stripe Connect payouts have their own
webhook route: `app/api/webhooks/stripe-connect/route.ts`.

```typescript
export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sig = req.headers.get('stripe-signature')!
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }
  await inngest.send({ name: `stripe/${event.type}`, data: event.data.object })
  return NextResponse.json({ received: true })
}
```

---

## Common Mistakes Claude Code Makes in This Codebase

1. **`from('memberships')`** — does not exist. Always `from('organization_members')`.
2. **`assigned_crew_id`** — deprecated column on `work_orders`. Use `assigned_crew_member_id`.
3. **Creating Inngest functions at `inngest/functions/`** — the real path is
   `lib/inngest/functions/`. The wrong path silently produces a function that's never
   registered.
4. **Forgetting to add a new Inngest function to the `serve()` array** in
   `app/api/inngest/route.ts`, or a new event name to `FieldStayEvents` in
   `lib/inngest/events.ts` before using it.
5. **Assuming PowerSync is the sync layer.** It isn't — Dexie (crew PWA) and direct
   Supabase reads (PM dashboard, including `org_milestones`) are. There is no
   `ALTER PUBLICATION powersync ...` step for new tables; that workflow doesn't exist
   anymore.
6. **Writing `access_token`/`refresh_token` directly onto `integration_connections`.**
   Those columns don't exist. Go through `lib/integrations/vault.ts`.
7. **Assuming Uplisting integration code exists.** It doesn't — see the Uplisting
   section above.
8. **Creating owner_transactions without checking `source_reference_id` first.** Causes
   duplicate expense/revenue entries on Inngest retries.
9. **Using `createServiceClient()` where `createServerClient()` is correct.** Service
   client bypasses RLS — use only in Inngest steps and admin routes.
10. **Calling `inngest.send()` directly from a client component.** Always fire Inngest
    from Server Actions, never client-side.
11. **Hardcoding hex colors instead of CSS variables.** `color: '#ffffff'` →
    `color: 'var(--text-primary)'`.
12. **Missing `WITH CHECK` clause on INSERT/UPDATE policies.** `USING` alone does not
    protect INSERT operations.
