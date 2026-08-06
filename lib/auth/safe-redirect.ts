/**
 * Same-origin redirect target validation — the one implementation.
 *
 * Post-auth "send me back where I was" is an open-redirect surface whenever the
 * destination comes from the URL, and it was one here: both auth forms read
 * `?next=` straight out of searchParams and handed it to `router.push()` with
 * NO validation at all.
 *
 *     https://app.fieldstay.com/login?next=//evil.example.com
 *
 * The victim sees a genuine FieldStay login, types real credentials into the
 * real site, and lands on the attacker's page — which is then free to show a
 * convincing "your session expired, sign in again" form. That the credentials
 * were entered on the legitimate origin is exactly what makes the pivot work.
 *
 * Why a URL parse and not a string check. app/(auth)/callback/route.ts already
 * had `path.startsWith('/') && !path.startsWith('//')`, and that rule ADMITS
 * a backslash form which every browser resolves off-origin:
 *
 *     new URL('/\\evil.example.com', 'https://app.fieldstay.com').origin
 *       === 'https://evil.example.com'
 *
 * WHATWG normalises `\` to `/` in a special scheme, so `/\evil.com` is
 * `//evil.com` by the time anything navigates. It was harmless in the callback
 * only because that route string-concatenates `origin + path` instead of
 * parsing — an accident of that one call site, not a property of the check.
 * Parsing against a sentinel origin and demanding the origin come back
 * unchanged uses the same parser the browser will, so it cannot disagree with
 * the browser about what a string means.
 */

/** Never resolvable — any input that changes the origin is rejected. */
const SENTINEL_ORIGIN = 'https://fieldstay.invalid'

/**
 * Returns `raw` when it is a same-origin path, otherwise `fallback`.
 *
 * The return value is the PARSED path (pathname + search + hash), so callers
 * get the browser's own normalisation rather than the raw string.
 */
export function safeNextPath(
  raw:      string | null | undefined,
  fallback: string,
): string {
  if (!raw) return fallback

  // A scheme-relative or absolute URL is rejected before parsing, so a value
  // like `https://fieldstay.invalid/x` cannot collide with the sentinel.
  if (!raw.startsWith('/')) return fallback

  try {
    const url = new URL(raw, SENTINEL_ORIGIN)
    if (url.origin !== SENTINEL_ORIGIN) return fallback
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return fallback
  }
}
