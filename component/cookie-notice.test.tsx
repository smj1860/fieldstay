import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CookieNotice } from '@/components/cookie-notice'

const STORAGE_KEY = 'fs-cookie-notice-dismissed'

describe('CookieNotice', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows the notice and privacy link when not previously dismissed', () => {
    render(<CookieNotice />)

    expect(screen.getByRole('region', { name: 'Cookie notice' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/privacy#cookies')
  })

  it('hides and persists dismissal when "Got it" is clicked', async () => {
    render(<CookieNotice />)

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss cookie notice' }))

    expect(screen.queryByRole('region', { name: 'Cookie notice' })).not.toBeInTheDocument()
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1')
  })

  it('hides and persists dismissal when the close (X) button is clicked', async () => {
    render(<CookieNotice />)

    await userEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('region', { name: 'Cookie notice' })).not.toBeInTheDocument()
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1')
  })

  it('stays hidden on a fresh render once already dismissed', () => {
    localStorage.setItem(STORAGE_KEY, '1')

    render(<CookieNotice />)

    expect(screen.queryByRole('region', { name: 'Cookie notice' })).not.toBeInTheDocument()
  })
})
