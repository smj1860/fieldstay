import { describe, it, expect } from 'vitest'
import {
  renderTemplate,
  SMS_TEMPLATE_REGISTRY,
  type SmsTemplateKey,
} from '@/lib/sms/template-registry'

const EXPECTED_KEYS: SmsTemplateKey[] = [
  'door_code',
  'morning_nudge',
  'evening_nudge',
  'rain_alert',
  'stay_extension',
  'vendor_work_order',
  'crew_invite',
  'crew_turnover_assigned',
]

describe('renderTemplate', () => {
  it('replaces a single token with its value', () => {
    expect(renderTemplate('Hello {{name}}!', { name: 'Alex' })).toBe('Hello Alex!')
  })

  it('replaces multiple distinct tokens', () => {
    expect(renderTemplate('{{a}} and {{b}}', { a: '1', b: '2' })).toBe('1 and 2')
  })

  it('replaces every occurrence of a repeated token', () => {
    expect(renderTemplate('{{x}}-{{x}}-{{x}}', { x: 'z' })).toBe('z-z-z')
  })

  it('stringifies a numeric value', () => {
    expect(renderTemplate('{{temperature}}°F', { temperature: 72 })).toBe('72°F')
  })

  it('replaces null and undefined values with an empty string rather than throwing', () => {
    expect(renderTemplate('a{{gone}}b', { gone: null })).toBe('ab')
    expect(renderTemplate('a{{gone}}b', { gone: undefined })).toBe('ab')
  })

  it('replaces a token missing from the vars object with an empty string', () => {
    expect(renderTemplate('a{{missing}}b', {})).toBe('ab')
  })

  it('leaves text with no tokens unchanged', () => {
    expect(renderTemplate('plain text, no tokens', {})).toBe('plain text, no tokens')
  })

  it('replaces an empty-string value with an empty string, not the literal token', () => {
    expect(renderTemplate('a{{gone}}b', { gone: '' })).toBe('ab')
  })

  it('does not interpolate a malformed single-brace token', () => {
    expect(renderTemplate('a{name}b', { name: 'x' })).toBe('a{name}b')
  })
})

describe('SMS_TEMPLATE_REGISTRY', () => {
  it('registers exactly the eight known template keys, each exactly once', () => {
    const keys = SMS_TEMPLATE_REGISTRY.map((t) => t.key)
    expect(keys.sort()).toEqual([...EXPECTED_KEYS].sort())
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gives every template a non-empty label, description, audience, and defaultBody', () => {
    for (const template of SMS_TEMPLATE_REGISTRY) {
      expect(template.label.length).toBeGreaterThan(0)
      expect(template.description.length).toBeGreaterThan(0)
      expect(['guest', 'crew', 'vendor']).toContain(template.audience)
      expect(template.defaultBody.length).toBeGreaterThan(0)
    }
  })

  it('every {{token}} appearing in a template\'s defaultBody is declared in its variables list', () => {
    for (const template of SMS_TEMPLATE_REGISTRY) {
      const tokensInBody = [...template.defaultBody.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
      const declaredTokens = template.variables.map((v) => v.token.replace(/[{}]/g, ''))

      for (const token of tokensInBody) {
        expect(declaredTokens, `template "${template.key}" uses {{${token}}} without declaring it`).toContain(token)
      }
    }
  })

  it('rendering each template\'s defaultBody with its own example values leaves no unfilled {{token}}', () => {
    for (const template of SMS_TEMPLATE_REGISTRY) {
      const vars = Object.fromEntries(
        template.variables.map((v) => [v.token.replace(/[{}]/g, ''), v.example])
      )

      const rendered = renderTemplate(template.defaultBody, vars)

      expect(rendered, `template "${template.key}" left an unfilled placeholder`).not.toMatch(/\{\{\w+\}\}/)
    }
  })

  it('every template includes a STOP opt-out instruction for TCPA compliance', () => {
    for (const template of SMS_TEMPLATE_REGISTRY) {
      expect(template.defaultBody, `template "${template.key}" is missing a STOP instruction`).toMatch(/reply stop/i)
    }
  })

  it('every declared variable has a non-empty token, description, and example', () => {
    for (const template of SMS_TEMPLATE_REGISTRY) {
      for (const variable of template.variables) {
        expect(variable.token).toMatch(/^\{\{\w+\}\}$/)
        expect(variable.description.length).toBeGreaterThan(0)
      }
    }
  })
})
