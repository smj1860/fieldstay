# E2E Merge Gate — Setup Runbook

Turns the Playwright suite (`e2e/specs/*`, 27 spec files) into a real merge
gate, per the launch-readiness audit's B2 finding and the 2026-07-22 audit's
recommendation #2.

**Current state:** `.github/workflows/ci.yml`'s `e2e` job is a *self-arming
gate*. With no secrets configured it skips the suite and stamps every CI run
with a loud "E2E gate UNARMED" warning. The moment the secrets below exist,
the suite runs on every PR and failures fail the job — no YAML edit needed.
Step 5 (branch protection) is what makes a red job actually block the merge
button.

The suite runs against a **dedicated E2E Supabase project**. Never point it
at production (`vpmznjktllhmmbfnxuvk`) — global setup/teardown deletes rows
matching `[E2E]%` patterns and the seeder flips org billing state.
`scripts/seed-e2e-project.ts` hard-refuses the production URL as a backstop.

---

## 1. Create the E2E Supabase project

> ✅ **ALREADY DONE — this runbook is now history, not a to-do list.**
> Project `fieldstay-e2e`, ref `syhthijeqlnltufdawyb`, us-east-1, $10/month.
> URL: `https://syhthijeqlnltufdawyb.supabase.co`.
>
> Steps 2, 3, 4 and 6 are done and are re-proven on every pull request: the
> `db-invariants` job runs ARMED against this project (`DB_INVARIANTS_REQUIRE_ARMED=1`,
> i.e. it fails rather than self-disarming if the secrets go missing) and
> prints its ledger reconciliation each run. Step 5 — whether `e2e` is a
> *required* status check — is branch-protection config that isn't readable
> from the repo, so confirm it in Settings → Branches if you need certainty.
>
> **Do not quote a migration count here.** An earlier draft of this note said
> "all 311 migrations applied"; it was already wrong by the time it was
> written and is now off by ~90. The number moves every week and a stale one
> reads as authoritative. The invariant, which CI actually enforces, is that
> local files and ledger rows differ only by the frozen set recorded in
> `scripts/migration-ledger-baseline.json` — currently 203 pre-existing
> divergences this project inherited when it was branched from prod. That is
> what `scripts/check-migration-ledger.mjs` asserts; read its output for the
> live figures.
>
> Bootstrap skips, recorded because they explain part of that divergence:
> two prod-only data seeds were intentionally not applied
> (`20260630044714_add_stephen_as_platform_staff` and
> `20260718010000_seed_room_templates` — both reference production
> identities, and the app auto-seeds room templates per-org at runtime), and
> the powersync-publication statements were skipped (that layer never exists
> on a fresh project and has since been dropped from prod entirely).

Dashboard → New project in the same org, or ask Claude to do it via the
Supabase MCP. Suggested name: `fieldstay-e2e`, region `us-east-1` (same as
prod). **Cost: $10/month** on the current org plan.

No extensions or manual schema work needed — migrations handle everything.

## 2. Apply all migrations

```bash
supabase link --project-ref syhthijeqlnltufdawyb
supabase db push
```

All migrations are idempotent (`IF NOT EXISTS` throughout), so re-pushing
after future migrations land is always safe. **Keep the E2E project
migrated in lockstep with production** — a schema-drifted E2E project
produces false failures. Easiest habit: `supabase db push` to the E2E ref in
the same sitting as every production `apply_migration`.

## 3. Seed the PM account and org

```bash
E2E_SUPABASE_URL=https://<e2e-project-ref>.supabase.co \
E2E_SUPABASE_SERVICE_ROLE_KEY=<e2e-service-role-key> \
E2E_PM_EMAIL=e2e-pm@fieldstay.test \
E2E_PM_PASSWORD=<long-random-password> \
npx tsx scripts/seed-e2e-project.ts
```

Idempotent — re-run any time. It creates the PM auth user and an org with
all 8 onboarding steps completed and `plan_status = 'active'`, then verifies
the exact preconditions `e2e/global-setup.ts` checks (the ones behind its
"/setup" and "/billing-wall" error messages).

The crew account needs **no** pre-seeding — `global-setup.ts` creates
`E2E_CREW_EMAIL` itself on first run. Just pick the values and add them as
secrets.

## 4. Add the GitHub Actions repo secrets

Settings → Secrets and variables → Actions. All Supabase values are the
**E2E project's**, not production's:

| Secret | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<e2e-project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | E2E project anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | E2E project service role key |
| `E2E_PM_EMAIL` / `E2E_PM_PASSWORD` | exactly what you passed to the seed script |
| `E2E_CREW_EMAIL` / `E2E_CREW_PASSWORD` | any values, e.g. `e2e-crew@fieldstay.test` + long random |
| `STRIPE_SECRET_KEY` | Stripe **test-mode** key (`sk_test_…`) |
| `RESEND_API_KEY` | can be a dummy string — no spec asserts on delivered email |
| `MAPBOX_PUBLIC_TOKEN` | real token (free tier is plenty) or dummy — geocode failure is non-fatal |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` — dedicated E2E pair |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | dummy strings — events fire-and-forget in dev mode; no spec asserts on async job output |

⚠️ These are gate-detection secrets: the `e2e` job arms itself when
`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `E2E_PM_EMAIL`
are all present. Adding them is the "go live" action.

## 5. Make it a required check (the actual gate)

Settings → Branches → protection rule for `main` → **Require status checks
to pass** → add `e2e` (alongside the existing `checks`). Until this step, a
red suite is visible but doesn't block the merge button.

## 6. Verify

Open a trivial PR. Expected: the `e2e` job prints "E2E gate is ARMED", runs
all specs (~sequential, single worker — they share a DB), and the PR is
mergeable only when green. Playwright's HTML report uploads as an artifact
on failure.

---

## Maintenance notes

- **Schema drift** is the most likely source of false failures — see step 2.
- The suite is sequential by design (`workers: 1`); a full run is the price
  of DB-sharing simplicity. If runtime becomes painful, shard by spec file
  ranges across parallel jobs, each with its own seeded org, not by turning
  on parallel workers against one org.
- `global-setup.ts` cleans stale `[E2E]%` rows before seeding, so an aborted
  run never poisons the next one.

### GRANT parity with production (checked 2026-08-06)

**A new E2E project starts with looser table privileges than production, and
the `db-invariants` job runs against E2E.** That combination is worth
understanding, because it means the gate can pass on a permission posture the
thing it protects does not have.

A Supabase project created through the dashboard carries a default-privilege
entry that production does not:

```sql
-- pg_default_acl, grantor postgres, schema public, objtype r (tables)
-- {postgres=arwdDxtm/postgres, authenticated=arwdDxtm/postgres, service_role=…}
```

`arwdDxtm` is everything — INSERT, SELECT, UPDATE, DELETE, **TRUNCATE**,
REFERENCES, TRIGGER. So every table created by a migration inherits full
`authenticated` access automatically. On 2026-08-06 the E2E project had
TRUNCATE, REFERENCES and TRIGGER granted to `authenticated` on **all 91**
public tables, plus 86 more (table, privilege) DML pairs than production, while
production had zero of the three extras.

Two consequences, and the second is the one that matters:

1. `TRUNCATE` bypasses RLS entirely, so a signed-in user on that project could
   empty any table. E2E holds no real data, so this was a test-project problem.
2. The `db-invariants` gate exists partly to catch a **missing** GRANT — the
   defect class that made the notification bell go dark in production, where
   `notifications` had correct RLS policies and no `authenticated` grant
   (`20260710200000_grant_authenticated_missing_tables.sql`). On a project where
   every new table is granted everything by default, that check can never fail.

Repaired by removing the source and then matching production exactly:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM authenticated;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
-- then re-GRANT production's exact per-table privilege set
```

Deliberately **not** a migration: this is project configuration, not a schema
change, and a migration hard-coding a grant snapshot goes stale the moment the
next table is added. Run it against any newly created E2E project as part of
step 1. Verify with the fingerprint — it must be identical on both projects:

```sql
SELECT md5(string_agg(table_name||':'||privilege_type, ',' ORDER BY table_name, privilege_type))
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee = 'authenticated';
```

There is no automated check for this yet. `db_invariant_report()` could grow an
`overbroad_authenticated_grants` section (TRUNCATE/REFERENCES/TRIGGER granted to
a client role) and a `default_privileges_to_client_roles` one — both are true
invariants of production, so the gate could assert them without needing to see
production at all.
