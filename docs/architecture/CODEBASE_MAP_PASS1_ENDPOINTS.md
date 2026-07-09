# Codebase Map — Pass 1: Incoming Data Endpoints

Every place external data or requests enter FieldStay. This is the boundary
layer other passes (data flow, outgoing effects, UI surfaces) will build on.

Four boundary categories exist:
1. **Route Handlers** (`route.ts`) — raw HTTP, own their own auth
2. **Server Action–backed pages** — Next.js pages whose forms/buttons call
   Server Actions; the "auth" is really whatever the Server Action checks
3. **Token-gated public pages** — no session, a URL-embedded token is the
   credential, checked directly against a DB column in the page itself
4. **The Inngest route** — a single HTTP endpoint that fans out internally
   to ~70 event-driven functions signed by Inngest's own mechanism, not ours

---

## 1. Third-Party Webhooks (signature/HMAC verified, no user session)

| Route | Provider(s) | Verification |
|---|---|---|
| `app/api/webhooks/stripe/route.ts` | Stripe (platform) | `stripe.webhooks.constructEvent()` + `STRIPE_WEBHOOK_SECRET` |
| `app/api/webhooks/stripe-connect/route.ts` | Stripe Connect (vendor payouts) | `stripe.webhooks.constructEvent()` + Connect webhook secret |
| `app/api/webhooks/telnyx/route.ts` | Telnyx (inbound SMS: STOP/START, replies) | Ed25519 signature verification |
| `app/api/webhooks/[provider]/route.ts` | Hospitable, OwnerRez (dynamic `[provider]` segment) | Per-provider adapter's `validateWebhook()` — HMAC (Hospitable) or Basic Auth (OwnerRez), per the Integration Registry pattern in `CLAUDE_INTEGRATIONS.md` |

All four call `createServiceClient()` (RLS bypass) since there is no
authenticated user — the signature/HMAC check IS the trust boundary.

---

## 2. OAuth Callbacks

| Route | Purpose |
|---|---|
| `app/auth/callback/route.ts` | The real public URL Google OAuth redirects to. Re-exports `GET` from `app/(auth)/callback/route.ts` — **same handler, two URL paths**, not a duplicate. The route group `(auth)` doesn't appear in the URL, so that file alone resolves to `/callback`; this file exists solely to also serve `/auth/callback`, which is what's registered with the OAuth provider. |
| `app/(auth)/callback/route.ts` | Actual implementation: `exchangeCodeForSession(code)`, sanitizes the post-login redirect (`sanitizeRedirectPath` — rejects protocol-relative/absolute URLs), handles org-invite acceptance via `invite_token` query param, fires audit events (`auth.oauth.callback`, `auth.account.created`) fire-and-forget. |
| `app/api/integrations/[provider]/callback/route.ts` | OAuth callback for **integration** connections (Kroger, Hospitable, OwnerRez, etc.) — distinct from user-login OAuth above. Requires an authenticated dashboard user (`getUser()` + `createServiceClient()` to store tokens). |

---

## 3. Public Token-Gated Routes (no session — DB-stored token is the credential)

These are the routes/pages external, non-authenticated parties (vendors,
owners, guests, crew invitees) land on directly from an emailed/texted link.

### `route.ts` (JSON/redirect responses)
| Route | Token column | Consumer |
|---|---|---|
| `app/api/vendor-connect/[token]/onboard/route.ts` | `stripe_connect_token` (via `vendors`) | Vendor — starts Stripe Connect onboarding |
| `app/api/vendor-connect/[token]/refresh/route.ts` | same | Vendor — Stripe's "link expired" redirect target; re-redirects to `onboard` |
| `app/api/vendor-connect/[token]/return/route.ts` | same | Vendor — Stripe's post-onboarding redirect; renders holding page pending `account.updated` webhook |
| `app/api/work-orders/[token]/complete/route.ts` (GET, POST) | WO completion token | Vendor — mark a work order complete without logging in |
| `app/api/work-orders/[token]/quote/route.ts` (GET, POST) | WO quote token | Vendor — submit a quote without logging in |

### Pages backed by Server Actions (no `route.ts`, token checked in the page itself)
| Page | Token column | Consumer |
|---|---|---|
| `app/crew-invite/[token]/page.tsx` | `organization_members.invite_token` | Prospective crew member accepting an org invite |
| `app/owner/[token]/page.tsx` | `owner_portal_tokens.token` | Property owner — read-only P&L/turnover portal, scoped to the token's `org_id` |
| `app/vendor-connect/[token]/status/page.tsx` | `vendors.stripe_connect_token` | Vendor — Connect onboarding status badge |
| `app/work-orders/[token]/page.tsx`, `.../quote/page.tsx` | WO tokens | Vendor-facing UI wrapping the routes above |
| `app/g/[slug]/page.tsx` | `guidebook_property_configs.slug` (not a secret token — public marketing-style slug) | Guest — public property guidebook |
| `app/g/b/[token]/page.tsx` | `bookings.guidebook_token` | Guest — booking-specific guidebook (personalized: check-in/out dates) |
| `app/g/b/[token]/opt-in/page.tsx` | same | Guest — SMS opt-in consent capture (TCPA-relevant; writes `guidebook_guest_sms_optins`) |
| `app/g/kit/[media_kit_token]/page.tsx` | `guidebook_sponsors.media_kit_token` | Prospective local-business sponsor — public media kit / self-serve checkout entry point |

`app/api/guidebook/sponsor-checkout/route.ts` (POST) belongs here too: it
takes a `mediaKitToken` in the JSON body (not the URL) and hands it to the
`createSponsorCheckoutSession` Server Action, which re-validates the token
before creating a Stripe Checkout session.

---

## 4. Authenticated Dashboard Routes (PM-facing, session required)

All go through `requireOrgMember()` (or `requireAuth()` for the two that
don't need an org yet) — see `CLAUDE.md`'s Auth pattern section.

```
app/api/assets/capex-csv/route.ts          [GET]  requireOrgMember
app/api/assets/cpa-export/route.ts         [GET]  requireOrgMember
app/api/assets/scan-data-plate/route.ts    [POST] requireOrgMember
app/api/integrations/health/route.ts       [GET]  requireOrgMember
app/api/invoices/[invoiceId]/checkout/route.ts [POST] requireOrgMember
app/api/milestones/dismiss/route.ts        [POST] requireOrgMember
app/api/milestones/review-clicked/route.ts [POST] requireOrgMember
app/api/milestones/seen/route.ts           [POST] requireOrgMember
app/api/repuguard/generate/route.ts        [POST] getUser() + createServiceClient
app/api/support/chat/route.ts              [POST] requireOrgMember
app/connect/finish/route.ts                [GET]  requireAuth (no org yet — mid-onboarding)
app/api/integrations/[provider]/connect/route.ts [GET] getUser() + createServiceClient
```

`app/api/account/delete/route.ts` [DELETE] and `app/api/gdpr/export/route.ts`
[GET] use the inline `getUser()` pattern rather than `requireOrgMember()`
since account deletion/data export are account-level, not org-scoped
operations.

---

## 5. Crew-Authenticated Routes (PWA, session + `crew_members` row required)

All use the inline pattern from `CLAUDE.md` (no shared helper exists yet):
```typescript
const { data: { user } } = await supabase.auth.getUser()
const { data: crew } = await supabase.from('crew_members').select('id, org_id').eq('user_id', user.id).single()
```

```
app/api/crew/feedback/route.ts                      [POST]
app/api/crew/inventory-count/route.ts               [POST]
app/api/crew/issue-reports/route.ts                 [POST]
app/api/crew/push-subscribe/route.ts                [POST]
app/api/crew/turnovers/[id]/complete/route.ts       [POST]
app/api/crew/turnovers/[id]/start/route.ts          [POST]
app/api/crew/work-orders/[id]/complete/route.ts     [POST]
app/api/dashboard/push-subscribe/route.ts           [POST]  (PM push subscribe, same inline pattern, dashboard side)
app/api/support-inbox/reply/route.ts                [POST]
app/api/support-inbox/resolve/route.ts              [POST]
```

Note: these routes receive requests directly (not via Dexie) — the
Dexie-first rule in `CLAUDE.md` governs *reads* in crew PWA client
components, not the route handlers those writes ultimately sync to.

---

## 6. Unauthenticated by Design

| Route | Reason |
|---|---|
| `app/api/health/route.ts` | Uptime monitor ping every 3 min. Does a trivial `organization_members` read to confirm DB connectivity, returns no data, no auth. |

---

## 7. The Inngest Boundary

`app/api/inngest/route.ts` — single `serve()` call, ~70 registered functions
(`lib/inngest/events.ts` → `FieldStayEvents`). Inngest's own request-signing
verifies inbound calls; **this is not user auth** and none of the standard
helpers apply here.

Two sub-classes worth distinguishing for later passes:
- **Externally-triggered**: functions invoked via `{ event: '...' }` where
  the `inngest.send()` call originates from one of the webhook/token routes
  above (e.g. a Stripe webhook enqueueing `integration/connection.error`,
  or `integration/ownerrez.connected` firing a sync). These are where an
  external boundary event above becomes an internal event.
- **Internally/cron-triggered**: functions invoked via `{ cron: '...' }`
  only, with no external trigger at all (e.g. `ownerrez-reviews-sync`'s
  `0 */6 * * *`, `maintenance-schedules` cron check). No external party
  causes these to fire — they're time-driven, not data-boundary-driven.

Mapping every one of the ~70 events to its trigger source is scoped to a
later pass, not Pass 1.

---

## Summary Table

| Category | Count | Trust mechanism |
|---|---|---|
| Third-party webhooks | 4 routes (Stripe ×2, Telnyx, `[provider]` ×2 providers) | Signature/HMAC |
| OAuth callbacks | 3 routes | Supabase/provider code exchange |
| Public token-gated | 5 `route.ts` + 9 pages | DB-stored token match |
| Authenticated dashboard | 12 routes | `requireOrgMember`/`requireAuth`/session |
| Crew-authenticated | 10 routes | Session + `crew_members` row |
| Unauthenticated (intentional) | 1 route | None — health check |
| Inngest | 1 route, ~70 functions | Inngest request signing |

**36** `route.ts` files + **1** Inngest mega-endpoint + **9** token-gated
Server-Action pages = the full incoming-data boundary.
