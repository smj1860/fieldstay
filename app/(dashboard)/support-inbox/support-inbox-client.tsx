'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronLeft }                 from 'lucide-react'
import { createClient }                from '@/lib/supabase/client'
import { cn }                          from '@/lib/utils'

interface ConversationRow {
  id:                string
  org_id:            string
  status:            string
  needs_human:       boolean
  escalation_reason: string | null
  escalated_at:      string | null
  resolved_at:       string | null
  last_message_at:   string
  created_at:        string
  organizations:     { name: string } | { name: string }[] | null
}

interface MessageRow {
  id:         string
  role:       'user' | 'assistant' | 'human'
  content:    string
  created_at: string
}

interface FeedbackRow {
  id:            string
  feedback_text: string
  created_at:    string
  crew_members:  { name: string } | { name: string }[] | null
  organizations: { name: string } | { name: string }[] | null
}

export function SupportInboxClient({
  initialConversations,
  initialFeedback,
}: Readonly<{
  initialConversations: ConversationRow[]
  initialFeedback:      FeedbackRow[]
}>) {
  const [conversations, setConversations] = useState(initialConversations)
  const [feedback] = useState(initialFeedback)
  const [selectedId, setSelectedId]       = useState<string | null>(
    initialConversations.find(c => c.needs_human)?.id ?? initialConversations[0]?.id ?? null
  )
  // Mobile master-detail toggle — independent of selectedId, which is
  // auto-populated above so the desktop two-pane layout has something to
  // show on load. On mobile we still want the list pane by default and
  // only switch to the detail pane once the user taps a conversation.
  const [mobileShowDetail, setMobileShowDetail] = useState(false)
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [replyText, setReplyText] = useState('')
  const [sending, setSending]     = useState(false)
  const supabase  = createClient()
  const bottomRef = useRef<HTMLDivElement>(null)

  // Real-time: new/updated conversations
  // Extracted from useEffect → .on() → setState(prev) → .map + .sort chain (S2004).
  const applyConversationChange = useCallback(
    (payload: { new: Record<string, unknown> }) => {
      const updated = payload.new as unknown as ConversationRow
      setConversations((prev) => {
        const exists = prev.some((c) => c.id === updated.id)
        const next   = exists
          ? prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c))
          : [updated, ...prev]
        return next.sort((a, b) => {
          if (a.needs_human !== b.needs_human) return a.needs_human ? -1 : 1
          return new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
        })
      })
    },
    []
  )

  useEffect(() => {
    const channel = supabase
      .channel('support-inbox-conversations')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'support_conversations' },
        applyConversationChange
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [supabase, applyConversationChange])

  // Load + subscribe to messages for the selected conversation
  useEffect(() => {
    if (!selectedId) return

    supabase
      .from('support_messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', selectedId)
      .order('created_at', { ascending: true })
      .then((result: { data: MessageRow[] | null }) => setMessages(result.data ?? []))

    const channel = supabase
      .channel(`support-inbox-messages-${selectedId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'support_messages', filter: `conversation_id=eq.${selectedId}` },
        (payload: { new: Record<string, unknown> }) => {
          setMessages(prev => [...prev, payload.new as unknown as MessageRow])
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [selectedId, supabase])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendReply() {
    if (!selectedId || !replyText.trim()) return
    setSending(true)
    const res = await fetch('/api/support-inbox/reply', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conversationId: selectedId, content: replyText.trim() }),
    })
    if (res.ok) setReplyText('')
    setSending(false)
  }

  async function resolveConversation() {
    if (!selectedId) return
    await fetch('/api/support-inbox/resolve', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conversationId: selectedId }),
    })
    setConversations(prev =>
      prev.map(c => c.id === selectedId ? { ...c, needs_human: false, status: 'closed' } : c)
    )
  }

  const selected = conversations.find(c => c.id === selectedId)
  const orgName  = (org: ConversationRow['organizations']) =>
    Array.isArray(org) ? org[0]?.name : org?.name

  const roleBubble = (m: MessageRow) => {
    if (m.role === 'user') {
      return {
        alignSelf:  'flex-end' as const,
        background: 'var(--bg-elevated)',
        color:      'var(--text-primary)',
        label:      null,
      }
    }
    if (m.role === 'human') {
      return {
        alignSelf:  'flex-start' as const,
        background: 'var(--accent-gold)',
        color:      'var(--text-inverse)',
        label:      'You',
      }
    }
    return {
      alignSelf:  'flex-start' as const,
      background: 'var(--bg-raised)',
      color:      'var(--text-primary)',
      label:      'FieldStay Bot',
    }
  }

  const feedbackCrewName = (crew: FeedbackRow['crew_members']) =>
    Array.isArray(crew) ? crew[0]?.name : crew?.name

  return (
    <>
    <div style={{ display: 'flex', height: 'calc(100vh - 64px)' }}>
      {/* Conversation list */}
      <div
        className={cn(
          'w-full md:w-[300px] flex-shrink-0',
          mobileShowDetail ? 'hidden md:block' : 'block',
        )}
        style={{ borderRight: '1px solid var(--border)', overflowY: 'auto' }}
      >
        <div style={{ padding: '16px', borderBottom: '1px solid var(--border)' }}>
          <h1 style={{ fontWeight: 700, fontSize: '14px', margin: 0 }}>Support Inbox</h1>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '2px 0 0' }}>
            {conversations.filter(c => c.needs_human).length} need attention
          </p>
        </div>
        {conversations.map((c) => (
          <button
            key={c.id}
            onClick={() => {
              setSelectedId(c.id)
              setMobileShowDetail(true)
            }}
            style={{
              width:           '100%',
              textAlign:       'left',
              padding:         '12px 14px',
              borderBottom:    '1px solid var(--border)',
              borderLeft:      'none',
              borderRight:     'none',
              borderTop:       'none',
              background:      c.id === selectedId ? 'var(--bg-elevated)' : 'transparent',
              cursor:          'pointer',
              display:         'block',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '2px' }}>
              <span style={{ fontWeight: 600, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {orgName(c.organizations)}
              </span>
              {c.needs_human && (
                <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 6px', borderRadius: '99px', background: 'var(--accent-red-dim)', color: 'var(--accent-red)', flexShrink: 0 }}>
                  Flagged
                </span>
              )}
            </div>
            {c.escalation_reason && (
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.escalation_reason}
              </p>
            )}
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
              {new Date(c.last_message_at).toLocaleString()}
            </p>
          </button>
        ))}
      </div>

      {/* Conversation detail */}
      <div
        className={cn(
          'flex-1 flex-col min-w-0',
          mobileShowDetail ? 'flex' : 'hidden md:flex',
        )}
      >
        {selected ? (
          <>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  onClick={() => setMobileShowDetail(false)}
                  className="md:hidden inline-flex items-center justify-center p-1 -ml-1"
                  aria-label="Back to conversation list"
                  style={{
                    background: 'transparent',
                    border:     'none',
                    color:      'var(--text-primary)',
                    cursor:     'pointer',
                  }}
                >
                  <ChevronLeft size={20} />
                </button>
                <div>
                  <h2 style={{ fontWeight: 700, fontSize: '13px', margin: 0 }}>{orgName(selected.organizations)}</h2>
                  {selected.needs_human && (
                    <p style={{ fontSize: '12px', color: 'var(--accent-red)', margin: '2px 0 0' }}>
                      Escalated — {selected.escalation_reason}
                    </p>
                  )}
                </div>
              </div>
              {selected.needs_human && (
                <button
                  onClick={resolveConversation}
                  style={{
                    fontSize:    '12px',
                    fontWeight:  600,
                    padding:     '6px 14px',
                    borderRadius:'8px',
                    background:  'var(--accent-gold)',
                    color:       'var(--text-inverse)',
                    border:      'none',
                    cursor:      'pointer',
                  }}
                >
                  Mark Resolved
                </button>
              )}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {messages.map((m) => {
                const style = roleBubble(m)
                return (
                  <div key={m.id} style={{ alignSelf: style.alignSelf, maxWidth: '75%' }}>
                    {style.label && (
                      <p style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.6, marginBottom: '2px' }}>
                        {style.label}
                      </p>
                    )}
                    <div style={{ borderRadius: '12px', padding: '8px 12px', background: style.background, color: style.color, fontSize: '13px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {m.content}
                    </div>
                  </div>
                )
              })}
              <div ref={bottomRef} />
            </div>

            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: '8px', flexShrink: 0 }}>
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void sendReply()
                  }
                }}
                rows={2}
                placeholder="Reply as FieldStay support…"
                style={{
                  flex:         1,
                  borderRadius: '8px',
                  border:       '1px solid var(--border-strong)',
                  padding:      '8px 10px',
                  fontSize:     '13px',
                  resize:       'none',
                  background:   'var(--bg-base)',
                  color:        'var(--text-primary)',
                  fontFamily:   'inherit',
                }}
              />
              <button
                onClick={() => void sendReply()}
                disabled={sending || !replyText.trim()}
                style={{
                  padding:      '8px 16px',
                  borderRadius: '8px',
                  fontWeight:   600,
                  fontSize:     '13px',
                  background:   'var(--accent-gold)',
                  color:        'var(--text-inverse)',
                  border:       'none',
                  cursor:       sending || !replyText.trim() ? 'not-allowed' : 'pointer',
                  opacity:      sending || !replyText.trim() ? 0.5 : 1,
                  flexShrink:   0,
                }}
              >
                Send
              </button>
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', color: 'var(--text-muted)' }}>
            Select a conversation
          </div>
        )}
      </div>
    </div>

    {/* Crew Feedback — app feedback submitted by crew members, all orgs */}
    <div style={{ padding: '20px 24px', borderTop: '1px solid var(--border)' }}>
      <h2 style={{ fontWeight: 700, fontSize: '14px', margin: '0 0 12px' }}>Crew Feedback</h2>

      {feedback.length === 0 && (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No feedback yet.</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '640px' }}>
        {feedback.map((f) => (
          <div
            key={f.id}
            style={{
              padding:      '10px 12px',
              borderRadius: '10px',
              border:       '1px solid var(--border)',
              background:   'var(--bg-elevated)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '4px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600 }}>
                {feedbackCrewName(f.crew_members) ?? 'Unknown crew'}
                <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {orgName(f.organizations)}</span>
              </span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>
                {new Date(f.created_at).toLocaleDateString()}
              </span>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', margin: 0 }}>
              {f.feedback_text}
            </p>
          </div>
        ))}
      </div>
    </div>
    </>
  )
}
