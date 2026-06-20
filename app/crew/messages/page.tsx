'use client'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { usePowerSyncQuery } from '@powersync/react'
import { Send, MessageSquare } from 'lucide-react'
import { cn, formatDateTime } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { sendMessageToPM, markConversationRead } from '@/app/(dashboard)/messages/actions'

type MessageRow = {
  id:           string
  sender_id:    string
  recipient_id: string
  content:      string
  read_at:      string | null
  group_id:     string | null
  group_label:  string | null
  created_at:   string
}

export default function CrewMessagesPage() {
  const [userId, setUserId]     = useState<string | null>(null)
  const [draft, setDraft]       = useState('')
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, startSend]    = useTransition()
  const bottomRef               = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const supabase = createClient()
    const loadUser = async () => {
      const { data } = await supabase.auth.getUser()
      setUserId(data.user?.id ?? null)
    }
    loadUser()
  }, [])

  const messages = usePowerSyncQuery<MessageRow>(
    `SELECT * FROM messages
     WHERE sender_id = ? OR recipient_id = ?
     ORDER BY created_at ASC`,
    [userId ?? '', userId ?? '']
  )

  const conversation = useMemo(() => messages ?? [], [messages])

  const unreadFromPM = useMemo(
    () => conversation.filter((m) => userId && m.recipient_id === userId && !m.read_at),
    [conversation, userId]
  )

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation.length])

  useEffect(() => {
    if (!userId || unreadFromPM.length === 0) return
    const otherUserId = unreadFromPM[0]!.sender_id
    markConversationRead(otherUserId)
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
      <div className="px-4 py-3 border-b border-accent-200 bg-white">
        <span className="font-semibold text-brand-800">FieldStay Operations</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
        {conversation.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-accent-400">
            <MessageSquare className="w-10 h-10" />
            <p className="text-sm">Send a message to your operations team</p>
          </div>
        )}
        {conversation.map((m) => {
          const fromMe = m.sender_id === userId
          return (
            <div key={m.id} className={cn('flex', fromMe ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[75%] rounded-2xl px-3.5 py-2',
                  fromMe ? 'bg-brand-800 text-white' : 'bg-accent-100 text-accent-800'
                )}
              >
                <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>
                {!fromMe && m.group_label && (
                  <p className="text-[10px] mt-0.5 text-accent-400 italic">
                    {m.group_label}
                  </p>
                )}
                <p className={cn('text-[10px] mt-1', fromMe ? 'text-brand-200' : 'text-accent-400')}>
                  {formatDateTime(m.created_at)}
                </p>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-accent-200 bg-white">
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
          className="flex-1 px-3 py-2 rounded-lg text-sm outline-none resize-none border border-accent-200 bg-white text-accent-900"
        />
        <button
          onClick={handleSend}
          disabled={sending || !draft.trim()}
          className="p-2.5 rounded-lg shrink-0 bg-brand-800 text-white disabled:opacity-40"
        >
          <Send className="w-4 h-4" />
        </button>
        </div>
      </div>
    </div>
  )
}
