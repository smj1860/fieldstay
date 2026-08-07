# Push Notifications

**Status:** planned, not started. Written 2026-08-07 during the settings audit.

Goal: the Settings → Notifications tab should control **both** the in-app
notification bell and real device push, **per user** rather than per org, and
the toggles should stay where the user sets them.

Nothing in this document has been built. It exists so the work can be picked up
cold without re-deriving the investigation.

---

## Why this is a document and not a bug fix

The Notifications tab currently renders six switches:

| Switch | Form key |
|---|---|
| Turnover assignments | `push_turnovers` |
| Maintenance alerts | `push_maintenance` |
| Inventory low-stock alerts | `push_inventory` |
| Work order updates | `push_work_orders` |
| Daily ops digest | `email_daily_digest` |
| Weekly report | `email_weekly_report` |

They save successfully and show "Preferences saved." **Nothing reads what they
save.** `notification_prefs` is written by exactly one place —
`updateNotificationPrefs` in `app/(dashboard)/settings/actions.ts` — and read by
zero places anywhere in the repo (verified across `.ts`, `.tsx`, `.sql`).

The form also renders `defaultChecked` unconditionally, so it never reflects
what was saved: turn something off, save, come back, it shows on again.

This was left intact rather than deleted or half-wired, because making it real
requires product decisions (below) that are not the auditor's to make.

---

## What exists today

### The bell already carries all four categories

`lib/notifications.ts` feeds the bell from **two** sources:

1. **Persisted event rows** (`notifications` table), written via
   `createPmNotification()` in `lib/inngest/helpers.ts`. Live types:

   | type | written by |
   |---|---|
   | `turnover_complete` | `turnover-events.ts` |
   | `work_order_created` | `cron/work-order-ops.ts`, `api/crew/work-order-reports` |
   | `work_order_dispatched` | `work-order-events.ts`, `work-order-vendor-assigned.ts` |
   | `work_order_complete` | `work-order-events.ts`, `work-order-crew-completed.ts` |
   | `work_order_quote_received` | `work-order-events.ts` |
   | `maintenance_opportunity` | `ownerrez/incremental-sync.ts` |
   | `billing_plan_changed` | `notify-plan-changed.ts` |
   | `billing_payment_failed` | `webhooks/stripe/handlers/core-billing.ts` |
   | `integration_connection_error` | `notify-integration-error.ts` |

2. **Derived "currently true" alerts**, recomputed on every read and never
   stored — `turnoverItems()`, `workOrderItems()`, `belowParItems()`,
   `complianceItems()`.

So every category the four switches name already has bell content. Turnovers
and work orders appear in both sources; inventory low-stock exists **only** as a
derived alert; maintenance exists **only** as a persisted event.

### Push infrastructure exists but cannot reach a PM

- `push_subscriptions` has **both** `crew_member_id` and `user_id` (both
  nullable), so the schema can already hold a PM's subscription.
- `lib/push/send-push.ts` → `sendPushToUser(userId, payload)` — but its second
  statement looks up `crew_members` by `user_id` and **returns early if there is
  no crew row**. A PM who is in `organization_members` and not `crew_members`
  gets silently nothing.
- Its only caller is `app/(dashboard)/messages/actions.ts` (crew ↔ PM messages).

**Nothing pushes turnovers, maintenance, inventory, or work orders to any
device.** The switches are labelled "Push Notifications — Receive alerts on this
device," and that delivery channel genuinely does not exist for these.

### The weekly report does not exist

No cron, no email template, no content queries. That switch controls a feature
that was never built.

---

## Traps

Four things that will cause silent, hard-to-diagnose breakage if missed.

### 1. Preferences in auth user metadata are unqueryable by the sender

`notification_prefs` lives in Supabase auth user metadata. The daily-digest cron
runs server-side over orgs and needs to resolve *which users in this org want
this*. It cannot join or filter on auth metadata through PostgREST.

**Preferences must move to a queryable table before anything else can be done.**

Use a dedicated `user_notification_prefs` table, **not** columns on
`organization_members`. Putting them there means granting a user UPDATE on their
own membership row — and that same row holds their `role`. Preferences must not
share a write path with privilege.

### 2. Today the daily digest reaches exactly ONE person per org

`cron/daily-wrapup.ts` does `const [pmEmail] = await getPmEmails(supabase, orgId)`
— resolves the org's owners and admins, then takes `[0]`.

So with an owner *and* an admin, the admin has never received it. Going
per-user does not merely *filter* recipients; it will start sending to people
who were not getting mail. That is presumably the intent, but it is a behavior
change, not a no-op.

### 3. The Resend idempotency key would silently drop all but one recipient

```ts
{ idempotencyKey: `daily-wrapup-${orgId}-${now.toISOString().split('T')[0]}` }
```

Keyed on org + date. Fan out to three admins without changing this and Resend
delivers **one** — the other two get nothing, with no error anywhere. The key
must become per-recipient in the same change that adds the fan-out.

### 4. The bell has shared read state

`notifications` has **no `user_id`** and a single `read_at` column. The rows
belong to the org. One admin clearing the bell clears it for everyone else —
they never see those items.

This is already true today, independent of this work. Per-user bell requires
fixing it.

Related: CLAUDE.md notes org members can UPDATE `read_at` with no column-level
lock-down. Moving read state to its own table closes that too.

---

## The switch model (DECIDED 2026-08-07)

One master **Push** toggle, plus the existing per-category toggles. The
categories decide whether the notification happens at all; the master decides
whether it also reaches a device.

| Category | Push master | Result |
|---|---|---|
| on | off | Bell only |
| on | on | Bell **and** push |
| off | — | Neither |

So the master is a delivery-channel switch, not a category. It can never
surface something the category toggle suppressed, which means push has no
independent notion of "what to send" to keep in sync — the categories are the
single source of truth for that.

### What this implies about where filtering happens

`notifications` rows are **org-scoped and shared** — one row, visible to every
member. So a category being off for one user *cannot* mean the row isn't
written: another member in the same org may have that category on, and skipping
the insert would silently rob them of it.

Therefore:

- **Bell:** always write the row. Filter per user at **read** time, in
  `getPersistedNotifications()` and the derived-alert sections. A user's
  category preference is a view filter, never a write gate.
- **Push:** decided per recipient at **send** time — category on AND master on.
- **Unread badge:** must apply the same filter as the feed, or the badge counts
  items the user cannot see and never clears.

That last one is the easy thing to get wrong.

---

## Open decisions

These need a human answer before Phase 1 ships.

1. **Do managers get the digest option**, or only owners and admins?
   `getPmEmails` currently resolves `['owner', 'admin']`.
2. **Section heading.** "Push Notifications — Receive alerts on this device" no
   longer describes it. Suggest "Alerts" for the category block, with the push
   master as its own labelled row ("Also push these to my devices").
3. ~~**Weekly report** — cut the switch, or build the report?~~ **DECIDED
   2026-08-07: hidden.** The row is commented out (not deleted) in
   `settings-tabs.tsx`'s `EMAIL_PREFS`, with its paired line in
   `updateNotificationPrefs`. It may come back; restoring it means building the
   report first — there is currently no cron, no template and no content
   queries behind it.
4. **Do PMs get a push subscription prompt at all?** Today only the crew PWA
   registers subscriptions. The PM dashboard would need the service worker
   registration + permission prompt. Verify whether the existing SW is scoped to
   `/crew`.
### The push master triggers the browser permission prompt (DECIDED 2026-08-07)

Switching the master on calls `Notification.requestPermission()`, then registers
the service worker and writes the `push_subscriptions` row. Three outcomes, and
only one of them may leave the toggle on:

| Permission result | Toggle | Why |
|---|---|---|
| `granted` | stays on, subscription saved | the normal path |
| `denied` | **revert to off**, explain how to re-enable in browser settings | a browser denial is sticky — `requestPermission()` will not re-prompt, so leaving it on means it can never do anything |
| `dismissed` | revert to off, no error | they closed the prompt; let them retry |

Leaving the toggle on after a denial is precisely the failure this document
exists to remove: a control that reports a state it does not have.

**The pref and the subscription are not the same thing, and this is the subtle
part.** The preference is per *user* (one row, all their devices). Browser
permission and the subscription are per *device*. So a user who enables push on
their laptop and then opens the dashboard on their phone has the pref on and no
subscription there — push silently will not arrive on the phone.

The UI must therefore show two distinct states: the account-level "I want push"
pref, and "this browser is subscribed." When the pref is on but the current
device is not subscribed, show an inline prompt to enable it here — do not
render it as if push were working.

---

## Plan

### Phase 1 — preferences become real and per-user (email digest)

Self-contained; delivers "the switch stays where I put it, and my digest is
independent of my admin's."

1. Migration: `user_notification_prefs` — `(user_id, org_id, key)` unique,
   `enabled boolean not null`, RLS `user_id = auth.uid()` for all four verbs,
   `GRANT` to `authenticated`, FK to `profiles(id)` and `organizations(id)` with
   deliberate `ON DELETE CASCADE`. Update `types/database.ts` in the same commit.
   Apply to the E2E project (`syhthijeqlnltufdawyb`) in the same sitting.
2. `lib/notifications/prefs.ts` — read/write helpers, with a documented default
   for a user who has never saved. Recommend: categories default **on**
   (matching today's always-on rendering), push master defaults **off** — an
   unasked-for phone notification is worse than a missing one, and the master
   cannot do anything useful until a device is subscribed anyway.
3. `updateNotificationPrefs` → write to the table, drop the auth-metadata write.
   Add a `getNotificationPrefs` read for the tab.
4. `daily-wrapup.ts` — resolve all opted-in recipients for the org, send to
   each, **per-recipient idempotency key** (trap 3).
5. Settings UI — load real state, no more unconditional `defaultChecked`. Use
   `components/ui/Checkbox` rather than the current hand-rolled
   `<input type="checkbox">` (CLAUDE.md names this explicitly). The push master
   row can ship here, disabled, with the "no device subscribed yet" copy —
   Phase 3 makes it live.

**Estimate:** ~1 day.

### Phase 2 — per-user bell, and the four categories become real filters

1. Migration: `notification_reads (notification_id, user_id, read_at)`, PK on
   the pair, RLS `user_id = auth.uid()`. Backfill from the existing
   `notifications.read_at` — attribute existing reads to nobody rather than
   guessing, or to the org owner; decide and document. Keep `read_at` in place
   for one deploy window, then drop it in a follow-up.
2. Update the four places that touch read state:
   - `lib/notifications.ts` `getPersistedNotifications()` (join reads)
   - `app/(dashboard)/notifications-actions.ts` (mark read)
   - the unread badge count
   - `cron/notifications-retention.ts` (its "only read rows" purge now means
     "read by everyone", or switch to age-only — decide and document)
3. Category filtering, applied at READ time (see "where filtering happens"
   above — rows are shared, so a category toggle is a view filter and must
   never gate the insert). The unread badge must apply the identical filter or
   it counts items the user cannot see and never clears. Map switch → content:

   | Switch | Persisted types | Derived section |
   |---|---|---|
   | Turnover assignments | `turnover_complete` | `turnoverItems()` |
   | Work order updates | `work_order_*` | `workOrderItems()` |
   | Inventory low-stock | — | `belowParItems()` |
   | Maintenance alerts | `maintenance_opportunity` | — |

   Billing, integration-error and vendor-compliance items are **not** covered by
   any switch. Leave them always-on; they are account-critical, not routine.

**Estimate:** ~1–1.5 days.

### Phase 3 — real device push

1. **Un-gate `sendPushToUser` from crew.** Its `crew_members` lookup is the
   blocker; `push_subscriptions.user_id` already exists. Keep the crew path
   working — that lookup currently also supplies `crew_member_id` for the
   subscription query, so this needs care, not just deletion.
2. PM-side subscription: service worker registration + permission prompt in the
   dashboard. Verify the existing SW's scope first (open decision 5).
3. Emit push alongside bell creation. `createPmNotification()` is the single
   chokepoint for every persisted type — hooking there covers maintenance,
   turnover-complete and the whole work-order family in **one** place. Gate per
   recipient on `category on AND push master on`; resolve the org's members and
   send only to those who pass. Note this is a per-recipient fan-out inside what
   is currently a single insert, so mind `n-plus-one-loops` — batch the pref
   lookup for the org rather than querying per member.
4. **Derived alerts have no event moment.** Inventory below-par and unassigned
   turnovers are recomputed on read; there is nothing to hang a push on. They
   need either a cron that pushes a daily summary, or promotion to real
   persisted `notifications` rows at the point the condition first becomes true.
   The second is better but is its own piece of work.
5. Respect quiet hours / rate limits. A push per work-order event is plausibly
   dozens a day for a busy org.

**Estimate:** ~2 days, plus the derived-alert decision in step 4, which could be
the same again if promoted to persisted rows.

---

## Test plan

- Prefs default for a user who never saved.
- A toggle survives a round trip and a page reload (the current bug).
- Two admins in one org: one opts out of the digest, the other still receives.
- Digest fan-out to N recipients actually sends N emails — asserts distinct
  idempotency keys (trap 3).
- Two admins: one marks a bell item read, the other still sees it unread
  (trap 4).
- A user with a category off does not see that category in the bell, and
  billing/integration/compliance items appear regardless.
- A category off for user A still writes the row, and user B (same org, category
  on) still sees it — the shared-row case that makes filtering a read concern.
- The unread badge matches the filtered feed: a user with a category off never
  has a badge they cannot clear.
- Push master off + category on = bell row written, no push sent.
- Push master on + category off = neither.
- `sendPushToUser` reaches a PM with no `crew_members` row (Phase 3).

---

## Files

Touched, by phase:

**1:** new migration; `types/database.ts`; new `lib/notifications/prefs.ts`;
`app/(dashboard)/settings/actions.ts`; `app/(dashboard)/settings/settings-tabs.tsx`;
`lib/inngest/functions/cron/daily-wrapup.ts`

**2:** new migration; `types/database.ts`; `lib/notifications.ts`;
`app/(dashboard)/notifications-actions.ts`; the bell component;
`lib/inngest/functions/cron/notifications-retention.ts`

**3:** `lib/push/send-push.ts`; `lib/inngest/helpers.ts` (`createPmNotification`);
dashboard service-worker registration; possibly new persisted-alert writers
