import {
  MAX_DAILY_COST_CAP_CENTS,
  MAX_DAILY_TASK_CAP,
  isAutonomy,
  isSettingsTeam,
  type AutonomyLevel,
  type SettingsTeam,
} from './constants'

/**
 * Turns an admin's edit to a team's settings into a column payload, or names
 * why it is refused. Separate from the Server Action so the rules sit apart
 * from the query, the audit write and the error handling, and so they can be
 * tested without a database.
 */

export interface SettingsPatchInput {
  enabled?:              unknown
  autonomy?:             unknown
  daily_task_cap?:       unknown
  daily_cost_cap_cents?: unknown
}

export interface SettingsUpdate {
  enabled?:              boolean
  autonomy?:             AutonomyLevel
  daily_task_cap?:       number
  daily_cost_cap_cents?: number
}

function boundedInt(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : null
}

type Checked<T> = { value: T } | { error: string }

function checkAutonomy(team: SettingsTeam, value: unknown): Checked<AutonomyLevel> {
  if (!isAutonomy(value)) return { error: 'Unknown autonomy level.' }
  // Routing is not built. Letting the manager be set to it would be a setting
  // that promises behaviour nothing implements.
  if (team === 'manager' && value !== 'propose_only') {
    return { error: 'The manager is observe-only until routing ships.' }
  }
  return { value }
}

function checkCap(value: unknown, max: number, message: string): Checked<number> {
  const cap = boundedInt(value, max)
  return cap === null ? { error: message } : { value: cap }
}

/** The two daily ceilings, each validated only if the edit names it. */
function checkCaps(patch: SettingsPatchInput): Checked<Pick<SettingsUpdate, 'daily_task_cap' | 'daily_cost_cap_cents'>> {
  const value: Pick<SettingsUpdate, 'daily_task_cap' | 'daily_cost_cap_cents'> = {}

  if ('daily_task_cap' in patch) {
    const checked = checkCap(
      patch.daily_task_cap, MAX_DAILY_TASK_CAP,
      `Daily task cap must be a whole number from 0 to ${MAX_DAILY_TASK_CAP}.`,
    )
    if ('error' in checked) return checked
    value.daily_task_cap = checked.value
  }

  if ('daily_cost_cap_cents' in patch) {
    const checked = checkCap(patch.daily_cost_cap_cents, MAX_DAILY_COST_CAP_CENTS, 'Daily spend cap must be from $0 to $1,000.')
    if ('error' in checked) return checked
    value.daily_cost_cap_cents = checked.value
  }

  return { value }
}

/** The master switch is only a switch. A cap or an autonomy level on it would be stored and never read. */
function hasNonSwitchFields(patch: SettingsPatchInput): boolean {
  return 'autonomy' in patch || 'daily_task_cap' in patch || 'daily_cost_cap_cents' in patch
}

export function buildSettingsUpdate(
  team: unknown,
  patch: SettingsPatchInput,
): { team: SettingsTeam; update: SettingsUpdate } | { error: string } {
  if (!isSettingsTeam(team)) return { error: 'Unknown team.' }
  if (team === 'global' && hasNonSwitchFields(patch)) return { error: 'The master switch only turns on or off.' }

  const update: SettingsUpdate = {}

  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') return { error: 'Enabled must be on or off.' }
    update.enabled = patch.enabled
  }

  if ('autonomy' in patch) {
    const checked = checkAutonomy(team, patch.autonomy)
    if ('error' in checked) return checked
    update.autonomy = checked.value
  }

  const caps = checkCaps(patch)
  if ('error' in caps) return caps
  Object.assign(update, caps.value)

  if (Object.keys(update).length === 0) return { error: 'Nothing to change.' }
  return { team, update }
}

export const DECISIONS = ['approve', 'reject', 'cancel'] as const
export type TaskDecision = (typeof DECISIONS)[number]

export function isDecision(value: unknown): value is TaskDecision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value)
}

/**
 * Where a decision may start from, and where it ends. Approve and reject only
 * ever apply to something actually waiting on a person; cancel also covers work
 * that has not started. A finished or running task cannot be cancelled here.
 */
export const DECISION_RULES: Record<TaskDecision, { from: readonly string[]; to: string }> = {
  approve: { from: ['needs_approval'],                          to: 'approved' },
  reject:  { from: ['needs_approval'],                          to: 'rejected' },
  cancel:  { from: ['pending', 'needs_approval', 'approved'],   to: 'cancelled' },
}

export const MAX_DECISION_NOTE_CHARS = 500
