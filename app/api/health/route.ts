import { NextResponse }    from 'next/server'
import { createClient }    from '@/lib/supabase/server'

// Lightweight health check — pinged by uptime monitoring every 3 minutes.
// Returns 200 if the app and database are reachable, 503 otherwise.
// Does NOT require auth — intentionally public.
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const supabase = await createClient()

    // Minimal DB round-trip — just checks connectivity, returns no data
    const { error } = await supabase
      .from('organization_members')
      .select('id')
      .limit(1)
      .maybeSingle()

    if (error) {
      console.error('[health] db check failed:', error.message)
      return NextResponse.json(
        { status: 'degraded', reason: 'db_unreachable' },
        { status: 503 }
      )
    }

    return NextResponse.json(
      { status: 'ok', ts: new Date().toISOString() },
      { status: 200 }
    )
  } catch (err) {
    console.error('[health] unexpected error:', err)
    return NextResponse.json(
      { status: 'error' },
      { status: 503 }
    )
  }
}
