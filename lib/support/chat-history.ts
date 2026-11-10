/**
 * Pure helpers for the support chat widget's conversation history.
 *
 * Kept free of React and of any browser API so the rules that decide what a
 * customer sees (which rows are merged, what counts as an unread staff reply)
 * can be unit-tested without a DOM.
 */

export type SupportMessageRole = 'user' | 'assistant' | 'human'

export interface SupportMessage {
  /** Present on rows that came from the database; absent on a message the widget just typed. */
  id?:        string
  role:       SupportMessageRole
  content:    string
  createdAt?: string
}

const ROLES: ReadonlySet<string> = new Set<SupportMessageRole>(['user', 'assistant', 'human'])

export function isSupportMessageRole(value: string): value is SupportMessageRole {
  return ROLES.has(value)
}

/**
 * Appends `incoming` to `existing`, skipping any row whose id is already shown.
 *
 * A live push and a history reload can both deliver the same staff reply, and
 * the widget would otherwise render it twice. Rows without an id are always
 * kept: they are messages typed locally, and have nothing to dedupe against.
 * Returns the SAME array when nothing is new, so a no-op merge does not cause
 * a re-render.
 */
export function mergeMessages(
  existing: SupportMessage[],
  incoming: SupportMessage[],
): SupportMessage[] {
  const seen = new Set(existing.flatMap((m) => (m.id ? [m.id] : [])))
  const fresh = incoming.filter((m) => !m.id || !seen.has(m.id))
  return fresh.length === 0 ? existing : [...existing, ...fresh]
}

/** The timestamp of the newest staff reply, or null when there is none. */
export function latestHumanAt(messages: SupportMessage[]): string | null {
  let latest: string | null = null
  for (const m of messages) {
    if (m.role !== 'human' || !m.createdAt) continue
    if (latest === null || Date.parse(m.createdAt) > Date.parse(latest)) latest = m.createdAt
  }
  return latest
}

/**
 * True when a staff reply exists that the customer has not opened the chat
 * since. `seenAt` is the timestamp of the newest reply they had seen, or null
 * when this device has never recorded one (a reply is then unread by
 * definition: nothing on this device says it was read).
 */
export function hasUnreadHumanReply(messages: SupportMessage[], seenAt: string | null): boolean {
  const latest = latestHumanAt(messages)
  if (latest === null) return false
  return seenAt === null || Date.parse(latest) > Date.parse(seenAt)
}
