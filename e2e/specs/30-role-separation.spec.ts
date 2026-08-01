import * as crypto from 'crypto'
import type { Browser, Page } from '@playwright/test'
import { test, expect } from '../fixtures'
import { getServiceClient } from '../helpers/teardown'

// ── Why this spec exists ────────────────────────────────────────────────────
// The suite has exactly one authenticated identity that touches the PM
// dashboard: the E2E_PM account, which is an org `owner`. `owner` passes
// requireOrgRole() unconditionally (lib/auth.ts mirrors is_org_member()'s
// "owner always passes" semantics), so every existing spec exercises the ONE
// role for which no permission check can ever fail. The read-only `viewer`
// role — and the PM/crew boundary in both directions — has never been
// executed end to end.
//
// Three boundaries are covered here, each of which fails open silently if it
// regresses (a removed requireOrgRole() call returns success; a removed layout
// guard renders the page):
//
//   1. viewer can READ but cannot WRITE — the write must be refused by the
//      SERVER, proven by the absence of the row, not just by a hidden button.
//   2. viewer cannot reach owner-only team administration.
//   3. PM cannot enter the crew PWA, and crew cannot enter the PM dashboard.
//
// Every disposable identity created here is rolled back in a `finally`, the
// same convention 22-crew-logout-guard.spec.ts and 27-crew-feedback.spec.ts
// use — global teardown's cleanE2EData() only sweeps [E2E]-prefixed data rows,
// never auth users or organization_members.
test.describe('Role separation', () => {
  test.describe.configure({ timeout: 90_000 })

  test('[E2E] viewer can read properties but the server refuses their write', async ({ ctx, browser }) => {
    const supabase = getServiceClient()
    const viewer   = await createViewerMember(ctx.orgId, browser)

    // Unique per attempt — CI sets retries: 2 and nothing cleans up between
    // attempts, so a static name would let a previous attempt's row (if this
    // test ever legitimately fails open) confuse the next one.
    const blockedName = `[E2E] Viewer Blocked Property ${crypto.randomUUID()}`

    try {
      const { page } = viewer

      // ── Read is allowed ────────────────────────────────────────────────
      // Positive control: without this, the write-refusal assertions below
      // would also pass on a blank or errored page.
      await page.goto('/properties')
      await expect(page.getByText('[E2E] The Lakehouse')).toBeVisible({ timeout: 15_000 })

      // ── Write is refused ───────────────────────────────────────────────
      // createProperty() (app/(dashboard)/properties/actions.ts) opens with
      // requireOrgRole(['admin','manager']), which throws for a viewer; the
      // action's catch converts that into { error: 'Operation failed. Please
      // try again.' } and the form renders it via useActionState. A successful
      // create would instead redirect() to /properties/<id>/setup/details, so
      // "still on /properties/new" is itself a meaningful assertion.
      await page.goto('/properties/new')
      await page.fill('#name', blockedName)
      await page.click('button[type="submit"]')

      await expect(page.getByText(/Operation failed/i)).toBeVisible({ timeout: 15_000 })
      await expect(page).toHaveURL(/\/properties\/new$/)

      // The assertion that actually matters: no row exists. A regression that
      // dropped the role gate would create the property and still be able to
      // render an error afterwards for some unrelated reason — only the
      // database can say whether the write happened.
      const { data: rows, error } = await supabase
        .from('properties')
        .select('id')
        .eq('org_id', ctx.orgId)
        .eq('name', blockedName)
      expect(error).toBeNull()
      expect(rows ?? []).toEqual([])
    } finally {
      // Belt and braces: if the gate HAS regressed, don't leave the row behind
      // for the rest of the suite to trip over.
      await supabase.from('properties').delete().eq('org_id', ctx.orgId).eq('name', blockedName)
      await viewer.cleanup()
    }
  })

  test('[E2E] viewer is not offered team administration', async ({ ctx, browser }) => {
    const viewer = await createViewerMember(ctx.orgId, browser)
    try {
      const { page } = viewer

      await page.goto('/settings/team')
      // Positive control — the page itself rendered (a viewer IS allowed to
      // see the roster), so the absence assertion below means something.
      await expect(page.getByRole('heading', { name: 'Team', exact: true })).toBeVisible({ timeout: 15_000 })

      // app/(dashboard)/settings/team/page.tsx renders the "Invite Member"
      // link only for membership.role === 'owner', and team-client.tsx gates
      // the whole invite form + the per-member role/remove controls on the
      // same isOwner flag.
      await expect(page.getByRole('link', { name: 'Invite Member' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /Send Invite/i })).toHaveCount(0)
    } finally {
      await viewer.cleanup()
    }
  })

  test('a PM account cannot enter the crew PWA', async ({ page }) => {
    // Uses the default chromium project storageState (the org-owner PM).
    // app/crew/layout.tsx looks up an active crew_members row for the
    // authenticated user and, finding none, writes a
    // 'security.route.mismatch' audit event and redirects to /ops.
    await page.goto('/crew')
    await page.waitForURL('**/ops', { timeout: 15_000 })
    await expect(page).toHaveURL(/\/ops/)
  })

  test('[E2E] a crew account cannot enter the PM dashboard', async ({ ctx, browser }) => {
    const crew = await createCrewOnlyMember(ctx.orgId, browser)
    try {
      const { page } = crew

      // Positive control — this identity really is signed in and really can
      // use the crew PWA, so the redirect below is about authorization, not a
      // dead session.
      await expect(page).toHaveURL(/\/crew$/)

      // A crew_members row is NOT an organization_members row, so
      // requireOrgMember() (which every (dashboard) page and the dashboard
      // layout call) finds no accepted membership and redirects to
      // /onboarding rather than rendering PM data.
      await page.goto('/ops')
      await page.waitForURL('**/onboarding', { timeout: 15_000 })
      await expect(page).toHaveURL(/\/onboarding/)

      // Same for the money-bearing surfaces specifically.
      await page.goto('/owners')
      await page.waitForURL('**/onboarding', { timeout: 15_000 })
      await expect(page.getByText('[E2E] The Lakehouse')).toHaveCount(0)

      await page.goto('/settings/team')
      await page.waitForURL('**/onboarding', { timeout: 15_000 })
      await expect(page.getByRole('heading', { name: 'Team', exact: true })).toHaveCount(0)
    } finally {
      await crew.cleanup()
    }
  })
})

// ── Helpers ─────────────────────────────────────────────────────────────────

interface DisposableSession {
  page:    Page
  cleanup: () => Promise<void>
}

/**
 * A disposable auth user holding a `viewer` organization_members row in the
 * primary E2E org, already signed in on a genuinely fresh browser context.
 */
async function createViewerMember(orgId: string, browser: Browser): Promise<DisposableSession> {
  const supabase = getServiceClient()

  const email    = `e2e-viewer-${crypto.randomUUID()}@e2e-test.invalid`
  const password = 'E2E-Viewer-Role-Test-1!'

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (createErr || !created.user) throw new Error(`Failed to create viewer auth user: ${createErr?.message}`)
  const userId = created.user.id

  try {
    // invite_accepted_at must be non-null or getMembershipContext() filters
    // the row out and requireOrgMember() redirects to /onboarding — which
    // would make this spec pass for entirely the wrong reason.
    const { error: memberErr } = await supabase.from('organization_members').insert({
      org_id:             orgId,
      user_id:            userId,
      role:               'viewer',
      invite_accepted_at: new Date().toISOString(),
    })
    if (memberErr) throw new Error(`Failed to create viewer membership: ${memberErr.message}`)

    const { page, closeContext } = await signIn(browser, email, password, '**/ops')

    return {
      page,
      cleanup: async () => {
        try {
          await closeContext()
        } finally {
          await supabase.from('organization_members').delete().eq('user_id', userId).eq('org_id', orgId)
          await supabase.auth.admin.deleteUser(userId)
        }
      },
    }
  } catch (err) {
    // Best-effort rollback — the outer error is what matters. A Supabase
    // query builder is PromiseLike only (no .catch()), so the try/catch is
    // the only way to guard this.
    try {
      await supabase.from('organization_members').delete().eq('user_id', userId).eq('org_id', orgId)
    } catch { /* ignore */ }
    await supabase.auth.admin.deleteUser(userId).catch(() => {})
    throw err
  }
}

/**
 * A disposable auth user holding ONLY a crew_members row (deliberately no
 * organization_members row — that is exactly the PM/crew separation under
 * test), already signed in and sitting on /crew.
 */
async function createCrewOnlyMember(orgId: string, browser: Browser): Promise<DisposableSession> {
  const supabase = getServiceClient()

  const email    = `e2e-crew-roleseparation-${crypto.randomUUID()}@e2e-test.invalid`
  const password = 'E2E-Crew-Separation-Test-1!'

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (createErr || !created.user) throw new Error(`Failed to create crew auth user: ${createErr?.message}`)
  const userId = created.user.id

  let crewMemberId: string | undefined
  try {
    const { data: crewMember, error: cmErr } = await supabase
      .from('crew_members')
      .insert({
        org_id:             orgId,
        user_id:            userId,
        name:               '[E2E] Role Separation Crew',
        role:               'general',
        is_active:          true,
        invite_accepted_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (cmErr || !crewMember) throw new Error(`Failed to create crew_members row: ${cmErr?.message}`)
    crewMemberId = crewMember.id

    const { page, closeContext } = await signIn(browser, email, password, '/crew')

    return {
      page,
      cleanup: async () => {
        try {
          await closeContext()
        } finally {
          await supabase.from('crew_members').delete().eq('id', crewMember.id)
          await supabase.auth.admin.deleteUser(userId)
        }
      },
    }
  } catch (err) {
    // Best-effort rollback — see the note in createViewerMember() for why
    // this is a try/catch rather than a trailing .catch().
    try {
      if (crewMemberId) await supabase.from('crew_members').delete().eq('id', crewMemberId)
    } catch { /* ignore */ }
    await supabase.auth.admin.deleteUser(userId).catch(() => {})
    throw err
  }
}

/**
 * Sign in on a genuinely blank context.
 *
 * storageState: undefined is required, not optional — Playwright Test
 * instruments every browser.newContext() created during a running test and
 * silently re-applies the project's configured use.storageState
 * ('e2e/.auth/pm.json'), so a bare browser.newContext() is secretly the PM.
 * See the long-form note in 21/22/25/27 for the confirmed repro.
 */
async function signIn(
  browser:  Browser,
  email:    string,
  password: string,
  destination: string,
): Promise<{ page: Page; closeContext: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: undefined })
  try {
    const page = await context.newPage()

    const isCrew = destination === '/crew'
    await page.goto(isCrew ? '/login?next=/crew' : '/login')
    await page.fill('#email',    email)
    await page.fill('#password', password)
    await page.click('button[type="submit"]')

    if (isCrew) {
      await page.waitForURL((url) => url.pathname === '/crew', { timeout: 20_000 })
    } else {
      await page.waitForURL(destination, { timeout: 20_000 })
    }

    return { page, closeContext: () => context.close() }
  } catch (err) {
    await context.close().catch(() => {})
    throw err
  }
}
