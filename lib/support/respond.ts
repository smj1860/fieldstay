import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { anthropic } from './anthropic-client'
import { retrieveContext } from './retrieve'
import type { SupportCategory, SupportMessage } from './types'

const MODEL_BY_CATEGORY: Record<SupportCategory, string> = {
  faq:              'claude-haiku-4-5-20251001',
  technical:        'claude-sonnet-4-6',
  account_specific: 'claude-sonnet-4-6',
}

export async function generateResponse(params: {
  category: SupportCategory
  message: string
  history: SupportMessage[]
}): Promise<{ content: string; modelUsed: string }> {
  const model = MODEL_BY_CATEGORY[params.category]
  const context = await retrieveContext(params.message)
  const systemPrompt = buildSystemPrompt(params.category, context)

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

  return {
    content:    textBlock?.text ?? "I wasn't able to generate a response — please try rephrasing.",
    modelUsed:  model,
  }
}

function buildSystemPrompt(category: SupportCategory, context: string[]): string {
  const base = `You are FieldStay's support assistant. FieldStay is an operations platform for short-term rental property managers — turnover management, crew scheduling, maintenance work orders, vendor coordination, and inventory tracking.

Answer only from the reference material below. If it doesn't cover the question, say so plainly and offer to flag this for the support team rather than guessing.

Reference material:
${context.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}`

  if (category === 'technical') {
    return `${base}\n\nThis was flagged as a technical issue. Ask clarifying questions about what they're seeing — error messages, which page, what they expected — before suggesting a fix.`
  }

  if (category === 'account_specific') {
    return `${base}\n\nThis references their specific account or data. You do not currently have access to live account data. Say so plainly and offer to flag this for a human who can look up their account — do not guess or fabricate account details.`
  }

  return base
}
