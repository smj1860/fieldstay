import { test, expect } from '../fixtures'
import { getServiceClient } from '../helpers/teardown'

test.describe('Inventory', () => {

  test('inventory page loads', async ({ page }) => {
    await page.goto('/inventory')
    await expect(
      page.getByRole('heading', { name: /Inventory/i }).or(
        page.getByText(/No inventory/i).or(
          page.getByText(/Par levels/i)
        )
      )
    ).toBeVisible()
  })

  test('can navigate to inventory template', async ({ page }) => {
    await page.goto('/setup/inventory-template')
    await expect(page).toHaveURL(/inventory-template/)
    await expect(
      page.getByRole('heading').first()
    ).toBeVisible()
  })

  // Dynamic PAR engine happy path: a smart org-catalog item, added to the
  // seeded property via the par-levels editor, resolves to the
  // guest_consumable formula value against that property's real metadata
  // ([E2E] The Lakehouse: bathrooms 2 / bedrooms 3 / max_guests 6, set in
  // global-setup.ts — base_qty 1 × 6 guests × 1.10 buffer = ceil(6.6) = 7),
  // then can be pinned to static and the typed value persists across a
  // reload. org_inventory_catalog/inventory_items aren't covered by
  // global-setup.ts's prefix-based cleanup, so this test tears itself down.
  test('[E2E] smart par item resolves the formula value and can be pinned to static', async ({ page, ctx }) => {
    const supabase = getServiceClient()
    const itemName = '[E2E] Smart Bath Towels'

    const { data: catalogItem, error: catalogError } = await supabase
      .from('org_inventory_catalog')
      .insert({
        org_id:             ctx.orgId,
        name:               itemName,
        category:           'bath',
        default_unit:       'each',
        default_par_level:  1,
        par_mode:           'smart',
        smart_group:        'guest_consumable',
        base_qty:           1,
      })
      .select('id')
      .single()
    expect(catalogError).toBeNull()

    try {
      await page.goto('/templates/inventory/par-levels')
      await page.getByRole('button', { name: /\[E2E\] The Lakehouse/ }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      await page.getByRole('button', { name: itemName }).click()

      const row = page.locator('.divide-y > div').filter({ hasText: itemName })
      await expect(row.getByText('Auto (formula)')).toBeVisible()
      // ceil(1 × 6 guests × 1.10) = 7
      await expect(row).toContainText('7')

      await page.getByRole('button', { name: /Save \d+ change/ }).click()
      await expect(page.getByRole('button', { name: /Save \d+ change/ })).toBeDisabled({ timeout: 10_000 })

      await row.getByRole('button', { name: 'Override' }).click()
      const parInput = row.getByLabel(`Par level for ${itemName}`)
      await expect(parInput).toHaveValue('7')
      await parInput.fill('10')

      await page.getByRole('button', { name: /Save \d+ change/ }).click()
      await expect(page.getByRole('button', { name: /Save \d+ change/ })).toBeDisabled({ timeout: 10_000 })

      // Prove it persisted server-side, not just in local component state.
      await page.reload()
      await page.getByRole('button', { name: /\[E2E\] The Lakehouse/ }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const persistedRow = page.locator('.divide-y > div').filter({ hasText: itemName })
      await expect(persistedRow.getByLabel(`Par level for ${itemName}`)).toHaveValue('10')
      await expect(persistedRow.getByText('Auto (formula)')).not.toBeVisible()
    } finally {
      await supabase.from('inventory_items').delete().eq('org_id', ctx.orgId).eq('catalog_item_id', catalogItem?.id ?? '')
      await supabase.from('org_inventory_catalog').delete().eq('id', catalogItem?.id ?? '')
    }
  })

})
