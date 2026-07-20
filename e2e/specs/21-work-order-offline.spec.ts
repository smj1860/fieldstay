import * as crypto from 'crypto'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures'
import { getServiceClient } from '../helpers/teardown'

async function dispatchOnline(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
}

test.describe('Work order offline support', () => {

  test('[E2E] crew work order completes offline and syncs on reconnect', async ({ ctx, browser }) => {
    const supabase = getServiceClient()

    const { data: property } = await supabase
      .from('properties').select('id').eq('org_id', ctx.orgId).eq('name', '[E2E] The Lakehouse').single()

    const crewEmail    = `e2e-crew-wo-${Date.now()}@e2e-test.invalid`
    const crewPassword = 'E2E-Crew-Offline-Test-1!'
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email: crewEmail, password: crewPassword, email_confirm: true,
    })
    if (createErr || !created.user) throw new Error(`Failed to create crew test user: ${createErr?.message}`)

    const { data: crewMember, error: cmErr } = await supabase.from('crew_members').insert({
      org_id:             ctx.orgId,
      user_id:            created.user.id,
      name:               '[E2E] Crew WO Tester',
      role:               'general',
      is_active:          true,
      invite_accepted_at: new Date().toISOString(),
    }).select('id').single()
    if (cmErr || !crewMember) throw new Error(`Failed to create crew_members row: ${cmErr?.message}`)

    const { data: wo, error: woErr } = await supabase.from('work_orders').insert({
      org_id:                  ctx.orgId,
      property_id:             property!.id,
      title:                   '[E2E] Offline Crew WO',
      category:                'general',
      priority:                'medium',
      status:                  'assigned',
      source:                  'manual',
      assigned_crew_member_id: crewMember.id,
    }).select('id').single()
    if (woErr || !wo) throw new Error(`Failed to create work order: ${woErr?.message}`)

    try {
      // Fresh, unauthenticated context — the default `page` fixture carries
      // the PM's storageState, which would put the crew layout's PM-guard
      // redirect in the way of a crew login.
      const context = await browser.newContext()
      const page    = await context.newPage()

      await page.goto('/login?next=/crew')
      await page.fill('#email', crewEmail)
      await page.fill('#password', crewPassword)
      await page.click('button[type="submit"]')
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })

      await page.goto(`/crew/work-orders/${wo.id}`)
      await expect(page.getByText('[E2E] Offline Crew WO')).toBeVisible({ timeout: 10_000 })

      // Simulate offline — block the completion route so the request never
      // reaches the server.
      await page.route('**/api/crew/work-orders/*/complete', (route) => route.abort())

      await page.getByRole('button', { name: /mark work complete/i }).click()

      // Optimistic local write — the UI shows done immediately despite the
      // blocked request.
      await expect(page.getByText('Work Complete')).toBeVisible({ timeout: 5_000 })

      // Confirm the server hasn't actually seen the completion yet.
      const { data: stillPending } = await supabase.from('work_orders').select('status').eq('id', wo.id).single()
      expect(stillPending?.status).not.toBe('completed')

      // Reconnect — remove the block and fire the 'online' event the same
      // way crew-shell.tsx's real listener would on an actual reconnect.
      await page.unroute('**/api/crew/work-orders/*/complete')
      await dispatchOnline(page)

      await expect.poll(async () => {
        const { data } = await supabase.from('work_orders').select('status').eq('id', wo.id).single()
        return data?.status
      }, { timeout: 10_000 }).toBe('completed')

      await context.close()
    } finally {
      await supabase.auth.admin.deleteUser(created.user.id)
    }
  })

  test('[E2E] vendor work order completes offline, survives reload, syncs on reconnect', async ({ ctx, page }) => {
    const supabase = getServiceClient()

    const { data: property } = await supabase
      .from('properties').select('id').eq('org_id', ctx.orgId).eq('name', '[E2E] The Lakehouse').single()
    const { data: vendor } = await supabase
      .from('vendors').select('id').eq('org_id', ctx.orgId).eq('name', '[E2E] Reliable Plumbing Co.').single()

    const token = crypto.randomUUID()
    const { data: wo, error: woErr } = await supabase.from('work_orders').insert({
      org_id:                      ctx.orgId,
      property_id:                 property!.id,
      title:                       '[E2E] Offline Vendor WO',
      category:                    'plumbing',
      priority:                    'medium',
      status:                      'assigned',
      source:                      'manual',
      vendor_id:                   vendor!.id,
      portal_enabled:               true,
      completion_token:            token,
      completion_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }).select('id').single()
    if (woErr || !wo) throw new Error(`Failed to create vendor work order: ${woErr?.message}`)

    await page.goto(`/work-orders/${token}`)
    await expect(page.getByText('[E2E] Offline Vendor WO')).toBeVisible({ timeout: 10_000 })

    await page.locator('input[placeholder="Description"]').first().fill('[E2E] Replaced valve')
    await page.locator('input[placeholder="0.00"]').first().fill('125')

    await page.route('**/api/work-orders/*/complete', (route) => route.abort())

    await page.getByRole('button', { name: /submit invoice/i }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 5_000 })

    // Reload while still "offline" — the queued submission should be
    // restored from IndexedDB, not lost to a blank form.
    await page.reload()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10_000 })

    const { data: stillAssigned } = await supabase.from('work_orders').select('status').eq('id', wo.id).single()
    expect(stillAssigned?.status).not.toBe('completed')

    await page.unroute('**/api/work-orders/*/complete')
    await dispatchOnline(page)

    await expect.poll(async () => {
      const { data } = await supabase.from('work_orders').select('status').eq('id', wo.id).single()
      return data?.status
    }, { timeout: 10_000 }).toBe('completed')

    const { data: invoices } = await supabase.from('work_order_invoices').select('id').eq('work_order_id', wo.id)
    expect(invoices?.length).toBe(1)
  })

  test('[E2E] vendor offline submission dead-letters cleanly when the WO was already closed', async ({ ctx, page }) => {
    const supabase = getServiceClient()

    const { data: property } = await supabase
      .from('properties').select('id').eq('org_id', ctx.orgId).eq('name', '[E2E] The Lakehouse').single()
    const { data: vendor } = await supabase
      .from('vendors').select('id').eq('org_id', ctx.orgId).eq('name', '[E2E] Reliable Plumbing Co.').single()

    const token = crypto.randomUUID()
    const { data: wo, error: woErr } = await supabase.from('work_orders').insert({
      org_id:                      ctx.orgId,
      property_id:                 property!.id,
      title:                       '[E2E] Already Closed Vendor WO',
      category:                    'plumbing',
      priority:                    'medium',
      status:                      'assigned',
      source:                      'manual',
      vendor_id:                   vendor!.id,
      portal_enabled:               true,
      completion_token:            token,
      completion_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }).select('id').single()
    if (woErr || !wo) throw new Error(`Failed to create vendor work order: ${woErr?.message}`)

    await page.goto(`/work-orders/${token}`)
    await expect(page.getByText('[E2E] Already Closed Vendor WO')).toBeVisible({ timeout: 10_000 })

    await page.locator('input[placeholder="Description"]').first().fill('[E2E] Replaced valve')
    await page.locator('input[placeholder="0.00"]').first().fill('125')

    await page.route('**/api/work-orders/*/complete', (route) => route.abort())
    await page.getByRole('button', { name: /submit invoice/i }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 5_000 })

    // Simulate "someone else closed it via another path" while this vendor
    // was offline queuing their own completion.
    await supabase.from('work_orders').update({ status: 'completed' }).eq('id', wo.id)

    await page.unroute('**/api/work-orders/*/complete')
    await dispatchOnline(page)

    await expect(page.getByText('Not Submitted')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/already closed/i)).toBeVisible()
    // No retry button should be offered for a terminal failure — retrying
    // an already-closed WO can never succeed.
    await expect(page.getByRole('button', { name: /retry now/i })).toHaveCount(0)
  })

})
