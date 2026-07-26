import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PricingSection from '@/components/hospitable/PricingSection'

describe('PricingSection (Hospitable)', () => {
  it('logged out: every "Start Free Trial" CTA routes through onboarding, not straight to connect', () => {
    render(<PricingSection isLoggedIn={false} />)

    const ctas = screen.getAllByRole('link', { name: /Start Free Trial/i })
    expect(ctas.length).toBeGreaterThan(0)
    for (const cta of ctas) {
      expect(cta).toHaveAttribute(
        'href',
        '/signup?provider=hospitable&next=/onboarding'
      )
    }
  })

  it('logged in: CTA connects directly, bypassing signup/onboarding', () => {
    render(<PricingSection isLoggedIn={true} />)

    const ctas = screen.getAllByRole('link', { name: /Start Free Trial/i })
    expect(ctas.length).toBeGreaterThan(0)
    for (const cta of ctas) {
      expect(cta).toHaveAttribute('href', '/api/integrations/hospitable/connect')
    }
  })
})
