'use client'

import { useState, useEffect, useMemo, useRef, useTransition } from 'react'
import { Send, MessageSquare, Search, ChevronLeft, Users } from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { sendMessageToCrew, sendGroupMessage, markConversationRead } from './actions'
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

interface DirectThread {
  type:        'direct'
  key:         string
  crew:        CrewOption
  messages:    Message[]
  lastMessage: Message | null
  unreadCount: number
}

interface GroupThread {
  type:         'group'
  key:          string
  groupId:      string
  groupLabel:   string
  participants: CrewOption[]
  messages:     Message[]
  lastMessage:  Message | null
  unreadCount:  number
}

type AnyThread = DirectThread | GroupThread

export function MessagesClient({ currentUserId, orgId, crew, initialMessages }: Props) {
  const [messages, setMessages]         = useState<Message[]>(initialMessages)
  const [selectedKey, setSelectedKey]   = useState<string | null>(null)
  const [search, setSearch]             = useState('')
  const [draft, setDraft]               = useState('')
  const [sendError, setSendError]       = useState<string | null>(null)
  const [sending, startSend]            = useTransition()

  // Group compose mode
  const [groupMode, setGroupMode]       = useState(false)
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set())
  const [groupLabel, setGroupLabel]     = useState('')
  const [groupDraft, setGroupDraft]     = useState('')
  const [groupError, setGroupError]     = useState<string | null>(null)
  const [sendingGroup, startGroupSend]  = useTransition()

  const bottomRef = useRef<HTMLDivElement>(null)

  // Live updates
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

    return () => { supabase.removeChannel(channel) }
  }, [orgId])

  const { directThreads, groupThreads } = useMemo(() => {
    const byUserId  = new Map(crew.map((c) => [c.user_id, c]))

    // Split messages into 1:1 and group
    const directMsgs: Message[] = []
    const groupMsgs:  Message[] = []
    for (const m of messages) {
      if (m.group_id) groupMsgs.push(m)
      else directMsgs.push(m)
    }

    // ── Direct threads (one per crew member, even if no messages) ──────────
    const directGrouped = new Map<string, Message[]>()
    for (const m of directMsgs) {
      const otherUserId = m.sender_id === currentUserId ? m.recipient_id : m.sender_id
      if (!byUserId.has(otherUserId)) continue
      const list = directGrouped.get(otherUserId) ?? []
      list.push(m)
      directGrouped.set(otherUserId, list)
    }

    const searchLower = search.trim().toLowerCase()

    const directs: DirectThread[] = crew
      .map((c) => {
        const list = (directGrouped.get(c.user_id) ?? []).sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        )
        const lastMessage  = list.length > 0 ? list[list.length - 1] : null
        const unreadCount  = list.filter((m) => m.recipient_id === currentUserId && !m.read_at).length
        return { type: 'direct' as const, key: c.id, crew: c, messages: list, lastMessage, unreadCount }
      })
      .filter((t) => !searchLower || t.crew.name.toLowerCase().includes(searchLower))
      .sort((a, b) => {
        const aTime = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0
        const bTime = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0
        return bTime - aTime
      })

    // ── Group threads (one per unique group_id) ────────────────────────────
    const groupedById = new Map<string, Message[]>()
    for (const m of groupMsgs) {
      const list = groupedById.get(m.group_id!) ?? []
      list.push(m)
      groupedById.set(m.group_id!, list)
    }

    const groups: GroupThread[] = []
    for (const [gid, msgs] of groupedById) {
      const sorted = msgs.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

      const participantUserIds = [...new Set(
        msgs.map(m => (m.sender_id === currentUserId ? m.recipient_id : m.sender_id))
            .filter(id => id !== currentUserId)
      )]
      const participants = participantUserIds
        .map(uid => byUserId.get(uid))
        .filter((c): c is CrewOption => !!c)

      const participantList = participants.map(p => p.name).slice(0, 3).join(', ')
        + (participants.length > 3 ? '…' : '')
      const label = (sorted[0].group_label ?? participantList) || 'Group message'

      if (searchLower && !label.toLowerCase().includes(searchLower)) continue

      const unreadCount = sorted.filter(m => m.recipient_id === currentUserId && !m.read_at).length
      groups.push({
        type: 'group',
        key:          gid,
        groupId:      gid,
        groupLabel:   label,
        participants,
        messages:     sorted,
        lastMessage:  sorted[sorted.length - 1] ?? null,
        unreadCount,
      })
    }

    groups.sort((a, b) => {
      const aTime = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0
      const bTime = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0
      return bTime - aTime
    })

    return { directThreads: directs, groupThreads: groups }
  }, [crew, messages, currentUserId, search])

  const allThreads = useMemo<AnyThread[]>(
    () => [...groupThreads, ...directThreads],
    [directThreads, groupThreads]
  )

  const selectedThread = allThreads.find((t) => t.key === selectedKey) ?? null

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [selectedThread?.messages.length])

  useEffect(() => {
    if (!selectedThread || selectedThread.unreadCount === 0) return
    const otherUserId = selectedThread.type === 'direct'
      ? selectedThread.crew.user_id
      : null
    if (!otherUserId) return
    markConversationRead(otherUserId).then(() => {
      setMessages((prev) =>
        prev.map((m) =>
          m.sender_id === otherUserId && m.recipient_id === currentUserId && !m.read_at
            ? { ...m, read_at: new Date().toISOString() }
            : m
        )
      )
    }).catch((err) => console.error('[messages] markConversationRead failed:', err))
  }, [selectedThread, currentUserId])

  function handleSend() {
    const content = draft.trim()
    if (!content || !selectedThread) return
    if (selectedThread.type !== 'direct') return
    setSendError(null)
    startSend(async () => {
      try {
        const result = await sendMessageToCrew(selectedThread.crew.id, content)
        if (result.success) {
          setDraft('')
          if (result.message) {
            const sent = result.message
            setMessages((prev) => (prev.some((m) => m.id === sent.id) ? prev : [...prev, sent]))
          }
        } else {
          setSendError(result.error ?? 'Failed to send message')
        }
      } catch {
        setSendError('Failed to send message')
      }
    })
  }

  function handleGroupSend() {
    const content = groupDraft.trim()
    if (!content || selectedGroupIds.size < 2) return
    setGroupError(null)
    startGroupSend(async () => {
      const result = await sendGroupMessage([...selectedGroupIds], content, groupLabel.trim() || undefined)
      if (!result.error) {
        setGroupDraft('')
        setGroupLabel('')
        setSelectedGroupIds(new Set())
        setGroupMode(false)
      } else {
        setGroupError(result.error)
      }
    })
  }

  function toggleGroupMember(crewId: string) {
    setSelectedGroupIds(prev => {
      const next = new Set(prev)
      if (next.has(crewId)) next.delete(crewId)
      else next.add(crewId)
      return next
    })
  }

  return (
    <div className="flex h-[calc(100vh-80px)] overflow-hidden rounded-xl border border-themed">

      {/* Left pane — thread list */}
      <div
        className={cn(
          'flex flex-col border-r border-themed flex-shrink-0',
          'w-full md:w-80 lg:w-96',
          selectedKey && !groupMode ? 'hidden md:flex' : 'flex',
        )}
        style={{ background: 'var(--bg-card)' }}
      >
        <div className="p-3 border-b flex flex-col gap-2" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search crew..."
                className="w-full pl-9 pr-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: 'var(--bg-inset, var(--bg-page))', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
            </div>
            <button
              onClick={() => {
                setGroupMode(!groupMode)
                setSelectedGroupIds(new Set())
                setGroupDraft('')
                setGroupLabel('')
                setGroupError(null)
              }}
              title="Group message"
              className="p-2 rounded-lg transition-colors flex-shrink-0"
              style={{
                background: groupMode ? 'var(--accent-gold)' : 'transparent',
                color:      groupMode ? 'var(--bg-page)' : 'var(--text-muted)',
                border:     '1px solid var(--border)',
              }}
            >
              <Users className="w-4 h-4" />
            </button>
          </div>
          {groupMode && (
            <p className="text-xs px-1" style={{ color: 'var(--text-muted)' }}>
              Select 2+ crew members to send a group message
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {allThreads.length === 0 && (
            <div className="p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No crew members found.
            </div>
          )}

          {allThreads.map((t) => {
            const label = t.type === 'direct' ? t.crew.name : t.groupLabel
            const sub   = t.type === 'direct' ? t.crew.specialty : `${t.participants.length} members`
            const initial = label.charAt(0).toUpperCase()
            const isGroupItem = t.type === 'group'

            if (groupMode && isGroupItem) return null // hide existing group threads in compose mode

            return (
              <button
                key={t.key}
                onClick={() => {
                  if (groupMode && t.type === 'direct') {
                    toggleGroupMember(t.crew.id)
                  } else {
                    setSelectedKey(t.key)
                  }
                }}
                className="w-full text-left px-4 py-3 border-b transition-colors flex items-start gap-3"
                style={{
                  borderColor: 'var(--border)',
                  background: (groupMode && t.type === 'direct' && selectedGroupIds.has(t.crew.id))
                    ? 'var(--accent-gold-dim, rgba(252,209,22,0.08))'
                    : selectedKey === t.key
                    ? 'var(--bg-hover, rgba(255,255,255,0.04))'
                    : 'transparent',
                }}
              >
                {groupMode && t.type === 'direct' && (
                  <input
                    type="checkbox"
                    readOnly
                    checked={selectedGroupIds.has(t.crew.id)}
                    className="mt-1 flex-shrink-0 accent-amber-400"
                  />
                )}
                {!groupMode && (
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium shrink-0"
                    style={{ background: isGroupItem ? 'var(--bg-raised)' : 'var(--accent-gold)', color: isGroupItem ? 'var(--text-muted)' : 'var(--bg-page)' }}
                  >
                    {isGroupItem ? <Users className="w-4 h-4" /> : initial}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {label}
                    </span>
                    {t.lastMessage && (
                      <span className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
                        {formatDateTime(t.lastMessage.created_at)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                      {t.lastMessage ? t.lastMessage.content : sub}
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
            )
          })}
        </div>

        {/* Group compose panel */}
        {groupMode && selectedGroupIds.size >= 2 && (
          <div className="border-t p-3 space-y-2" style={{ borderColor: 'var(--border)' }}>
            <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
              Group message to {selectedGroupIds.size} crew members
            </p>
            <input
              value={groupLabel}
              onChange={e => setGroupLabel(e.target.value)}
              placeholder="Group label (optional, e.g. Morning Crew)"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'var(--bg-page)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
            <div className="flex items-end gap-2">
              <textarea
                value={groupDraft}
                onChange={e => setGroupDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGroupSend() } }}
                placeholder="Type a message..."
                rows={2}
                className="flex-1 px-3 py-2 rounded-lg text-sm outline-none resize-none"
                style={{ background: 'var(--bg-page)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <button
                onClick={handleGroupSend}
                disabled={sendingGroup || !groupDraft.trim()}
                className="p-2.5 rounded-lg shrink-0 disabled:opacity-40"
                style={{ background: 'var(--accent-gold)', color: 'var(--bg-page)' }}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            {groupError && (
              <p className="text-xs" style={{ color: 'var(--accent-red)' }}>{groupError}</p>
            )}
          </div>
        )}
      </div>

      {/* Right pane — active conversation */}
      <div
        className={cn(
          'flex flex-col flex-1 min-w-0',
          !selectedKey || groupMode ? 'hidden md:flex' : 'flex',
        )}
        style={{ background: 'var(--bg-card)' }}
      >
        {!selectedThread ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2" style={{ color: 'var(--text-muted)' }}>
            <MessageSquare className="w-10 h-10" />
            <p className="text-sm">Select a conversation</p>
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
              <button
                className="md:hidden btn-ghost p-1.5 -ml-1 mr-1"
                onClick={() => setSelectedKey(null)}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              {selectedThread.type === 'group' ? (
                <div>
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {selectedThread.groupLabel}
                  </span>
                  <span className="text-xs ml-2" style={{ color: 'var(--text-muted)' }}>
                    {selectedThread.participants.map(p => p.name).join(', ')}
                  </span>
                </div>
              ) : (
                <>
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {selectedThread.crew.name}
                  </span>
                  <span className="text-xs ml-2" style={{ color: 'var(--text-muted)' }}>
                    {selectedThread.crew.specialty}
                  </span>
                </>
              )}
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

            {selectedThread.type === 'direct' && (
              <div className="border-t" style={{ borderColor: 'var(--border)' }}>
                {sendError && (
                  <div className="px-3 pt-2 text-xs" style={{ color: 'var(--accent-red, #dc2626)' }}>
                    {sendError}
                  </div>
                )}
                <div className="p-3 flex items-end gap-2">
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
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
