// app/api/integrations/health/route.ts
// ============================================================
// Single health surface for every integration mechanism in the org —
// see lib/integrations/health.ts for what "single" means here and why.
// ============================================================

import { NextResponse } from 'next/server'
import { requireOrgMember } from '@/lib/auth'
import { getIntegrationHealth } from '@/lib/integrations/health'

export async function GET() {
  const { membership } = await requireOrgMember()

  const items = await getIntegrationHealth(membership.org_id)

  return NextResponse.json({ items })
}
