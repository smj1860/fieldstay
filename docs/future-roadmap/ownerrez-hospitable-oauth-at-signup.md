# OwnerRez/Hospitable: trigger OAuth at signup itself

**Status:** Proposed, not started. Follow-up to the marketplace-CTA fix
shipped 2026-07-26 (see git history: "Fix marketplace signup CTAs to route
through onboarding before OAuth"), which explicitly deferred this as a
future iteration.

**Concept:** a visitor arriving from the OwnerRez or Hospitable marketplace
listing, clicking "Start Free Trial" / "Create your FieldStay account,"
should land on the provider's OAuth consent screen immediately after
completing signup — no intermediate "name your organization" form, no
manual "click Connect" step. Org creation happens invisibly, using a
placeholder name, so nothing blocks OAuth from firing at the earliest
possible moment.

---

## Why this shape, not the alternatives considered

The user framed three candidate approaches for the org-name problem (OAuth
needs an `org_id` to exist somewhere downstream; the current onboarding
flow captures that name from the user *before* OAuth ever fires):

- **(A) Placeholder org name at signup, renamed later** via the existing
  onboarding `name-org` step or Settings.
- **(B) Raw signup email as the permanent `organizations.name`** — no
  placeholder, no rename step needed.
- **(C) Raw email as the permanent DB `name`, plus a separate UI-facing
  "display name"** that the onboarding step would set instead of ever
  touching the real `name` column.

**Recommendation: (A), with one refinement — derive the placeholder from
the signup form's `full_name` field, not a generic string, and never from
email.**

### Why not (B) — raw email as the org name

`organizations.name` is not a private, backend-only field today. It is
read and surfaced to real third parties in several live code paths:

- **Vendors** — email subject/body and SMS: `app/actions/work-order-public.ts:102,125`
  (`dispatcherOrg`/`org_name` fed into the `vendor_work_order` SMS
  template), `lib/resend/emails/vendor-invoice-paid.tsx:38,72`,
  `lib/resend/emails/vendor-compliance-nudge.tsx:37,60,67`,
  `lib/resend/emails/vendor-connect-invite.tsx:22-23`,
  `lib/stripe/vendor-connect-invite.ts:145,148,224,227` (subject line:
  `` `${params.orgName} pays invoices via Stripe Connect...` ``),
  `lib/inngest/functions/work-order-events.ts:177,180`,
  `lib/inngest/functions/notify-vendor-compliance-expiring.ts:58`.
- **Property owners** — `emails/owner-portal.tsx:22` ("Hi {ownerName} —
  {orgName} has shared your property's financial ..."), threaded from
  `app/(dashboard)/owners/actions.ts:117,124`.
- **Crew** — `emails/crew-invite.tsx:14,19,21`,
  `lib/sms/telnyx.ts:253-257` (`` `${params.orgName} invited you to their
  crew on FieldStay.` ``), `app/(dashboard)/settings/actions.ts:764,874`.
- **Guidebook sponsors** — a genuine external business being sold ad
  space: `app/g/kit/[media_kit_token]/print/print-kit.tsx:25-26`
  (`` `Prepared for ${sponsor.business_name} by ${orgName}` ``), a
  printable sales one-pager.

If `name` were the raw signup email, every one of those surfaces would
put the PM's personal email address in front of a vendor, an owner, a
crew member, or a prospective sponsor business — permanently, for any org
whose PM never gets around to visiting Settings to rename it. Given there
is currently **zero** friction pushing a PM to rename anything once
connected (see "Rename nudge" below — that has to be added regardless of
approach), a meaningful fraction of orgs would carry a raw email as their
permanent public-facing name indefinitely. Not acceptable even as a
"reasonable starting point."

(Note: guests are **not** at risk either way — grepped every
`audience: 'guest'` SMS template in `lib/sms/template-registry.ts:56-129`
and the guidebook page's rendered fields in `app/g/[slug]/page.tsx:24-138`;
`org_name`/`{{org_name}}` appears in **no** guest-facing surface, only
`vendor`/`crew` audience templates. Stripe is also unaffected — no
`stripe.customers.create/update` call anywhere sends `organizations.name`;
the one Checkout Session tied to org billing,
`app/(dashboard)/settings/actions.ts:1057-1063`, sends `customer_email`
only.)

### Why not (C) — separate DB name vs. UI display name

This solves a problem the codebase doesn't actually have. `name` has **no
uniqueness constraint** (`supabase/schema_reference.sql:1728-1776` — only
`slug` does, via `organizations_slug_key`), and nothing in the app treats
`organizations.name` as a stable, non-human-facing identifier: it's never
used in a lookup-by-name, and `slug` — the one column that *does* carry
uniqueness pressure — is written once at creation and **never read
anywhere else in the app** (grepped the full `app`/`lib` tree for
`.slug` reads on organizations; zero results outside the creation path).
There's also no existing `display_name` concept anywhere in the schema to
repurpose — this would be genuinely new schema, plus a refactor of every
call site listed above under (B) to decide which of two name columns to
read, for a benefit (B) doesn't actually need once a real placeholder
strategy is in place. Bigger blast radius, no corresponding technical
requirement.

### Why the placeholder should come from `full_name`, not "New Organization"

The signup form already collects a **Full Name** field
(`app/(auth)/signup/signup-form.tsx:135-146`) — required, not optional —
for both email/password signup and (via Google's own profile data,
available on `user_metadata.full_name`) Google signup. Deriving something
like `"{full_name}'s Organization"` costs nothing extra to collect, reads
far better than a generic `"New Organization"` repeated identically across
every vendor a multi-org vendor works with, and carries much lower
sensitivity than an email address — a name in a "so-and-so's
organization" business context is normal and expected, not something a
vendor or owner would find surprising or unprofessional the way a raw
email address would be.

---

## Scope

- **Marketplace-originated signups only** — i.e. `?provider=ownerrez` or
  `?provider=hospitable` present on the signup link. Direct (non-marketplace)
  signup keeps its existing explicit "name your organization" first-touch
  step untouched; that's a deliberate branding moment for a self-directed
  signup and shouldn't be silently skipped.
- Covers **both** auth methods — email/password (with email confirmation)
  and Google OAuth — since a marketplace visitor can use either.

---

## What already exists and is directly reusable

- **`create_organization_with_owner`** (`supabase/migrations/20260624140430_create_organization_with_owner_function.sql:12-44`)
  — the org+owner-membership insert is already one atomic, advisory-locked
  RPC call, already idempotent per user (`IF EXISTS (SELECT 1 FROM
  organization_members WHERE user_id = p_user_id) THEN RETURN NULL, false`).
  No changes needed to this function; call it from a second place.
- **Slug generation + collision handling** — currently inline in
  `app/onboarding/actions.ts:26-31` (`slugify(name)`, count-check, `-${Date.now().toString(36)}`
  suffix on collision). Should be extracted into a small shared helper
  (e.g. `lib/org/create-with-name.ts`) so both the existing onboarding
  action and the new auto-create path call one implementation, not two.
- **`app/(auth)/callback/route.ts`** — confirmed (full read) to be the
  **one shared choke point** where a real session first exists for both
  auth methods: Google lands here directly after `signInWithOAuth`; email/
  password lands here only after the user clicks the confirmation link
  (no session exists in `signup-form.tsx` unless email confirmation is
  disabled). This is where the new auto-org-creation call belongs — not in
  `signup-form.tsx`, which only reliably has a session for one of the two
  auth methods.
- **`fs-oauth-next` cookie pattern** (`components/auth/GoogleSignInButton.tsx:17-19`,
  read back in `app/(auth)/callback/route.ts:20-24`) — already solves
  exactly the "carry a value across Google's redirect, which drops query
  params" problem. The new `provider` value needs the same treatment (see
  below).
- **`app/api/integrations/[provider]/connect/route.ts`** — confirmed (full
  read) to have **zero** org dependency: it builds the authorization URL
  and redirects using only `user?.id ?? null`, no `org_id`/`organizations`
  reference anywhere. Needs no changes — it already works the moment an
  org exists by the time the OAuth callback resolves.
- **`lib/integrations/finalize-connection.ts`** — already tolerates having
  no org (skips the initial-sync event, leaves `org_id = null`) rather
  than erroring. Needs no changes; it'll just find the (now
  synchronously-created) org via its existing earliest-accepted-membership
  lookup (`finalize-connection.ts:89-96`).
- **Existing org rename path** — `app/(dashboard)/settings/settings-tabs.tsx:158-171`
  → `app/(dashboard)/settings/actions.ts:25-62` (`updateOrgSettings`)
  already does a direct `.update({ name, billing_email })` on
  `organizations`. No new rename mechanism needed — the placeholder name
  is just whatever's in that field until the PM changes it.
- **`org_milestones` + `NudgeBanner`** — the established pattern in this
  codebase for "flag an org needs a follow-up action, show a dismissible
  banner until resolved" (e.g. `kroger_store_needed` in
  `lib/inngest/functions/build-shopping-cart.ts`, rendered via
  `components/nudge-banner.tsx`). Reuse this exact pattern for the
  rename nudge rather than building something new.

---

## What's missing / needs to be built

### 1. Thread `provider` through to `/auth/callback`

Confirmed (full read of `app/(auth)/signup/signup-form.tsx`): the
`?provider=X` query param on `/signup` is read **nowhere** today — not
stored in a cookie, not in the DB, not passed into `emailRedirectTo`. It
currently only exists to be forwarded into `next`. To make it load-bearing:

- **Email/password path:** embed `provider` directly in the
  `emailRedirectTo` URL built at `signup-form.tsx:48-53` (same place
  `next`/`invite_token` are already embedded), since the confirmation
  link may be opened on a different device/browser than the one that
  submitted the form — a cookie set at signup time isn't reliably present
  at confirmation-click time.
- **Google path:** set a new cookie (`fs-oauth-provider`, mirroring
  `fs-oauth-next`'s exact pattern) in `GoogleSignInButton.tsx` before
  calling `signInWithOAuth`, read back and cleared in `/auth/callback`
  alongside the existing `fs-oauth-next` handling.

### 2. Auto-create the org in `/auth/callback`

After `exchangeCodeForSession()` succeeds, before computing the final
redirect: if a `provider` value resolved (query/cookie) **and** the user
has no existing `organization_members` row, call the shared
create-with-placeholder-name helper (see above) with a name derived from
`user_metadata.full_name`, falling back to a generic default if that's
somehow empty. Reuses `create_organization_with_owner`'s own idempotency
guard, so a duplicate/retry call is a safe no-op — no separate "have I
already done this" check needed beyond what the RPC already does.

### 3. Point `next` at the connect route again, with a safety fallback

Revert the four CTA files touched by the 2026-07-26 fix
(`components/ownerrez/PricingSection.tsx`,
`components/hospitable/PricingSection.tsx`, `app/ownerrez/page.tsx`,
`app/hospitable/page.tsx`) back to
`next=/api/integrations/{provider}/connect` — now safe, because
`/auth/callback` guarantees an org exists before that route is ever
reached. **Do not delete the `/onboarding` routing added in the prior
fix** — keep it as the fallback path for any case where auto-creation
didn't apply or failed (e.g. the `provider` value got stripped somewhere,
or the RPC errored). Never let a user reach the connect route with no org;
`/onboarding`'s existing resume-guard is the safety net.

### 4. Rename nudge

Write an `org_milestones` row (e.g. `org_name_placeholder`) at
auto-creation time; clear it the first time `updateOrgSettings` actually
changes the name away from the placeholder. Render via the existing
`NudgeBanner` pattern on `/ops` until cleared.

### 5. Rate limiting

Confirmed (full read of `lib/rate-limit.ts` + grep of every consumer):
`oauthCallbackRatelimit` is **already defined** (`lib/rate-limit.ts:172-177`)
but **wired into nothing** — not imported by
`app/api/integrations/[provider]/callback/route.ts` or `/connect/route.ts`.
Also confirmed: there is currently **no rate limiter anywhere** between
form-submit and a real org (live Stripe trial clock, 15 property slots)
existing in the DB — the only existing friction is the explicit human
step of typing an org name, which this plan removes for the marketplace
path. Two things to do together with this change, not as an afterthought:
- Wire the existing (currently dead) `oauthCallbackRatelimit` into the
  OAuth callback route.
- Add a new limiter on the auto-org-creation branch in `/auth/callback`,
  keyed by IP (mirroring `inviteAcceptRatelimit`'s existing pattern at
  `lib/rate-limit.ts:193-198`).

### 6. Testing

- Unit tests for the extracted placeholder-name/slug helper (mirror the
  existing coverage in `unit/auth/onboarding-actions.test.ts`).
- Unit/integration coverage for `/auth/callback`'s new branch: provider
  present + no org yet → org created, correct redirect; provider present
  + org already exists (retry) → no duplicate, still redirects correctly;
  provider absent → unchanged existing behavior (regression guard for
  direct signup).
- E2E: the prior fix's handoff doc already noted no email-confirmation or
  Google-OAuth automation helper exists in `e2e/helpers/` — building that
  harness is a **prerequisite** for real end-to-end coverage of this flow,
  not something this plan delivers incidentally. Flagging it here so it
  isn't rediscovered as a surprise blocker mid-implementation.

---

## Open questions to resolve before implementation

- Confirm Google populates `user_metadata.full_name` reliably in practice
  (verify against a real Google signup, not just Supabase's docs) — decide
  the fallback string if it's ever empty.
- Finalize the exact placeholder copy — this doc proposes
  `"{full_name}'s Organization"` / a generic fallback like `"New FieldStay
  Organization"` as a starting point, not final wording.
- Decide whether the rename nudge is dismissible-forever or
  persistent-but-dismissible-per-session (`NudgeBanner`'s existing
  localStorage-per-id dismiss behavior supports either).

## Out of scope

- Any change to direct (non-marketplace) signup's onboarding flow.
- Kroger or any non-PMS integration — scoped to the OwnerRez/Hospitable
  marketplace entry points only.
- Building the missing email-confirmation/Google-OAuth E2E automation
  harness itself (flagged as a prerequisite, not delivered here).
