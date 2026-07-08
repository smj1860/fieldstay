import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient } from './anthropic-client'
import type { SupportCategory } from './types'

const ROUTE_TOOL = {
  name: 'route_support_request',
  description: 'Classify the support request type',
  input_schema: {
    type: 'object' as const,
    properties: {
      category: {
        type: 'string' as const,
        enum: ['faq', 'technical', 'account_specific'],
      },
    },
    required: ['category'],
  },
}

export async function classifyIntent(message: string): Promise<SupportCategory> {
  try {
    const res = await getAnthropicClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      system:
        "Classify the user's support request. 'faq' = general how-to, pricing, or feature questions answerable from documentation. 'technical' = something appears broken, an error, or isn't behaving as expected. 'account_specific' = references their own properties, bookings, integrations, crew, or billing.",
      messages: [{ role: 'user', content: message }],
      tools: [ROUTE_TOOL],
      tool_choice: { type: 'tool', name: 'route_support_request' },
    })

    const toolUse = res.content.find(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use'
    )
    const category = (toolUse?.input as { category?: string } | undefined)?.category

    if (category === 'faq' || category === 'technical' || category === 'account_specific') {
      return category
    }
    return 'faq'
  } catch (err) {
    console.error('[support/classify] classification failed, defaulting to faq', err)
    return 'faq'
  }
}
