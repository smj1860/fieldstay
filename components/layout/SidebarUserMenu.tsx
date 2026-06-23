'use client'

import { useState }     from 'react'
import { useRouter }    from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

interface Props {
  userName:  string
  userEmail: string
  orgName:   string
}

export function SidebarUserMenu({ userName, userEmail, orgName }: Props) {
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
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

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
                onClick={() => { setOpen(false); router.push('/settings') }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors"
                style={{ color: 'var(--text-primary)' }}
                onMouseOver={(e) => { e.currentTarget.style.background = 'var(--bg-card)' }}
                onMouseOut={(e)  => { e.currentTarget.style.background = 'transparent' }}
              >
                <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24"
                     stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"/>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
                Settings
              </button>

              <div className="my-1" style={{ borderTop: '1px solid var(--border)' }}/>

              <button
                onClick={handleSignOut}
                disabled={loading}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors disabled:opacity-50"
                style={{ color: '#ef4444' }}
                onMouseOver={(e) => { e.currentTarget.style.background = 'var(--bg-card)' }}
                onMouseOut={(e)  => { e.currentTarget.style.background = 'transparent' }}
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
