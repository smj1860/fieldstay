export type SupportCategory = 'faq' | 'technical' | 'account_specific'

export interface SupportMessage {
  role: 'user' | 'assistant'
  content: string
}
