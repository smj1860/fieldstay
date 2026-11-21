import { describe, it, expect, vi, beforeEach } from 'vitest'

const create = vi.hoisted(() => vi.fn())
vi.mock('@/lib/support/anthropic-client', () => ({ getAnthropicClient: () => ({ messages: { create } }) }))

import { SALES_DRAFT_MODEL, generateDraft } from '@/lib/gtm/teams/sales-ops-draft'
import { WRITE_DRAFT_TOOL, type DraftBrief } from '@/lib/gtm/teams/sales-ops-prompt'

const brief: DraftBrief = {
  company: 'Acme Rentals', city: null, state: null, pms: null, portfolioSize: null, contactFirstName: 'Dana',
  contactTitle: null, kind: 'first_touch', daysSinceLastTouch: null, priorTouches: [], feedback: ['be brief'],
}
const reply = (content: unknown[]) => ({ content, usage: { input_tokens: 900, output_tokens: 150 } })

beforeEach(() => { create.mockReset() })

describe('generateDraft', () => {
  it('returns the draft with the model and the tokens to bill', async () => {
    create.mockResolvedValue(reply([{ type: 'tool_use', name: 'write_draft', input: { subject: '  Hello  ', body: ' Hi Dana, text ' } }]))
    expect(await generateDraft(brief)).toEqual({
      model: SALES_DRAFT_MODEL, inputTokens: 900, outputTokens: 150, draft: { subject: 'Hello', body: 'Hi Dana, text' },
    })
  })

  it('never forces a tool (the model rejects it), asks for the draft tool in the system prompt, passes a timeout and carries the feedback', async () => {
    create.mockResolvedValue(reply([{ type: 'tool_use', name: 'write_draft', input: { subject: 's', body: 'b' } }]))
    await generateDraft(brief)
    const [params, options] = create.mock.calls[0]
    // A forced tool_choice ('tool' or 'any') is a 400 on this model, so every draft failed (SENTRY-CRAZY-CUSHION-1N).
    expect(params.tool_choice).toEqual({ type: 'auto' })
    expect(params.tools).toEqual([WRITE_DRAFT_TOOL])
    expect(params.system).toContain(WRITE_DRAFT_TOOL.name)
    expect(params.model).toBe(SALES_DRAFT_MODEL)
    expect(params.system).toContain('be brief')
    expect(options).toMatchObject({ timeout: expect.any(Number) })
  })

  // The call cost money whether or not the answer is usable, so the tokens come back either way.
  it.each([
    ['no tool call', [{ type: 'text', text: 'Here is a draft' }]],
    ['the wrong tool', [{ type: 'tool_use', name: 'other', input: { subject: 's', body: 'b' } }]],
    ['a missing body', [{ type: 'tool_use', name: 'write_draft', input: { subject: 's' } }]],
    ['a non-string subject', [{ type: 'tool_use', name: 'write_draft', input: { subject: 5, body: 'b' } }]],
    ['nothing at all', []],
  ])('returns no draft, but still the tokens, for %s', async (_label, content) => {
    create.mockResolvedValue(reply(content))
    expect(await generateDraft(brief)).toMatchObject({ draft: null, inputTokens: 900, outputTokens: 150 })
  })

  it('lets an API failure propagate so the task is retried', async () => {
    create.mockRejectedValue(new Error('overloaded'))
    await expect(generateDraft(brief)).rejects.toThrow('overloaded')
  })

  it('passes the previous attempt\'s problems into the next request', async () => {
    create.mockResolvedValue(reply([{ type: 'tool_use', name: 'write_draft', input: { subject: 's', body: 'b' } }]))
    await generateDraft(brief, [{ rule: 'pricing', detail: 'Quotes a price.' }])
    expect(create.mock.calls[0][0].messages[0].content).toContain('Quotes a price.')
  })
})
