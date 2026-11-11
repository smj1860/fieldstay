/**
 * Where the login page's "Start free trial" link should go.
 *
 * A partner landing page (/ownerrez, /hospitable) sends a visitor to
 * /login?next=/api/integrations/<provider>/connect. Someone who has no account
 * and clicks "Start free trial" from there used to arrive at a bare /signup,
 * dropping the provider the page's own sign-up buttons carry
 * (/signup?provider=<provider>&next=/onboarding). This hands it back.
 *
 * `provider` is taken only from a strict slug pattern, so nothing the URL
 * supplies can add a character to the link beyond [a-z0-9-].
 */
const PROVIDER_CONNECT_PATH = /^\/api\/integrations\/([a-z0-9-]+)\/connect(?:[/?#]|$)/

export function signupHrefForLoginNext(next: string | null | undefined): string {
  const match = next ? PROVIDER_CONNECT_PATH.exec(next) : null
  return match ? `/signup?provider=${match[1]}&next=/onboarding` : '/signup'
}
