import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// ============================================================================
// handleSend() had no re-entrancy guard. queueMessageToPM mints a fresh
// crypto.randomUUID() on every call with no dedup, and setDraft('') — the
// thing that would visually clear the box — only runs AFTER the async queue
// call resolves. Two triggers reach handleSend (the Enter keydown and the
// button's onClick), so a fast double-tap or double-Enter before that promise
// settles queued the same message twice.
// ============================================================================

const mockRefresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => [],
}))

vi.mock('@/lib/dexie/context', () => ({
  useDexieDb:     () => ({ mutations: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) } }),
  useDexieUserId: () => 'user_1',
}))

vi.mock('@/app/(dashboard)/messages/actions', () => ({
  markConversationRead: vi.fn(async () => {}),
}))

vi.mock('@/lib/dexie/net', () => ({
  isOnline: () => false,
}))

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

let resolveQueue: ((id: string) => void) | null = null
const queueMessageToPM = vi.fn(() => new Promise<string>((resolve) => {
  resolveQueue = resolve
}))

vi.mock('@/lib/dexie/helpers', () => ({
  loadMessageDraft: vi.fn(async () => ''),
  saveMessageDraft: vi.fn(async () => {}),
  queueMessageToPM: (...args: unknown[]) => queueMessageToPM(...(args as [])),
}))

import { CrewMessagesView } from '@/app/crew/messages/messages-view'

describe('CrewMessagesView — handleSend re-entrancy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveQueue = null
    // jsdom does not implement scrollIntoView; the view calls it on every
    // message-list change.
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('does not queue the same message twice on a fast double-click', async () => {
    render(<CrewMessagesView userId="user_1" messages={[]} />)

    const textarea = screen.getByLabelText('Message to your operations team')
    fireEvent.change(textarea, { target: { value: 'On my way' } })

    const sendButton = screen.getByLabelText('Send message')
    // Two clicks before the in-flight queueMessageToPM promise has resolved —
    // the exact window a real double-tap lands in.
    fireEvent.click(sendButton)
    fireEvent.click(sendButton)

    expect(queueMessageToPM).toHaveBeenCalledTimes(1)

    await act(async () => { resolveQueue?.('msg-1') })
  })

  it('does not queue the same message twice on a fast double-Enter', async () => {
    render(<CrewMessagesView userId="user_1" messages={[]} />)

    const textarea = screen.getByLabelText('Message to your operations team')
    fireEvent.change(textarea, { target: { value: 'On my way' } })

    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(queueMessageToPM).toHaveBeenCalledTimes(1)

    await act(async () => { resolveQueue?.('msg-1') })
  })

  it('allows a genuinely new send once the previous one has resolved', async () => {
    render(<CrewMessagesView userId="user_1" messages={[]} />)

    const textarea   = screen.getByLabelText('Message to your operations team')
    const sendButton = screen.getByLabelText('Send message')

    fireEvent.change(textarea, { target: { value: 'First message' } })
    fireEvent.click(sendButton)
    expect(queueMessageToPM).toHaveBeenCalledTimes(1)

    await act(async () => { resolveQueue?.('msg-1') })

    fireEvent.change(textarea, { target: { value: 'Second message' } })
    fireEvent.click(sendButton)
    expect(queueMessageToPM).toHaveBeenCalledTimes(2)

    await act(async () => { resolveQueue?.('msg-2') })
  })
})
