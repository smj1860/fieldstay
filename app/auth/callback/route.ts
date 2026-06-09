/**
 * OAuth callback handler at /auth/callback
 *
 * Google OAuth (and other providers) redirect here after authentication.
 * The route group (auth) resolves to /callback, but Google is configured
 * for /auth/callback — this file provides the correct URL.
 *
 * Audit: every successful OAuth callback is logged as auth.oauth.callback.
 * The existing handler in app/(auth)/callback/route.ts is re-used directly;
 * this file is the correct public URL entry point.
 */

export { GET } from '@/app/(auth)/callback/route'
