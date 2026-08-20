import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PricingSection from '@/components/ownerrez/PricingSection'

// The `isLoggedIn` prop is gone (2026-08-20), and with it the "logged in: CTA
// connects directly" case this file used to assert.
//
// It was never reachable in production. The page that renders this stopped
// resolving a session on 2026-08-19 — the cookies() call it needed forced
// dynamic rendering on a page whose whole job is to be fetched by strangers —
// so the prop arrived hardcoded `false` from then on. The test kept passing
// because it constructed the state itself.
//
// That is the shape unit/guardrails/unreferenced-server-actions.ts exists for
// on the server side: a full passing suite around a branch nothing can reach.
describe('PricingSection (OwnerRez)', () => {
  it('every "Start Free Trial" CTA routes through onboarding, not straight to connect', () => {
    render(<PricingSection />)

    const ctas = screen.getAllByRole('link', { name: /Start Free Trial/i })
    expect(ctas.length).toBeGreaterThan(0)
    for (const cta of ctas) {
      expect(cta).toHaveAttribute(
        'href',
        '/signup?provider=ownerrez&next=/onboarding'
      )
    }
  })

  it('no CTA links straight to the connect endpoint', () => {
    // The removed branch's destination. A signed-in visitor following the
    // signup link lands on /signup, which proxy.ts redirects to /ops, so the
    // shortcut is the only thing lost — but it must not come back by accident
    // on a page anonymous traffic sees.
    render(<PricingSection />)

    for (const cta of screen.getAllByRole('link')) {
      expect(cta.getAttribute('href') ?? '').not.toContain('/api/integrations/ownerrez/connect')
    }
  })
})
