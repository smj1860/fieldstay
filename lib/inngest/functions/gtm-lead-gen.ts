import { leadGenHandlers } from '@/lib/gtm/teams/lead-gen'
import { createTeamDrain } from '@/lib/inngest/functions/gtm-team-drain'

// ============================================================================
// Lead Gen's work queue. Tasks arrive from Rev Ops after a person approves its
// weekly report (see executeReport in lib/gtm/teams/rev-ops.ts), so there is no
// schedule of its own: nothing happens here until someone said yes to it.
// ============================================================================

export const gtmLeadGenDrain = createTeamDrain({
  id:       'gtm-lead-gen-drain',
  name:     'GTM Lead Gen: work queue',
  team:     'lead_gen',
  registry: leadGenHandlers,
})
