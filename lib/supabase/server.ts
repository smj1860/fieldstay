import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// The <Database> generic is still omitted, so `Schema` defaults to `any` and
// NO .from() or .rpc() call in this app is type-checked. That is a real gap,
// not a style choice: reviews.internal_notes (fixed 2026-08-02) was selected
// by a cron for months — PostgREST rejects the whole select on an unknown
// column, so the job threw on every run for every org — and nothing compared
// the select string against the schema because there was nothing to compare
// it to.
//
// The blocker used to be that types/database.ts was hand-written and its
// interfaces do not satisfy postgrest-js's GenericSchema constraint (no index
// signatures, no Relationships), so binding them collapsed every row type to
// `never`: 2267 errors, 2163 of them that one collapse.
//
// That blocker is now GONE. types/database.generated.ts is generated from the
// live schema and Database re-exports it, so wiring the generic here is:
//
//   import type { Database } from '@/types/database'
//   return createServerClient<Database>(
//
// Measured on that basis: 138 errors, across 44 files — a long tail of
// insert/update payload mismatches, nullability, and Json shapes, each needing
// its own judgement rather than one mechanical fix. Wiring it is the next step
// and must land with those 138 resolved, not before; a half-wired client is
// worse than an unwired one because it looks checked.

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
 * Anon-key client that reads NO cookies and writes NO cookies, so nothing it
 * does touches the caller's live session.
 *
 * The one use for this is re-authentication: proving the person holding the
 * session also knows the current password before a sensitive change (password
 * rotation). `createClient()` cannot do that job — a successful
 * signInWithPassword() on the cookie-bound client would silently rotate the
 * caller's session cookies as a side effect of the check, and a failed one on
 * some GoTrue error paths can clear them. This client makes the verification a
 * pure question with a yes/no answer.
 *
 * It holds no elevated privilege at all (anon key, RLS enforced, no session),
 * so it is not a service-role bypass and needs no ServiceRoleContext.
 */
export function createReauthClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => [],
        setAll: () => {},
      },
      auth: {
        autoRefreshToken: false,
        persistSession:   false,
      },
      realtime: {
        params: { eventsPerSecond: -1 },
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
 * - platformAdmin:     the staff admin from requirePlatformAdmin(), used only
 *                      for writes that cross org boundaries (e.g. broadcasting
 *                      a platform inventory template to other orgs' own
 *                      inventory_templates rows) — requirePlatformAdmin()'s
 *                      own RLS-scoped client covers everything that stays
 *                      within is_platform_staff_admin()-gated tables; this
 *                      variant is only for the narrow case where the target
 *                      row's RLS is scoped to a DIFFERENT org than the caller
 */
export type ServiceRoleContext =
  | { authorizedBy: { org_id: string; role: string } }
  | { authenticatedUser: { id: string } }
  | { crew: { id: string; org_id: string } }
  | { publicSurface: string }
  | { system: string }
  | { platformAdmin: { id: string } }

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