import { z } from 'zod'
import type { PriorityLevel, WoStatus } from '@/types/database'

// Mirrors the `priority_level` and `wo_status` Postgres enums.
// Validating against these schemas at insert/update boundaries replaces
// unsafe `as never` casts with a runtime check that narrows to the DB enum type.

export const PriorityLevelSchema = z.enum(
  ['low', 'medium', 'high', 'urgent'] satisfies [PriorityLevel, ...PriorityLevel[]]
)

export const WoStatusSchema = z.enum(
  ['pending', 'quote_requested', 'assigned', 'in_progress', 'completed', 'cancelled'] satisfies [WoStatus, ...WoStatus[]]
)
