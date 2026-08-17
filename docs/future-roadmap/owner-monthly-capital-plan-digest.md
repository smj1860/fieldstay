# Monthly Capital Planning email digest for owners

**Status:** Proposed, not started. Came out of a conversation following the
2026-08-15 asset-health/capital-planning follow-up work (PR #628) — the user
asked whether Capital Planning should also reach owners as a recurring
report, not just a page they have to think to visit.

**Concept:** once a month, email property owners who've been opted into
Capital Plan sharing a short summary of their forecasted replacement costs —
mirroring the PM's existing daily wrap-up email, but monthly, owner-facing,
and scoped to Capital Planning only.

---

## Why this shape

Owner Portal already has a *live view* of this data — `property_owners
.share_capital_plan` is a PM-controlled opt-in flag that, when true, surfaces
the org's CapEx forecast (filtered to that owner's properties) inside the
portal (`app/owner/[token]/load-owner-portal-data.ts:508-514`, toggled from
`app/(dashboard)/owners/owners-manager.tsx`'s `CapitalPlanToggle`). What
doesn't exist is anything that *pushes* — an owner has no reason to
proactively check a page that changes once a month at most. A daily-wrapup-
style digest email is the natural complement: pull → push, same as the PM
side already has (live notification bell + daily wrap-up email).

The other reason to model this on `daily-wrapup.ts`
(`lib/inngest/functions/cron/daily-wrapup.ts`) specifically, rather than
inventing a new shape: it already solves the two hard parts of "not annoying
the recipient" — per-tenant fan-out so the compute doesn't scale linearly
inside one function run, and a diff-against-last-time pattern
(`diffDigestSnapshot`) so the email doesn't just repeat the same numbers
every send. Both problems apply here too.

---

## Scope

- Property owners only — this does not touch PM-facing Capital Planning at
  all, and does not change how or when `asset_capex_recommendations` /
  `org_milestones.capex_projection_{year}` get computed.
- Gated on the existing `share_capital_plan` flag as a prerequisite (an
  owner not opted into the live view should not start getting emails about
  it) — see the consent open question below for whether that flag alone is
  *sufficient* or whether email needs its own opt-in.
- Monthly cadence only, timed to run after the existing projection refresh.

---

## What already exists and is directly reusable

- **`generateCapexProjections`** (`lib/inngest/functions/capex-projections.ts:38`)
  already regenerates `org_milestones.capex_projection_{year}` monthly, cron
  `0 0 1 * *`. The new digest cron should run *after* this — same day or the
  next — not on an independent schedule, or it risks reading a stale
  milestone from the month before.
- **`filterCapexToOwnedProperties`** (`app/owner/[token]/load-owner-portal-data.ts:235`)
  already does exactly the "narrow the org-wide projection down to this
  owner's properties" work the live portal uses. It's currently a
  module-private function in an `app/` route file — needs to be exported (or
  moved to a shared `lib/` module) to be callable from an Inngest function,
  but the logic itself doesn't need to change.
- **`owner_portal_tokens`** already has everything needed to link back to
  the live portal from the email: `token`, `expires_at` (90 days,
  `app/(dashboard)/owners/actions.ts:105`), `revoked_at`. No new token
  concept needed — reuse the existing row for that `property_owner_id` if
  one exists and is still valid.
- **`emails/owner-portal.tsx`** is the existing owner-facing Resend template
  (portal-link email) and the pattern to follow for tone/layout
  (`EmailLayout`, CTA button, footer note) — owner-facing templates
  currently live in the root `emails/` directory, distinct from
  `lib/resend/emails/` where the PM-facing cron templates
  (`daily-wrapup.tsx`, `pm-alert.tsx`) live. Worth deciding which directory
  this new one belongs in before writing it — see open questions.
- **`notification_digest_state`** (PK `(org_id, category)`,
  `diffDigestSnapshot()` in `lib/inngest/helpers.ts:482`) is the existing
  "what's new since last time" mechanism. It's currently org-scoped, not
  owner-scoped — extending it (or adding an owner-scoped sibling) is
  probably the smallest path to the same diffing behavior, rather than
  building a new mechanism from scratch.
- **Fan-out shape** — `dailyWrapUp` (finds candidates, dispatches one event
  per org) / `dailyWrapUpOrg` (per-org compute + send) is the exact
  structural template to copy: enumerate via `fetchAllRows` (an unbounded
  `.select()` on a platform-wide cron silently truncates at PostgREST's
  `max_rows = 1000`, per CLAUDE.md's Supabase-patterns section), fan out via
  `step.sendEvent`, one event per org, each running under its own
  concurrency cap.
- **Resend idempotency pattern** — `daily-wrapup.ts:580-582`'s
  `idempotencyKey` + swallow-the-409-as-success handling
  (`isIdempotencyConflict`) is directly reusable; just needs a key shaped
  around whatever the final send-grouping unit turns out to be (see below).
- **Audit logging precedent** — `owner_portal.capital_plan.accessed`
  already exists (`load-owner-portal-data.ts:270-278`) for the live-view
  case, logged without PII. A parallel `owner_portal.capital_plan.emailed`
  action would need adding to the `AuditAction` union in `lib/audit.ts`.

---

## What's missing / needs to be built

### 1. A batched "who gets this" query

No helper currently resolves "every `property_owners` row with
`share_capital_plan = true` and a non-null `email`, across N orgs" the way
`getPmEmailsByOrgIds`/`getPmMembersByOrgIds` do for PMs
(`lib/inngest/helpers.ts:250-279`). This needs to be new, paginated
(`fetchAllRows`), and org-scoped per the N+1 guardrail — the per-org handler
should do one query for that org's shared owners, not one query per owner.

### 2. Deciding the grouping unit — the central open design question

`property_owners` is a **per-property** row. An owner with three properties
in the portfolio has three separate rows (and potentially three separate
`share_capital_plan` flags, independently toggled). Two real options:

- **(A) One email per `property_owners` row.** Simple, matches the existing
  data model exactly, no new grouping logic. Downside: an owner with
  multiple properties gets multiple emails in the same run, which reads as
  spammy from the owner's side even though each one is legitimate.
- **(B) One email per owner identity, bundling every shared property they
  have.** Better recipient experience, but `property_owners` has no stable
  "this is the same human across rows" key today — the closest thing is
  `email`, and that's an assumption (co-owners on a shared property are
  legitimately two different `property_owners` rows with two different
  emails; that's not the same problem). `owner_portal_tokens.is_multi` +
  `property_ids` already models a multi-property owner for portal *access*,
  but a token is provisioned per grouping the PM already set up manually
  (`generatePortalToken`/`app/(dashboard)/owners/actions.ts`) — it's not
  guaranteed to exist or be complete for every multi-property owner.

Recommend (B) for UX, but flag that it may mean grouping by `email` as a
pragmatic proxy rather than a fully modeled "owner identity," and that
should be a conscious call, not a default fallen into.

### 3. New Inngest cron + event

- Register `org/capital_plan_digest.requested` in `lib/inngest/events.ts`
  (mirrors `org/daily_wrapup.requested`'s shape).
- New file `lib/inngest/functions/cron/capital-plan-owner-digest.ts` (or
  similar), two functions mirroring `dailyWrapUp`/`dailyWrapUpOrg`:
  fan-out cron finds orgs with ≥1 opted-in owner, per-org function resolves
  those owners, builds and sends.
- Register both in `app/api/inngest/route.ts`'s single `serve()` call.
- Schedule: after `generateCapexProjections`'s `0 0 1 * *` — something like
  `0 12 1 * *` (noon UTC, same day) or the 2nd of the month if same-day
  timing against a platform-wide fan-out feels too tight. Needs to be
  decided against how long the projection fan-out actually takes to
  complete for every org at current portfolio counts.

### 4. New Resend template

Owner-facing, so probably belongs in `emails/` alongside `owner-portal.tsx`
rather than `lib/resend/emails/` — but that split isn't formally documented
anywhere in this codebase, just observed from what's there today, so worth
confirming rather than assuming. Content needs its own pass, not a reuse of
Capital Planning's PM-facing copy verbatim:

- The reserve-fund number and next-12-months total (`page.tsx`'s existing
  math, already filtered by property) are safe to show as-is — they're
  already framed for a non-technical reader.
- Repair-vs-Replace **reasoning text** (`buildCapexRecommendation()` in
  `lib/assets/repair-vs-replace.ts`) is written for a PM deciding what to
  do next, not for an owner reading a monthly summary — e.g. naming a
  specific dollar ratio against a 50% threshold assumes context an owner
  doesn't have. This likely needs a separate, softer owner-facing sentence
  per recommendation rather than reusing `reasoning[0]` directly.
- Open question: does the owner-facing version show raw health scores /
  "End of Life" labels at all, or only $ and year? Showing a blunt
  end-of-life label on an owner's own asset without the PM having framed it
  first risks reading as alarming, or as FieldStay speaking over the PM's
  head to their client.

### 5. Diffing / "what's new" vs. full snapshot

Two options, not mutually exclusive:

- Full current-state snapshot every month (simplest, always accurate, but
  can feel repetitive if nothing changed).
- Lead with what changed since last month (extend `diffDigestSnapshot`'s
  pattern to be owner-scoped, e.g. category key incorporating
  `property_owner_id`), falling back to "nothing new this month, here's
  where things stand" when the diff is empty — closer to how the PM daily
  wrap-up already behaves for its sections.

Recommend the second, but it's a real product-feel decision, not just an
implementation one.

### 6. Consent — is `share_capital_plan` alone enough?

Today, `share_capital_plan` only ever produces a *passive* surface — the
data sits in a portal an owner has to visit. A monthly email is an
active push into someone's inbox, a different kind of commitment. Worth
deciding whether to:

- Reuse `share_capital_plan` as-is (simplest, but conflates "show this if
  they look" with "proactively email them"), or
- Add a second, explicit flag (e.g. `email_capital_plan_digest`) so a PM
  can share the live view without opting an owner into recurring email, or
  vice versa.

### 7. Testing

- Unit coverage for the new batched-owner-resolution helper, same shape as
  existing `getPmEmailsByOrgIds` tests — including the N+1 guardrail
  (`unit/guardrails/n-plus-one-loops.test.ts`) actually passing against the
  new code.
- Cron/dispatch tests mirroring `unit/inngest/*daily-wrapup*` (if such a
  test file exists — confirm before assuming the coverage shape).
- Idempotency test: same digest key sent twice in one run doesn't double-
  send (mirrors the `isIdempotencyConflict` swallow behavior).

---

## Open questions to resolve before implementation

- Per-property-owner-row emails, or bundled-by-owner-identity emails (see
  §2 above) — and if bundled, is grouping by `email` acceptable as the
  proxy for "same person"?
- Does this need its own consent flag, or does `share_capital_plan` cover
  it (see §6)?
- Full snapshot every month, or lead-with-what's-new (see §5)?
- Exact cron time relative to `generateCapexProjections` — needs a real
  answer for how long that fan-out takes across the current org count, not
  a guess.
- Should health scores / recommendation labels appear at all in the
  owner-facing copy, or only dollar figures and timing?
- `emails/` vs. `lib/resend/emails/` for the new template — confirm the
  audience-vs-trigger split actually holds as an intentional convention
  before following it.

## Out of scope

- Any change to the live Owner Portal Capital Planning view itself — this
  is additive (a push channel on top), not a replacement.
- A PDF/downloadable version — the PM-facing Capital Planning page already
  has CSV export and a CPA depreciation PDF export; those are a different
  audience and mechanism from this.
- SMS delivery — guest SMS infrastructure (Telnyx, `SMS_ENABLED`) is a
  separate system built for guests, not owners, and isn't a fit here.
- Any change to how Repair-vs-Replace recommendations or the Weibull
  health-scoring curve are computed — this only reads and reformats
  existing output for a different audience.
- A configurable send frequency (weekly/quarterly/etc.) — start monthly
  only, matching the existing projection-refresh cadence; a frequency
  picker is a bigger settings surface and a separate follow-up if there's
  ever demand for it.
