# Codebase Map — Pass 4: UI Surfaces (Data-Access Patterns)

Passes 1–3 traced data crossing FieldStay's boundary and what happens to
it. This pass maps the presentation layer itself — not page-by-page, but
by the three genuinely distinct **data-access patterns** the app uses,
matching the split CLAUDE.md already documents: the PM dashboard reads
Supabase directly, the crew PWA never does, and a third surface (token-
gated public pages) doesn't fit either mold.

---

## 1. PM Dashboard (`app/(dashboard)/*`) — direct Supabase reads

**21 feature sections:** assets, bookings, capital-planning, comms-log,
crew-manage, guidebook, help, inventory, invoices, maintenance, messages,
ops, owners, properties, reviews, settings, setup, support-inbox,
templates, turnovers, vendors.

`templates` (added 2026-07-21) is the Templates Hub — Room Library Builder
for turnover checklists, plus org-level inventory and maintenance catalogs.
It replaced the old onboarding-only checklist/maintenance-schedule seeding
that lived under `setup/checklist-template` and `setup/maintenance-template`
(those two pages are now thin pointers into `/templates` rather than owning
their own seed data — the `org_master_checklist_items` /
`org_master_maintenance_schedules` tables they used to write to were
dropped outright, not just superseded).

**Layout-level gate** (`app/(dashboard)/layout.tsx`) runs on every
request before any page: auth check → org membership lookup → onboarding
gate (redirects to `/setup` unless the path is exempt) → billing gate
(redirects to `/billing-wall` on expired trial/cancelled/paused, unless
exempt) → pending-milestone lookup (marks it prompted) → unread message
count → staff flag. All of this feeds `DashboardShell`, a Client
Component, as props.

**Worth noting:** this layout does *not* call `requireOrgMember()` — it
inlines its own `organization_members` + `organizations` query instead,
extended with fields (`repuguard_status`, `onboarding_steps_completed`)
that `OrgMembership` (in `lib/auth.ts`) doesn't carry, and with its own
redirect logic (onboarding/billing gates) that doesn't match
`requireOrgMember()`'s behavior. So there are two independent
implementations of "look up the current user's org membership" living
side by side — not a bug, but a maintenance seam: a schema change to
`organizations` that another feature needs inside `requireOrgMember()`
won't automatically reach the layout's copy, and vice versa.

**Page-level pattern**, used consistently across all 20 sections (e.g.
`turnovers/page.tsx`):
```typescript
const { supabase, membership } = await requireOrgMember()
const [{ data: a }, { data: b }, ...] = await Promise.all([
  supabase.from('x').select(...).eq('org_id', membership.org_id),
  supabase.from('y').select(...).eq('org_id', membership.org_id),
])
// passed as props to a Client Component for interactivity
```
Every query is RLS-enforced (the user's own session, not service role)
and explicitly `org_id`-scoped per CLAUDE.md's tenant-isolation rule,
even though RLS would also catch a missing filter — belt and suspenders.

**Mutations** go through Server Actions (`app/(dashboard)/*/actions.ts`),
each starting with the same `requireOrgMember()` call — this is the
pattern documented in CLAUDE.md's "Code Patterns" section, confirmed
consistent across the section directories checked in Pass 2/3.

**No local cache, no offline support** — every navigation is a fresh
server round-trip. This is a deliberate contrast with the crew PWA below:
the PM dashboard assumes a reliable connection (office/desk use), the
crew PWA assumes it can't (crews working inside properties with poor
signal).

---

## 2. Crew PWA (`app/crew/*`) — Dexie local-first, never direct Supabase reads

**Layout-level gate** (`app/crew/layout.tsx`) is structurally different
from the dashboard's: it uses `createServiceClient()` (RLS bypass) to
look up `crew_members` by `user_id`, requiring `is_active` and
`invite_accepted_at IS NOT NULL`. A PM account that wanders into `/crew`
gets redirected to `/dashboard` **and an audit event is logged**
(`security.route.mismatch`) — the one layout in the app that treats
reaching the wrong surface as a security-relevant event worth a
permanent record, not just a silent redirect.

**Read path — `DexieProvider`** (`lib/dexie/context.tsx`), mounted once
per session:
1. On mount, pulls four domains from Supabase in parallel: assigned
   turnovers (+ derived properties + inventory_items), work orders
   (scheduled within the last two weeks or undated), messages (last 90
   days, capped at 500), and the crew member's own availability
   (30 days back to 1 year ahead) — into the matching Dexie tables via
   `bulkPut`.
2. Turnover sync also chains into a checklist pull
   (`pullChecklistsForTurnovers`) for every synced turnover.
3. Three Supabase Realtime subscriptions keep the cache live afterward:
   `turnover_assignments` (re-triggers the whole turnover+checklist
   pull), `work_orders`, and a dynamically-scoped channel covering
   `checklist_instance_items`/`checklist_instances`/`turnovers` filtered
   to just this crew member's currently-open turnovers — rebuilt
   whenever the open-turnover set changes, guarded by a generation
   counter so a slow, superseded rebuild can't clobber a newer one.
4. Client components never call Supabase directly — they read via
   `useLiveQuery(() => getDexieDb(userId).turnovers.where(...).toArray())`
   against the local IndexedDB cache, reactive without a network round
   trip.

**Write path — `enqueueMutation()` → outbox → `SyncEngine`**
(`lib/dexie/syncService.ts`):
1. A UI write calls `enqueueMutation(userId, table, targetId, op,
   payload)`, which appends a row to the local `mutations` table and
   fires `processOutbox()` in the background — the UI never waits on
   network to reflect a write locally (Dexie's own reactivity handles
   that immediately).
2. `processOutbox()` drains the queue **in insertion order**, only
   removing a mutation after it uploads successfully. On failure it
   retries (up to 5 attempts); at 3+ retries it stops draining further
   mutations for that call so records after it aren't applied
   out-of-order, but does `continue` past permanently-exhausted ones.
   At 5 retries the row is marked `failed` and kept (not deleted) — the
   UI (e.g. the crew turnover page) surfaces this and offers a manual
   retry, rather than a write silently vanishing.
3. **Per-table upload targets diverge deliberately.** Plain field
   updates (`inventory_items.current_quantity`, `crew_availability`,
   `checklist_instance_items` checkbox ticks, `checklist_instances`
   confirm-complete) go straight to a Supabase `.update()`/`.upsert()`.
   But turnover **status transitions** to `in_progress` or `completed`,
   and crew-flagged issue reports, are routed through Route Handlers
   instead (`/api/crew/turnovers/[id]/start`, `.../complete`,
   `/api/crew/work-order-reports`) — because those are exactly the
   crew-side entry points into Pass 1 §5's crew-authenticated routes and
   Pass 2's turnover/work-order event chains. A direct table write would
   skip the cleaning-fee posting, PM notification, and crew-duration
   tracking that only fire through the proper Route Handler → event
   pipeline. (There is no `turnover_issue_reports` table — a crew-flagged
   issue is inserted as a `work_orders` row with `wo_source: 'crew_flag'`.)

**Teardown:** on logout, `closeDexieDb()` deletes the entire per-user
IndexedDB database (and the separate photo-blob store) so no crew data
persists on a shared device after sign-out; a mount-time sweep also
deletes any other `fieldstay-*` databases left behind by a previous
user on the same device.

---

## 3. Token-gated public pages — neither pattern

Already enumerated in Pass 1 §3 (`crew-invite/[token]`, `owner/[token]`,
`vendor-connect/[token]/status`, `work-orders/[token]`,
`g/[slug]`, `g/b/[token]`, `g/kit/[media_kit_token]`). Worth calling out
here as a third, genuinely distinct pattern rather than a variant of
either above:

- No session at all — the URL-embedded token *is* the credential,
  checked with a direct `.eq('token', token)` (or equivalent) against a
  `createServiceClient()` query inside the page itself.
- No Dexie, no local cache, no Realtime subscription — a single
  server-rendered request per visit, same as the PM dashboard's "always
  fresh" model, but with no auth gate to get there.
- No `requireOrgMember()`/`requireAuth()` — org scoping comes from
  whatever row the token resolves to, not from a session's membership.

This is the right design for its use case (a one-off visit from an
emailed link, often on an unfamiliar device) but it means the tenant-
isolation guarantee here rests entirely on the token being
unguessable and the query being scoped to it — there's no RLS session
context backing it up the way the other two patterns get for free.

---

## Summary

| | PM Dashboard | Crew PWA | Token-Gated Public |
|---|---|---|---|
| Auth | Session + `requireOrgMember()` | Session + `crew_members` row (service-client check) | None — token is the credential |
| Data source | Supabase directly, RLS-enforced | Dexie (IndexedDB) cache, synced from Supabase | Supabase via service client, single request |
| Live updates | None — full reload per navigation | Supabase Realtime → Dexie → `useLiveQuery` | None |
| Offline support | None | Full read; writes queue in local outbox | None |
| Write path | Server Action → Supabase directly | `enqueueMutation` → outbox → Supabase *or* Route Handler (side-effecting writes) | N/A (mostly read-only; the few writes go through their own token-gated routes from Pass 1) |
| Failure visibility | Thrown error → Next.js error boundary | Dead-lettered mutations kept + surfaced in UI for retry | Thrown error → Next.js error boundary |

The dashboard and crew PWA split isn't a stylistic choice — it's a direct
answer to two different reliability assumptions (reliable office
connection vs. crews working inside properties with poor signal), and
the token-gated pages are a third answer to a problem neither of those
two patterns was built for (an anonymous, one-off visit with no account
at all).
