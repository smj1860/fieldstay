/**
 * lib/sms/template-registry.ts
 *
 * Client-safe SMS template schema and renderer — no server-only imports.
 * Split out of lib/sms/templates.ts so client components (e.g. the Settings
 * SMS Templates tab) can read the registry without pulling in
 * createServiceClient/next-headers through that file's server-only
 * renderSmsBody().
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SmsTemplateKey =
  | 'door_code'
  | 'morning_nudge'
  | 'evening_nudge'
  | 'rain_alert'
  | 'stay_extension'
  | 'vendor_work_order'
  | 'crew_invite'
  | 'crew_turnover_assigned'

export interface SmsTemplateVariable {
  token:       string   // e.g. "{{property_name}}"
  description: string
  example:     string   // used in live preview
}

export interface SmsTemplateConfig {
  key:         SmsTemplateKey
  label:       string
  description: string
  audience:    'guest' | 'crew' | 'vendor'
  variables:   SmsTemplateVariable[]
  defaultBody: string
}

// ── Token renderer ────────────────────────────────────────────────────────────

/**
 * Replaces {{token}} placeholders in a template string.
 * Missing tokens are replaced with an empty string (never throw).
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number | null | undefined>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = vars[key]
    return val !== null && val !== undefined ? String(val) : ''
  })
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const SMS_TEMPLATE_REGISTRY: SmsTemplateConfig[] = [
  {
    key:         'door_code',
    label:       'Door Code — Guest Check-In',
    description: 'Sent immediately when a guest opts into guidebook SMS. Delivers their door code and guidebook link.',
    audience:    'guest',
    variables: [
      { token: '{{property_name}}', description: 'Property name',                  example: 'Lakeside Lodge' },
      { token: '{{door_code}}',     description: 'Entry door code',                 example: '4829' },
      { token: '{{portal_url}}',    description: 'Personalized guidebook link',     example: 'https://app.fieldstay.app/g/b/abc123' },
    ],
    defaultBody: [
      '{{property_name}} — you\'re all set. 🏡',
      '',
      'Door code: {{door_code}}',
      '',
      'WiFi password + your local guide:',
      '{{portal_url}}',
      '',
      'Reply STOP to opt out.',
    ].join('\n'),
  },
  {
    key:         'morning_nudge',
    label:       'Morning Nudge — Guest Stay',
    description: 'Sent each morning guests are in their stay (7–11 AM). Includes today\'s temperature and an optional sponsor offer.',
    audience:    'guest',
    variables: [
      { token: '{{property_name}}', description: 'Property name',           example: 'Lakeside Lodge' },
      { token: '{{temperature}}',   description: 'Current temp in °F',      example: '72' },
      { token: '{{offer_line}}',    description: 'Sponsor line — always names the active sponsor; includes their offer or custom message plus distance when available', example: 'Sunrise Coffee has 20% off — just show this screen (0.4 mi away)' },
    ],
    defaultBody: 'Good morning! It\'s {{temperature}}°F at {{property_name}} today. {{offer_line}} Reply STOP to opt out.',
  },
  {
    key:         'evening_nudge',
    label:       'Evening Nudge — Guest Stay',
    description: 'Sent each evening guests are in their stay (5–9 PM). Includes an optional sponsor offer.',
    audience:    'guest',
    variables: [
      { token: '{{property_name}}', description: 'Property name',                example: 'Lakeside Lodge' },
      { token: '{{offer_line}}',    description: 'Sponsor line — always names the active sponsor; includes their offer or custom message plus distance when available', example: 'River Bistro has free dessert — just show this screen (0.8 mi away)' },
    ],
    defaultBody: 'Hope you\'re enjoying your stay at {{property_name}}! {{offer_line}} Reply STOP to opt out.',
  },
  {
    key:         'rain_alert',
    label:       'Rain Alert — Guest Stay',
    description: 'Replaces the morning or evening nudge when precipitation probability is ≥60% and a rainy-day sponsor is configured.',
    audience:    'guest',
    variables: [
      { token: '{{property_name}}', description: 'Property name', example: 'Lakeside Lodge' },
      { token: '{{offer_line}}',    description: 'Sponsor line — always names the active rainy-day sponsor; includes their offer or custom message plus distance when available', example: 'Cozy Books Café has 15% off — just show this screen (0.3 mi away)' },
    ],
    defaultBody: 'Heads up — rain expected near {{property_name}} today. {{offer_line}} Reply STOP to opt out.',
  },
  {
    key:         'stay_extension',
    label:       'Stay Extension Offer — Guest',
    description: 'Sent when there is availability after a guest\'s checkout and a stay extension opportunity is detected.',
    audience:    'guest',
    variables: [
      { token: '{{property_name}}',  description: 'Property name',              example: 'Lakeside Lodge' },
      { token: '{{checkout_date}}',  description: 'Guest\'s current checkout date', example: '2026-07-12' },
      { token: '{{portal_url}}',     description: 'Link to guidebook / extension page', example: 'https://app.fieldstay.app/g/b/abc123' },
      { token: '{{discount_line}}',  description: 'Discount offer text (may be empty)', example: ' We\'re offering 15% off to extend your stay.' },
    ],
    defaultBody: [
      'Enjoying {{property_name}}?',
      'There\'s availability after your checkout on {{checkout_date}}.{{discount_line}}',
      'Check availability here: {{portal_url}}',
      'Reply STOP to opt out.',
    ].join(' '),
  },
  {
    key:         'vendor_work_order',
    label:       'Work Order — Vendor Notification',
    description: 'Sent to a vendor when they are assigned to a work order.',
    audience:    'vendor',
    variables: [
      { token: '{{pm_name}}',        description: 'Property manager\'s name',   example: 'Sarah Johnson' },
      { token: '{{org_name}}',       description: 'Organization name',           example: 'Summit Property Management' },
      { token: '{{wo_number}}',      description: 'Work order number',           example: 'WO-0042' },
      { token: '{{property_name}}',  description: 'Property name',              example: 'Lakeside Lodge' },
      { token: '{{nte_line}}',       description: 'NTE amount line (may be empty)', example: '\nNTE: $500' },
      { token: '{{window_line}}',    description: 'Scheduling window (may be empty)', example: '\nAvailable window: 11:00 AM – 3:00 PM CDT' },
      { token: '{{portal_url}}',     description: 'Vendor portal link',          example: 'https://app.fieldstay.app/w/abc123' },
    ],
    defaultBody: [
      'New work order from {{pm_name}} at {{org_name}}:',
      '{{wo_number}} — {{property_name}}{{nte_line}}{{window_line}}',
      '',
      'Review & sign off:',
      '{{portal_url}}',
      '',
      'Reply STOP to opt out.',
    ].join('\n'),
  },
  {
    key:         'crew_invite',
    label:       'Crew Invite',
    description: 'Sent when a crew member is invited to join the organization\'s FieldStay crew.',
    audience:    'crew',
    variables: [
      { token: '{{org_name}}',   description: 'Organization name',  example: 'Summit Property Management' },
      { token: '{{crew_name}}',  description: 'Crew member\'s name', example: 'Alex Rivera' },
      { token: '{{invite_url}}', description: 'Onboarding link',    example: 'https://app.fieldstay.app/crew/join/abc123' },
    ],
    defaultBody: [
      '{{org_name}} invited you to their crew on FieldStay.',
      '',
      'Set up your account & install the crew app:',
      '{{invite_url}}',
      '',
      'Reply STOP to opt out.',
    ].join('\n'),
  },
  {
    key:         'crew_turnover_assigned',
    label:       'Turnover Assignment — Crew',
    description: 'Sent to a crew member when one or more turnovers are assigned to them.',
    audience:    'crew',
    variables: [
      { token: '{{org_name}}',     description: 'Organization name',                       example: 'Summit Property Management' },
      { token: '{{assignments}}',  description: 'Formatted bullet list of assigned turnovers', example: '• Lakeside Lodge — Mon, Jul 7 · 4hr window\n• Mountain Cabin — Tue, Jul 8 · 3hr window' },
    ],
    defaultBody: [
      '{{org_name}}: New turnover assignment(s) 📋',
      '{{assignments}}',
      '',
      'Open your crew app for details & checklist.',
      '',
      'Reply STOP to opt out.',
    ].join('\n'),
  },
]
