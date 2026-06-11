'use client'

import { useState, useEffect, useMemo, useRef, useTransition } from 'react'
import { Send, MessageSquare, Search } from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { sendMessageToCrew, markConversationRead } from './actions'
import type { Message } from '@/types/database'

interface CrewOption {
  id:        string
  name:      string
  specialty: string
  user_id:   string
}

interface Props {
  currentUserId:   string
  orgId:           string
  crew:            CrewOption[]
  initialMessages: Message[]
}

interface Thread {
  crew:          CrewOption
  messages:      Message[]
  lastMessage:   Message | null
  unreadCount:   number
}

export function MessagesClient({ currentUserId, orgId, crew, initialMessages }: Props) {
  const [messages, setMessages]   = useState<Message[]>(initialMessages)
  const [selectedId, setSelected] = useState<string | null>(null)
  const [search, setSearch]       = useState('')
  const [draft, setDraft]         = useState('')
  const [sending, startSend]      = useTransition()
  const bottomRef                 = useRef<HTMLDivElement>(null)

  // Live updates — keep the conversation in sync without a full reload.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`messages-org-${orgId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `org_id=eq.${orgId}` },
        (payload: RealtimePostgresChangesPayload<Message>) => {
          const incoming = payload.new as Message
          setMessages((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]))
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `org_id=eq.${orgId}` },
        (payload: RealtimePostgresChangesPayload<Message>) => {
          const updated = payload.new as Message
          setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [orgId])

  const threads = useMemo<Thread[]>(() => {
    const byUserId = new Map(crew.map((c) => [c.user_id, c]))

    const grouped = new Map<string, Message[]>()
    for (const m of messages) {
      const otherUserId = m.sender_id === currentUserId ? m.recipient_id : m.sender_id
      if (!byUserId.has(otherUserId)) continue
      const list = grouped.get(otherUserId) ?? []
      list.push(m)
      grouped.set(otherUserId, list)
    }

    return crew
      .map((c) => {
        const list = (grouped.get(c.user_id) ?? []).sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        )
        const lastMessage = list.length > 0 ? list[list.length - 1] : null
        const unreadCount = list.filter((m) => m.recipient_id === currentUserId && !m.read_at).length
        return { crew: c, messages: list, lastMessage, unreadCount }
      })
      .filter((t) => !search.trim() || t.crew.name.toLowerCase().includes(search.trim().toLowerCase()))
      .sort((a, b) => {
        const aTime = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0
        const bTime = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0
        return bTime - aTime
      })
  }, [crew, messages, currentUserId, search])

  const selectedThread = threads.find((t) => t.crew.id === selectedId) ?? null

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [selectedThread?.messages.length])

  useEffect(() => {
    if (!selectedThread || selectedThread.unreadCount === 0) return
    const otherUserId = selectedThread.crew.user_id
    markConversationRead(otherUserId).then(() => {
      setMessages((prev) =>
        prev.map((m) =>
          m.sender_id === otherUserId && m.recipient_id === currentUserId && !m.read_at
            ? { ...m, read_at: new Date().toISOString() }
            : m
        )
      )
    })
  }, [selectedThread, currentUserId])

  function handleSend() {
    const content = draft.trim()
    if (!content || !selectedThread) return
    startSend(async () => {
      try {
        await sendMessageToCrew(selectedThread.crew.id, content)
        setDraft('')
      } catch {
        // Draft is preserved in state — user can retry
      }
    })
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      {/* Thread list */}
      <div
        className="w-80 shrink-0 rounded-xl border flex flex-col overflow-hidden"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
      >
        <div className="p-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search crew..."
              className="w-full pl-9 pr-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'var(--bg-inset, var(--bg-page))', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {threads.length === 0 && (
            <div className="p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No crew members found.
            </div>
          )}

          {threads.map((t) => (
            <button
              key={t.crew.id}
              onClick={() => setSelected(t.crew.id)}
              className="w-full text-left px-4 py-3 border-b transition-colors flex items-start gap-3"
              style={{
                borderColor: 'var(--border)',
                background: selectedId === t.crew.id ? 'var(--bg-hover, rgba(255,255,255,0.04))' : 'transparent',
              }}
            >
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium shrink-0"
                style={{ background: 'var(--accent-gold)', color: 'var(--bg-page)' }}
              >
                {t.crew.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {t.crew.name}
                  </span>
                  {t.lastMessage && (
                    <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
                      {formatDateTime(t.lastMessage.created_at)}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <span className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                    {t.lastMessage ? t.lastMessage.content : 'No messages yet'}
                  </span>
                  {t.unreadCount > 0 && (
                    <span
                      className="text-xs font-medium rounded-full px-1.5 py-0.5 shrink-0"
                      style={{ background: 'var(--accent-gold)', color: 'var(--bg-page)' }}
                    >
                      {t.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Conversation */}
      <div
        className="flex-1 rounded-xl border flex flex-col overflow-hidden"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--border)' }}
      >
        {!selectedThread ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2" style={{ color: 'var(--text-muted)' }}>
            <MessageSquare className="w-10 h-10" />
            <p className="text-sm">Select a crew member to start messaging</p>
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {selectedThread.crew.name}
              </span>
              <span className="text-xs ml-2" style={{ color: 'var(--text-muted)' }}>
                {selectedThread.crew.specialty}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
              {selectedThread.messages.length === 0 && (
                <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  No messages yet — say hello.
                </div>
              )}
              {selectedThread.messages.map((m) => {
                const fromMe = m.sender_id === currentUserId
                return (
                  <div key={m.id} className={cn('flex', fromMe ? 'justify-end' : 'justify-start')}>
                    <div
                      className="max-w-[70%] rounded-2xl px-3.5 py-2"
                      style={
                        fromMe
                          ? { background: 'var(--bg-navy, #0a1628)', color: '#ffffff' }
                          : { background: 'var(--bg-page)', color: 'var(--text-primary)', border: '1px solid var(--border)' }
                      }
                    >
                      <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>
                      <p
                        className="text-[10px] mt-1"
                        style={{ color: fromMe ? 'rgba(255,255,255,0.6)' : 'var(--text-muted)' }}
                      >
                        {formatDateTime(m.created_at)}
                      </p>
                    </div>
                  </div>
                )
              })}
              <div ref={bottomRef} />
            </div>

            <div className="p-3 border-t flex items-end gap-2" style={{ borderColor: 'var(--border)' }}>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                placeholder="Type a message..."
                rows={1}
                className="flex-1 px-3 py-2 rounded-lg text-sm outline-none resize-none"
                style={{ background: 'var(--bg-page)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <button
                onClick={handleSend}
                disabled={sending || !draft.trim()}
                className="p-2.5 rounded-lg shrink-0 disabled:opacity-40"
                style={{ background: 'var(--accent-gold)', color: 'var(--bg-page)' }}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
