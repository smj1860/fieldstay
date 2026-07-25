import { test, expect } from '../fixtures'
import { getServiceClient } from '../helpers/teardown'

// This spec creates its OWN disposable crew login + turnover per test
// (mirroring 27-crew-feedback.spec.ts) rather than reusing the shared
// e2e/.auth/crew.json. Two of the three tests below end in a real logout
// (supabase.auth.signOut(), which revokes the session server-side) — since
// crew.json is a static storageState snapshot loaded fresh per test but the
// underlying session is a single shared server-side record, whichever test
// logs out first permanently kills the session for every test that runs
// after it in this same file, regardless of declaration order (only one of
// the three tests preserves the session by clicking "Stay Logged In"). A
// throwaway per-test account with its own turnover has no such shared-state
// hazard.
test.describe('Crew logout guard', () => {
  // loginAsFreshCrewWithTurnover() below does 5 sequential Supabase Admin
  // API round trips (createUser, crew_members, turnovers,
  // turnover_assignments, checklist_instances, checklist_instance_items)
  // plus a full page navigation/login before a test's own assertions even
  // start — under CI load that alone can eat most of the default 30s
  // per-test budget, so these tests were reaching the correct destination
  // (login genuinely succeeded) and still failing on "Test timeout of
  // 30000ms exceeded."
  test.describe.configure({ timeout: 60_000 })

  test('logout with no unsynced work redirects immediately, no warning dialog', async ({ ctx, browser }) => {
    const { page, cleanup } = await loginAsFreshCrewWithTurnover(ctx.orgId, browser)
    try {
      await page.getByRole('button', { name: 'Log out' }).click()

      await page.waitForURL('**/login**', { timeout: 10_000 })
      await expect(page.getByText('Unsynced work on this device')).not.toBeVisible()
    } finally {
      await cleanup()
    }
  })

  test('offline checklist tick blocks logout with a warning, "Stay Logged In" cancels', async ({ ctx, browser }) => {
    const { page, cleanup } = await loginAsFreshCrewWithTurnover(ctx.orgId, browser)
    try {
      // Open the seeded turnover, then its checklist — the counters item lives there.
      const turnoverLink = page.locator('a[href^="/crew/turnovers/"]').first()
      await turnoverLink.waitFor({ timeout: 15_000 })
      await turnoverLink.click()
      await page.getByText('Turnover Checklist').click()
      await page.getByText('[E2E] Wipe kitchen counters').waitFor({ timeout: 10_000 })

      // Go offline before ticking the item, so the mutation queues locally
      // and never reaches the outbox handler.
      await page.context().setOffline(true)

      await page.getByLabel(/Mark (complete|incomplete)/).first().click()
      // Optimistic local write — no network round trip to wait for.
      await page.waitForTimeout(300)

      await page.getByRole('button', { name: 'Log out' }).click()

      const dialog = page.getByText('Unsynced work on this device')
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      await expect(page.getByText(/1 item.*haven.t reached FieldStay yet/)).toBeVisible()

      await page.getByRole('button', { name: 'Stay Logged In' }).click()
      await expect(dialog).not.toBeVisible()

      // Session must still be active — no redirect happened.
      await expect(page).toHaveURL(/\/crew/)

      await page.context().setOffline(false)
    } finally {
      await cleanup()
    }
  })

  test('offline checklist tick + "Log Out Anyway" clears local data and redirects', async ({ ctx, browser }) => {
    const { page, cleanup } = await loginAsFreshCrewWithTurnover(ctx.orgId, browser)
    try {
      const turnoverLink = page.locator('a[href^="/crew/turnovers/"]').first()
      await turnoverLink.waitFor({ timeout: 15_000 })
      await turnoverLink.click()
      await page.getByText('Turnover Checklist').click()
      await page.getByText('[E2E] Wipe kitchen counters').waitFor({ timeout: 10_000 })

      await page.context().setOffline(true)

      // Toggling the same item again is fine — the guard counts queued
      // mutation rows, not completion direction.
      await page.getByLabel(/Mark (complete|incomplete)/).first().click()
      await page.waitForTimeout(300)

      await page.getByRole('button', { name: 'Log out' }).click()
      await expect(page.getByText('Unsynced work on this device')).toBeVisible({ timeout: 10_000 })

      await page.getByRole('button', { name: 'Log Out Anyway' }).click()

      await page.waitForURL('**/login**', { timeout: 10_000 })

      // performLogout() deletes the per-user Dexie database before the
      // redirect — confirm it's actually gone, not just that the dialog closed.
      const dbNames = await page.evaluate(async () => {
        const dbs = await indexedDB.databases()
        return dbs.map((d) => d.name)
      })
      expect(dbNames.some((name) => name?.startsWith('fieldstay-crew-'))).toBe(false)

      await page.context().setOffline(false)
    } finally {
      await cleanup()
    }
  })

})

async function loginAsFreshCrewWithTurnover(orgId: string, browser: import('@playwright/test').Browser) {
  const supabase = getServiceClient()

  const { data: property, error: propertyErr } = await supabase
    .from('properties')
    .select('id')
    .eq('org_id', orgId)
    .eq('name', '[E2E] The Lakehouse')
    .single()
  if (propertyErr || !property) throw new Error(`Seed property [E2E] The Lakehouse not found: ${propertyErr?.message}`)

  // crypto.randomUUID() rather than Date.now() — this file's three tests
  // could in principle run alongside another disposable-crew spec
  // (27-crew-feedback.spec.ts) and a millisecond collision would fail
  // createUser() on a duplicate email.
  const crewEmail    = `e2e-crew-logout-${crypto.randomUUID()}@e2e-test.invalid`
  const crewPassword = 'E2E-Crew-Logout-Test-1!'
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: crewEmail, password: crewPassword, email_confirm: true,
  })
  if (createErr || !created.user) throw new Error(`Failed to create crew test user: ${createErr?.message}`)
  const userId = created.user.id

  // Everything past this point can throw — without this catch, a failure
  // here would skip the `cleanup` this function never got to return,
  // orphaning the just-created auth user and any rows already inserted in
  // the E2E project. Track each row's id as soon as it's created so the
  // catch block can roll all of them back, not just the auth user.
  let context:       import('@playwright/test').BrowserContext | undefined
  let crewMemberId:  string | undefined
  let turnoverId:    string | undefined
  try {
    const { data: crewMember, error: cmErr } = await supabase
      .from('crew_members')
      .insert({
        org_id:             orgId,
        user_id:            userId,
        // Distinct from the static "[E2E] Logout Guard Crew" name
        // global-setup.ts's seedCrewLoginAndAssignment() seeds for
        // e2e/.auth/crew.json — 18-messages.spec.ts asserts on that exact
        // seeded row, and this helper creates a fresh one per test here,
        // so sharing the name would leave ambiguous duplicates in the DB
        // for the rest of the run.
        name:               '[E2E] Fresh Logout Guard Crew',
        role:               'cleaning',
        specialty:          'cleaning',
        is_active:          true,
        invite_accepted_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (cmErr || !crewMember) throw new Error(`Failed to create crew_members row: ${cmErr?.message}`)
    crewMemberId = crewMember.id

    const checkout = new Date(Date.now() + 2 * 60 * 60 * 1000) // 2h from now
    const checkin  = new Date(Date.now() + 26 * 60 * 60 * 1000) // next day

    const { data: turnover, error: turnoverErr } = await supabase
      .from('turnovers')
      .insert({
        org_id:            orgId,
        property_id:       property.id,
        checkout_datetime: checkout.toISOString(),
        checkin_datetime:  checkin.toISOString(),
        status:            'assigned',
        priority:          'medium',
        auto_generated:    false,
      })
      .select('id')
      .single()
    if (turnoverErr || !turnover) throw new Error(`Failed to create turnover: ${turnoverErr?.message}`)
    turnoverId = turnover.id

    const { error: assignErr } = await supabase.from('turnover_assignments').insert({
      turnover_id:    turnover.id,
      crew_member_id: crewMember.id,
      org_id:         orgId,
      property_id:    property.id,
    })
    if (assignErr) throw new Error(`Failed to create turnover_assignments row: ${assignErr.message}`)

    const { data: instance, error: instanceErr } = await supabase
      .from('checklist_instances')
      .insert({
        turnover_id:       turnover.id,
        org_id:            orgId,
        template_snapshot: {},
        status:            'not_started',
      })
      .select('id')
      .single()
    if (instanceErr || !instance) throw new Error(`Failed to create checklist instance: ${instanceErr?.message}`)

    const { error: itemErr } = await supabase.from('checklist_instance_items').insert({
      instance_id:    instance.id,
      turnover_id:    turnover.id,
      section_name:   '[E2E] Kitchen',
      task:           '[E2E] Wipe kitchen counters',
      requires_photo: false,
      is_completed:   false,
      sort_order:     0,
    })
    if (itemErr) throw new Error(`Failed to create checklist instance item: ${itemErr.message}`)

    // Fresh, unauthenticated context — the default `page` fixture carries the
    // PM's storageState, which would put the crew layout's PM-guard redirect
    // in the way of a crew login.
    //
    // storageState: undefined is NOT redundant with the bare call below it —
    // Playwright Test instruments every browser.newContext() made during a
    // running test (not just the fixture-provided `context`/`page`), and
    // silently re-applies the project's configured `use.storageState`
    // ('e2e/.auth/pm.json' — see playwright.config.ts) to it. A bare
    // `browser.newContext()` here is therefore secretly PM-authenticated,
    // not fresh: page.goto('/login?next=/crew') 307s straight past the
    // login form (proxy.ts sees an authenticated user hitting a public
    // route) to /crew, which the crew layout's PM-guard then 307s again to
    // /ops — and #email never existed on that page, so the next line's
    // page.fill() times out. Confirmed by a standalone repro against the
    // installed @playwright/test package: a bare browser.newContext() came
    // back carrying a cookie seeded only via the project's storageState
    // config. Explicitly overriding it to undefined is the only way to get
    // a genuinely blank context.
    context = await browser.newContext({ storageState: undefined })
    const page = await context.newPage()

    await page.goto('/login?next=/crew')
    await page.fill('#email', crewEmail)
    await page.fill('#password', crewPassword)
    await page.click('button[type="submit"]')
    await page.waitForURL((url) => url.pathname === '/crew', { timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    return {
      page,
      cleanup: async () => {
        // context.close() throwing must not skip the deletes below — same
        // orphaned-data hazard this try/catch exists to close.
        try {
          await context!.close()
        } finally {
          // turnovers first — turnover_assignments/checklist_instances/
          // checklist_instance_items cascade from it (ON DELETE CASCADE).
          await supabase.from('turnovers').delete().eq('id', turnover.id)
          // crew_members.user_id is ON DELETE SET NULL, not CASCADE — the
          // auth user delete alone would leave this row behind orphaned.
          await supabase.from('crew_members').delete().eq('id', crewMember.id)
          await supabase.auth.admin.deleteUser(userId)
        }
      },
    }
  } catch (err) {
    await context?.close().catch(() => {})
    try {
      if (turnoverId)   await supabase.from('turnovers').delete().eq('id', turnoverId)
      if (crewMemberId) await supabase.from('crew_members').delete().eq('id', crewMemberId)
    } catch { /* best-effort rollback — the outer error is what matters */ }
    await supabase.auth.admin.deleteUser(userId).catch(() => {})
    throw err
  }
}
