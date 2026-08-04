'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLiveQuery } from 'dexie-react-hooks'
import { Send, MessageSquare, Clock } from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import { useDexieDb, useDexieUserId } from '@/lib/dexie/context'
import { loadMessageDraft, saveMessageDraft, queueMessageToPM } from '@/lib/dexie/helpers'
import { markConversationRead } from '@/app/(dashboard)/messages/actions'
import { isOnline } from '@/lib/dexie/net'
import { reportError } from '@/lib/observability/report-error'

export interface CrewMessage {
  id:          string
  sender_id:   string
  content:     string
  group_label: string | null
  created_at:  string
}

/**
 * Sent history comes from the server as a prop; messages still waiting in the
 * outbox are read from Dexie and rendered as pending. That split is the whole
 * design: the outbox is local by definition and stays local, while history —
 * which is only useful when you can also get a reply — is fetched.
 */
export function CrewMessagesView({
  userId,
  messages,
}: Readonly<{ userId: string; messages: CrewMessage[] }>) {
  const db          = useDexieDb()
  const dexieUserId = useDexieUserId()
  const router      = useRouter()

  const [draft, setDraft]         = useState('')
  const [draftLoaded, setLoaded]  = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const bottomRef                 = useRef<HTMLDivElement>(null)

  // Queued-but-unsent messages. `failed` ones are deliberately included: that
  // message has NOT reached the server either, so hiding it would tell the
  // crew member it sent. The failed-sync banner is what offers the retry.
  const pending = useLiveQuery(
    () => db.mutations.where('table').equals('messages').toArray(),
    [],
  ) ?? []

  // Restore a half-typed message once, so navigating away and back doesn't
  // lose it. Set in the async callback, never synchronously in the effect.
  useEffect(() => {
    let cancelled = false
    void loadMessageDraft(dexieUserId)
      .then((saved) => { if (!cancelled) { setDraft(saved); setLoaded(true) } })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [dexieUserId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, pending.length])

  const unreadSenderId = messages.find((m) => m.sender_id !== userId)?.sender_id
  useEffect(() => {
    if (!unreadSenderId) return
    markConversationRead(unreadSenderId)
      .catch((err) => console.error('[messages] markConversationRead failed:', err))
  }, [unreadSenderId])

  function updateDraft(text: string) {
    setDraft(text)
    if (draftLoaded) void saveMessageDraft(dexieUserId, text)
  }

  async function handleSend() {
    const content = draft.trim()
    if (!content) return
    setSendError(null)
    try {
      await queueMessageToPM(dexieUserId, content)
      setDraft('')
      // Nothing to refresh while offline — the pending bubble is the feedback.
      if (isOnline()) setTimeout(() => router.refresh(), 1_200)
    } catch (err) {
      // Deliberately does not log `content` — a crew message is free text.
      console.error('[messages] queue failed:', err)
      reportError(err, { site: 'page.crew.messages.queue' })
      setSendError('Could not save your message. Please try again.')
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-9.5rem)] -mx-4 -my-6">
      <div className="px-4 py-3 border-b border-themed bg-card-themed">
        <span className="font-semibold text-brand-800">FieldStay Operations</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
        {messages.length === 0 && pending.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-themed">
            <MessageSquare className="w-10 h-10" />
            <p className="text-sm">Send a message to your operations team</p>
          </div>
        )}

        {messages.map((m) => {
          const fromMe = m.sender_id === userId
          return (
            <div key={m.id} className={cn('flex', fromMe ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[75%] rounded-2xl px-3.5 py-2',
                  fromMe ? 'bg-brand-800 text-white' : 'bg-raised-themed text-primary-themed'
                )}
              >
                <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>
                {!fromMe && m.group_label && (
                  <p className="text-[10px] mt-0.5 text-muted-themed italic">{m.group_label}</p>
                )}
                <p className={cn('text-[10px] mt-1', fromMe ? 'text-brand-200' : 'text-muted-themed')}>
                  {formatDateTime(m.created_at)}
                </p>
              </div>
            </div>
          )
        })}

        {pending.map((m) => (
          <div key={`pending-${m.id}`} className="flex justify-end">
            <div className="max-w-[75%] rounded-2xl px-3.5 py-2 bg-brand-800 text-white opacity-60">
              <p className="text-sm whitespace-pre-wrap break-words">{String(m.payload.content ?? '')}</p>
              <p className="text-[10px] mt-1 text-brand-200 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {m.failed ? 'Didn’t send — see the banner above' : 'Sending when you have signal'}
              </p>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-themed bg-card-themed">
        {sendError && <div className="px-3 pt-2 text-xs" style={{ color: 'var(--accent-red)' }}>{sendError}</div>}
        <div className="p-3 flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => updateDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder="Type a message..."
            rows={1}
            aria-label="Message to your operations team"
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-none resize-none border border-themed bg-card-themed text-primary-themed"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!draft.trim()}
            aria-label="Send message"
            className="min-h-11 min-w-11 flex items-center justify-center rounded-lg shrink-0 bg-brand-800 text-white disabled:opacity-40"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
