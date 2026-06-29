import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// Database['public'] doesn't satisfy postgrest-js v2.106's GenericSchema constraint
// (hand-written interfaces lack index signatures required by Record<string, GenericTable>).
// We omit the <Database> type arg so Schema defaults to `any`, which allows all
// .from() queries to type-check. Replace with Supabase CLI-generated types once connected.

/**
 * Server-side Supabase client for use in:
 * - Server Components
 * - Route Handlers
 * - Server Actions
 *
 * Uses the anon key + RLS for normal user operations.
 * Use createServiceClient() for privileged server-side operations
 * (Inngest functions, webhooks).
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // setAll called from a Server Component — cookies
            // can't be set here. Middleware handles token refresh.
          }
        },
      },
    }
  )
}

/**
 * Service-role client — bypasses RLS.
 * Only use in trusted server contexts: Inngest functions,
 * Stripe webhooks, iCal sync, vendor portal completion.
 * Never expose to the client.
 */
// lib/supabase/server.ts — createServiceClient only, leave createClient unchanged

export function createServiceClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll: () => [],
        setAll: () => {},
      },
      auth: {
        autoRefreshToken: false,
        persistSession:   false,
      },
      // Disable WebSocket connection to Supabase Realtime (Warp).
      // Inngest functions, webhooks, and server actions never subscribe
      // to real-time events. Without this, every Inngest step opens a
      // WebSocket that Warp's timeout manager kills 15 minutes later,
      // producing "Thread killed by timeout manager" logs on every sync cycle.
      realtime: {
        params: { eventsPerSecond: -1 },
      },
    }
  )
}