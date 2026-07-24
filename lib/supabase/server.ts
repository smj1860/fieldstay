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
 * The typed justification every service-role call site must present.
 * Structural types only (no imports from lib/auth — that would be a cycle);
 * each variant matches what the corresponding auth helper already returns:
 *
 * - authorizedBy:      the membership from requireOrgMember()/requireOrgRole()
 * - authenticatedUser: the user from requireAuth()/supabase.auth.getUser()
 *                      on self-scoped routes (account delete, GDPR export)
 * - crew:              the crew identity from requireCrewMember()
 * - publicSurface:     a token-gated/webhook/public route that VALIDATES ITS
 *                      OWN ACCESS in-file (the token lookup or signature
 *                      check needs this client, so proof can't precede it) —
 *                      the string names the surface for grep/audit
 * - system:            background execution with ambient service authority:
 *                      Inngest functions, crons, seeds, and internal lib
 *                      helpers whose request-path callers are themselves
 *                      gated — the string is the module/job audit handle
 */
export type ServiceRoleContext =
  | { authorizedBy: { org_id: string; role: string } }
  | { authenticatedUser: { id: string } }
  | { crew: { id: string; org_id: string } }
  | { publicSurface: string }
  | { system: string }

/**
 * Service-role client — bypasses RLS.
 * Only use in trusted server contexts: Inngest functions,
 * Stripe webhooks, iCal sync, vendor portal completion.
 * Never expose to the client.
 *
 * The required context parameter is COMPILE-TIME ONLY — runtime ignores it.
 * It exists so obtaining the RLS-bypassing client forces the author to name
 * why the bypass is justified, checkable by the compiler at every call site
 * (see CLAUDE.md → Structural Enforcement; the unit/guardrails/
 * service-role-authorization test is the cross-file belt to this per-site
 * suspender). Passing a context you don't actually hold (e.g. a hardcoded
 * object literal where a membership should be) is grep-visible and treated
 * as a security-review finding.
 */
// lib/supabase/server.ts — createServiceClient only, leave createClient unchanged

export function createServiceClient(_ctx: ServiceRoleContext) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    // eslint-disable-next-line no-restricted-syntax -- the ONE canonical read of the service-role key (with adminFetch below); everywhere else goes through these helpers
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

/**
 * Raw fetch against the Supabase Admin REST API (e.g. /auth/v1/admin/users)
 * for admin operations not covered by the JS client's postgrest/gotrue
 * wrapper (e.g. GET /auth/v1/admin/users?email= for a targeted user lookup).
 * Server-only — attaches the service role key. Never call from client code.
 */
export function adminFetch(path: string, init?: RequestInit) {
  // eslint-disable-next-line no-restricted-syntax -- see createServiceClient above: canonical key-read site
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!

  return fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey:        key,
      Authorization: `Bearer ${key}`,
      ...init?.headers,
    },
  })
}

/**
 * Shared type for helper functions that accept either client — createClient()
 * and createServiceClient() both call @supabase/ssr's createServerClient()
 * with the same omitted <Database> generic (see the note above), so their
 * return types are structurally identical. Several files independently
 * redeclared this as `SupabaseClient<any>`; use this instead.
 */
export type DBClient = Awaited<ReturnType<typeof createClient>> | ReturnType<typeof createServiceClient>