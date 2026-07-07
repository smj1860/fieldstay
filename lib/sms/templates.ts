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

import { createServiceClient } from '@/lib/supabase/server'
import {
  buildDoorCodeSMS,
  buildMorningNudgeSMS,
  buildEveningNudgeSMS,
  buildRainAlertSMS,
  buildVendorWorkOrderSMS,
  buildCrewInviteSMS,
  buildCrewTurnoverAssignedSMS,
} from '@/lib/sms/telnyx'
import {
  renderTemplate,
  SMS_TEMPLATE_REGISTRY,
  type SmsTemplateKey,
} from '@/lib/sms/template-registry'

export {
  renderTemplate,
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
 * Always uses createServiceClient() — call only from Inngest steps or
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
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('org_sms_templates')
    .select('body')
    .eq('org_id', orgId)
    .eq('key', key)
    .maybeSingle()

  // Custom template found — render and return
  if (data?.body) return renderTemplate(data.body, vars)

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

    case 'evening_nudge':
      return buildEveningNudgeSMS(
        String(vars.property_name ?? ''),
        vars.offer_line ? String(vars.offer_line) : null
      )

    case 'rain_alert':
      return buildRainAlertSMS(String(vars.property_name ?? ''))

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

    default: {
      const _exhaustive: never = key
      throw new Error(`Unhandled SMS template key: ${_exhaustive}`)
    }
  }
}
