# FieldStay — Claude Code Instructions

## Project Identity

**App:** FieldStay (`fieldstay.app`)
**Purpose:** Field operations platform for short-term rental property managers. Automates turnover management, crew scheduling, inventory, and maintenance work orders.
**Stack:** Next.js 14 App Router · Supabase (PostgreSQL + Auth + Vault) · PowerSync (local-first sync) · Inngest (background jobs) · Resend (transactional email) · Stripe (billing) · Vercel (deployment)

**DO NOT use:** Vite, Turborepo, or any build tooling other than what Next.js provides natively.

---

## What Is Already Built — Do Not Rebuild

The following is fully deployed and working. Do not modify these unless a task explicitly requires it.

### Database (Supabase project: `vpmznjktllhmmbfnxuvk`)

All migrations are applied. Integration-relevant tables:

| Table | Purpose |
|---|---|
| `public.integration_providers` | Reference table. Seeded with `ownerrez`, `hostaway`, `guesty`. RLS enabled, SELECT-only for active providers. |
| `public.integration_connections` | One row per user per provider. Stores `vault_secret_id` (pointer into Vault), `external_user_id` (OwnerRez `user_id`), `status`, `metadata`. RLS enabled. |
| `public.oauth_states` | Ephemeral CSRF state tokens for in-flight OAuth flows. Expires after 10 minutes. Service-role only (no client policies). |

**Vault:** Access tokens are stored encrypted in `vault.secrets` via three Postgres wrapper functions callable only with the `service_role` key:
- `vault_store_integration_token(user_id, provider_id, access_token, external_user_id, scope, metadata)`
- `vault_get_integration_token(user_id, provider_id)` → returns `access_token`
- `vault_delete_integration_token(user_id, provider_id)`

Call these via `supabase.rpc()` with the service-role client. Never call `vault.secrets` directly from application code.

### Integration Framework (`src/lib/integrations/`)

| File | Purpose |
|---|---|
| `types.ts` | TypeScript interfaces: `IntegrationProvider`, `OAuthTokenResponse`, `WebhookEvent` |
| `registry.ts` | Provider lookup map — `getProvider(providerId)` returns the correct provider instance |
| `vault.ts` | Application-layer wrappers around the Vault RPC functions |
| `providers/ownerrez.ts` | OwnerRez-specific OAuth logic: `getAuthorizationUrl()`, `exchangeCodeForToken()`, `handleWebhookEvent()` |

### API Routes (Vercel Serverless Functions)

| Route | Purpose |
|---|---|
| `src/app/api/integrations/[provider]/connect/route.ts` | Step 1 of OAuth — generates CSRF state, stores in DB + httpOnly cookie, redirects user to OwnerRez authorization URL |
| `src/app/api/integrations/[provider]/callback/route.ts` | Steps 2–3 — validates state, exchanges temporary code for access token, stores in Vault, redirects to dashboard |
| `src/app/api/webhooks/[provider]/route.ts` | Receives OwnerRez webhook POSTs authenticated via HTTP Basic Auth. Handles `application_authorization_revoked` and entity-change events. Always returns 200 immediately, offloads processing to Inngest. |

### Middleware (`proxy.ts` in project root)

Next.js middleware. Already bypasses these routes (no auth required):
- `/api/webhooks/` — OwnerRez POSTs here without a FieldStay session
- `/api/integrations/` — OAuth callback arrives without a session
- `/ownerrez` — Marketplace landing page, handles its own auth state

### `/ownerrez` Landing Page (`src/app/ownerrez/page.tsx`)

Marketing landing page for users arriving from the OwnerRez marketplace. Currently live and deployed. See Task 1 for required changes.

---

## OwnerRez API — Critical Details

**Base URL:** `https://api.ownerrez.com/`
**Auth for API calls:** Bearer token — `Authorization: Bearer at_xxxxxxxx`
**Auth for OAuth token exchange:** HTTP Basic — username = Client ID (`c_xxx`), password = Client Secret (`s_xxx`)
**Auth for webhook verification:** HTTP Basic — username/password set in OwnerRez OAuth app settings

### Mandatory User-Agent Header

Every request to `api.ownerrez.com` MUST include:

```
User-Agent: FieldStay/1.0 (OWNERREZ_CLIENT_ID)
```

Where `OWNERREZ_CLIENT_ID` is the value of the `OWNERREZ_CLIENT_ID` environment variable. A missing or malformed User-Agent returns a 403.

### Key OwnerRez Behaviors

- **No refresh tokens.** Access tokens (`at_xxx`) are long-lived and never expire unless revoked. Do not implement any token refresh logic.
- **Temporary codes expire in 10 minutes** and are single-use.
- **`since_utc` parameter** is available on `GET /v2/bookings` and `GET /v2/guests` for incremental sync — always use this for non-initial syncs.
- **Pagination:** All list endpoints return paged results. Always handle `next_page_token` or equivalent until exhausted.

### OwnerRez OAuth Endpoints

```
Authorization: https://app.ownerrez.com/oauth/authorize
Token exchange: POST https://api.ownerrez.com/oauth/access_token
Token revocation: DELETE https://api.ownerrez.com/oauth/access_token/<token>
```

### Token Exchange Response Shape

```json
{
  "access_token": "at_foobarbaz",
  "token_type": "bearer",
  "scope": "all",
  "user_id": 123456
}
```

---

## Environment Variables

These must exist in `.env.local` and in Vercel project settings. Do not hardcode any values.

```bash
# OwnerRez OAuth App credentials
OWNERREZ_CLIENT_ID=c_xxxxxxxxxxxx
OWNERREZ_CLIENT_SECRET=s_xxxxxxxxxxxx

# HTTP Basic Auth credentials for incoming OwnerRez webhooks (you set these)
OWNERREZ_WEBHOOK_USER=ownerrez-webhook
OWNERREZ_WEBHOOK_PASSWORD=your-strong-password

# App URL (no trailing slash)
NEXT_PUBLIC_APP_URL=https://fieldstay.app

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://vpmznjktllhmmbfnxuvk.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...   # Server-side only — never expose to the browser or client components
```

---

## Supabase Client Patterns

**Server-side (Route Handlers, Server Components, Inngest functions):**
```typescript
import { createClient } from '@supabase/supabase-js'

// Use service-role for Vault RPCs and any server-only writes
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
)
```

**Session-aware (Route Handlers that also read cookies):**
Use `createServerClient` from `@supabase/ssr` with the `cookies()` API. See existing connect/callback routes for the exact pattern including the `NextResponse.next()` accumulator and `makeRedirect()` helper.

**PowerSync — NEVER sync integration tables:**
The tables `integration_connections`, `oauth_states`, and anything in the `vault` schema must NEVER be added to the PowerSync publication. Access tokens must never reach the client. The PowerSync publication is an explicit allowlist — these tables are already excluded and must stay that way.

---

## Supabase Data API Grants (Required for New Tables)

Any new table created in the `public` schema after May 30, 2026 requires explicit grants before PostgREST/supabase-js can access it. When creating a new migration that adds tables, always append:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_new_table TO anon, authenticated;
```

---

## Tasks

---

### Task 1 — `/ownerrez` Landing Page: Remove Pricing + Auth-Aware CTA

**File:** `src/app/ownerrez/page.tsx`

**Change 1 — Remove pricing:** The page must not display any pricing information. Remove any pricing section, tier comparison, or cost references if present. The value proposition should stand on its own without pricing.

**Change 2 — Auth-aware CTA:** The "Get Started Free →" button and the sign-up form currently link to `#`. This must be replaced with auth-aware behavior:

```
User is NOT logged in  →  href="/signup?provider=ownerrez&next=/api/integrations/ownerrez/connect"
User IS logged in      →  href="/api/integrations/ownerrez/connect"
```

Implementation approach:
- This is a Server Component — use Supabase's `createServerClient` to check the session server-side
- If no session: render the sign-up form / "Get Started Free" button pointing to the signup URL above
- If session exists: replace the sign-up form with a single "Connect OwnerRez" button pointing to the connect route
- The connect route already handles the redirect to OwnerRez — no additional logic needed here

**Confirmed (OwnerRez):** OwnerRez does not pass any user identifiers in the marketplace redirect. Users arrive completely unauthenticated with no query parameters. The sign-up form approach is correct as-is — no special parameter forwarding required.

---

### Task 2 — Post-Connect Webhook Subscription

**No code required.**

Confirmed with OwnerRez: the global Webhook URL configured in the OAuth app settings automatically receives entity-change events for all connected users. No `POST /v2/webhooksubscriptions` call is needed per user after connect.

**Manual step required in OwnerRez dashboard (done once by FieldStay, not per user):**
Go to the OAuth app settings and select the desired webhook types from the "Types" dropdown:
`https://app.ownerrez.com/settings/api/589413933/appedit`

Recommended types to enable: **Bookings**, **Guests**.

---

### Task 3 — OwnerRez API Client Module

**New file:** `src/lib/integrations/providers/ownerrez-api.ts`

Create a typed, reusable API client class. Every method must:
- Retrieve the access token for a given `userId` via `vault_get_integration_token` RPC (using the admin client)
- Set `Authorization: Bearer <token>` on all requests
- Set `User-Agent: FieldStay/1.0 (${process.env.OWNERREZ_CLIENT_ID})` on all requests
- Handle HTTP 401 → mark the connection as `status: 'error'` in `integration_connections` and throw a typed `TokenRevokedError`
- Handle HTTP 429 → throw a typed `RateLimitError` with the `Retry-After` header value attached (Inngest will use this for backoff)
- Handle pagination automatically — all list methods must fetch all pages and return a complete array

Minimum methods required for sync tasks:

```typescript
class OwnerRezApiClient {
  constructor(private userId: string) {}

  async getProperties(): Promise<OwnerRezProperty[]>
  async getBookings(params: { propertyIds?: number[]; sinceUtc?: string }): Promise<OwnerRezBooking[]>
  async getGuests(params: { sinceUtc?: string }): Promise<OwnerRezGuest[]>
  async getCurrentUser(): Promise<OwnerRezUser>
  async deleteAccessToken(token: string): Promise<void>  // Used during revocation
}
```

**Confirmed (OwnerRez):** `User-Agent: FieldStay/1.0 (OWNERREZ_CLIENT_ID)` is the correct and approved format.

---

### Task 4 — In-App Connect UI (Settings Page)

**New file:** `src/app/(app)/settings/integrations/page.tsx`

For existing FieldStay users who did not arrive from the OwnerRez marketplace, they need a way to connect OwnerRez from inside the app.

Requirements:
- Show a list of available integrations from `integration_providers` (SELECT WHERE `is_active = true`)
- For each provider, check `integration_connections` for a row matching the current `user_id` and `provider_id`
- **Connected state:** Show provider name, connected date, external user ID, a "Disconnect" button
- **Not connected state:** Show provider name, description, a "Connect" button linking to `/api/integrations/ownerrez/connect`
- **Disconnect flow:** Clicking "Disconnect" should call a Server Action that:
  1. Retrieves the access token from Vault
  2. Calls `DELETE https://api.ownerrez.com/oauth/access_token/<token>` using HTTP Basic Auth (client_id:client_secret)
  3. Calls `vault_delete_integration_token` to remove from Vault
  4. Deletes the row from `integration_connections`

Add a link to this page from the existing app navigation/settings area.

---

### Task 5 — Inngest Sync Functions

**New directory:** `src/inngest/functions/ownerrez/`

#### 5a — Initial Sync (`ownerrez-initial-sync.ts`)

Triggered by the `integration/ownerrez.connected` event dispatched from the callback route (Task 2).

Steps (use Inngest `step.run()` for each so failures are independently retried):

1. `step.run('fetch-properties')` — Call `client.getProperties()`, upsert into `public.properties` (see data mapping below)
2. `step.run('fetch-bookings')` — Call `client.getBookings({ propertyIds: [...] })`, upsert into `public.bookings`
3. `step.run('update-last-synced')` — Write `last_synced_at = now()` and `sync_cursor` (latest `updated_at` from OwnerRez) into `integration_connections.metadata`

#### 5b — Incremental Sync (`ownerrez-incremental-sync.ts`)

Triggered by:
- Inngest cron: every 15 minutes (`0/15 * * * *`)
- Webhook event dispatch from `src/app/api/webhooks/[provider]/route.ts` when an entity-change event arrives

For each connected user (SELECT from `integration_connections` WHERE `provider_id = 'ownerrez'` AND `status = 'active'`):

1. Read `sync_cursor` from `metadata`
2. Call `client.getBookings({ sinceUtc: sync_cursor })` and `client.getGuests({ sinceUtc: sync_cursor })`
3. Upsert results
4. Update `sync_cursor` and `last_synced_at`

Use `step.run()` per user so one failure doesn't block others. Use `step.sleep()` with appropriate backoff if a `RateLimitError` is caught.

---

### Task 6 — OwnerRez → FieldStay Data Mapping

When upserting OwnerRez data into FieldStay tables, use `ON CONFLICT DO UPDATE` (upsert). Track the source so OwnerRez-originated records can be distinguished:

#### Properties mapping

OwnerRez `GET /v2/properties` → `public.properties`

| OwnerRez field | FieldStay column |
|---|---|
| `id` | `external_id` (add this column — see migration note below) |
| `name` | `name` |
| `bedrooms` | `bedrooms` |
| `bathrooms` | `bathrooms` |
| `max_occupancy` | `max_guests` |
| *(static)* | `org_id` — resolve from `integration_connections.user_id` → `organization_members.org_id` |

#### Bookings mapping

OwnerRez `GET /v2/bookings` → `public.bookings`

| OwnerRez field | FieldStay column |
|---|---|
| `id` | `external_id` (add this column — see migration note below) |
| `arrival` | `checkin_date` |
| `departure` | `checkout_date` |
| `guest.name` | `guest_name` |
| `guest.email` | `guest_email` |
| `status` | `status` (map: `confirmed`→`confirmed`, `cancelled`→`cancelled`) |
| `channel_name` | `source` (map to closest `booking_source` enum value; default `other`) |
| *(static)* | `org_id` — resolved same as above |

#### Migration required before Task 6

Create a new migration that adds `external_id` and `external_source` columns to `properties` and `bookings`:

```sql
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS external_source text;

CREATE UNIQUE INDEX IF NOT EXISTS properties_external_id_source_idx
  ON public.properties (external_id, external_source)
  WHERE external_id IS NOT NULL;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS external_source text;

CREATE UNIQUE INDEX IF NOT EXISTS bookings_external_id_source_idx
  ON public.bookings (external_id, external_source)
  WHERE external_id IS NOT NULL;

-- Data API grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.properties TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bookings TO anon, authenticated;
```

Upsert key for properties: `(external_id, external_source)`.
Upsert key for bookings: `(external_id, external_source)`.

---

## Code Style & Conventions

- **TypeScript strict mode.** No `any`. Define explicit types for all OwnerRez API responses.
- **No inline secrets.** All credentials via `process.env`. Throw at startup if required vars are missing.
- **Server Actions and Route Handlers** use the service-role client for all Vault and integration writes.
- **Errors are never swallowed.** Log with context (`[OwnerRez:userId]` prefix), then rethrow or return a typed error response.
- **Webhooks always return 200 immediately.** Process asynchronously via Inngest. A slow or throwing handler must not cause OwnerRez to retry.
- **No PowerSync sync for integration tables.** Do not add `integration_connections`, `oauth_states`, or any token-bearing table to the PowerSync publication under any circumstances.
- **Import paths:** Use `@/` alias for `src/` imports throughout.

---

## OwnerRez Questions — All Resolved

All questions have been answered by `partnerhelp@ownerrez.com`. No placeholders remain.

1. **Marketplace redirect context** — OwnerRez does NOT pass any user identifiers. Users arrive unauthenticated with no query parameters. Standard signup flow applies. *(Task 1 updated)*

2. **Webhook subscriptions** — Global Webhook URL automatically covers all connected users. No per-user API call needed. Webhook types must be selected manually in the OwnerRez dashboard once. *(Task 2 requires no code — see manual step)*

3. **User-Agent format** — `FieldStay/1.0 (OWNERREZ_CLIENT_ID)` is confirmed correct. *(Task 3 updated)*

4. **Reviews write endpoint** — No `POST /v2/reviews` endpoint exists or is planned. Submit a feature request via the OwnerRez forum if desired. *(No task impact)*
