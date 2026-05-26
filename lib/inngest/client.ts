import { Inngest, EventSchemas } from 'inngest'
import type { FieldStayEvents } from './events'

/**
 * Inngest client — single instance shared across all functions.
 * Import this wherever you need to send events or define functions.
 */
export const inngest = new Inngest({
  id: 'fieldstay',
  name: 'FieldStay',
  schemas: new EventSchemas().fromRecord<FieldStayEvents>(),
})
