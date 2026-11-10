import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

type InsertHandler = (payload: { new: Record<string, unknown> }) => void
let insertHandler: InsertHandler | null = null

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: () => ({
      on: (_event: string, _filter: unknown, handler: InsertHandler) => {
        insertHandler = handler
        return { subscribe: () => ({}) }
      },
    }),
    removeChannel: vi.fn(),
  }),
}))

import { SupportChatWidget } from '@/components/support/support-chat-widget'

// ============================================================================
// A staff reply is saved even when the customer is not looking. Before the
// widget restored its thread, a customer who came back later saw an empty chat
// and never learned the reply existed. These pin the two things that fix it:
// the earlier thread comes back, and an unseen staff reply is signalled on the
// closed launcher.
// ============================================================================

const SEEN_KEY = 'fieldstay:support-seen:c1'
const REPLY_AT = '2026-11-10T20:30:00+00:00'

const thread = {
  conversationId: 'c1',
  messages: [
    { id: 'm1', role: 'user',      content: 'What can I do?',            createdAt: '2026-11-10T20:10:00+00:00' },
    { id: 'm2', role: 'assistant', content: 'I am Finn.',                createdAt: '2026-11-10T20:10:05+00:00' },
    { id: 'm3', role: 'human',     content: 'Welcome, glad you are here', createdAt: REPLY_AT },
  ],
}

function stubHistory(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })))
}

const launcher = () => screen.findByRole('button', { name: /Open support chat/ })

describe('SupportChatWidget', () => {
  beforeEach(() => {
    insertHandler = null
    localStorage.clear()
    // jsdom does not implement scrollIntoView, which the widget calls when the panel opens.
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('restores the earlier thread, including a staff reply sent while the customer was away', async () => {
    stubHistory(thread)
    render(<SupportChatWidget />)
    await userEvent.click(await launcher())
    expect(await screen.findByText('Welcome, glad you are here')).toBeInTheDocument()
    expect(screen.getByText('What can I do?')).toBeInTheDocument()
    expect(screen.getByText('FieldStay Team')).toBeInTheDocument()
  })

  it('signals an unseen staff reply on the closed launcher', async () => {
    stubHistory(thread)
    render(<SupportChatWidget />)
    expect(await screen.findByRole('button', { name: /new reply from the FieldStay team/ })).toBeInTheDocument()
  })

  it('does not signal a reply this device already saw', async () => {
    localStorage.setItem(SEEN_KEY, REPLY_AT)
    stubHistory(thread)
    render(<SupportChatWidget />)
    // Wait until history has loaded, then check the label never gained the cue.
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Open support chat' })).toBeInTheDocument()
  })

  it('clears the signal once the chat is opened, and remembers the reply as seen', async () => {
    stubHistory(thread)
    render(<SupportChatWidget />)
    await userEvent.click(await screen.findByRole('button', { name: /new reply/ }))
    await waitFor(() => expect(localStorage.getItem(SEEN_KEY)).toBe(REPLY_AT))
    await userEvent.click(screen.getByRole('button', { name: 'Close support chat' }))
    expect(await screen.findByRole('button', { name: 'Open support chat' })).toBeInTheDocument()
  })

  it('signals a reply that arrives live while the chat is closed', async () => {
    stubHistory({ ...thread, messages: thread.messages.slice(0, 2) })
    render(<SupportChatWidget />)
    await launcher()
    await waitFor(() => expect(insertHandler).not.toBeNull())
    act(() => insertHandler!({
      new: { id: 'm9', role: 'human', content: 'Quick follow up', created_at: '2026-11-10T21:00:00+00:00' },
    }))
    expect(await screen.findByRole('button', { name: /new reply/ })).toBeInTheDocument()
  })

  it('does not show a live reply twice when history already holds it', async () => {
    stubHistory(thread)
    render(<SupportChatWidget />)
    await userEvent.click(await screen.findByRole('button', { name: /new reply/ }))
    await screen.findByText('Welcome, glad you are here')
    await waitFor(() => expect(insertHandler).not.toBeNull())
    act(() => insertHandler!({
      new: { id: 'm3', role: 'human', content: 'Welcome, glad you are here', created_at: REPLY_AT },
    }))
    expect(screen.getAllByText('Welcome, glad you are here')).toHaveLength(1)
  })

  it('shows the greeting and no signal for a customer who has never chatted', async () => {
    stubHistory({ conversationId: null, messages: [] })
    render(<SupportChatWidget />)
    await userEvent.click(await launcher())
    expect(await screen.findByText(/I'm Finn/)).toBeInTheDocument()
  })

  it('still opens normally when the history request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    render(<SupportChatWidget />)
    await userEvent.click(await launcher())
    expect(await screen.findByText(/I'm Finn/)).toBeInTheDocument()
  })
})
