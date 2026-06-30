import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { anthropic } from './anthropic-client'
import { retrieveContext } from './retrieve'
import type { SupportCategory, SupportMessage, SupportResponse } from './types'
import { ACCOUNT_TOOLS, callAccountTool } from './account-tools'

const MODEL_BY_CATEGORY: Record<SupportCategory, string> = {
  faq:              'claude-haiku-4-5-20251001',
  technical:        'claude-sonnet-4-6',
  account_specific: 'claude-sonnet-4-6',
}

export async function generateResponse(params: {
  category: SupportCategory
  message:  string
  history:  SupportMessage[]
  orgId:    string
}): Promise<SupportResponse> {
  const model        = MODEL_BY_CATEGORY[params.category]
  const context      = await retrieveContext(params.message)
  const systemPrompt = buildSystemPrompt(params.category, context)

  if (params.category === 'account_specific') {
    return generateAccountSpecificResponse({
      model,
      systemPrompt,
      message: params.message,
      history: params.history,
      orgId:   params.orgId,
    })
  }

  const res = await anthropic.messages.create({
    model,
    max_tokens: 800,
    system: systemPrompt,
    messages: [
      ...params.history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: params.message },
    ],
  })

  const textBlock = res.content.find(
    (b): b is Anthropic.Messages.TextBlock => b.type === 'text'
  )

  const content = textBlock?.text ?? "I wasn't able to generate a response — please try rephrasing."

  return {
    content,
    modelUsed:       model,
    needsEscalation: detectEscalation(content),
  }
}

async function generateAccountSpecificResponse(params: {
  model:        string
  systemPrompt: string
  message:      string
  history:      SupportMessage[]
  orgId:        string
}): Promise<SupportResponse> {
  const messages: Anthropic.Messages.MessageParam[] = [
    ...params.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: params.message },
  ]

  let res = await anthropic.messages.create({
    model:      params.model,
    max_tokens: 800,
    system:     params.systemPrompt,
    tools:      ACCOUNT_TOOLS,
    messages,
  })

  // Tool-use loop — handle up to 3 rounds of tool calls before forcing a final answer
  let rounds = 0
  while (res.stop_reason === 'tool_use' && rounds < 3) {
    const toolUseBlocks = res.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
    )

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => ({
        type:        'tool_result' as const,
        tool_use_id: block.id,
        content:     JSON.stringify(await callAccountTool(block.name, params.orgId)),
      }))
    )

    messages.push({ role: 'assistant', content: res.content })
    messages.push({ role: 'user', content: toolResults })

    res = await anthropic.messages.create({
      model:      params.model,
      max_tokens: 800,
      system:     params.systemPrompt,
      tools:      ACCOUNT_TOOLS,
      messages,
    })

    rounds++
  }

  const textBlock = res.content.find(
    (b): b is Anthropic.Messages.TextBlock => b.type === 'text'
  )
  const content = textBlock?.text ?? "I wasn't able to generate a response — please try rephrasing."

  return {
    content,
    modelUsed:       params.model,
    needsEscalation: detectEscalation(content),
  }
}

/**
 * Detects whether the bot's own response indicates a human handoff is needed.
 * The system prompt instructs the model to explicitly say so when escalating,
 * so this checks for that signal rather than trying to interpret intent.
 */
function detectEscalation(responseText: string): boolean {
  const signals = [
    'flagging this for',
    'flag this for',
    'human to follow up',
    'our team',
    'a closer look from our team',
    'needs a closer look',
  ]
  const lower = responseText.toLowerCase()
  return signals.some((s) => lower.includes(s))
}

function buildSystemPrompt(category: SupportCategory, context: string[]): string {
  const base = `You are FieldStay's support assistant. FieldStay is an operations platform for short-term rental property managers — turnover management, crew scheduling, maintenance work orders, vendor coordination, and inventory tracking.

Answer only from the reference material below. If it doesn't cover the question, say so plainly and offer to flag this for the support team rather than guessing.

Always escalate to a human rather than attempting to answer when the message involves:
- A guest being charged or billed incorrectly, or any payment dispute
- A safety incident, injury, or property damage claim
- An explicit request to speak with a person or a human
- Threats of legal action or mentions of an attorney
- Anything involving account deletion, data export, or cancellation that the person wants help executing (not just understanding)

When escalating, say so directly and warmly — do not pretend to resolve the issue first. Example: "This needs a closer look from our team — I'm flagging this for a human to follow up with you."

Keep responses short. The person reading this is on a phone, in a chat widget, mid-task. Lead with the direct answer in the first sentence. Use short paragraphs or a short list only if the answer genuinely has multiple steps. Avoid headers, bold text, and any formatting that assumes a desktop screen.

When referencing an in-app action, name the actual path (e.g. "Settings → Integrations") rather than describing it vaguely.

Never invent a feature, button, or setting that isn't in the reference material. If you're not sure something exists, say you're not sure rather than guessing at a UI element.

Reference material:
${context.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}`

  if (category === 'technical') {
    return `${base}\n\nThis was flagged as a technical issue. Ask clarifying questions about what they're seeing — error messages, which page, what they expected — before suggesting a fix.`
  }

  if (category === 'account_specific') {
    return `${base}

This question is about the person's specific account or data. You have tools available to look up their plan status, recent turnovers, integration connection status, and recent purchase orders. Use a tool when it would answer the question directly. If the question needs information no tool provides, say so plainly and offer to flag this for a human.`
  }

  return base
}
