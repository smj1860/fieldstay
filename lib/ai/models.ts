import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'

import { reportError } from '@/lib/observability/report-error'

// ============================================================================
// One place that decides which Claude model each job uses.
//
// Call sites ask for a TIER ("fast" or "smart"), never a model id. The id for
// each tier comes from AI_MODEL_FAST / AI_MODEL_SMART (validated in
// lib/env.ts), falling back to DEFAULT_MODELS. Changing models is a Vercel env
// change + redeploy, not a code edit.
//
// Why this exists: model ids were hardcoded in six files, and one of them
// (claude-sonnet-4-20250514 in build-shopping-cart.ts) was retired by
// Anthropic. The API returned 404 not_found_error and the cart's item-name
// normalisation silently degraded to its fallback with nothing reported.
//
// ── Tiers ───────────────────────────────────────────────────────────────────
//   fast   bounded, cheap jobs: support intent routing, FAQ answers, manual
//          lookups.
//   smart  jobs that need more judgment or vision: account-specific and
//          technical support answers, data-plate OCR, cart item normalisation,
//          RepuGuard (unless REPUGUARD_MODEL overrides it).
//
// ── Model capability differences this module absorbs ───────────────────────
// Verified against the live API on 2026-10-10:
//   - claude-haiku-5-5 and claude-sonnet-5-5 THINK BY DEFAULT. Thinking spends
//     max_tokens before any text or tool call is produced, so a small cap
//     (classify.ts uses 50) returns an EMPTY response. Haiku 5.5 accepts
//     thinking {type:'disabled'}; Sonnet 5.5 rejects 'disabled' and needs
//     {type:'between_tools'}. claude-sonnet-5 rejects 'between_tools'.
//   - claude-sonnet-5-5 rejects tool_choice {type:'tool'} and {type:'any'}
//     with a 400. Callers that force a tool get tool_choice:auto plus an
//     explicit instruction to call that tool. Under auto it may write a
//     sentence before the tool call, so max_tokens is raised to at least
//     AUTO_TOOL_MIN_TOKENS: classify.ts's 50-token cap was cut off mid-call.
//   - Models not listed in CAPABILITIES get the request unchanged, which is
//     how the 4.x models already behave.
//
// Two constraints on the entries below that are NOT visible from the table
// and will 400 if a future entry ignores them:
//   - 'between_tools' takes no companion field (display, budget_tokens,
//     block_binding alongside it is a 400) and is accepted only at effort
//     'high' or below. No caller sets output_config.effort today, and Sonnet
//     5.5 defaults to 'high', so the entry below is valid as written.
//   - Haiku 5.5's 'disabled' is likewise only accepted at effort 'high' or
//     below; its default is 'medium'.
// A caller that starts sending output_config.effort must re-check both.
// ============================================================================

export type ModelTier = 'fast' | 'smart'

export const DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  fast:  'claude-haiku-4-5-20251001',
  smart: 'claude-sonnet-4-6',
}

interface ModelCapabilities {
  /** Sent as `thinking` so the model answers without spending max_tokens on reasoning. */
  thinkingOff:      Anthropic.Messages.ThinkingConfigParam | null
  /** Whether tool_choice {type:'tool'|'any'} is accepted. */
  forcedToolChoice: boolean
}

const DEFAULT_CAPABILITIES: ModelCapabilities = { thinkingOff: null, forcedToolChoice: true }

/** Floor for max_tokens when a forced tool is downgraded to auto (see header). */
export const AUTO_TOOL_MIN_TOKENS = 512

// Ordered: first prefix match wins. Only list what was verified live.
const CAPABILITIES: ReadonlyArray<readonly [prefix: string, caps: ModelCapabilities]> = [
  ['claude-sonnet-5-5', { thinkingOff: { type: 'between_tools' }, forcedToolChoice: false }],
  ['claude-haiku-5-5',  { thinkingOff: { type: 'disabled' },      forcedToolChoice: true }],
]

export function modelFor(tier: ModelTier): string {
  // Two literal `process.env.X` reads rather than `process.env[lookup[tier]]`.
  // unit/guardrails/env-schema-coverage.test.ts matches /process\.env\.NAME/
  // against the source, so a computed index is invisible to it: the ENV_SPEC
  // entries for these two would be unenforced in both directions, and deleting
  // them would fail nothing.
  const configured = (tier === 'fast' ? process.env.AI_MODEL_FAST : process.env.AI_MODEL_SMART)?.trim()
  return configured ? configured : DEFAULT_MODELS[tier]
}

export function capabilitiesFor(model: string): ModelCapabilities {
  for (const [prefix, caps] of CAPABILITIES) {
    if (model.startsWith(prefix)) return caps
  }
  return DEFAULT_CAPABILITIES
}

export type TierMessageParams = Omit<Anthropic.Messages.MessageCreateParamsNonStreaming, 'model'>

/**
 * Adapts request params to what `model` accepts: turns default thinking off,
 * and replaces a forced tool_choice the model rejects with auto + an explicit
 * instruction. Pure, so it is unit-testable without the SDK.
 */
export function adaptParamsForModel(
  model:  string,
  params: TierMessageParams,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const caps = capabilitiesFor(model)
  const adapted: Anthropic.Messages.MessageCreateParamsNonStreaming = { ...params, model }

  if (caps.thinkingOff && params.thinking === undefined) {
    adapted.thinking = caps.thinkingOff
  }

  const choice = params.tool_choice
  if (!caps.forcedToolChoice && choice && (choice.type === 'tool' || choice.type === 'any')) {
    const instruction = choice.type === 'tool'
      ? `You must respond by calling the ${choice.name} tool immediately, with no text before it.`
      : 'You must respond by calling one of the provided tools immediately, with no text before it.'
    adapted.tool_choice = { type: 'auto' }
    adapted.system      = appendSystemInstruction(params.system, instruction)
    adapted.max_tokens  = Math.max(params.max_tokens, AUTO_TOOL_MIN_TOKENS)
  }

  return adapted
}

function appendSystemInstruction(
  system:      TierMessageParams['system'],
  instruction: string,
): TierMessageParams['system'] {
  if (system === undefined) return instruction
  if (typeof system === 'string') return `${system}\n\n${instruction}`
  return [...system, { type: 'text', text: instruction }]
}

function isModelNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && err.status === 404
}

function hasUsableContent(message: Anthropic.Messages.Message): boolean {
  return message.content.some((b) => b.type === 'text' || b.type === 'tool_use')
}

export interface TierMessageResult {
  message: Anthropic.Messages.Message
  /** The model that actually answered — the tier default if the configured one 404'd. */
  model:   string
}

/**
 * messages.create() for a tier. If the configured model no longer exists
 * (404, e.g. retired), reports it and retries once on the tier's default so a
 * bad AI_MODEL_* value degrades instead of taking the feature down. Also
 * reports responses that contain neither text nor a tool call, which is what a
 * model that spent max_tokens on thinking returns.
 */
export async function createTierMessage(
  client:  Anthropic,
  tier:    ModelTier,
  params:  TierMessageParams,
  site:    string,
  options?: Anthropic.RequestOptions,
): Promise<TierMessageResult> {
  const model = modelFor(tier)
  let result: TierMessageResult

  try {
    result = { message: await client.messages.create(adaptParamsForModel(model, params), options), model }
  } catch (err) {
    const fallback = DEFAULT_MODELS[tier]
    if (!isModelNotFound(err) || model === fallback) throw err
    reportError(err, { site: `${site}.model_not_found`, extra: { tier, model, fallback } })
    result = { message: await client.messages.create(adaptParamsForModel(fallback, params), options), model: fallback }
  }

  if (!hasUsableContent(result.message)) {
    reportError(new Error(`AI response had no text or tool call (stop_reason=${result.message.stop_reason})`), {
      site:  `${site}.empty_response`,
      extra: { tier, model: result.model, stop_reason: result.message.stop_reason ?? null },
    })
  }

  return result
}
