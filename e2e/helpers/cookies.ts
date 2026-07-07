import type { Page } from '@playwright/test'

export async function dismissCookieBanner(page: Page): Promise<void> {
  const banner = page.getByRole('region', { name: 'Cookie notice' })
  const isVisible = await banner.isVisible().catch(() => false)
  if (!isVisible) return

  const dismissBtn = page.getByRole('button', {
    name: /accept|got it|ok|dismiss|close|agree|allow/i,
  }).first()

  const btnVisible = await dismissBtn.isVisible().catch(() => false)
  if (btnVisible) {
    await dismissBtn.click()
    await banner.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {})
  }
}
