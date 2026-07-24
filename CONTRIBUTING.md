# Contributing to FieldStay

This is a private repository. Access is granted on a need-to-know basis. If you have access, this document tells you exactly how to work within the codebase safely.

**Read [`CLAUDE.md`](CLAUDE.md) before touching a single line of code.** It is the authoritative source for every architectural decision, naming convention, and guardrail. This document covers process; CLAUDE.md covers the code itself.

---

## Before You Start

### Branching

```
main          — production; protected; deploys to Vercel automatically
staging       — pre-production integration testing
feature/*     — your feature work (branch off main)
fix/*         — bug fixes
chore/*       — housekeeping (deps, types, tooling)
```

Never commit directly to `main` or `staging`.

### Local Environment

Follow the [README setup guide](README.md#local-development-setup) completely. In particular:

- Run `npm run types:supabase` after pulling if any migration files have changed.
- Run `npm run inngest:dev` in a second terminal — background jobs will silently never fire without it.

---

## Development Workflow

### 1. Create your branch

```bash
git checkout main && git pull
git checkout -b feature/your-feature-name
```

### 2. Run the pre-flight audit before feature work

```bash
# Catch the most common stale-table bug before it causes auth failures
grep -rn "from('memberships')" --include="*.ts" --include="*.tsx" app/ lib/
```

Any hit here is a bug. Replace with `from('organization_members')`.

### 3. Write code

Follow CLAUDE.md. The non-negotiables are repeated in the checklist below.

### 4. Test locally

```bash
npm run build      # catches TypeScript errors and Next.js build issues
npm run lint       # ESLint
```

There is no automated test suite yet. Manual QA is expected for every PR.

### 5. Open a pull request

Target branch: `main` (or `staging` for larger features in progress).

---

## PR Checklist

Before marking a PR ready for review, confirm every item:

### Database
- [ ] Every new table has `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and four policies (SELECT, INSERT, UPDATE, DELETE) using `get_user_org_ids()` and `is_org_member()`
- [ ] Every migration that adds a column also updates the matching interface in `types/database.ts` in the same commit
- [ ] New migration files are named `YYYYMMDDHHMMSS_description.sql` (e.g. `20260723140000_add_widget_column.sql`) and are safe to re-run (idempotent SQL) — the older `fieldstay_migration_vN.sql` convention is retired; the two `fieldstay_migration_v1/v2.SUPERSEDED.sql` files at the repo root are historical only, do not run them
- [ ] No new `.from('memberships')` calls — the table is `organization_members`

### Security
- [ ] `SUPABASE_SERVICE_ROLE_KEY` / `createServiceClient()` is used only in Inngest steps and specific server-side handlers
- [ ] No PII, Stripe tokens, or raw error messages are passed to `console.log` or returned to the client
- [ ] Stripe webhook handlers call `stripe.webhooks.constructEvent()` before processing anything
- [ ] Every Server Action and Route Handler that touches org data calls `requireOrgMember()` as its first line

### Inngest
- [ ] Every new event name is registered in `lib/inngest/events.ts` before being used in `inngest.send()` or a function trigger
- [ ] Every new Inngest function is added to the functions array in `app/api/inngest/route.ts` (there is exactly ONE `serve()` call)
- [ ] All steps that create DB records are idempotent (check `source_reference_id` or use `ON CONFLICT DO NOTHING`)
- [ ] No nested `step.run` / `step.sleep` calls — steps must be flat

### TypeScript
- [ ] No `any` types
- [ ] No `unknown` without a type guard
- [ ] No direct Supabase reads in crew PWA client components (`app/crew/*`) — Dexie (`getDexieDb`/`useLiveQuery`) only
- [ ] `npm run build` passes with zero errors

### UI
- [ ] Colors use CSS custom properties (`var(--text-primary)`, `var(--bg-card)`, `var(--accent-gold)`) — no hardcoded hex or Tailwind color utilities in component files
- [ ] Dark mode works (no hardcoded `bg-white`, `text-gray-900`, etc.)

---

## Adding a New Database Table

1. Write the migration SQL in `supabase/migrations/YYYYMMDDHHMMSS_description.sql`
2. Include `ENABLE ROW LEVEL SECURITY` and all four policies in the same file
3. Update `types/database.ts` — find the correct section and add the new interface
4. Run `npm run types:supabase` to regenerate `types/supabase.ts`
5. Commit migration + type update together

## Adding a New Inngest Function

1. Add the event type to `lib/inngest/events.ts`
2. Create the function file at `lib/inngest/functions/your-function.ts`
3. Register it in `app/api/inngest/route.ts` — add to the existing `serve()` array
4. Test it in the Inngest dev UI at `http://localhost:8288`

## Adding a New Environment Variable

1. Add it to `.env.example` with a comment explaining where to get the value
2. Document it in the relevant section of `.env.example`
3. If it's required at build time, add a check in the appropriate server module
4. Add it to Vercel project settings before deploying

---

## Code Style

- **TypeScript strict mode** is on. Respect it.
- **No ORM** (no Prisma, Drizzle, etc.) — use the Supabase JS client directly.
- **No Vite, Turborepo, or tRPC** — the stack is locked.
- **Server Components by default.** Add `'use client'` only when you need interactivity or browser APIs.
- **Server Actions for mutations.** No client-side API calls to Supabase.
- Return `{ success: true, data }` or `{ success: false, error: 'User-facing message' }` from Server Actions — never throw to the client.

---

## Getting Help

If something in CLAUDE.md is unclear or appears to conflict with something else in the codebase, open an issue rather than guessing. Architectural decisions here have downstream security and data-integrity implications.
