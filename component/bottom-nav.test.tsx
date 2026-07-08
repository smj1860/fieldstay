import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BottomNav } from '@/components/bottom-nav'

const mockUsePathname = vi.fn<() => string>()

vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}))

describe('BottomNav', () => {
  beforeEach(() => {
    mockUsePathname.mockReset()
  })

  it('shows every item for a manager', () => {
    mockUsePathname.mockReturnValue('/ops')
    render(<BottomNav role="manager" onMore={vi.fn()} />)

    expect(screen.getByRole('link', { name: /Overview/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Turnovers/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Inventory/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Maintenance/ })).toBeInTheDocument()
  })

  it('hides Inventory and Maintenance for a viewer', () => {
    mockUsePathname.mockReturnValue('/ops')
    render(<BottomNav role="viewer" onMore={vi.fn()} />)

    expect(screen.getByRole('link', { name: /Overview/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Turnovers/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Inventory/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Maintenance/ })).not.toBeInTheDocument()
  })

  it('treats an owner the same as an admin', () => {
    mockUsePathname.mockReturnValue('/ops')
    render(<BottomNav role="owner" onMore={vi.fn()} />)

    expect(screen.getByRole('link', { name: /Inventory/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Maintenance/ })).toBeInTheDocument()
  })

  it('links to the right hrefs', () => {
    mockUsePathname.mockReturnValue('/ops')
    render(<BottomNav role="admin" onMore={vi.fn()} />)

    expect(screen.getByRole('link', { name: /Turnovers/ })).toHaveAttribute('href', '/turnovers')
    expect(screen.getByRole('link', { name: /Maintenance/ })).toHaveAttribute('href', '/maintenance')
  })

  it('calls onMore when the Menu button is clicked, and marks it active on an unmatched path', async () => {
    mockUsePathname.mockReturnValue('/settings')
    const onMore = vi.fn()
    render(<BottomNav role="admin" onMore={onMore} />)

    const menuButton = screen.getByRole('button', { name: /Menu/ })
    // moreActive → gold color, since /settings matches none of the nav items
    expect(menuButton).toHaveStyle({ color: 'var(--chrome-gold)' })

    await userEvent.click(menuButton)
    expect(onMore).toHaveBeenCalledTimes(1)
  })

  it('does not mark Menu active when a nav item matches the path', () => {
    mockUsePathname.mockReturnValue('/turnovers/123')
    render(<BottomNav role="admin" onMore={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Menu/ })).toHaveStyle({ color: 'var(--chrome-text-muted)' })
    expect(screen.getByRole('link', { name: /Turnovers/ })).toHaveStyle({ color: 'var(--chrome-gold)' })
  })
})
