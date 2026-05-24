import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { formatDateTime } from '@/lib/utils'

/**
 * Triggered when a new turnover is created (from iCal sync or manual).
 *
 * Steps:
 *  1. Fetch turnover + property details
 *  2. (Future) Auto-assign if default crew set
 *  3. Sleep until 24 hours before checkout
 *  4. If still unassigned, send urgent warning to PM
 */
export const handleTurnoverCreated = inngest.createFunction(
  {
    id:      'turnover-created',
    name:    'Handle New Turnover',
    retries: 2,
  },
  { event: 'turnover/created' as const },
  async ({ event, step, logger }) => {
    const { turnover_id, property_id, org_id, checkout_datetime } = event.data

    // ── Fetch turnover data ──────────────────────────────────────────────────

    const { turnover, property, pmEmail } = await step.run('fetch-turnover-data', async () => {
      const supabase = createServiceClient()

      const [{ data: turnover }, { data: property }, { data: adminMember }] = await Promise.all([
        supabase
          .from('turnovers')
          .select(`
            id, checkout_datetime, checkin_datetime, window_minutes, status, priority,
            turnover_assignments ( crew_member_id, crew_members ( name, email, phone, preferred_contact ) )
          `)
          .eq('id', turnover_id)
          .single(),
        supabase
          .from('properties')
          .select('name, city, state')
          .eq('id', property_id)
          .single(),
        supabase
          .from('organization_members')
          .select('user_id')
          .eq('org_id', org_id)
          .eq('role', 'admin')
          .single(),
      ])

      let pmEmail: string | null = null
      if (adminMember?.user_id) {
        const { data: { user } } = await supabase.auth.admin.getUserById(adminMember.user_id)
        pmEmail = user?.email ?? null
      }

      return { turnover, property, pmEmail }
    })

    if (!turnover || !property) return

    const checkoutDT    = new Date(checkout_datetime)
    const windowHours   = Math.round((turnover.window_minutes ?? 0) / 60)
    const isUrgent      = turnover.priority === 'urgent' || turnover.priority === 'high'

    // ── Notify already-assigned crew (if any) ───────────────────────────────

    const assignments = Array.isArray(turnover.turnover_assignments)
      ? turnover.turnover_assignments
      : turnover.turnover_assignments
        ? [turnover.turnover_assignments]
        : []

    if (assignments.length > 0) {
      await step.run('notify-assigned-crew', async () => {
        for (const assignment of assignments) {
          const crew = Array.isArray(assignment.crew_members)
            ? assignment.crew_members[0]
            : assignment.crew_members

          if (!crew?.email) continue

          await resend.emails.send({
            from:    FROM,
            to:      crew.email,
            subject: `Turnover assigned — ${property.name} on ${checkoutDT.toLocaleDateString()}`,
            html: `
              <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
                <h2>You've been assigned a turnover</h2>
                <p><strong>Property:</strong> ${property.name}</p>
                <p><strong>Checkout:</strong> ${formatDateTime(turnover.checkout_datetime)}</p>
                <p><strong>Next Check-in:</strong> ${formatDateTime(turnover.checkin_datetime)}</p>
                <p><strong>Window:</strong> ${windowHours}h ${(turnover.window_minutes ?? 0) % 60}m</p>
                <p><strong>Priority:</strong> ${turnover.priority.toUpperCase()}</p>
              </div>
            `,
          })
        }
      })

      // Crew is assigned — schedule completion check, then done
      return { turnover_id, crewNotified: assignments.length }
    }

    // ── No crew assigned — schedule 24h warning ──────────────────────────────

    // Warn 24 hours before checkout (or immediately if urgent)
    const warnAt = new Date(checkoutDT)
    warnAt.setHours(warnAt.getHours() - (isUrgent ? 4 : 24))

    await step.sleepUntil('wait-for-assignment-deadline', warnAt)

    // Re-check assignment status
    const stillUnassigned = await step.run('check-assignment-status', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('turnovers')
        .select('status, turnover_assignments(id)')
        .eq('id', turnover_id)
        .single()

      const assigned = Array.isArray(data?.turnover_assignments)
        ? data.turnover_assignments.length > 0
        : !!data?.turnover_assignments

      return data?.status !== 'cancelled' && !assigned
    })

    if (stillUnassigned && pmEmail) {
      await step.run('send-unassigned-warning', async () => {
        const hoursUntil = Math.round(
          (checkoutDT.getTime() - Date.now()) / 3_600_000
        )

        await resend.emails.send({
          from:    FROM,
          to:      pmEmail!,
          subject: `⚠️ Turnover needs crew — ${property.name} in ${hoursUntil}h`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
              <h2 style="color:#b45309">Turnover needs crew assigned</h2>
              <p>
                <strong>${property.name}</strong> has a turnover in 
                <strong>${hoursUntil} hours</strong> with no crew assigned.
              </p>
              <table style="border-collapse:collapse;width:100%;margin:16px 0">
                <tr><td style="padding:8px;color:#64748b">Checkout</td><td style="padding:8px;font-weight:600">${formatDateTime(turnover.checkout_datetime)}</td></tr>
                <tr><td style="padding:8px;color:#64748b">Check-in</td><td style="padding:8px;font-weight:600">${formatDateTime(turnover.checkin_datetime)}</td></tr>
                <tr><td style="padding:8px;color:#64748b">Window</td><td style="padding:8px;font-weight:600">${windowHours}h ${(turnover.window_minutes ?? 0) % 60}m</td></tr>
                <tr><td style="padding:8px;color:#64748b">Priority</td><td style="padding:8px;font-weight:600;color:#b45309">${turnover.priority.toUpperCase()}</td></tr>
              </table>
              <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/turnovers" style="background:#093b31;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block">Assign Crew →</a></p>
            </div>
          `,
        })
      })
    }

    return { turnover_id, warned: stillUnassigned }
  }
)

/**
 * Triggered when a turnover is marked complete by crew.
 * Sends a brief "turnover complete" notification to the PM.
 */
export const handleTurnoverCompleted = inngest.createFunction(
  {
    id:      'turnover-completed',
    name:    'Handle Turnover Completed',
    retries: 2,
  },
  { event: 'turnover/completed' as const },
  async ({ event, step }) => {
    const { turnover_id, property_id, org_id } = event.data

    await step.run('notify-pm-of-completion', async () => {
      const supabase = createServiceClient()

      const [{ data: property }, { data: adminMember }] = await Promise.all([
        supabase.from('properties').select('name').eq('id', property_id).single(),
        supabase.from('organization_members').select('user_id').eq('org_id', org_id).eq('role', 'admin').single(),
      ])

      if (!adminMember?.user_id) return

      const { data: { user } } = await supabase.auth.admin.getUserById(adminMember.user_id)
      if (!user?.email) return

      await resend.emails.send({
        from:    FROM,
        to:      user.email,
        subject: `✅ Turnover complete — ${property?.name}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <h2 style="color:#15803d">Turnover marked complete</h2>
            <p><strong>${property?.name}</strong> is ready for guests.</p>
            <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/turnovers/${turnover_id}" style="color:#093b31">View turnover →</a></p>
          </div>
        `,
      })
    })

    return { turnover_id, notified: true }
  }
)
