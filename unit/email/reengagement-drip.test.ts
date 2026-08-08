import { describe, it, expect } from 'vitest'
import { renderReengagementEmail } from '@/emails/reengagement-drip'

// ============================================================================
// Day-7 onboarding email 3. The connected variant states a NUMBER — "N came in
// this week — RepuGuard already has draft responses ready for your approval" —
// and `reviewCount` arrived as a hardcoded literal `3` from
// lib/inngest/functions/onboarding-drip.tsx. Every connected PM was told three
// reviews had arrived and drafts were waiting, regardless of what was actually
// in their account: a false factual claim in a commercial email, and one the
// recipient disproves the moment they click the CTA.
//
// These assert against the RENDERED HTML rather than the props, because the
// claim lives in the copy, not in the call site.
// ============================================================================

const base = {
  firstName:       'Jamie',
  orgName:         'Lakeview Rentals',
  dashboardUrl:    'https://app.fieldstay.test/ops',
  integrationsUrl: 'https://app.fieldstay.test/settings?tab=integrations',
  onboardingUrl:   'https://app.fieldstay.test/onboarding',
}

// React Email escapes and may insert zero-width joiners / entity encodings, so
// compare on a normalised, tag-stripped string.
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|​|‌| /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('ReengagementEmail — connected, reviews actually arrived', () => {
  it('states the real count', async () => {
    const body = text(await renderReengagementEmail({ ...base, isConnected: true, reviewCount: 7 }))

    expect(body).toContain('7 reviews came in this week')
    expect(body).toContain('RepuGuard already has draft responses ready')
    expect(body).not.toContain('Nothing new came in this week')
  })

  it('says "review", singular, for exactly one', async () => {
    const body = text(await renderReengagementEmail({ ...base, isConnected: true, reviewCount: 1 }))

    expect(body).toContain('1 review came in this week')
    expect(body).not.toContain('1 reviews')
  })
})

describe('ReengagementEmail — connected, no reviews this week', () => {
  it('never claims reviews arrived and never renders a count of zero as if it were news', async () => {
    const body = text(await renderReengagementEmail({ ...base, isConnected: true, reviewCount: 0 }))

    expect(body).toContain('Nothing new came in this week')
    expect(body).not.toContain('came in this week — RepuGuard already has draft responses')
    expect(body).not.toMatch(/\b0 reviews? came in\b/)
    // Must not claim drafts are already waiting for reviews that do not exist.
    expect(body).not.toContain('already has draft responses ready')
  })

  it('does not fall through to the not-connected copy, which is equally untrue for this recipient', async () => {
    const body = text(await renderReengagementEmail({ ...base, isConnected: true, reviewCount: 0 }))

    expect(body).not.toContain("your PMS isn't connected yet")
    expect(body).toContain('Since you connected your PMS')
  })
})

describe('ReengagementEmail — not connected', () => {
  it('keeps the connect-your-PMS copy and never mentions a review count', async () => {
    const body = text(await renderReengagementEmail({ ...base, isConnected: false, reviewCount: 0 }))

    expect(body).toContain("your PMS isn't connected yet")
    expect(body).not.toContain('came in this week')
    expect(body).not.toContain('RepuGuard')
  })
})
