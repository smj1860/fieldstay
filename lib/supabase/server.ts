import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'

// The <Database> generic IS wired (2026-08-03). Every .from() and .rpc() call
// in this app is now type-checked against types/database.generated.ts, which
// is generated from the live schema.
//
// Why this mattered: reviews.internal_notes was selected by a cron for months
// — PostgREST rejects the whole select on an unknown column, so the job threw
// on every run for every org — and nothing compared the select string against
// the schema because, with `Schema` defaulting to `any`, there was nothing to
// compare it to.
//
// Wiring it took the error count 138 -> 123 -> 0 over three passes. The last
// pass found four more defects of exactly that class, none of which any test
// or lint rule could have caught:
//
//   - checklist_instances.property_id does not exist (the column lives on
//     turnovers). The select discarded its error, so the checklist-signals
//     cron processed ZERO items on every run and the dynamic photo-required
//     learning loop had never produced a signal.
//   - work_order_photos.uploaded_at does not exist (the column is created_at).
//     Vendor sign-off photos uploaded to storage and were then never linked
//     to their work order.
//   - Three to-one embeds indexed with [0] (turnover_assignments->crew_members,
//     inventory_count_drafts->crew_members, draft items->inventory_items), each
//     silently rendering blank, plus one to-MANY embed (reviews->
//     review_responses) read as an object, which opened the response editor
//     empty for any review that already had a draft.
//   - wo_category values with no vendor_specialty counterpart (appliance,
//     flooring, windows_doors, structural) were passed straight into
//     .eq('specialty', ...), so PostgREST rejected the query and auto-assign
//     silently suggested nothing for those four categories.
//
// KEEP IT WIRED. If a change here ever forces the generic off, that is a
// regression, not a cleanup: an unwired client makes every one of the above
// invisible again. Two known limits are documented at their call sites rather
// than worked around globally — supabase-js's select-string type parser cannot
// read the FK-column embed form `alias:fk_column(name)` (see
// app/(dashboard)/maintenance/[id]/page.tsx), and generated RPC Args cannot
// express a nullable parameter (see lib/supabase/rpc-args.ts).

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

  return createServerClient<Database>(
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
  return createServerClient<Database>(
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
  return createServerClient<Database>(
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
 * with the same <Database> generic (see the note above), so their
 * return types are structurally identical. Several files independently
 * redeclared this as `SupabaseClient<any>`; use this instead.
 */
export type DBClient = Awaited<ReturnType<typeof createClient>> | ReturnType<typeof createServiceClient>