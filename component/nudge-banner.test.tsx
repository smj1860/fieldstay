import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NudgeBanner } from '@/components/nudge-banner'

describe('NudgeBanner', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders the message and link when not previously dismissed', () => {
    render(
      <NudgeBanner id="test-nudge" message="Try the new thing" href="/somewhere" linkText="Check it out" />
    )

    expect(screen.getByText('Try the new thing')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Check it out/ })).toHaveAttribute('href', '/somewhere')
  })

  it('hides itself and persists the dismissal when the dismiss button is clicked', async () => {
    render(
      <NudgeBanner id="test-nudge" message="Try the new thing" href="/somewhere" linkText="Check it out" />
    )

    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    expect(screen.queryByText('Try the new thing')).not.toBeInTheDocument()
    expect(localStorage.getItem('fieldstay_dismissed_nudges')).toBe(JSON.stringify(['test-nudge']))
  })

  it('stays hidden on a fresh render once already dismissed', () => {
    localStorage.setItem('fieldstay_dismissed_nudges', JSON.stringify(['test-nudge']))

    render(
      <NudgeBanner id="test-nudge" message="Try the new thing" href="/somewhere" linkText="Check it out" />
    )

    expect(screen.queryByText('Try the new thing')).not.toBeInTheDocument()
  })

  it('does not affect a different nudge id', () => {
    localStorage.setItem('fieldstay_dismissed_nudges', JSON.stringify(['some-other-nudge']))

    render(
      <NudgeBanner id="test-nudge" message="Try the new thing" href="/somewhere" linkText="Check it out" />
    )

    expect(screen.getByText('Try the new thing')).toBeInTheDocument()
  })
})
