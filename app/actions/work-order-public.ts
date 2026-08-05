'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { requireOrgMember }    from '@/lib/auth'
import { inngest }             from '@/lib/inngest/client'
import { revalidatePath }      from 'next/cache'
import { logAuditEvent }       from '@/lib/audit'
import { renderSmsBody }       from '@/lib/sms/templates'
import { getManualUrlForAsset } from '@/lib/assets/manual-lookup'
import { unwrapJoin }          from '@/lib/utils/supabase-joins'

import { reportError } from '@/lib/observability/report-error'
import { tryUnwrap }   from '@/lib/supabase/unwrap'
import { checkLimit, emailSendActionLimiter } from '@/lib/rate-limit'
const TOKEN_TTL_DAYS = 30
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.com'

/**
 * The dispatch token written to `work_orders.completion_token`.
 *
 * MUST be a UUID. That column is `uuid` in the live schema, and the previous
 * implementation returned `randomBytes(32).toString('hex')` — 64 characters,
 * which Postgres rejects with `22P02: invalid input syntax for type uuid`.
 * An UPDATE is atomic, so the whole statement failed and every dispatch
 * returned "Failed to generate work order link". Production bears this out:
 * every completion_token in the table is a 36-char UUID (the column default,
 * or crypto.randomUUID() from the four other writers) — not one 64-char value
 * was ever stored.
 *
 * It survived 15 green unit tests because they mock the Supabase client, and
 * a mocked database cannot fail a cast.
 */
function generatePublicToken(): string {
  return crypto.randomUUID()
}

function photoFileExtension(mimeType: string): string {
  if (mimeType === 'image/png')  return 'png'
  if (mimeType === 'image/webp') return 'webp'
  return 'jpg'
}

export async function dispatchWorkOrderToVendor(input: {
  workOrderId:  string
  vendorEmail:  string
  vendorName:   string
  vendorPhone?: string | null
}): Promise<{ success?: boolean; token?: string; publicUrl?: string; error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    // This action sends an email AND an SMS to addresses that arrive in the
    // request body. Without a limiter, one authenticated trial user could loop
    // it over attacker-chosen recipients — bounded only by Vercel concurrency
    // — and relay from our sending domain and our Telnyx number. Resend's
    // idempotency key includes the recipient, so varying it defeats that too.
    // Keyed per user: the org is not the thing being abused.
    const limit = await checkLimit(emailSendActionLimiter, user.id, {
      onError: 'allow',   // abuse limiter, not a spend ceiling — see lib/rate-limit.ts
      site:    'serverAction.work-order-public.dispatchWorkOrderToVendor',
    })
    if (!limit.allowed) {
      return { error: 'Too many vendor dispatches in the last hour. Please try again shortly.' }
    }

    const { data: wo, error: fetchErr } = await supabase
      .from('work_orders')
      .select(`
        id, wo_number, status, org_id, property_id, asset_id, title,
        description, nte_amount, access_notes, lockbox_code, parking_notes,
        properties ( name, address ),
        vendors ( name, email )
      `)
      .eq('id', input.workOrderId)
      .eq('org_id', membership.org_id)
      .single()

    if (fetchErr || !wo) return { error: 'Work order not found' }

    if (wo.status === 'cancelled') {
      return { error: 'This work order has been cancelled' }
    }

    // The recipient is NEVER taken from the request body. `vendorEmail` and
    // `vendorPhone` used to be relayed verbatim to Resend and Telnyx, which
    // made this action a general-purpose email/SMS relay for anyone with a
    // trial account — and the Resend idempotency key contains the recipient,
    // so looping over addresses defeated that too. Resolve the vendor from our
    // own records, scoped to the caller's org, and send only to the contact
    // details that row carries.
    const vendorRes = await supabase
      .from('vendors')
      .select('id, name, email, phone')
      .eq('org_id', membership.org_id)
      .ilike('email', input.vendorEmail.trim())
      .limit(1)
      .maybeSingle()

    const vendorOut = tryUnwrap<{ id: string; name: string; email: string | null; phone: string | null }>(
      vendorRes, { site: 'serverAction.work-order-public.dispatchWorkOrderToVendor.vendor', orgId: membership.org_id },
    )
    if (!vendorOut.ok) return { error: 'Could not verify the vendor. Please try again.' }
    if (!vendorOut.data?.email) {
      return { error: 'That vendor is not in your address book, or has no email on file.' }
    }

    const vendorEmail = vendorOut.data.email
    const vendorName  = vendorOut.data.name
    const vendorPhone = vendorOut.data.phone

    const token     = generatePublicToken()
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + TOKEN_TTL_DAYS)

    const { error: updateErr } = await supabase
      .from('work_orders')
      .update({
        completion_token:            token,
        completion_token_expires_at: expiresAt.toISOString(),
        vendor_dispatch_email:       vendorEmail,
        // The portal page this link points at filters on
        // .eq('portal_enabled', true) (app/work-orders/[token]/page.tsx:38).
        // Dispatching a work order created with the portal off — which is the
        // default whenever request_quotes was set, see maintenance/actions.ts
        // `usePortal` — minted a valid token behind a notFound(). The Inngest
        // dispatch path already sets this for the same reason
        // (work-order-vendor-assigned.ts:99).
        portal_enabled:              true,
      })
      .eq('id', input.workOrderId)
      // Defence in depth. The row was already org-scoped on the read above and
      // this client is RLS-enforced, but a write reachable from a request body
      // should not depend on a check made ninety lines earlier.
      .eq('org_id', membership.org_id)

    if (updateErr) {
      console.error('[dispatchWorkOrderToVendor] update token', updateErr)
      return { error: 'Failed to generate work order link' }
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, phone')
      .eq('id', user.id)
      .single()

    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', membership.org_id)
      .single()

    const property = unwrapJoin(wo.properties)

    const manualUrl = await getManualUrlForAsset(supabase, membership.org_id, wo.asset_id ?? null)

    await inngest.send({
      name: 'work-order/dispatched' as const,
      data: {
        workOrderId:      wo.id,
        woNumber:         wo.wo_number ?? '',
        token,
        publicUrl:        `${APP_URL}/work-orders/${token}`,
        vendorEmail:      vendorEmail,
        vendorName:       vendorName,
        propertyName:     (property as { name: string } | null)?.name  ?? 'Property',
        propertyAddress:  (property as { address: string | null } | null)?.address ?? '',
        title:            wo.title,
        description:      wo.description ?? '',
        nteAmount:        (wo.nte_amount as number | null) ?? 0,
        dispatcherName:   profile?.full_name ?? 'Your Property Manager',
        dispatcherOrg:    org?.name ?? 'FieldStay Property Management',
        dispatcherPhone:  profile?.phone ?? null,
        manualUrl,
      },
    })

    // SMS — send alongside the dispatched email when vendor has a mobile number
    if (vendorPhone) {
      const { normalizePhoneToE164, sendSMS } = await import('@/lib/sms/telnyx')

      const e164 = normalizePhoneToE164(vendorPhone)
      if (e164) {
        const nteAmt     = (wo.nte_amount as number | null) ?? 0
        const nteLine    = nteAmt > 0 ? `\nNTE: $${nteAmt.toLocaleString()}` : ''
        const propName   = (property as { name: string } | null)?.name ?? 'Property'
        const portalUrl  = `${APP_URL}/work-orders/${token}`

        try {
          const smsBody = await renderSmsBody(membership.org_id, 'vendor_work_order', {
            vendor_name:   vendorName,
            wo_number:     wo.wo_number ?? '',
            property_name: propName,
            pm_name:       profile?.full_name ?? 'Your Property Manager',
            org_name:      org?.name ?? 'FieldStay Property Management',
            nte_amount:    nteAmt,
            window:        null,    // manual dispatch has no scheduled window
            nte_line:      nteLine,
            window_line:   '',
            portal_url:    portalUrl,
          })
          await sendSMS(e164, smsBody, { orgId: membership.org_id })
        } catch (smsErr) {
          console.error('[dispatchWorkOrderToVendor] SMS failed (non-fatal):', smsErr)
          reportError(smsErr, { site: 'serverAction.work-order-public.dispatchWorkOrderToVendor' })
        }
      }
    }

    revalidatePath('/maintenance')
    return { success: true, token, publicUrl: `${APP_URL}/work-orders/${token}` }

  } catch (err) {
    console.error('[dispatchWorkOrderToVendor]', err)
    reportError(err, { site: 'serverAction.work-order-public.dispatchWorkOrderToVendor' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// Uses service client — the token IS the authorization.
// No auth.uid() available; token is the sole gate.
export async function getWorkOrderByToken(token: string): Promise<{
  data?: {
    id: string
    wo_number: string | null
    status: string
    title: string
    description: string | null
    nte_amount: number | null
    access_notes: string | null
    lockbox_code: string | null
    parking_notes: string | null
    public_token_expires_at: string | null
    public_viewed_at: string | null
    public_signed_off_at: string | null
    sign_off_notes: string | null
    vendor_dispatch_email: string | null
    properties: { id: string; name: string; address: string | null } | null
    vendors: { id: string; name: string } | null
    organizations: { name: string } | null
  }
  error?: string
}> {
  if (!token || token.length !== 64) return { error: 'Invalid link' }

  const supabase = createServiceClient({ publicSurface: 'work-order-public-token' })

  const { data: wo, error } = await supabase
    .from('work_orders')
    .select(`
      id, wo_number, status, title, description, nte_amount,
      access_notes, lockbox_code, parking_notes,
      public_token_expires_at, public_viewed_at, public_signed_off_at,
      sign_off_notes, vendor_dispatch_email,
      properties ( id, name, address ),
      vendors    ( id, name ),
      organizations ( name )
    `)
    .eq('public_token', token)
    .single()

  if (error || !wo) return { error: 'Work order not found or link has expired' }

  if (wo.public_token_expires_at) {
    if (new Date(wo.public_token_expires_at) < new Date()) {
      return { error: 'This work order link has expired. Contact your property manager.' }
    }
  }

  // Mark as viewed on first open (fire-and-forget — don't fail page if this errors)
  if (!wo.public_viewed_at) {
    supabase
      .from('work_orders')
      .update({ public_viewed_at: new Date().toISOString() })
      .eq('id', wo.id)
      .then(({ error: viewErr }) => {
        if (viewErr) console.error('[getWorkOrderByToken] mark viewed', viewErr)
      })
  }

  return {
    data: {
      ...wo,
      properties: unwrapJoin(wo.properties),
      vendors:    unwrapJoin(wo.vendors),
      organizations: unwrapJoin(wo.organizations),
    }
  }
}

const MAX_PHOTOS      = 5
const MAX_PHOTO_BYTES = 10 * 1024 * 1024  // 10 MB
const ALLOWED_MIME    = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])

type ServiceClient = ReturnType<typeof createServiceClient>

/** Returns an error message, or null when the batch is acceptable. */
function validateSignOffPhotos(photos: File[] | undefined): string | null {
  if (!photos || photos.length === 0) return null
  if (photos.length > MAX_PHOTOS) return `Maximum ${MAX_PHOTOS} photos allowed`
  for (const photo of photos) {
    if (photo.size > MAX_PHOTO_BYTES) return 'Each photo must be under 10 MB'
    if (!ALLOWED_MIME.has(photo.type)) return 'Only JPEG, PNG, WebP, or HEIC photos are accepted'
  }
  return null
}

/**
 * Per-work-order submission throttle.
 *
 * ⚠️ The key is deliberately derived from the TOKEN, so the budget is per
 * work order rather than per contractor — a contractor legitimately submits
 * once, so 5 attempts in 5 minutes against the same WO is already generous.
 * This provides NO enumeration protection whatsoever: an attacker guessing
 * tokens uses a DIFFERENT key on every attempt and never collides with
 * itself here. Token-enumeration throttling for this surface comes solely
 * from proxy.ts's per-IP workOrderRatelimit on the '/work-orders/' prefix.
 *
 * Abuse limiter → fails OPEN: a degraded Redis must never block a
 * legitimate contractor's sign-off.
 */
async function signOffThrottled(token: string): Promise<boolean> {
  const { signOffRatelimit, checkLimit } = await import('@/lib/rate-limit')
  const decision = await checkLimit(signOffRatelimit, `signoff:${token.slice(0, 16)}`, {
    onError: 'allow',
    site:    'serverAction.work-order-public.submitWorkOrderSignOff',
  })
  return !decision.allowed
}

async function uploadSignOffPhotos(
  supabase:    ServiceClient,
  orgId:       string,
  workOrderId: string,
  photos:      File[],
): Promise<void> {
  for (const photo of photos) {
    // Path MUST start with the owning org's id — see the identical note in
    // app/api/work-orders/[token]/photos/route.ts: the work-order-photos
    // bucket becomes private with org-scoped storage RLS keyed on
    // (storage.foldername(name))[1].
    const ext  = photoFileExtension(photo.type)
    const path = `${orgId}/work-orders/${workOrderId}/signoff/${crypto.randomUUID()}.${ext}`
    const { error: uploadErr } = await supabase.storage
      .from('work-order-photos')
      .upload(path, photo, { contentType: photo.type, upsert: false })
    if (uploadErr) {
      console.error('[submitWorkOrderSignOff] photo upload', uploadErr)
      continue
    }
    // work_order_photos has created_at (DEFAULT now()), NOT uploaded_at —
    // naming a column that does not exist made PostgREST reject the whole
    // insert, and the discarded result meant every vendor sign-off photo
    // landed in the bucket and was then never linked to its work order.
    const { error: insertErr } = await supabase.from('work_order_photos').insert({
      work_order_id: workOrderId,
      storage_path:  path,
    })
    if (insertErr) {
      console.error('[submitWorkOrderSignOff] photo row insert', insertErr)
    }
  }
}

export async function submitWorkOrderSignOff(
  token:       string,
  notes:       string,
  photos?:     File[],
  actualCost?: number
): Promise<{ success?: boolean; error?: string }> {
  if (!token || token.length !== 64) return { error: 'Invalid link' }

  const photoError = validateSignOffPhotos(photos)
  if (photoError) return { error: photoError }

  if (actualCost !== undefined && (actualCost < 0 || actualCost > 1_000_000)) {
    return { error: 'Cost must be a valid amount' }
  }

  if (await signOffThrottled(token)) {
    return { error: 'Too many requests. Please try again in a few minutes.' }
  }

  const supabase = createServiceClient({ publicSurface: 'work-order-public-token' })

  const { data: wo, error: fetchErr } = await supabase
    .from('work_orders')
    .select(`
      id, wo_number, status, title, org_id,
      public_token_expires_at, public_signed_off_at,
      vendor_dispatch_email,
      properties ( name, address ),
      organizations ( name )
    `)
    .eq('public_token', token)
    .single()

  if (fetchErr || !wo) return { error: 'Work order not found' }

  // Cheap pre-checks — these only produce a friendlier message sooner. The
  // authoritative already-signed-off check is the UPDATE's own
  // .is('public_signed_off_at', null) precondition below.
  if (wo.public_signed_off_at) {
    return { error: 'This work order has already been signed off' }
  }

  if (wo.status === 'cancelled') {
    return { error: 'This work order has been cancelled' }
  }

  if (wo.public_token_expires_at && new Date(wo.public_token_expires_at) < new Date()) {
    return { error: 'This work order link has expired' }
  }

  const now = new Date().toISOString()

  // TOCTOU guard: the precondition lives IN the UPDATE, not in an `if` before
  // it. Two concurrent submits (double-tap, retried form post) both passed the
  // read-then-write check above and both wrote — duplicating the photo
  // uploads, the audit event and the downstream Inngest notification, and
  // letting whichever landed last decide actual_cost. Postgres serialises the
  // conditional UPDATE, so exactly one request matches a row; the loser gets
  // zero rows back and is treated as "already signed off". Same pattern as
  // app/api/work-orders/[token]/quote/route.ts's .eq('status','pending').
  const { data: signedOff, error: signOffErr } = await supabase
    .from('work_orders')
    .update({
      public_signed_off_at:   now,
      sign_off_notes:         notes.trim() || null,
      status:                 'completed',
      vendor_acknowledged_at: now,
      actual_cost:            actualCost ?? null,
    })
    .eq('id', wo.id)
    .is('public_signed_off_at', null)
    .select('id')
    .maybeSingle()

  if (signOffErr) {
    console.error('[submitWorkOrderSignOff]', signOffErr)
    return { error: 'Failed to record sign-off. Please try again.' }
  }

  if (!signedOff) {
    // Zero rows matched — a concurrent request won the race.
    return { error: 'This work order has already been signed off' }
  }

  const property = unwrapJoin(wo.properties)
  const org      = unwrapJoin(wo.organizations)

  await logAuditEvent({
    orgId:      wo.org_id,
    actorId:    undefined,
    action:     'work_order.vendor_signoff',
    targetType: 'work_order',
    targetId:   wo.id,
    metadata:   {
      has_photos: Boolean(photos?.length),
    },
  })

  if (photos && photos.length > 0) {
    await uploadSignOffPhotos(supabase, wo.org_id, wo.id, photos)
  }

  await inngest.send({
    name: 'work-order/signed-off' as const,
    data: {
      workOrderId:     wo.id,
      woNumber:        wo.wo_number ?? '',
      title:           wo.title,
      signOffNotes:    notes.trim() || null,
      signedOffAt:     now,
      propertyName:    (property as { name: string } | null)?.name    ?? 'Property',
      propertyAddress: (property as { address: string | null } | null)?.address ?? '',
      orgId:           wo.org_id,
      orgName:         (org as { name: string } | null)?.name ?? '',
      vendorEmail:     wo.vendor_dispatch_email ?? null,
    },
  })

  return { success: true }
}
