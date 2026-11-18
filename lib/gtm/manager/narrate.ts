import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient } from '@/lib/support/anthropic-client'
import { reportError } from '@/lib/observability/report-error'
import { NARRATION_SYSTEM_PROMPT, narrationFacts, type ManagerMetrics } from './brief'

/**
 * The one model call the manager makes, kept apart from brief.ts so everything
 * with a decision in it stays testable without the SDK.
 *
 * It can never block or corrupt a brief: any failure resolves to `ok: false`
 * and the caller writes the deterministic facts on their own.
 */

/** Cheapest tier is plenty: the model reads a dozen numbers and writes a paragraph. */
export const MANAGER_MODEL = 'claude-haiku-4-5-20251001'

const MAX_OUTPUT_TOKENS = 300
const REQUEST_TIMEOUT_MS = 30_000

export type NarrationResult =
  | { ok: true; text: string; model: string; inputTokens: number; outputTokens: number }
  | { ok: false; reason: 'no_text' | 'error' }

function firstText(content: Anthropic.Messages.ContentBlock[]): string | null {
  const block = content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
  const text = block?.text.trim()
  return text ? text : null
}

/**
 * Models are told not to use an em dash, and told again here in code: copy a
 * person reads should never carry one, and an instruction is a request, not a
 * guarantee.
 */
export function stripEmDashes(text: string): string {
  return text.replaceAll('—', ',')
}

export async function narrateBrief(metrics: ManagerMetrics): Promise<NarrationResult> {
  try {
    const res = await getAnthropicClient().messages.create(
      {
        model:      MANAGER_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system:     NARRATION_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: JSON.stringify(narrationFacts(metrics)) }],
      },
      { timeout: REQUEST_TIMEOUT_MS },
    )

    const text = firstText(res.content)
    if (!text) return { ok: false, reason: 'no_text' }

    return {
      ok:           true,
      text:         stripEmDashes(text),
      model:        MANAGER_MODEL,
      inputTokens:  res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    }
  } catch (err) {
    // A warning, not an error: the brief still ships with its facts.
    reportError(err, { site: 'gtm.manager.narrate', level: 'warning' })
    return { ok: false, reason: 'error' }
  }
}
