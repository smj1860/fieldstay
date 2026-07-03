import type { Page } from '@playwright/test'

export async function goToDashboard(page: Page, route: string) {
  await page.goto(route)
  // Ensure we didn't land on an auth redirect
  await page.waitForURL(`**${route}*`, { timeout: 10_000 })
}
