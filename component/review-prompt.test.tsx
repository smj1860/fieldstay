import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReviewPrompt } from '@/components/review-prompt'

describe('ReviewPrompt', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let openMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    openMock = vi.fn()
    vi.stubGlobal('open', openMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the milestone message', () => {
    render(<ReviewPrompt milestone="first_turnover_completed" message="First turnover complete!" />)

    expect(screen.getByText(/First turnover complete!/)).toBeInTheDocument()
  })

  it('posts to review-clicked, opens the review URL, and hides on "Leave a Review"', async () => {
    render(<ReviewPrompt milestone="first_turnover_completed" message="First turnover complete!" />)

    await userEvent.click(screen.getByRole('button', { name: 'Leave a Review' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/milestones/review-clicked',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ milestone: 'first_turnover_completed' }),
      })
    ))
    expect(openMock).toHaveBeenCalledWith(
      expect.stringContaining('mailto:feedback@fieldstay.app'),
      '_blank',
      'noopener,noreferrer'
    )
    expect(screen.queryByText(/First turnover complete!/)).not.toBeInTheDocument()
  })

  it('posts to dismiss and hides on the X button, without opening anything', async () => {
    render(<ReviewPrompt milestone="first_turnover_completed" message="First turnover complete!" />)

    await userEvent.click(screen.getByTitle('Maybe later'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/milestones/dismiss',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ milestone: 'first_turnover_completed' }),
      })
    ))
    expect(openMock).not.toHaveBeenCalled()
    expect(screen.queryByText(/First turnover complete!/)).not.toBeInTheDocument()
  })
})
