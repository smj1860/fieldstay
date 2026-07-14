'use client'

import { useState }     from 'react'
import { useRouter }    from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

interface Props {
  userName:  string
  userEmail: string
  orgName:   string
}

export function SidebarUserMenu({ userName, userEmail, orgName }: Readonly<Props>) {
  const router            = useRouter()
  const [loading, setLoading] = useState(false)
  const [open,    setOpen]    = useState(false)

  async function handleSignOut() {
    setLoading(true)
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const initials = userName
    .split(' ')
    .map(n => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <div style={{ position: 'relative' }}>
      {/* User row — tap to toggle popover */}
      <button
        onClick={() => setOpen(prev => !prev)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/10 transition-colors text-left"
        aria-label="User menu"
      >
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
          style={{ background: 'var(--chrome-gold)', color: 'var(--chrome-bg)' }}
        >
          {initials}
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold truncate"
               style={{ color: 'var(--chrome-text)' }}>
            {userName}
          </div>
          <div className="text-xs truncate opacity-60"
               style={{ color: 'var(--chrome-text-muted)' }}>
            {orgName}
          </div>
        </div>

        <svg
          className="w-3.5 h-3.5 shrink-0 opacity-50"
          style={{
            color:      'var(--chrome-text-muted)',
            transform:  open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
          }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>

      {/* Popover — appears above the button */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            role="button"
            tabIndex={0}
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(false) } }}
          />

          <div
            className="absolute bottom-full left-0 right-0 mb-2 z-50 rounded-xl overflow-hidden"
            style={{
              minWidth:  200,
              background: 'var(--bg-raised)',
              border:     '1px solid var(--border)',
              boxShadow:  '0 4px 16px rgba(0,0,0,0.3)',
            }}
          >
            <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{userName}</div>
              <div className="text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{userEmail}</div>
            </div>

            <div className="py-1">
              <button
                onClick={handleSignOut}
                disabled={loading}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent-gold)]"
                style={{ color: '#ef4444' }}
                onMouseOver={(e) => { e.currentTarget.style.background = 'var(--bg-card)' }}
                onFocus={(e)     => { e.currentTarget.style.background = 'var(--bg-card)' }}
                onMouseOut={(e)  => { e.currentTarget.style.background = 'transparent' }}
                onBlur={(e)      => { e.currentTarget.style.background = 'transparent' }}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24"
                     stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75"/>
                </svg>
                {loading ? 'Signing out...' : 'Sign out'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
