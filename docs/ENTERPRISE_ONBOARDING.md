# Onboarding an Enterprise account

For a portfolio above `MAX_SELF_SERVE_PROPERTIES` (150). Written after
measuring a 334-property account against a 14-org / 872-property fixture; the
measurements behind the capacity notes are in `scripts/rls-plan-probe.sql` and
the CLAUDE.md item it closes.

Self-serve onboarding needs none of this. Enterprise does, because two of the
steps below are enforced in Postgres rather than in application code, so
getting them wrong produces a database error rather than a friendly message.

---

## 1. Raise `organizations.max_properties` — REQUIRED

```sql
UPDATE organizations
   SET max_properties = <contracted ceiling>
 WHERE id = '<org uuid>';
```

**This is not optional and it is not advisory.** `properties` carries a
`BEFORE INSERT` trigger, `enforce_property_plan_limit()`, which reads this
column and raises:

```
ERROR: 23514: Property limit reached: this plan allows up to N active properties.
```

So the cap is enforced by the database, not only by
`app/(dashboard)/properties/actions.ts`. Until the column is raised, **every**
path that creates a property fails — the dashboard, a PMS import, a bulk
migration, a backfill run directly against the database. The error surfaces
from a trigger, which is not where anyone looks first.

Set it to the contracted ceiling with headroom, not to the exact property
count: the same trigger blocks the property that takes them one over.

## 2. Keep the subscription OFF the self-serve platform price — REQUIRED

An Enterprise contract is billed outside Stripe self-serve. If the
subscription is nonetheless created against `STRIPE_PRICE_PLATFORM_MONTHLY` /
`_ANNUAL`, the billing webhook treats the org as self-serve and writes
`max_properties = MAX_SELF_SERVE_PROPERTIES` (150) over whatever step 1 set.

The next subscription event — a renewal, a card update, a billing-portal
visit — then silently re-imposes the 150 cap, and property creation starts
failing at the trigger above with no deploy and no code change to explain it.

`syncNonPlatformSubscription` in
`app/api/webhooks/stripe/handlers/core-billing.ts` is what protects this: for
a price that is not the platform price it syncs `plan_status` only and leaves
the entitlement columns alone. That protection is conditional on the price,
so the price is the thing to get right.

If an Enterprise org must carry a Stripe subscription at all, it goes on a
separate Price. Verify after setup:

```sql
SELECT id, name, plan, plan_status, max_properties
  FROM organizations WHERE id = '<org uuid>';
```

`max_properties` still at the contracted value after the first real webhook
fires is the check that matters.

## 3. Things that need no action

Recorded because each was checked, so nobody re-derives them:

- **Query plans.** Measured at 872 properties across 14 orgs: every probed
  dashboard read still seeks an `org_id` index, and the RLS helper
  (`get_user_org_ids()`) is evaluated once per query as a hashed SubPlan, not
  per row. Re-measure with `pnpm run check:rls-plans` if the shape of the
  portfolio changes. See `scripts/rls-plan-probe.sql`.
- **Board completeness.** The maintenance board's work-order, schedule and
  asset reads are drained through `fetchAllRows`, so they are complete at any
  portfolio size rather than capped at a number chosen for a smaller one.
- **Cron step counts.** The maintenance-schedule cron batches its per-schedule
  work (`chunkDueSchedules`), so a large org no longer produces a step count
  that scales with its schedule count.

## 4. Things to watch, with the reason

None is a defect today. Each is recorded because the reason it is fine is a
reason that can expire.

- **Board payload.** MEASURED 2026-09-29, and the earlier worry here was
  wrong. `/turnovers` ships 5,682 rows / 2.32MB and `/ops` ships 2,005 rows /
  0.71MB at 334 properties — roughly a tenth of the 24MB budget the probe
  checks against. Even allowing for a real in-season turnover rate, which is
  about 2.4x what the fixture seeds, `/turnovers` lands near 5.5MB. The boards
  are not a scaling risk at this size and no window, virtualisation or
  server-side aggregate is needed. Re-measure with
  `pnpm run check:payload-volume` if the portfolio grows well past 334. See
  `scripts/payload-volume-probe.sql`.

- **The crew device cache — the one to plan for.** Same probe, same run: a
  crew member's device holds 176,640 rows / 104MB after about 2.6 years on a
  334-property account, and 100MB of that is `checklist_instance_items`. It
  grows with that person's TENURE and nothing brings it back down —
  `fetchAssignedTurnoverIds` has no date window, and `pruneLocalCache` derives
  its live set FROM the cached turnovers, so a turnover only leaves the device
  when the server unassigns it. At the seeded rate the 192MB ceiling arrives
  around year five, which is inside the working life of the account. A full
  resync also costs 276 sequential round trips today (~80 seconds at a phone's
  300ms RTT), which is what a new device, a reinstall or
  `forceFullCrewResync()` pays.

  **The 100MB half is fixed as of 2026-09-29.**
  `pruneSettledChecklistItems()` sheds a checklist's items once the delta
  cursor has moved past them, so the items no longer accumulate with tenure and
  a forced resync's re-inflation is shed again in the same pass. The trigger is
  the cursor rather than completion, because a just-completed turnover sits
  inside `CURSOR_OVERLAP_MS` and a completion trigger loops purge/re-pull on the
  most recent job — measured before the fix was written.

  **The rest followed the same day.** `CREW_SCOPE_HORIZON_DAYS` (45) bounds the
  assignment scope itself, applied server-side through a
  `turnovers!inner(checkout_datetime)` embed so the round trips shrink with the
  cache. The past only — a future turnover is always in scope — and a turnover
  with unsent work is retained regardless of age, because the dead-letter window
  is a different clock from the horizon. Nothing on a crew device now grows with
  tenure.

- **The crew PWA's checklist pull.** `checklist_instance_items` has no
  `org_id` column in its policy at all — both branches resolve through
  `instance_id IN (subquery)` — so a crew member's read materialises their
  accessible `checklist_instances` set once per query. At fixture size the
  planner chooses a sequential scan of `checklist_instances` to build that
  set, which is the *cheaper* option there and not a missing index: with
  `enable_seqscan = off` an index plan exists and is in fact faster, so
  Postgres will move to it on cost as the table grows. `checklist_instances`
  grows with TIME rather than with portfolio size, so this is the one to
  re-measure periodically rather than once.

## 5. After onboarding

Run the cross-tenant isolation probe once the account has real data —
it is the only check that measures what a user can actually see rather than
what the schema says:

```bash
pnpm run check:rls-isolation:prod
```

Safe against production: everything it does is inside a transaction that ends
in `ROLLBACK`.
