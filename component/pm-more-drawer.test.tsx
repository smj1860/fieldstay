import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PmMoreDrawer } from '@/components/pm-more-drawer'

vi.mock('next/navigation', () => ({
  usePathname: () => '/ops',
}))

// ============================================================================
// A phone has TWO nav surfaces in this app: the ☰ drawer (the full sidebar,
// pinned blocks included) and the bottom-nav "More" sheet. Support Inbox
// existed only in the first one, which is not the one a thumb reaches for, so
// on a phone it read as simply absent.
//
// Two independent things had to be true for it to appear, and a fix that got
// only one of them would have looked correct and changed nothing: the explicit
// `item.id !== 'support-inbox'` filter had to go, AND `isStaff` had to be
// threaded through — getVisibleNavItems() drops every `condition: 'staff'`
// item without it. These tests pin both.
// ============================================================================

function renderDrawer(props: Partial<React.ComponentProps<typeof PmMoreDrawer>> = {}) {
  return render(
    <PmMoreDrawer open onClose={vi.fn()} role="admin" isStaff={false} {...props} />,
  )
}

describe('PmMoreDrawer', () => {
  it('shows Support Inbox to platform staff', () => {
    renderDrawer({ isStaff: true })
    expect(screen.getByRole('link', { name: /support inbox/i })).toBeInTheDocument()
  })

  it('hides Support Inbox from everyone else', () => {
    // It is a platform-staff surface, not a tenant one. The role filter is not
    // what protects it — `condition: 'staff'` is — so an admin without the
    // flag must not see it.
    renderDrawer({ isStaff: false })
    expect(screen.queryByRole('link', { name: /support inbox/i })).not.toBeInTheDocument()
  })

  it('still hides Support Inbox from a manager who is not staff', () => {
    renderDrawer({ role: 'manager', isStaff: false })
    expect(screen.queryByRole('link', { name: /support inbox/i })).not.toBeInTheDocument()
  })

  it('keeps Help out of the sheet — it has its own pinned block in the sidebar', () => {
    renderDrawer({ isStaff: true })
    expect(screen.queryByRole('link', { name: /help/i })).not.toBeInTheDocument()
  })

  it('still renders the ordinary management items alongside it', () => {
    // Guards against a filter change that accidentally narrows the sheet to
    // the one item this fix was about.
    renderDrawer({ isStaff: true })
    expect(screen.getByRole('link', { name: /bookings/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument()
  })

  it('renders nothing when closed', () => {
    render(<PmMoreDrawer open={false} onClose={vi.fn()} role="admin" isStaff />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
