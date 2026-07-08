import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dialog } from '@/components/ui/Dialog'

describe('Dialog', () => {
  it('renders nothing when closed', () => {
    render(
      <Dialog open={false} onClose={vi.fn()} title="Test Dialog">
        <p>Body content</p>
      </Dialog>
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders the title and children when open', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Test Dialog">
        <p>Body content</p>
      </Dialog>
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Test Dialog')).toBeInTheDocument()
    expect(screen.getByText('Body content')).toBeInTheDocument()
  })

  it('calls onClose when the backdrop is clicked', async () => {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} title="Test Dialog">
        <p>Body content</p>
      </Dialog>
    )

    // The backdrop is the first of the two fixed-inset siblings inside the
    // portal root — aria-hidden, so query it directly rather than by role.
    const backdrop = document.querySelector('[aria-hidden="true"]')
    expect(backdrop).not.toBeNull()
    await userEvent.click(backdrop!)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} title="Test Dialog">
        <p>Body content</p>
      </Dialog>
    )

    await userEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} title="Test Dialog">
        <p>Body content</p>
      </Dialog>
    )

    await userEvent.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('locks and restores body scroll while open', () => {
    const { rerender, unmount } = render(
      <Dialog open onClose={vi.fn()} title="Test Dialog">
        <p>Body content</p>
      </Dialog>
    )

    expect(document.body.style.overflow).toBe('hidden')

    rerender(
      <Dialog open={false} onClose={vi.fn()} title="Test Dialog">
        <p>Body content</p>
      </Dialog>
    )

    expect(document.body.style.overflow).not.toBe('hidden')
    unmount()
  })
})
