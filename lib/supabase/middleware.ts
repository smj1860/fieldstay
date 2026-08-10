import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Omit <Database> type arg — see lib/supabase/server.ts for explanation.

/**
 * Refreshes the Supabase auth session and returns the updated
 * response with refreshed cookies. Called from middleware.ts.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Write to request cookies first
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          // Rebuild response so updated cookies flow through
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // getClaims(), not getUser() — and deliberately not getSession() either.
  //
  // All three answer "who is this request", at very different prices:
  //
  //   getSession()  reads the cookie and trusts it. No verification at all. A
  //                 forged cookie passes. Never acceptable here.
  //   getUser()     asks GoTrue over the network, every single request. This is
  //                 what used to run — on EVERY non-bypass request, making
  //                 Supabase Auth's latency and uptime a hard dependency of
  //                 every page load in the app.
  //   getClaims()   verifies the JWT signature locally with WebCrypto against
  //                 the project's JWKS, which is fetched once and cached (and
  //                 edge-cached by Supabase for cold starts).
  //
  // getClaims() only avoids the network when the project signs with an
  // ASYMMETRIC key; on a legacy symmetric HS256 project it silently falls back
  // to a getUser()-style round trip and this change would be a no-op rename.
  // Verified for this project before switching:
  //   GET https://vpmznjktllhmmbfnxuvk.supabase.co/auth/v1/.well-known/jwks.json
  //   -> 200 {"keys":[{"alg":"ES256","kty":"EC",...}]}
  // If JWT signing keys are ever rotated back to a shared secret, this quietly
  // becomes a network call again — correct, just not fast.
  //
  // ── Why this is safe HERE and NOT in lib/auth.ts ────────────────────────
  //
  // Local verification proves the token was issued by us and has not expired.
  // It cannot see REVOCATION: a user deleted, banned, or globally signed out
  // still presents a cryptographically valid token until it expires.
  //
  // That is acceptable for middleware because middleware does ROUTING, not
  // authorization — its entire use of the result is "redirect to /login" or
  // "redirect away from /login". A revoked user who slips past it reaches a
  // page or Server Action that calls requireOrgMember() -> getAuthContext(),
  // which still calls getUser() and still asks the Auth server. Authorization
  // stays authoritative; only the routing hint is local.
  //
  // Session refresh is preserved: getClaims() refreshes an access token that is
  // near expiry before validating it, and the refresh flows through the
  // setAll() handler above exactly as it did under getUser(). A REVOKED refresh
  // token fails that refresh, so a revoked session still dies here — at the
  // next refresh boundary rather than instantly.
  const { data } = await supabase.auth.getClaims()

  // Shaped as `{ id }` rather than returned raw: proxy.ts only ever tests this
  // for truthiness, and narrowing it here stops a future caller from reaching
  // for a claim (or a full User field) that local verification did not prove.
  const user = data?.claims?.sub ? { id: data.claims.sub } : null

  return { supabaseResponse, user }
}
