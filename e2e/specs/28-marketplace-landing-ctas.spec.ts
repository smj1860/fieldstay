import { test, expect } from '../fixtures'

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

test.describe('Marketplace landing page CTAs (logged out)', () => {
  // Fresh browser context — no saved auth state, same pattern as 01-auth.spec.ts
  test.use({ storageState: { cookies: [], origins: [] } })

  test('OwnerRez landing: Section 5 CTA routes through onboarding', async ({ page }) => {
    await page.goto(`${BASE_URL}/ownerrez`)
    const cta = page.getByRole('link', { name: 'Create your FieldStay account' })
    await expect(cta).toHaveAttribute(
      'href',
      '/signup?provider=ownerrez&next=/onboarding'
    )
  })

  test('OwnerRez landing: pricing section CTAs route through onboarding', async ({ page }) => {
    await page.goto(`${BASE_URL}/ownerrez`)
    const ctas = page.getByRole('link', { name: 'Start Free Trial' })
    const count = await ctas.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      await expect(ctas.nth(i)).toHaveAttribute(
        'href',
        '/signup?provider=ownerrez&next=/onboarding'
      )
    }
  })

  test('Hospitable landing: Section 5 CTA routes through onboarding', async ({ page }) => {
    await page.goto(`${BASE_URL}/hospitable`)
    const cta = page.getByRole('link', { name: 'Create your FieldStay account' })
    await expect(cta).toHaveAttribute(
      'href',
      '/signup?provider=hospitable&next=/onboarding'
    )
  })

  test('Hospitable landing: pricing section CTAs route through onboarding', async ({ page }) => {
    await page.goto(`${BASE_URL}/hospitable`)
    const ctas = page.getByRole('link', { name: 'Start Free Trial' })
    const count = await ctas.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      await expect(ctas.nth(i)).toHaveAttribute(
        'href',
        '/signup?provider=hospitable&next=/onboarding'
      )
    }
  })
})
