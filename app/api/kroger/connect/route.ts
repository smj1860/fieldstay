// app/api/kroger/connect/route.ts
// Place at: app/api/kroger/connect/route.ts

import { NextResponse }       from 'next/server'
import { cookies }            from 'next/headers'
import { requireOrgMember }   from '@/lib/auth'
import { buildKrogerAuthUrl } from '@/lib/kroger/client'

export async function GET() {
  await requireOrgMember()

  const state       = crypto.randomUUID()
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/kroger/callback`

  const cookieStore = await cookies()
  cookieStore.set('kroger_oauth_state', state, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   600,
    path:     '/',
  })

  return NextResponse.redirect(buildKrogerAuthUrl(state, redirectUri))
}
