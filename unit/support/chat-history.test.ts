import { describe, it, expect } from 'vitest'
import {
  hasUnreadHumanReply,
  isSupportMessageRole,
  latestHumanAt,
  mergeMessages,
  type SupportMessage,
} from '@/lib/support/chat-history'

const human = (id: string, createdAt: string): SupportMessage => ({ id, role: 'human', content: id, createdAt })

describe('mergeMessages', () => {
  it('adds a staff reply that is not on screen yet', () => {
    const merged = mergeMessages([{ role: 'user', content: 'hi' }], [human('m1', '2026-11-10T20:00:00Z')])
    expect(merged).toHaveLength(2)
  })

  it('does not show the same reply twice when a live push and a reload both deliver it', () => {
    const existing = [human('m1', '2026-11-10T20:00:00Z')]
    expect(mergeMessages(existing, [human('m1', '2026-11-10T20:00:00Z')])).toHaveLength(1)
  })

  it('returns the same array when nothing is new, so a no-op merge does not re-render', () => {
    const existing = [human('m1', '2026-11-10T20:00:00Z')]
    expect(mergeMessages(existing, [human('m1', '2026-11-10T20:00:00Z')])).toBe(existing)
  })

  it('keeps locally typed messages, which have no id to dedupe against', () => {
    const merged = mergeMessages([], [{ role: 'user', content: 'a' }, { role: 'user', content: 'a' }])
    expect(merged).toHaveLength(2)
  })
})

describe('latestHumanAt', () => {
  it('is null with no staff replies, even when other messages are timestamped', () => {
    expect(latestHumanAt([{ role: 'assistant', content: 'x', createdAt: '2026-11-10T20:00:00Z' }])).toBeNull()
  })

  it('picks the newest staff reply by time, not by position', () => {
    const msgs = [human('new', '2026-11-10T21:00:00Z'), human('old', '2026-11-10T20:00:00Z')]
    expect(latestHumanAt(msgs)).toBe('2026-11-10T21:00:00Z')
  })

  it('ignores a staff message that has no timestamp', () => {
    expect(latestHumanAt([{ role: 'human', content: 'x' }])).toBeNull()
  })
})

describe('hasUnreadHumanReply', () => {
  const reply = [human('m1', '2026-11-10T20:00:00Z')]

  it('is false when there is no staff reply at all', () => {
    expect(hasUnreadHumanReply([{ role: 'user', content: 'hi' }], null)).toBe(false)
  })

  it('is true when this device has never recorded seeing a reply', () => {
    expect(hasUnreadHumanReply(reply, null)).toBe(true)
  })

  it('is true when the reply is newer than the last one seen', () => {
    expect(hasUnreadHumanReply(reply, '2026-11-10T19:00:00Z')).toBe(true)
  })

  it('is false once the newest reply has been seen', () => {
    expect(hasUnreadHumanReply(reply, '2026-11-10T20:00:00Z')).toBe(false)
  })
})

describe('isSupportMessageRole', () => {
  it('accepts the three roles the widget renders and rejects anything else', () => {
    expect(['user', 'assistant', 'human'].every(isSupportMessageRole)).toBe(true)
    expect(isSupportMessageRole('system')).toBe(false)
  })
})
