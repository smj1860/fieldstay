export type SupportCategory = 'faq' | 'technical' | 'account_specific'

export interface SupportMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SupportResponse {
  content:         string
  modelUsed:       string
  /**
   * True if the response text indicates this conversation needs human follow-up.
   * Detected via keyword match on the response content (see detectEscalation in
   * respond.ts). Phase 3 will use this to trigger the Inngest escalation event.
   */
  needsEscalation: boolean
}
