export type SupportCategory = 'faq' | 'technical' | 'account_specific'

export interface SupportMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SupportResponse {
  content:          string
  modelUsed:        string
  /**
   * True if this conversation needs human follow-up. Set via a structured
   * tool-call field the model fills out alongside its response (see
   * ESCALATION_TOOL in respond.ts), not by parsing the response text.
   */
  needsEscalation:  boolean
  /**
   * The model's own one-sentence reason for escalating, from the same
   * structured tool call. Empty string when needsEscalation is false.
   */
  escalationReason: string
}
