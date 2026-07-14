'use client'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useDexieDb, useDexieUserId } from '@/lib/dexie/context'
import { Send, MessageSquare } from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import { sendMessageToPM, markConversationRead } from '@/app/(dashboard)/messages/actions'
import { CrewLoading } from '@/components/crew/CrewLoading'

export default function CrewMessagesPage() {
  const db = useDexieDb()
  const userId = useDexieUserId()
  const [draft, setDraft]       = useState('')
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, startSend]    = useTransition()
  const bottomRef               = useRef<HTMLDivElement>(null)

  const messages = useLiveQuery(
    () => db.messages
      .where('recipient_id').equals(userId)
      .or('sender_id').equals(userId)
      .sortBy('created_at'),
    [userId]
  )

  // `messages` is `undefined` while the Dexie query is still resolving, and
  // only becomes an array once it has actually resolved (possibly empty) —
  // do not coerce with `?? []` here or the empty state flashes before real
  // data loads. Downstream helpers that need an array default internally.
  const unreadFromPM = useMemo(
    () => (messages ?? []).filter((m) => userId && m.recipient_id === userId && !m.read_at),
    [messages, userId]
  )

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages?.length])

  useEffect(() => {
    if (!userId || unreadFromPM.length === 0) return
    const otherUserId = unreadFromPM[0]!.sender_id
    markConversationRead(otherUserId)
      .catch((err) => console.error('[messages] markConversationRead failed:', err))
  }, [userId, unreadFromPM])

  function handleSend() {
    const content = draft.trim()
    if (!content) return
    setSendError(null)
    startSend(async () => {
      const result = await sendMessageToPM(content)
      if (result.success) {
        setDraft('')
      } else {
        setSendError(result.error ?? 'Failed to send message')
      }
    })
  }

  return (
    <div className="flex flex-col h-[calc(100vh-9.5rem)] -mx-4 -my-6">
      <div className="px-4 py-3 border-b border-themed bg-card-themed">
        <span className="font-semibold text-brand-800">FieldStay Operations</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
        {messages === undefined && <CrewLoading label="Loading messages…" />}
        {messages !== undefined && messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-themed">
            <MessageSquare className="w-10 h-10" />
            <p className="text-sm">Send a message to your operations team</p>
          </div>
        )}
        {messages !== undefined && messages.map((m) => {
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
                  <p className="text-[10px] mt-0.5 text-muted-themed italic">
                    {m.group_label}
                  </p>
                )}
                <p className={cn('text-[10px] mt-1', fromMe ? 'text-brand-200' : 'text-muted-themed')}>
                  {formatDateTime(m.created_at)}
                </p>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-themed bg-card-themed">
        {sendError && (
          <div className="px-3 pt-2 text-xs text-red-600">{sendError}</div>
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
          className="flex-1 px-3 py-2 rounded-lg text-sm outline-none resize-none border border-themed bg-card-themed text-primary-themed"
        />
        <button
          onClick={handleSend}
          disabled={sending || !draft.trim()}
          className="min-h-11 min-w-11 flex items-center justify-center rounded-lg shrink-0 bg-brand-800 text-white disabled:opacity-40"
        >
          <Send className="w-4 h-4" />
        </button>
        </div>
      </div>
    </div>
  )
}
