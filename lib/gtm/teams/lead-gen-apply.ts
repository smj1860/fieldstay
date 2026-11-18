import 'server-only'
import { normalizeEmail, normalizePhone } from '@/lib/prospecting/normalize'
import { reportError } from '@/lib/observability/report-error'
import type { createServiceClient } from '@/lib/supabase/server'
import type { AgentTask } from '@/types/database'
import type { Json } from '@/types/database.generated'
import type { JsonObject } from '../tasks'

/**
 * The ONLY place any GTM agent writes to the prospect tables, and the only way
 * it gets there is a proposal a person approved.
 *
 * Three rules hold the door:
 *   1. No recorded decision on the task, no write. The worker only reaches this
 *      from the 'approved' stage, but a bug upstream must not be able to turn a
 *      proposal into a write, so it is checked again here.
 *   2. Only EMPTY fields are filled, enforced by the UPDATE's own `IS NULL`
 *      condition rather than by a read before it: a person can fill the field
 *      between approval and application, and theirs must win.
 *   3. Only email and phone, re-validated from the stored proposal. Status,
 *      scores, notes and every other column are out of reach by construction:
 *      they are not named in any payload below.
 *
 * unit/guardrails/gtm-agent-boundaries.test.ts allowlists exactly this file for
 * prospect writes and fails if it ever names a `status`.
 */

type ServiceClient = ReturnType<typeof createServiceClient>

const SITE = 'gtm.lead-gen.apply'

export interface ApprovedContacts { email?: string; phone?: string }

/** The proposal's fields, re-validated. Anything that does not parse is dropped, never "fixed up". */
export function parseApprovedContacts(output: Json | null): ApprovedContacts {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return {}
  const fields = output.fields
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return {}

  const result: ApprovedContacts = {}
  const email = typeof fields.email === 'string' ? normalizeEmail(fields.email) : null
  if (email) result.email = email
  const phone = typeof fields.phone === 'string' ? normalizePhone(fields.phone).e164 : null
  if (phone) result.phone = phone
  return result
}

function record(wrote: boolean, field: 'email' | 'phone', applied: string[], skipped: JsonObject[]): void {
  if (wrote) applied.push(field)
  else skipped.push({ field, reason: 'already_filled' })
}

export async function applyApprovedContacts(supabase: ServiceClient, task: AgentTask): Promise<JsonObject> {
  if (!task.decided_at) throw new Error('Refusing to apply a proposal that no person approved')
  if (!task.prospect_id) return { applied: [], skipped: [{ field: 'all', reason: 'no_account' }] }

  const contacts = parseApprovedContacts(task.output)
  const applied: string[] = []
  const skipped: JsonObject[] = []

  // Two explicit writes, not a loop: each is its own atomic fill-if-empty.
  if (contacts.email) record(await fillIfEmpty(supabase, task.prospect_id, { email: contacts.email }, 'email'), 'email', applied, skipped)
  if (contacts.phone) record(await fillIfEmpty(supabase, task.prospect_id, { phone: contacts.phone }, 'phone'), 'phone', applied, skipped)

  if (applied.length > 0) await logApplied(supabase, task, applied)
  return { applied, skipped }
}

async function fillIfEmpty(
  supabase: ServiceClient,
  prospectId: string,
  patch: { email: string } | { phone: string },
  column: 'email' | 'phone',
): Promise<boolean> {
  const { data, error } = await supabase
    .from('prospect_accounts')
    .update(patch)
    .eq('id', prospectId)
    .is(column, null)
    .select('id')
    .maybeSingle()

  if (error) {
    reportError(error, { site: `${SITE}.fill`, extra: { prospectId, column } })
    throw error
  }
  return data !== null
}

/**
 * A note in the account's history, so the funnel reads the way it happened. It
 * says what was added and that a person approved it, never the value itself.
 * Best-effort: the contact is saved either way, so a failure here is reported
 * and swallowed rather than undoing a write that already landed.
 */
async function logApplied(supabase: ServiceClient, task: AgentTask, applied: string[]): Promise<void> {
  const { error } = await supabase.from('prospect_touches').insert({
    prospect_id: task.prospect_id!,
    touch_type:  'note',
    note:        `Lead Gen added ${applied.join(' and ')} found on the company website (approved).`,
    actor_id:    task.decided_by,
  })
  if (error) reportError(error, { site: `${SITE}.note`, level: 'warning', extra: { taskId: task.id } })
}
