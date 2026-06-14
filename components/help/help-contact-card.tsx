'use client'

import { Mail, MessageCircle } from 'lucide-react'

export function HelpContactCard() {
  const hasCrisp =
    typeof process !== 'undefined' &&
    !!process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID

  const openChat = () => {
    if (typeof window !== 'undefined' && window.$crisp) {
      window.$crisp.push(['do', 'chat:open'])
    }
  }

  return (
    <div
      className="mt-10 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center
                 justify-between gap-4"
      style={{
        background: 'var(--bg-card)',
        border:     '1px solid var(--border)',
      }}
    >
      <div>
        <p
          className="text-sm font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          Still stuck?
        </p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
          We typically respond within a few hours on business days.
        </p>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {hasCrisp && (
          <button
            onClick={openChat}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-lg text-sm
                       font-medium transition-all"
            style={{
              background: 'var(--bg-raised)',
              color:      'var(--text-primary)',
              border:     '1px solid var(--border)',
            }}
          >
            <MessageCircle className="w-4 h-4" />
            Chat
          </button>
        )}
        <a
          href="mailto:support@fieldstay.app"
          className="flex items-center gap-2 px-3.5 py-2.5 rounded-lg text-sm
                     font-semibold transition-opacity hover:opacity-80"
          style={{
            background: 'var(--accent-gold)',
            color:      '#0a1628',
          }}
        >
          <Mail className="w-4 h-4" />
          Email Support
        </a>
      </div>
    </div>
  )
}
