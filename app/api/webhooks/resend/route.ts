import { NextRequest, NextResponse } from 'next/server'

import { createServiceClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { createPmNotifications, type CreatePmNotificationInput } from '@/lib/inngest/helpers'
import {
  verifyResendSignature, parseResendEvent, classifyEvent,
  problemTitle, problemHint, lookupAddresses, type EmailProblem,
} from '@/lib/resend/webhook'

// ============================================================================
// Resend delivery events: a bounced, complained-about, suppressed or failed email
// used to vanish. Nothing told FieldStay, so a crew invite to a mistyped address
// looked sent forever.
//
// This route verifies Resend's signature, claims the delivery once, and then:
//   1. Reports it to Sentry as a WARNING (a signal, not a fault) with no address.
//   2. Where the recipient is a crew member, vendor or property owner on file,
//      puts a note in that org's notification bell so the PM can fix the address.
//
// A recipient that matches nobody (a PM's own sign-in email, a guest) is reported
// to Sentry only: there is no org to tell.
// ============================================================================

type ServiceClient = ReturnType<typeof createServiceClient>

interface Contact {
  orgId: string
  name:  string
  email: string
  href:  string
  kind:  'crew' | 'vendor' | 'owner'
}

/** Every contact on file whose address matches. Three bounded reads, not one per recipient. */
async function findContacts(supabase: ServiceClient, addresses: string[]): Promise<Contact[]> {
  if (addresses.length === 0) return []

  const [crew, vendors, owners] = await Promise.all([
    fetchAllRows<{ id: string; org_id: string; name: string; email: string | null }>(
      (from, to) => supabase.from('crew_members').select('id, org_id, name, email')
        .in('email', addresses).order('id', { ascending: true }).range(from, to),
      { label: 'resend-webhook-crew' },
    ),
    fetchAllRows<{ id: string; org_id: string; name: string; email: string | null }>(
      (from, to) => supabase.from('vendors').select('id, org_id, name, email')
        .in('email', addresses).order('id', { ascending: true }).range(from, to),
      { label: 'resend-webhook-vendors' },
    ),
    fetchAllRows<{ id: string; org_id: string; property_id: string; name: string; email: string | null }>(
      (from, to) => supabase.from('property_owners').select('id, org_id, property_id, name, email')
        .in('email', addresses).order('id', { ascending: true }).range(from, to),
      { label: 'resend-webhook-owners' },
    ),
  ])

  return [
    ...(crew ?? []).map((c): Contact => ({
      orgId: c.org_id, name: c.name, email: c.email ?? '', kind: 'crew', href: '/crew',
    })),
    ...(vendors ?? []).map((v): Contact => ({
      orgId: v.org_id, name: v.name, email: v.email ?? '', kind: 'vendor', href: `/vendors/${v.id}`,
    })),
    ...(owners ?? []).map((o): Contact => ({
      orgId: o.org_id, name: o.name, email: o.email ?? '', kind: 'owner', href: `/properties/${o.property_id}`,
    })),
  ]
}

function toNotification(
  contact: Contact, problem: EmailProblem, emailId: string,
): CreatePmNotificationInput {
  return {
    orgId:    contact.orgId,
    type:     'email_delivery_problem',
    title:    problemTitle(problem, contact.name),
    subtitle: `${contact.email}. ${problemHint(problem)}`,
    href:     contact.href,
    severity: 'amber',
    // One note per email per contact: a retried delivery cannot stack them.
    dedupeKey: `email-problem:${problem}:${emailId}:${contact.kind}:${contact.name}`,
  }
}

async function handleProblem(
  supabase: ServiceClient, problem: EmailProblem, emailId: string | undefined,
  recipients: string[], bounceType: string | undefined,
): Promise<void> {
  // No address and no org id here: the event is a count, not a record of who.
  reportError(new Error(`Resend email ${problem}`), {
    site:  'webhook.resend.delivery_problem',
    level: 'warning',
    tags:  { problem, ...(bounceType ? { bounce_type: bounceType } : {}) },
    extra: { email_id: emailId ?? null },
  })

  if (!emailId) return
  const contacts = await findContacts(supabase, lookupAddresses(recipients))
  await createPmNotifications(supabase, contacts.map((c) => toNotification(c, problem, emailId)))
}

export async function POST(req: NextRequest) {
  // Raw body first: the signature is over the exact bytes.
  const rawBody = await req.text()
  const headers = {
    id:        req.headers.get('svix-id'),
    timestamp: req.headers.get('svix-timestamp'),
    signature: req.headers.get('svix-signature'),
  }

  if (!verifyResendSignature(rawBody, headers, process.env.RESEND_WEBHOOK_SECRET)) {
    reportError(new Error('Resend webhook signature verification failed'), {
      site: 'webhook.resend.signature_verification', level: 'warning',
    })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const event = parseResendEvent(rawBody)
  if (!event) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const problem = classifyEvent(event)
  if (!problem) return NextResponse.json({ received: true })

  const supabase  = createServiceClient({ publicSurface: 'api-webhooks-resend' })
  const webhookId = `resend:${headers.id}`

  // Replay/retry guard. The svix id is stable across Resend's retries.
  const claim = await supabase.from('processed_webhooks').insert({ webhook_id: webhookId })
  if (claim.error?.code === '23505') return NextResponse.json({ received: true, duplicate: true })
  if (claim.error) {
    // A dedup outage must not drop the alert: the notification has its own dedupe key.
    reportError(new Error(claim.error.message), { site: 'webhook.resend.dedup_insert' })
  }

  try {
    await handleProblem(
      supabase, problem, event.data.email_id, event.data.to ?? [], event.data.bounce?.type,
    )
  } catch (err) {
    reportError(err, { site: 'webhook.resend.handler' })
    // Release the claim so Resend's retry is processed instead of discarded as a duplicate.
    const { error: releaseErr } = await supabase
      .from('processed_webhooks').delete().eq('webhook_id', webhookId)
    if (releaseErr) reportError(new Error(releaseErr.message), { site: 'webhook.resend.dedup_release' })
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
