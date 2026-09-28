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

Neither is a defect today. Both are recorded because the reason they are fine
is a reason that can expire.

- **Board render time.** The database is not the constraint — the probed
  reads run in 0.9-7 ms at this size. What grows is the payload: roughly
  6,300 turnovers over the boards' 67-day window, server-rendered and
  serialised to the client. If the account reports slow boards, that is where
  to look, not at indexes.
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
