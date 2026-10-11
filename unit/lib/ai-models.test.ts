import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { reportError } from '@/lib/observability/report-error'
import {
  AUTO_TOOL_MIN_TOKENS,
  DEFAULT_MODELS,
  adaptParamsForModel,
  capabilitiesFor,
  createTierMessage,
  modelFor,
  type TierMessageParams,
} from '@/lib/ai/models'

const BASE: TierMessageParams = {
  max_tokens:  50,
  system:      'Classify the request.',
  messages:    [{ role: 'user', content: 'hi' }],
  tools:       [{ name: 'route', description: 'route', input_schema: { type: 'object', properties: {} } }],
  tool_choice: { type: 'tool', name: 'route' },
}

function message(content: Anthropic.Messages.ContentBlock[], stop: Anthropic.Messages.StopReason = 'end_turn'): Anthropic.Messages.Message {
  return { content, stop_reason: stop } as Anthropic.Messages.Message
}

function fakeClient(create: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { create } } as unknown as Anthropic
}

describe('modelFor', () => {
  const saved = { fast: process.env.AI_MODEL_FAST, smart: process.env.AI_MODEL_SMART }
  afterEach(() => {
    process.env.AI_MODEL_FAST  = saved.fast
    process.env.AI_MODEL_SMART = saved.smart
    if (saved.fast === undefined) delete process.env.AI_MODEL_FAST
    if (saved.smart === undefined) delete process.env.AI_MODEL_SMART
  })

  it('falls back to the tier default when the env var is unset or blank', () => {
    delete process.env.AI_MODEL_FAST
    process.env.AI_MODEL_SMART = '   '
    expect(modelFor('fast')).toBe(DEFAULT_MODELS.fast)
    expect(modelFor('smart')).toBe(DEFAULT_MODELS.smart)
  })

  it('uses the configured id, trimmed', () => {
    process.env.AI_MODEL_FAST = ' claude-haiku-5-5 '
    expect(modelFor('fast')).toBe('claude-haiku-5-5')
  })
})

describe('adaptParamsForModel', () => {
  it('leaves 4.x requests unchanged apart from the model id', () => {
    const out = adaptParamsForModel('claude-haiku-4-5-20251001', BASE)
    expect(out).toEqual({ ...BASE, model: 'claude-haiku-4-5-20251001' })
  })

  it('turns default thinking off on Haiku 5.5 and keeps the forced tool', () => {
    const out = adaptParamsForModel('claude-haiku-5-5', BASE)
    expect(out.thinking).toEqual({ type: 'disabled' })
    expect(out.tool_choice).toEqual({ type: 'tool', name: 'route' })
  })

  it('uses between_tools and swaps a forced tool for auto + instruction on Sonnet 5.5', () => {
    const out = adaptParamsForModel('claude-sonnet-5-5', BASE)
    expect(out.thinking).toEqual({ type: 'between_tools' })
    expect(out.tool_choice).toEqual({ type: 'auto' })
    expect(out.system).toBe('Classify the request.\n\nYou must respond by calling the route tool immediately, with no text before it.')
    expect(out.max_tokens).toBe(AUTO_TOOL_MIN_TOKENS)
  })

  it('appends the instruction as a block when system is an array', () => {
    const out = adaptParamsForModel('claude-sonnet-5-5', { ...BASE, system: [{ type: 'text', text: 'Rules.' }] })
    expect(out.system).toEqual([{ type: 'text', text: 'Rules.' }, { type: 'text', text: expect.stringContaining('route tool') }])
  })

  it('does not override thinking a caller set explicitly', () => {
    const out = adaptParamsForModel('claude-haiku-5-5', { ...BASE, thinking: { type: 'adaptive' } })
    expect(out.thinking).toEqual({ type: 'adaptive' })
  })

  it('treats unknown models as 4.x-like', () => {
    expect(capabilitiesFor('claude-something-new')).toEqual({ thinkingOff: null, forcedToolChoice: true })
  })
})

describe('createTierMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.AI_MODEL_FAST
  })

  it('returns the message and the model that answered', async () => {
    const create = vi.fn().mockResolvedValue(message([{ type: 'text', text: 'ok', citations: null }]))
    const out = await createTierMessage(fakeClient(create), 'fast', BASE, 'test.site')
    expect(out.model).toBe(DEFAULT_MODELS.fast)
    expect(create).toHaveBeenCalledTimes(1)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('reports and retries on the tier default when the configured model 404s', async () => {
    process.env.AI_MODEL_FAST = 'claude-retired-model'
    const notFound = Object.assign(new Error('model: claude-retired-model'), { status: 404 })
    const create = vi.fn()
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce(message([{ type: 'text', text: 'ok', citations: null }]))
    const out = await createTierMessage(fakeClient(create), 'fast', BASE, 'test.site')
    expect(out.model).toBe(DEFAULT_MODELS.fast)
    expect(create.mock.calls[1]![0].model).toBe(DEFAULT_MODELS.fast)
    expect(reportError).toHaveBeenCalledWith(notFound, expect.objectContaining({ site: 'test.site.model_not_found' }))
  })

  it('rethrows a 404 on the default itself and any non-404 error', async () => {
    const notFound = Object.assign(new Error('gone'), { status: 404 })
    await expect(createTierMessage(fakeClient(vi.fn().mockRejectedValue(notFound)), 'fast', BASE, 's')).rejects.toBe(notFound)

    process.env.AI_MODEL_FAST = 'claude-haiku-5-5'
    const overloaded = Object.assign(new Error('overloaded'), { status: 529 })
    await expect(createTierMessage(fakeClient(vi.fn().mockRejectedValue(overloaded)), 'fast', BASE, 's')).rejects.toBe(overloaded)
  })

  it('reports a response with no text or tool call', async () => {
    const create = vi.fn().mockResolvedValue(message([], 'max_tokens'))
    await createTierMessage(fakeClient(create), 'fast', BASE, 'test.site')
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ site: 'test.site.empty_response' }))
  })
})
