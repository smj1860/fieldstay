import type { Metadata } from 'next'
import { UnsubscribeForm } from './unsubscribe-form'

export const metadata: Metadata = { title: 'Unsubscribe' }

// No session is read here, so nothing to cache per-user, but the token makes
// every URL unique anyway. Rendered dynamically so the confirmation always
// reflects the action just taken.
export const dynamic = 'force-dynamic'

type Props = Readonly<{ params: Promise<{ token: string }> }>

/**
 * Public CAN-SPAM opt-out landing page.
 *
 * Deliberately does NOT unsubscribe on GET. Mail clients, security scanners
 * and link-preview bots follow every URL in a message, so an opt-out that
 * fired on GET would unsubscribe people who never clicked anything. The
 * actual write happens on POST, from the form below — which is also what
 * RFC 8058 one-click expects.
 */
export default async function UnsubscribePage({ params }: Props) {
  const { token } = await params
  return <UnsubscribeForm token={token} />
}
