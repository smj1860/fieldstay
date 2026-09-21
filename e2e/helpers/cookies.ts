import type { Page } from '@playwright/test'

export async function dismissCookieBanner(page: Page): Promise<void> {
  const banner = page.getByRole('region', { name: 'Cookie notice' })

  // WAIT for it rather than sampling once. components/cookie-notice.tsx renders
  // nothing on the server and on the first client paint (useSyncExternalStore
  // with a `false` server snapshot), then reveals itself on mount. A bare
  // isVisible() therefore races React: called right after a goto() it returns
  // false for a banner that is about to appear, this helper returns "nothing to
  // do", and the banner then sits over the page for the rest of the test.
  //
  // That race was invisible for as long as the banner happened to be short
  // enough to clear the controls underneath it. It stopped being invisible when
  // a copy change added one line: 25-owner-portal.spec.ts failed with the
  // banner's own <p> intercepting a click it had supposedly already dismissed.
  //
  // A timeout here is not a failure — plenty of specs run in a context where
  // the banner is genuinely already dismissed.
  await banner.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {})

  const isVisible = await banner.isVisible().catch(() => false)
  if (!isVisible) return

  // Scoped to the banner region: with force:true below, a page-wide locator
  // could force-click an open dialog's Close/OK button instead.
  const dismissBtn = banner.getByRole('button', {
    name: /accept|got it|ok|dismiss|close|agree|allow/i,
  }).first()

  const btnVisible = await dismissBtn.isVisible().catch(() => false)
  if (btnVisible) {
    // force: the fixed-position banner can sit under a Dialog overlay
    // (fixed inset-0) that intercepts pointer events — specs legitimately
    // dismiss the banner while a dialog is open, so bypass the hit-test.
    await dismissBtn.click({ force: true })
    await banner.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {})
  }
}
