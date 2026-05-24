import { Inngest } from 'inngest'
import type { FieldStayEvents } from './events'

/**
 * Inngest client — single instance shared across all functions.
 * Import this wherever you need to send events or define functions.
 */
export const inngest = new Inngest<FieldStayEvents>({
  id: 'fieldstay',
  name: 'FieldStay',
})
