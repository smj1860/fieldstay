import { NextResponse } from 'next/server'
import { recordUnsubscribe } from '@/app/unsubscribe/[token]/actions'

/**
 * RFC 8058 one-click unsubscribe endpoint.
 *
 * This is the target of the `List-Unsubscribe` header. Gmail and Yahoo's bulk
 * sender rules require that a mail client be able to opt a user out with a
 * single POST, with no confirmation page and no session — so this handler
 * takes the token from the query string and performs the write directly.
 *
 * POST only, deliberately. Mail scanners and link-preview bots GET every URL
 * in a message; honouring a GET here would unsubscribe recipients who never
 * clicked. Humans who click the visible footer link land on
 * /unsubscribe/[token], which likewise only writes on submit.
 *
 * Rate limiting is applied upstream in proxy.ts — '/api/email/unsubscribe' is
 * a TOKEN_ROUTES entry with a matching rateLimiterForPathname branch.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const result = await recordUnsubscribe(token)

  // RFC 8058 clients look at the status code only; there is no human reading
  // this response. An invalid token is still a 400 so the failure is visible
  // in logs rather than silently counted as an opt-out.
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}
