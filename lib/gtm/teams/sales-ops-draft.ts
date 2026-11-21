import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient } from '@/lib/support/anthropic-client'
import { ANTHROPIC_TIMEOUT_MS } from '@/lib/http/timeout'
import type { DraftText, VoiceIssue } from '../brand/voice'
import { WRITE_DRAFT_TOOL, systemPrompt, userPrompt, type DraftBrief } from './sales-ops-prompt'

/**
 * The one model call Sales Ops makes. Kept apart from the handler so everything
 * with a decision in it stays testable without the SDK, and so the billed-caller
 * list (unit/guardrails/gtm-agent-boundaries.test.ts) names one small file.
 *
 * It returns the draft AND the tokens used even when the answer is unusable: the
 * call cost money either way, and the caller bills it before it judges the text.
 */

/** Copy is what this call is for, so it gets the stronger tier. A draft costs on the order of a cent. */
export const SALES_DRAFT_MODEL = 'claude-sonnet-5-5'

const MAX_OUTPUT_TOKENS = 700

export interface DraftCall {
  model:        string
  inputTokens:  number
  outputTokens: number
  /** null when the model did not return a usable draft */
  draft:        DraftText | null
}

function readDraft(content: Anthropic.Messages.ContentBlock[]): DraftText | null {
  const block = content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use' && b.name === WRITE_DRAFT_TOOL.name)
  const input = block?.input as { subject?: unknown; body?: unknown } | undefined
  if (typeof input?.subject !== 'string' || typeof input.body !== 'string') return null
  return { subject: input.subject.trim(), body: input.body.trim() }
}

/** Throws on a transport or API failure, so the task is retried. A malformed answer is a result, not a throw. */
export async function generateDraft(brief: DraftBrief, issues: readonly VoiceIssue[] = []): Promise<DraftCall> {
  const res = await getAnthropicClient().messages.create(
    {
      model:       SALES_DRAFT_MODEL,
      max_tokens:  MAX_OUTPUT_TOKENS,
      system:      systemPrompt(brief.feedback),
      messages:    [{ role: 'user', content: userPrompt(brief, issues) }],
      tools:       [WRITE_DRAFT_TOOL],
      // Never force the tool ({ type: 'tool' } or 'any'): claude-sonnet-5-5 rejects both with a 400
      // (SENTRY-CRAZY-CUSHION-1N), so every draft failed. 'auto' plus the instruction in the system prompt
      // does the same job, and readDraft() already treats an answer without the tool call as no draft.
      tool_choice: { type: 'auto' },
    },
    { timeout: ANTHROPIC_TIMEOUT_MS },
  )

  return {
    model:        SALES_DRAFT_MODEL,
    inputTokens:  res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    draft:        readDraft(res.content),
  }
}
