// src/app/api/integrations/[provider]/connect/route.ts
// ============================================================
// OAuth Step 1: Initiate the authorization flow.
//
// Works for any provider in the registry.
// Adding a new OAuth integration never requires changing this file.
//
// Flow:
//   1. User clicks "Connect OwnerRez" (or arrives from OwnerRez marketplace)
//   2. Browser hits GET /api/integrations/ownerrez/connect
//   3. We generate a random state token, persist it in the DB
//   4. We redirect the user to OwnerRez's authorization page
//   5. User approves → OwnerRez sends them to /callback (handled in callback/route.ts)
//
// Cookie strategy:
//   We use NextResponse.next() as a temporary accumulator for any session
//   token refreshes Supabase performs during getUser(). Those cookies are
//   then copied onto the final redirect response before returning.
//   We do NOT use cookies() from next/headers — mutations via that API are
//   unreliable when the handler returns a NextResponse.redirect().
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient }             from '@supabase/ssr'
import { createClient }                   from '@supabase/supabase-js'
import { randomBytes }                    from 'crypto'
import { getProvider }                    from '@/lib/integrations/registry'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const resolvedParams = await params
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL!
  const providerId = resolvedParams.provider.toLowerCase()

  // ── 1. Validate the requested provider ────────────────────
  let providerAdapter
  try {
    providerAdapter = getProvider(providerId)
  } catch {
    return NextResponse.json(
      { error: `Unknown integration provider: "${providerId}"` },
      { status: 404 }
    )
  }

  if (providerAdapter.authType !== 'oauth2' || !providerAdapter.getAuthorizationUrl) {
    return NextResponse.json(
      { error: `Provider "${providerId}" does not support OAuth2` },
      { status: 400 }
    )
  }

  // ── 2. Set up Supabase client with response-bound cookie accumulator ─
  //
  //    When getUser() is called, Supabase may refresh the session token
  //    and invoke setAll() with new cookie values. Those values must land
  //    on the response we actually return, not a separate store.
  //
  //    Pattern:
  //      a) Create supabaseResponse = NextResponse.next() as an accumulator
  //      b) Wire setAll() to write into it
  //      c) After building our real redirect, copy those cookies across
  //         via makeRedirect() before returning
  const supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        // Read from the incoming request (where the session cookie lives)
        getAll() {
          return request.cookies.getAll()
        },
        // Write to both the request object (so in-handler reads stay consistent)
        // and our accumulator response (so they end up on the final redirect)
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // ── Helper: produce any redirect with Supabase session cookies attached ─
  function makeRedirect(destination: string | URL): NextResponse {
    const res = NextResponse.redirect(destination, { status: 302 })
    // Copy any session refreshes Supabase performed onto the real response
    supabaseResponse.cookies.getAll().forEach((cookie) => res.cookies.set(cookie))
    return res
  }

  // ── 3. Identify the current user (if already logged in) ───
  //    Users arriving from the OwnerRez marketplace may not yet have a
  //    FieldStay account. user will be null in that case — handled in /callback.
  const { data: { user } } = await supabase.auth.getUser()

  // ── 4. Generate the CSRF state token ──────────────────────
  const state = randomBytes(32).toString('hex')


  // ── 5. Persist state in the DB ────────────────────────────
  //    Storing in the DB (not only a cookie) makes the state durable
  //    across cross-device flows and easier to expire/consume server-side.
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { error: stateError } = await admin.from('oauth_states').insert({
    state,
    user_id:     user?.id ?? null,
    provider_id: providerId,
    return_to:   request.nextUrl.searchParams.get('return_to') ?? '/ops',
  })

  if (stateError) {
    console.error(`[OAuth:${providerId}] Failed to persist OAuth state:`, stateError.message)
    return makeRedirect(
      new URL(`/connect/error?provider=${providerId}&error=state_creation_failed`, appUrl)
    )
  }

  // ── 6. Build the authorization URL and redirect ────────────
  const redirectUri      = `${appUrl}/api/integrations/${providerId}/callback`
  const authorizationUrl = providerAdapter.getAuthorizationUrl({ state, redirectUri })

  // makeRedirect carries any Supabase session cookies onto this response
  const response = makeRedirect(authorizationUrl)

  // Belt-and-suspenders: also store state in an httpOnly cookie as a secondary
  // verification source. The DB record is the authoritative check in /callback.
  response.cookies.set(`oauth_state_${providerId}`, state, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',     // 'lax' required — 'strict' blocks the top-level redirect back from OwnerRez
    path:     '/',
    maxAge:   60 * 10,   // 10 minutes — matches OwnerRez's temporary code expiry
  })

  return response
}
