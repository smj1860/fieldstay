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

Dashboard → New project in the same org, or ask Claude to do it via the
Supabase MCP. Suggested name: `fieldstay-e2e`, region `us-east-1` (same as
prod). **Cost: $10/month** on the current org plan.

No extensions or manual schema work needed — migrations handle everything.

## 2. Apply all migrations

```bash
supabase link --project-ref <e2e-project-ref>
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
