import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import PricingCards from '@/components/pricing/PricingCards'
import type { PricingTier } from '@/components/pricing/plan-tiers'

// ============================================================================
// The calculator's number input feeds `qty` straight into
// monthlyCostCents()/annualCostCents(), both of which return `null` for a
// non-integer quantity. PricingCalculator read them with a non-null
// assertion (`monthlyCostCents(qty)!`), and `null! / 100` does not throw —
// `null` coerces to `0` in a numeric division — so typing a decimal like
// "12.5" rendered "$0/mo" to a visitor instead of a real price. Nothing on
// the range input or the old `Number(e.target.value) || 1` clamp on the
// number input rejected a non-integer value.
// ============================================================================

const TIERS: PricingTier[] = [
  { name: 'Hosts', description: '', monthly: 49, annual: 490, annualSavings: 98, properties: '1', highlight: false, features: [] },
  { name: 'Starter', description: '', monthly: 62, annual: 620, annualSavings: 124, properties: '2-4', highlight: false, features: [] },
  { name: 'Growth', description: '', monthly: 92, annual: 920, annualSavings: 184, properties: '5-15', highlight: true, features: [] },
  { name: 'Portfolio', description: '', monthly: 172, annual: 1720, annualSavings: 344, properties: '16-50', highlight: false, features: [] },
  { name: 'Enterprise', description: '', monthly: null, annual: null, annualSavings: null, properties: '51+', highlight: false, features: [] },
]

function priceText(): string {
  // "Your price" is the label; the dollar figure is the next sibling block.
  const label = screen.getByText('Your price')
  return label.parentElement!.textContent ?? ''
}

/** Renders the calculator and types `value` into its number input. */
function typeQty(value: string): HTMLInputElement {
  render(<PricingCards tiers={TIERS} annual={false} signupHref="/signup" />)
  const input = screen.getByRole('spinbutton') as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  return input
}

describe('PricingCards calculator — non-integer property counts', () => {
  it('rounds a decimal typed into the number input to a valid integer', () => {
    const input = typeQty('12.5')

    // Clamped to a valid integer rather than passed straight through.
    expect(input.value).toBe('13')
  })

  it('never shows $0/mo for a decimal typed into the number input', () => {
    // Independent of the clamp assertion above: monthlyCostCents()/
    // annualCostCents() return null for a non-integer quantity, and
    // PricingCalculator used to read them with a non-null assertion —
    // `null! / 100` doesn't throw, it silently evaluates to 0.
    typeQty('12.5')

    expect(priceText()).not.toMatch(/\$0(?!\d)/)
  })

  it('clamps a non-numeric entry to 1 rather than NaN', () => {
    const input = typeQty('abc')

    expect(input.value).toBe('1')
    expect(priceText()).not.toMatch(/\$0(?!\d)/)
  })

  it('clamps an out-of-range entry to MAX_SELF_SERVE_PROPERTIES', () => {
    const input = typeQty('9999')

    expect(input.value).toBe('150')
  })

  it('still shows a real price for an ordinary integer entry', () => {
    const input = typeQty('30')

    expect(input.value).toBe('30')
    expect(priceText()).not.toMatch(/\$0(?!\d)/)
  })
})

// ============================================================================
// The annual branch of a tier card's price called .toLocaleString()
// (comma-formats thousands); the monthly branch did not — `plan.monthly` was
// rendered via raw template-literal coercion. Invisible today because every
// tier's floor-computed monthly figure stays under 1,000, but
// monthlyCostCents(150) (the true schedule ceiling) is already 1,068 — a
// future rebracketing that pushes a tier's displayed monthly past 999 would
// render $1068 next to a comma-formatted $10,680 annual figure on the same
// toggle.
// ============================================================================
describe('PricingCards tier cards — monthly/annual number formatting parity', () => {
  const FOUR_DIGIT_TIERS: PricingTier[] = [
    { name: 'Portfolio', description: '', monthly: 1068, annual: 10680, annualSavings: 2136, properties: '51-150', highlight: false, features: [] },
  ]

  it('comma-formats a four-digit monthly price the same way the annual price already is', () => {
    render(<PricingCards tiers={FOUR_DIGIT_TIERS} annual={false} signupHref="/signup" />)

    expect(screen.getByText('$1,068')).toBeInTheDocument()
    expect(screen.queryByText('$1068')).not.toBeInTheDocument()
  })

  it('still comma-formats the annual price on the same toggle', () => {
    render(<PricingCards tiers={FOUR_DIGIT_TIERS} annual={true} signupHref="/signup" />)

    expect(screen.getByText('$10,680')).toBeInTheDocument()
  })
})
