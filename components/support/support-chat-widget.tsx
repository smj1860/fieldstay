'use client'

import { useState, useRef, useEffect } from 'react'
import { createClient }                from '@/lib/supabase/client'

interface Message {
  role: 'user' | 'assistant' | 'human'
  content: string
}

export function SupportChatWidget() {
  const [open, setOpen]                     = useState(false)
  const [messages, setMessages]             = useState<Message[]>([])
  const [input, setInput]                   = useState('')
  const [loading, setLoading]               = useState(false)
  const [error, setError]                   = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  // Subscribe to new human replies for this conversation
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
          const row = payload.new as { role: string; content: string }
          // Only add human messages via realtime — user/assistant are already
          // added locally during the send() flow to avoid duplicates
          if (row.role === 'human') {
            setMessages(prev => [...prev, { role: 'human', content: row.content }])
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [conversationId])

  async function send() {
    const text = input.trim()
    if (!text || loading) return

    setInput('')
    setError(null)
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setLoading(true)

    try {
      const res = await fetch('/api/support/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: text, conversationId }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? 'Request failed')
      }

      const data = await res.json() as {
        conversationId: string
        reply:          string
      }

      if (!conversationId) setConversationId(data.conversationId)
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong — please try again.')
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  function bubbleStyle(role: Message['role']) {
    if (role === 'user') {
      return {
        alignSelf:    'flex-end'  as const,
        background:   'var(--accent-gold)',
        color:        'var(--text-inverse)',
        borderRadius: '12px 12px 2px 12px',
      }
    }
    if (role === 'human') {
      return {
        alignSelf:    'flex-start' as const,
        background:   'var(--bg-raised)',
        color:        'var(--text-primary)',
        borderRadius: '12px 12px 12px 2px',
        border:       '1px solid var(--accent-gold)',
      }
    }
    return {
      alignSelf:    'flex-start' as const,
      background:   'var(--bg-elevated)',
      color:        'var(--text-primary)',
      borderRadius: '12px 12px 12px 2px',
    }
  }

  return (
    <div style={{ position: 'fixed', bottom: '24px', right: '24px', zIndex: 9999 }}>
      {open ? (
        <div
          style={{
            width:         '360px',
            maxHeight:     '520px',
            display:       'flex',
            flexDirection: 'column',
            background:    'var(--bg-card)',
            border:        '1px solid var(--border-strong)',
            borderRadius:  'var(--radius-lg)',
            boxShadow:     'var(--shadow-lg)',
            overflow:      'hidden',
          }}
        >
          {/* Header */}
          <div
            style={{
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'space-between',
              padding:        '12px 16px',
              borderBottom:   '1px solid var(--border)',
              background:     'var(--bg-raised)',
              flexShrink:     0,
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>
                Finn · FieldStay Support
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>
                Ask anything about your account
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: 'none',
                border:     'none',
                cursor:     'pointer',
                color:      'var(--text-muted)',
                fontSize:   '18px',
                lineHeight: 1,
                padding:    '2px 4px',
              }}
              aria-label="Close support chat"
            >
              ×
            </button>
          </div>

          {/* Messages */}
          <div
            style={{
              flex:          1,
              overflowY:     'auto',
              padding:       '12px 16px',
              display:       'flex',
              flexDirection: 'column',
              gap:           '10px',
            }}
          >
            {messages.length === 0 && (
              <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
                Hi, I'm Finn — FieldStay's support assistant. Ask me about pricing, integrations, turnovers, or anything else.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: bubbleStyle(m.role).alignSelf, maxWidth: '85%' }}>
                {m.role === 'human' && (
                  <p style={{ fontSize: '10px', fontWeight: 700, color: 'var(--accent-gold)', marginBottom: '2px', marginLeft: '2px' }}>
                    FieldStay Team
                  </p>
                )}
                <div
                  style={{
                    ...bubbleStyle(m.role),
                    padding:    '8px 12px',
                    fontSize:   '13px',
                    lineHeight: '1.5',
                    whiteSpace: 'pre-wrap',
                    wordBreak:  'break-word',
                  }}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div
                style={{
                  alignSelf:    'flex-start',
                  padding:      '8px 12px',
                  borderRadius: '12px 12px 12px 2px',
                  background:   'var(--bg-elevated)',
                  fontSize:     '13px',
                  color:        'var(--text-muted)',
                }}
              >
                Thinking…
              </div>
            )}
            {error && (
              <div
                style={{
                  fontSize:     '12px',
                  color:        'var(--accent-red)',
                  background:   'var(--accent-red-dim)',
                  borderRadius: 'var(--radius)',
                  padding:      '6px 10px',
                }}
              >
                {error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div
            style={{
              padding:    '10px 12px',
              borderTop:  '1px solid var(--border)',
              background: 'var(--bg-raised)',
              display:    'flex',
              gap:        '8px',
              alignItems: 'flex-end',
              flexShrink: 0,
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message…"
              rows={1}
              disabled={loading}
              style={{
                flex:         1,
                resize:       'none',
                background:   'var(--bg-base)',
                border:       '1px solid var(--border-strong)',
                borderRadius: 'var(--radius)',
                color:        'var(--text-primary)',
                fontSize:     '13px',
                padding:      '8px 10px',
                outline:      'none',
                fontFamily:   'inherit',
                lineHeight:   '1.4',
                maxHeight:    '80px',
                overflowY:    'auto',
              }}
            />
            <button
              onClick={() => void send()}
              disabled={loading || !input.trim()}
              className="btn-primary"
              style={{ padding: '8px 14px', fontSize: '13px', flexShrink: 0 }}
            >
              Send
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          style={{
            width:          '52px',
            height:         '52px',
            borderRadius:   '50%',
            background:     'var(--accent-gold)',
            border:         'none',
            cursor:         'pointer',
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            boxShadow:      'var(--shadow-lg)',
            color:          'var(--text-inverse)',
            fontSize:       '22px',
          }}
          aria-label="Open support chat"
        >
          ?
        </button>
      )}
    </div>
  )
}
