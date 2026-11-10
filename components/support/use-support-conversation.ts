'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  hasUnreadHumanReply,
  latestHumanAt,
  mergeMessages,
  type SupportMessage,
} from '@/lib/support/chat-history'

const SEEN_KEY_PREFIX = 'fieldstay:support-seen:'

interface LoadedConversation {
  conversationId: string
  messages:       SupportMessage[]
}

// Storage can be unavailable (private windows, blocked site data), so every
// access is guarded. The only cost of losing it is that the unread dot comes
// back on the next load.
function readSeenAt(conversationId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(SEEN_KEY_PREFIX + conversationId) ?? null
  } catch {
    return null
  }
}

function writeSeenAt(conversationId: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(SEEN_KEY_PREFIX + conversationId, value)
  } catch {
    // Storage unavailable: nothing to do.
  }
}

async function loadLatestConversation(): Promise<LoadedConversation | null> {
  try {
    const res = await fetch('/api/support/chat', { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const data = await res.json() as { conversationId: string | null; messages: SupportMessage[] }
    return data.conversationId ? { conversationId: data.conversationId, messages: data.messages } : null
  } catch (err) {
    console.error('[support-widget] could not load conversation history', err)
    return null
  }
}

/** Restores the customer's latest thread once, when the widget first mounts. */
function useRestoredHistory(
  startedLocally: React.MutableRefObject<boolean>,
  onLoaded: (loaded: LoadedConversation) => void,
): void {
  useEffect(() => {
    let cancelled = false
    void loadLatestConversation().then((loaded) => {
      // A customer who has already typed something owns the thread now: do not
      // replace it with the stored one underneath them.
      if (cancelled || !loaded || startedLocally.current) return
      onLoaded(loaded)
    })
    return () => { cancelled = true }
    // Mount-only on purpose: the callback is stable and the ref never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/** Adds staff replies pushed live while the page is open. */
function useLiveReplies(
  conversationId: string | null,
  onReply: (message: SupportMessage) => void,
): void {
  useEffect(() => {
    if (!conversationId) return

    const supabase = createClient()
    const channel  = supabase
      .channel(`support-widget-${conversationId}`)
      .on('postgres_changes',
        {
          event:  'INSERT',
          schema: 'public',
          table:  'support_messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload: { new: Record<string, unknown> }) => {
          const row = payload.new as { id?: string; role: string; content: string; created_at?: string }
          // Only staff replies arrive this way: user and assistant messages are
          // already added locally while sending, and would show twice.
          if (row.role !== 'human') return
          onReply({ id: row.id, role: 'human', content: row.content, createdAt: row.created_at })
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [conversationId, onReply])
}

/**
 * Re-checks for staff replies each time the panel opens. A live subscription
 * misses anything sent while the connection was down (a laptop that slept, a
 * phone in another app), and opening the chat is when the customer looks.
 */
function useReplyRefreshOnOpen(
  open: boolean,
  conversationId: string | null,
  onReplies: (messages: SupportMessage[]) => void,
): void {
  useEffect(() => {
    if (!open || !conversationId) return
    let cancelled = false
    void loadLatestConversation().then((loaded) => {
      if (cancelled || loaded?.conversationId !== conversationId) return
      // Staff replies only: the user and assistant rows already on screen were
      // typed locally and carry no id, so merging them would duplicate them.
      onReplies(loaded.messages.filter((m) => m.role === 'human'))
    })
    return () => { cancelled = true }
  }, [open, conversationId, onReplies])
}

export interface SupportConversation {
  messages:          SupportMessage[]
  conversationId:    string | null
  open:              boolean
  /** A staff reply exists that the customer has not opened the chat since. */
  unread:            boolean
  openChat:          () => void
  closeChat:         () => void
  appendMessage:     (message: SupportMessage) => void
  adoptConversation: (id: string) => void
}

export function useSupportConversation(): SupportConversation {
  const [open, setOpen]                     = useState(false)
  const [messages, setMessages]             = useState<SupportMessage[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [seenAt, setSeenAt]                 = useState<string | null>(null)
  const startedLocally = useRef(false)

  const mergeIncoming = useCallback((incoming: SupportMessage[]) => {
    setMessages((prev) => mergeMessages(prev, incoming))
  }, [])
  const mergeOne = useCallback((message: SupportMessage) => mergeIncoming([message]), [mergeIncoming])

  const restore = useCallback((loaded: LoadedConversation) => {
    setConversationId(loaded.conversationId)
    setMessages(loaded.messages)
    setSeenAt(readSeenAt(loaded.conversationId))
  }, [])

  useRestoredHistory(startedLocally, restore)
  useLiveReplies(conversationId, mergeOne)
  useReplyRefreshOnOpen(open, conversationId, mergeIncoming)

  // While the chat is open, whatever reply is newest counts as read. Writing it
  // to storage here keeps a closed tab from losing it; the in-memory marker is
  // moved by openChat and closeChat, which are events rather than effects.
  useEffect(() => {
    if (!open || !conversationId) return
    const latest = latestHumanAt(messages)
    if (latest !== null) writeSeenAt(conversationId, latest)
  }, [open, conversationId, messages])

  // Everything the customer can currently see counts as seen.
  const acknowledge = () => {
    if (!conversationId) return
    const latest = latestHumanAt(messages)
    if (latest === null) return
    setSeenAt(latest)
    writeSeenAt(conversationId, latest)
  }

  const openChat = () => {
    acknowledge()
    setOpen(true)
  }

  // Closing acknowledges too, so a reply that arrived while the panel was open
  // does not light the indicator the moment it is closed.
  const closeChat = () => {
    acknowledge()
    setOpen(false)
  }

  const appendMessage = useCallback((message: SupportMessage) => {
    startedLocally.current = true
    setMessages((prev) => [...prev, message])
  }, [])

  const adoptConversation = useCallback((id: string) => {
    setConversationId((current) => current ?? id)
  }, [])

  return {
    messages,
    conversationId,
    open,
    unread: !open && hasUnreadHumanReply(messages, seenAt),
    openChat,
    closeChat,
    appendMessage,
    adoptConversation,
  }
}
