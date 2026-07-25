import type { Locator } from '@playwright/test'

// selectOption() by label can race a <select>'s options being populated
// after a dialog opens or a page navigates — the properties/vendors/owners
// list is fetched client-side and isn't guaranteed to be in the DOM yet
// when the dialog first renders. When it loses that race, Playwright's own
// "waiting for element to be visible and enabled" / "did not find some
// options" retry loop just times out with no useful signal about why.
// Recurred across 23-booking-validation, 24-vendor-compliance-block, and
// 25-owner-portal — real, not one-off flake. Wait for the specific option
// to be attached first so the eventual selectOption() call always has
// something to select.
export async function selectOptionWhenReady(
  select: Locator,
  label: string,
  timeout = 10_000,
): Promise<void> {
  await select.locator('option', { hasText: label }).first().waitFor({ state: 'attached', timeout })
  await select.selectOption({ label })
}
