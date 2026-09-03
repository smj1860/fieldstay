/**
 * lib/sms/templates.ts
 *
 * Server-only SMS template rendering.
 * - renderSmsBody — fetches org override → falls back to default → renders
 *
 * The client-safe schema (SMS_TEMPLATE_REGISTRY, renderTemplate, types) lives
 * in lib/sms/template-registry.ts — this file re-exports them for existing
 * importers, but never import THIS file from a client component: it pulls in
 * createServiceClient (next/headers), which Turbopack can't bundle for the
 * client.
 */

import { tryUnwrap } from '@/lib/supabase/unwrap'
import { createServiceClient } from '@/lib/supabase/server'
import {
  buildDoorCodeSMS,
  buildMorningNudgeSMS,
  buildEveningNudgeSMS,
  buildRainAlertSMS,
  buildTomorrowOutdoorSMS,
  buildVendorWorkOrderSMS,
  buildCrewInviteSMS,
  buildCrewTurnoverAssignedSMS,
} from '@/lib/sms/telnyx'
import {
  renderTemplate,
  withOptOutNotice,
  type SmsTemplateKey,
} from '@/lib/sms/template-registry'

export {
  renderTemplate,
  hasOptOutNotice,
  withOptOutNotice,
  SMS_OPT_OUT_NOTICE,
  SMS_TEMPLATE_REGISTRY,
  type SmsTemplateKey,
  type SmsTemplateVariable,
  type SmsTemplateConfig,
} from '@/lib/sms/template-registry'

// ── renderSmsBody — main entry point for all Inngest SMS sends ────────────────

/**
 * Fetches the org's custom template for `key` (if any) and renders it with
 * `vars`. Falls back to the hardcoded default builder if no custom template exists.
 *
 * Always uses createServiceClient({ system: 'lib/sms/templates' }) — call only from Inngest steps or
 * server-side code where the service role key is available.
 */
export interface CrewTurnoverAssignmentData {
  propertyName:     string
  checkoutDatetime: string
  windowMinutes:    number
}

export async function renderSmsBody(
  orgId: string,
  key:   SmsTemplateKey,
  vars:  Record<string, string | number | null | undefined>,
  // Structured data for the 'crew_turnover_assigned' default-renderer fallback
  // only — the legacy builder needs the raw turnover list (not the flattened
  // {{assignments}} string) to preserve its pluralisation logic.
  turnoverData?: CrewTurnoverAssignmentData[]
): Promise<string> {
  const supabase = createServiceClient({ system: 'lib/sms/templates' })

  // Degrade, don't throw: falling back to the built-in copy is the right
  // behaviour for a missing custom template, and an SMS should still go out
  // if this lookup fails. tryUnwrap still logs and reports.
  const templateRes = await supabase
    .from('org_sms_templates')
    .select('body')
    .eq('org_id', orgId)
    .eq('key', key)
    .maybeSingle()

  const templateOut = tryUnwrap(templateRes, { site: 'lib.sms.templates', orgId })
  const data = templateOut.ok ? templateOut.data : null

  // Custom template found — render and return.
  //
  // withOptOutNotice is the backstop, not decoration. An org override REPLACES
  // the default body wholesale, and every one of the built-in defaults ends
  // with "Reply STOP to opt out." — so before this, saving a custom template
  // that omitted it silently stripped the opt-out instruction from every SMS
  // that org sent, guest and crew alike, for as long as the override existed.
  // Nothing downstream re-added it: sendSMS passes the body straight to Telnyx.
  //
  // saveOrgSmsTemplate now rejects a body with no opt-out keyword, but that
  // guard only covers rows written through that action. This one covers rows
  // written by any path, including any saved before the rule existed.
  if (data?.body) return withOptOutNotice(renderTemplate(data.body, vars))

  // Fall back to hardcoded defaults — keeps the existing builder logic
  return renderDefault(key, vars, turnoverData)
}

// ── Default renderer — delegates back to telnyx.ts builders ──────────────────

function renderDefault(
  key:  SmsTemplateKey,
  vars: Record<string, string | number | null | undefined>,
  turnoverData?: CrewTurnoverAssignmentData[]
): string {
  switch (key) {
    case 'door_code':
      return buildDoorCodeSMS(
        String(vars.property_name ?? ''),
        String(vars.door_code     ?? ''),
        String(vars.portal_url    ?? '')
      )

    case 'morning_nudge':
      return buildMorningNudgeSMS(
        String(vars.property_name ?? ''),
        Number(vars.temperature   ?? 72),
        vars.offer_line ? String(vars.offer_line) : null
      )

    case 'arrival_reminder':
      // Inline rather than a telnyx.ts builder: there is no legacy builder to
      // preserve, and checkin_line is already assembled (or omitted) by the
      // caller so a property with no check-in time still reads correctly.
      return [
        `Looking forward to hosting you at ${vars.property_name ?? 'your rental'} today!`,
        vars.checkin_line ? String(vars.checkin_line) : '',
        'Reply STOP to opt out.',
      ].filter(Boolean).join(' ')

    case 'evening_nudge':
      return buildEveningNudgeSMS(
        String(vars.property_name ?? ''),
        vars.offer_line ? String(vars.offer_line) : null
      )

    case 'rain_alert':
      return buildRainAlertSMS(
        String(vars.property_name ?? ''),
        vars.offer_line ? String(vars.offer_line) : null
      )

    case 'tomorrow_outdoor':
      return buildTomorrowOutdoorSMS(
        String(vars.property_name ?? ''),
        vars.offer_line ? String(vars.offer_line) : null
      )

    case 'stay_extension':
      return [
        `Enjoying ${vars.property_name ?? 'your stay'}?`,
        `There's availability after your checkout on ${vars.checkout_date ?? ''}.${vars.discount_line ?? ''}`,
        `Check availability here: ${vars.portal_url ?? ''}`,
        `Reply STOP to opt out.`,
      ].join(' ')

    case 'vendor_work_order':
      return buildVendorWorkOrderSMS({
        vendorName:   String(vars.vendor_name   ?? ''),
        woNumber:     String(vars.wo_number     ?? ''),
        propertyName: String(vars.property_name ?? ''),
        pmName:       String(vars.pm_name       ?? ''),
        orgName:      String(vars.org_name      ?? ''),
        nteAmount:    Number(vars.nte_amount     ?? 0),
        portalUrl:    String(vars.portal_url    ?? ''),
        window:       vars.window ? String(vars.window) : undefined,
      })

    case 'crew_invite':
      return buildCrewInviteSMS({
        crewName:  String(vars.crew_name  ?? ''),
        orgName:   String(vars.org_name   ?? ''),
        inviteUrl: String(vars.invite_url ?? ''),
      })

    case 'crew_turnover_assigned': {
      // Legacy builder expects the turnovers array — but the registry
      // flattens this to {{assignments}}. Build the legacy call when using
      // default, render the template when custom.
      // Here we're in the default path, so delegate to the builder.
      if (turnoverData) {
        return buildCrewTurnoverAssignedSMS({
          orgName:   String(vars.org_name ?? ''),
          turnovers: turnoverData,
        })
      }
      // Fallback if called without structured turnovers (shouldn't happen)
      return [
        `${vars.org_name ?? 'Your property manager'}: New turnover assignment(s) 📋`,
        String(vars.assignments ?? ''),
        '',
        'Open your crew app for details & checklist.',
        '',
        'Reply STOP to opt out.',
      ].join('\n')
    }

    case 'crew_turnover_cancelled':
      return [
        `${vars.org_name ?? 'Your property manager'}: A cancelled booking removed ${vars.count ?? '1'} of your assigned turnover(s).`,
        'No need to go.',
        '',
        'Reply STOP to opt out.',
      ].join('\n')

    default: {
      const _exhaustive: never = key
      throw new Error(`Unhandled SMS template key: ${_exhaustive}`)
    }
  }
}
