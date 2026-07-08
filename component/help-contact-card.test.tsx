import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HelpContactCard } from '@/components/help/help-contact-card'

describe('HelpContactCard', () => {
  it('renders a mailto link to support', () => {
    render(<HelpContactCard />)

    expect(screen.getByText('Still stuck?')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Email Support/ })).toHaveAttribute(
      'href',
      'mailto:support@fieldstay.app'
    )
  })
})
