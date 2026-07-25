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
  // hasText does a case-insensitive SUBSTRING match, not an exact match —
  // waiting for label "Owner 1" would already resolve as soon as an
  // "Owner 10" option is attached, so the later selectOption({ label })
  // call (which does match exactly) could still race a not-yet-rendered
  // "Owner 1" option. Anchor the regex to require an exact match.
  const exact = new RegExp(`^${escapeRegex(label)}$`)
  await select.locator('option', { hasText: exact }).first().waitFor({ state: 'attached', timeout })
  await select.selectOption({ label })
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}
