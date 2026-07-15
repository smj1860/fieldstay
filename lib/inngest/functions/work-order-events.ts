import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { renderWorkOrderEmail } from '@/emails/work-order'
import { getPmEmail } from '@/lib/inngest/helpers'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { stripe } from '@/lib/stripe/client'
import { renderVendorConnectInviteEmail } from '@/lib/resend/emails/vendor-connect-invite'
import { logAuditEvent } from '@/lib/audit'
import { loadDispatchContext, sendVendorDispatchEmail, sendVendorDispatchSms } from './work-order-events-helpers'

// ── Work Order Created ────────────────────────────────────────────────────────

export const handleWorkOrderCreated = inngest.createFunction(
  {
    id:      'work-order-created',
    name:    'Handle Work Order Created',
    retries: 2,
  },
  { event: 'work-order/created' as const },
  async ({ event, step, logger }) => {
    const { work_order_id, property_id, org_id, portal_enabled } = event.data

    if (portal_enabled) {
      // ── Step 1: Load dispatch context (WO/vendor/property/dispatcher/org,
      // completion-token ensure) ──────────────────────────────────────────────
      const dispatchResult = await step.run('load-dispatch-context', async () => {
        const supabase = createServiceClient()
        return loadDispatchContext(supabase, work_order_id, org_id)
      })

      // ── Step 2: Send vendor email ───────────────────────────────────────────
      // Its own step so a retry of the SMS step below can never re-trigger a
      // duplicate email send, and vice versa.
      if (dispatchResult.dispatched) {
        await step.run('send-vendor-email', async () => {
          const supabase = createServiceClient()
          await sendVendorDispatchEmail(work_order_id, dispatchResult, supabase, org_id)
          logger.info(`Dispatched WO ${work_order_id} to vendor ${dispatchResult.vendorEmail}`)
        })

        // ── Step 3: Send vendor SMS (non-fatal) — send alongside email when
        // vendor has a mobile number ────────────────────────────────────────
        await step.run('send-vendor-sms', async () => {
          await sendVendorDispatchSms(org_id, dispatchResult)
        })
      }

      // ── Step 4: Notify PM of dispatch outcome ──────────────────────────────
      await step.run('notify-pm', async () => {
        const supabase = createServiceClient()
        const pmEmail  = await getPmEmail(supabase, org_id)

        if (!pmEmail) {
          logger.warn(`No PM email found for org ${org_id} — skipping PM notification`)
          return { skipped: true }
        }

        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'

        if (!dispatchResult.dispatched && dispatchResult.reason === 'no_vendor_email') {
          // Vendor has no email — alert PM so they can manually notify the vendor
          await resend.emails.send({
            from:    FROM,
            to:      pmEmail,
            subject: 'Action required — vendor has no email address',
            html: await renderPmAlert({
              heading:  'Work order created — vendor not notified',
              body:     `A work order was created with the vendor portal enabled, but the assigned vendor${dispatchResult.vendorName ? ` (${dispatchResult.vendorName})` : ''} has no email address on file. The vendor was not notified automatically.`,
              details:  [
                { label: 'Action required', value: 'Add an email address to the vendor record so future work orders dispatch automatically.' },
              ],
              ctaLabel: 'Go to Vendors →',
              ctaUrl:   `${appUrl}/vendors`,
            }),
          })
          return { notified: true, reason: 'no_vendor_email_warning' }
        }

        if (dispatchResult.dispatched) {
          // Confirm to PM that vendor was notified
          await resend.emails.send(
            {
              from:    FROM,
              to:      pmEmail,
              subject: `Work order dispatched — ${dispatchResult.woNumber} · ${dispatchResult.propertyName}`,
              html: await renderPmAlert({
                heading:  'Work order sent to vendor',
                body:     `${dispatchResult.vendorName} has been notified of work order ${dispatchResult.woNumber} and can access the job details and sign off via the link in their email.`,
                details:  [
                  { label: 'Property', value: dispatchResult.propertyName ?? null },
                  { label: 'Vendor',   value: dispatchResult.vendorName   ?? null },
                ],
                ctaLabel: 'View work order →',
                ctaUrl:   `${appUrl}/maintenance/${work_order_id}`,
              }),
            },
            { idempotencyKey: `wo-pm-notified-created-${work_order_id}` }
          )
          return { notified: true }
        }

        return { skipped: true }
      })

      // ── Step 5: Immediate Stripe Connect invite if vendor isn't set up yet ───
      //
      // The nightly cron covers vendors created in the last 2 days, but misses
      // same-day dispatches and vendors added more than 2 days ago. This step
      // bridges that gap by triggering the invite immediately when a work order
      // is dispatched.
      //
      // Idempotency: stripe_connect_invite_sent_at is the dedup guard.
      // If the cron or a prior dispatch already sent the invite, this is a no-op.
      if (dispatchResult.dispatched && event.data.vendor_id) {
        await step.run('trigger-vendor-stripe-onboarding', async () => {
          const supabase = createServiceClient()

          const { data: vendor, error: vendorErr } = await supabase
            .from('vendors')
            .select('id, name, email, org_id, stripe_connect_token, stripe_connect_account_id, stripe_connect_invite_sent_at')
            .eq('id', event.data.vendor_id!)
            .eq('org_id', org_id)
            .single()

          if (vendorErr || !vendor) {
            logger.warn(
              `[WO created] Could not fetch vendor ${event.data.vendor_id} for Stripe onboarding check`
            )
            return { skipped: true, reason: 'vendor_not_found' }
          }

          // Dedup guard — cron or prior dispatch already handled this vendor
          if (vendor.stripe_connect_invite_sent_at || vendor.stripe_connect_account_id) {
            return { skipped: true, reason: 'already_invited_or_onboarded' }
          }

          // Vendor must have an email to receive the invite
          if (!vendor.email) {
            return { skipped: true, reason: 'vendor_has_no_email' }
          }

          // Vendor must have a stripe_connect_token to build the onboard URL
          if (!vendor.stripe_connect_token) {
            logger.warn(
              `[WO created] Vendor ${vendor.id} has no stripe_connect_token — cannot build onboard URL`
            )
            return { skipped: true, reason: 'vendor_missing_connect_token' }
          }

          // Get PM name and org name for contextual email copy
          let pmName:  string | null = null
          let orgName: string        = 'Your property manager'

          const [membersResult, orgResult] = await Promise.all([
            supabase
              .from('organization_members')
              .select('user_id')
              .eq('org_id', org_id)
              .in('role', ['owner', 'admin'])
              .not('invite_accepted_at', 'is', null)
              .limit(1),
            supabase
              .from('organizations')
              .select('name')
              .eq('id', org_id)
              .single(),
          ])

          if (orgResult.data?.name) orgName = orgResult.data.name

          if (membersResult.data?.[0]?.user_id) {
            const { data: profile } = await supabase
              .from('profiles')
              .select('full_name')
              .eq('id', membersResult.data[0].user_id)
              .single()
            if (profile?.full_name) pmName = profile.full_name
          }

          // Create a Stripe Express account if the vendor doesn't have one yet.
          // Idempotency key prevents duplicate accounts on step retry.
          let accountId = vendor.stripe_connect_account_id
          if (!accountId) {
            const account = await stripe.accounts.create(
              {
                type:  'express',
                email: vendor.email,
                metadata: {
                  vendor_id: vendor.id,
                  org_id:    vendor.org_id,
                },
                capabilities: {
                  card_payments: { requested: true },
                  transfers:     { requested: true },
                },
              },
              { idempotencyKey: `vendor-connect-create-${vendor.id}` }
            )
            accountId = account.id
          }

          const appUrl        = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
          const onboardingUrl = `${appUrl}/api/vendor-connect/${vendor.stripe_connect_token}/onboard`
          const woNumber      = dispatchResult.dispatched ? (dispatchResult.woNumber ?? null) : null

          // Send the invite email
          const { error: emailErr } = await resend.emails.send(
            {
              from:    FROM,
              to:      vendor.email,
              replyTo: 'support@fieldstay.app',
              subject: `${orgName} uses FieldStay — set up your payment account`,
              html:    await renderVendorConnectInviteEmail({
                vendorName:    vendor.name,
                orgName,
                pmName,
                woNumber,
                onboardingUrl,
              }),
            },
            { idempotencyKey: `vendor-connect-invite-wo-${event.data.vendor_id}` }
          )

          if (emailErr) {
            // Log and return — don't throw. A Resend error here must not retry
            // the entire step and risk creating duplicate Stripe accounts.
            logger.error(
              `[WO created] Stripe Connect invite email failed for vendor ${vendor.id}: ` +
              JSON.stringify(emailErr)
            )
            return { skipped: true, reason: 'email_send_failed' }
          }

          // Persist the Stripe account ID and sent timestamp.
          // Two fields in one update — atomic. If this update fails and the step
          // retries, the idempotency key on stripe.accounts.create prevents a
          // duplicate account, and the email idempotency key prevents a duplicate send.
          const { error: updateErr } = await supabase
            .from('vendors')
            .update({
              stripe_connect_account_id:    accountId,
              stripe_connect_invite_sent_at: new Date().toISOString(),
            })
            .eq('id',     vendor.id)
            .eq('org_id', vendor.org_id)   // explicit tenant scope even with service role

          if (updateErr) {
            logger.error(
              `[WO created] Failed to update vendor ${vendor.id} with Stripe account ID: ` +
              updateErr.message
            )
            // Do not throw — email was sent successfully. The cron will see
            // stripe_connect_invite_sent_at is still null and may re-send, but
            // the Resend idempotency key will dedup that send.
          }

          logger.info(
            `[WO created] Stripe Connect invite sent to vendor ${vendor.id} — ` +
            `account: ${accountId}`
          )

          return { sent: true, vendorId: vendor.id, accountId }
        })
      }
    }

    // ── Overdue check (unchanged from original) ────────────────────────────
    if (event.data.vendor_id) {
      const scheduledDate = await step.run('fetch-scheduled-date', async () => {
        const supabase = createServiceClient()
        const { data: wo } = await supabase
          .from('work_orders')
          .select('scheduled_date')
          .eq('id', work_order_id)
          .single()
        return wo?.scheduled_date ?? null
      })

      if (scheduledDate) {
        // Don't check overdue status until 3 days past the scheduled date —
        // sending the event immediately produced a "3 days overdue" alert
        // within minutes of WO creation.
        const overdueCheckDate = new Date(scheduledDate)
        overdueCheckDate.setDate(overdueCheckDate.getDate() + 3)

        await step.sleepUntil('wait-until-overdue-threshold', overdueCheckDate)

        const stillOpen = await step.run('check-still-open-before-overdue-event', async () => {
          const supabase = createServiceClient()
          const { data: wo } = await supabase
            .from('work_orders')
            .select('status')
            .eq('id', work_order_id)
            .single()
          return wo ? wo.status !== 'completed' && wo.status !== 'cancelled' : false
        })

        if (stillOpen) {
          await step.sendEvent('schedule-overdue-check', {
            name: 'work-order/overdue' as const,
            data: {
              work_order_id,
              property_id,
              org_id,
              scheduled_date: scheduledDate,
              days_overdue:   3,
            },
          })
        }
      }
    }

    return { work_order_id }
  }
)

// ── Work Order Completed (PM-side) ───────────────────────────────────────────

export const handleWorkOrderCompleted = inngest.createFunction(
  { id: 'work-order-completed', name: 'Work Order Completed — Post Expense', retries: 3 },
  { event: 'work-order/completed' as const },
  async ({ event, step }) => {
    const { work_order_id, property_id, org_id } = event.data

    await step.run('post-wo-expense', async () => {
      const supabase = createServiceClient()

      const { data: wo } = await supabase
        .from('work_orders')
        .select('title, actual_cost, estimated_cost')
        .eq('id', work_order_id)
        .single()

      // Only post once the real cost is known — estimated_cost is a placeholder
      // and would be permanently locked in by the ignoreDuplicates upsert below.
      // logActualCost() posts/corrects the expense once actual_cost is logged.
      const cost = wo?.actual_cost ?? null
      if (!cost || cost <= 0) return { skipped: true }

      const { data: txn } = await supabase.from('owner_transactions').upsert({
        property_id,
        org_id,
        work_order_id,
        source:               'wo_completion',
        source_reference_id:  work_order_id,
        transaction_type:     'expense',
        category:             'maintenance',
        amount:               cost,
        description:          wo?.title ?? 'Work order expense',
        transaction_date:     new Date().toISOString().split('T')[0],
        visible_to_owner:     false,
      }, { onConflict: 'source_reference_id,source', ignoreDuplicates: true }).select('id').maybeSingle()

      if (txn) {
        await logAuditEvent({
          orgId:      org_id,
          action:     'owner.transaction.created',
          targetType: 'owner_transaction',
          targetId:   txn.id,
          metadata:   { source: 'work_order_completion', work_order_id },
        })
      }

      return { posted: cost }
    })

    return { work_order_id }
  }
)

// ── Work Order Completed via Portal ──────────────────────────────────────────

export const handleWorkOrderCompletedViaPortal = inngest.createFunction(
  {
    id:      'work-order-completed-via-portal',
    name:    'Work Order Completed via Vendor Portal',
    retries: 2,
  },
  { event: 'work-order/completed-via-portal' as const },
  async ({ event, step, logger }) => {
    const { work_order_id } = event.data

    await step.run('notify-pm-of-completion', async () => {
      const supabase = createServiceClient()

      const { data: wo } = await supabase
        .from('work_orders')
        .select(`
          id, title, completion_notes, actual_cost, org_id,
          vendors ( name ),
          properties ( id, name ),
          work_order_photos ( storage_path )
        `)
        .eq('id', work_order_id)
        .single()

      if (!wo) return

      const pmEmail = await getPmEmail(supabase, wo.org_id)
      if (!pmEmail) {
        logger.warn(`No PM email for org_id=${wo.org_id} work_order_id=${work_order_id} event=work-order/completed-via-portal — skipping notification`)
        return
      }

      const vendor   = Array.isArray(wo.vendors)   ? wo.vendors[0]   : wo.vendors
      const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties
      const photos   = Array.isArray(wo.work_order_photos) ? wo.work_order_photos : []

      // Expense posting is owned by handleWorkOrderCompleted / logActualCost —
      // posting here too would race on (source_reference_id, source) and could
      // lock in whichever amount lands first via ignoreDuplicates.

      const photoNote = photos.length > 0
        ? `${photos.length} photo${photos.length !== 1 ? 's' : ''} attached to the work order.`
        : undefined

      await resend.emails.send(
        {
          from:    FROM,
          to:      pmEmail,
          subject: `✅ Work order complete — ${wo.title} at ${property?.name}`,
          html: await renderPmAlert({
            heading:  'Work order marked complete',
            body:     `${vendor?.name ?? 'Your vendor'} has completed: ${wo.title}.`,
            details: [
              { label: 'Property', value: property?.name ?? null },
              { label: 'Notes',    value: wo.completion_notes ?? null },
            ],
            note:     photoNote,
            ctaLabel: 'View Work Order →',
            ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/maintenance?wo=${work_order_id}`,
          }),
        },
        { idempotencyKey: `wo-completed-via-portal-${work_order_id}` }
      )
    })

    return { work_order_id, notified: true }
  }
)

// ── Work Order Overdue ────────────────────────────────────────────────────────

export const handleWorkOrderOverdue = inngest.createFunction(
  {
    id:      'work-order-overdue',
    name:    'Work Order Overdue Alert',
    retries: 1,
  },
  { event: 'work-order/overdue' as const },
  async ({ event, step, logger }) => {
    const { work_order_id, org_id, days_overdue } = event.data

    await step.run('check-and-alert', async () => {
      const supabase = createServiceClient()

      const { data: wo } = await supabase
        .from('work_orders')
        .select('id, title, status, scheduled_date, vendors(name), properties(name)')
        .eq('id', work_order_id)
        .eq('org_id', org_id)
        .single()

      if (!wo || wo.status === 'completed' || wo.status === 'cancelled') return

      const pmEmail = await getPmEmail(supabase, org_id)
      if (!pmEmail) {
        logger.warn(`No PM email for org_id=${org_id} work_order_id=${work_order_id} event=work-order/overdue — skipping alert`)
        return
      }

      const vendor   = Array.isArray(wo.vendors)   ? wo.vendors[0]   : wo.vendors
      const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties

      await resend.emails.send(
        {
          from:    FROM,
          to:      pmEmail,
          subject: `⚠️ Work order overdue — ${wo.title} at ${property?.name}`,
          html: await renderPmAlert({
            heading:  `Work order ${days_overdue} day${days_overdue !== 1 ? 's' : ''} overdue`,
            body:     `${wo.title} was scheduled for ${new Date(wo.scheduled_date!).toLocaleDateString()} and hasn't been completed.`,
            details: [
              { label: 'Assigned To', value: vendor?.name ?? null },
            ],
            ctaLabel: 'Review Work Orders →',
            ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
          }),
        },
        { idempotencyKey: `wo-overdue-${work_order_id}` }
      )
    })

    return { work_order_id, alerted: true }
  }
)

// ── Quote Requested ───────────────────────────────────────────────────────────

export const handleWorkOrderQuoteRequested = inngest.createFunction(
  {
    id:      'work-order-quote-requested',
    name:    'Work Order Quote Requested',
    retries: 2,
  },
  { event: 'work-order/quote-requested' as const },
  async ({ event, step, logger }) => {
    const { work_order_id, quote_request_id } = event.data

    await step.run('send-vendor-quote-request', async () => {
      const supabase = createServiceClient()

      const { data: qr } = await supabase
        .from('quote_requests')
        .select(`
          id, quote_token, status,
          work_orders (
            id, title, description, wo_number, category, priority,
            scheduled_date, estimated_cost, nte_amount,
            properties (name, address, city, state, zip)
          ),
          vendors (name, email)
        `)
        .eq('id', quote_request_id)
        .single()

      if (!qr?.quote_token) return

      const wo       = Array.isArray(qr.work_orders) ? qr.work_orders[0] : qr.work_orders
      const vendor   = Array.isArray(qr.vendors)     ? qr.vendors[0]     : qr.vendors
      const property = wo && (Array.isArray(wo.properties) ? wo.properties[0] : wo.properties)

      if (!vendor?.email) {
        logger.warn(`Quote request ${quote_request_id}: vendor has no email`)
        return
      }

      const quoteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/work-orders/${qr.quote_token}/quote`

      const html = await renderWorkOrderEmail({
        vendorName:    vendor.name,
        jobTitle:      wo?.title ?? '',
        description:   wo?.description ?? undefined,
        scheduledDate: wo?.scheduled_date
          ? new Date(wo.scheduled_date).toLocaleDateString('en-US', {
              month: 'long', day: 'numeric', year: 'numeric',
            })
          : undefined,
        propertyName:  property?.name ?? '',
        propertyCity:  property?.city ?? undefined,
        propertyState: property?.state ?? undefined,
        portalUrl:     quoteUrl,
      })

      await resend.emails.send(
        {
          from:    FROM,
          to:      vendor.email,
          subject: `Quote request: ${wo?.title} — ${property?.name}`,
          html,
        },
        { idempotencyKey: `wo-quote-requested-${quote_request_id}` }
      )

      logger.info(`Sent quote request to ${vendor.email} for WO ${work_order_id}`)
    })

    return { work_order_id }
  }
)

// ── Quote Submitted ───────────────────────────────────────────────────────────

export const handleWorkOrderQuoteSubmitted = inngest.createFunction(
  {
    id:      'work-order-quote-submitted',
    name:    'Work Order Quote Submitted',
    retries: 2,
  },
  { event: 'work-order/quote-submitted' as const },
  async ({ event, step, logger }) => {
    const { work_order_id, quote_request_id, org_id, quoted_amount, quote_notes } = event.data

    await step.run('notify-pm-of-quote', async () => {
      const supabase = createServiceClient()

      const { data: wo } = await supabase
        .from('work_orders')
        .select('id, title, vendors ( name ), properties ( name )')
        .eq('id', work_order_id)
        .eq('org_id', org_id)
        .single()

      if (!wo) return

      const vendor   = Array.isArray(wo.vendors)   ? wo.vendors[0]   : wo.vendors
      const property = Array.isArray(wo.properties) ? wo.properties[0] : wo.properties

      const pmEmail = await getPmEmail(supabase, org_id)
      if (!pmEmail) {
        logger.warn(`No PM email for org_id=${org_id} work_order_id=${work_order_id} event=work-order/quote-submitted — skipping notification`)
        return
      }

      await resend.emails.send(
        {
          from:    FROM,
          to:      pmEmail,
          subject: `💬 Quote received — ${wo.title} at ${property?.name}`,
          html: await renderPmAlert({
            heading:  'Quote received',
            body:     `${vendor?.name ?? 'Your vendor'} has submitted a quote for ${wo.title}.`,
            details: [
              { label: 'Property',      value: property?.name ?? null },
              { label: 'Quoted Amount', value: `$${quoted_amount.toFixed(2)}` },
              { label: 'Vendor Notes',  value: quote_notes ?? null },
            ],
            ctaLabel: 'Review Quote →',
            ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
          }),
        },
        { idempotencyKey: `wo-quote-submitted-${quote_request_id}` }
      )
    })

    return { work_order_id, notified: true }
  }
)
