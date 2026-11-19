import { salesOpsHandlers } from '@/lib/gtm/teams/sales-ops'
import { createTeamDrain } from '@/lib/inngest/functions/gtm-team-drain'

// ============================================================================
// Sales Ops' work queue. Tasks arrive from Rev Ops after a person approves its
// weekly report (see executeReport in lib/gtm/teams/rev-ops.ts), so there is no
// schedule of its own. Nothing happens here until someone said yes to it, and
// nothing it produces is ever sent by it.
// ============================================================================

export const gtmSalesOpsDrain = createTeamDrain({
  id:       'gtm-sales-ops-drain',
  name:     'GTM Sales Ops: work queue',
  team:     'sales_ops',
  registry: salesOpsHandlers,
})
