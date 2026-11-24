import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient } from '@/lib/support/anthropic-client'
import { ANTHROPIC_TIMEOUT_MS } from '@/lib/http/timeout'
import { reportError } from '@/lib/observability/report-error'
import { WORKER_TEAMS } from '../constants'
import { ACTION_CATALOG, ACTION_KINDS, MAX_UNMET_CHARS, readInterpretation, renderFacts, type InstructionFacts, type Interpretation } from './instructions'
import { MANAGER_MODEL } from './narrate'

/**
 * The second model call the manager makes: reading a person's reply to a brief
 * and saying which catalog actions it asks for. Kept apart from the Inngest
 * function so everything with a decision in it (instructions.ts) stays testable
 * without the SDK, and so the billed-caller list names one small file.
 *
 * The model can only CHOOSE from the catalog. It cannot name a new action, and
 * whatever it returns is re-validated by readInterpretation() before anything is
 * stored. It returns the tokens used even when the answer is unusable, because
 * the call cost money either way and the caller bills it before judging it.
 */

const MAX_OUTPUT_TOKENS = 500

export const PROPOSE_ACTIONS_TOOL: Anthropic.Messages.Tool = {
  name: 'propose_actions',
  description: 'Answer the instruction: say what you understood in plain words, and list the catalog actions it asks for, if any.',
  input_schema: {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description: 'One to three plain sentences to the person: what you understood and what you will do, or why you cannot. No em dashes.',
      },
      actions: {
        type: 'array',
        description: 'The catalog actions the instruction asks for. Empty when it asks for nothing on the list.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...ACTION_KINDS] },
            team:  { type: 'string', enum: [...WORKER_TEAMS], description: 'Only for requeue_failed, and only when the person named a team.' },
            limit: { type: 'integer', minimum: 1, description: 'Only for redraft_rejected, enrich_ownerrez and draft_meeting_requests, and only when the person named a number.' },
          },
          required: ['kind'],
        },
      },
      unmet: {
        type: 'array',
        description: `Each part of the instruction that no catalog action covers, as a short phrase in the person's own terms (under ${MAX_UNMET_CHARS} characters). Empty when everything is covered.`,
        items: { type: 'string' },
      },
    },
    required: ['reply', 'actions', 'unmet'],
  },
}

export function interpretSystemPrompt(): string {
  const catalog = ACTION_KINDS.map((k) => `- ${k}: ${ACTION_CATALOG[k].description}`).join('\n')
  return [
    'You are the manager of a small sales-operations agent team. A person has replied to your daily brief with an instruction.',
    'Decide which of these actions, and only these, the instruction asks for:',
    catalog,
    'Rules:',
    '- You cannot send email, text, call, change an account, close or delete anything, or change settings. If the instruction asks for any of that, propose nothing and say plainly that you cannot.',
    '- Do not guess. If the instruction is vague, propose nothing and say what you can do instead.',
    '- If the instruction has several parts, propose the actions that cover the parts you can, and list every part you cannot cover in `unmet`. Do not drop a part silently and do not refuse the whole thing because one part is off the list.',
    '- If the person asks what would help, or leaves the choice to you, use the current counts to recommend one or two actions and propose them.',
    '- Do not propose more than the instruction asks for.',
    '- Every action only queues work for a team. The person still approves what the team produces.',
    `Answer only by calling the ${PROPOSE_ACTIONS_TOOL.name} tool. Write nothing outside that call.`,
  ].join('\n')
}

export interface InterpretCall {
  model:          string
  inputTokens:    number
  outputTokens:   number
  /** null when the model did not return a usable answer */
  interpretation: Interpretation | null
}

function readCall(content: Anthropic.Messages.ContentBlock[]): Interpretation | null {
  const block = content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use' && b.name === PROPOSE_ACTIONS_TOOL.name)
  return block ? readInterpretation(block.input) : null
}

/** Throws on a transport or API failure so the step is retried. A malformed answer is a result, not a throw. */
export async function interpretInstruction(instruction: string, briefText: string | null, facts: InstructionFacts): Promise<InterpretCall> {
  const brief = briefText ? `Your latest brief, for context:\n${briefText}\n\n` : ''
  const context = `${brief}${renderFacts(facts)}\n\n`
  try {
    const res = await getAnthropicClient().messages.create(
      {
        model:      MANAGER_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system:     interpretSystemPrompt(),
        messages:   [{ role: 'user', content: `${context}The person's instruction:\n${instruction}` }],
        tools:      [PROPOSE_ACTIONS_TOOL],
        // Never force the tool ({ type: 'tool' } or 'any'): some models reject it with a 400.
        // 'auto' plus the instruction in the system prompt does the same job, and readCall()
        // already treats an answer without the tool call as no answer.
        tool_choice: { type: 'auto' },
      },
      { timeout: ANTHROPIC_TIMEOUT_MS },
    )
    return {
      model:          MANAGER_MODEL,
      inputTokens:    res.usage.input_tokens,
      outputTokens:   res.usage.output_tokens,
      interpretation: readCall(res.content),
    }
  } catch (err) {
    reportError(err, { site: 'gtm.manager.interpret', level: 'warning' })
    throw err
  }
}
